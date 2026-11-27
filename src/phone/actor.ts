import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from '../types.js';

/**
 * The per-phone actor (docs/root-cause.md 13.2, 13.3c; 2026-11-27). Every piece of work the server sends to a phone
 * goes through its phone's one actor as a typed job:
 *
 * - `input`: touches, keys, typing, launches, the owner's explicit wake and lock. In arrival order, one at a time.
 *   Input never waits behind a look, a power action or system work (13.1 P1): those are already on the phone, and
 *   WDA's own lane puts input first there.
 * - `power`, `look`, `system`: one at a time between them (power first, then looks, then system), and none of them
 *   starts while an input is queued or running, or (while the owner is touching the phone) within `reserveMs` of the
 *   owner's last input: the input reservation (13.1 P1, root-cause section 8).
 *
 * Every job may carry a deadline: one that can't start by its `startBy` is refused at once with a 503 that says the
 * phone is busy (never queued behind work it can't outlast), and one that runs past its `deadlineAt` is answered with
 * a 504 while its abort signal fires (whatever is already on the phone may still happen: the answer says so).
 *
 * The lease (13.3c) says who drives the phone: Free, Owner (the owner's input in the last `ownerQuietMs`), Hand(id)
 * (an agent's work) or System(op) (re-sign, fork install, self-test, the idle lock). The owner pre-empts a hand: a
 * hand's input waits until the owner has been quiet `ownerQuietMs` (at most `ownerWaitMs`, then 409). System work
 * waits for Free and never pre-empts anyone.
 *
 * A job that runs inside another job of the same phone (the wake inside the owner's wake key, a look inside a lock)
 * is part of that job's turn: it runs at once, never queued behind the job that waits for it.
 */

export type JobKind = 'input' | 'power' | 'look' | 'system';
export type Who = { owner: true } | { hand: string } | { system: string } | { server: string };

export type Lease =
  | { kind: 'free' }
  | { kind: 'owner'; since: number }
  | { kind: 'hand'; id: string; since: number }
  | { kind: 'system'; op: string; since: number };

/** What a job gets while it runs. */
export interface JobContext {
  /** Fires at the job's deadline (or when it's cancelled): stop what can still be stopped. */
  signal: AbortSignal;
  /** performance.now() by which it must be done (Infinity: none). */
  deadlineAt: number;
}

export interface Job<T> {
  kind: JobKind;
  /** For the log and the errors ("tap", "look", "lock"). */
  label: string;
  run: (ctx: JobContext) => Promise<T>;
  who?: Who;
  /** How long it may run once started (ms; Infinity or none: no limit). */
  timeoutMs?: number;
  /** It must start within this long (ms from now) or it's refused, busy (none: no limit). */
  startWithinMs?: number;
  /** An absolute deadline (Date.now() ms, the client's `deadlineAt`): it must be done by then. */
  deadlineEpoch?: number;
  /** Never refused by a full queue (a touch's down and up, a lift). */
  must?: boolean;
  /** Background work that isn't worth waiting for: skipped (resolves `undefined`) when the phone has anything else on. */
  skipIfBusy?: boolean;
  /** Input: start at least this long after the last input ended (a breath between discrete actions). */
  gapMs?: number;
  /** After it's done, keep its slot this long more (a gesture answered when queued still plays on the phone). */
  holdAfter?: (r: T) => number;
  /** The 504 for a run past its deadline (default: "<label> got no answer within N s"). */
  onTimeout?: (ms: number) => Error;
  /**
   * A hand's input waits for the owner to be quiet (default true for `who.hand` input). A look with it (a read of the
   * app in front: it holds WDA's main queue as long as the app takes) doesn't start while the owner drives the phone.
   */
  yieldToOwner?: boolean;
}

export interface ActorOptions {
  /** The owner counts as touching the phone for this long after his last input (ms; default OWNER_QUIET_MS). */
  ownerQuietMs?: number;
  /** A hand's input waits for the owner at most this long, then 409 (ms; default OWNER_WAIT_MS). */
  ownerWaitMs?: number;
  /** While the owner touches the phone, a look starts only this long after his last input (ms; default RESERVE_MS). */
  reserveMs?: number;
  /** A hand's lease ends this long after its last work (ms; default HAND_IDLE_MS). */
  handIdleMs?: number;
  /** Input queued per phone before more is refused (must-jobs excepted). */
  maxWaiting?: number;
  /** After a job ran past its deadline, the next one of its line waits at most this long for it (ms). */
  hungGraceMs?: number;
  log?: (m: string) => void;
}

