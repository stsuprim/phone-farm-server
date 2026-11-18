import type { Backend } from './types.js';

/**
 * Idle lock and wake. After `idleLockMinutes` (src/settings.ts) with no input and no open viewer on a phone, the
 * server locks it (screen off: WDA /wda/lock). Input or a new viewer (a stream or WebRTC session) counts as activity:
 * it wakes the phone by itself (WDA /wda/unlock: home press + swipe, which lands past the lock screen when there's no
 * passcode) before the input goes through.
 *
 * Input only waits for a wake when the phone is known to be locked, so a tap on an awake phone pays nothing.
 */

export interface PowerState {
  locked: boolean | null;
  screenOn: boolean | null;
  lastActive: number | null;
  viewers: number;
  /** The last lock/wake failure (e.g. a passcode keeps it locked), or null. */
  error: string | null;
}

interface Entry extends PowerState {
  known: boolean; // seen online + ready since the server started (idle time counts from then)
  busy?: Promise<void>; // a lock or wake in progress
  checkedAt: number; // when the phone was last asked whether it's locked before an input
  unsure?: boolean; // the last ask got no answer: every input asks again until one comes
  asked?: boolean; // locked on request (an idle lock, a lock key, a switch of the live phone), not found dark
}

/** A phone can't have gone dark by itself sooner than this after its last input (iOS's shortest Auto-Lock is 30 s). */
export const AWAKE_FOR_MS = 25_000;
/** An input waits this long at most to hear whether the phone is locked. */
const LOCKED_ASK_MS = 4000;

export interface IdleOptions {
  now?: () => number;
  /** How often the idle check runs (ms; default 30 s). 0 = never on its own (tests call tick()). */
  tickMs?: number;
  log?: (m: string) => void;
  /** Which phones can be locked now (online, WDA ready); default: backend.list(). */
  devices?: () => Promise<string[]>;
}

export class IdleLock {
  private st = new Map<string, Entry>();
  private timer?: NodeJS.Timeout;
  private now: () => number;
  private log: (m: string) => void;
  private ticking = false;

