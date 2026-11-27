import { trace } from './trace.js';
import { HttpError } from './types.js';

/**
 * 2026-11-21, the root cause of "the more we fix the more it breaks": every part of the server asked a phone's
 * WebDriverAgent whatever it wanted whenever it wanted, all at once, while the phone does one thing at a time: WDA runs
 * its routes on the main queue, and XCTest's testmanagerd takes a screenshot only once the accessibility read before
 * it is done. One slow still held everything behind it, and the server took the timeouts for a dead WDA.
 *
 * The lane: one per phone, and every request to its WDA goes through it. At most one is on its way from the Mac at a
 * time; a background read (`quiet`) is skipped at once when anything else is going on.
 *
 * 2026-11-27, docs/root-cause.md §2, §8 and §13 (P1, P7), what changed and why:
 * - **One deadline.** Every request carries `deadlineAt` (when its caller stops waiting). The lane refuses at once
 *   what can't start in time, drops unsent what waited past its last useful start, and gives the request on its way
 *   only the time that's left. Nothing is "held" after its caller left: the 60 s hold after a timeout went.
 * - **The journal.** What the Mac stopped waiting for is still on the phone (WDA never cancels a request whose socket
 *   closed). `RequestJournal` says what is on the phone now and since when, so "held" is a state anyone can read,
 *   never a hidden timer. An entry leaves it when the phone answers it, when a later answer on the same queue proves it
 *   done (the main queue is first in, first out: an answer to something sent after it means it's over; the beat is
 *   such a request, src/wda.ts), or when the runner is gone.
 * - **Input first, never behind a read.** 2026-11-22's "touches go beside a read that yields" could not work on a real
 *   phone: /lotus/gesture and /lotus/touch run on the same main queue as the read (FBLotusCommands.inc,
 *   FBWebServer.m), so the touch sent "beside" waited behind it on the phone anyway. Now an input takes the lane's slot
 *   at once: a read on its way from the Mac is cancelled (its caller hears so; the phone may still be working on it,
 *   and the journal says so), never waited for. Reads and looks never start while an input waits.
 * - **Looks last, one at a time.** A still or a tree (`look`) goes after every input and read, never while another
 *   look (or anything we stopped waiting for) is on the phone, never within `lookGuardMs` of an input, and the same
 *   look asked again meanwhile joins the one asked (single flight).
 */
export type LanePrio = 'input' | 'read' | 'look' | 'quiet';

/** Where a request runs on the phone: WDA's main queue, or a standalone route off it (a still: testmanagerd). */
export type PhoneQueue = 'main' | 'side';

/** A request with a deadline may start this long before it at the latest (its least useful time on the phone, ms). */
export const MIN_SEND_MS = 150;
/** A look (a still, a tree) doesn't start this soon after an input was sent (ms): a burst of touches isn't interleaved with looks. */
export const LOOK_GUARD_MS = 250;
/** Two requests sent this close together (ms) may reach the phone in either order: an answer proves only what went before it by more. */
export const PROOF_MARGIN_MS = 50;

/** How one request goes through the lane. */
export interface LaneOpts {
  /** @deprecated 2026-11-27: nothing goes "beside" anything any more (see the header); accepted and ignored. */
  yields?: boolean;
  /** @deprecated 2026-11-27: accepted and ignored. */
  beside?: boolean;
  /** When the caller stops waiting (ms since the epoch). The request is refused or dropped once it can't start in time. */
  deadlineAt?: number;
  /** Its least useful time on the phone (ms): it starts no later than `deadlineAt - minMs` (default MIN_SEND_MS with a deadline). */
  minMs?: number;
  /** An input may stop it on its way from the Mac (default: anything but an input). Never for a request with side effects. */
  cancellable?: boolean;
  /** Which queue it runs on on the phone (default the main one). */
  queue?: PhoneQueue;
  /** A read of the app in front through accessibility (said in the journal). */
  appBound?: boolean;
}

