import fs from 'node:fs';

/**
 * 2026-11-21 (long runs): the process's own safety net.
 *
 * - A promise rejection nobody caught is logged and the server carries on: Node 20 would end the whole process for
 *   one forgotten `.catch()` deep in a phone's WDA code, and every phone's live view with it.
 * - An exception nobody caught leaves the process in an unknown state: logged, then the normal shutdown, and
 *   launchd's KeepAlive starts a fresh server. 2026-11-27: that shutdown leaves the WDA runners and forwards up
 *   (releaseDevices below): the next server adopts them, so a crash or an update never restarts the device layer.
 * - The shutdown runs once, and ends the process after `deadlineMs` even when a step hangs.
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

// ---- 2026-11-27 (root cause §11, §13.3c/e): leases, system work and a shutdown that leaves the device layer up ----

/** One phone's lease as the server's actor sees it (docs/root-cause.md 13.3c). No `udid`: it stands for every phone. */
export interface LeaseState {
  udid?: string;
  busy: boolean;
  /** Who holds it: "owner", "hand:<id>", "system:<op>"... */
  who?: string;
}
export type LeaseProbe = () => LeaseState[];
/** The actor's own System lease, taken for system work: its release, or null when the phone isn't Free after all. */
export type SystemClaim = (udid: string, op: string) => (() => void) | null;

let leaseProbe: LeaseProbe | null = null;
let systemClaim: SystemClaim | null = null;
/** System work running now (ours), by phone: what and since when. */
const systemRunning = new Map<string, { op: string; since: number }>();

/**
 * How the ops side (the updater, the re-sign, our build's install and self-test) hears whether a phone is in use.
 * The server wires it (its actor's leases); index.ts sets a stand-in from the idle tracker until then. null: none.
 */
export function setLeaseProbe(fn: LeaseProbe | null): void {
  leaseProbe = fn;
}

/** The actor's System lease, when it has one: system work takes it for its phone and gives it back after. */
export function setSystemClaim(fn: SystemClaim | null): void {
  systemClaim = fn;
}

/** Every lease the probe reports now. A probe that throws counts as one busy lease (nothing is assumed free). */
export function leaseStates(): LeaseState[] {
  if (!leaseProbe) return [];
  try {
    const got = leaseProbe();
    return Array.isArray(got) ? got.filter((l) => l && typeof l === 'object') : [];
  } catch (err) {
    return [{ busy: true, who: `unknown (the lease probe failed: ${(err as Error)?.message ?? String(err)})` }];
  }
}

/** The busy leases on `udid` (a lease without a phone counts for every phone); every busy one without `udid`. */
export function busyLeases(udid?: string): LeaseState[] {
  return leaseStates().filter((l) => l.busy && (udid === undefined || l.udid === undefined || l.udid === udid));
}

/** The phone's lease is Free: no owner, no hand, no system work of the actor's. */
export function phoneFree(udid: string): boolean {
  return busyLeases(udid).length === 0;
}

/** Whether every phone is Free (the probe's leases and our own system work); `who` lists what's held. */
export function farmFree(): { free: boolean; who: string[] } {
  const who = busyLeases().map((l) => `${l.who ?? 'in use'}${l.udid ? ` on ${l.udid.slice(-8)}` : ''}`);
  for (const [udid, s] of systemRunning) who.push(`system:${s.op} on ${udid.slice(-8)}`);
  return { free: who.length === 0, who };
}

/** The system work of ours running now (GET /api/wda can say it). */
export function systemWork(): { udid: string; op: string; since: string }[] {
  return [...systemRunning].map(([udid, s]) => ({ udid, op: s.op, since: new Date(s.since).toISOString() }));
}

export interface SystemTurnOptions {
  /** How long to wait for the phone's lease to be Free (ms; default 0: look once). */
  waitMs?: number;
  /** How often to look again meanwhile (ms; default 2 s). */
  pollMs?: number;
  /** Go whatever the lease says (an expiring profile, a self-test the owner asked for). */
  force?: boolean;
  /** The caller's own word on the phone too (its option's lease check): both must say Free. */
  free?: (udid: string) => boolean;
  log?: (m: string) => void;
}

export type SystemTurnResult<T> = { ran: true; value: T } | { ran: false; why: string };

/**
 * `system:<op>` work on one phone (root cause 13.3c: System waits for Free, never pre-empts): waits for the phone's
 * lease to be Free (at most `waitMs`), takes the actor's System lease when it has one, runs `fn`, gives it back.
 * One phone at a time across the Mac is the caller's `exclusive()` (src/resign.ts); this is the per-phone gate.
 */
export async function systemTurn<T>(op: string, udid: string, fn: () => Promise<T>, opts: SystemTurnOptions = {}): Promise<SystemTurnResult<T>> {
  const waitMs = opts.waitMs ?? 0;
  const pollMs = Math.max(10, opts.pollMs ?? 2000);
  const end = Date.now() + waitMs;
  let release: (() => void) | null = null;
  for (;;) {
    const held = opts.force ? [] : busyLeases(udid);
    if (!opts.force && !held.length && opts.free && !opts.free(udid)) held.push({ udid, busy: true, who: 'in use' });
    if (!held.length) {
      release = systemClaim ? systemClaim(udid, op) : () => {};
      if (release || opts.force) break;
    }
    if (Date.now() >= end) {
      const who = held.map((l) => l.who ?? 'in use').join(', ') || 'the System lease was refused';
      return { ran: false, why: `the phone is in use (${who})` };
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, end - Date.now()))));
  }
  const tag = `${udid.slice(-8)}`;
  systemRunning.set(udid, { op, since: Date.now() });
  opts.log?.(`${tag}: system:${op} starts`);
  try {
    return { ran: true, value: await fn() };
  } finally {
    if (systemRunning.get(udid)?.op === op) systemRunning.delete(udid);
    try {
      release?.();
    } catch {
      /* the actor's own trouble */
    }
  }
}

/** The device layer's two ways down: everything ended (the old way), or only the API side, runners left up. */
export interface DeviceLayer {
  close(): Promise<void>;
  /** 2026-11-27: a real stop of the device layer too (runners ended), when close() is the API layer's only. */
  stop?(): Promise<void>;
  /**
   * Ends the API side only (timers, captures, sockets) and leaves the WDA runners and their forwards running, their
   * pid, port and token kept (data/runners.json) for the next server to adopt. src/wda.ts's owner implements it.
   */
  detach?(): Promise<void>;
}

/**
 * How a shutdown leaves the phones (root cause §11, P6): `keep` (a signal, an update, a crash) never ends a WDA
 * runner or a forward: `detach()` when the backend has one, else nothing at all (the captures and HID helpers end by
 * themselves when this process goes: phonecap exits on stdin EOF or a new parent). `stop` ends everything.
 */
export async function releaseDevices(backend: DeviceLayer, mode: 'keep' | 'stop', log: (m: string) => void = (m) => console.error(m)): Promise<'detached' | 'left' | 'closed'> {
  if (mode === 'stop') {
    await (typeof backend.stop === 'function' ? backend.stop() : backend.close());
    return 'closed';
  }
  if (typeof backend.detach === 'function') {
    await backend.detach();
    log('[process] the phones\' WebDriverAgent runners stay up for the next start (detached)');
    return 'detached';
  }
  log('[process] the phones\' WebDriverAgent runners are left running (not ended on a restart)');
  return 'left';
}
