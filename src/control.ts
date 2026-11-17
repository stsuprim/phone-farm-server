import crypto from 'node:crypto';
import { Box, curvePath, dragPath, Rng, seeded, swipeMs, tapPlan } from './human.js';
import { InputMeter, InputResult, InputVia } from './inputlog.js';
import { guessUnit, parseUnit, toPoints, Unit } from './orient.js';
import { Backend, ButtonName, ControlState, HttpError, PathPoint } from './types.js';

const MAX_WAITING = 50; // actions queued per phone before new ones are refused
const MAX_POINTS = 5000;
const MAX_GESTURE_MS = 60000;
const TAP_MS = 250; // a still touch lifted sooner than this is a tap
const STILL_PT = 4; // ...and "still" means it never strayed more than this many points
const STALE_TOUCH_MS = 60000; // a buffered touch (nothing on the phone yet) never lifted is forgotten after this
/**
 * A live touch (a finger down on the phone) is lifted by the server when neither an event of the touch nor anything
 * at all from its sender (its socket's or channel's pings count: `Control.alive`) came for this long: the link died
 * with the finger down. 2026-11-16: it was 1.5 s without a touch event, whatever the link said, so a finger held still
 * was lifted whenever the client's repeated moves were late or lost (a long press let go by itself, a drag cut).
 */
export const TOUCH_RELEASE_MS = 6000;
/**
 * ...and one whose sender is alive but has said nothing of the touch for this long (a frozen page; a healthy client
 * repeats a still finger's place a few times a second: the page every 0.4 s) is lifted too. 2026-11-17: 30 s became
 * 5 s (the watchdog: no finger is ever left down for long). A buffered touch has nothing on the phone to lift.
 */
export const TOUCH_QUIET_MS = 5000;
/** A finger held still: its contact is said again to the phone this often, so nothing on the way takes it for stuck. */
export const HOLD_REPEAT_MS = 800;
/**
 * A touch whose sender closed (a data channel made anew, a socket reconnecting) waits this long for the same touch to
 * go on over another link before it's lifted.
 */
export const OWNER_GRACE_MS = 2500;
/**
 * A live touch stays down at least this long. A quick tap whose down waited in the phone's queue (the phone waking,
 * a gesture still playing) would otherwise be pressed and lifted in the same instant, which iOS can take for nothing.
 */
export const MIN_CONTACT_MS = 30;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The keys POST /key (and `{type: "key"}`) takes. */
export const KEYS = ['home', 'lock', 'volumeUp', 'volumeDown', 'enter', 'delete'] as const;
export type KeyName = (typeof KEYS)[number];

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

/** Replay step for a one-command swipe: the gesture is resampled to this (ms; ~120 Hz) so it plays smooth. */
export const SWIPE_STEP_MS = 8;
const SWIPE_DEFAULT_MS = 300;

/**
 * A one-command swipe's points, ready to replay as one gesture: time starts at 0; with `duration` (ms) the client's
 * timing is stretched to it (no timing at all: spread evenly); then resampled every SWIPE_STEP_MS by linear
 * interpolation along the path, so a coarse or jittery client sample still plays as a smooth drag. One point (or a
 * zero-length, zero-time path) stays one point (a tap).
 */
export function swipePlan(points: PathPoint[], duration?: unknown, stepMs = SWIPE_STEP_MS): PathPoint[] {
  if (!points.length) return [];
  const t0 = points[0]![2];
  let pts = points.map(([x, y, t]) => [x, y, t - t0] as PathPoint);
  const span = pts[pts.length - 1]![2];
  const want = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? Math.min(duration, MAX_GESTURE_MS) : null;
  if (pts.length === 1) return want ? [pts[0]!, [pts[0]![0], pts[0]![1], want]] : pts;
  if (span <= 0) {
    const total = want ?? SWIPE_DEFAULT_MS;
    pts = pts.map(([x, y], i) => [x, y, (total * i) / (pts.length - 1)] as PathPoint);
  } else if (want) {
    pts = pts.map(([x, y, t]) => [x, y, (t * want) / span] as PathPoint);
  }
  const end = pts[pts.length - 1]![2];
  const step = Math.max(stepMs, end / (MAX_POINTS - 2)); // a very long drag: fewer steps, never cut short
  const out: PathPoint[] = [];
  let j = 0;
  for (let t = 0; t < end; t += step) {
    while (j < pts.length - 2 && pts[j + 1]![2] <= t) j++;
    const a = pts[j]!;
    const b = pts[j + 1]!;
    const f = b[2] > a[2] ? Math.min(1, Math.max(0, (t - a[2]) / (b[2] - a[2]))) : 1;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, t]);
  }
  const last = pts[pts.length - 1]!;
  out.push([last[0], last[1], end]);
  return out;
}

/** Whoever sent a touch (a socket, a data channel): told when the server lifts it itself. */
export interface TouchOwner {
  touchReleased?(info: { id: unknown; reason: 'timeout' | 'lost'; error?: string }): void;
}

interface Touch {
  /** The client's touch id (`id` on messages that carry `seq`); null for older clients. */
  tid: unknown;
  /** The newest `seq` applied (older moves arriving late are skipped). */
  seq: number;
  /** The unit its `down` came in; later events without one use it. */
  unit: Unit;
  pts: PathPoint[];
  t0: number; // Date.now() at t = 0
  owner?: object;
  timer?: NodeJS.Timeout;
  /** When an event of this touch last came, when its sender was last heard at all, when its sender closed (Date.now()). */
  eventAt: number;
  heardAt: number;
  orphanAt?: number;
  /** When its contact was last said to the phone (live touches: the hold's repeat). */
  reportAt: number;
  /** Its down went straight to the phone (HID live touch): moves and the up follow live. */
  live: boolean;
  /** When its down reached the phone (performance.now()). */
  downAt?: number;
  /** The live down never reached the phone: the gesture is buffered and played whole on "up" by the other route. */
  liveFailed: boolean;
  /** Why it isn't live (the ack's and the meter's `reason`). */
  reason?: string;
  /** A live move waiting in the phone's queue (later moves only update `next`: a stall never builds a backlog). */
  moving?: Promise<Result>;
  next?: [number, number];
  ended: boolean;
}

