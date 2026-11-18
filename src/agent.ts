import { resolveApp } from './apps.js';
import { Control, touchAck } from './control.js';
import type { InputResult } from './inputlog.js';
import type { TypeCheck } from './field.js';
import type { Orientation } from './orient.js';
import { Backend, HttpError } from './types.js';
import { centerOf, describeQuery, ElementQuery, findElements, flattenUi, UiElement, UiTree } from './ui.js';

/**
 * The AI control API: what an agent needs to run a phone with nobody touching it. It reads the screen as a short
 * list of elements and strings (GET /ui), acts on elements by what they say (tap-element), and every action comes
 * back with what it did: `{ok, ms, changed, app, orientation, verified?, error?}`. `changed` compares a cheap hash of
 * the picture before and after (the UI tree's when the backend has no picture hash); `verify` waits for a condition
 * (a string or a label on screen, the foreground app) and says whether it came.
 */

/** 2026-11-17: a tree read this recently is given again (any action since makes it stale at once). Was 300 ms. */
export const UI_FRESH_MS = 1000;
/**
 * The settle after an action (2026-11-17, the owner: "make it fast even for simple task"): at least SETTLE_MIN_MS,
 * then as soon as the picture stops changing (two equal stills), at most SETTLE_MAX_MS; a launch at least
 * SETTLE_LAUNCH_MIN_MS and at most SETTLE_LAUNCH_MAX_MS. Was a fixed 350 ms (a launch 1000 ms) plus a separate look.
 * A backend without stills to compare waits SETTLE_MS.
 */
export const SETTLE_MS = 300;
export const SETTLE_MIN_MS = 100;
export const SETTLE_MAX_MS = 700;
export const SETTLE_LAUNCH_MIN_MS = 400;
export const SETTLE_LAUNCH_MAX_MS = 1600;
/**
 * Yielding to the owner (2026-11-17, the owner: "WHEN USER IS RANDOMLY TOUCHING WHILE UR WORKING PAUSE ALL UR
 * SEQUENCE UNTIL USER LEAVES THE TOUCHES FOR LIKE 5 sec"): the owner's own input on a phone (a message with
 * `owner: true`, or a live touch) pauses Lotus's actions on that phone until it has been quiet OWNER_QUIET_MS. A single
 * action waits at most OWNER_WAIT_MS (under the client's 60 s), a batch OWNER_BATCH_WAIT_MS (under its 300 s).
 */
export const OWNER_QUIET_MS = 5000;
export const OWNER_WAIT_MS = 45_000;
export const OWNER_BATCH_WAIT_MS = 120_000;
const OWNER_POLL_MS = 200;
/** The words a single action answers with when the screen it aimed at went away while the owner touched it. */
export const CHANGED_WHILE_TOUCHING = 'screen changed while you were touching';
/** Timing lines in the log (2026-11-17, to measure reads and actions); off in tests (INPUT_LOG=0). */
const timingLog = (line: string) => {
  if (process.env.INPUT_LOG !== '0' && process.env.AGENT_TIMING !== '0') console.log(`[timing] ${line}`);
};
const VERIFY_MS = 3000;
const VERIFY_MAX_MS = 20000;
const MAX_STEPS = 50;
const MAX_WAIT_MS = 15000;
/** Input this recent may still be changing the screen (a push, a sheet, an app opening). */
const TRANSITION_MS = 1500;
/** After recent input, an element that isn't there yet is waited for this long even when no `timeoutMs` was given. */
const GRACE_MS = 1000;
/** Waiting for the picture to stop changing: two looks this far apart that are the same, for at most STILL_MAX_MS. */
const STILL_STEP_MS = 150;
const STILL_MAX_MS = 900;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round1 = (v: number) => Math.round(v * 10) / 10;

export interface UiSnapshot extends UiTree {
  udid: string;
  orientation: Orientation | null;
  /** The foreground app's bundle id. */
  app: string | null;
  /** The upright screen in points and in pixels (elements are normalized: multiply by either). */
  point_width: number | null;
  point_height: number | null;
  width: number | null;
  height: number | null;
  count: number;
  /** How long the phone took to give the tree (ms); `cached` when this answer is a moment old. */
  ms: number;
  cached: boolean;
}

