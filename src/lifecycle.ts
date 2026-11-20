import fs from 'node:fs';

/**
 * 2026-11-21 (long runs): the process's own safety net.
 *
 * - A promise rejection nobody caught is logged and the server carries on: Node 20 would end the whole process for
 *   one forgotten `.catch()` deep in a phone's WDA code, and every phone's live view with it.
 * - An exception nobody caught leaves the process in an unknown state: logged, then the normal shutdown (WDA runners
 *   and forwards ended, captures stopped), and launchd's KeepAlive starts a fresh server.
 * - The shutdown runs once, and ends the process after `deadlineMs` even when a step hangs (a phone that never
 *   answers its session delete), so launchd never has to SIGKILL it with the runners still up.
 */
export interface Guards {
  /** How many rejections were caught and logged (the same reason at most once a minute in the log). */
  rejections(): number;
  uninstall(): void;
}

export function installGuards(onFatal: (err: unknown) => void, log: (m: string) => void = (m) => console.error(m)): Guards {
  let count = 0;
  const lastSaid = new Map<string, number>();
  const onRejection = (reason: unknown) => {
    count++;
    const text = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    const key = (reason instanceof Error ? `${reason.name}: ${reason.message}` : text).slice(0, 200);
    const now = Date.now();
    if (now - (lastSaid.get(key) ?? 0) < 60_000) return;
    lastSaid.set(key, now);
    if (lastSaid.size > 200) lastSaid.clear();
    log(`[process] unhandled rejection (the server carries on): ${text.slice(0, 2000)}`);
  };
  const onException = (err: unknown) => {
    log(`[process] uncaught exception, shutting down for a clean restart: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    onFatal(err);
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return {
    rejections: () => count,
    uninstall: () => {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
    },
  };
}

/**
 * A shutdown that runs once: `steps` in order (each one's failure logged, never stopping the rest), then
 * `exit(code)`; or `exit(code)` at `deadlineMs` when a step never ends. Returns the trigger.
 */
export function makeShutdown(
  steps: () => Promise<void> | void,
  opts: { deadlineMs?: number; exit?: (code: number) => void; log?: (m: string) => void } = {},
): (code?: number) => void {
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const log = opts.log ?? ((m: string) => console.error(m));
  const deadlineMs = opts.deadlineMs ?? 20_000;
  let started = false;
  let exited = false;
  const end = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  return (code = 0) => {
    if (started) return;
    started = true;
    const t = setTimeout(() => {
      log(`[process] shutdown still running after ${Math.round(deadlineMs / 1000)} s: exiting anyway`);
      end(code);
    }, deadlineMs);
    t.unref?.();
    Promise.resolve()
      .then(steps)
      .catch((err) => log(`[process] shutdown step failed: ${(err as Error)?.message ?? String(err)}`))
      .finally(() => {
        clearTimeout(t);
        end(code);
      });
  };
}

/**
 * The log launchd writes (deploy/com.lotus.phonefarm.plist's StandardOutPath, server.log) is never rotated by
 * anyone: weeks of runs filled the Mac's disk. When it's over `maxBytes` it's copied to `<file>.1` (the older
 * ones move up to `.keep`, the oldest dropped) and cut to nothing in place, so launchd's open handle (O_APPEND)
 * writes on at the start of the same file. Returns whether it rotated.
 */
export function rotateLog(file: string, maxBytes: number, keep = 3, fsx: Pick<typeof fs, 'statSync' | 'renameSync' | 'copyFileSync' | 'truncateSync' | 'rmSync'> = fs): boolean {
  let size: number;
  try {
    size = fsx.statSync(file).size;
  } catch {
    return false; // no log there (a dev run, MOCK, another StandardOutPath)
  }
  if (size <= maxBytes) return false;
  try {
    fsx.rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      try {
        fsx.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        /* not there */
      }
    }
    fsx.copyFileSync(file, `${file}.1`);
    fsx.truncateSync(file, 0);
    return true;
  } catch (err) {
    console.error(`[log] rotating ${file} failed: ${(err as Error).message}`);
    return false;
  }
}

/** rotateLog now and every `everyMs`. Returns the stop. */
export function startLogRotation(file: string, maxBytes = 20 * 1024 * 1024, keep = 3, everyMs = 10 * 60_000): () => void {
  const tick = () => {
    if (rotateLog(file, maxBytes, keep)) console.log(`[log] ${file} passed ${Math.round(maxBytes / 1048576)} MB: older lines in ${file}.1`);
  };
  tick();
  const t = setInterval(tick, everyMs);
  t.unref();
  return () => clearInterval(t);
}
