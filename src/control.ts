import { InputMeter, InputResult, InputVia } from './inputlog.js';
import { Backend, ControlState, HttpError, PathPoint } from './types.js';

const MAX_WAITING = 50; // actions queued per phone before new ones are refused
const MAX_POINTS = 5000;
const MAX_GESTURE_MS = 60000;
const TAP_MS = 250; // a still touch lifted sooner than this is a tap
const STILL_PT = 4; // ...and "still" means it never strayed more than this many points
const STALE_TOUCH_MS = 60000;

function numbers(body: Record<string, unknown>, ...keys: string[]): number[] {
  return keys.map((k) => {
    const v = body[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `"${k}" must be a number`);
    return v;
  });
}

function duration(v: unknown, dflt: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : dflt;
}

function parsePath(v: unknown): PathPoint[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_POINTS) {
    throw new HttpError(400, `"points" must be an array of [x, y, ms] (1 to ${MAX_POINTS})`);
  }
  let prev = 0;
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2) throw new HttpError(400, `points[${i}] must be [x, y, ms]`);
    const [x, y, ms = prev] = p as unknown[];
    for (const n of [x, y, ms]) {
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `points[${i}] must hold numbers`);
    }
    prev = Math.max(prev, Math.min(Math.max(0, ms as number), MAX_GESTURE_MS)); // keep time monotonic
    return [x as number, y as number, prev];
  });
}

interface Touch {
  pts: PathPoint[];
  t0: number; // Date.now() at t = 0
  owner?: object;
  timer?: NodeJS.Timeout;
  /** Its down went straight to the phone (HID live touch): moves and the up follow live. */
  live: boolean;
  /** A live event failed: the rest is buffered and the whole gesture played on "up" by the other route. */
  liveFailed: boolean;
  /** A live move waiting in the phone's queue (later moves only update `next`: a stall never builds a backlog). */
  moveQueued: boolean;
  next?: [number, number];
}

type Result = InputResult | void;

/**
 * Validates, clamps and serialises every phone action. One queue per phone, so actions from HTTP and the
 * control WebSocket run in order and never overlap. Live touch (down/move/up) goes straight to the phone when it
 * has a live channel (CoreDevice HID); otherwise it's buffered into one gesture played on "up".
 * Every action's receive -> injected time is measured (`meter`).
 */
export class Control {
  private queues = new Map<string, { tail: Promise<unknown>; waiting: number }>();
  private touches = new Map<string, Touch>();
  readonly meter: InputMeter;

  constructor(private backend: Backend, meter?: InputMeter) {
    this.meter = meter ?? new InputMeter();
  }

  /** Run one message: `{type: "tap"|"swipe"|"path"|"hold"|"home"|"type"|"launch"|"touch", ...}`. */
  async handle(udid: string, msg: Record<string, unknown>, owner?: object): Promise<Result> {
    const tRecv = performance.now();
    switch (msg.type) {
      case 'tap': {
        const [x, y] = this.clamp(udid, ...(numbers(msg, 'x', 'y') as [number, number]));
        return this.run(udid, 'tap', tRecv, () => this.backend.tap(udid, x, y));
      }
      case 'swipe': {
        const [x1, y1, x2, y2] = numbers(msg, 'x1', 'y1', 'x2', 'y2') as [number, number, number, number];
        return this.gesture(udid, [[x1, y1, 0], [x2, y2, duration(msg.ms, 300, 10000)]], 'swipe', tRecv);
      }
      case 'hold': {
        const [x, y] = numbers(msg, 'x', 'y') as [number, number];
        return this.gesture(udid, [[x, y, 0], [x, y, duration(msg.ms, 1000, 30000)]], 'hold', tRecv);
      }
      case 'path': {
        const pts = parsePath(msg.points);
        if (pts.length === 1) {
          const [x, y, ms] = pts[0]!;
          if (ms <= 0) return this.handle(udid, { type: 'tap', x, y });
          pts.unshift([x, y, 0]);
        }
        return this.gesture(udid, pts, 'path', tRecv);
      }
      case 'type':
        if (typeof msg.text !== 'string') throw new HttpError(400, '"text" must be a string');
        return this.run(udid, 'type', tRecv, () => this.backend.type(udid, msg.text as string));
      case 'home':
        return this.run(udid, 'home', tRecv, () => this.backend.home(udid));
      case 'launch':
        if (typeof msg.bundleId !== 'string' || !msg.bundleId) throw new HttpError(400, '"bundleId" must be a string');
        return this.run(udid, 'launch', tRecv, () => this.backend.launch(udid, msg.bundleId as string));
      case 'touch':
        return this.touch(udid, msg, tRecv, owner);
      default:
        throw new HttpError(400, `unknown action type ${JSON.stringify(msg.type ?? null)}`);
    }
  }