/** What every action answers. */
export interface ActionReport {
  ok: boolean;
  /** The server's receive -> injected time (ms); `total_ms` adds the look before, the settle and the look after. */
  ms: number;
  total_ms?: number;
  via?: string;
  /** Why a slower route took it. */
  reason?: string;
  /** The screen changed (null: it couldn't be told). */
  changed: boolean | null;
  app: string | null;
  orientation: Orientation | null;
  /** With `verify`: the condition came (true) or the wait ran out (false). */
  verified?: boolean;
  error?: string;
  /** 2026-11-17: how long it waited for the owner to stop touching the phone first. */
  paused?: { ms: number };
  /** 2026-11-17: where the time went (ms): the look before, the action, the settle (with the look after), the verify. */
  timing?: { look: number; act: number; settle: number; verify?: number };
  /** 2026-11-18, `type` and `clear`: the field read back (src/field.ts), its text when it isn't secure, the clear. */
  check?: TypeCheck;
  value?: string;
  cleared?: boolean;
  clear_method?: string;
}

export interface Verify {
  /** A visible string containing this (any case). */
  text?: string;
  /** An element with exactly this label (any case). */
  label?: string;
  /** The foreground app: a bundle id, or a name GET /apps knows. */
  app?: string;
  /** Wait for the text or label to be gone instead. */
  gone?: boolean;
  timeoutMs?: number;
}

export interface ActionOptions {
  verify?: unknown;
  /** How long the screen gets to react before the look after (ms; default: until it stops changing, see SETTLE_*). */
  settleMs?: unknown;
  /** The caller already waited for the owner (a batch between its steps, a tap-element before its look). */
  noYield?: boolean;
}

interface Look {
  kind: 'frame' | 'ui';
  hash: string;
}

const errorOf = (err: unknown): string => (err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err));
const lower = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function parseVerify(v: unknown): Verify | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: Verify = {};
  if (typeof o.text === 'string' && o.text.trim()) out.text = o.text;
  if (typeof o.label === 'string' && o.label.trim()) out.label = o.label;
  if (typeof o.app === 'string' && o.app.trim()) out.app = o.app.trim();
  if (o.gone === true || o.absent === true) out.gone = true;
  const t = o.timeoutMs ?? o.timeout_ms ?? o.timeout;
  if (typeof t === 'number' && Number.isFinite(t)) out.timeoutMs = Math.min(VERIFY_MAX_MS, Math.max(0, t));
  return out.text || out.label || out.app ? out : null;
}

function queryOf(o: Record<string, unknown>): ElementQuery {
  const s = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string) : undefined);
  const q: ElementQuery = { id: s('id') ?? s('element'), label: s('label'), name: s('name'), text: s('text'), type: s('elementType') };
  if (typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0) q.index = o.index;
  return q;
}

/** Whether an element still says what the caller read at its id (`label`, `name` or `text` given beside the `id`). */
function says(el: UiElement, q: ElementQuery): boolean {
  if (q.type && el.type.toLowerCase() !== q.type.replace(/^XCUIElementType/i, '').toLowerCase()) return false;
  if (q.label && lower(el.label) !== lower(q.label)) return false;
  if (q.name && lower(el.name) !== lower(q.name)) return false;
  if (q.text && ![el.label, el.value, el.name].some((f) => f !== null && lower(f).includes(lower(q.text)))) return false;
  return true;
}

export class Agent {
  private uiCache = new Map<string, { at: number; t0: number; p: Promise<UiSnapshot> }>();
  private lane = new Map<string, Promise<void>>();
  /** 2026-11-17: when the owner last gave a phone input (Date.now()), by udid. */
  private ownerAt = new Map<string, number>();
  /** 2026-11-17: phones on which an action of Lotus's is waiting for the owner now: since when (Date.now()). */
  private pausedSince = new Map<string, number>();
  /** A read saw the app in front (the server keeps the phone's card up to date with it). */
  onApp?: (udid: string, bundleId: string) => void;

  /** A reported action or batch (an agent's) is running or waiting on the phone now. */
  busy(udid: string): boolean {
    return this.lane.has(udid);
  }

  /** OWNER_QUIET_MS and the waits' caps (tests make them short). */
  private quietMs: number;
  private waitOneMs: number;
  private waitBatchMs: number;

  constructor(private backend: Backend, private control: Control, opts: { ownerQuietMs?: number; ownerWaitMs?: number; ownerBatchWaitMs?: number } = {}) {
    this.quietMs = opts.ownerQuietMs ?? OWNER_QUIET_MS;
    this.waitOneMs = opts.ownerWaitMs ?? OWNER_WAIT_MS;
    this.waitBatchMs = opts.ownerBatchWaitMs ?? OWNER_BATCH_WAIT_MS;
    control.resolveApp = (udid, name) => this.bundleId(udid, name);
  }

  /**
   * One reported action at a time per phone, in arrival order: a reported action looks at the screen before it enters
   * the phone's queue, so without this a tap-element sent right behind a launch would read the screen the launch is
   * about to replace. Live touches never wait here.
   */
  inOrder<T>(udid: string, fn: () => Promise<T>): Promise<T> {
    const p = (this.lane.get(udid) ?? Promise.resolve()).then(fn);
    const done = p.then(() => {}, () => {});
    this.lane.set(udid, done);
    void done.then(() => {
      if (this.lane.get(udid) === done) this.lane.delete(udid);
    });
    return p;
  }