export const OWNER_QUIET_MS = 5000;
export const OWNER_WAIT_MS = 45_000;
export const RESERVE_MS = 250;
/** After the owner opens a live view with input, a read of the app in front waits this long: his first touch comes (ms). */
export const OPEN_RESERVE_MS = 1000;
export const HAND_IDLE_MS = 10_000;
export const MAX_WAITING = 50;
export const HUNG_GRACE_MS = 5000;

/** Refused: the phone can't take this now (its deadline can't be met, or the queue is full). `state: "busy"`. */
export class ActorBusy extends HttpError {
  constructor(message: string) {
    super(503, message, { state: 'busy' });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BG_ORDER: Record<Exclude<JobKind, 'input'>, number> = { power: 0, look: 1, system: 2 };

interface Entry {
  job: Job<any>;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  queuedAt: number;
  startBy: number; // performance.now(); Infinity: none
  deadlineAt: number; // performance.now(); Infinity: none
  timer?: NodeJS.Timeout;
  started: boolean;
  done: boolean;
  seq: number;
}

/** The job a piece of code runs inside of (its phone's actor and the entry), across awaits. */
const inside = new AsyncLocalStorage<{ actor: PhoneActor; entry: Entry }>();

let seqN = 0;

export class PhoneActor {
  private inputs: Entry[] = [];
  private bg: Entry[] = [];
  private inputRunning: Entry | null = null;
  private bgRunning: Entry | null = null;
  /** A job that ran past its deadline and may still be on its way at the phone, per line. */
  private hungInput: Promise<unknown> | null = null;
  private hungBg: Promise<unknown> | null = null;
  /** The slot is held after the last input (a gesture still playing) until this performance.now(). */
  private inputHoldUntil = 0;
  private ownerAt = -Infinity; // Date.now()
  /** Until when (Date.now()) a read of the app in front waits for the owner who just opened his live view. */
  private openReserveUntil = 0;
  private ownerSince = 0;
  private handAt = -Infinity; // Date.now()
  private handId: string | null = null;
  private handSince = 0;
  private handHolds = new Map<string, number>();
  private system: { op: string; since: number } | null = null;
  private systemWaiters: { op: string; resolve: (release: () => void) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }[] = [];
  private kickTimer?: NodeJS.Timeout;
  /** performance.now() when the last input started or ended (-Infinity: never). */
  lastInputAt = -Infinity;
  private lastInputEnd = -Infinity;
  private quietMs: number;
  private waitMs: number;
  private reserveMs: number;
  private handIdleMs: number;
  private maxWaiting: number;
  private hungGraceMs: number;
  private log: (m: string) => void;

  constructor(readonly udid: string, opts: ActorOptions = {}) {
    this.quietMs = opts.ownerQuietMs ?? OWNER_QUIET_MS;
    this.waitMs = opts.ownerWaitMs ?? OWNER_WAIT_MS;
    this.reserveMs = opts.reserveMs ?? RESERVE_MS;
    this.handIdleMs = opts.handIdleMs ?? HAND_IDLE_MS;
    this.maxWaiting = opts.maxWaiting ?? MAX_WAITING;
    this.hungGraceMs = opts.hungGraceMs ?? HUNG_GRACE_MS;
    this.log = opts.log ?? ((m) => console.log(`[actor ${udid.slice(-8)}] ${m}`));
  }

  /** Change the owner's quiet time and wait (tests make them short); undefined keeps what's set. */
  tune(o: { ownerQuietMs?: number; ownerWaitMs?: number; reserveMs?: number; handIdleMs?: number }): void {
    if (o.ownerQuietMs !== undefined) this.quietMs = o.ownerQuietMs;
    if (o.ownerWaitMs !== undefined) this.waitMs = o.ownerWaitMs;
    if (o.reserveMs !== undefined) this.reserveMs = o.reserveMs;
    if (o.handIdleMs !== undefined) this.handIdleMs = o.handIdleMs;
  }

  // ---- the lease ----

  /** The owner gave this phone input now: his lease (a hand pauses until he's quiet). */
  ownerInput(): void {
    const now = Date.now();
    if (!this.ownerActive()) this.ownerSince = now;
    this.ownerAt = now;
  }

  /**
   * The owner opened a live view with input (a control socket): his first touch is on its way, so a read of the app in
   * front (a look with `yieldToOwner`) waits `ms` first. It isn't his lease: nobody else's input waits for it.
   */
  ownerOpened(ms = OPEN_RESERVE_MS): void {
    this.openReserveUntil = Math.max(this.openReserveUntil, Date.now() + ms);
    this.kickSoon();
  }

  /** How long ago the owner last gave this phone input (ms); Infinity when never. */
  ownerQuiet(): number {
    return Number.isFinite(this.ownerAt) ? Date.now() - this.ownerAt : Infinity;
  }

  ownerActive(): boolean {
    return this.ownerQuiet() < this.quietMs;
  }

  get ownerQuietMs(): number {
    return this.quietMs;
  }

  /** A hand works on the phone now (its lease, until `handIdleMs` after its last work). */
  handWork(id: string): void {
    const now = Date.now();
    if (this.handId !== id || now - this.handAt >= this.handIdleMs) this.handSince = now;
    this.handId = id;
    this.handAt = now;
  }

  /** A hand holds the phone (a batch, a reported action) until the returned release. */
  holdHand(id: string): () => void {
    this.handWork(id);
    this.handHolds.set(id, (this.handHolds.get(id) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.handHolds.get(id) ?? 1) - 1;
      if (n > 0) this.handHolds.set(id, n);
      else this.handHolds.delete(id);
      this.handWork(id);
      this.kickSoon();
    };
  }

  private handActive(): boolean {
    if (this.handHolds.size) return true;
    return this.handId !== null && Date.now() - this.handAt < this.handIdleMs;
  }

  lease(): Lease {
    if (this.system) return { kind: 'system', op: this.system.op, since: this.system.since };
    if (this.ownerActive()) return { kind: 'owner', since: this.ownerSince };
    if (this.handActive()) {
      const id = this.handHolds.size ? [...this.handHolds.keys()][0]! : this.handId!;
      return { kind: 'hand', id, since: this.handSince };
    }
    return { kind: 'free' };
  }

  /** Nothing on the phone and nobody holding it: what system work waits for. */
  free(): boolean {
    return this.lease().kind === 'free' && !this.busy();
  }

  /** Input or background work queued or running. */
  busy(): boolean {
    return this.pending() > 0;
  }

  /**
   * Take the system lease for `op` (re-sign, fork install, self-test, the idle lock): waits until the phone is Free,
   * at most `waitMs` (then refused, busy). Never pre-empts anyone. Resolves the release.
   */
  acquireSystem(op: string, waitMs = Infinity): Promise<() => void> {
    const got = this.trySystem(op);
    if (got) return Promise.resolve(got);
    return new Promise((resolve, reject) => {
      const w: (typeof this.systemWaiters)[number] = { op, resolve, reject };
      if (Number.isFinite(waitMs)) {
        w.timer = setTimeout(() => {
          this.systemWaiters = this.systemWaiters.filter((x) => x !== w);
          reject(new ActorBusy(`the phone was not free for ${op} within ${Math.round(waitMs / 1000)} s (${this.describe()})`));
        }, waitMs);
        w.timer.unref?.();
      }
      this.systemWaiters.push(w);
      this.kickSoon();
    });
  }

  /** The system lease now, or null when the phone isn't Free. */
  trySystem(op: string): (() => void) | null {
    if (this.system || !this.free()) return null;
    const mine = { op, since: Date.now() };
    this.system = mine;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.system === mine) this.system = null;
      this.kick();
    };
  }