/** A request that was never sent: the phone was busy with an earlier one (or skipped: a background read). 503. */
export class LaneBusy extends HttpError {
  constructor(message: string, extra: Record<string, unknown> = {}) {
    super(503, message, { state: 'busy', ...extra });
  }
}

/** 2026-11-27: a request stopped on its way from the Mac so that an input could go first (the phone may still finish it). */
export class LaneCancelled extends LaneBusy {
  constructor(message: string, extra: Record<string, unknown> = {}) {
    super(message, { cancelled: true, ...extra });
  }
}

/** How a request sent to the phone ended, as the Mac knows it. */
export type LaneOutcome = 'answered' | 'failed' | 'timeout' | 'cancelled';

/** What a started request gives the lane. */
export interface LaneRun<T> {
  /** The caller's answer (it may come before the request ended on the wire). */
  result: Promise<T>;
  /** The request ended on the Mac's side (answered, failed, timed out or cancelled): the lane's slot is free after this. */
  ended: Promise<unknown>;
  /**
   * 2026-11-27: how it ended: `answered` (the phone is done with it), `failed` (it never reached the phone: the
   * connection failed), `timeout`/`cancelled` (the phone may still be working on it: it stays in the journal).
   * Without it, the request counts as answered once `ended`.
   */
  outcome?: Promise<LaneOutcome>;
  /** Stops it on the Mac's side now: `result` rejects with `err`, and it ends at once. */
  cancel?: (err: Error) => void;
  /** 2026-11-27: true once a late answer came after a timeout (the phone is done with it: the journal clears it). */
  late?: Promise<boolean>;
}

// ---- the journal: what is on the phone now, and since when ----

export interface JournalEntry {
  id: number;
  /** "GET /source", "POST /session/:id/wda/tap" (no ids, no query, no body). */
  label: string;
  prio: LanePrio;
  queue: PhoneQueue;
  appBound: boolean;
  /** When it went to the phone, and when its caller stops (stopped) waiting (ms since the epoch). */
  sentAt: number;
  deadlineAt: number;
  /** `on-wire`: the Mac still waits for its answer; `abandoned`: the Mac stopped waiting (timeout, cancelled), the phone may not have. */
  state: 'on-wire' | 'abandoned';
  abandonedAt: number | null;
  why: string | null;
}

type JournalListener = {
  /** Something answered on `queue` that was sent at `sentAt` (the queue moves). */
  answer?: (queue: PhoneQueue, sentAt: number, at: number) => void;
  /** An entry left the journal: `how` is answered, proved (a later answer on its queue), aged (a still past its cap), flushed. */
  cleared?: (e: JournalEntry, how: 'answered' | 'proved' | 'aged' | 'flushed' | 'failed', at: number) => void;
  abandoned?: (e: JournalEntry) => void;
  change?: () => void;
};

/** What is on the phone now (ours), and since when. One per phone (each lane has its own). */
export class RequestJournal {
  private list: JournalEntry[] = [];
  private seq = 0;
  private subs = new Set<JournalListener>();
  constructor(private now: () => number = Date.now) {}

  /** Told of answers, clears, abandons and every change; returns the unsubscribe. */
  on(l: JournalListener): () => void {
    this.subs.add(l);
    return () => void this.subs.delete(l);
  }

  private changed(): void {
    for (const s of [...this.subs]) s.change?.();
  }

  add(x: { label: string; prio: LanePrio; queue: PhoneQueue; appBound: boolean; sentAt: number; deadlineAt: number }): JournalEntry {
    const e: JournalEntry = { id: ++this.seq, ...x, state: 'on-wire', abandonedAt: null, why: null };
    this.list.push(e);
    this.changed();
    return e;
  }