  // ---- the owner's input (2026-11-17) ----

  /** The owner gave this phone input now (a touch, a swipe, a key from the page). */
  ownerInput(udid: string): void {
    this.ownerAt.set(udid, Date.now());
  }

  /** How long ago the owner last gave this phone input (ms); Infinity when never. */
  ownerQuiet(udid: string): number {
    const at = this.ownerAt.get(udid);
    return at === undefined ? Infinity : Date.now() - at;
  }

  /** The owner touched this phone in the last OWNER_QUIET_MS. */
  ownerActive(udid: string): boolean {
    return this.ownerQuiet(udid) < this.quietMs;
  }

  /** For GET /phones/:udid/owner and the phone's list entry: `{ activeMs, paused, pausedMs }`. */
  ownerState(udid: string): { active: boolean; quietMs: number | null; paused: boolean; pausedMs: number | null } {
    const q = this.ownerQuiet(udid);
    const since = this.pausedSince.get(udid);
    return { active: q < this.quietMs, quietMs: Number.isFinite(q) ? q : null, paused: since !== undefined, pausedMs: since !== undefined ? Date.now() - since : null };
  }

  /**
   * Wait while the owner is touching this phone: until OWNER_QUIET_MS without input, at most `maxMs`. Null when he
   * wasn't touching it (nothing waited); else how long it waited and whether he stopped (`resumed`).
   */
  async yieldToOwner(udid: string, maxMs: number): Promise<{ ms: number; resumed: boolean } | null> {
    if (!this.ownerActive(udid)) return null;
    const t0 = Date.now();
    this.pausedSince.set(udid, t0);
    try {
      while (this.ownerActive(udid)) {
        if (Date.now() - t0 >= maxMs) return { ms: Date.now() - t0, resumed: false };
        await sleep(Math.max(5, Math.min(OWNER_POLL_MS, this.quietMs - this.ownerQuiet(udid) + 5)));
      }
      return { ms: Date.now() - t0, resumed: true };
    } finally {
      if (this.pausedSince.get(udid) === t0) this.pausedSince.delete(udid);
    }
  }

  /** A single action waits for the owner; still touching after OWNER_WAIT_MS: refused (409). */
  private async yieldOne(udid: string): Promise<{ ms: number } | null> {
    const p = await this.yieldToOwner(udid, this.waitOneMs);
    if (p && !p.resumed) throw new HttpError(409, `the owner is still using the phone (touching it for ${Math.round(p.ms / 1000)} s): try again when he stops`);
    return p ? { ms: p.ms } : null;
  }

  // ---- reading ----

  /**
   * GET /ui: the screen as elements and strings; an answer under 300 ms old is given again (`fresh` asks anew), but
   * never one read before the phone's last input: that may be the screen the input replaced. `settle` waits for the
   * picture to stop changing first (a transition to end).
   */
  ui(udid: string, opts: { all?: boolean; max?: number; fresh?: boolean; settle?: boolean } = {}): Promise<UiSnapshot> {
    const key = `${udid}|${opts.all ? 'all' : 'seen'}|${opts.max ?? ''}`;
    const kept = this.uiCache.get(key);
    const current = !!kept && kept.t0 >= this.control.lastAction(udid);
    if (kept && current && !opts.fresh && !opts.settle && (kept.at === 0 || Date.now() - kept.at < UI_FRESH_MS)) {
      return kept.p.then((s) => (kept.at === 0 ? s : { ...s, cached: true }));
    }
    // at 0 = still on its way: everyone asking meanwhile shares it
    const entry = { at: 0, t0: performance.now(), p: opts.settle ? this.still(udid).then(() => this.snapshot(udid, opts)) : this.snapshot(udid, opts) };
    this.uiCache.set(key, entry);
    entry.p.then(
      () => {
        entry.at = Date.now();
      },
      () => {
        if (this.uiCache.get(key) === entry) this.uiCache.delete(key);
      },
    );
    if (this.uiCache.size > 64) {
      for (const [k, v] of this.uiCache) if (v.at && Date.now() - v.at > UI_FRESH_MS) this.uiCache.delete(k);
    }
    return entry.p;
  }