  /**
   * Wait while the owner is touching this phone: until `ownerQuietMs` without his input, at most `maxMs`. Null when he
   * wasn't (nothing waited); else how long it waited and whether he stopped.
   */
  async waitOwnerQuiet(maxMs: number, onPause?: (since: number) => void, onResume?: () => void): Promise<{ ms: number; resumed: boolean } | null> {
    if (!this.ownerActive()) return null;
    const t0 = Date.now();
    onPause?.(t0);
    try {
      while (this.ownerActive()) {
        if (Date.now() - t0 >= maxMs) return { ms: Date.now() - t0, resumed: false };
        await sleep(Math.max(5, Math.min(200, this.quietMs - this.ownerQuiet() + 5)));
      }
      return { ms: Date.now() - t0, resumed: true };
    } finally {
      onResume?.();
    }
  }

  // ---- jobs ----

  /** The job this code runs inside of on this phone, if any (re-entrant work joins its turn). */
  private current(): Entry | null {
    const c = inside.getStore();
    return c && c.actor === this && !c.entry.done ? c.entry : null;
  }

  /** Whether the caller runs inside one of this phone's jobs. */
  inJob(): boolean {
    return this.current() !== null;
  }

  submit<T>(job: Job<T>): Promise<T> {
    // inside a job of this phone: part of that job's turn (never queued behind the job that waits for it)
    const outer = this.current();
    if (outer) return this.runNested(outer, job);
    const now = performance.now();
    if (job.skipIfBusy && (this.busy() || this.system || this.ownerActive())) return Promise.resolve(undefined as T);
    if (job.kind === 'input' && !job.must && this.inputPending() >= this.maxWaiting) {
      return Promise.reject(new ActorBusy('too many actions waiting for this phone'));
    }
    const epochLeft = job.deadlineEpoch !== undefined && Number.isFinite(job.deadlineEpoch) ? job.deadlineEpoch - Date.now() : Infinity;
    if (epochLeft <= 0) return Promise.reject(new ActorBusy(`${job.label}: its deadline had passed when it reached the phone's queue`));
    const startWithin = Math.min(job.startWithinMs ?? Infinity, epochLeft);
    return new Promise<T>((resolve, reject) => {
      const e: Entry = {
        job, resolve, reject, queuedAt: now, started: false, done: false, seq: ++seqN,
        startBy: now + startWithin,
        deadlineAt: Number.isFinite(epochLeft) ? now + epochLeft : Infinity,
      };
      if (Number.isFinite(startWithin)) {
        e.timer = setTimeout(() => this.expire(e), Math.max(0, startWithin));
        e.timer.unref?.();
      }
      if (job.kind === 'input') this.inputs.push(e);
      else {
        this.bg.push(e);
        this.bg.sort((a, b) => BG_ORDER[a.job.kind as 'power'] - BG_ORDER[b.job.kind as 'power'] || a.seq - b.seq);
      }
      this.kick();
    });
  }