  constructor(private backend: Backend, private minutes: () => number, private o: IdleOptions = {}) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[idle] ${m}`));
    const every = o.tickMs ?? 30_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.tick(), every);
      this.timer.unref();
    }
  }

  /** Whether lock/wake can work on this backend at all. */
  get supported(): boolean {
    return typeof this.backend.lock === 'function' && typeof this.backend.unlock === 'function';
  }

  private entry(udid: string): Entry {
    let e = this.st.get(udid);
    if (!e) this.st.set(udid, (e = { locked: null, screenOn: null, lastActive: null, viewers: 0, error: null, known: false, checkedAt: -Infinity }));
    return e;
  }

  state(udid: string): PowerState {
    const e = this.st.get(udid);
    return e
      ? { locked: e.locked, screenOn: e.screenOn, lastActive: e.lastActive, viewers: e.viewers, error: e.error }
      : { locked: null, screenOn: null, lastActive: null, viewers: 0, error: null };
  }

  /** Open viewers on every phone (the WDA re-sign waits for none unless expiry is close). */
  liveViewers(): number {
    let n = 0;
    for (const e of this.st.values()) n += e.viewers;
    return n;
  }

  /**
   * Input on the phone: counts as activity. Returns a promise to wait on only when the phone is known to be locked
   * (the wake), or, for a `discrete` action (a tap, a swipe, a touch's down, typing) on a phone left alone long
   * enough to have gone dark by itself, while it's asked and woken if it is; else null (nothing to wait for).
   */
  activity(udid: string, discrete = false): Promise<void> | null {
    const e = this.entry(udid);
    const now = this.now();
    const quiet = e.lastActive === null ? Infinity : now - e.lastActive;
    e.lastActive = now;
    e.known = true;
    if (e.busy) return e.busy.catch(() => {});
    if (e.locked === true) return this.wake(udid).then(() => undefined, () => undefined);
    if (discrete && this.supported && this.backend.isLocked && (quiet >= AWAKE_FOR_MS || e.unsure) && now - e.checkedAt >= AWAKE_FOR_MS) {
      e.checkedAt = now;
      return this.ensureAwake(udid).catch(() => {});
    }
    return null;
  }

  /** Ask the phone whether it's locked (it may have gone dark by itself) and wake it if it is; never presses blind. */
  private ensureAwake(udid: string): Promise<void> {
    const e = this.entry(udid);
    return this.serial(e, async () => {
      const ask = this.backend.isLocked!(udid).catch(() => null);
      const l = await Promise.race([ask, new Promise<null>((r) => setTimeout(() => r(null), LOCKED_ASK_MS).unref?.())]);
      if (l !== null) e.unsure = false;
      if (l === false) {
        e.locked = false;
        e.screenOn = true;
        return;
      }
      if (l !== true) {
        // it can't tell (WDA slow to answer after a quiet spell): the input goes as it is, and the next one asks again
        // rather than every input for the next 25 s going to a phone that may be dark
        e.checkedAt = -Infinity;
        e.unsure = true;
        return;
      }
      e.locked = true;
      e.screenOn = false;
      await this.backend.unlock!(udid);
      this.backend.silence?.(udid, 'woken before an input');
      const still = await this.backend.isLocked!(udid).catch(() => null);
      e.screenOn = true;
      e.locked = still === true;
      e.error = still ? 'still locked after wake (a passcode is set: enter it on the phone once, or remove it)' : null;
      if (!still) this.log(`${udid.slice(-8)} was dark: woke before the input`);
    });
  }

  /**
   * What a health check learned about the lock (not activity): a phone found locked is woken by the next input
   * before it acts, without asking first. 2026-11-16: one found locked or dark that nobody asked to lock, while a
   * viewer watches it (it went dark by itself: iOS's Auto-Lock), is woken now, so a watched phone never stays black.
   */
  note(udid: string, locked: boolean | null): void {
    if (locked === null) return;
    const e = this.entry(udid);
    if (e.busy) return; // a lock or wake in progress says better
    e.unsure = false;
    e.locked = locked;
    e.screenOn = !locked;
    if (!locked) e.asked = false;
    else if (!e.asked && e.viewers > 0 && this.supported) {
      this.log(`${udid.slice(-8)} went dark while watched: waking`);
      void this.wake(udid).catch(() => {});
    }
  }

  /**
   * A viewer opened (stream or WebRTC session): activity, and the phone wakes. Returns the release. 2026-11-17:
   * `wake: false` (the control socket): activity only, the phone is left as it is (a Lotus that opens a phone's
   * control link has had the owner press Unlock, which wakes it by POST /wake; a picture's own offer wakes it too).
   */
  viewer(udid: string, wake = true): () => void {
    const e = this.entry(udid);
    e.viewers++;
    e.lastActive = this.now();
    e.known = true;
    // a viewer isn't latency-critical: the phone is asked whether it's locked or dark unless it's known to be
    // (2026-11-16: also when it's thought awake: a phone that went dark by itself says nothing, and showed black)
    if (wake && this.supported) void this.wake(udid, e.locked !== true).catch(() => {});
    let done = false;
    return () => {
      if (done) return;
      done = true;
      e.viewers = Math.max(0, e.viewers - 1);
      e.lastActive = this.now();
    };
  }

  /**
   * Wake and unlock now. `check`: ask first and do nothing if it's already unlocked. `force` (2026-11-18: the live
   * view's capture gives no picture): a screen that can't be looked at counts as dark (src/dark.ts wakeScreen).
   * After a wake the phone is silenced again (src/audio.ts, at most every few minutes).
   */
  wake(udid: string, check = false, force = false): Promise<PowerState> {
    const e = this.entry(udid);
    e.lastActive = this.now();
    e.known = true;
    return this.serial(e, async () => {
      if (!this.backend.unlock) throw new Error('this backend cannot wake phones');
      if (check && this.backend.isLocked) {
        const l = await this.backend.isLocked(udid).catch(() => null);
        if (l === false) {
          e.locked = false;
          e.screenOn = true;
          return;
        }
      }
      await (force ? this.backend.unlock(udid, { force: true }) : this.backend.unlock(udid));
      this.backend.silence?.(udid, 'woken');
      const still = this.backend.isLocked ? await this.backend.isLocked(udid).catch(() => null) : false;
      e.asked = false;
      e.screenOn = true;
      e.locked = still === null ? false : still;
      e.error = still ? 'still locked after wake (a passcode is set: enter it on the phone once, or remove it)' : null;
      if (!still) this.log(`${udid.slice(-8)} woke`);
    }).then(() => this.state(udid));
  }

  /**
   * 2026-11-18 (a live view stuck on "connecting" while the phone's screen was off): the capture gave no picture, so
   * the phone is woken now, whatever was thought of it (`force`: a screen that can't be looked at counts as dark).
   * Resolves null when it's awake, else why not, in a line for the viewer.
   */
  async wakeForPicture(udid: string, force = true): Promise<string | null> {
    if (!this.supported) return 'this server cannot wake phones';
    try {
      const st = await this.wake(udid, false, force);
      if (st.locked) return st.error ?? 'the phone stayed locked (a passcode is set: enter it on the phone once, or remove it)';
      return null;
    } catch (err) {
      return (err as Error)?.message?.slice(0, 200) || 'the wake failed';
    }
  }

  /** Lock (screen off) now. */
  lock(udid: string): Promise<PowerState> {
    const e = this.entry(udid);
    return this.serial(e, async () => {
      if (!this.backend.lock) throw new Error('this backend cannot lock phones');
      await this.backend.lock(udid);
      e.locked = true;
      e.screenOn = false;
      e.asked = true;
      e.error = null;
    }).then(() => this.state(udid));
  }

  private serial(e: Entry, fn: () => Promise<void>): Promise<void> {
    const prev = e.busy ?? Promise.resolve();
    const p = prev.catch(() => {}).then(fn);
    const mine = p.then(
      () => undefined,
      (err: Error) => {
        e.error = err?.message?.slice(0, 200) ?? 'failed';
      },
    );
    e.busy = mine;
    void mine.then(() => {
      if (e.busy === mine) e.busy = undefined;
    });
    return p;
  }

  /** Whether a phone should be locked now (idle long enough, nobody watching, not already locked). Pure. */
  static due(e: Pick<PowerState, 'locked' | 'viewers' | 'lastActive'>, minutes: number, now: number): boolean {
    if (!(minutes > 0) || e.viewers > 0 || e.locked === true || e.lastActive === null) return false;
    return now - e.lastActive >= minutes * 60_000;
  }

  /** The periodic check: learn the phones, lock the idle ones. Returns the phones it locked. */
  async tick(): Promise<string[]> {
    if (this.ticking || !this.supported) return [];
    this.ticking = true;
    const locked: string[] = [];
    try {
      const ids = this.o.devices
        ? await this.o.devices()
        : (await this.backend.list()).filter((p) => p.online && p.ready).map((p) => p.udid);
      const now = this.now();
      for (const udid of ids) {
        const e = this.entry(udid);
        if (!e.known) {
          e.known = true;
          e.lastActive ??= now; // idle time counts from when the server first saw it
        }
      }
      const minutes = this.minutes();
      for (const udid of ids) {
        const e = this.entry(udid);
        if (e.busy || !IdleLock.due(e, minutes, now)) continue;
        try {
          await this.lock(udid);
          locked.push(udid);
          this.log(`${udid.slice(-8)} locked after ${minutes} min idle`);
        } catch (err) {
          this.log(`${udid.slice(-8)} could not be locked: ${(err as Error).message}`);
          e.lastActive = now; // try again after another idle period, not every tick
        }
      }
    } finally {
      this.ticking = false;
    }
    return locked;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