  private async snapshot(udid: string, opts: { all?: boolean; max?: number }): Promise<UiSnapshot> {
    const source = this.backend.uiSource?.bind(this.backend);
    if (!source) throw new HttpError(501, 'this backend cannot read the UI');
    const t0 = performance.now();
    const read = () =>
      Promise.all([
        source(udid),
        this.app(udid),
        this.backend.refreshOrientation?.(udid, 500).catch(() => null), // the tree's rectangles are upright: so must the screen be
      ]);
    let [tree, app] = await read();
    // the phone had input while the tree was being read (a big screen takes a second): the tree may show either side
    // of it, so it's read once more
    if (this.control.lastAction(udid) > t0) [tree, app] = await read();
    const s = this.backend.screen(udid);
    const flat = flattenUi(tree, s, opts);
    timingLog(`${udid.slice(-8)} ui: ${flat.elements.length} elements in ${round1(performance.now() - t0)} ms`);
    const px = (v: number | undefined) => (s?.scale && v ? Math.round(v * s.scale) : null);
    return {
      udid, orientation: this.backend.orientation?.(udid) ?? null, app,
      point_width: s?.width ?? null, point_height: s?.height ?? null, width: px(s?.width), height: px(s?.height),
      count: flat.elements.length, ...flat, ms: round1(performance.now() - t0), cached: false,
    };
  }

  private async app(udid: string): Promise<string | null> {
    try {
      const app = (await this.backend.activeApp?.(udid)) ?? null;
      if (app) this.onApp?.(udid, app);
      return app;
    } catch {
      return null;
    }
  }

  /** GET /apps. */
  async apps(udid: string) {
    if (!this.backend.apps) throw new HttpError(501, 'this backend cannot list apps');
    return this.backend.apps(udid);
  }

  /** An app's bundle id from its name (or a bundle id as it is). */
  async bundleId(udid: string, name: string): Promise<string> {
    return resolveApp(await this.apps(udid), name);
  }

  // ---- acting ----

  /** A cheap look at the screen: the picture's hash, else (a backend without one) the UI tree's. */
  private async look(udid: string): Promise<Look | null> {
    if (this.backend.frameHash) {
      const h = await this.backend.frameHash(udid).catch(() => null);
      return h ? { kind: 'frame', hash: h } : null;
    }
    if (!this.backend.uiSource) return null;
    try {
      return { kind: 'ui', hash: (await this.ui(udid, { fresh: true })).hash };
    } catch {
      return null;
    }
  }

  /**
   * Wait for the picture to stop changing: two looks STILL_STEP_MS apart that are the same, for at most `maxMs`
   * (a video never stops). True when it's still; false when it kept moving or the backend has no picture to compare.
   */
  async still(udid: string, maxMs = STILL_MAX_MS): Promise<boolean> {
    const hash = this.backend.frameHash?.bind(this.backend);
    if (!hash) return false;
    const until = performance.now() + maxMs;
    let prev = await hash(udid).catch(() => null);
    while (prev !== null) {
      await sleep(STILL_STEP_MS);
      const now = await hash(udid).catch(() => null);
      if (now === prev) return true;
      if (performance.now() >= until) break;
      prev = now;
    }
    return false;
  }

  /**
   * One action (a control message: tap, swipe, path, hold, type, key, home, launch, wake) through the phone's queue,
   * with a look before and after. Throws what the action throws (bad input, WDA down...); a failed `verify` doesn't
   * throw: `verified: false` with why in `error`.
   */
  async action(udid: string, msg: Record<string, unknown>, opts: ActionOptions = {}, owner?: object): Promise<ActionReport> {
    // 2026-11-17: Lotus's action waits while the owner is touching this phone (the owner's own never does)
    const paused = msg.owner === true || opts.noYield ? null : await this.yieldOne(udid);
    const t0 = performance.now();
    const verify = parseVerify(opts.verify ?? msg.verify);
    const before = await this.look(udid);
    const tAct = performance.now();
    const since = Date.now();
    const r = (await this.control.handle(udid, msg, owner)) as InputResult | void;
    const ms = round1(performance.now() - tAct);
    // a gesture answered when it was queued is still playing on the phone: the look after comes after it
    const play = r && typeof r.play_ms === 'number' && r.play_ms > 0 ? Math.min(r.play_ms, 60_000) : 0;
    if (play > 0) await sleep(play);
    const tSettle = performance.now();
    const after = await this.settleLook(udid, msg, opts.settleMs ?? msg.settleMs, !!before);
    const broke = this.backend.playFailure?.(udid, since);
    if (broke) throw new HttpError(502, `${broke}; look at the screen before trying again`);
    const tVerify = performance.now();
    const v = verify ? await this.verify(udid, verify) : null;
    const timing = { look: round1(tAct - t0), act: round1(ms + play), settle: round1(tVerify - tSettle), ...(v ? { verify: round1(performance.now() - tVerify) } : {}) };
    const total = round1(performance.now() - t0);
    timingLog(`${udid.slice(-8)} ${String(msg.type)}: look ${timing.look} · act ${timing.act} · settle ${timing.settle}${v ? ` · verify ${timing.verify}` : ''} · total ${total} ms${paused ? ` (waited ${paused.ms} ms for the owner)` : ''}`);
    return {
      ok: true, ms, total_ms: total,
      ...(r ? { via: r.via, ...(r.reason ? { reason: r.reason } : {}) } : {}),
      ...typeExtra(r),
      changed: before && after && before.kind === after.kind ? before.hash !== after.hash : null,
      app: v?.app !== undefined ? v.app : await this.app(udid),
      orientation: this.backend.orientation?.(udid) ?? null,
      ...(v ? { verified: v.verified, ...(v.error ? { error: v.error } : {}) } : {}),
      ...(paused ? { paused } : {}),
      timing,
    };
  }