  /** A job that couldn't start by its `startBy`: refused, busy, at once. */
  private expire(e: Entry): void {
    if (e.started || e.done) return;
    e.done = true;
    this.inputs = this.inputs.filter((x) => x !== e);
    this.bg = this.bg.filter((x) => x !== e);
    const waited = Math.round(performance.now() - e.queuedAt);
    e.reject(new ActorBusy(`${e.job.label} could not start in time (waited ${waited} ms: ${this.describe()})`));
    this.kick();
  }

  /** What holds the phone now, in a few words (for "busy" answers). */
  describe(): string {
    const parts: string[] = [];
    if (this.inputRunning) parts.push(`${this.inputRunning.job.label} running`);
    if (this.inputs.length) parts.push(`${this.inputs.length} input${this.inputs.length > 1 ? 's' : ''} waiting`);
    if (this.bgRunning) parts.push(`${this.bgRunning.job.label} on the phone`);
    const l = this.lease();
    if (l.kind !== 'free') parts.push(l.kind === 'hand' ? `an agent (${l.id}) drives it` : l.kind === 'system' ? `system work (${l.op})` : 'the owner is using it');
    return parts.join(', ') || 'nothing';
  }

  /** Queued or running jobs (of one kind, or all). */
  pending(kind?: JobKind): number {
    const all = [...this.inputs, ...this.bg, ...(this.inputRunning ? [this.inputRunning] : []), ...(this.bgRunning ? [this.bgRunning] : [])];
    return kind ? all.filter((e) => e.job.kind === kind).length : all.length;
  }

  /** Inputs queued or running (the input reservation holds looks back while it's > 0). */
  inputPending(): number {
    return this.inputs.length + (this.inputRunning ? 1 : 0);
  }

  /** A snapshot for the stats. */
  snapshot(): { lease: Lease; inputs: number; background: number; running: string[] } {
    return {
      lease: this.lease(),
      inputs: this.inputPending(),
      background: this.bg.length + (this.bgRunning ? 1 : 0),
      running: [this.inputRunning, this.bgRunning].filter((e): e is Entry => !!e).map((e) => `${e.job.kind}:${e.job.label}`),
    };
  }