  private remove(id: number, how: 'answered' | 'proved' | 'aged' | 'flushed' | 'failed', at: number): JournalEntry | null {
    const i = this.list.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const [e] = this.list.splice(i, 1);
    for (const s of [...this.subs]) s.cleared?.(e!, how, at);
    return e!;
  }

  /** The phone answered it: gone, and everything on its queue sent before it is over too (first in, first out). */
  done(id: number): void {
    const at = this.now();
    const e = this.remove(id, 'answered', at);
    if (!e) return;
    this.proveQuiet(e.queue, e.sentAt, at);
    for (const s of [...this.subs]) s.answer?.(e.queue, e.sentAt, at);
    this.changed();
  }

  /** It never reached the phone (the connection failed): gone, proving nothing. */
  failed(id: number): void {
    if (this.remove(id, 'failed', this.now())) this.changed();
  }

  /** The Mac stopped waiting for it (`why`: timeout, cancelled); it stays: the phone may still be working on it. */
  abandon(id: number, why: string): void {
    const e = this.list.find((x) => x.id === id);
    if (!e || e.state === 'abandoned') return;
    e.state = 'abandoned';
    e.abandonedAt = this.now();
    e.why = why;
    for (const s of [...this.subs]) s.abandoned?.(e);
    this.changed();
  }

  /**
   * Something on `queue` sent at `sentAt` was answered (a beat, or a request outside the lane): everything ours on that
   * queue sent before it (by more than PROOF_MARGIN_MS) is over.
   */
  prove(queue: PhoneQueue, sentAt: number): void {
    const at = this.now();
    this.proveQuiet(queue, sentAt, at);
    for (const s of [...this.subs]) s.answer?.(queue, sentAt, at);
    this.changed();
  }

  private proveQuiet(queue: PhoneQueue, sentAt: number, at: number): void {
    for (const e of this.list.filter((x) => x.queue === queue && x.sentAt < sentAt - PROOF_MARGIN_MS)) this.remove(e.id, 'proved', at);
  }

  /** Abandoned entries on `queue` older than `ms` are taken as over (a still: XCTest gives up on its own within 20 s). */
  age(queue: PhoneQueue, ms: number): void {
    const at = this.now();
    const old = this.list.filter((x) => x.queue === queue && x.state === 'abandoned' && at - x.sentAt > ms);
    for (const e of old) this.remove(e.id, 'aged', at);
    if (old.length) this.changed();
  }

  /** The runner is gone (restarted, stopped): nothing of ours is on the phone any more. */
  flush(): void {
    const at = this.now();
    const all = [...this.list];
    for (const e of all) this.remove(e.id, 'flushed', at);
    if (all.length) this.changed();
  }

  /** Every entry, oldest first (copies). */
  entries(): JournalEntry[] {
    return this.list.map((e) => ({ ...e }));
  }

  /** Entries on the phone (all of them, or on one queue). */
  count(queue?: PhoneQueue): number {
    return queue ? this.list.filter((e) => e.queue === queue).length : this.list.length;
  }

  /** Entries the Mac stopped waiting for that may still hold the phone (all, or on one queue). */
  held(queue?: PhoneQueue): JournalEntry[] {
    return this.list.filter((e) => e.state === 'abandoned' && (!queue || e.queue === queue)).map((e) => ({ ...e }));
  }

  /** The oldest entry on the phone, or null. */
  oldest(queue?: PhoneQueue): JournalEntry | null {
    const e = this.list.find((x) => !queue || x.queue === queue);
    return e ? { ...e } : null;
  }

  /** Entries still within their deadline at `at` (someone still waits for them). */
  inDeadline(at = this.now()): JournalEntry[] {
    return this.list.filter((e) => e.deadlineAt > at).map((e) => ({ ...e }));
  }
}

// ---- the lane ----