  /**
   * 2026-11-17: the settle after an action and the look after it, together: a given `settleMs` is waited as it is;
   * else at least SETTLE_MIN_MS (a launch SETTLE_LAUNCH_MIN_MS), then until two stills in a row are the same (at
   * most SETTLE_MAX_MS, a launch SETTLE_LAUNCH_MAX_MS), and the last still is the look after. A backend without
   * stills waits SETTLE_MS (a launch SETTLE_LAUNCH_MIN_MS) and looks.
   */
  private async settleLook(udid: string, msg: Record<string, unknown>, asked: unknown, look: boolean): Promise<Look | null> {
    const launch = msg.type === 'launch';
    if (typeof asked === 'number' && Number.isFinite(asked)) {
      await sleep(Math.min(5000, Math.max(0, asked)));
      return look ? this.look(udid) : null;
    }
    await sleep(launch ? SETTLE_LAUNCH_MIN_MS : SETTLE_MIN_MS);
    if (this.backend.frameHash) {
      const h = await this.stillHash(udid, (launch ? SETTLE_LAUNCH_MAX_MS : SETTLE_MAX_MS) - (launch ? SETTLE_LAUNCH_MIN_MS : SETTLE_MIN_MS));
      return h ? { kind: 'frame', hash: h } : null;
    }
    await sleep(Math.max(0, SETTLE_MS - SETTLE_MIN_MS));
    return look ? this.look(udid) : null;
  }

  /** Like `still`, but says the last still's hash (null: no still came). */
  private async stillHash(udid: string, maxMs: number): Promise<string | null> {
    const hash = this.backend.frameHash!.bind(this.backend);
    const until = performance.now() + maxMs;
    let t = performance.now();
    let prev = await hash(udid).catch(() => null);
    while (prev !== null && performance.now() < until) {
      // two stills STILL_STEP_MS apart: a still that took that long already is the gap
      await sleep(Math.max(0, STILL_STEP_MS - (performance.now() - t)));
      t = performance.now();
      const now = await hash(udid).catch(() => null);
      if (now === null || now === prev) return now ?? prev;
      prev = now;
    }
    return prev;
  }

