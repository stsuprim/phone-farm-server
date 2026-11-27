import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { ForkInstaller, forkPort, ForkTokens, readForkMeta } from './fork.js';
import { IdleLock } from './idle.js';
import { installGuards, LeaseState, makeShutdown, phoneFree, releaseDevices, setLeaseProbe, setSystemClaim, startLogRotation } from './lifecycle.js';
import { actorsFor } from './phone/actor.js';
import { MockBackend } from './mock.js';
import { RealBackend } from './real.js';
import { buildWdaRunner, provisionTeam, WdaResigner } from './resign.js';
import { loadRtc, rtcCleanup } from './rtc.js';
import { createServer } from './server.js';
import { SettingsStore } from './settings.js';
import { createUpdater } from './updater.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The commit this build runs (GET /health says it): read once at start; null outside a git checkout. */
function commitNow(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}
const version: { commit: string | null; startedAt: string; fork?: number | null } = { commit: commitNow(), startedAt: new Date().toISOString() };
const cfg = loadConfig();
if (!cfg.mock && !cfg.wdaProject) {
  console.error('WDA_PROJECT is not set in .env (see README), or set MOCK=true.');
  process.exit(1);
}
// LOTUS_FORK.json's "liveTouch" (pushed from afar) wins over the default; WDA_LIVE_TOUCH=off on the Mac wins over both
{
  const lt = readForkMeta(ROOT)?.liveTouch;
  if (lt && lt !== 'auto' && cfg.wdaLiveTouch !== 'off') cfg.wdaLiveTouch = lt;
}
const real = cfg.mock ? null : new RealBackend(cfg);
const backend = real ?? new MockBackend(cfg.mockPhones);
// 2026-11-27 (root cause §11): built in the background after pushes settle, gated by `npm run regress`, restarted into only
// when every phone's lease is Free (or at the quiet hour), and the restart ends the API only: the runners stay up
const updater = cfg.mock ? undefined : createUpdater(() => shutdown(0), { quietStartHour: cfg.wdaResignHour });

// the server's config dir (data/, next to ports.json): settings and the WDA signing record
const settings = new SettingsStore(path.join(cfg.dataDir, 'settings.json'));
const idle = new IdleLock(backend, () => settings.get().idleLockMinutes);
const onlinePhones = async () => (await backend.list()).filter((p) => p.online).map((p) => p.udid);
/**
 * 2026-11-27: the leases the ops side waits for (src/lifecycle.ts): each phone's actor (src/phone/actor.ts: the owner,
 * a hand, system work), and a live view open on it (the owner watching: an update would cut his picture) or an action
 * in the last 2 minutes (the idle tracker). System work (re-sign, fork install, self-test) takes the actor's own
 * System lease, so nothing of the owner's or an agent's runs under it.
 */