  /** Recover the phone's WDA, in the phone's queue so it never overlaps an action. */
  recover(udid: string): Promise<ControlState> {
    let state: ControlState = 'down';
    return this.run(udid, 'recover', null, async () => {
      state = await this.backend.recover(udid);
    }).then(() => state);
  }

  /** Forget unfinished live touches started by `owner` (its socket closed); a finger down on the phone is lifted. */
  release(owner: object): void {
    for (const [udid, t] of this.touches) {
      if (t.owner === owner) this.drop(udid, t);
    }
  }

  /** Forget a touch; a live one's finger is lifted on the phone. */
  private drop(udid: string, g: Touch): void {
    if (g.timer) clearTimeout(g.timer);
    if (this.touches.get(udid) === g) this.touches.delete(udid);
    if (g.live && !g.liveFailed && this.backend.liveTouch) {
      const [x, y] = g.next ?? [g.pts[g.pts.length - 1]![0], g.pts[g.pts.length - 1]![1]];
      g.liveFailed = true;
      const lift = this.backend.liveTouch.bind(this.backend);
      this.run(udid, 'touch-up', null, () => lift(udid, 'up', x, y)).catch(() => {});
    }
  }

  private clamp(udid: string, x: number, y: number): [number, number] {
    const s = this.backend.screen(udid);
    const mx = s ? Math.max(0, s.width - 1) : Infinity;
    const my = s ? Math.max(0, s.height - 1) : Infinity;
    return [Math.min(Math.max(0, x), mx), Math.min(Math.max(0, y), my)];
  }

  private gesture(udid: string, pts: PathPoint[], type: string, tRecv: number): Promise<Result> {
    const clamped = pts.map(([x, y, t]) => [...this.clamp(udid, x, y), t] as PathPoint);
    return this.run(udid, type, tRecv, () => this.backend.gesture(udid, clamped));
  }

  /** In the phone's queue; with `tRecv`, its receive -> injected time is recorded. */
  private run(udid: string, type: string, tRecv: number | null, fn: () => Promise<Result>): Promise<Result> {
    let q = this.queues.get(udid);
    if (!q) {
      q = { tail: Promise.resolve(), waiting: 0 };
      this.queues.set(udid, q);
    }
    if (q.waiting >= MAX_WAITING) return Promise.reject(new HttpError(503, 'too many actions waiting for this phone'));
    const queue = q;
    queue.waiting++;
    const p = queue.tail.then(async () => {
      const tStart = performance.now();
      try {
        const r = await fn();
        if (tRecv !== null) this.record(udid, type, tRecv, tStart, r ? r.via : null, true);
        return r;
      } catch (err) {
        if (tRecv !== null) this.record(udid, type, tRecv, tStart, null, false, (err as Error)?.message);
        throw err;
      }
    });
    queue.tail = p.then(
      () => undefined,
      () => undefined,
    );
    void queue.tail.then(() => {
      queue.waiting--;
      if (!queue.waiting && this.queues.get(udid) === queue) this.queues.delete(udid);
    });
    return p;
  }

  private record(udid: string, type: string, tRecv: number, tStart: number, via: InputVia | null, ok: boolean, error?: string): void {
    const end = performance.now();
    this.meter.add(udid, {
      at: Date.now(), type, via, ok, wait_ms: tStart - tRecv, inject_ms: end - tStart, total_ms: end - tRecv,
      ...(error ? { error: error.slice(0, 200) } : {}),
    });
  }