type Result = InputResult | void;

interface RunOptions {
  /** A discrete action (tap, swipe, touch down, typing...): a locked or dark phone is woken first. */
  discrete?: boolean;
  /** Never refused by a full queue (a touch's down and up, a lift). */
  must?: boolean;
  /** Not activity and never wakes (a lock). */
  silent?: boolean;
  /** Why a slower route took it, for the meter and the ack. */
  reason?: string;
  /** How long it may take before it counts as hung (ms; default the action timeout; Infinity: no limit). */
  timeoutMs?: number;
  /** Not input at all (a health check): not activity, not timed, no spacing, never marks the phone as acted on. */
  quiet?: boolean;
  /**
   * The owner's live touch on the phone's live channel (HID): never held up by what only WDA needs. It doesn't wait
   * for a health check, the idle probe or the look at a quiet phone's screen (those run beside it), nor for the
   * breath between two actions.
   */
  live?: boolean;
}

export interface ControlOptions {
  /** A live touch with no event and nothing from its sender for this long is lifted (ms; default TOUCH_RELEASE_MS). */
  releaseMs?: number;
  /** ...and one with no event of its own for this long, whatever its sender says (ms; default TOUCH_QUIET_MS). */
  quietMs?: number;
  /** A held finger's contact is said again to the phone this often (ms; default HOLD_REPEAT_MS; 0 = never). */
  holdRepeatMs?: number;
  /** A touch whose sender closed waits this long to go on over another link (ms; default OWNER_GRACE_MS). */
  ownerGraceMs?: number;
  /** Discrete actions on one phone start at least this long after the last one ended (ms; default MIN_GAP_MS). */
  minGapMs?: number;
  /** An action that takes longer than this is answered with an error and the phone is healed (ms; default ACTION_TIMEOUT_MS). */
  actionTimeoutMs?: number;
  /** The first discrete action after this long without one probes the phone first (ms; default IDLE_PROBE_MS). */
  idleProbeMs?: number;
  /**
   * Natural touch on now (the server's `naturalTouch` setting; default off here): taps, swipes, holds and drags sent
   * as commands move like a finger (src/human.ts). A message with `natural: false` is always exact.
   */
  natural?: () => boolean;
  /** Seed of natural touch's randomness (tests); default a random one. */
  seed?: number;
}

/** Bursts are spaced: WDA (and the phone) get a breath between two discrete actions. */
export const MIN_GAP_MS = 40;
/** An action hung longer than this (beyond its own length) is given up on and the phone healed. */
export const ACTION_TIMEOUT_MS = 20_000;
/** A phone left alone this long is probed (and healed) before the next action, inside the same request. */
export const IDLE_PROBE_MS = 30_000;
/** How long an action waits for that probe (a WDA restart takes longer: the action then waits in WDA's own start). */
const HEAL_WAIT_MS = 20_000;
/** How long an action waits for the phone to wake before it goes anyway. */
const WAKE_WAIT_MS = 30_000;
/** After an action timed out, the next one waits this much longer for it to settle (never two at once on WDA). */
const HUNG_GRACE_MS = 5_000;