interface Job {
  prio: LanePrio;
  label: string;
  at: number;
  /** The last moment it may start (ms since the epoch; Infinity: no limit), and its deadline. */
  startBy: number;
  deadlineAt: number;
  cancellable: boolean;
  queue: PhoneQueue;
  appBound: boolean;
  key?: string;
  start: (budgetMs?: number) => LaneRun<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: NodeJS.Timeout;
  /** Callers that asked the very same quiet read or look meanwhile: they get its answer. */
  joined: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[];
}

export interface LaneState {
  /** The request on its way now ("GET /lotus/shot"), or null. */
  inFlight: string | null;
  /** Since when (ms since the epoch), and whether its caller already stopped waiting (only a hand-made run can do that now). */
  since: number | null;
  abandoned: boolean;
  /** Requests waiting their turn. */
  waiting: number;
  /** @deprecated 2026-11-27: nothing goes beside anything any more; always null. */
  beside: string | null;
  /** 2026-11-27: requests of ours on the phone now (on their way, or ones the Mac stopped waiting for). */
  onPhone?: number;
  /** The oldest one the Mac stopped waiting for that may still hold the phone, and since when it was sent. */
  held?: string | null;
  heldSince?: number | null;
}

type Slot = { job: Job; label: string; prio: LanePrio; since: number; abandoned: boolean; over: boolean; cancellable: boolean; run?: LaneRun<unknown> };

/** Inputs first, then reads, then looks, then quiet reads; first come, first served within each. */
const RANK: Record<LanePrio, number> = { input: 0, read: 1, look: 2, quiet: 3 };

export class WdaLane {
  /** 2026-11-27: what is on the phone now (src/wda.ts's ControlLink reads it). */
  readonly journal: RequestJournal;
  private queue: Job[] = [];
  private current: Slot | null = null;
  private drains = new Set<() => void>();
  private now: () => number;
  private explain?: (label: string) => string | null;
  private refuse?: (prio: LanePrio, label: string) => HttpError | null;
  private lookGuardMs: number;
  private id: string | undefined;
  private lastInputAt = 0;
  private guardTimer?: NodeJS.Timeout;

  /**
   * `name()`: the phone's name, for the messages. `explain(label)`: why the request on its way is slow, when that's
   * known, said in the "busy" answer. `refuse(prio, label)`: an error to answer at once instead of queueing (the
   * control link is hung or restarting: nothing could finish in time). `id`: the phone, in trace events.
   */
  constructor(
    private name: () => string,
    opts: { now?: () => number; explain?: (label: string) => string | null; refuse?: (prio: LanePrio, label: string) => HttpError | null; lookGuardMs?: number; id?: string } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.explain = opts.explain;
    this.refuse = opts.refuse;
    this.lookGuardMs = opts.lookGuardMs ?? LOOK_GUARD_MS;
    this.id = opts.id;
    this.journal = new RequestJournal(this.now);
    // the phone came free of something we'd stopped waiting for: what waited for that may go now
    this.journal.on({ change: () => this.pump() });
  }

  /** Nothing on its way from the Mac and nothing waiting (the journal may still hold requests the Mac stopped waiting for). */
  get idle(): boolean {
    return !this.current && !this.queue.length;
  }

  /** Requests on their way or waiting (stats). */
  get load(): number {
    return (this.current ? 1 : 0) + this.queue.length;
  }

  state(): LaneState {
    const held = this.journal.held()[0] ?? null;
    return {
      inFlight: this.current?.label ?? null,
      since: this.current?.since ?? null,
      abandoned: this.current?.abandoned ?? false,
      waiting: this.queue.length,
      beside: null,
      onPhone: this.journal.count(),
      held: held?.label ?? null,
      heldSince: held?.sentAt ?? null,
    };
  }

