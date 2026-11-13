import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const log = (m: string) => console.log(`[updater] ${new Date().toISOString()} ${m}`);

async function sh(cmd: string, args: string[], cwd: string, timeoutMs = 10 * 60_000): Promise<string> {
  const { stdout } = await run(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

const errText = (e: unknown, max = 500) => {
  const err = e as { message?: string; stderr?: string };
  return (err?.stderr || err?.message || String(e)).toString().trim().slice(0, max);
};

export interface UpdateStatus {
  current: string | null;
  remote: string | null;
  upToDate: boolean | null;
  lastCheck: string | null;
  lastError: string | null;
  /** origin/main commit whose build failed; the poller won't retry it until main moves (POST /update/now retries). */
  failedCommit: string | null;
  pollSeconds: number;
}

export type UpdateResult = { started: boolean; reason?: string };

export interface Updater {
  /** Asks GitHub for main's commit and compares it with local HEAD. */
  status(): Promise<UpdateStatus>;
  /** Force-updates now (same path as the poller). started:true = build ok and restart triggered. */
  now(): Promise<UpdateResult>;
  /** Starts the poller. The argument is the interval in minutes (config.autoUpdateMinutes, 10 s by default); <= 0 disables. */
  start(minutes: number): void;
}

/**
 * Outbound-only force-updater. The Mac sits behind a home router, so nothing can push to it:
 * every ~10 s it runs a tiny `git ls-remote origin refs/heads/main`. When that hash differs from
 * HEAD it force-updates: fetch, `git checkout -f -B main origin/main` (a hard reset: local edits
 * and local commits are dropped; untracked/ignored files such as .env stay), npm install when
 * package files changed, npm run build, then onRestart (the process exits and launchd KeepAlive
 * starts the new build).
 *
 * If install/build fails, it resets back to the previous commit and rebuilds that, so the running
 * server and dist/ stay on a working version; the failure is logged and kept in status().lastError,
 * and that commit isn't retried by the poller until a newer one is pushed (POST /update/now retries).
 */
export function createUpdater(onRestart: () => void, cwd = process.cwd()): Updater {
  let busy = false;
  let lastCheck: string | null = null;
  let lastError: string | null = null;
  let failedCommit: string | null = null;
  let pollSeconds = 0;

  const fail = (reason: string): UpdateResult => {
    lastError = reason;
    log(`failed: ${reason}`);
    return { started: false, reason };
  };

  /** The remote main commit, by a tiny ls-remote (no objects downloaded). */
  const remoteHead = async (): Promise<string> => {
    const out = await sh('git', ['ls-remote', 'origin', 'refs/heads/main'], cwd, 15_000);
    const hash = out.split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error(`unexpected ls-remote output: ${out.slice(0, 120)}`);
    return hash;
  };

  const install = (changed: string[]) =>
    changed.some((f) => f === 'package.json' || f === 'package-lock.json')
      ? (log('package files changed: npm install'), sh('npm', ['install', '--no-audit', '--no-fund'], cwd))
      : Promise.resolve('');

  const forceUpdate = async (manual: boolean): Promise<UpdateResult> => {
    if (busy) return { started: false, reason: 'an update is already running' };
    busy = true;
    try {
      let remote: string;
      try {
        remote = await remoteHead();
        lastCheck = new Date().toISOString();
      } catch (e) {
        // Network blips are normal on a home line: only note them, don't spam the log every 10 s.
        lastError = `GitHub check failed: ${errText(e, 300)}`;
        if (manual) log(lastError);
        return { started: false, reason: lastError };
      }
      const local = await sh('git', ['rev-parse', 'HEAD'], cwd);
      if (local === remote) {
        if (manual) log(`up to date (${local.slice(0, 7)})`);
        lastError = null;
        failedCommit = null;
        return { started: false, reason: 'already up to date' };
      }
      if (!manual && remote === failedCommit) return { started: false, reason: `build of ${remote.slice(0, 7)} failed before` };

      log(`${manual ? 'manual' : 'new commit'}: force-updating ${local.slice(0, 7)} -> ${remote.slice(0, 7)}`);
      await sh('git', ['fetch', '--quiet', '--force', 'origin', '+refs/heads/main:refs/remotes/origin/main'], cwd);
      const target = await sh('git', ['rev-parse', 'origin/main'], cwd);
      const changed = (await sh('git', ['diff', '--name-only', local, target], cwd)).split('\n');
      await sh('git', ['checkout', '--quiet', '-f', '-B', 'main', target], cwd);
      await sh('git', ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'], cwd).catch(() => undefined);
      try {
        await install(changed);
        log('npm run build');
        await sh('npm', ['run', 'build'], cwd);
      } catch (e) {
        const reason = `build of ${target.slice(0, 7)} failed, kept ${local.slice(0, 7)} running: ${errText(e)}`;
        failedCommit = target;
        // Put the previous commit back and rebuild it, so dist/ matches the version that is running.
        log(`build failed, rolling back to ${local.slice(0, 7)}`);
        try {
          await sh('git', ['checkout', '--quiet', '-f', '-B', 'main', local], cwd);
          await install(changed);
          await sh('npm', ['run', 'build'], cwd);
          log(`rolled back to ${local.slice(0, 7)} and rebuilt it`);
        } catch (e2) {
          log(`rollback rebuild failed too (the running process is still the old one): ${errText(e2, 300)}`);
        }
        return fail(reason);
      }
      lastError = null;
      failedCommit = null;
      const nativeErr = path.join(cwd, 'native', 'phonecap', 'build', 'phonecap.error');
      if (fs.existsSync(nativeErr)) {
        const text = fs.readFileSync(nativeErr, 'utf8');
        const first = text.split('\n').find((l) => /\berror:/i.test(l)) ?? text.split('\n')[0];
        log(`phonecap (H.264 helper) did not build, the live view will use MJPEG: ${first}`);
      }
      log(`build ok, restarting on ${target.slice(0, 7)}`);
      // Give an HTTP response time to flush before the process exits.
      setTimeout(onRestart, 500);
      return { started: true };
    } catch (e) {
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
        current = await sh('git', ['rev-parse', 'HEAD'], cwd);
      } catch (e) {
        lastError = errText(e, 300);
      }
      try {
        remote = await remoteHead();
        lastCheck = new Date().toISOString();
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
      };
    },
    now: () => forceUpdate(true),
    start(minutes: number) {
      const seconds = Math.round(minutes * 60);
      if (!(seconds > 0)) return log('disabled (AUTO_UPDATE_SECONDS=0)');
      pollSeconds = Math.max(5, seconds);
      log(`checking GitHub main every ${pollSeconds} s (force-update on a new commit)`);
      const tick = () => void forceUpdate(false).finally(() => setTimeout(tick, pollSeconds * 1000));
      setTimeout(tick, 15_000);
    },
  };
}