/** `p`, or `onTimeout()`'s error after `ms`. */
function within<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  if (!Number.isFinite(ms)) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The ack of a live touch message that carried `seq`: `{ack: seq, ok, ms, id, phase, via?, reason?, coalesced?,
 * stray?, error?}` (`ms` = the server's receive -> injected). Null for a message without `seq` (older clients).
 */
export function touchAck(msg: Record<string, unknown>, t0: number, r: Result, error?: string): Record<string, unknown> | null {
  if (msg.type !== 'touch' || typeof msg.seq !== 'number' || !Number.isFinite(msg.seq)) return null;
  const base = { ack: msg.seq, id: msg.id ?? null, phase: msg.phase ?? null, ms: round1(performance.now() - t0) };
  if (error !== undefined) return { ...base, ok: false, error };
  return {
    ...base, ok: true,
    ...(r ? { via: r.via, ...(r.reason ? { reason: r.reason } : {}), ...(r.coalesced ? { coalesced: true } : {}), ...(r.stray ? { stray: true } : {}) } : {}),
  };
}

/**
 * Validates, maps and serialises every phone action. Coordinates come in normalized (0..1 of the upright picture),
 * in the upright picture's pixels or in points, and leave as upright points, clamped to the screen. One queue per
 * phone, so actions from HTTP, the control WebSocket and the data channels run in the order they arrived and never
 * overlap; a locked or dark phone is woken inside the queue, before the action. Live touch (down/move/up) goes
 * straight to the phone when it has a live channel (CoreDevice HID); otherwise it's buffered into one gesture played
 * on "up". Every action's receive -> injected time is measured (`meter`).
 */
export class Control {
  private queues = new Map<string, { tail: Promise<unknown>; waiting: number }>();
  private touches = new Map<string, Touch>();
  private acted = new Map<string, number>(); // when each phone last had an action start, end or finish playing
  private checks = new Map<string, Promise<unknown>>(); // a health check running beside each phone's queue
  private releaseMs: number;
  private quietMs: number;
  private holdRepeatMs: number;
  private ownerGraceMs: number;
  readonly meter: InputMeter;
  /**
   * Called for every input, inside the phone's queue (src/idle.ts): marks activity; for a discrete action it
   * returns a promise to wait for (the phone waking) or null.
   */
  onInput?: (udid: string, discrete: boolean, live?: boolean) => Promise<void> | null;
  /** Lock and wake (src/idle.ts), for `key: "lock"` and `wake`. */
  power?: { lock(udid: string): Promise<unknown>; wake(udid: string): Promise<unknown> };
  /** An app's name -> its bundle id (src/agent.ts), for `launch {name}`. */
  resolveApp?: (udid: string, name: string) => Promise<string>;
  /**
   * Probe the phone and heal what's wrong (backend.heal): called inside the queue before the first discrete action
   * after `idleProbeMs` without one, and (not waited for) when an action hung.
   */
  onHeal?: (udid: string, reason: string) => Promise<unknown>;
  /** An action ran (or failed): what it may have changed (the app in front, the battery) is worth a fresh look. */
  onActed?: (udid: string) => void;
  private minGapMs: number;
  private actionTimeoutMs: number;
  private idleProbeMs: number;
  private naturalOn: () => boolean;
  private rng: Rng;

  constructor(private backend: Backend, meter?: InputMeter, opts: ControlOptions = {}) {
    this.meter = meter ?? new InputMeter();
    this.releaseMs = opts.releaseMs ?? TOUCH_RELEASE_MS;
    this.quietMs = opts.quietMs ?? TOUCH_QUIET_MS;
    this.holdRepeatMs = opts.holdRepeatMs ?? HOLD_REPEAT_MS;
    this.ownerGraceMs = opts.ownerGraceMs ?? OWNER_GRACE_MS;
    this.minGapMs = opts.minGapMs ?? MIN_GAP_MS;
    this.actionTimeoutMs = opts.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    this.idleProbeMs = opts.idleProbeMs ?? IDLE_PROBE_MS;
    this.naturalOn = opts.natural ?? (() => false);
    this.rng = seeded(opts.seed ?? crypto.randomInt(0, 2 ** 31));
  }

  /** Whether this message's touch is made natural: the setting is on and the message didn't ask for exact. */
  private natural(msg: Record<string, unknown>): boolean {
    if (msg.natural === false || msg.exact === true) return false;
    try {
      return this.naturalOn();
    } catch {
      return false;
    }
  }

  /** Actions waiting in (or running from) the phone's queue now. */
  pending(udid: string): number {
    return this.queues.get(udid)?.waiting ?? 0;
  }

  /**
   * A health check beside the phone's queue: it never runs on WDA alongside an action (it's skipped, false, when the
   * queue isn't empty: the phone is being used, so the actions themselves find out; and an action that comes while
   * it runs waits for it). 2026-11-16: the owner's live touch doesn't wait for it: it goes by the phone's live channel,
   * not WDA, and a press that landed during a check used to sit in the queue for seconds (a drag that started late
   * and jumped).
   */
  async check(udid: string, fn: () => Promise<void>): Promise<boolean> {
    if (this.pending(udid) > 0 || this.checks.has(udid)) return false;
    const p = fn().finally(() => {
      if (this.checks.get(udid) === p) this.checks.delete(udid);
    });
    this.checks.set(udid, p);
    await p;
    return true;
  }

  /**
   * Something came from `owner` (a ping, any message on its socket or channel): its link is alive, so a finger of
   * its held still on the phone stays down.
   */
  alive(owner: object): void {
    const now = Date.now();
    for (const t of this.touches.values()) if (t.owner === owner) t.heardAt = now;
  }

  /**
   * Run one message: `{type: "tap"|"swipe"|"path"|"hold"|"home"|"type"|"key"|"launch"|"wake"|"touch", ...}`. A swipe
   * is either `{x1, y1, x2, y2, ms}` or a whole drag `{points: [[x, y, t], ...], duration}` (swipePlan). `unit` says
   * what the coordinates are ("norm", "px" with optional `w`/`h` of the picture, "pt"); without it, values within
   * 0..1 are normalized and anything else points.
   */
  async handle(udid: string, msg: Record<string, unknown>, owner?: object): Promise<Result> {
    const tRecv = performance.now();
    switch (msg.type) {
      case 'tap': {
        const [[x, y]] = this.map(udid, msg, [numbers(msg, 'x', 'y') as [number, number]]) as [[number, number]];
        // `hold`: the tap's own hold (ms), e.g. the owner's real one; natural: a few points off and held 50-120 ms
        const given = typeof msg.hold === 'number' && Number.isFinite(msg.hold) && msg.hold > 0 ? Math.min(2000, Math.round(msg.hold)) : undefined;
        if (this.natural(msg)) {
          const t = tapPlan(x, y, this.rng, this.box(udid, msg), this.backend.screen(udid));
          return this.run(udid, 'tap', tRecv, () => this.backend.tap(udid, t.x, t.y, given ?? t.hold), { discrete: true });
        }
        return this.run(udid, 'tap', tRecv, () => (given ? this.backend.tap(udid, x, y, given) : this.backend.tap(udid, x, y)), { discrete: true });
      }
      case 'swipe': {
        if (msg.points !== undefined) {
          // a whole drag in one command (the remote profile): replayed here as one smooth gesture
          const plan = swipePlan(this.mapPath(udid, msg, parsePath(msg.points)), msg.duration ?? msg.ms);
          if (plan.length === 1) return this.run(udid, 'tap', tRecv, () => this.backend.tap(udid, plan[0]![0], plan[0]![1]), { discrete: true });
          return this.gesture(udid, plan, 'swipe', tRecv);
        }
        const [x1, y1, x2, y2] = numbers(msg, 'x1', 'y1', 'x2', 'y2') as [number, number, number, number];
        const [a, b] = this.map(udid, msg, [[x1, y1], [x2, y2]]) as [[number, number], [number, number]];
        return this.gesture(udid, this.swipePoints(udid, msg, a, b), 'swipe', tRecv);
      }
      case 'hold': {
        let [[x, y]] = this.map(udid, msg, [numbers(msg, 'x', 'y') as [number, number]]) as [[number, number]];
        if (this.natural(msg)) ({ x, y } = tapPlan(x, y, this.rng, this.box(udid, msg), this.backend.screen(udid)));
        return this.gesture(udid, [[x, y, 0], [x, y, duration(msg.ms, 1000, 30000)]], 'hold', tRecv);
      }
      case 'path': {
        const pts = this.mapPath(udid, msg, parsePath(msg.points));
        if (pts.length === 1) {
          const [x, y, ms] = pts[0]!;
          if (ms <= 0) return this.run(udid, 'tap', tRecv, () => this.backend.tap(udid, x, y), { discrete: true });
          pts.unshift([x, y, 0]);
        }
        return this.gesture(udid, pts, 'path', tRecv);
      }
      case 'type': {
        if (typeof msg.text !== 'string') throw new HttpError(400, '"text" must be a string');
        const text = msg.text + (msg.enter === true ? '\n' : '');
        if (!text) throw new HttpError(400, '"text" is empty');
        return this.run(udid, 'type', tRecv, () => this.backend.type(udid, text), { discrete: true, timeoutMs: this.actionTimeoutMs + text.length * 150 });
      }
      case 'key':
        return this.key(udid, msg.key, tRecv);
      case 'home':
        return this.run(udid, 'home', tRecv, () => this.backend.home(udid), { discrete: true });
      case 'wake': {
        const power = this.power;
        if (!power) throw new HttpError(501, 'this server cannot wake phones');
        return this.run(udid, 'wake', tRecv, async () => {
          await power.wake(udid);
          return { via: 'wda' as InputVia };
        }, { timeoutMs: 45_000 });
      }
      case 'launch': {
        const bundleId = typeof msg.bundleId === 'string' && msg.bundleId ? msg.bundleId : null;
        const name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : null;
        if (!bundleId && !name) throw new HttpError(400, '"bundleId" (or "name") must be a string');
        const resolve = this.resolveApp;
        if (!bundleId && !resolve) throw new HttpError(501, 'this server cannot look apps up by name: send "bundleId"');
        // a name is looked up inside the queue, so a launch never jumps ahead of (or falls behind) its neighbours
        return this.run(udid, 'launch', tRecv, async () => this.backend.launch(udid, bundleId ?? (await resolve!(udid, name!))), { discrete: true });
      }
      case 'touch':
        return this.touch(udid, msg, tRecv, owner);
      default:
        throw new HttpError(400, `unknown action type ${JSON.stringify(msg.type ?? null)}`);
    }
  }

  private key(udid: string, key: unknown, tRecv: number): Promise<Result> {
    if (typeof key !== 'string' || !(KEYS as readonly string[]).includes(key)) {
      throw new HttpError(400, `"key" must be one of ${KEYS.join(', ')}`);
    }
    switch (key as KeyName) {
      case 'home':
        return this.run(udid, 'key-home', tRecv, () => this.backend.home(udid), { discrete: true });
      case 'enter':
        return this.run(udid, 'key-enter', tRecv, () => this.backend.type(udid, '\n'), { discrete: true });
      case 'delete':
        return this.run(udid, 'key-delete', tRecv, () => this.backend.type(udid, '\b'), { discrete: true });
      case 'lock': {
        const power = this.power;
        if (!power) throw new HttpError(501, 'this server cannot lock phones');
        return this.run(udid, 'key-lock', tRecv, async () => {
          await power.lock(udid);
          return { via: 'wda' as InputVia };
        }, { silent: true });
      }
      default: {
        const press = this.backend.pressButton?.bind(this.backend);
        if (!press) throw new HttpError(501, 'this backend cannot press the volume buttons');
        return this.run(udid, `key-${key}`, tRecv, () => press(udid, key as ButtonName), { discrete: true });
      }
    }
  }

  /** Recover the phone's WDA, in the phone's queue so it never overlaps an action. */
  recover(udid: string): Promise<ControlState> {
    let state: ControlState = 'down';
    return this.run(udid, 'recover', null, async () => {
      state = await this.backend.recover(udid);
    }, { silent: true, timeoutMs: Infinity }).then(() => state);
  }

  /**
   * `owner` closed (its socket, its data channel): its unfinished touches wait `ownerGraceMs` for the same touch to
   * go on over another link (the page's channel is made anew mid-drag and the touch carries on over its socket), then
   * a finger down on the phone is lifted and a buffered one dropped.
   */
  release(owner: object): void {
    const now = Date.now();
    for (const [udid, t] of this.touches) {
      if (t.owner !== owner) continue;
      if (this.ownerGraceMs <= 0) this.end(udid, t, 'closed');
      else {
        t.owner = undefined;
        t.orphanAt = now;
      }
    }
  }

  /** Whether a touch is in progress on the phone (tests, stats). */
  touching(udid: string): boolean {
    return this.touches.has(udid);
  }

  /**
   * When the phone last had input (performance.now(); -Infinity: never): an action's start, its end, and the end of
   * a gesture the phone was still playing. What was read from the screen before that may be stale (src/agent.ts).
   */
  lastAction(udid: string): number {
    return this.acted.get(udid) ?? -Infinity;
  }

  // ---- coordinates ----

  /** Coordinate pairs of one message, in its unit -> upright points, clamped to the screen. */
  private map(udid: string, msg: Record<string, unknown>, pairs: [number, number][], sticky?: Unit): [number, number][] {
    const unit = parseUnit(msg.unit) ?? sticky ?? guessUnit(pairs.flat());
    return pairs.map(([x, y]) => this.point(udid, msg, x, y, unit));
  }

  private mapPath(udid: string, msg: Record<string, unknown>, pts: PathPoint[]): PathPoint[] {
    const xy = this.map(udid, msg, pts.map(([x, y]) => [x, y] as [number, number]));
    return pts.map((p, i) => [xy[i]![0], xy[i]![1], p[2]] as PathPoint);
  }

  private point(udid: string, msg: Record<string, unknown>, x: number, y: number, unit: Unit): [number, number] {
    const s = this.backend.screen(udid);
    const fw = typeof msg.w === 'number' && msg.w > 0 ? msg.w : null;
    const fh = typeof msg.h === 'number' && msg.h > 0 ? msg.h : null;
    const p = toPoints(x, y, unit, s, fw && fh ? { width: fw, height: fh } : null);
    if (!p) {
      throw new HttpError(503, `the phone's screen size isn't known yet, so ${unit === 'norm' ? 'normalized' : 'pixel'} coordinates can't be placed (WDA has no session); try again shortly`);
    }
    return this.clamp(udid, p[0], p[1]);
  }

  private clamp(udid: string, x: number, y: number): [number, number] {
    const s = this.backend.screen(udid);
    const mx = s ? Math.max(0, s.width - 1) : Infinity;
    const my = s ? Math.max(0, s.height - 1) : Infinity;
    return [Math.min(Math.max(0, x), mx), Math.min(Math.max(0, y), my)];
  }

  /**
   * A two-point swipe's gesture. `hold` (ms) makes it a drag: pressed there first, then moved, then rested before the
   * lift (no fling). Natural: a slight bow with ease-in and ease-out, over `ms` (±8 %) or, without one, a time that
   * fits the length (src/human.ts). Exact: a straight line at even speed over `ms` (300 by default).
   */
  private swipePoints(udid: string, msg: Record<string, unknown>, a: [number, number], b: [number, number]): PathPoint[] {
    const natural = this.natural(msg);
    const given = typeof msg.ms === 'number' && Number.isFinite(msg.ms) && msg.ms > 0;
    const hold = typeof msg.hold === 'number' && Number.isFinite(msg.hold) && msg.hold > 0 ? Math.min(msg.hold, 10000) : 0;
    const clamp = (x: number, y: number) => this.clamp(udid, x, y);
    if (!natural) {
      const ms = duration(msg.ms, 300, 10000);
      if (hold) return dragPath(a, b, hold, ms, null);
      return [[a[0], a[1], 0], [b[0], b[1], ms]];
    }
    const ms = given ? Math.min(10000, Math.max(50, Math.round((msg.ms as number) * (0.92 + 0.16 * this.rng())))) : swipeMs(Math.hypot(b[0] - a[0], b[1] - a[1]), this.rng);
    if (hold) return dragPath(a, b, hold, ms, this.rng, clamp);
    return curvePath(a, b, ms, this.rng, { clamp });
  }

  /** The element a tap or hold aims at (`bounds: [x, y, w, h]` in the message's unit), in points; null without one. */
  private box(udid: string, msg: Record<string, unknown>): Box | null {
    const v = msg.bounds;
    if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    const [bx, by, bw, bh] = v as number[];
    if (!(bw! > 0) || !(bh! > 0)) return null;
    try {
      const m = this.map(udid, msg, [[bx!, by!], [bx! + bw!, by! + bh!]]);
      const [x1, y1] = m[0]!;
      const [x2, y2] = m[1]!;
      return x2 > x1 && y2 > y1 ? [x1, y1, x2 - x1, y2 - y1] : null;
    } catch {
      return null;
    }
  }

  /** `pts` are upright points already (mapped and clamped). */
  private gesture(udid: string, pts: PathPoint[], type: string, tRecv: number): Promise<Result> {
    return this.run(udid, type, tRecv, () => this.backend.gesture(udid, pts), { discrete: true, timeoutMs: this.actionTimeoutMs + Math.max(0, pts[pts.length - 1]![2]) });
  }

  // ---- the phone's queue ----

  /** In the phone's queue; with `tRecv`, its receive -> injected time is recorded. */
  private run(udid: string, type: string, tRecv: number | null, fn: () => Promise<Result>, opts: RunOptions = {}): Promise<Result> {
    let q = this.queues.get(udid);
    if (!q) {
      q = { tail: Promise.resolve(), waiting: 0 };
      this.queues.set(udid, q);
    }
    if (q.waiting >= MAX_WAITING && !opts.must) return Promise.reject(new HttpError(503, 'too many actions waiting for this phone'));
    const queue = q;
    queue.waiting++;
    let hung: Promise<unknown> | null = null; // the action that timed out, still on its way at the phone
    const p = queue.tail.then(async () => {
      if (opts.quiet) return fn();
      // a health check is on WDA right now: what goes through WDA waits for it (the owner's live touch doesn't)
      if (!opts.live) await this.checks.get(udid)?.catch(() => {});
      // the first action after a quiet spell: the phone's WDA is probed (and healed) first, in this same request
      if (opts.discrete && this.onHeal) {
        const last = this.acted.get(udid);
        const quiet = last === undefined ? Infinity : performance.now() - last;
        if (quiet >= this.idleProbeMs) {
          const why = last === undefined ? 'first action since the server started' : `first action after ${Math.round(quiet / 1000)} s idle`;
          const probe = within(this.onHeal(udid, why), HEAL_WAIT_MS, () => new Error('probe')).catch(() => {});
          if (!opts.live) await probe; // a live touch isn't WDA's: the probe runs beside it
        }
      }
      // input is activity (idle lock); a locked or dark phone is woken first, here, so the order of actions holds
      if (!opts.silent) {
        const waking = this.onInput?.(udid, !!opts.discrete, !!opts.live);
        if (waking && opts.discrete) await within(waking, WAKE_WAIT_MS, () => new Error('wake')).catch(() => {});
      }
      // bursts are spaced: a discrete action starts a breath after the last one ended
      if (opts.discrete && !opts.live && this.minGapMs > 0) {
        const since = performance.now() - (this.acted.get(udid) ?? -Infinity);
        if (since < this.minGapMs) await sleep(this.minGapMs - since);
      }
      const tStart = performance.now();
      this.acted.set(udid, tStart);
      try {
        const inner = fn();
        const limit = opts.timeoutMs ?? this.actionTimeoutMs;
        let r = await within(inner, limit, () => {
          hung = inner.catch(() => {});
          const why = `${type} on the phone got no answer within ${Math.round(limit / 1000)} s`;
          void this.onHeal?.(udid, why)?.catch(() => {});
          return new HttpError(504, `${why}: the phone is being checked and healed; it may still happen, so look at the screen before trying again`);
        });
        if (opts.reason && r && !r.reason) r = { ...r, reason: opts.reason };
        if (tRecv !== null) this.record(udid, type, tRecv, tStart, r ? r.via : null, true, undefined, r ? r.reason : undefined);
        return r;
      } catch (err) {
        if (tRecv !== null) this.record(udid, type, tRecv, tStart, null, false, (err as Error)?.message);
        throw err;
      } finally {
        this.acted.set(udid, performance.now());
        if (opts.discrete) this.onActed?.(udid);
      }
    });
    // An action answered when it was queued on the phone (HID's paths, the fast WDA route) is still playing there:
    // its sender has its answer, but the phone's next action waits until it's through, so a Home press or a tap by
    // another route never lands in the middle of a swipe. One that timed out is waited for a little longer too.
    queue.tail = p.then(
      (r) => {
        const play = r && typeof r.play_ms === 'number' && r.play_ms > 0 ? Math.min(r.play_ms, MAX_GESTURE_MS) : 0;
        return play ? sleep(play).then(() => void this.acted.set(udid, performance.now())) : undefined;
      },
      () => (hung ? Promise.race([hung, sleep(HUNG_GRACE_MS)]).then(() => undefined) : undefined),
    );
    void queue.tail.then(() => {
      queue.waiting--;
      if (!queue.waiting && this.queues.get(udid) === queue) this.queues.delete(udid);
    });
    return p;
  }

  private record(udid: string, type: string, tRecv: number, tStart: number, via: InputVia | null, ok: boolean, error?: string, reason?: string): void {
    const end = performance.now();
    this.meter.add(udid, {
      at: Date.now(), type, via, ok, wait_ms: tStart - tRecv, inject_ms: end - tStart, total_ms: end - tRecv,
      ...(error ? { error: error.slice(0, 200) } : {}),
      ...(reason ? { reason: reason.slice(0, 200) } : {}),
    });
  }

  // ---- live touch ----

  /**
   * Live touch: `{type: "touch", phase: "down"|"move"|"up", x, y, t, seq, id}`. With a live channel (HID) down, move
   * and up go to the phone as they come, in order (a real finger: drags follow live, a hold is a hold); a down and
   * an up are never dropped, and moves arriving while the phone is behind fold into the newest one. Without one (WDA
   * can't keep a finger down across requests) they're buffered and played as one gesture on "up", keeping every
   * point and its timing (`t` = ms since the press, else server time). One contact is held on the phone from the down
   * to the up: a finger held still stays down for as long as its sender's link is alive (`alive`; the server says the
   * contact again to the phone meanwhile), and is lifted by the server only when that link died (`watch`). Natural
   * touch never comes near it: the owner's own input goes to the phone as it came.
   */
  private touch(udid: string, msg: Record<string, unknown>, tRecv: number, owner?: object): Promise<Result> {
    const phase = msg.phase;
    if (phase !== 'down' && phase !== 'move' && phase !== 'up') throw new HttpError(400, '"phase" must be down, move or up');
    const [rx, ry] = numbers(msg, 'x', 'y') as [number, number];
    const now = Date.now();
    const given = typeof msg.t === 'number' && Number.isFinite(msg.t) && msg.t >= 0 ? Math.min(msg.t, MAX_GESTURE_MS) : null;
    // `id` names the touch only on messages that carry `seq`; on older clients' messages it was the ack's id
    const seq = typeof msg.seq === 'number' && Number.isFinite(msg.seq) ? msg.seq : null;
    const tid = seq !== null ? msg.id ?? null : null;
    const g = this.touches.get(udid);
    const liveTouch = this.backend.liveTouch?.bind(this.backend);

    if (phase === 'down') {
      const unit = parseUnit(msg.unit) ?? guessUnit([rx, ry]);
      const [x, y] = this.point(udid, msg, rx, ry, unit);
      if (g) this.end(udid, g, 'replaced'); // a new press lifts (or plays) any unfinished one
      const t = given ?? 0;
      const live = !!liveTouch && !!this.backend.liveTouchReady?.(udid);
      const ng: Touch = { tid, seq: seq ?? -Infinity, unit, pts: [[x, y, t]], t0: now - t, owner, live, liveFailed: false, ended: false, eventAt: now, heardAt: now, reportAt: now };
      this.touches.set(udid, ng);
      this.arm(udid, ng);
      if (!live || !liveTouch) {
        // a phone that could take live touch but can't right now says why (a fallback); one that never does, doesn't
        ng.reason = this.backend.liveTouchWhy?.(udid) ?? undefined;
        return Promise.resolve({ via: 'buffered', reason: ng.reason ?? 'no live touch on this phone: the gesture plays on "up"' });
      }
      const press = async () => {
        const r = await liveTouch(udid, 'down', x, y);
        ng.downAt = performance.now();
        ng.reportAt = Date.now();
        return r;
      };
      return this.run(udid, 'touch-down', tRecv, press, { discrete: true, must: true, live: true }).catch((err): Result => {
        // nothing reached the phone: the rest is buffered and "up" plays the whole gesture by the other route
        ng.liveFailed = true;
        ng.reason = `live touch failed (${(err as Error)?.message ?? 'unknown'}): the gesture plays on "up"`;
        if (!ng.ended && this.touches.get(udid) === ng) this.arm(udid, ng);
        return { via: 'buffered', reason: ng.reason };
      });
    }

    // a move or up whose touch is gone (lifted by the server, replaced, or late on the unordered channel)
    if (!g || (tid !== null && g.tid !== null && tid !== g.tid)) return Promise.resolve({ via: 'buffered', stray: true });
    // the touch goes on, maybe over another link than its down came by (its first sender closed): that one owns it now
    g.eventAt = g.heardAt = now;
    if (owner && g.owner !== owner) g.owner = owner;
    if (g.owner) g.orphanAt = undefined;
    if (phase === 'move' && seq !== null) {
      if (seq <= g.seq) {
        this.meter.coalesced(udid);
        return Promise.resolve({ via: g.live && !g.liveFailed ? 'hid' : 'buffered', coalesced: true }); // older than one already applied
      }
      g.seq = seq;
    }
    const [x, y] = this.point(udid, msg, rx, ry, parseUnit(msg.unit) ?? g.unit);
    const last = g.pts[g.pts.length - 1]!;
    const t = Math.max(last[2], Math.min(given ?? now - g.t0, MAX_GESTURE_MS));

    if (phase === 'move') {
      this.arm(udid, g);
      if (g.pts.length < MAX_POINTS) g.pts.push([x, y, t]);
      if (!g.live || g.liveFailed || !liveTouch) return Promise.resolve({ via: 'buffered', ...(g.reason ? { reason: g.reason } : {}) });
      g.next = [x, y];
      if (g.moving) {
        // the phone is behind: this point replaces the one waiting, and is acked when that one is injected
        this.meter.coalesced(udid);
        return g.moving.then((r) => ({ ...(r ?? { via: 'hid' as InputVia }), coalesced: true }));
      }
      const p: Promise<Result> = this.run(udid, 'touch-move', tRecv, async () => {
        if (g.moving === p) g.moving = undefined;
        if (g.liveFailed) return { via: 'buffered' as InputVia, reason: g.reason }; // its down never reached the phone
        const [mx, my] = g.next!;
        g.reportAt = Date.now();
        return liveTouch(udid, 'move', mx, my);
      }, { live: true }).catch((err): Result => {
        if (g.moving === p) g.moving = undefined;
        // the finger was down and the channel broke: lift it and say so (replaying would play the drag twice)
        this.lose(udid, g, (err as Error)?.message ?? 'unknown');
        throw new HttpError(502, `the live touch was lost mid-drag (${(err as Error)?.message ?? 'unknown'}); the finger was lifted`);
      });
      g.moving = p;
      return p;
    }

    this.disarm(g);
    if (this.touches.get(udid) === g) this.touches.delete(udid);
    g.ended = true;
    g.pts.push([x, y, t]);
    if (g.live && !g.liveFailed && liveTouch) {
      let played = false;
      return this.run(udid, 'touch-up', tRecv, async () => {
        if (g.liveFailed) {
          // its down (queued ahead of this) never reached the phone: play the whole gesture by the other route, here
          played = true;
          const r = await this.play(udid, g);
          return r ? { ...r, reason: g.reason } : r;
        }
        const held = g.downAt === undefined ? Infinity : performance.now() - g.downAt;
        if (held < MIN_CONTACT_MS) await sleep(MIN_CONTACT_MS - held);
        return liveTouch(udid, 'up', x, y);
      }, { must: true, live: true }).catch((err) => {
        if (played) throw err;
        throw new HttpError(502, `the live touch's lift failed (${(err as Error)?.message ?? 'unknown'}); the phone lifts it as its touch session closes`);
      });
    }
    return this.finish(udid, g, tRecv);
  }

  /**
   * The touch's watch, from its down to its end. A live one (a finger down on the phone) is lifted when its sender's
   * link has died (no event of the touch and nothing from its sender for `releaseMs`), when its sender is alive but
   * silent about it for `quietMs`, or when its sender closed and nobody carried it on within `ownerGraceMs`; while it
   * is held still its contact is said again to the phone every `holdRepeatMs`. A buffered one (nothing on the phone
   * yet) is only forgotten, after STALE_TOUCH_MS, or dropped once its sender closed.
   */
  private arm(udid: string, g: Touch): void {
    if (g.timer) return;
    const every = Math.max(10, Math.min(250, this.releaseMs / 4, this.holdRepeatMs > 0 ? this.holdRepeatMs / 4 : 250, this.ownerGraceMs > 0 ? this.ownerGraceMs / 4 : 250));
    g.timer = setInterval(() => this.watch(udid, g), every);
    g.timer.unref?.();
  }

  private watch(udid: string, g: Touch): void {
    if (g.ended || this.touches.get(udid) !== g) return this.disarm(g);
    const now = Date.now();
    const live = g.live && !g.liveFailed;
    if (g.orphanAt !== undefined && now - g.orphanAt >= this.ownerGraceMs) return this.end(udid, g, 'closed');
    if (!live) {
      // nothing is down on the phone (it plays whole on "up", or is dropped when its sender closed): as before the fork
      if (now - g.eventAt >= STALE_TOUCH_MS) this.end(udid, g, 'stale');
      return;
    }
    if (now - Math.max(g.eventAt, g.heardAt) >= this.releaseMs || now - g.eventAt >= this.quietMs) return this.end(udid, g, 'timeout');
    // held still: the contact is said again where it is (in the live lane, behind any move on its way)
    const liveTouch = this.backend.liveTouch?.bind(this.backend);
    if (this.holdRepeatMs > 0 && liveTouch && g.downAt !== undefined && !g.moving && now - g.reportAt >= this.holdRepeatMs) {
      g.reportAt = now;
      const [x, y] = g.next ?? [g.pts[g.pts.length - 1]![0], g.pts[g.pts.length - 1]![1]];
      this.run(udid, 'touch-hold', null, async () => {
        if (g.ended || g.liveFailed) return;
        return liveTouch(udid, 'move', x, y);
      }, { live: true }).catch((err) => this.lose(udid, g, (err as Error)?.message ?? 'unknown'));
    }
  }

  private disarm(g: Touch): void {
    if (g.timer) clearInterval(g.timer);
    g.timer = undefined;
  }

  /** A live touch's channel broke mid-gesture: forget it, try to lift, tell its owner. */
  private lose(udid: string, g: Touch, error: string): void {
    if (g.ended) return;
    this.disarm(g);
    if (this.touches.get(udid) === g) this.touches.delete(udid);
    g.ended = true;
    const lift = this.backend.liveTouch?.bind(this.backend);
    const [x, y] = g.next ?? [g.pts[g.pts.length - 1]![0], g.pts[g.pts.length - 1]![1]];
    if (lift && this.backend.liveTouchReady?.(udid)) this.run(udid, 'touch-release', null, () => lift(udid, 'up', x, y), { must: true, silent: true, live: true }).catch(() => {});
    (g.owner as TouchOwner | undefined)?.touchReleased?.({ id: g.tid, reason: 'lost', error });
  }

  /**
   * End a touch that got no "up": timeout (a live one whose sender's link died: lifted, its owner told), replaced
   * (a new press: a live one is lifted, a buffered one played), closed (its sender closed and nobody carried it on: a
   * live one is lifted, a buffered one dropped) or stale (a buffered one never lifted: dropped).
   */
  private end(udid: string, g: Touch, why: 'timeout' | 'replaced' | 'closed' | 'stale'): void {
    this.disarm(g);
    if (this.touches.get(udid) === g) this.touches.delete(udid);
    if (g.ended) return;
    g.ended = true;
    if (g.live && !g.liveFailed && this.backend.liveTouch) {
      const [x, y] = g.next ?? [g.pts[g.pts.length - 1]![0], g.pts[g.pts.length - 1]![1]];
      const lift = this.backend.liveTouch.bind(this.backend);
      this.run(udid, 'touch-release', performance.now(), () => lift(udid, 'up', x, y), { must: true, silent: true, live: true }).catch(() => {});
      if (why === 'timeout') {
        this.meter.released(udid);
        (g.owner as TouchOwner | undefined)?.touchReleased?.({ id: g.tid, reason: 'timeout' });
      }
    } else if (why === 'replaced') {
      this.finish(udid, g, performance.now()).catch(() => {});
    }
  }

  /** Play a buffered touch as one action: a quick still one is a tap, else a gesture with every point and its timing. */
  private finish(udid: string, g: Touch, tRecv: number): Promise<Result> {
    this.disarm(g);
    if (this.touches.get(udid) === g) this.touches.delete(udid);
    g.ended = true;
    return this.run(udid, this.isTap(g) ? 'tap' : 'gesture', tRecv, () => this.play(udid, g), { discrete: true, must: true, reason: g.reason, timeoutMs: this.actionTimeoutMs + Math.max(0, g.pts[g.pts.length - 1]?.[2] ?? 0) });
  }

  private isTap(g: Touch): boolean {
    const [fx, fy] = g.pts[0]!;
    return g.pts.every(([x, y]) => Math.hypot(x - fx, y - fy) < STILL_PT) && g.pts[g.pts.length - 1]![2] < TAP_MS;
  }

  /** The buffered touch to the phone, now (the caller is in the phone's queue); its points are clamped already. */
  private play(udid: string, g: Touch): Promise<Result> {
    const pts = g.pts;
    const [fx, fy] = pts[0]!;
    if (this.isTap(g)) {
      // the owner's own tap: where it landed, held as long as it really was (natural touch on; exact: the route's own)
      const held = Math.round(pts[pts.length - 1]![2]);
      return this.natural({}) && held > 0 ? this.backend.tap(udid, fx, fy, Math.min(TAP_MS, Math.max(MIN_CONTACT_MS, held))) : this.backend.tap(udid, fx, fy);
    }
    if (pts.length === 1) pts.push([fx, fy, pts[0]![2]]);
    return this.backend.gesture(udid, pts);
  }
}