  /**
   * Live touch. With a live channel (HID) down/move/up go to the phone as they come (a real finger: drags follow
   * live, a hold is a hold). Without one (WDA can't keep a finger down across requests) they're buffered and played
   * as one gesture on "up", keeping every point and its timing (`t` = ms since the press, else server time).
   */
  private touch(udid: string, msg: Record<string, unknown>, tRecv: number, owner?: object): Promise<Result> {
    const phase = msg.phase;
    if (phase !== 'down' && phase !== 'move' && phase !== 'up') throw new HttpError(400, '"phase" must be down, move or up');
    const [x, y] = this.clamp(udid, ...(numbers(msg, 'x', 'y') as [number, number]));
    const now = Date.now();
    const given = typeof msg.t === 'number' && Number.isFinite(msg.t) && msg.t >= 0 ? Math.min(msg.t, MAX_GESTURE_MS) : null;
    const g = this.touches.get(udid);
    const liveTouch = this.backend.liveTouch?.bind(this.backend);

    if (phase === 'down') {
      if (g) {
        // a new press lifts any unfinished one
        if (g.live && !g.liveFailed) this.drop(udid, g);
        else this.finish(udid, g, tRecv).catch(() => {});
      }
      const t = given ?? 0;
      const live = !!liveTouch && !!this.backend.liveTouchReady?.(udid);
      const ng: Touch = { pts: [[x, y, t]], t0: now - t, owner, live, liveFailed: false, moveQueued: false };
      ng.timer = setTimeout(() => this.drop(udid, ng), STALE_TOUCH_MS);
      this.touches.set(udid, ng);
      if (!live || !liveTouch) return Promise.resolve();
      return this.run(udid, 'touch-down', tRecv, () => liveTouch(udid, 'down', x, y)).catch((): Result => {
        ng.liveFailed = true; // the rest is buffered; "up" plays the whole gesture by the other route
        return { via: 'buffered' };
      });
    }
    if (!g) return Promise.resolve(); // stray move/up without a down: nothing to do
    const last = g.pts[g.pts.length - 1]!;
    const t = Math.max(last[2], Math.min(given ?? now - g.t0, MAX_GESTURE_MS));
    if (phase === 'move') {
      if (g.pts.length < MAX_POINTS) g.pts.push([x, y, t]);
      if (!g.live || g.liveFailed || !liveTouch) return Promise.resolve();
      g.next = [x, y];
      if (g.moveQueued) return Promise.resolve({ via: 'hid' }); // folded into the move already waiting
      g.moveQueued = true;
      return this.run(udid, 'touch-move', tRecv, () => {
        g.moveQueued = false;
        const [mx, my] = g.next!;
        return liveTouch(udid, 'move', mx, my);
      }).catch((): Result => {
        g.moveQueued = false;
        g.liveFailed = true;
        return { via: 'buffered' };
      });
    }
    g.pts.push([x, y, t]);
    if (g.live && !g.liveFailed && liveTouch) {
      if (g.timer) clearTimeout(g.timer);
      if (this.touches.get(udid) === g) this.touches.delete(udid);
      return this.run(udid, 'touch-up', tRecv, () => liveTouch(udid, 'up', x, y)).catch(() => {
        g.liveFailed = true; // the finger may not have reached the phone whole: play the gesture by the other route
        return this.finish(udid, g, tRecv);
      });
    }
    return this.finish(udid, g, tRecv);
  }

  private finish(udid: string, g: Touch, tRecv: number): Promise<Result> {
    if (g.timer) clearTimeout(g.timer);
    if (this.touches.get(udid) === g) this.touches.delete(udid);
    const pts = g.pts;
    const [fx, fy] = pts[0]!;
    const end = pts[pts.length - 1]![2];
    const still = pts.every(([x, y]) => Math.hypot(x - fx, y - fy) < STILL_PT);
    if (still && end < TAP_MS) return this.run(udid, 'tap', tRecv, () => this.backend.tap(udid, fx, fy));
    if (pts.length === 1) pts.push([fx, fy, end]);
    return this.run(udid, 'gesture', tRecv, () => this.backend.gesture(udid, pts)); // already clamped
  }
}
