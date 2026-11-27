import crypto from 'node:crypto';
import { Box, dragPath, flickMs, flickPath, Rng, seeded, LOTUS_SWIPE_STEP_MS, swipeMs, tapPlan } from './human.js';
import { FieldState, fieldValueOut, parseTypeRequest, TypeRequest, typeCheck } from './field.js';
import { InputMeter, InputResult, InputVia } from './inputlog.js';
import { ClipResult, cutText, isSelectAll, KeyStep, parseClipboard, parseKeyOps, pressCount } from './keys.js';
import { guessUnit, parseUnit, toPoints, Unit } from './orient.js';
import { Actors, actorsFor, deadlineOf, PhoneActor, Who, whoOf } from './phone/actor.js';
import { Backend, ButtonName, ControlState, HttpError, PathPoint } from './types.js';

/** 2026-11-18: time allowed for reading the focused field (twice per `type`) and for emptying it. */
const FIELD_READ_MS = 8000;
const FIELD_CLEAR_MS = 20000;
/** 2026-11-24: a copy or cut waits this long for the field's text (the owner's next keys wait behind it), and this long for the app to have cut it. */
const CLIP_READ_MS = 4000;
const CUT_SETTLE_MS = 150;
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
  /** A discrete action (tap, swipe, touch down, typing...): a phone observed locked or dark is woken first (its own turn). */
  discrete?: boolean;
  /** Never refused by a full queue (a touch's down and up, a lift). */
  must?: boolean;
  /** Not activity and never wakes (a lock). */
  silent?: boolean;
  /** 2026-11-21 (kept for callers): 2026-11-27, nothing is healed for any action any more (docs/root-cause.md G4). */
  noHeal?: boolean;
  /** Why a slower route took it, for the meter and the ack. */
  reason?: string;
  /** How long it may take before it counts as hung (ms; default the action timeout; Infinity: no limit). */
  timeoutMs?: number;
  /** Not input at all (a health check): not activity, not timed, no spacing, never marks the phone as acted on. */
  quiet?: boolean;
  /** The owner's live touch on the phone's live channel (HID): no breath between two of them. */
  live?: boolean;
  /** Who sent it (the lease: the owner pre-empts a hand). Default: the server's API. */
  who?: Who;
  /** The client's deadline (Date.now() ms): refused at once, busy, when it can't start by then. */
  deadlineAt?: number;
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
  /** An action that takes longer than this is answered with an error (ms; default ACTION_TIMEOUT_MS); nothing is healed for it. */
  actionTimeoutMs?: number;
  /** Kept for callers; 2026-11-27: no probe goes in front of an action any more (docs/root-cause.md section 8). */
  idleProbeMs?: number;
  /** The phones' actors (src/phone/actor.ts; default: the backend's, shared with the agent and the idle lock). */
  actors?: Actors;
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
/** An action hung longer than this (beyond its own length) is answered with a 504 (nothing is restarted for it). */
export const ACTION_TIMEOUT_MS = 20_000;
/** Kept for callers (2026-11-27: no probe before an action any more). */
export const IDLE_PROBE_MS = 30_000;
/** How long an action waits for the phone's wake (its own turn before it) before it goes anyway. */
const WAKE_WAIT_MS = 30_000;

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

/** Keyboard input's failure: what it held never reaches a log or an answer (anything not already said safely is a plain 502). */
async function quietly<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'the phone could not take the keys; look at the field before trying again');
  }
}