  private kickSoon(): void {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      this.kick();
    }, 0);
  }

  /** Start whatever may start now; re-check later when something waits on time (a timer that keeps the process up: work is queued). */
  private kick(): void {
    let later = Infinity;
    // system waiters: Free and nothing on the phone
    if (this.systemWaiters.length && !this.system && this.free()) {
      const w = this.systemWaiters.shift()!;
      if (w.timer) clearTimeout(w.timer);
      const release = this.trySystem(w.op);
      if (release) w.resolve(release);
    } else if (this.systemWaiters.length) {
      // the owner's or a hand's lease ends by time passing: look again then
      const ownerLeft = this.quietMs - this.ownerQuiet();
      const handLeft = this.handHolds.size ? Infinity : this.handIdleMs - (Date.now() - this.handAt);
      const left = Math.max(ownerLeft, handLeft);
      later = Math.min(later, Number.isFinite(left) && left > 0 ? left + 5 : 250);
    }
    // input: one at a time, in order
    if (!this.inputRunning && this.inputs.length && !this.hungInput) {
      const wait = this.inputHoldUntil - performance.now();
      if (wait > 0) later = Math.min(later, wait);
      else this.start(this.inputs.shift()!, 'input');
    }
    // background: one at a time; never while input waits or runs (the reservation)
    if (!this.bgRunning && this.bg.length && !this.hungBg && !this.inputPending() && performance.now() >= this.inputHoldUntil) {
      const next = this.bg[0]!;
      const sinceInput = performance.now() - this.lastInputEnd;
      const owner = this.ownerActive();
      const opened = this.openReserveUntil - Date.now();
      const reserve = next.job.kind !== 'look'
        ? 0
        : next.job.yieldToOwner
          ? Math.max(owner ? this.quietMs - this.ownerQuiet() : 0, opened)
          : owner ? this.reserveMs - sinceInput : 0;
      // system work waits while the owner or a hand drives the phone (the system lease's holder's own work goes)
      const sys = next.job.kind === 'system' && (this.ownerActive() || this.handActive());
      if (reserve > 0) later = Math.min(later, reserve);
      else if (sys) later = Math.min(later, 250);
      else this.start(this.bg.shift()!, 'bg');
    }
    if (Number.isFinite(later)) {
      if (this.kickTimer) clearTimeout(this.kickTimer);
      this.kickTimer = setTimeout(() => {
        this.kickTimer = undefined;
        this.kick();
      }, Math.max(1, Math.ceil(later)));
    }
  }

  private start(e: Entry, line: 'input' | 'bg'): void {
    if (e.done) return this.kick();
    e.started = true;
    if (e.timer) clearTimeout(e.timer);
    if (line === 'input') this.inputRunning = e;
    else this.bgRunning = e;
    void this.execute(e, line).finally(() => {
      if (line === 'input') this.inputRunning = null;
      else this.bgRunning = null;
      this.kick();
    });
  }

  private async execute(e: Entry, line: 'input' | 'bg'): Promise<void> {
    const job = e.job;
    try {
      if (line === 'input') await this.beforeInput(e);
      if (e.done) return;
      const timeout = job.timeoutMs !== undefined && Number.isFinite(job.timeoutMs) ? performance.now() + job.timeoutMs : Infinity;
      const deadlineAt = Math.min(timeout, e.deadlineAt);
      if (line === 'input') this.lastInputAt = performance.now();
      const ac = new AbortController();
      const work = inside.run({ actor: this, entry: e }, () => job.run({ signal: ac.signal, deadlineAt }));
      let r: unknown;
      if (Number.isFinite(deadlineAt)) {
        const ms = Math.max(0, deadlineAt - performance.now());
        let t: NodeJS.Timeout | undefined;
        try {
          r = await Promise.race([
            work,
            new Promise((_, reject) => {
              t = setTimeout(() => {
                ac.abort();
                const hung = work.then(() => {}, () => {});
                if (line === 'input') {
                  this.hungInput = Promise.race([hung, sleep(this.hungGraceMs)]).then(() => void (this.hungInput = null, this.kick()));
                } else {
                  this.hungBg = Promise.race([hung, sleep(this.hungGraceMs)]).then(() => void (this.hungBg = null, this.kick()));
                }
                reject(job.onTimeout?.(ms) ?? new HttpError(504, `${job.label} on the phone got no answer within ${Math.round(ms / 1000)} s; it may still happen, so look at the screen before trying again`));
              }, ms);
            }),
          ]);
        } finally {
          if (t) clearTimeout(t);
        }
      } else r = await work;
      // a hand's lease runs from its last work
      if (job.who && 'hand' in job.who) this.handWork(job.who.hand);
      if (line === 'input') {
        const hold = job.holdAfter ? Math.max(0, Math.min(60_000, job.holdAfter(r as never) || 0)) : 0;
        this.lastInputEnd = performance.now();
        this.lastInputAt = this.lastInputEnd;
        if (hold > 0) {
          this.inputHoldUntil = performance.now() + hold;
          setTimeout(() => {
            this.lastInputAt = this.lastInputEnd = performance.now();
            this.kick();
          }, hold);
        }
      }
      e.done = true;
      e.resolve(r);
    } catch (err) {
      if (line === 'input') this.lastInputAt = this.lastInputEnd = performance.now();
      e.done = true;
      e.reject(err);
    }
  }

  /** Before an input starts: a hand waits for the owner (the owner pre-empts it), and the breath between inputs. */
  private async beforeInput(e: Entry): Promise<void> {
    const job = e.job;
    const who = job.who;
    if (who && 'owner' in who) this.ownerInput();
    if (who && 'hand' in who) {
      this.handWork(who.hand);
      if (job.yieldToOwner !== false && this.ownerActive()) {
        const max = Math.min(this.waitMs, e.startBy - performance.now());
        const p = await this.waitOwnerQuiet(max);
        if (p && !p.resumed) {
          e.done = true;
          e.reject(new HttpError(409, `the owner is still using the phone (touching it for ${Math.round(p.ms / 1000)} s): try again when he stops`, { state: 'owner' }));
          return;
        }
      }
    }
    if (job.gapMs && job.gapMs > 0) {
      const since = performance.now() - this.lastInputEnd;
      if (since < job.gapMs) await sleep(job.gapMs - since);
    }
  }

  /** A job inside another job of this phone: runs now, within the outer one's deadline. */
  private async runNested<T>(outer: Entry, job: Job<T>): Promise<T> {
    if (job.kind === 'input' && job.who && 'owner' in job.who) this.ownerInput();
    const ac = new AbortController();
    const deadlineAt = Math.min(outer.deadlineAt, job.timeoutMs !== undefined && Number.isFinite(job.timeoutMs) ? performance.now() + job.timeoutMs : Infinity);
    return job.run({ signal: ac.signal, deadlineAt });
  }
}