  /** Wait for a condition: every given part must hold (`gone`: the text and label must be absent). */
  async verify(udid: string, v: Verify): Promise<{ verified: boolean; app?: string | null; error?: string }> {
    const until = Date.now() + (v.timeoutMs ?? VERIFY_MS);
    let wantApp: string | null = null;
    if (v.app) {
      try {
        wantApp = (await this.bundleId(udid, v.app)).toLowerCase();
      } catch {
        wantApp = v.app.toLowerCase();
      }
    }
    let app: string | null | undefined;
    let why = '';
    for (;;) {
      const missing: string[] = [];
      if (wantApp) {
        app = await this.app(udid);
        if ((app ?? '').toLowerCase() !== wantApp) missing.push(`the foreground app is ${app ?? 'unknown'}, not ${v.app}`);
      }
      if ((v.text || v.label) && !missing.length) {
        try {
          const snap = await this.ui(udid, { fresh: true });
          if (app === undefined) app = snap.app;
          if (v.text) {
            const w = lower(v.text);
            const has = snap.lines.some((l) => lower(l).includes(w)) || snap.elements.some((e) => e.visible && [e.label, e.value, e.name].some((f) => lower(f).includes(w)));
            if (has === !!v.gone) missing.push(v.gone ? `${JSON.stringify(v.text)} is still on screen` : `no ${JSON.stringify(v.text)} on screen`);
          }
          if (v.label) {
            const w = lower(v.label);
            const has = snap.elements.some((e) => e.visible && lower(e.label) === w);
            if (has === !!v.gone) missing.push(v.gone ? `the element labelled ${JSON.stringify(v.label)} is still there` : `no element labelled ${JSON.stringify(v.label)}`);
          }
        } catch (err) {
          missing.push(`the UI couldn't be read (${errorOf(err)})`);
        }
      }
      if (!missing.length) return { verified: true, ...(app !== undefined ? { app } : {}) };
      why = missing.join('; ');
      const left = until - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(left, v.text || v.label ? 350 : 200));
    }
    return { verified: false, ...(app !== undefined ? { app } : {}), error: `verify: ${why} (waited ${v.timeoutMs ?? VERIFY_MS} ms)` };
  }

  /**
   * POST /tap-element `{id | label | name | text, index?, timeoutMs?, verify?}`: find the element on the screen as it
   * is now (waiting up to `timeoutMs` for it to appear) and tap its middle.
   */
  async tapElement(udid: string, body: Record<string, unknown>, owner?: object): Promise<ActionReport & { element: UiElement; matches: number; moved?: boolean }> {
    const q = queryOf(body);
    if (!q.id && !q.label && !q.name && !q.text) throw new HttpError(400, 'say which element: "id" (from GET /ui), "label", "name" or "text"');
    // 2026-11-17: waits while the owner is touching the phone, then looks at the screen as it is now
    const paused = body.noYield === true ? null : await this.yieldOne(udid);
    // The phone just had input: the screen may still be arriving (a push, a sheet sliding in, an app opening). An
    // element read mid-way is tapped where it was, not where it ends up, so the picture is waited for to stop moving
    // first, and an element that isn't there yet gets a moment to appear even when no `timeoutMs` was given.
    const recent = performance.now() - this.control.lastAction(udid) < TRANSITION_MS;
    const asked = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs);
    const wait = asked ? Math.min(MAX_WAIT_MS, Math.max(0, body.timeoutMs as number)) : recent ? GRACE_MS : 0;
    if (recent && body.settle !== false) await this.still(udid);
    const until = Date.now() + wait;
    let found: UiElement[] = [];
    let snap: UiSnapshot;
    for (let first = true; ; first = false) {
      // an id can name any node, a container too; and after the first look only a new one can show something else
      snap = await this.ui(udid, { all: !!q.id, fresh: !first || !!paused }); // after the owner's touches: read anew
      found = findElements(snap.elements, q);
      if (found.length > (q.index ?? 0) || Date.now() >= until) break;
      await sleep(Math.min(300, Math.max(0, until - Date.now())));
    }
    const i = q.index ?? 0;
    if (!found.length && !paused) {
      // 2026-11-18: the list holds only what's on the screen; one that's there but off it (its middle beyond the
      // edge) is said so, rather than "no element"
      const off = await this.ui(udid, { all: true }).then((all) => findElements(all.elements, q)[0], () => undefined);
      if (off) {
        const cx = off.x + off.w / 2;
        const cy = off.y + off.h / 2;
        if (!(off.w > 0) || !(off.h > 0) || cx < 0 || cx > 1 || cy < 0 || cy > 1) {
          throw new HttpError(409, `${off.type} ${JSON.stringify(off.label ?? off.name ?? off.id)} is off the screen (its middle is at ${cx.toFixed(2)}, ${cy.toFixed(2)}): scroll it into view first`);
        }
      }
    }
    if (!found.length) {
      const says = snap.text.replace(/\n/g, ' | ').slice(0, 240);
      // the owner's touches moved the screen away from what Lotus read: said so, for a fresh read and a new plan
      if (paused) throw new HttpError(409, `${CHANGED_WHILE_TOUCHING}: no element matches ${describeQuery(q)} now${says ? `; the screen says: ${says}` : ''}`);
      throw new HttpError(404, `no element matches ${describeQuery(q)}${says ? `; the screen says: ${says}` : ' (the screen has no readable text)'}`);
    }
    if (i >= found.length) throw new HttpError(404, `only ${found.length} element(s) match ${describeQuery({ ...q, index: undefined })}, so there is no index ${i}`);
    let el = found[i]!;
    let moved = false;
    if (q.id && (q.label || q.name || q.text) && !says(el, q)) {
      // An id is a place in the tree: after the screen changed, another element sits there. The caller also said what
      // it read at that id, so the element that says it now is the one meant (wherever it is), else nothing is tapped.
      const now = findElements(snap.elements, { ...q, id: undefined });
      const again = now[q.index ?? 0] ?? now[0];
      if (!again) {
        throw new HttpError(409, `the screen changed since it was read: ${q.id} is now ${el.type} ${JSON.stringify(el.label ?? el.name ?? el.value ?? '')}, not ${describeQuery({ ...q, id: undefined })}; read the screen again`);
      }
      el = again;
      moved = true;
    }
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    if (!(el.w > 0) || !(el.h > 0) || cx < 0 || cx > 1 || cy < 0 || cy > 1) {
      // its middle would be clamped to the screen's edge, and something else pressed there
      throw new HttpError(409, `${el.type} ${JSON.stringify(el.label ?? el.name ?? el.id)} is off the screen (its middle is at ${cx.toFixed(2)}, ${cy.toFixed(2)}): scroll it into view first`);
    }
    const [x, y] = centerOf(el);
    // its box goes along: a natural tap lands a little off the middle, never outside the element
    const tap: Record<string, unknown> = { type: 'tap', x, y, unit: 'norm', bounds: [el.x, el.y, el.w, el.h] };
    if (body.natural === false) tap.natural = false;
    const report = await this.action(udid, tap, { verify: body.verify, settleMs: body.settleMs, noYield: true }, owner);
    return { ...report, element: el, matches: found.length, ...(moved ? { moved } : {}), ...(paused ? { paused } : {}) };
  }

  /**
   * POST /act `{steps: [...], verify?, continueOnError?}`: steps run in order, each `{type, ...}` as its own endpoint
   * takes it (tap, tap-element, swipe, path, hold, type, key, home, launch, wake, lock) plus `{type: "wait", ms}` or
   * `{type: "wait", text | label | app, timeoutMs}`; a step may carry its own `verify`. It stops at the first step
   * that fails (or whose verify doesn't come) unless `continueOnError`. `ok` = every step went and every verify came.
   */
  async batch(udid: string, body: Record<string, unknown>): Promise<ActionReport & { steps: Record<string, unknown>[]; done: number; failedAt?: number; paused?: { ms: number; resumed: boolean }; remaining?: Record<string, unknown>[] }> {
    const steps = body.steps;
    if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) throw new HttpError(400, `"steps" must be an array of 1 to ${MAX_STEPS} actions`);
    for (const [i, s] of steps.entries()) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new HttpError(400, `steps[${i}] must be an object like {"type": "tap", "x": 0.5, "y": 0.5}`);
    }
    const t0 = performance.now();
    const before = await this.look(udid);
    const out: Record<string, unknown>[] = [];
    let ok = true;
    let failedAt: number | undefined;
    let error: string | undefined;
    for (const [i, raw] of (steps as Record<string, unknown>[]).entries()) {
      // 2026-11-17: the owner is touching this phone: the batch stops before this step, waits until he has left it
      // OWNER_QUIET_MS, and hands back what's done and what's left (never replayed blindly on a screen he changed)
      if (this.ownerActive(udid)) {
        const p = (await this.yieldToOwner(udid, this.waitBatchMs)) ?? { ms: 0, resumed: true };
        const remaining = (steps as Record<string, unknown>[]).slice(i);
        timingLog(`${udid.slice(-8)} batch paused for the owner before step ${i} (${p.ms} ms, ${remaining.length} left)`);
        return {
          ok: true, ms: round1(performance.now() - t0), changed: out.some((s) => s.changed === true) ? true : null,
          app: await this.app(udid), orientation: this.backend.orientation?.(udid) ?? null,
          steps: out, done: out.filter((s) => s.ok).length, paused: p, remaining,
        };
      }
      const type = String(raw.type ?? raw.action ?? raw.do ?? '').replace(/[_ ]/g, '-').toLowerCase();
      const step: Record<string, unknown> = { ...raw, type };
      let rep: Record<string, unknown>;
      const ts = performance.now();
      try {
        if (type === 'wait' || type === 'sleep') {
          const v = parseVerify(raw);
          if (v) {
            const r = await this.verify(udid, v);
            rep = { ok: r.verified, verified: r.verified, ...(r.error ? { error: r.error } : {}) };
          } else {
            const ms = typeof raw.ms === 'number' && Number.isFinite(raw.ms) ? Math.min(MAX_WAIT_MS, Math.max(0, raw.ms)) : 500;
            await sleep(ms);
            rep = { ok: true };
          }
          rep.ms = round1(performance.now() - ts);
        } else if (type === 'tap-element' || type === 'tapelement' || (type === 'tap' && typeof raw.x !== 'number')) {
          const r = await this.tapElement(udid, { ...raw, noYield: true });
          rep = { ...r, element: r.element.id, label: r.element.label };
        } else if (type === 'lock') {
          rep = { ...(await this.action(udid, { type: 'key', key: 'lock' }, { verify: raw.verify, settleMs: raw.settleMs, noYield: true })) };
        } else {
          rep = { ...(await this.action(udid, step, { verify: raw.verify, settleMs: raw.settleMs, noYield: true })) };
        }
      } catch (err) {
        rep = { ok: false, ms: round1(performance.now() - ts), error: errorOf(err) };
      }
      const good = rep.ok === true && rep.verified !== false;
      out.push({ i, type: type || null, ...rep, ok: good });
      if (!good) {
        ok = false;
        failedAt ??= i;
        error ??= `step ${i} (${type || 'no type'}): ${String(rep.error ?? 'failed')}`;
        if (body.continueOnError !== true) break;
      }
    }
    const verify = ok ? parseVerify(body.verify) : null;
    const v = verify ? await this.verify(udid, verify) : null;
    if (v && !v.verified) {
      ok = false;
      error ??= v.error;
    }
    const after = before ? await this.look(udid) : null;
    timingLog(`${udid.slice(-8)} batch of ${steps.length}: ${out.map((s) => `${String(s.type)} ${String(s.ms ?? '?')}`).join(' · ')} · total ${round1(performance.now() - t0)} ms`);
    return {
      ok, ms: round1(performance.now() - t0),
      changed: before && after && before.kind === after.kind ? before.hash !== after.hash : out.some((s) => s.changed === true) ? true : null,
      app: v?.app !== undefined ? v.app : await this.app(udid),
      orientation: this.backend.orientation?.(udid) ?? null,
      ...(v ? { verified: v.verified } : {}),
      ...(error ? { error } : {}),
      steps: out, done: out.filter((s) => s.ok).length, ...(failedAt !== undefined ? { failedAt } : {}),
    };
  }

  // ---- the control socket and the data channels ----

  /**
   * One message from a control socket or a data channel -> its answer (null: none). Never rejects. A touch with
   * `seq` answers `{ack: seq, ok, ms, ...}`; anything with an `id` answers `{type: "ack", id, ok, via, ms}`, and with
   * `report: true` or a `verify` also `changed`, `app`, `orientation`, `verified`; a failure always answers.
   */
  async dispatch(udid: string, msg: Record<string, unknown>, owner?: object): Promise<Record<string, unknown> | null> {
    const t0 = performance.now();
    const id = msg.id ?? null;
    // 2026-11-17: the owner's own input (a live touch, or what the page marks `owner: true`) pauses Lotus on this phone
    // and never waits behind Lotus's reported actions or batch
    if (msg.type === 'touch' || msg.owner === true) this.ownerInput(udid);
    try {
      if (msg.type === 'touch') {
        const r = await this.control.handle(udid, msg, owner);
        const ack = touchAck(msg, t0, r);
        if (ack) return ack;
        return id !== null ? { type: 'ack', id, ok: true, ...ackExtra(r, t0) } : null;
      }
      if (msg.type === 'tap-element') {
        // on a socket `id` is the ack's: the element's id comes as `element`
        const r = await this.inOrder(udid, () => this.tapElement(udid, { ...msg, id: msg.element }, owner));
        return id !== null ? { type: 'ack', ...r, id } : null;
      }
      if (msg.report === true || parseVerify(msg.verify)) {
        const r = await this.inOrder(udid, () => this.action(udid, msg, {}, owner));
        return id !== null ? { type: 'ack', ...r, id } : null;
      }
      // a plain action behind a reported one keeps its place; otherwise it goes straight to the phone's queue
      const plain = () => this.control.handle(udid, msg, owner);
      const r = await (this.lane.has(udid) && msg.owner !== true ? this.inOrder(udid, plain) : plain());
      return id !== null ? { type: 'ack', id, ok: true, ...ackExtra(r, t0) } : null;
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      const error = err instanceof HttpError ? err.message : 'internal error';
      // touches without an id still hear about a failed gesture
      return touchAck(msg, t0, undefined, error) ?? { type: 'ack', id, ok: false, error };
    }
  }
}

/**
 * The extra fields an ack carries about an injected action (old clients ignore them): how it reached the phone, the
 * server's receive -> injected time, and why a slower route took it.
 */
export function ackExtra(r: InputResult | void, t0: number): Record<string, unknown> {
  return r ? { via: r.via, ms: round1(performance.now() - t0), ...(r.reason ? { reason: r.reason } : {}), ...typeExtra(r) } : {};
}

/** 2026-11-18: what `type` and `clear` add to their answer: the read-back `check`, the field's text (never a secure one's), the clear. */
export function typeExtra(r: InputResult | void): Record<string, unknown> {
  if (!r) return {};
  return {
    ...(r.cleared !== undefined ? { cleared: r.cleared } : {}),
    ...(r.clear_method ? { clear_method: r.clear_method } : {}),
    ...(r.check ? { check: r.check } : {}),
    ...(r.check && !r.check.secure && typeof r.value === 'string' ? { value: r.value } : {}),
  };
}