  /**
   * Runs `start` when it's this request's turn, and answers what it answers. `maxWaitMs`: how long it may wait for its
   * turn before it's dropped unsent (a LaneBusy); with `opts.deadlineAt`, never later than `deadlineAt - minMs`
   * either, and refused at once when that's already past. A quiet read is skipped at once (a LaneBusy) while anything
   * else is on its way, waiting, or held on the phone; the same quiet read or look (`key`) asked again meanwhile joins
   * it. `start(budgetMs)` gets the time left to the deadline (undefined without one).
   */
  run<T>(prio: LanePrio, label: string, maxWaitMs: number, start: (budgetMs?: number) => LaneRun<T>, key?: string, opts: LaneOpts = {}): Promise<T> {
    const now = this.now();
    const deadlineAt = opts.deadlineAt ?? Infinity;
    const minMs = opts.minMs ?? (opts.deadlineAt !== undefined ? MIN_SEND_MS : 0);
    const startBy = Math.min(now + Math.max(0, maxWaitMs), deadlineAt - minMs);
    const refused = this.refuse?.(prio, label);
    if (refused) {
      this.tr('wda.refused', { label, prio, why: refused.message });
      return Promise.reject(refused);
    }
    if (startBy < now) {
      const err = new LaneBusy(`${this.name()}: ${label} was not sent: its deadline leaves no time for the phone to do it`, { reason: 'deadline' });
      this.tr('wda.refused', { label, prio, why: 'deadline' });
      return Promise.reject(err);
    }
    if (prio === 'quiet') {
      const busy = (this.current && this.current.prio !== 'quiet') || this.queue.some((j) => j.prio !== 'quiet') || this.journal.held().length > 0;
      if (busy) {
        this.tr('wda.skipped', { label });
        return Promise.reject(this.busyError(label, true));
      }
    }
    if (key && (prio === 'quiet' || prio === 'look')) {
      // single flight: the very same read or look already waiting (or on its way, still awaited) is joined
      const same = this.queue.find((j) => j.key === key) ?? (this.current && !this.current.abandoned && this.current.job.key === key ? this.current.job : undefined);
      if (same) {
        this.tr('wda.joined', { label });
        return new Promise<T>((resolve, reject) => same.joined.push({ resolve: resolve as (v: unknown) => void, reject }));
      }
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        prio, label, at: now, startBy, deadlineAt, key, start: start as (b?: number) => LaneRun<unknown>,
        cancellable: opts.cancellable ?? prio !== 'input', queue: opts.queue ?? 'main', appBound: !!opts.appBound,
        resolve: resolve as (v: unknown) => void, reject, joined: [],
      };
      if (Number.isFinite(startBy)) {
        job.timer = setTimeout(() => {
          const i = this.queue.indexOf(job);
          if (i < 0) return;
          this.queue.splice(i, 1);
          const err = this.busyError(label, false);
          this.tr('wda.dropped', { label, prio, waitedMs: this.now() - job.at });
          job.reject(err);
          for (const j of job.joined) j.reject(err);
        }, Math.max(0, startBy - now));
      }
      this.queue.push(job);
      this.tr('wda.queued', { label, prio, deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null });
      this.pump();
    });
  }

  /** Every request still waiting is answered with `err` now (a restart began: nothing queued goes to the new runner). */
  flush(err: Error): void {
    const jobs = this.queue.splice(0);
    for (const job of jobs) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(err);
      for (const j of job.joined) j.reject(err);
    }
  }

  /** Resolves true once nothing is on its way from the Mac (at once when idle), false after `ms`. */
  drained(ms: number): Promise<boolean> {
    if (!this.current) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.drains.delete(done);
        resolve(true);
      };
      const t = setTimeout(() => {
        this.drains.delete(done);
        resolve(!this.current);
      }, Math.max(0, ms));
      this.drains.add(done);
    });
  }

  private tr(kind: string, data: Record<string, unknown>): void {
    try {
      trace(kind, { udid: this.id, ...data });
    } catch {
      /* the trace never breaks a request */
    }
  }

  private busyError(label: string, skipped: boolean): LaneBusy {
    const c = this.current;
    const held = this.journal.held()[0] ?? null;
    const secs = (t: number) => ((this.now() - t) / 1000).toFixed(1);
    const on = c
      ? `${c.label}, ${secs(c.since)} s so far${c.abandoned ? ', still waiting for the phone to answer it' : ''}`
      : held
        ? `${held.label}, ${secs(held.sentAt)} s so far; the server stopped waiting for it but the phone has not said it's done`
        : 'requests ahead of it';
    const ahead = this.queue.length;
    const why = c ? this.explain?.(c.label) ?? null : held ? this.explain?.(held.label) ?? null : null;
    return new LaneBusy(
      skipped
        ? `${this.name()} is busy (${on}): ${label} skipped`
        : `${this.name()} is busy: its WebDriverAgent is still working on an earlier request (${on}${ahead > 1 ? `; ${ahead - 1} more waiting` : ''}${why ? `; ${why}` : ''}), so ${label} was not sent; try again in a moment`,
      { inFlight: c?.label ?? held?.label ?? null, skipped },
    );
  }

  /** Why this job can't start now even with the slot free (null: it may). */
  private blocked(j: Job): 'held' | 'guard' | null {
    if (j.prio === 'input') return null; // the reserved slot: an input never waits for anything but the input before it
    if (j.prio === 'read') return this.journal.held('main').length ? 'held' : null;
    if (this.journal.held().length) return 'held';
    if (j.prio === 'look' && this.now() - this.lastInputAt < this.lookGuardMs) return 'guard';
    return null;
  }

  /** The next job by rank (first come within one) that may start now. */
  private next(): Job | undefined {
    let best: Job | undefined;
    let guard = false;
    const inputWaits = this.queue.some((j) => j.prio === 'input');
    for (const j of this.queue) {
      if (inputWaits && j.prio !== 'input') continue; // nothing starts while an input waits
      const b = this.blocked(j);
      if (b === 'guard') guard = true;
      if (b) continue;
      if (!best || RANK[j.prio] < RANK[best.prio]) best = j;
    }
    if (!best && guard && !this.guardTimer) {
      this.guardTimer = setTimeout(() => {
        this.guardTimer = undefined;
        this.pump();
      }, Math.max(1, this.lastInputAt + this.lookGuardMs - this.now()));
      this.guardTimer.unref?.();
    }
    return best;
  }

  private pump(): void {
    for (;;) {
      if (this.current) {
        // an input waits and what's on its way may be stopped: it is, at once (never waited for)
        if (this.current.cancellable && this.current.run?.cancel && this.queue.some((j) => j.prio === 'input')) {
          this.cancelCurrent();
          continue;
        }
        break;
      }
      const job = this.next();
      if (!job) break;
      this.begin(job);
    }
    if (!this.current) for (const d of [...this.drains]) d();
  }

  private cancelCurrent(): void {
    const cur = this.current!;
    const input = this.queue.find((j) => j.prio === 'input');
    cur.over = true;
    this.current = null;
    this.tr('wda.cancelled', { label: cur.label, prio: cur.prio, forLabel: input?.label ?? null, ms: this.now() - cur.since });
    cur.run!.cancel!(
      new LaneCancelled(
        `${this.name()}: ${cur.label} was stopped on its way (not waited for) so that ${input?.label ?? 'an input'} could go first; the phone may still finish it; ask again`,
        { inFlight: cur.label },
      ),
    );
  }

  private begin(job: Job): void {
    this.queue.splice(this.queue.indexOf(job), 1);
    if (job.timer) clearTimeout(job.timer);
    const t = this.now();
    const cur: Slot = { job, label: job.label, prio: job.prio, since: t, abandoned: false, over: false, cancellable: job.cancellable };
    this.current = cur;
    if (job.prio === 'input') this.lastInputAt = t;
    const release = () => {
      if (this.current === cur) this.current = null;
    };
    const fail = (err: unknown) => {
      job.reject(err);
      for (const j of job.joined) j.reject(err);
    };
    let run: LaneRun<unknown>;
    try {
      run = job.start(Number.isFinite(job.deadlineAt) ? Math.max(1, job.deadlineAt - t) : undefined);
    } catch (err) {
      cur.over = true;
      release();
      fail(err);
      return;
    }
    cur.run = run;
    const entry = this.journal.add({ label: job.label, prio: job.prio, queue: job.queue, appBound: job.appBound, sentAt: t, deadlineAt: job.deadlineAt });
    this.tr('wda.sent', { label: job.label, prio: job.prio, waitedMs: t - job.at, queue: job.queue });
    let settled: 'ok' | 'err' | null = null;
    run.result.then(
      (v) => {
        settled = 'ok';
        if (!cur.over) cur.abandoned = true; // (a hand-made run: its caller has the answer; the request is still on the wire)
        job.resolve(v);
        for (const j of job.joined) j.resolve(v);
      },
      (err) => {
        settled = 'err';
        if (!cur.over) cur.abandoned = true;
        fail(err);
      },
    );
    if (run.outcome) {
      run.outcome.then(
        (o) => {
          this.tr(o === 'answered' ? 'wda.answered' : o === 'failed' ? 'wda.failed' : 'wda.abandoned', { label: job.label, prio: job.prio, ms: this.now() - t, outcome: o });
          if (o === 'answered') this.journal.done(entry.id);
          else if (o === 'failed') this.journal.failed(entry.id);
          else this.journal.abandon(entry.id, o === 'timeout' ? `no answer within ${((this.now() - t) / 1000).toFixed(1)} s` : 'cancelled for an input');
        },
        () => this.journal.failed(entry.id),
      );
      // a late answer: done on the phone (and so is everything on its queue sent before it)
      run.late?.then((v) => v && this.journal.done(entry.id), () => {});
    }
    const free = () => {
      // a run without an outcome: what ended is over on the phone too (a hand-made run in a test)
      if (!run.outcome) {
        this.tr('wda.answered', { label: job.label, prio: job.prio, ms: this.now() - t, outcome: settled ?? 'ended' });
        this.journal.done(entry.id);
      }
      if (cur.over) return;
      cur.over = true;
      release();
      this.pump();
    };
    run.ended.then(free, free);
  }
}