const leasePhones = new Set<string>();
{
  const refresh = () => void onlinePhones().then((ids) => {
    leasePhones.clear();
    for (const id of ids) leasePhones.add(id);
  }, () => {});
  refresh();
  setInterval(refresh, 10_000).unref();
}
const actors = actorsFor(backend);
setLeaseProbe(() => {
  const out: LeaseState[] = [];
  for (const udid of new Set([...leasePhones, ...actors.udids()])) {
    const a = actors.of(udid);
    const l = a.lease();
    if (l.kind !== 'free') {
      out.push({ udid, busy: true, who: l.kind === 'hand' ? `hand:${l.id}` : l.kind === 'system' ? `system:${l.op}` : 'owner' });
      continue;
    }
    if (a.busy()) {
      out.push({ udid, busy: true, who: `work on the phone (${a.describe()})` });
      continue;
    }
    const s = idle.state(udid);
    const recent = s.lastActive !== null && Date.now() - s.lastActive < 2 * 60_000;
    out.push({ udid, busy: s.viewers > 0 || recent, ...(s.viewers > 0 ? { who: `owner (${s.viewers} viewer${s.viewers === 1 ? '' : 's'})` } : recent ? { who: 'recent activity' } : {}) });
  }
  return out;
});
// the actor's System lease for system work (null: the phone isn't Free after all, and the work waits)
setSystemClaim((udid, op) => actors.of(udid).trySystem(op));
// The built runner's profile, of the stock WebDriverAgent and of our own build.
const profileOf = (derivedData: string) => path.join(derivedData, 'Build', 'Products', 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app', 'embedded.mobileprovision');
const forkBuildDir = cfg.wdaForkDerivedData ?? path.join(cfg.dataDir, 'wda-fork-build');
// wda/LOTUS_FORK.json: the version of our build in this checkout, and its two switches (they travel with a push)
const forkMeta = readForkMeta(ROOT);
version.fork = forkMeta?.version ?? null; // GET /health says it with the commit
/**
 * Fork v7's experiments, off by default (src/fork.ts forkExperimentEnv): WDA_APP_HIT_TEST=on in .env puts upstream's
 * accessibility hit test back into /wda/activeAppInfo; WDA_OFFMAIN_GESTURE=on (or "offMainGesture": true in
 * LOTUS_FORK.json, pushed from afar; .env's "off" wins) serves /lotus/gesture/offmain. A runner gets them at its next start.
 */
const onOff = (v: string | undefined) => (v === undefined || v === '' ? undefined : /^(1|on|true|yes)$/i.test(v));
const forkExperiments = {
  appHitTest: onOff(process.env.WDA_APP_HIT_TEST) ?? forkMeta?.appHitTest === true,
  offMainGesture: onOff(process.env.WDA_OFFMAIN_GESTURE) ?? forkMeta?.offMainGesture === true,
};
/**
 * The Apple team every build is signed with: WDA_TEAM_ID of .env, else the team of the WebDriverAgent that's already
 * built and trusted on the phones (read from its profile), so the same team and certificate are used with nothing typed.
 */
const teamId = (): string => {
  if (cfg.wdaTeamId) return cfg.wdaTeamId;
  for (const f of [profileOf(cfg.wdaDerivedData), profileOf(forkBuildDir)]) {
    try {
      const t = provisionTeam(fs.readFileSync(f));
      if (t) return t;
    } catch {
      /* not built */
    }
  }
  return '';
};
const signProblem = () =>
  process.platform !== 'darwin'
    ? 'WDA signing needs macOS'
    : teamId()
      ? null
      : 'the Apple Team ID is not known: WDA_TEAM_ID is not set in .env and no built WebDriverAgent profile says it (build once with scripts/build-wda.sh)';
// Each phone's build is signed by the same script with the same team and certificate; a phone on our own
// WebDriverAgent build (src/fork.ts) has that one built, from wda/ in this checkout.
const forkEnv: Record<string, string> = { WDA_BUILD_FLAVOR: 'fork', WDA_FORK_DERIVED_DATA: forkBuildDir };
const signRun = buildWdaRunner(ROOT, teamId, undefined, (udid) => (real?.wdaBuild(udid).flavor === 'fork' ? forkEnv : {}));

// Our own WebDriverAgent build: installed on each phone by the server itself, right after a version of it lands here
// (and whenever a phone that hasn't got it is plugged in). The stock one keeps running until ours answers.
let resignerRef: WdaResigner | undefined;
const fork = real
  ? new ForkInstaller({
      file: path.join(cfg.dataDir, 'wda-fork.json'),
      meta: forkMeta,
      enabled: cfg.wdaFork !== false && forkMeta?.enabled !== false,
      tokens: new ForkTokens(path.join(cfg.dataDir, 'wda-tokens.json')),
      project: path.join(ROOT, 'wda'),
      derivedData: forkBuildDir,
      port: (udid) => forkPort(cfg.wdaForkBasePort ?? 28100, real.wdaSlot(udid), udid, cfg.wdaForkPorts),
      build: buildWdaRunner(ROOT, teamId, undefined, () => forkEnv),
      switchTo: (udid, flavor) => real.switchWda(udid, flavor),
      selftest: cfg.wdaLiveTouch === 'off' ? undefined : (udid) => real.wdaSelftest(udid),
      liveSetting: cfg.wdaLiveTouch ?? 'auto',
      devices: onlinePhones,
      prepare: (udid) => idle.wake(udid),
      // 2026-11-17: the self-test runs only on a phone that's awake and unlocked (WDA's word and a look at the screen)
      awake: async (udid) => {
        const l = await real.isLocked(udid).catch(() => null);
        return l === null ? null : !l;
      },
      signed: () => resignerRef?.refresh(),
      // 2026-11-27: installs, re-tries and self-tests are system:<op> work that waits for a Free lease (src/lifecycle.ts)
      busy: (udid) => !phoneFree(udid),
      experiments: forkExperiments,
      problem: signProblem,
    })
  : undefined;
if (real && fork) real.useFork(fork);

const resigner =
  cfg.mock || !cfg.wdaResign
    ? undefined
    : new WdaResigner({
        file: path.join(cfg.dataDir, 'wda-sign.json'),
        // the profile that expires first, among the builds phones run now
        provisionFile: () => {
          const flavors = new Set((real ? real.wdaFlavors() : []) as string[]);
          return [...(flavors.has('fork') ? [profileOf(forkBuildDir)] : []), ...(flavors.has('stock') || !flavors.size ? [profileOf(cfg.wdaDerivedData)] : [])];
        },
        run: signRun,
        devices: onlinePhones,
        liveViewers: () => idle.liveViewers(),
        // 2026-11-27: each phone's build waits for its lease to be Free (system:resign), one phone at a time
        free: (udid) => phoneFree(udid),
        prepare: (udid) => idle.wake(udid),
        installed: (udid) => backend.restartWda?.(udid),
        quietStartHour: cfg.wdaResignHour,
        problem: signProblem,
      });
resignerRef = resigner;
const server = createServer(backend, cfg.token, updater, { settings, idle, resigner, version, fork, filesDir: path.join(cfg.dataDir, 'sends') });

server.listen(cfg.port, cfg.host, () => {
  console.log(`phone-farm-server ${version.commit ?? '(no commit)'} listening on http://${cfg.host}:${cfg.port} (${cfg.mock ? 'MOCK' : 'real'} mode)`);
});
// the WebRTC library (a native module) loads now rather than under the first viewer's offer
void loadRtc();

// 2026-11-21: one shutdown (a signal, the updater, a crash), each step's failure logged, and an exit after 20 s even
// when a phone never answers (launchd's ExitTimeOut is 30 s); open sockets are ended so server.close() can finish.
// 2026-11-27 (root cause §11, P6): it ends the API only. The WDA runners and forwards stay up for the next start to
// adopt (src/lifecycle.ts releaseDevices); the captures end with this process. Only SIGUSR2 (`launchctl kill SIGUSR2
// gui/$UID/com.lotus.phonefarm`) or STOP_DEVICES_ON_EXIT=true ends the device layer too.
let stopDevices = /^(1|true|yes)$/i.test(process.env.STOP_DEVICES_ON_EXIT ?? '');
const shutdown = makeShutdown(async () => {
  server.close();
  server.closeAllConnections?.();
  idle.close();
  resigner?.close();
  fork?.close();
  updater?.stop();
  try {
    await releaseDevices(backend, cfg.mock || stopDevices ? 'stop' : 'keep');
  } finally {
    rtcCleanup();
  }
});
installGuards(() => shutdown(1));
// launchd's log (deploy/com.lotus.phonefarm.plist), kept under 20 MB with three older ones; LOG_FILE= turns it off
{
  const logFile = process.env.LOG_FILE ?? path.join(ROOT, 'server.log');
  if (logFile) startLogRotation(logFile);
}
updater?.start(cfg.autoUpdateMinutes);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGUSR2', () => {
  stopDevices = true;
  shutdown(0);
});
