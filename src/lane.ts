import { HttpError } from './types.js';

/**
 * 2026-11-21, the root cause of "the more we fix the more it breaks": every part of the server asked a phone's
 * WebDriverAgent whatever it wanted whenever it wanted (the orientation every 3 s, the card's reads, the watch's
 * lock and dark checks, the settle's stills, the owner's touches, Lotus's reads, the health checks), all at once,
 * while the phone does one thing at a time: WDA runs its routes on the main queue, and XCTest's testmanagerd takes a
 * screenshot only once the accessibility read before it is done. One slow still (8-20 s) held everything behind it;
 * every request behind it ran out of time on the Mac (the owner's touch: "no answer within 5s") yet still ran on the
 * phone later, piling up more; and the server took those timeouts (and the still's own 500) for a dead WDA and
 * restarted the runner, again and again, which is what jams XCTest for good ("Control down", "needs replug").
 *
 * The lane: one per phone, and every request to its WDA goes through it. At most one is on its way at a time; a touch
 * (input) goes before reads that wait; a read that waited too long is dropped, never sent late; a background read
 * (`quiet`: the orientation poll, the card, a liveness probe) is skipped at once when anything else is on its way. A
 * request the Mac stopped waiting for (its caller already heard "no answer") still holds the lane until the phone
 * really answers it (or a long cap), so nothing piles up behind it on the phone.
 */
export type LanePrio = 'input' | 'read' | 'quiet';

/** A request that was never sent: the phone was busy with an earlier one (or skipped: a background read). 503. */
export class LaneBusy extends HttpError {
  constructor(message: string, extra: Record<string, unknown> = {}) {
    super(503, message, { state: 'busy', ...extra });
  }
}

/** What a started request gives the lane. */
export interface LaneRun<T> {
  /** The caller's answer (it may come before the request ended on the wire: a timeout on the Mac). */
  result: Promise<T>;
  /** The request really ended (the phone answered, it failed, or it was given up): the lane is free after this. */
  ended: Promise<unknown>;
}

interface Job {
  prio: LanePrio;
  label: string;
  at: number;
  maxWaitMs: number;
  key?: string;
  start: () => LaneRun<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: NodeJS.Timeout;
  /** Callers that asked the very same quiet read meanwhile: they get its answer. */
  joined: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[];
}

export interface LaneState {
  /** The request on its way now ("GET /lotus/shot"), or null. */
  inFlight: string | null;
  /** Since when (ms since the epoch), and whether its caller already stopped waiting (it still holds the lane). */
  since: number | null;
  abandoned: boolean;
  /** Requests waiting their turn. */
  waiting: number;
}

/** Inputs first, then reads, then quiet reads; first come, first served within each. */
const RANK: Record<LanePrio, number> = { input: 0, read: 1, quiet: 2 };

export class WdaLane {
  private queue: Job[] = [];
  private current: { label: string; prio: LanePrio; since: number; abandoned: boolean } | null = null;
  private drains = new Set<() => void>();
  private now: () => number;
  private explain?: (label: string) => string | null;

  /**
   * `name()`: the phone's name, for the messages. `explain(label)`: why the request on its way is slow, when that's
   * known (2026-11-21: "the app in front isn't answering accessibility reads"), said in the "busy" answer.
   */
  constructor(private name: () => string, opts: { now?: () => number; explain?: (label: string) => string | null } = {}) {
    this.now = opts.now ?? Date.now;
    this.explain = opts.explain;
  }

  /** Nothing on its way and nothing waiting. */
  get idle(): boolean {
    return !this.current && !this.queue.length;
  }

  /** Requests on their way or waiting (stats). */
  get load(): number {
    return (this.current ? 1 : 0) + this.queue.length;
  }

  state(): LaneState {
    return {
      inFlight: this.current?.label ?? null,
      since: this.current?.since ?? null,
      abandoned: this.current?.abandoned ?? false,
      waiting: this.queue.length,
    };
  }