/** 2026-11-27: a still or the tree: a look (lowest, one at a time). */
const LOOK_RE = /^(\/session\/[^/]+)?\/(screenshot|source|lotus\/shot)$/;
/** Routes WDA answers off its main queue (FBLotusCommands.inc's standalone list, WDA's own /status and /screenshot). */
const SIDE_RE = /^(\/session\/[^/]+)?\/(status|screenshot|lotus\/shot|lotus\/info)$/;

/**
 * Whose turn first: a touch, a key, typing, a launch, a lock or a lift is input; a still or the tree is a look; every
 * other read (and the session's own housekeeping) is a read.
 */
export function routePriority(method: string, p: string): LanePrio {
  const route = p.split('?')[0]!;
  if (method === 'GET') return LOOK_RE.test(route) ? 'look' : 'read';
  if (method === 'DELETE') return /\/actions$/.test(route) ? 'input' : 'read';
  if (route === '/session' || /\/appium\/settings$/.test(route)) return 'read';
  return 'input';
}

/** 2026-11-27: which queue a route runs on on the phone: off the main queue (a still, /status) or on it (everything else). */
export function routeQueue(method: string, p: string): PhoneQueue {
  return method === 'GET' && SIDE_RE.test(p.split('?')[0]!) ? 'side' : 'main';
}

/** A request as the messages say it: the session's id and the query left out ("GET /session/:id/orientation"). */
export function routeLabel(method: string, p: string): string {
  return `${method} ${p.split('?')[0]!.replace(/^\/session\/[^/]+/, '/session/:id')}`;
}
