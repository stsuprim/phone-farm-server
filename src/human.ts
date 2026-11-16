import { PathPoint } from './types.js';

/**
 * Natural touch (2026-11-16, the setting `naturalTouch`, on by default): what the AI sends moves like a finger.
 * A swipe follows a slight bow with ease-in and ease-out speed over a time that fits its length; a tap lands a few
 * points off the exact place (inside the element it was aimed at) and is held a short, varied moment; a drag is
 * pressed, moved the same way and rested before the lift. Every random draw comes from a seeded generator, so the
 * same seed gives the same touches (tests). With the setting off, everything is exact and straight.
 */

/** A random number in [0, 1). */
export type Rng = () => number;

/** mulberry32: a small, fast, seeded generator (deterministic for a seed). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minimum-jerk easing (10t³ - 15t⁴ + 6t⁵): starts and ends at rest, monotone, exact at 0 and 1. */
export function ease(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * u * (10 + u * (-15 + 6 * u));
}

const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

/** A normal draw (Box-Muller), clipped to ±`most`. */
function gauss(rng: Rng, sd: number, most: number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
  return Math.max(-most, Math.min(most, n));
}

/** Shortest and longest swipe a finger makes (ms). */
export const SWIPE_MIN_MS = 120;
export const SWIPE_MAX_MS = 1200;

/**
 * How long a finger takes to swipe `dist` points: about 200 ms for a short flick, 330 for 300 pt, 460 for 800 pt
 * (grows with the square root of the length), ±10 % with `rng`.
 */
export function swipeMs(dist: number, rng?: Rng): number {
  const base = 120 + 12 * Math.sqrt(Math.max(0, dist));
  const k = rng ? between(rng, 0.9, 1.1) : 1;
  return Math.round(Math.min(SWIPE_MAX_MS, Math.max(SWIPE_MIN_MS, base * k)));
}

/** Sample step of a made path (ms; ~120 Hz, like a one-command swipe's replay). */
export const CURVE_STEP_MS = 8;

export interface CurveOptions {
  /** Time of the first point (ms; a drag's press comes first). */
  startMs?: number;
  /** Sample step (ms). */
  stepMs?: number;
  /** Where a point may be (the screen): each made point is clamped by it (the two ends are exact already). */
  clamp?: (x: number, y: number) => [number, number];
}

/**
 * One finger from `a` to `b` over `ms`: a quadratic Bézier whose middle bows sideways by 3-8 % of the length (at most
 * 24 pt, either side), walked with minimum-jerk speed (slow off the mark, fastest mid-way, slow into the end). The
 * first and last points are exactly `a` and `b`; progress along the way never goes back.
 */
export function curvePath(a: [number, number], b: [number, number], ms: number, rng: Rng, opts: CurveOptions = {}): PathPoint[] {
  const t0 = opts.startMs ?? 0;
  const step = Math.max(1, opts.stepMs ?? CURVE_STEP_MS);
  const dur = Math.max(1, Math.round(ms));
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  // the control point: the middle, pushed sideways (a thumb's arc) and a little along the way
  const bow = len > 0 ? Math.min(24, len * between(rng, 0.03, 0.08)) * (rng() < 0.5 ? -1 : 1) : 0;
  const along = between(rng, -0.08, 0.08);
  const nx = len > 0 ? -dy / len : 0;
  const ny = len > 0 ? dx / len : 0;
  const cx = ax + dx * (0.5 + along) + nx * bow * 2; // a quadratic's middle reaches half its control's offset
  const cy = ay + dy * (0.5 + along) + ny * bow * 2;
  const n = Math.max(2, Math.ceil(dur / step));
  const out: PathPoint[] = [[ax, ay, t0]];
  for (let i = 1; i < n; i++) {
    const s = ease(i / n);
    const m = 1 - s;
    let x = m * m * ax + 2 * m * s * cx + s * s * bx;
    let y = m * m * ay + 2 * m * s * cy + s * s * by;
    if (opts.clamp) [x, y] = opts.clamp(x, y);
    out.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, t0 + Math.round((i * dur) / n)]);
  }
  out.push([bx, by, t0 + dur]);
  return out;
}

/** A drag's rest before the lift (ms), so the release isn't a fling. */
export const DRAG_REST_MS = 150;

/**
 * A drag (`hold` > 0): pressed at `a` for `hold` ms, moved to `b` over `ms`, rested `DRAG_REST_MS`, lifted.
 * Natural (an `rng`): the move is a `curvePath`, the hold and the rest vary a little; exact: a straight line at even
 * speed (every CURVE_STEP_MS*2), the times as given.
 */
export function dragPath(a: [number, number], b: [number, number], hold: number, ms: number, rng: Rng | null, clamp?: CurveOptions['clamp']): PathPoint[] {
  const h = Math.max(0, Math.round(rng ? hold * between(rng, 0.92, 1.08) : hold));
  const rest = rng ? Math.round(DRAG_REST_MS * between(rng, 0.85, 1.25)) : DRAG_REST_MS;
  const out: PathPoint[] = [[a[0], a[1], 0]];
  if (h > 0) out.push([a[0], a[1], h]);
  if (rng) {
    out.push(...curvePath(a, b, ms, rng, { startMs: h, clamp }).slice(1));
  } else {
    const steps = Math.min(400, Math.max(2, Math.round(ms / 16)));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, h + Math.round(ms * k)]);
    }
  }
  const end = out[out.length - 1]![2];
  out.push([b[0], b[1], end + rest]);
  return out;
}

/** A tap's hold (ms): a finger is down 50-120 ms. */
export const TAP_HOLD_MIN = 50;
export const TAP_HOLD_MAX = 120;
/** How far a natural tap may land from the place aimed at (points). */
export const TAP_OFFSET_MAX = 3;

/** A rectangle in points: x, y, w, h. */
export type Box = [number, number, number, number];

/**
 * Where a natural tap lands and how long it's held: up to TAP_OFFSET_MAX points off (x, y) (a normal spread, most
 * within 1-2 pt), kept inside `box` (the element aimed at, its edges kept clear by a fifth of its size, at most 2 pt)
 * and `screen`; held TAP_HOLD_MIN-TAP_HOLD_MAX ms.
 */
export function tapPlan(x: number, y: number, rng: Rng, box?: Box | null, screen?: { width: number; height: number } | null): { x: number; y: number; hold: number } {
  let tx = x + gauss(rng, 1.2, TAP_OFFSET_MAX);
  let ty = y + gauss(rng, 1.2, TAP_OFFSET_MAX);
  if (box && box[2] > 0 && box[3] > 0) {
    const [bx, by, bw, bh] = box;
    const mx = Math.min(2, bw / 5);
    const my = Math.min(2, bh / 5);
    tx = Math.min(bx + bw - mx, Math.max(bx + mx, tx));
    ty = Math.min(by + bh - my, Math.max(by + my, ty));
  }
  if (screen) {
    tx = Math.min(Math.max(0, screen.width - 1), Math.max(0, tx));
    ty = Math.min(Math.max(0, screen.height - 1), Math.max(0, ty));
  }
  const hold = Math.round(between(rng, TAP_HOLD_MIN, TAP_HOLD_MAX));
  return { x: Math.round(tx * 10) / 10, y: Math.round(ty * 10) / 10, hold };
}