/** Every phone's actor. */
export class Actors {
  private map = new Map<string, PhoneActor>();
  constructor(private opts: ActorOptions = {}) {}

  of(udid: string): PhoneActor {
    let a = this.map.get(udid);
    if (!a) this.map.set(udid, (a = new PhoneActor(udid, this.opts)));
    return a;
  }

  /** The phones that have an actor so far. */
  udids(): string[] {
    return [...this.map.keys()];
  }

  /** Change every actor's timings (tests). */
  tune(o: Parameters<PhoneActor['tune']>[0]): void {
    Object.assign(this.opts, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
    for (const a of this.map.values()) a.tune(o);
  }
}

/**
 * The actors of one backend (one set of phones): the control queue, the agent, the idle lock and the backend's own
 * reads all find the same actor for a phone through the backend they share, without being wired to each other.
 */
const byBackend = new WeakMap<object, Actors>();
export function actorsFor(backend: object): Actors {
  let a = byBackend.get(backend);
  if (!a) byBackend.set(backend, (a = new Actors()));
  return a;
}

/** Use these actors for this backend (a server that makes its own). */
export function setActorsFor(backend: object, actors: Actors): void {
  byBackend.set(backend, actors);
}

/** Who sent a control message: the owner (`owner: true`, a live touch), a hand (`hand: "<id>"`), else the server. */
export function whoOf(msg: Record<string, unknown>, fallback: Who = { server: 'api' }): Who {
  if (msg.owner === true || msg.type === 'touch') return { owner: true };
  if (typeof msg.hand === 'string' && msg.hand.trim()) return { hand: msg.hand.trim().slice(0, 64) };
  return fallback;
}

/** A client's deadline on a message (`deadlineAt`, Date.now() ms), else undefined. */
export function deadlineOf(msg: Record<string, unknown>): number | undefined {
  const d = msg.deadlineAt ?? msg.deadline_at;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : undefined;
}