/** Why the field's text can't go to the PC; undefined when it can. */
function unreadable(f: FieldState | null): string | undefined {
  if (!f) return 'the focused field could not be read';
  if (!f.found) return 'no field has the keyboard';
  if (f.secure) return 'a password field is never read';
  if (typeof f.value !== 'string') return 'the focused field could not be read';
  return f.value ? undefined : 'the field is empty';
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
 * Validates and maps every phone action, and hands it to the phone's actor (src/phone/actor.ts) as an input job.
 * Coordinates come in normalized (0..1 of the upright picture), in the upright picture's pixels or in points, and
 * leave as upright points, clamped to the screen. The actor's one input line per phone keeps actions from HTTP, the
 * control WebSocket and the data channels in the order they arrived, never overlapping. 2026-11-27 (docs/root-cause.md
 * G4): nothing else happens inside an input's turn: no probe or heal of the phone's WDA, no look at its screen, no
 * wake (a phone observed locked or dark gets its wake as its own turn, right before the input). Live touch
 * (down/move/up) goes straight to the phone when it has a live channel (CoreDevice HID); otherwise it's buffered into
 * one gesture played on "up". Every action's receive -> injected time is measured (`meter`).
 */
export class Control {
  private touches = new Map<string, Touch>();
  private acted = new Map<string, number>(); // when each phone last had an action start, end or finish playing
  private turns = new Map<string, number>(); // how many actions each phone was given so far
  private selectedAll = new Map<string, number>(); // the turn of a Cmd+A: nothing came after it, so the whole field is selected
  private releaseMs: number;
  private quietMs: number;
  private holdRepeatMs: number;
  private ownerGraceMs: number;
  readonly meter: InputMeter;
  /**
   * Called for every input as it's received, before it's queued (src/idle.ts): marks activity; for a phone observed
   * locked or dark it returns the wake (queued in the phone's input line ahead of this input), else null.
   */
  onInput?: (udid: string, discrete: boolean, live?: boolean) => Promise<void> | null;
  /** Lock and wake (src/idle.ts), for `key: "lock"` and `wake`. */
  power?: { lock(udid: string): Promise<unknown>; wake(udid: string): Promise<unknown> };
  /** An app's name -> its bundle id (src/agent.ts), for `launch {name}`. */
  resolveApp?: (udid: string, name: string) => Promise<string>;
  /**
   * Kept for callers. 2026-11-27: never called from here any more: a phone's health is its control link's (its own
   * probes and the request journal), never a probe or a heal inside an action's turn (docs/root-cause.md 13.2).
   */
  onHeal?: (udid: string, reason: string) => Promise<unknown>;
  /** The phones' actors: the queue, the lease, the deadlines. */
  readonly actors: Actors;
  /** An action ran (or failed): what it may have changed (the app in front, the battery) is worth a fresh look. */
  onActed?: (udid: string) => void;
  private minGapMs: number;
  private actionTimeoutMs: number;
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
    this.actors = opts.actors ?? actorsFor(backend);
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

  /** The phone's actor. */
  actor(udid: string): PhoneActor {
    return this.actors.of(udid);
  }

  /** Actions waiting in (or running from) the phone's input line now. */
  pending(udid: string): number {
    return this.actors.of(udid).inputPending();
  }

  /**
   * A health check as background work of the phone's actor: skipped (false) when the phone has anything else on or
   * someone drives it (the actions themselves find out). 2026-11-27: input never waits for it (it's never in an
   * input's turn); it waits for input (the reservation).
   */
  async check(udid: string, fn: () => Promise<void>): Promise<boolean> {
    let ran = false;
    await this.actors.of(udid).submit({
      kind: 'look', label: 'health check', skipIfBusy: true, who: { server: 'watch' },
      run: async () => {
        ran = true;
        await fn();
      },
    });
    return ran;
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
   * 0..1 are normalized and anything else points. 2026-11-27: `who` (else from the message: `owner: true` or a touch
   * is the owner's, `hand: "<id>"` an agent's) is the lease it runs under, and `deadlineAt` (Date.now() ms) the
   * client's deadline: an action that can't start by then is refused at once, busy.
   */
  handle(udid: string, msg: Record<string, unknown>, owner?: object, who?: Who): Promise<Result> {
    const prev = this.ctx;
    this.ctx = { who: who ?? whoOf(msg), deadlineAt: deadlineOf(msg) };
    try {
      // its jobs are queued synchronously, inside this (the context is read as they're made)
      return this.route(udid, msg, owner);
    } finally {
      this.ctx = prev;
    }
  }

  /** Who sent the message being handled now, and its deadline (set by `handle` while it queues its jobs). */
  private ctx: { who: Who; deadlineAt: number | undefined } | null = null;

  private async route(udid: string, msg: Record<string, unknown>, owner?: object): Promise<Result> {
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
      case 'type':
      case 'clear': {
        // 2026-11-18: `clear` empties the focused field in one go first; the field is read back after the text
        const req = parseTypeRequest(msg);
        const reads = this.backend.field ? FIELD_READ_MS * 2 + (req.clear ? FIELD_CLEAR_MS : 0) : 0;
        return this.run(udid, msg.type === 'clear' ? 'clear' : 'type', tRecv, () => this.typeInto(udid, req), {
          discrete: true, timeoutMs: this.actionTimeoutMs + (req.text.length + 1) * 150 + reads,
        });
      }
      case 'keyboard':
        return this.keyboard(udid, msg, tRecv);
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

  /**
   * `type` and `clear` (2026-11-18, the phones typing contract): empty the field first when asked (in one go, never a
   * Delete per letter), type the text, read the field back for the `check` (before Return, so a form that's sent and
   * gone doesn't hide what was typed), then Return if asked. A backend that can't read fields just types.
   */
  private async typeInto(udid: string, req: TypeRequest): Promise<InputResult | void> {
    const b = this.backend;
    let cleared: FieldState | null = null;
    let before: FieldState | null = null;
    if (req.clear) {
      if (!b.field) throw new HttpError(501, 'this server cannot clear a field');
      cleared = await b.field(udid, { clear: true });
      // what's typed next must be all the field holds: checked against an empty field (a clear that left text fails)
      before = { found: true, secure: !!cleared?.secure, len: 0, value: '' };
    } else if (req.text && b.field) {
      before = await b.field(udid);
    }
    let r: InputResult | void = undefined;
    if (req.text) r = await b.type(udid, req.text);
    const after = !b.field ? null : req.text ? await b.field(udid) : cleared;
    if (req.enter) r = (await b.type(udid, '\n')) ?? r;
    if (!b.field) return r;
    const out: InputResult = { ...(r ?? { via: b.mock ? 'mock' : 'wda' }) };
    if (req.clear) {
      out.cleared = !!cleared && (cleared.cleared ?? (cleared.found && cleared.len === 0));
      if (cleared?.method) out.clear_method = cleared.method;
    }
    out.check = typeCheck(req.text, before, after);
    Object.assign(out, fieldValueOut(after));
    return out;
  }

  /**
   * 2026-11-24, the PC keyboard (POST /keyboard, or a `keyboard` message): `ops` in order, one turn in the phone's queue,
   * the owner's only. Nothing of what's typed is logged, kept or answered.
   */
  private async keyboard(udid: string, msg: Record<string, unknown>, tRecv: number): Promise<Result> {
    if (msg.owner !== true) throw new HttpError(400, 'the keyboard is the owner\'s: "owner" must be true');
    const steps = parseKeyOps(msg.ops);
    if (!steps.length) return undefined; // only characters no keyboard has
    const press = this.backend.keyboard?.bind(this.backend);
    if (!press) throw new HttpError(501, 'this server cannot press keys on this phone');
    const turn = this.turn(udid) + 1;
    const r = await this.run(udid, 'keyboard', tRecv, () => quietly(press(udid, steps)), { discrete: true, timeoutMs: this.keysMs(steps) });
    if (isSelectAll(steps[steps.length - 1])) this.selectedAll.set(udid, turn);
    return r;
  }

  /**
   * 2026-11-24, POST /clipboard (the owner's only). copy and cut press Cmd+C / Cmd+X on the phone; the phone's own
   * clipboard can't be read without bringing WebDriverAgent to the front (iOS gives a background app nothing), which
   * would take the owner's app away, so it's never tried. The text comes from the focused field instead, when it can
   * be read and isn't a secure one: a cut's is what went missing from it, a copy's is the whole field (`exact` when it
   * is all selected). paste types `text` into the field (a secure one too), or with none presses Cmd+V.
   */
  async clipboard(udid: string, body: Record<string, unknown>): Promise<{ clip: ClipResult; result: Result }> {
    const tRecv = performance.now();
    if (body.owner !== true) throw new HttpError(400, 'the clipboard is the owner\'s: "owner" must be true');
    const { action, text } = parseClipboard(body);
    const b = this.backend;
    const press = b.keyboard?.bind(b);
    if (!press) throw new HttpError(501, 'this server cannot press keys on this phone');
    const field = async (): Promise<FieldState | null> =>
      !b.field ? null : within(b.field(udid), CLIP_READ_MS, () => new Error('field')).catch(() => null);
    const chord = (key: string): KeyStep[] => [{ key, mods: ['cmd'], n: 1 }];
    let clip: ClipResult = { action, how: 'phone-only' };
    const turn = this.turn(udid) + 1;
    const whole = this.selectedAll.get(udid) === turn - 1;
    const fn = async (): Promise<Result> => {
      if (action === 'paste') {
        clip = { action, how: text !== null ? 'typed' : 'phone' };
        return text !== null ? press(udid, [{ text }], { paste: true }) : press(udid, chord('v'));
      }
      if (action === 'cut') {
        const before = await field();
        const r = await press(udid, chord('x'));
        clip.why = unreadable(before);
        if (clip.why) return r;
        await sleep(CUT_SETTLE_MS);
        const after = await field();
        if (!after?.found || after.secure || typeof after.value !== 'string') return (clip.why = 'the field could not be read after the cut', r);
        const cut = cutText(before!.value!, after.value);
        if (cut) clip = { action, how: 'field', text: cut.text, exact: cut.exact };
        else clip.why = before!.value === after.value ? 'nothing was cut: nothing is selected in the field' : 'the field changed in another way meanwhile';
        return r;
      }
      let r: Result = undefined;
      let refused: HttpError | null = null;
      try {
        r = await press(udid, chord('c'));
      } catch (err) {
        // this phone's build can't press it: the field's text can still go to the PC
        if (!(err instanceof HttpError) || err.status !== 501) throw err;
        refused = err;
      }
      const f = await field();
      clip.why = unreadable(f);
      if (!clip.why && f!.value) {
        clip = { action, how: 'field', text: f!.value, exact: whole, ...(whole ? {} : { why: 'the whole field: iOS does not say what is selected' }) };
      } else if (refused) throw refused;
      return r;
    };
    const result = await this.run(udid, action, tRecv, () => quietly(fn()), {
      discrete: true, who: { owner: true }, timeoutMs: this.keysMs(text !== null ? [{ text }] : []) + CLIP_READ_MS * 2 + CUT_SETTLE_MS,
    });
    if (action === 'copy' && whole) this.selectedAll.set(udid, turn);
    return { clip, result };
  }

  /** How many turns the phone's queue has given (asked for) so far. */
  private turn(udid: string): number {
    return this.turns.get(udid) ?? 0;
  }

  private keysMs(steps: readonly KeyStep[]): number {
    return this.actionTimeoutMs + pressCount(steps) * 150;
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
        }, { silent: true, noHeal: true });
      }
      default: {
        const press = this.backend.pressButton?.bind(this.backend);
        if (!press) throw new HttpError(501, 'this backend cannot press the volume buttons');
        return this.run(udid, `key-${key}`, tRecv, () => press(udid, key as ButtonName), { discrete: true });
      }
    }
  }

  /**
   * Recover the phone's WDA. Not in the phone's queue (2026-11-18): queued behind actions that each waited on a stuck
   * WDA it never got its turn; it only asks /status and the session (a restart only when WDA is dead), and joins a
   * restart under way.
   */
  recover(udid: string): Promise<ControlState> {
    return this.backend.recover(udid);
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
   * lift (no fling; natural: bowed and eased, src/human.ts dragPath). 2026-11-17: without `hold` it's a flick, one
   * whole path like phones_path's (flickPath: pressed, a move every step, at speed when it's lifted) over `ms`
   * (natural: ±8 %) or, without one, 150-300 ms by its length; natural adds a slight bow, exact is straight.
   * 2026-11-17, later: Lotus's swipes (anything not the owner's) step every LOTUS_SWIPE_STEP_MS (16 ms, phones_path's and
   * the page's proven spacing; the 8 ms flick moved nothing on either phone); the owner's wheel keeps its 8 ms.
   */
  private swipePoints(udid: string, msg: Record<string, unknown>, a: [number, number], b: [number, number]): PathPoint[] {
    const natural = this.natural(msg);
    const given = typeof msg.ms === 'number' && Number.isFinite(msg.ms) && msg.ms > 0;
    const hold = typeof msg.hold === 'number' && Number.isFinite(msg.hold) && msg.hold > 0 ? Math.min(msg.hold, 10000) : 0;
    const clamp = (x: number, y: number) => this.clamp(udid, x, y);
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const stepMs = msg.owner === true ? undefined : LOTUS_SWIPE_STEP_MS;
    if (!natural) {
      // 2026-11-17: a quick swipe is a whole path (a move every step, at speed at the lift), never one jump
      if (hold) return dragPath(a, b, hold, duration(msg.ms, 300, 10000), null, undefined, stepMs);
      return flickPath(a, b, given ? duration(msg.ms, 300, 10000) : flickMs(dist), null, { clamp, stepMs });
    }
    if (hold) {
      const ms = given ? Math.min(10000, Math.max(50, Math.round((msg.ms as number) * (0.92 + 0.16 * this.rng())))) : swipeMs(dist, this.rng);
      return dragPath(a, b, hold, ms, this.rng, clamp, stepMs);
    }
    const ms = given ? Math.min(10000, Math.max(50, Math.round((msg.ms as number) * (0.92 + 0.16 * this.rng())))) : flickMs(dist, this.rng);
    return flickPath(a, b, ms, this.rng, { clamp, stepMs });
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

  // ---- the phone's input line (src/phone/actor.ts) ----

  /** An input job in the phone's actor; with `tRecv`, its receive -> injected time is recorded. */
  private run(udid: string, type: string, tRecv: number | null, fn: () => Promise<Result>, opts: RunOptions = {}): Promise<Result> {
    const actor = this.actors.of(udid);
    if (!opts.quiet) this.turns.set(udid, this.turn(udid) + 1);
    const who = opts.who ?? this.ctx?.who ?? { server: 'api' };
    const deadlineAt = opts.deadlineAt ?? this.ctx?.deadlineAt;
    if ('owner' in who) actor.ownerInput(); // his lease from the moment it's received: a hand pauses now
    // Input is activity (idle lock). A phone observed locked or dark has its wake queued now, as the turn before this
    // one; nothing is looked at, probed or woken inside this input's own turn.
    if (!opts.silent && !opts.quiet) {
      const waking = this.onInput?.(udid, !!opts.discrete, !!opts.live);
      if (waking && opts.discrete) {
        void actor
          .submit({ kind: 'input', label: 'wake', must: true, who: { server: 'power' }, run: () => within(waking, WAKE_WAIT_MS, () => new Error('wake')).catch(() => {}) })
          .catch(() => {});
      }
    }
    let tStart = 0;
    const p = actor.submit<Result>({
      kind: 'input',
      label: type,
      who,
      must: opts.must,
      deadlineEpoch: deadlineAt,
      // bursts are spaced: a discrete action starts a breath after the last one ended
      gapMs: opts.discrete && !opts.live && !opts.quiet ? this.minGapMs : 0,
      timeoutMs: opts.quiet ? undefined : opts.timeoutMs ?? this.actionTimeoutMs,
      onTimeout: (ms) =>
        new HttpError(504, `${type} on the phone got no answer within ${Math.round(ms / 1000)} s; nothing was restarted for it; it may still happen, so look at the screen before trying again`),
      // An action answered when it was queued on the phone (HID's paths, the fast WDA route) is still playing there:
      // its sender has its answer, but the phone's next input waits until it's through, so a Home press or a tap by
      // another route never lands in the middle of a swipe. One that timed out is waited for a little longer too.
      holdAfter: (r) => (r && typeof r.play_ms === 'number' && r.play_ms > 0 ? Math.min(r.play_ms, MAX_GESTURE_MS) : 0),
      run: async () => {
        tStart = performance.now();
        if (!opts.quiet) this.acted.set(udid, tStart);
        try {
          let r = await fn();
          if (opts.reason && r && !r.reason) r = { ...r, reason: opts.reason };
          return r;
        } finally {
          if (!opts.quiet) this.acted.set(udid, performance.now());
          if (opts.discrete) this.onActed?.(udid);
        }
      },
    });
    return p.then(
      (r) => {
        if (tRecv !== null) this.record(udid, type, tRecv, tStart || performance.now(), r ? r.via : null, true, undefined, r ? r.reason : undefined);
        const play = r && typeof r.play_ms === 'number' && r.play_ms > 0 ? Math.min(r.play_ms, MAX_GESTURE_MS) : 0;
        if (play && !opts.quiet) setTimeout(() => void this.acted.set(udid, performance.now()), play).unref?.();
        return r;
      },
      (err) => {
        if (tRecv !== null) this.record(udid, type, tRecv, tStart || performance.now(), null, false, (err as Error)?.message);
        throw err;
      },
    );
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
