import { Backend, HttpError, PathPoint } from './types.js';

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
  timer: NodeJS.Timeout;
}

/**
 * Validates, clamps and serialises every phone action. One queue per phone, so actions from HTTP and the
 * control WebSocket run in order and never overlap; live touch (down/move/up) is buffered into one gesture.
 */
export class Control {
  private queues = new Map<string, { tail: Promise<void>; waiting: number }>();
  private touches = new Map<string, Touch>();

  constructor(private backend: Backend) {}

  /** Run one message: `{type: "tap"|"swipe"|"path"|"hold"|"home"|"type"|"launch"|"touch", ...}`. */
  async handle(udid: string, msg: Record<string, unknown>, owner?: object): Promise<void> {
    switch (msg.type) {
      case 'tap': {
        const [x, y] = this.clamp(udid, ...(numbers(msg, 'x', 'y') as [number, number]));
        return this.run(udid, () => this.backend.tap(udid, x, y));
      }
      case 'swipe': {
        const [x1, y1, x2, y2] = numbers(msg, 'x1', 'y1', 'x2', 'y2') as [number, number, number, number];
        return this.gesture(udid, [[x1, y1, 0], [x2, y2, duration(msg.ms, 300, 10000)]]);
      }
      case 'hold': {
        const [x, y] = numbers(msg, 'x', 'y') as [number, number];
        return this.gesture(udid, [[x, y, 0], [x, y, duration(msg.ms, 1000, 30000)]]);
      }
      case 'path': {
        const pts = parsePath(msg.points);
        if (pts.length === 1) {
          const [x, y, ms] = pts[0]!;
          if (ms <= 0) return this.handle(udid, { type: 'tap', x, y });
          pts.unshift([x, y, 0]);
        }
        return this.gesture(udid, pts);
      }
      case 'type':
        if (typeof msg.text !== 'string') throw new HttpError(400, '"text" must be a string');
        return this.run(udid, () => this.backend.type(udid, msg.text as string));
      case 'home':
        return this.run(udid, () => this.backend.home(udid));
      case 'launch':
        if (typeof msg.bundleId !== 'string' || !msg.bundleId) throw new HttpError(400, '"bundleId" must be a string');
        return this.run(udid, () => this.backend.launch(udid, msg.bundleId as string));
      case 'touch':
        return this.touch(udid, msg, owner);
      default:
        throw new HttpError(400, `unknown action type ${JSON.stringify(msg.type ?? null)}`);
    }
  }

  /** Forget unfinished live touches started by `owner` (its socket closed). */
  release(owner: object): void {
    for (const [udid, t] of this.touches) {
      if (t.owner === owner) {
        clearTimeout(t.timer);
        this.touches.delete(udid);
      }
    }
  }

  private clamp(udid: string, x: number, y: number): [number, number] {
    const s = this.backend.screen(udid);
    const mx = s ? Math.max(0, s.width - 1) : Infinity;
    const my = s ? Math.max(0, s.height - 1) : Infinity;
    return [Math.min(Math.max(0, x), mx), Math.min(Math.max(0, y), my)];
  }

  private gesture(udid: string, pts: PathPoint[]): Promise<void> {
    const clamped = pts.map(([x, y, t]) => [...this.clamp(udid, x, y), t] as PathPoint);
    return this.run(udid, () => this.backend.gesture(udid, clamped));
  }

  private run(udid: string, fn: () => Promise<void>): Promise<void> {
    let q = this.queues.get(udid);
    if (!q) {
      q = { tail: Promise.resolve(), waiting: 0 };
      this.queues.set(udid, q);
    }
    if (q.waiting >= MAX_WAITING) return Promise.reject(new HttpError(503, 'too many actions waiting for this phone'));
    const queue = q;
    queue.waiting++;
    const p = queue.tail.then(fn);
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

  /**
   * Live touch. WDA can't keep a finger down across requests, so down/move/up are buffered and played as one
   * W3C pointer action on "up", keeping every point and its timing (`t` = ms since the press, else server time).
   */
  private touch(udid: string, msg: Record<string, unknown>, owner?: object): Promise<void> {
    const phase = msg.phase;
    if (phase !== 'down' && phase !== 'move' && phase !== 'up') throw new HttpError(400, '"phase" must be down, move or up');
    const [x, y] = this.clamp(udid, ...(numbers(msg, 'x', 'y') as [number, number]));
    const now = Date.now();
    const given = typeof msg.t === 'number' && Number.isFinite(msg.t) && msg.t >= 0 ? Math.min(msg.t, MAX_GESTURE_MS) : null;
    let g = this.touches.get(udid);

    if (phase === 'down') {
      const before = g ? this.finish(udid, g) : null; // a new press lifts any unfinished one
      before?.catch(() => {});
      const t = given ?? 0;
      g = { pts: [[x, y, t]], t0: now - t, owner, timer: setTimeout(() => this.touches.delete(udid), STALE_TOUCH_MS) };
      this.touches.set(udid, g);
      return Promise.resolve();
    }
    if (!g) return Promise.resolve(); // stray move/up without a down: nothing to do
    const last = g.pts[g.pts.length - 1]!;
    const t = Math.max(last[2], Math.min(given ?? now - g.t0, MAX_GESTURE_MS));
    if (phase === 'move') {
      if (g.pts.length < MAX_POINTS) g.pts.push([x, y, t]);
      return Promise.resolve();
    }
    g.pts.push([x, y, t]);
    return this.finish(udid, g);
  }

  private finish(udid: string, g: Touch): Promise<void> {
    clearTimeout(g.timer);
    if (this.touches.get(udid) === g) this.touches.delete(udid);
    const pts = g.pts;
    const [fx, fy] = pts[0]!;
    const end = pts[pts.length - 1]![2];
    const still = pts.every(([x, y]) => Math.hypot(x - fx, y - fy) < STILL_PT);
    if (still && end < TAP_MS) return this.run(udid, () => this.backend.tap(udid, fx, fy));
    if (pts.length === 1) pts.push([fx, fy, end]);
    return this.run(udid, () => this.backend.gesture(udid, pts)); // already clamped
  }
}
