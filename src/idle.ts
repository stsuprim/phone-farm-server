import { actorsFor, Actors } from './phone/actor.js';
import { AWAKE_FOR_MS, isPowerFeed, PowerTracker, PowerView } from './phone/power.js';
import type { Backend } from './types.js';

/**
 * Idle lock and wake. After `idleLockMinutes` (src/settings.ts) with no input and no open viewer on a phone, the
 * server locks it (screen off: WDA /wda/lock), under the phone's `system` lease (src/phone/actor.ts): only a phone
 * that's Free (nobody driving it, nothing on its way) is locked, never inside an input's turn.
 *
 * 2026-11-27 (docs/root-cause.md 13.3d, G6): the power state comes from observations only (src/phone/power.ts).
 * Nothing is pressed on inference: an input is never preceded by a "is it locked?" look of its own, a screen that
 * couldn't be looked at is never woken with Home presses, and a wake goes out only when asked (POST /wake, the wake
 * key, a viewer's open) or on an observed dark or locked screen. An input on a phone observed locked or dark (the
 * server's own idle lock, a watch that saw it) has that phone woken first, as its own turn in the phone's queue.
 */

export interface PowerState {
  locked: boolean | null;
  screenOn: boolean | null;
  lastActive: number | null;
  viewers: number;
  /** The last lock/wake failure (e.g. a passcode keeps it locked), or null. */
  error: string | null;
  /** 2026-11-27: what was observed of the screen, and when (src/phone/power.ts): Unknown is never acted on. */
  power?: PowerView;
}

interface Entry extends PowerState {
  known: boolean; // seen online + ready since the server started (idle time counts from then)
  busy?: Promise<void>; // a lock or wake in progress
  busyKind?: 'wake' | 'lock';
  asked?: boolean; // locked on request (an idle lock, a lock key, a switch of the live phone), not found dark
}

export { AWAKE_FOR_MS };
/** A wake for a live view that has no picture waits this long at most for the phone's control link to come up. */
export const PICTURE_WAKE_WAIT_MS = 150_000;
/** A lock or wake (a power job) must start within this long, else it's refused (the phone is busy). */
const POWER_START_MS = 30_000;
/** A wake in front of an input takes at most this long; then the input goes anyway. */
const WAKE_BEFORE_INPUT_MS = 30_000;

export interface IdleOptions {
  now?: () => number;
  /** How often the idle check runs (ms; default 30 s). 0 = never on its own (tests call tick()). */
  tickMs?: number;
  log?: (m: string) => void;
  /** Which phones can be locked now (online, WDA ready); default: backend.list(). */
  devices?: () => Promise<string[]>;
  /** The phones' actors (default: the backend's, shared with its Control). */
  actors?: Actors;
}

export class IdleLock {
  private st = new Map<string, Entry>();
  private timer?: NodeJS.Timeout;
  private now: () => number;
  private log: (m: string) => void;
  private ticking = false;
  private actors: Actors;
  /** What was observed of each phone's screen (src/phone/power.ts). */
  readonly power: PowerTracker;
  private unwatch?: () => void;

