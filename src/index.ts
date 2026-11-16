import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { ForkInstaller, forkPort, ForkTokens, readForkMeta } from './fork.js';
import { IdleLock } from './idle.js';
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
const version = { commit: commitNow(), startedAt: new Date().toISOString() };
const cfg = loadConfig();
if (!cfg.mock && !cfg.wdaProject) {
  console.error('WDA_PROJECT is not set in .env (see README), or set MOCK=true.');
  process.exit(1);
}
if (readForkMeta(ROOT)?.liveTouch === 'off') cfg.wdaLiveTouch = 'off';
const real = cfg.mock ? null : new RealBackend(cfg);
const backend = real ?? new MockBackend(cfg.mockPhones);
const updater = cfg.mock ? undefined : createUpdater(() => shutdown());

// the server's config dir (data/, next to ports.json): settings and the WDA signing record
const settings = new SettingsStore(path.join(cfg.dataDir, 'settings.json'));
const idle = new IdleLock(backend, () => settings.get().idleLockMinutes);
const onlinePhones = async () => (await backend.list()).filter((p) => p.online).map((p) => p.udid);
// The built runner's profile, of the stock WebDriverAgent and of our own build.
const profileOf = (derivedData: string) => path.join(derivedData, 'Build', 'Products', 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app', 'embedded.mobileprovision');
const forkBuildDir = cfg.wdaForkDerivedData ?? path.join(cfg.dataDir, 'wda-fork-build');
// wda/LOTUS_FORK.json: the version of our build in this checkout, and its two switches (they travel with a push)
const forkMeta = readForkMeta(ROOT);
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
      devices: onlinePhones,
      prepare: (udid) => idle.wake(udid),
      // 2026-11-17: the self-test runs only on a phone that's awake and unlocked (WDA's word and a look at the screen)
      awake: async (udid) => {
        const l = await real.isLocked(udid).catch(() => null);
        return l === null ? null : !l;
      },
      signed: () => resignerRef?.refresh(),
      busy: (udid) => {
        const s = idle.state(udid);
        return s.viewers > 0 || (s.lastActive !== null && Date.now() - s.lastActive < 2 * 60_000);
      },
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
        prepare: (udid) => idle.wake(udid),
        installed: (udid) => backend.restartWda?.(udid),
        quietStartHour: cfg.wdaResignHour,
        problem: signProblem,
      });
resignerRef = resigner;
const server = createServer(backend, cfg.token, updater, { settings, idle, resigner, version, fork });

server.listen(cfg.port, cfg.host, () => {
  console.log(`phone-farm-server ${version.commit ?? '(no commit)'} listening on http://${cfg.host}:${cfg.port} (${cfg.mock ? 'MOCK' : 'real'} mode)`);
});
// the WebRTC library (a native module) loads now rather than under the first viewer's offer
void loadRtc();

const shutdown = () => {
  server.close();
  idle.close();
  resigner?.close();
  fork?.close();
  void backend.close().finally(() => {
    rtcCleanup();
    process.exit(0);
  });
};
updater?.start(cfg.autoUpdateMinutes);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