  /**
   * Runs `start` when it's this request's turn, and answers what it answers. `maxWaitMs`: how long it may wait for
   * its turn before it's dropped unsent (a LaneBusy). A quiet read is skipped at once (a LaneBusy) while anything
   * that isn't a quiet read is on its way or waiting; the same quiet read (`key`) asked again meanwhile joins it.
   */
  run<T>(prio: LanePrio, label: string, maxWaitMs: number, start: () => LaneRun<T>, key?: string): Promise<T> {
    if (prio === 'quiet') {
      const busy = (this.current && this.current.prio !== 'quiet') || this.queue.some((j) => j.prio !== 'quiet');
      if (busy) return Promise.reject(this.busyError(label, true));
      const same = key ? this.queue.find((j) => j.key === key) : undefined;
      if (same) return new Promise<T>((resolve, reject) => same.joined.push({ resolve: resolve as (v: unknown) => void, reject }));
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = { prio, label, at: this.now(), maxWaitMs, key, start: start as () => LaneRun<unknown>, resolve: resolve as (v: unknown) => void, reject, joined: [] };
      if (Number.isFinite(maxWaitMs)) {
        job.timer = setTimeout(() => {
          const i = this.queue.indexOf(job);
          if (i < 0) return;
          this.queue.splice(i, 1);
          const err = this.busyError(label, false);
          job.reject(err);
          for (const j of job.joined) j.reject(err);
        }, Math.max(0, maxWaitMs));
      }
      this.queue.push(job);
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

  /** Resolves true once nothing is on its way (at once when idle), false after `ms`. */
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

  private busyError(label: string, skipped: boolean): LaneBusy {
    const c = this.current;
    const on = c ? `${c.label}, ${((this.now() - c.since) / 1000).toFixed(1)} s so far${c.abandoned ? ', still waiting for the phone to answer it' : ''}` : 'requests ahead of it';
    const ahead = this.queue.length;
    const why = c ? this.explain?.(c.label) ?? null : null;
    return new LaneBusy(
      skipped
        ? `${this.name()} is busy (${on}): ${label} skipped`
        : `${this.name()} is busy: its WebDriverAgent is still working on an earlier request (${on}${ahead > 1 ? `; ${ahead - 1} more waiting` : ''}${why ? `; ${why}` : ''}), so ${label} was not sent; try again in a moment`,
      { inFlight: c?.label ?? null, skipped },
    );
  }

  private next(): Job | undefined {
    let best: Job | undefined;
    for (const j of this.queue) if (!best || RANK[j.prio] < RANK[best.prio]) best = j;
    return best;
  }

  private pump(): void {
    if (this.current) return;
    const job = this.next();
    if (!job) {
      for (const d of [...this.drains]) d();
      return;
    }
    this.queue.splice(this.queue.indexOf(job), 1);
    if (job.timer) clearTimeout(job.timer);
    const cur = { label: job.label, prio: job.prio, since: this.now(), abandoned: false };
    this.current = cur;
    let run: LaneRun<unknown>;
    try {
      run = job.start();
    } catch (err) {
      this.current = null;
      job.reject(err);
      for (const j of job.joined) j.reject(err);
      return this.pump();
    }
    let over = false;
    const answered = () => {
      if (!over) cur.abandoned = true; // the caller has its answer; the request is still on the wire
    };
    run.result.then(
      (v) => {
        answered();
        job.resolve(v);
        for (const j of job.joined) j.resolve(v);
      },
      (err) => {
        answered();
        job.reject(err);
        for (const j of job.joined) j.reject(err);
      },
    );
    const free = () => {
      over = true;
      if (this.current === cur) this.current = null;
      this.pump();
    };
    run.ended.then(free, free);
  }
}

/**
 * Whose turn first: a touch, a key, typing, a launch, a lock or a lift is input; everything that only looks (and the
 * session's own housekeeping) is a read.
 */
export function routePriority(method: string, p: string): LanePrio {
  const route = p.split('?')[0]!;
  if (method === 'GET') return 'read';
  if (method === 'DELETE') return /\/actions$/.test(route) ? 'input' : 'read';
  if (route === '/session' || /\/appium\/settings$/.test(route)) return 'read';
  return 'input';
}

/** A request as the messages say it: the session's id and the query left out ("GET /session/:id/orientation"). */
export function routeLabel(method: string, p: string): string {
  return `${method} ${p.split('?')[0]!.replace(/^\/session\/[^/]+/, '/session/:id')}`;
}
