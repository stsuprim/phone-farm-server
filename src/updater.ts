import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { farmFree } from './lifecycle.js';
import { isQuietHour } from './resign.js';

// 2026-11-27: the server wires its actor's leases here (src/lifecycle.ts keeps them for every ops part)
export { setLeaseProbe, setSystemClaim } from './lifecycle.js';
export type { LeaseProbe, LeaseState } from './lifecycle.js';

const run = promisify(execFile);
const defaultLog = (m: string) => console.log(`[updater] ${new Date().toISOString()} ${m}`);

export type Sh = (cmd: string, args: string[], cwd: string, timeoutMs?: number) => Promise<string>;

const realSh: Sh = async (cmd, args, cwd, timeoutMs = 10 * 60_000) => {
  const { stdout } = await run(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

const errText = (e: unknown, max = 500) => {
  const err = e as { message?: string; stderr?: string; stdout?: string };
  return (err?.stderr || err?.stdout || err?.message || String(e)).toString().trim().slice(-max);
};

/**
 * 2026-11-27 (docs/root-cause.md §11, 13.3e): idle = nothing new; pending = a new commit, waiting for pushes to settle
 * (`debounceMs` after the last one); building = built (and the pre-release gate run) in the background while the
 * old build serves; ready = built and passed, waiting for every phone's lease to be Free (or a quiet hour);
 * restarting = the API restarts (the device layer stays up: src/lifecycle.ts releaseDevices).
 */
export type UpdaterState = 'idle' | 'pending' | 'building' | 'ready' | 'restarting';

export interface GateResult {
  commit: string;
  /** false: no `regress` script in that commit's package.json (passed, with a warning). */
  ran: boolean;
  ok: boolean;
  at: string;
  warning?: string;
  error?: string;
}

export interface UpdateStatus {
  current: string | null;
  remote: string | null;
  upToDate: boolean | null;
  lastCheck: string | null;
  lastError: string | null;
  /** origin/main commit whose build or gate failed; the poller won't retry it until main moves (POST /update/now retries). */
  failedCommit: string | null;
  pollSeconds: number;
  state: UpdaterState;
  /** The commit this process runs (read when it started). */
  running: string | null;
  /** The commit being waited on, built, or ready. */
  target: string | null;
  /** pending: when the debounce ends (ISO). */
  settlesAt: string | null;
  /** ready: since when, and the leases the restart waits for. */
  readyAt: string | null;
  waitingFor: string[];
  /** The last pre-release gate (npm run regress). */
  gate: GateResult | null;
}

export type UpdateResult = { started: boolean; reason?: string; state?: UpdaterState };

export interface Updater {
  /** Asks GitHub for main's commit and compares it with local HEAD. */
  status(): Promise<UpdateStatus>;
  /**
   * Updates now (POST /update/now): no debounce, a failed commit is tried again. started:true = the API restart was
   * triggered; a good build while a phone is in use waits (state "ready") unless `force`.
   */
  now(opts?: { force?: boolean }): Promise<UpdateResult>;
  /** Starts the poller. The argument is the interval in minutes (config.autoUpdateMinutes, 10 s by default); <= 0 disables. */
  start(minutes: number): void;
  /** One poll (the poller's step; tests call it). */
  tick(): Promise<UpdateResult>;
  stop(): void;
}

export interface UpdaterOptions {
  cwd?: string;
  /** Quiet time after the last push before building (ms; default 2 min). */
  debounceMs?: number;
  /** The quiet hours' start (3 h from it; default 3). A ready build restarts then even with a lease held. null: never. */
  quietStartHour?: number | null;
  /** The pre-release gate's limit (ms; default 20 min). */
  gateTimeoutMs?: number;
  /** Whether the checked-out package.json has a script (default: reads it from `cwd`). */
  hasScript?: (name: string) => boolean;
  /** Whether every phone is Free (default: src/lifecycle.ts farmFree, the leases the server wired). */
  free?: () => { free: boolean; who: string[] };
  sh?: Sh;
  now?: () => number;
  log?: (m: string) => void;
}

/**
 * Outbound-only updater. The Mac sits behind a home router, so nothing can push to it: every ~10 s it runs a tiny
 * `git ls-remote origin refs/heads/main`. A new commit isn't acted on at once (2026-11-27, root cause §11: every push
 * restarted every phone's runner and capture): it waits `debounceMs` after the last push, then builds in place
 * (fetch, `git checkout -f -B main origin/main`, npm install when package files changed, npm run build) while the old
 * process keeps serving, then runs the PRE-RELEASE GATE (`npm run regress`; a commit without that script passes with a
 * warning). Only a build that passed is restarted into, and only when every phone's lease is Free (no viewer, no
 * hand, no system work) or at a quiet hour; the restart ends the API only (src/index.ts, src/lifecycle.ts).
 *
 * A failed build or gate puts the last good commit back and rebuilds it, so dist/ stays on what runs (or what is
 * ready); the failure is logged and kept in status().lastError, and that commit isn't retried by the poller until a
 * newer one is pushed (POST /update/now retries).
 */
export function createUpdater(onRestart: () => void, cwdOrOpts: string | UpdaterOptions = {}): Updater {
  const o: UpdaterOptions = typeof cwdOrOpts === 'string' ? { cwd: cwdOrOpts } : cwdOrOpts;
  const cwd = o.cwd ?? process.cwd();
  const sh = o.sh ?? realSh;
  const now = o.now ?? Date.now;
  const log = o.log ?? defaultLog;
  const debounceMs = o.debounceMs ?? 2 * 60_000;
  const quietStartHour = o.quietStartHour === undefined ? 3 : o.quietStartHour;
  const gateTimeoutMs = o.gateTimeoutMs ?? 20 * 60_000;
  const free = o.free ?? farmFree;
  const hasScript =
    o.hasScript ??
    ((name: string) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
        return typeof j?.scripts?.[name] === 'string';
      } catch {
        return false;
      }
    });

  let state: UpdaterState = 'idle';
  let busy = false;
  let lastCheck: string | null = null;
  let lastError: string | null = null;
  let failedCommit: string | null = null;
  let pollSeconds = 0;
  let running: string | null = null; // what this process runs
  let built: string | null = null; // what dist/ holds (a good build)
  let target: string | null = null;
  let changedAt = 0; // when `target` last changed (the debounce counts from here)
  let readyAt: number | null = null;
  let waitingFor: string[] = [];
  let gate: GateResult | null = null;
  let timer: NodeJS.Timeout | undefined;
  let lastWaitSaid = '';

  const setState = (s: UpdaterState, why?: string) => {
    if (s === state) return;
    state = s;
    log(`${s}${target ? ` (${target.slice(0, 7)})` : ''}${why ? `: ${why}` : ''}`);
  };

  const fail = (reason: string): UpdateResult => {
    lastError = reason;
    log(`failed: ${reason}`);
    return { started: false, reason, state };
  };

  /** The remote main commit, by a tiny ls-remote (no objects downloaded). */
  const remoteHead = async (): Promise<string> => {
    const out = await sh('git', ['ls-remote', 'origin', 'refs/heads/main'], cwd, 15_000);
    const hash = out.split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error(`unexpected ls-remote output: ${out.slice(0, 120)}`);
    return hash;
  };

  const head = () => sh('git', ['rev-parse', 'HEAD'], cwd);

  /** Once: the commit this process started on (HEAD moves with each build in place). */
  const known = async () => {
    if (running === null) {
      running = await head();
      built ??= running;
    }
  };

  const install = (changed: string[]) =>
    changed.some((f) => f === 'package.json' || f === 'package-lock.json')
      ? (log('package files changed: npm install'), sh('npm', ['install', '--no-audit', '--no-fund'], cwd))
      : Promise.resolve('');

  /** The pre-release gate on what's checked out now; throws when it fails. */
  const runGate = async (commit: string): Promise<void> => {
    const at = new Date(now()).toISOString();
    if (!hasScript('regress')) {
      gate = { commit, ran: false, ok: true, at, warning: 'no "regress" script in package.json: the pre-release gate passed without running' };
      log(`gate: ${gate.warning}`);
      return;
    }
    log(`gate: npm run regress on ${commit.slice(0, 7)}`);
    try {
      await sh('npm', ['run', 'regress'], cwd, gateTimeoutMs);
      gate = { commit, ran: true, ok: true, at };
      log('gate: passed');
    } catch (e) {
      gate = { commit, ran: true, ok: false, at, error: errText(e, 800) };
      throw new Error(`the pre-release gate (npm run regress) failed: ${errText(e, 400)}`);
    }
  };

  /** Fetch, check out, install, build and gate `want`; on any failure the last good build is put back. */
  const build = async (want: string): Promise<boolean> => {
    const from = built!;
    setState('building', `from ${from.slice(0, 7)}; the running build keeps serving`);
    let changed: string[] = [];
    try {
      await sh('git', ['fetch', '--quiet', '--force', 'origin', '+refs/heads/main:refs/remotes/origin/main'], cwd);
      const fetched = await sh('git', ['rev-parse', 'origin/main'], cwd);
      if (fetched !== want) {
        // main moved again between the ls-remote and the fetch: wait for it to settle
        target = fetched;
        changedAt = now();
        setState('pending', 'main moved again');
        return false;
      }
      changed = (await sh('git', ['diff', '--name-only', from, want], cwd)).split('\n');
      await sh('git', ['checkout', '--quiet', '-f', '-B', 'main', want], cwd);
      await sh('git', ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'], cwd).catch(() => undefined);
      await install(changed);
      log('npm run build');
      await sh('npm', ['run', 'build'], cwd);
      await runGate(want);
    } catch (e) {
      failedCommit = want;
      const reason = `${(e as Error)?.message?.startsWith('the pre-release gate') ? (e as Error).message : `build of ${want.slice(0, 7)} failed: ${errText(e)}`}; kept ${running!.slice(0, 7)} running`;
      log(`rolling back to ${from.slice(0, 7)}`);
      try {
        await sh('git', ['checkout', '--quiet', '-f', '-B', 'main', from], cwd);
        await install(changed);
        await sh('npm', ['run', 'build'], cwd);
        log(`rolled back to ${from.slice(0, 7)} and rebuilt it`);
      } catch (e2) {
        log(`rollback rebuild failed too (the running process is still the old one): ${errText(e2, 300)}`);
      }
      target = from === running ? null : from;
      setState(from === running ? 'idle' : 'ready', 'the new build was refused');
      fail(reason);
      return false;
    }
    lastError = null;
    failedCommit = null;
    built = want;
    readyAt = now();
    const nativeErr = path.join(cwd, 'native', 'phonecap', 'build', 'phonecap.error');
    if (fs.existsSync(nativeErr)) {
      const text = fs.readFileSync(nativeErr, 'utf8');
      const first = text.split('\n').find((l) => /\berror:/i.test(l)) ?? text.split('\n')[0];
      log(`phonecap (H.264 helper) did not build, the live view will use MJPEG: ${first}`);
    }
    setState('ready', 'built and passed the gate');
    return true;
  };

  /** Ready: restart the API when every phone is Free (or at a quiet hour, or forced). */
  const maybeRestart = (force: boolean): UpdateResult => {
    const f = free();
    const quiet = quietStartHour !== null && isQuietHour(now(), quietStartHour);
    if (!force && !f.free && !quiet) {
      waitingFor = f.who;
      const said = f.who.join(', ');
      if (said !== lastWaitSaid) log(`ready, waiting for the phones to be free: ${said}`);
      lastWaitSaid = said;
      return { started: false, reason: `built ${built!.slice(0, 7)}; the restart waits until no phone is in use (${said})`, state };
    }
    waitingFor = [];
    lastWaitSaid = '';
    setState('restarting', force ? 'asked for' : f.free ? 'every phone is free' : `quiet hour (${f.who.join(', ')} still held)`);
    // Give an HTTP response time to flush before the process exits.
    setTimeout(onRestart, 500);
    return { started: true, state };
  };

  const step = async (manual: boolean, force = false): Promise<UpdateResult> => {
    if (state === 'restarting') return { started: false, reason: 'restarting', state };
    if (busy) return { started: false, reason: 'an update is already running', state };
    busy = true;
    try {
      await known();
      let remote: string;
      try {
        remote = await remoteHead();
        lastCheck = new Date(now()).toISOString();
      } catch (e) {
        // Network blips are normal on a home line: only note them, don't spam the log every 10 s.
        lastError = `GitHub check failed: ${errText(e, 300)}`;
        if (manual) log(lastError);
        // a ready build still restarts once the phones are free, network or not
        return state === 'ready' ? maybeRestart(force) : { started: false, reason: lastError, state };
      }
      if (remote === built) {
        if (built === running) {
          if (state !== 'idle') {
            target = null;
            setState('idle', 'main is back on the running commit');
          }
          if (manual) log(`up to date (${running!.slice(0, 7)})`);
          lastError = null;
          failedCommit = null;
          return { started: false, reason: 'already up to date', state };
        }
        target = built;
        if (state !== 'ready') setState('ready');
        return maybeRestart(force);
      }
      // main differs from what dist/ holds
      if (!manual && remote === failedCommit) {
        if (state === 'pending') setState(built === running ? 'idle' : 'ready');
        return state === 'ready' ? maybeRestart(force) : { started: false, reason: `build of ${remote.slice(0, 7)} failed before`, state };
      }
      if (target !== remote || state !== 'pending') {
        if (target !== remote) changedAt = now();
        target = remote;
        if (state !== 'pending') setState('pending', `new commit; built once pushes settle for ${Math.round(debounceMs / 1000)} s`);
      }
      if (!manual && now() - changedAt < debounceMs) return { started: false, reason: `waiting for pushes to settle (${remote.slice(0, 7)})`, state };
      log(`${manual ? 'manual' : 'settled'}: updating ${built!.slice(0, 7)} -> ${remote.slice(0, 7)}`);
      if (!(await build(remote))) return { started: false, reason: lastError ?? 'not built', state };
      return maybeRestart(force);
    } catch (e) {
      if (state === 'building') setState(built === running ? 'idle' : 'ready');
      return fail(`update failed, keeping current version: ${errText(e)}`);
    } finally {
      busy = false;
    }
  };

  return {
    async status() {
      let current: string | null = null;
      let remote: string | null = null;
      try {
        current = await head();
      } catch (e) {
        lastError = errText(e, 300);
      }
      try {
        remote = await remoteHead();
        lastCheck = new Date(now()).toISOString();
      } catch (e) {
        lastError = `GitHub check failed: ${errText(e, 300)}`;
      }
      return {
        current,
        remote,
        upToDate: current && remote ? current === remote : null,
        lastCheck,
        lastError,
        failedCommit,
        pollSeconds,
        state,
        running,
        target,
        settlesAt: state === 'pending' ? new Date(changedAt + debounceMs).toISOString() : null,
        readyAt: state === 'ready' && readyAt ? new Date(readyAt).toISOString() : null,
        waitingFor,
        gate,
      };
    },
    now: (opts) => step(true, opts?.force === true),
    tick: () => step(false),
    start(minutes: number) {
      const seconds = Math.round(minutes * 60);
      if (!(seconds > 0)) return log('disabled (AUTO_UPDATE_SECONDS=0)');
      pollSeconds = Math.max(5, seconds);
      log(`checking GitHub main every ${pollSeconds} s (a new commit is built after ${Math.round(debounceMs / 1000)} s quiet, gated, and restarted into when every phone is free)`);
      const loop = () => {
        timer = setTimeout(() => void step(false).finally(loop), pollSeconds * 1000);
        timer.unref?.();
      };
      timer = setTimeout(() => void step(false).finally(loop), 15_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearTimeout(timer);
    },
  };
}