  constructor(private backend: Backend, private minutes: () => number, private o: IdleOptions = {}) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[idle] ${m}`));
    this.actors = o.actors ?? actorsFor(backend);
    this.power = new PowerTracker(this.now);
    // the backend says what it saw as it reads the screen (a moving capture, a still, WDA's lock word)
    if (isPowerFeed(backend)) this.unwatch = backend.watchPower((udid, ob) => this.power.observe(udid, ob));
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
    if (!e) this.st.set(udid, (e = { locked: null, screenOn: null, lastActive: null, viewers: 0, error: null, known: false }));
    return e;
  }

  state(udid: string): PowerState {
    const e = this.st.get(udid);
    const power = this.power.view(udid);
    return e
      ? { locked: e.locked, screenOn: e.screenOn, lastActive: e.lastActive, viewers: e.viewers, error: e.error, power }
      : { locked: null, screenOn: null, lastActive: null, viewers: 0, error: null, power };
  }

  /** Open viewers on every phone (the WDA re-sign waits for none unless expiry is close). */
  liveViewers(): number {
    let n = 0;
    for (const e of this.st.values()) n += e.viewers;
    return n;
  }

  /** Observed off: locked by the server (and not woken since) or seen dark or locked. */
  private observedOff(udid: string, e: Entry): boolean {
    return e.locked === true || this.power.observedOff(udid);
  }

  /**
   * Input on the phone: counts as activity. Returns a promise to wait on (as its own turn, before the input: see
   * Control) only when the phone was observed locked or dark: the wake; else null. 2026-11-27: no look of its own
   * before an input any more (it used to ask the phone after 25 s of quiet, inside the input's turn), and a lock in
   * progress is never waited for (input never waits behind a power action).
   */
  activity(udid: string, _discrete = false): Promise<void> | null {
    const e = this.entry(udid);
    e.lastActive = this.now();
    e.known = true;
    if (e.busy && e.busyKind === 'wake') return e.busy.catch(() => {});
    // the wake goes into the phone's input line now, so it's the turn right before this input's
    if (this.supported && !e.busy && this.observedOff(udid, e)) return this.wakeNow(udid, true, false, 'input').then(() => undefined, () => undefined);
    return null;
  }

  /**
   * What a health check learned about the lock (not activity): a phone found locked is woken by the next input
   * before it acts. 2026-11-16: one found locked or dark that nobody asked to lock, while a viewer watches it (it went
   * dark by itself: iOS's Auto-Lock), is woken now (an observation, never an inference), so a watched phone never
   * stays black. `null` (it couldn't tell) changes nothing.
   */
  note(udid: string, locked: boolean | null): void {
    if (locked === null) return;
    const e = this.entry(udid);
    if (e.busy) return; // a lock or wake in progress says better
    this.power.observe(udid, { screen: locked ? 'locked' : 'on', from: 'watch' });
    e.locked = locked;
    e.screenOn = !locked;
    if (!locked) e.asked = false;
    else if (!e.asked && e.viewers > 0 && this.supported) {
      this.log(`${udid.slice(-8)} went dark while watched: waking`);
      void this.wakeNow(udid, true).catch(() => {});
    }
  }

  /**
   * A viewer opened (stream or WebRTC session): activity, and the phone wakes if it's observed off. Returns the
   * release. 2026-11-17: `wake: false` (the control socket): activity only, the phone is left as it is (a Lotus that
   * opens a phone's control link has had the owner press Unlock, which wakes it by POST /wake; a picture's own offer
   * wakes it too).
   */
  viewer(udid: string, wake = true): () => void {
    const e = this.entry(udid);
    e.viewers++;
    e.lastActive = this.now();
    e.known = true;
    // a viewer isn't latency-critical: the phone is looked at (never pressed blind) and woken only when that shows
    // it's locked or dark
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
   * Wake and unlock now. Without `check` it's the owner's explicit wake (POST /wake, the wake key): WDA's unlock goes
   * even when the phone doesn't say whether it's locked. With `check` (a viewer, an offer) the phone is asked first and
   * left alone when it's unlocked. Either way Home is pressed only on a screen observed dark (src/dark.ts). `force`
   * is kept for callers and changes nothing now (2026-11-27). After a wake the phone is silenced again.
   */
  wake(udid: string, check = false, _force = false): Promise<PowerState> {
    return this.wakeNow(udid, false, check).then(() => this.state(udid));
  }

  /**
   * One wake as a power job of the phone's actor. `observed`: it's for an observed Locked/Dark (automatic), so WDA's
   * unlock goes only on its own "locked". Inside an input's job (the owner's wake key) it runs in that turn.
   */
  private wakeNow(udid: string, observed: boolean, check = false, line: 'input' | 'power' = 'power'): Promise<void> {
    const e = this.entry(udid);
    e.lastActive = this.now();
    e.known = true;
    return this.serial(e, 'wake', () =>
      this.actors.of(udid).submit({
        // before an input: its own turn in the input line (the input follows it); else a power job beside input
        kind: line, label: 'wake', who: { server: 'power' }, startWithinMs: POWER_START_MS,
        ...(line === 'input' ? { timeoutMs: WAKE_BEFORE_INPUT_MS, must: true } : {}),
        run: async () => {
          if (!this.backend.unlock) throw new Error('this backend cannot wake phones');
          if (check && this.backend.isLocked) {
            const l = await this.backend.isLocked(udid).catch(() => null);
            if (l === false) {
              this.power.observe(udid, { screen: 'on', from: 'wake-check' });
              e.locked = false;
              e.screenOn = true;
              return;
            }
          }
          this.power.waking(udid);
          // `explicit`: src/real.ts reads it (the Backend type of src/types.ts says `force` only)
          const opts = { force: false, explicit: !observed && !check };
          await this.backend.unlock(udid, opts);
          this.backend.silence?.(udid, 'woken');
          const still = this.backend.isLocked ? await this.backend.isLocked(udid).catch(() => null) : false;
          e.asked = false;
          if (still === true) this.power.observe(udid, { screen: 'locked', from: 'wake' });
          else if (still === false) this.power.observe(udid, { screen: 'on', from: 'wake' });
          else this.power.forget(udid); // it couldn't be told: Unknown, never acted on
          e.screenOn = still === null ? null : !still;
          e.locked = still;
          e.error = still ? 'still locked after wake (a passcode is set: enter it on the phone once, or remove it)' : null;
          if (!still) this.log(`${udid.slice(-8)} woke`);
        },
      }),
    );
  }

  /**
   * 2026-11-18, 2026-11-27: the capture gave no picture. The phone is looked at and woken only if that shows it locked
   * or dark (a screen that can't be looked at is never pressed: docs/root-cause.md section 6). Resolves null when it's
   * awake (or nothing could be told), else why not, in a line for the viewer.
   */
  async wakeForPicture(udid: string, _force = true): Promise<string | null> {
    if (!this.supported) return 'this server cannot wake phones';
    // 2026-11-22 (iPhone-2 stuck on "connecting" after a replug): a phone just plugged in is locked, and its USB
    // screen capture shows nothing until it's unlocked once; the unlock needs its control link, which takes a minute
    // or two to start after a replug. It waits for the link (outside the phone's queue) and then looks.
    if (this.backend.whenControlReady) await this.backend.whenControlReady(udid, PICTURE_WAKE_WAIT_MS).catch(() => false);
    try {
      await this.wakeNow(udid, true, true);
      const st = this.state(udid);
      if (st.locked) return st.error ?? 'the phone stayed locked (a passcode is set: enter it on the phone once, or remove it)';
      return null;
    } catch (err) {
      return (err as Error)?.message?.slice(0, 200) || 'the wake failed';
    }
  }

  /** Lock (screen off) now: a power job (inside the owner's lock key it's that key's own turn). */
  lock(udid: string): Promise<PowerState> {
    const e = this.entry(udid);
    return this.serial(e, 'lock', () =>
      this.actors.of(udid).submit({
        kind: 'power', label: 'lock', who: { server: 'power' }, startWithinMs: POWER_START_MS,
        run: async () => {
          if (!this.backend.lock) throw new Error('this backend cannot lock phones');
          await this.backend.lock(udid);
          this.power.observe(udid, { screen: 'locked', from: 'lock' });
          e.locked = true;
          e.screenOn = false;
          e.asked = true;
          e.error = null;
        },
      }),
    ).then(() => this.state(udid));
  }

  private serial(e: Entry, kind: 'wake' | 'lock', fn: () => Promise<void>): Promise<void> {
    const start = () => {
      e.busyKind = kind;
      return fn();
    };
    // nothing in progress: started now (synchronously), so its job takes its place in the queue before the caller's next
    const p = e.busy ? e.busy.catch(() => {}).then(start) : start();
    const mine = p.then(
      () => undefined,
      (err: Error) => {
        e.error = err?.message?.slice(0, 200) ?? 'failed';
      },
    );
    e.busy = mine;
    void mine.then(() => {
      if (e.busy === mine) {
        e.busy = undefined;
        e.busyKind = undefined;
      }
    });
    return p;
  }

  /** Whether a phone should be locked now (idle long enough, nobody watching, not already locked). Pure. */
  static due(e: Pick<PowerState, 'locked' | 'viewers' | 'lastActive'>, minutes: number, now: number): boolean {
    if (!(minutes > 0) || e.viewers > 0 || e.locked === true || e.lastActive === null) return false;
    return now - e.lastActive >= minutes * 60_000;
  }

  /**
   * The periodic check: learn the phones, lock the idle ones. Returns the phones it locked. Each lock takes the
   * phone's system lease ("idle-lock"): a phone someone drives, or with anything on its way, is left for the next tick.
   */
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
        const release = this.actors.of(udid).trySystem('idle-lock');
        if (!release) continue; // not Free: tried again next tick
        try {
          await this.lock(udid);
          locked.push(udid);
          this.log(`${udid.slice(-8)} locked after ${minutes} min idle`);
        } catch (err) {
          this.log(`${udid.slice(-8)} could not be locked: ${(err as Error).message}`);
          e.lastActive = now; // try again after another idle period, not every tick
        } finally {
          release();
        }
      }
    } finally {
      this.ticking = false;
    }
    return locked;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.unwatch?.();
  }
}
