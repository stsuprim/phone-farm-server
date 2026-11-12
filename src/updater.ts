import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const log = (m: string) => console.log(`[updater] ${new Date().toISOString()} ${m}`);

async function sh(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await run(cmd, args, { cwd, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Outbound-only auto-update: fetch origin/main, and if it is ahead, fast-forward pull,
 * npm install (only when package files changed), npm run build, then call onRestart
 * (the process exits and launchd KeepAlive starts the new build).
 * Any failure keeps the running version and is logged. Dirty working tree = skip.
 */
export function startUpdater(minutes: number, onRestart: () => void, cwd = process.cwd()): void {
  if (!(minutes > 0)) {
    log('disabled (AUTO_UPDATE_MINUTES=0)');
    return;
  }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const branch = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      if (branch !== 'main') return log(`skip: on branch "${branch}", not main`);
      await sh('git', ['fetch', '--quiet', 'origin', 'main'], cwd);
      const local = await sh('git', ['rev-parse', 'HEAD'], cwd);
      const remote = await sh('git', ['rev-parse', 'origin/main'], cwd);
      if (local === remote) return;
      if ((await sh('git', ['rev-list', '--count', 'origin/main..HEAD'], cwd)) !== '0') {
        return log('skip: local commits not on origin/main');
      }
      if ((await sh('git', ['status', '--porcelain'], cwd)) !== '') {
        return log('skip: working tree has uncommitted changes');
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
      log(`build ok, restarting on ${remote.slice(0, 7)}`);
      onRestart();
    } catch (e) {
      const err = e as { message?: string; stderr?: string };
      log(`failed, keeping current version: ${(err.stderr || err.message || String(e)).toString().slice(0, 500)}`);
    } finally {
      busy = false;
    }
  };
  log(`checking GitHub every ${minutes} min`);
  setTimeout(() => void tick(), 30_000);
  setInterval(() => void tick(), minutes * 60_000);
}
