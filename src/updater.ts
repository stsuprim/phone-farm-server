import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const log = (m: string) => console.log(`[updater] ${new Date().toISOString()} ${m}`);

async function sh(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await run(cmd, args, { cwd, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export interface UpdateStatus {
  current: string | null;
  remote: string | null;
  upToDate: boolean | null;
  lastCheck: string | null;
  lastError: string | null;
}

export interface Updater {
  /** Fetches origin/main and compares it with local HEAD. */
  status(): Promise<UpdateStatus>;
  /** Runs the update now. started:true = build ok and restart triggered; otherwise the reason it skipped/failed. */
  now(): Promise<{ started: boolean; reason?: string }>;
  start(minutes: number): void;
}

/**
 * Outbound-only auto-update: fetch origin/main, and if it is ahead, fast-forward pull,
 * npm install (only when package files changed), npm run build, then call onRestart
 * (the process exits and launchd KeepAlive starts the new build).
 * Any failure keeps the running version and is logged. Dirty working tree = skip.
 */
export function createUpdater(onRestart: () => void, cwd = process.cwd()): Updater {
  let busy = false;
  let lastCheck: string | null = null;
  let lastError: string | null = null;

  const fail = (reason: string) => {
    lastError = reason;
    log(`skip/failed: ${reason}`);
    return { started: false, reason };
  };

  const attempt = async (): Promise<{ started: boolean; reason?: string }> => {
    if (busy) return { started: false, reason: 'an update check is already running' };
    busy = true;
    try {
      const branch = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      if (branch !== 'main') return fail(`on branch "${branch}", not main`);
      await sh('git', ['fetch', '--quiet', 'origin', 'main'], cwd);
      lastCheck = new Date().toISOString();
      const local = await sh('git', ['rev-parse', 'HEAD'], cwd);
      const remote = await sh('git', ['rev-parse', 'origin/main'], cwd);
      if (local === remote) {
        lastError = null;
        log(`up to date (${local.slice(0, 7)})`);
        return { started: false, reason: 'already up to date' };
      }
      if ((await sh('git', ['rev-list', '--count', 'origin/main..HEAD'], cwd)) !== '0') {
        return fail('local commits not on origin/main');
      }
      if ((await sh('git', ['status', '--porcelain', '--untracked-files=no'], cwd)) !== '') {
        return fail('working tree has uncommitted changes');
      }
      const changed = (await sh('git', ['diff', '--name-only', 'HEAD', 'origin/main'], cwd)).split('\n');
      log(`updating ${local.slice(0, 7)} -> ${remote.slice(0, 7)}`);
      await sh('git', ['merge', '--ff-only', 'origin/main'], cwd);
      try {
        if (changed.some((f) => f === 'package.json' || f === 'package-lock.json')) {
          log('package files changed: npm install');
          await sh('npm', ['install', '--no-audit', '--no-fund'], cwd);
        }
        log('npm run build');
        await sh('npm', ['run', 'build'], cwd);
      } catch (e) {
        // Build failed: go back to the old commit so the running (old) dist still matches the source.
        await sh('git', ['reset', '--hard', local], cwd).catch(() => undefined);
        throw e;
      }
      lastError = null;
      const nativeErr = path.join(cwd, 'native', 'phonecap', 'build', 'phonecap.error');
      if (fs.existsSync(nativeErr)) {
        const first = fs.readFileSync(nativeErr, 'utf8').split('\n')[0];
        log(`phonecap (H.264 helper) did not build, the live view will use MJPEG: ${first}`);
      }
      log(`build ok, restarting on ${remote.slice(0, 7)}`);
      // Give an HTTP response time to flush before the process exits.
      setTimeout(onRestart, 500);
      return { started: true };
    } catch (e) {
      const err = e as { message?: string; stderr?: string };
      return fail(`failed, keeping current version: ${(err.stderr || err.message || String(e)).toString().slice(0, 500)}`);
    } finally {
      busy = false;
    }
  };

  return {
    async status() {
      try {
        await sh('git', ['fetch', '--quiet', 'origin', 'main'], cwd);
        lastCheck = new Date().toISOString();
      } catch (e) {
        lastError = `fetch failed: ${((e as Error).message || String(e)).slice(0, 300)}`;
      }
      let current: string | null = null;
      let remote: string | null = null;
      try {
        current = await sh('git', ['rev-parse', 'HEAD'], cwd);
        remote = await sh('git', ['rev-parse', 'origin/main'], cwd);
      } catch (e) {
        lastError = ((e as Error).message || String(e)).slice(0, 300);
      }
      return { current, remote, upToDate: current && remote ? current === remote : null, lastCheck, lastError };
    },
    now: attempt,
    start(minutes: number) {
      if (!(minutes > 0)) return log('disabled (AUTO_UPDATE_MINUTES=0)');
      log(`checking GitHub every ${minutes} min`);
      setTimeout(() => void attempt(), 30_000);
      setInterval(() => void attempt(), minutes * 60_000);
    },
  };
}
