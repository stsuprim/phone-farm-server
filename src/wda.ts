import { ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Config } from './config.js';
import { ClearStep, FieldState, fieldFrom, nextClearStep, scrubTyped } from './field.js';
import { FIELD_FORK_VERSION, FORK_ROUTES, ForkLaunch, launchPlan, LIVE_GAPPED, LIVE_SEGMENTED, TOKEN_ENV, TOKEN_HEADER, usableLiveMode, WdaFlavor } from './fork.js';
import { isLandscape, Orientation, orientationFromWda, portraitSize, uprightSize, uprightToPanel } from './orient.js';
import { Segmenter } from './segments.js';
import { ButtonName, ControlState, HttpError, PathPoint, ScreenInfo, StreamSettings } from './types.js';

export type WdaStatus = 'starting' | 'ready' | 'failed' | 'stopped';

/**
 * unreachable/session/server = WDA (or its session) is down and worth a recovery + retry;
 * rejected = WDA answered but refused the request; unknown = WDA doesn't have that endpoint.
 */
type Kind = 'unreachable' | 'session' | 'server' | 'rejected' | 'unknown';

export class WdaError extends HttpError {
  named = false;
  /** No answer came in time (WDA may only be busy: it works one request at a time), rather than a refused connection. */
  timeout = false;
  constructor(public kind: Kind, message: string) {
    super(502, message);
  }
  get down(): boolean {
    return this.kind === 'unreachable' || this.kind === 'session' || this.kind === 'server';
  }
}

interface Entry {
  udid: string;
  wdaPort: number;
  mjpegPort: number;
  status: WdaStatus;
  control: ControlState;
  wanted: boolean;
  procs: ChildProcess[];
  restarts: number;
  timer?: NodeJS.Timeout;
  sessionId?: string;
  sessionP?: Promise<string>;
  recovering?: Promise<void>;
  checking: boolean;
  lastOk: number;
  /** The screen in points as held in portrait (short side across), with the pixel scale. */
  screen?: ScreenInfo;
  /** How the phone is turned (WDA's /orientation: the foreground app's), when it was last asked, and an ask in flight. */
  orientation: Orientation | null;
  orientAt: number;
  orientP?: Promise<Orientation | null>;
  tapRoute: 0 | 1 | 2; // 0: /wda/tap, 1: /wda/tap/0 (older WDA), 2: W3C actions
  /** The patched WDA's /wda/lotus/touch (scripts/patch-wda.mjs): yes, no (an unpatched build), or not tried yet. */
  fast: 'yes' | 'no' | 'unknown';
  fastFails: number; // the fast route refused touches in a row (3: given up until WDA restarts)
  mjpeg: StreamSettings; // wanted MJPEG settings
  mjpegApplied?: string; // JSON of the settings last applied to the current session
  /** This WDA's /status names its session (so a /status without ours means ours is gone). */
  statusNamesSession?: boolean;
  /** When a quiet call last had the session remade (at most one such remake every few seconds). */
  goneAt?: number;
  agent: http.Agent; // keep-alive connections to WDA (through iproxy): no new usbmux connection per touch
  /** Self-heals so far (a session remade, WDA restarted, a forward respawned), and the last one with its reason. */
  heals: number;
  lastHeal: HealRecord | null;
  /** Actions and reads on their way to WDA now (a quiet read skips while one is: WDA takes one thing at a time). */
  inflight: number;
  /** A liveness probe in progress (shared by everyone asking). */
  probeP?: Promise<boolean>;
  /** Requests of any kind on their way to WDA now (card reads, the orientation, a lock, a screenshot: all of them). */
  busy: number;
  /** When WDA last answered anything at all, whatever it said (Date.now()). */
  lastAnswer: number;
  /** Liveness checks in a row that got no answer in time, and when the first of them was. */
  misses: number;
  missAt: number;
  /** When `control` last left "ready" (state() says so only once that lasted: a blip is never shown). */
  unreadyAt: number;
  /** Recoveries and runner restarts so far, and why the last recovery ran (stats). */
  recoveries: number;
  runnerRestarts: number;
  /** Which WebDriverAgent runs (or is being started) on the phone: the stock one, or our own build (src/fork.ts). */
  flavor: WdaFlavor;
  /** Our build's token for this phone (sent with every request; never logged). Undefined on a stock WDA. */
  token?: string;
  /** The xcodebuild process of the runner now. */
  runner?: ChildProcess;
  /** What our build said of itself (GET /lotus/info) when it came up; null on a stock WDA. */
  forkInfo: { lotus: number; upstream?: string } | null;
  /** A switch of flavor in progress (src/fork.ts installs our build): a runner that exits isn't relaunched with a back-off. */
  switching: boolean;
  /** Why the runner last failed to start (xcodebuild's exit and the end of what it said), for whoever switches. */
  launchError: string | null;
  /** Our build's live touch stopped working since the runner started (what XCTest said): not used until it restarts. */
  liveFailed: string | null;
  /** Live mode 4 (segmented, src/segments.ts): the drag going to our build in short whole gestures as it happens. */
  seg?: Segmenter;
  /** Our build's runner ended this many times in a row without staying up FORK_STABLE_MS, and when it last came up. */
  forkFails: number;
  readyAt: number;
  /** 2026-11-18, restarts: the attempt of the restart now under way or last made (0: none since WDA was last fine). */
  attempt: number;
  /** The restart in progress (one per phone: every caller joins it) and when it began. */
  restartP?: Promise<void>;
  restartSince: number;
  /** Why control is down after the restarts gave up; null otherwise (a recover or WDA answering again clears it). */
  downWhy: string | null;
  /** Bumped by start() and stop(): a restart begun before stops at its next step. */
  epoch: number;
  /**
   * 2026-11-18, leftovers: the old runner's teardown under way (its session deleted, its xcodebuild and forwards
   * killed and waited for, strays for this phone killed, its ports free). A launch waits for it: never two runners.
   */
  stopping?: Promise<void>;
  /** Bumped by every launch and kill: a launch waiting for a teardown goes ahead only while it's still the newest. */
  launchSeq: number;
  /** The Mac ports this runner's forwards listen on (checked free before the next one starts). */
  fwdPorts: number[];
  /** Control is down because the XCTest session looked jammed and a reset of the device link didn't help: replug. */
  needsReplug: boolean;
}

/**
 * A restart attempt that failed because the runner didn't come up (its /status never answered, it made no session,
 * or it ended before answering): a sign of a jammed XCTest session. Not one refused for a locked phone or signing.
 */
export function jammedStart(why: string): boolean {
  if (/locked|passcode|profile|provision|signing|code ?sign|not trusted|untrusted|expired|developer mode|the phone was stopped/i.test(why)) return false;
  return /did not answer|made no session|no session|ended before|exited|timed? ?out|no answer/i.test(why);
}

/** One self-heal: when (ms since the epoch) and why. */
export interface HealRecord {
  at: number;
  reason: string;
}

/** How long WDA gets to answer each kind of request before it counts as hung (ms). */
export interface WdaTimeouts {
  /** A tap, a button, the home screen, a fast-route touch. */
  input: number;
  /** Launching an app. */
  launch: number;
  /** A liveness probe (GET /session/:id). */
  probe: number;
  /** How long a restarted runner gets to come back. */
  restart: number;
  /** A recovery's first ask of /status (ms; default STATUS_MS); the two asks after it get half as long again. */
  status?: number;
  /** Liveness checks in a row with no answer in time before WDA counts as down (default MISSES)... */
  misses?: number;
  /** ...and only when they span at least this long (ms; default MISS_SPAN_MS). */
  missSpan?: number;
  /** A control state other than "ready" is said only once it lasted this long (ms; default CONTROL_DEBOUNCE_MS). */
  debounce?: number;
  /** Before a restart: /status asked this many times, and every one unanswered (default DEAD_PROBES)... */
  probes?: number;
  /** ...one this long after the start of the last (ms; default PROBE_EVERY_MS). */
  probeEvery?: number;
  /** Waits between restart attempts (ms; default RESTART_BACKOFF_MS)... */
  backoff?: number[];
  /** ...and at most this many attempts before control is down (default RESTART_ATTEMPTS). */
  attempts?: number;
  /** A restarted WDA that answers gets this long to make its session (ms; default SESSION_WAIT_MS). */
  sessionWait?: number;
  /** A recover asked for waits this long for a restart before it answers with the state as it is (ms; default RECOVER_WAIT_MS). */
  recoverWait?: number;
  /** A call waits this long for a WDA that's starting before it answers 503 (ms; default START_WAIT_MS). */
  startWait?: number;
  /** A killed runner gets this long to end after SIGTERM before SIGKILL (ms; default KILL_WAIT_MS). */
  killWait?: number;
  /** Restart attempts in a row whose runner didn't come up before the device link is reset (default JAM_AFTER). */
  jamAfter?: number;
}
export const DEFAULT_TIMEOUTS: WdaTimeouts = { input: 8000, launch: 20000, probe: 3000, restart: 90000 };
/**
 * 2026-11-16, the control link that kept failing and recovering: WDA works one request at a time, and one liveness
 * check that got no answer in 3 s (it waited behind a screenshot, a lock, a card read, the orientation) counted as a
 * dead WDA: its session was dropped, and when /status then waited behind the same request (2.5 s) its runner was
 * restarted on the phone (half a minute of "Recovering"). Now WDA counts as down only after MISSES liveness checks
 * in a row over MISS_SPAN_MS got no answer while nothing else answered either; a recovery asks /status three times
 * before it restarts anything and keeps a session that still answers; and a state that isn't "ready" is said only
 * once it lasted CONTROL_DEBOUNCE_MS. A refused connection (WDA isn't listening at all) still recovers at once.
 */
export const MISSES = 3;
export const MISS_SPAN_MS = 15_000;
export const STATUS_MS = 2500;
export const CONTROL_DEBOUNCE_MS = 4000;
/**
 * 2026-11-18, "it restarts too much" (and one restart left iPhone-2 "recovering" for 10+ minutes with every call
 * timing out): WDA is restarted only once it's really dead: /status asked DEAD_PROBES times, PROBE_EVERY_MS apart
 * (about 12-15 s), none answered and nothing else from WDA answered meanwhile. A slow or failed action never
 * restarts anything by itself. One restart at a time per phone (everyone joins it), every step bounded; calls
 * meanwhile get a 503 at once. Attempts wait RESTART_BACKOFF_MS between them, at most RESTART_ATTEMPTS, then the
 * phone's control is "down" with the last error until a recover, or WDA answering again.
 */
export const DEAD_PROBES = 4;
export const PROBE_EVERY_MS = 4000;
export const RESTART_BACKOFF_MS = [5000, 15000, 60000];
export const RESTART_ATTEMPTS = 4;
export const SESSION_WAIT_MS = 20_000;
export const RECOVER_WAIT_MS = 20_000;
export const START_WAIT_MS = 1000;
/**
 * 2026-11-18, "recovering" for good until a USB replug (iPhone-2, then iPhone-1, after hours of use): a restart sent
 * SIGTERM to the old xcodebuild and its iproxy forwards and launched the new ones at once, without deleting the WDA
 * session or waiting for the old runner to end. XCTest runners and forwards piled up on the phone until its XCTest
 * session jammed, and then every further restart made it worse. Now the old runner is torn down first (its session
 * deleted, its process tree SIGTERMed, waited for KILL_WAIT_MS, then SIGKILLed; strays for the phone killed; its
 * ports free), restarts go one phone at a time, and after JAM_AFTER attempts in a row whose runner didn't come up
 * the device link is reset once (src resetLink); when that doesn't help either, control is down with "needs replug".
 */
export const KILL_WAIT_MS = 10_000;
export const JAM_AFTER = 2;
/** A launched runner's WDA gets this long (by the clock) to answer /status before the runner is given up on. */
const START_MS = 180_000;

/**
 * What the server does to the Mac's processes and the phone's device link around a runner (real mode only; tests
 * that give their own spawn get none of it unless they hand in their own).
 */
export interface WdaSys {
  /** True when these act on the real Mac (pids are real, commands run). */
  real: boolean;
  /** Runs a command, bounded by `timeoutMs`; never throws. */
  run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }>;
  /** The pids under `pid` (children, theirs, ...), deepest first. */
  descendants(pid: number): Promise<number[]>;
  /** Sends `sig` to a pid; false when it's gone. */
  signal(pid: number, sig: NodeJS.Signals): boolean;
  /** Whether a pid is still running. */
  alive(pid: number): boolean;
  /** The pids listening on a local TCP port, with their command lines. */
  listeners(port: number): Promise<{ pid: number; command: string }[]>;
}

const runCmd = (cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') }));
    } catch (err) {
      resolve({ ok: false, out: (err as Error).message });
    }
  });

export const REAL_SYS: WdaSys = {
  real: true,
  run: runCmd,
  async descendants(pid) {
    const out: number[] = [];
    const walk = async (p: number, depth: number) => {
      if (depth > 6) return;
      const r = await runCmd('pgrep', ['-P', String(p)], 3000);
      for (const c of r.out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 1)) {
        await walk(c, depth + 1);
        out.push(c);
      }
    };
    await walk(pid, 0);
    return out;
  },
  signal(pid, sig) {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  async listeners(port) {
    const r = await runCmd('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 5000);
    const pids = [...new Set(r.out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 1))];
    return Promise.all(pids.map(async (pid) => ({ pid, command: (await runCmd('ps', ['-o', 'command=', '-p', String(pid)], 3000)).out.trim() })));
  },
};

/** Tests with their own spawn: no real processes, nothing run, nothing killed but the fakes themselves. */
export const NO_SYS: WdaSys = {
  real: false,
  run: async () => ({ ok: false, out: '' }),
  descendants: async () => [],
  signal: () => false,
  alive: () => false,
  listeners: async () => [],
};

/** `p`, or `onTimeout()`'s error after `ms` (`p` still runs; its end is ignored). */
function within<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

const newAgent = () => new http.Agent({ keepAlive: true, maxSockets: 6 });
type HttpErr = Error & { code?: string };

const PORTS_FILE = path.join('data', 'ports.json');
const HEALTH_MS = 10000;
const DEFAULT_MJPEG: StreamSettings = { fps: 60, quality: 50, scale: 50 };
// No waiting for the app to be idle/animations to finish before each action: that's what made taps slow.
const CAPS = { shouldWaitForQuiescence: false, waitForIdleTimeout: 0, shouldUseCompactResponses: true, maxTypingFrequency: 60 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The fast route's tap: press, then lift this long after (a finger's quick tap). */
export const FAST_TAP_HOLD_MS = 50;
/** The route scripts/patch-wda.mjs adds to WebDriverAgent (keep the two in step). */
export const FAST_TOUCH_ROUTE = '/wda/lotus/touch';

/** Our build whose runner ends this many times in a row (outside an install) is given up on: the stock one comes back. */
export const FORK_GIVE_UP = 3;
/** A runner of our build that stayed up this long was fine: its next end starts the count afresh. */
export const FORK_STABLE_MS = 60_000;
/** A runner left failed by a switch nobody followed up on is started again after this long. */
const SWITCH_RETRY_MS = 15_000;
/** One live touch event gets this long to be answered (it's answered when queued on the phone). */
export const LIVE_TOUCH_TIMEOUT_MS = 2500;

/** The route a whole gesture goes to as one command: our build's, or the one scripts/patch-wda.mjs adds to a stock WDA. */
export function gestureRoute(flavor: WdaFlavor): string {
  return flavor === 'fork' ? FORK_ROUTES.gesture : FAST_TOUCH_ROUTE;
}

/**
 * The body of a whole gesture in one command (both builds take the same): every point with its time, in portrait
 * points; the phone plays all of it by itself, so a natural swipe's curve stays smooth whatever the link does
 * meanwhile. `hold`: lift this long after the last point (a tap's hold). `gap` (our build v3, live mode 5): the
 * phone waits this long after playing it before the next record; sent only when above 0.
 */
export function gestureBody(points: PathPoint[], hold?: number, gap?: number): { points: PathPoint[]; orientation: 1; hold?: number; gap?: number } {
  return { ...(hold !== undefined ? { hold } : {}), ...(gap ? { gap } : {}), points, orientation: 1 };
}

/** The body of one live touch event for our build (POST /lotus/touch): the place in portrait points and the mode its self-test found. */
export function liveBody(phase: 'down' | 'move' | 'up', [x, y]: [number, number], mode: number): { phase: string; x: number; y: number; mode: number; orientation: 1 } {
  return { phase, x, y, mode, orientation: 1 };
}

/** W3C pointer actions for one finger through the points (x, y in points, t = ms since start). */
export function pointerActions(pts: PathPoint[]): unknown[] {
  const p0 = pts[0]!;
  const out: unknown[] = [
    { type: 'pointerMove', duration: 0, x: Math.round(p0[0]), y: Math.round(p0[1]) },
    { type: 'pointerDown', button: 0 },
  ];
  if (p0[2] > 0) out.push({ type: 'pause', duration: Math.round(p0[2]) });
  const total = pts[pts.length - 1]![2] - p0[2];
  const minDt = Math.max(10, total / 400); // ~100 Hz, at most ~400 segments
  let prev = p0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const lastOne = i === pts.length - 1;
    const dt = Math.round(p[2] - prev[2]);
    if (!lastOne && dt < minDt) continue; // merged into the next segment (time is absolute)
    const x = Math.round(p[0]);
    const y = Math.round(p[1]);
    if (x === Math.round(prev[0]) && y === Math.round(prev[1])) {
      if (dt > 0) out.push({ type: 'pause', duration: dt });
    } else {
      out.push({ type: 'pointerMove', duration: Math.max(0, dt), x, y });
    }
    prev = p;
  }
  out.push({ type: 'pointerUp', button: 0 });
  return out;
}

/** Supervises one xcodebuild(WDA) + two iproxy forwards per phone, keeps a WDA session warm and recovers it. */
export class WdaManager {
  private entries = new Map<string, Entry>();
  private ports: Record<string, number> = {};
  private health: NodeJS.Timeout;
  private sys: WdaSys;
  /** 2026-11-18: restarts go one phone at a time (never both phones' runners at once): the queue, and the phones in it. */
  private restartLock: Promise<void> = Promise.resolve();
  private lockQueue: string[] = [];
  /** Called when a phone's orientation (or its screen size, once known) changed. */
  onOrientation?: (udid: string) => void;
  /** Whether someone is watching the phone now: its health check probes the session, not just /status. */
  watched?: (udid: string) => boolean;

  constructor(
    private cfg: Config,
    private nameOf: (udid: string) => string = (u) => u,
    private spawnFn: typeof spawn = spawn, // tests: no real iproxy/xcodebuild
    private timeouts: WdaTimeouts = DEFAULT_TIMEOUTS,
    sys?: WdaSys,
  ) {
    this.sys = sys ?? (spawnFn === spawn ? REAL_SYS : NO_SYS);
    try {
      this.ports = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
    } catch {
      /* first run */
    }
    this.health = setInterval(() => this.healthCheck(), HEALTH_MS);
    this.health.unref();
  }

  // ---- stock WebDriverAgent or our own build (src/fork.ts) ----

  /** Set by the backend: how a phone's WDA starts when the server does, and what our build needs to be launched on it. */
  fork?: { flavorAtStart(udid: string): WdaFlavor; launch(udid: string): ForkLaunch; failed(udid: string, why: string): void; liveMode(udid: string): number; liveGap?(udid: string): number };

  /** Which WebDriverAgent the phone runs (or is being started with). */
  flavor(udid: string): WdaFlavor {
    return this.entries.get(udid)?.flavor ?? 'stock';
  }

  /** Our build is up on the phone and said so (GET /lotus/info answered); null on a stock WDA. */
  forkInfo(udid: string): { lotus: number; upstream?: string } | null {
    const e = this.entries.get(udid);
    return e && e.status === 'ready' ? e.forkInfo : null;
  }

  /**
   * Restart the phone's runner as `flavor` and wait until it answers: /status, and for our build its /lotus/info
   * too. Resolves `{ok: false, why}` when it doesn't within `timeoutMs`, or xcodebuild gives up first (the install
   * was refused: a locked phone, an expired profile). The caller decides what then (src/fork.ts puts the stock one back).
   */
  async switchFlavor(udid: string, flavor: WdaFlavor, timeoutMs = 4 * 60_000): Promise<{ ok: boolean; why?: string }> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted) return { ok: false, why: 'WebDriverAgent is not running for this phone (is it plugged in and trusted?)' };
    this.log(e, `switching the runner to ${flavor === 'fork' ? 'our own WebDriverAgent build' : 'the stock WebDriverAgent'}`);
    e.flavor = flavor;
    e.switching = true;
    e.restarts = 0;
    e.forkFails = 0;
    e.launchError = null;
    try {
      this.restart(e);
      const until = Date.now() + timeoutMs;
      while (e.wanted && e.flavor === flavor && Date.now() < until) {
        if (e.status === 'ready' && (flavor === 'stock' || e.forkInfo)) return { ok: true };
        if (e.status === 'ready' && flavor === 'fork') return { ok: false, why: 'something answers on its port, but it is not our build (no /lotus/info)' };
        if (e.status === 'failed') return { ok: false, why: e.launchError ?? 'xcodebuild exited before WebDriverAgent answered' };
        await sleep(250);
      }
      return { ok: false, why: !e.wanted ? 'the phone was unplugged' : `WebDriverAgent did not answer within ${Math.round(timeoutMs / 1000)} s${e.launchError ? ` (${e.launchError})` : ''}` };
    } finally {
      e.switching = false;
      // A runner left "failed" by the switch has no restart pending. Whoever asked usually switches again at once
      // (src/fork.ts puts the stock one back), which takes over; if nobody does, it's started again by itself.
      if (e.wanted && e.status === 'failed' && !e.timer) {
        e.timer = setTimeout(() => {
          e.timer = undefined;
          if (e.wanted && e.status === 'failed') this.launch(e);
        }, SWITCH_RETRY_MS);
        e.timer.unref?.();
      }
    }
  }

  /** The phone's index (kept in data/ports.json): its Mac ports are the bases plus it. */
  slotOf(udid: string): number {
    return this.slot(udid);
  }

  private slot(udid: string): number {
    if (this.ports[udid] === undefined) {
      const used = new Set(Object.values(this.ports));
      let n = 0;
      while (used.has(n)) n++;
      this.ports[udid] = n;
      fs.mkdirSync('data', { recursive: true });
      fs.writeFileSync(PORTS_FILE, JSON.stringify(this.ports, null, 2));
    }
    return this.ports[udid]!;
  }

  /** `m` with the phone's token (our build's secret) taken out, should anything that's printed ever hold it. */
  private clean(e: Entry, m: string): string {
    return e.token ? m.split(e.token).join('[token]') : m;
  }

  private log(e: Entry, m: string): void {
    console.log(`[wda ${e.udid.slice(-8)}] ${this.clean(e, m)}`); // UDID end: the start (00008110...) is the chip, same on both phones
  }

  /** A self-heal: counted, kept as the phone's last one and logged with its reason. */
  private healed(e: Entry, reason: string): void {
    reason = this.clean(e, reason);
    e.heals++;
    e.lastHeal = { at: Date.now(), reason: reason.slice(0, 200) };
    console.log(`[wda-heal] ${e.udid.slice(-8)} ${reason}`);
  }

  /** The phone's self-heals (`heals`) and the last one (`lastHeal`), for its stats. */
  healStats(udid: string): { heals: number; lastHeal: HealRecord | null } {
    const e = this.entries.get(udid);
    return { heals: e?.heals ?? 0, lastHeal: e?.lastHeal ?? null };
  }

  /**
   * How WDA's own link is doing, for the phone's stats (`stats.controlLink.wda`): the state as told (debounced) and
   * as it is, liveness checks missed in a row, recoveries and runner restarts so far, ms since WDA last answered.
   */
  linkHealth(udid: string): { state: ControlState; raw: ControlState; misses: number; recoveries: number; runnerRestarts: number; answeredMsAgo: number | null; busy: number; restarting: { attempt: number; of: number; since: number } | null; controlDown: string | null; needsReplug: boolean } | null {
    const e = this.entries.get(udid);
    if (!e) return null;
    return {
      state: this.state(udid), raw: !e.wanted || e.downWhy ? 'down' : e.status === 'starting' ? 'recovering' : e.status !== 'ready' ? 'down' : e.control,
      misses: e.misses, recoveries: e.recoveries, runnerRestarts: e.runnerRestarts,
      answeredMsAgo: e.lastAnswer ? Date.now() - e.lastAnswer : null, busy: e.busy + e.inflight,
      restarting: this.restarting(udid), controlDown: e.downWhy, needsReplug: !!e.downWhy && e.needsReplug,
    };
  }

  /** The restart under way now: which attempt of how many, and since when; null when none is. */
  restarting(udid: string): { attempt: number; of: number; since: number } | null {
    const e = this.entries.get(udid);
    return e?.restartP ? { attempt: Math.max(1, e.attempt), of: this.maxAttempts, since: e.restartSince } : null;
  }

  /** Why the phone's control is down after its restarts gave up; null otherwise. */
  controlDown(udid: string): string | null {
    return this.entries.get(udid)?.downWhy ?? null;
  }

  /** The phone's control is down and only a USB replug will bring it back (a software reset didn't help). */
  needsReplug(udid: string): boolean {
    const e = this.entries.get(udid);
    return !!e?.downWhy && e.needsReplug;
  }

  private get maxAttempts(): number {
    return this.timeouts.attempts ?? RESTART_ATTEMPTS;
  }

  /**
   * Throws a 503 at once while the phone's WDA is being restarted, or its control is down after the restarts gave up:
   * `{error: "The phone's control link is restarting (attempt N)", state: "restarting"}` or "control down: ...".
   */
  gate(udid: string): void {
    const e = this.entries.get(udid);
    if (!e || !e.wanted) return;
    if (e.restartP) throw this.restartingError(e);
    if (e.downWhy) throw this.controlDownError(e);
  }

  private restartingError(e: Entry): HttpError {
    return new HttpError(503, `The phone's control link is restarting (attempt ${Math.max(1, e.attempt)})`, { state: 'restarting' });
  }

  private controlDownError(e: Entry): HttpError {
    return new HttpError(503, `control down: ${e.downWhy}`, e.needsReplug ? { state: 'down', needsReplug: true } : { state: 'down' });
  }

  /** `control` changes here, so when it left "ready" is known (state() says a state only once it lasted). */
  private setControl(e: Entry, c: ControlState): void {
    if (c !== 'ready' && e.control === 'ready') e.unreadyAt = Date.now();
    e.control = c;
  }

  /**
   * A liveness check got no answer. True when WDA now counts as down: the connection was refused (nothing listens), or
   * this is the `misses`-th check in a row without an answer in time, over `missSpan`, with nothing else answered
   * meanwhile (any answer at all clears the count: src request()).
   */
  private missed(e: Entry, err: unknown): boolean {
    if (!(err instanceof WdaError) || !err.timeout) return true;
    const now = Date.now();
    if (!e.misses) e.missAt = now;
    e.misses++;
    const down = e.misses >= (this.timeouts.misses ?? MISSES) && now - e.missAt >= (this.timeouts.missSpan ?? MISS_SPAN_MS);
    if (!down && e.misses === 1) this.log(e, `a liveness check got no answer in time (${err.message}); WDA may only be busy, checking again`);
    return down;
  }

  status(udid: string): WdaStatus {
    return this.entries.get(udid)?.status ?? 'stopped';
  }
  /**
   * ready = session warm; recovering = WDA starting or session being remade; down = not running / gave up. A session
   * being remade or checked says "ready" until that has lasted `debounce`: a hiccup that heals in a moment is never
   * shown as the link going down and coming back.
   */
  state(udid: string): ControlState {
    const e = this.entries.get(udid);
    if (!e || !e.wanted || e.downWhy) return 'down';
    if (e.restartP || e.status === 'starting') return 'recovering';
    if (e.status !== 'ready') return 'down';
    if (e.control !== 'ready' && Date.now() - e.unreadyAt < (this.timeouts.debounce ?? CONTROL_DEBOUNCE_MS)) return 'ready';
    return e.control;
  }
  /** The screen in points, upright: as the phone is turned now (844 x 390 in landscape). */
  screen(udid: string): ScreenInfo | null {
    const e = this.entries.get(udid);
    return e?.screen ? { ...uprightSize(e.screen, e.orientation), scale: e.screen.scale } : null;
  }
  orientation(udid: string): Orientation | null {
    return this.entries.get(udid)?.orientation ?? null;
  }
  /**
   * Whether this phone's WDA has its MJPEG server (WDA's screenshots as a JPEG stream; stock WDA: yes). A WDA built
   * without it gives stills as PNG screenshots only (src/stills.ts asks here).
   */
  mjpegAvailable(udid: string): boolean {
    return this.entries.get(udid)?.flavor !== 'fork';
  }
  mjpegPort(udid: string): number {
    const e = this.entries.get(udid);
    if (!e) throw new HttpError(503, 'WebDriverAgent is not running for this phone');
    if (e.flavor === 'fork') throw new HttpError(503, 'this WebDriverAgent build has no MJPEG server');
    return e.mjpegPort;
  }

  start(udid: string): void {
    let e = this.entries.get(udid);
    if (e?.wanted) return;
    const n = this.slot(udid);
    e ??= {
      udid, wdaPort: this.cfg.wdaBasePort + n, mjpegPort: this.cfg.mjpegBasePort + n, status: 'starting', control: 'recovering',
      wanted: true, procs: [], restarts: 0, checking: false, lastOk: 0, orientation: null, orientAt: 0, tapRoute: 0, fast: 'unknown', fastFails: 0,
      mjpeg: { ...DEFAULT_MJPEG }, agent: newAgent(), heals: 0, lastHeal: null, inflight: 0,
      busy: 0, lastAnswer: 0, misses: 0, missAt: 0, unreadyAt: 0, recoveries: 0, runnerRestarts: 0,
      flavor: 'stock', forkInfo: null, switching: false, launchError: null, liveFailed: null, forkFails: 0, readyAt: 0,
      attempt: 0, restartSince: 0, downWhy: null, epoch: 0, launchSeq: 0, fwdPorts: [], needsReplug: false,
    };
    const first = !this.entries.has(udid);
    e.epoch++;
    e.attempt = 0;
    e.downWhy = null;
    e.needsReplug = false;
    e.restartP = undefined;
    // ours when it was installed on this phone and ran (src/fork.ts), else the stock one
    e.flavor = this.fork?.flavorAtStart(udid) ?? 'stock';
    e.wanted = true;
    this.entries.set(udid, e);
    // the first start since the server started: a runner or forward left for this phone by the server before (an
    // update's restart) is ended first, so the new one is the only one
    if (first && this.sys.real) this.chainStop(e, () => this.reapStrays(e, [this.cfg.wdaBasePort + n, this.cfg.mjpegBasePort + n]));
    this.launch(e);
  }

  stop(udid: string): void {
    const e = this.entries.get(udid);
    if (!e) return;
    e.wanted = false;
    e.status = 'stopped';
    e.control = 'down';
    e.epoch++;
    e.restartP = undefined;
    e.attempt = 0;
    e.downWhy = null;
    e.needsReplug = false;
    this.killProcs(e);
  }

  /**
   * Ends the phone's runner and forwards. The entry lets go of them at once (their exits are no failure to act on);
   * the teardown runs in the background (reap) and the next launch waits for it, so a phone never has two runners.
   */
  private killProcs(e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    e.launchSeq++; // a launch waiting for an earlier teardown doesn't go ahead: whoever kills decides what's next
    const old = { procs: e.procs, sessionId: e.sessionId, agent: e.agent, wdaPort: e.wdaPort, ports: e.fwdPorts, token: e.token };
    e.procs = [];
    e.fwdPorts = [];
    e.runner = undefined; // killed on purpose: its exit isn't a failure to act on
    e.sessionId = undefined;
    e.sessionP = undefined;
    e.mjpegApplied = undefined;
    e.agent = newAgent();
    if (!this.sys.real && !old.procs.some((p) => p.pid)) {
      // no real processes (tests): nothing to wait for
      for (const p of old.procs) p.kill('SIGTERM');
      old.agent.destroy();
      return;
    }
    this.chainStop(e, () => this.reap(e, old));
  }

  /** Runs `step` after any teardown under way for the phone; the next launch waits for all of them. */
  private chainStop(e: Entry, step: () => Promise<void>): void {
    const prev = e.stopping ?? Promise.resolve();
    const p: Promise<void> = prev
      .then(step)
      .catch((err) => this.log(e, `stopping the old runner: ${(err as Error)?.message ?? err}`))
      .finally(() => {
        if (e.stopping === p) e.stopping = undefined;
      });
    e.stopping = p;
  }

  /** A teardown under way ends (at most `ms`). */
  private async settled(e: Entry, ms = 60_000): Promise<void> {
    const until = Date.now() + ms;
    while (e.stopping && Date.now() < until) await within(e.stopping, Math.max(1, until - Date.now()), () => new Error('wait')).catch(() => {});
  }

  /**
   * The old runner torn down for good: its WDA session deleted (XCTest frees it), its xcodebuild and forwards with
   * every process under them sent SIGTERM and waited for (`killWait`), SIGKILL for what's left; then any stray
   * runner or forward for this phone, and the ports checked free. Every step bounded; nothing here throws.
   */
  private async reap(e: Entry, old: { procs: ChildProcess[]; sessionId?: string; agent: http.Agent; wdaPort: number; ports: number[]; token?: string }): Promise<void> {
    const t0 = Date.now();
    const live = (p: ChildProcess) => !!p.pid && p.exitCode === null && p.signalCode === null && this.sys.alive(p.pid);
    try {
      if (old.sessionId && old.procs.some(live)) await this.deleteSession(old.agent, old.wdaPort, old.sessionId, old.token);
    } finally {
      old.agent.destroy();
    }
    const procs = old.procs.filter(live);
    if (procs.length) {
      // the tree first: once xcodebuild is gone its children belong to launchd and can't be found by it any more
      const tree = new Map<number, number[]>();
      for (const p of procs) tree.set(p.pid!, await this.sys.descendants(p.pid!));
      for (const p of procs) {
        try {
          p.kill('SIGTERM');
        } catch {
          /* gone */
        }
        for (const c of tree.get(p.pid!) ?? []) this.sys.signal(c, 'SIGTERM');
      }
      const all = () => [...tree].flatMap(([pid, kids]) => [pid, ...kids]).filter((pid) => this.sys.alive(pid));
      const until = Date.now() + (this.timeouts.killWait ?? KILL_WAIT_MS);
      while (all().length && Date.now() < until) await sleep(100);
      const left = all();
      if (left.length) {
        this.log(e, `the old runner did not end within ${Math.round((this.timeouts.killWait ?? KILL_WAIT_MS) / 1000)} s of SIGTERM: SIGKILL to ${left.length} process(es)`);
        for (const pid of left) this.sys.signal(pid, 'SIGKILL');
        const until2 = Date.now() + 3000;
        while (all().length && Date.now() < until2) await sleep(100);
        if (all().length) this.log(e, `process(es) ${all().join(', ')} still there after SIGKILL`);
      }
    }
    await this.reapStrays(e, old.ports);
    this.log(e, `old runner stopped in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  /** DELETE /session/:id through the old forward, at most 1.5 s, whatever it answers (best effort). */
  private deleteSession(agent: http.Agent, port: number, sid: string, token?: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'DELETE', path: `/session/${encodeURIComponent(sid)}`, agent, timeout: 1500, headers: token ? { [TOKEN_HEADER]: token } : {} },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
          res.on('error', () => resolve());
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.end();
    });
  }

  /**
   * Any runner (xcodebuild test-without-building for this phone) or forward (iproxy -u <udid>) still there, ours or
   * left by an earlier server: SIGTERM, a moment, SIGKILL. Then the ports: an iproxy still listening on one is ended,
   * anything else is said in the log. Never touches a build (build-for-testing) or another phone.
   */
  private async reapStrays(e: Entry, ports: number[]): Promise<void> {
    if (!this.sys.real) return;
    const patterns = [`xcodebuild test-without-building.*id=${e.udid}`, `iproxy -u ${e.udid}`];
    let found = false;
    for (const pat of patterns) found = (await this.sys.run('pkill', ['-TERM', '-f', pat], 5000)).ok || found; // 0: some matched
    if (found) {
      this.log(e, 'stray runner or forward processes for this phone found: ended');
      await sleep(2000);
      for (const pat of patterns) await this.sys.run('pkill', ['-KILL', '-f', pat], 5000);
    }
    for (const port of ports) {
      let ls = await this.sys.listeners(port);
      const until = Date.now() + 3000;
      while (ls.length && Date.now() < until) {
        await sleep(250);
        ls = await this.sys.listeners(port);
      }
      for (const l of ls) {
        if (/\biproxy\b/.test(l.command)) {
          this.log(e, `port ${port} still held by ${l.command.slice(0, 120)} (pid ${l.pid}): killed`);
          this.sys.signal(l.pid, 'SIGKILL');
        } else {
          this.log(e, `port ${port} is held by another program (pid ${l.pid}: ${l.command.slice(0, 120)}); the new forward may fail`);
        }
      }
    }
  }

  /** Relaunch the phone's runner now (after a re-sign: test-without-building installs the fresh build). */
  restartRunner(udid: string): void {
    const e = this.entries.get(udid);
    if (!e?.wanted) return;
    // a restart under way launches the fresh build anyway
    if (e.restartP) return void this.log(e, 'a fresh WDA build is in place; the restart under way runs it');
    this.log(e, 'restarting the runner (fresh WDA build)');
    e.restarts = 0;
    e.attempt = 0;
    e.downWhy = null;
    e.needsReplug = false;
    // one phone at a time: never both phones' runners restarting together
    const epoch = e.epoch;
    void this.exclusive(e, async () => {
      if (!e.wanted || e.epoch !== epoch || e.restartP || e.switching) return;
      this.restart(e);
      await this.awaitUp(e, this.timeouts.restart, () => e.wanted && e.epoch === epoch);
    }).catch(() => {});
  }

  /**
   * Runs `fn` while no other phone's runner is being restarted (one restart at a time across the farm). Every holder
   * is bounded (a teardown, the runner's /status and its session), so a wait ends.
   */
  private async exclusive<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const prev = this.restartLock;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.restartLock = prev.then(() => mine);
    const ahead = this.lockQueue.filter((u) => u !== e.udid);
    if (ahead.length) this.restartLog(e, `waiting for ${ahead.map((u) => this.nameOf(u)).join(', ')}'s restart to finish first (one phone at a time)`);
    this.lockQueue.push(e.udid);
    try {
      await prev;
      return await fn();
    } finally {
      this.lockQueue.splice(this.lockQueue.indexOf(e.udid), 1);
      release();
    }
  }

  /** Kill and relaunch the WDA runner and its forwards right away. */
  private restart(e: Entry): void {
    if (!e.wanted) return;
    this.killProcs(e);
    e.restarts++;
    e.runnerRestarts++;
    this.launch(e);
  }

  private relaunchLater(e: Entry, why: string): void {
    this.killProcs(e);
    if (!e.wanted) return;
    e.status = 'failed';
    e.control = 'down';
    e.restarts++;
    why = this.clean(e, why);
    e.launchError = why.slice(0, 300);
    // a switch of flavor is watching (switchFlavor): it decides what's launched next
    if (e.switching) return void this.log(e, why);
    // Our build's runner ended by itself. One that had stayed up a while starts the count afresh (a phone unplugged
    // for a moment, an iOS hiccup); three in a row that didn't (it won't start, or dies right after it does): the
    // stock one comes back, and ours is tried again later (src/fork.ts).
    if (e.flavor === 'fork') {
      if (e.readyAt && Date.now() - e.readyAt >= FORK_STABLE_MS) e.forkFails = 0;
      e.readyAt = 0;
      if (++e.forkFails >= FORK_GIVE_UP) {
        e.flavor = 'stock';
        e.restarts = 0;
        e.forkFails = 0;
        e.attempt = 0; // a new start: the stock one gets its own attempts
        this.fork?.failed(e.udid, why);
        this.healed(e, `our WebDriverAgent build did not stay up ${FORK_GIVE_UP} times in a row (${why}); back to the stock one`);
      }
    }
    // the runner ended: WDA is dead for sure (no probing). The restart under way sees it; a phone whose restarts gave up
    // stays down until a recover; otherwise a restart begins (one at a time, backed off, capped).
    if (e.restartP) return void this.log(e, why);
    if (e.downWhy) return void this.log(e, `${why}; control stays down until a recover`);
    void this.beginRestart(e, why);
  }

  /**
   * Start the phone's runner: at once, or once the old one's teardown ended (it's "starting" meanwhile). Only the
   * newest launch goes ahead, and only while nothing was killed since; never a second runner beside a live one.
   */
  private launch(e: Entry): void {
    e.fast = 'unknown'; // a rebuilt WDA may have (or lack) the fast route
    e.fastFails = 0;
    e.status = 'starting';
    e.control = 'recovering';
    e.sessionId = undefined;
    e.sessionP = undefined;
    e.mjpegApplied = undefined;
    const seq = ++e.launchSeq;
    if (!e.stopping) return this.spawnRunner(e);
    void (async () => {
      while (e.stopping && e.launchSeq === seq) await e.stopping.catch(() => {});
      if (!e.wanted || e.launchSeq !== seq) return;
      if (e.runner || e.procs.length) return void this.log(e, 'a runner is already there: not starting a second one');
      this.spawnRunner(e);
    })();
  }

  private spawnRunner(e: Entry): void {
    if (e.procs.length) {
      // never two runners (launch() makes sure this doesn't happen): the old one is torn down first
      this.killProcs(e);
      return this.launch(e);
    }
    const spawnLogged = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
      const p = this.spawnFn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      const errTail: string[] = [];
      p.stderr?.on('data', (d: Buffer) => {
        errTail.push(...d.toString().split(/\r?\n/).filter(Boolean));
        if (errTail.length > 5) errTail.splice(0, errTail.length - 5);
      });
      p.on('exit', (code) => {
        if (code && errTail.length) this.log(e, `${cmd} exited with ${code}; last stderr: ${errTail.join(' | ')}`);
      });
      p.stdout?.on('data', () => {});
      p.on('error', (err) => this.log(e, `${cmd} failed to start: ${err.message}`));
      return p;
    };

    // Stock: WDA's default ports on the phone (8100, and 9100 for MJPEG), forwarded to this phone's Mac ports. Ours:
    // its own high port and its token, no MJPEG at all (src/fork.ts launchPlan). A forward that dies (a usbmuxd
    // hiccup, the phone re-enumerating after a long sleep) is started again by itself: WDA is still fine, and without
    // its forward every request looked like WDA being down (a slow full restart).
    const plan = launchPlan(this.cfg, e.udid, this.slot(e.udid), e.flavor === 'fork' && this.fork ? this.fork.launch(e.udid) : null);
    e.flavor = plan.flavor;
    e.wdaPort = plan.wda.local;
    e.token = plan.flavor === 'fork' ? plan.env[`TEST_RUNNER_${TOKEN_ENV}`] : undefined;
    e.forkInfo = null;
    e.liveFailed = null;
    e.seg = undefined;
    const forward = (slot: 0 | 1, local: number, remote: number): ChildProcess => {
      const p = spawnLogged('iproxy', ['-u', e.udid, `${local}:${remote}`]);
      p.on('exit', (code) => {
        if (!e.wanted || e.procs[slot] !== p) return; // killed on purpose, or superseded
        this.healed(e, `the ${slot === 0 ? 'WDA' : 'MJPEG'} port forward (iproxy :${local}) exited (${code}); starting it again`);
        setTimeout(() => {
          if (!e.wanted || e.procs[slot] !== p) return;
          if (slot === 0) {
            e.agent.destroy(); // its connections went with it
            e.agent = newAgent();
          }
          e.procs[slot] = forward(slot, local, remote);
        }, 500).unref?.();
      });
      return p;
    };
    const fwdWda = forward(0, plan.wda.local, plan.wda.device);
    const fwdMjpeg = plan.mjpeg ? forward(1, plan.mjpeg.local, plan.mjpeg.device) : null;
    // the environment holds our build's token: it's handed to xcodebuild and never logged
    const xcode = spawnLogged('xcodebuild', plan.args, plan.env);
    e.runner = xcode;
    e.procs = fwdMjpeg ? [fwdWda, fwdMjpeg, xcode] : [fwdWda, xcode];
    e.fwdPorts = plan.mjpeg ? [plan.wda.local, plan.mjpeg.local] : [plan.wda.local];
    this.log(e, plan.mjpeg ? `starting (wda :${plan.wda.local}, mjpeg :${plan.mjpeg.local})` : `starting our own build (wda :${plan.wda.local} on the Mac and the phone, token set, no MJPEG)`);

    // what xcodebuild said about a refused install or signing (a locked phone, an expired profile), for the switch's "why"
    const tail: string[] = [];
    const keep = (d: Buffer) => {
      for (const l of d.toString().split(/\r?\n/)) if (/error|fail|unable|cannot|locked|trust|profile|sign/i.test(l)) tail.push(l.trim().slice(0, 160));
      if (tail.length > 4) tail.splice(0, tail.length - 4);
    };
    xcode.stdout?.on('data', keep);
    xcode.stderr?.on('data', keep);
    xcode.on('exit', (code) => {
      if (e.runner !== xcode) return; // superseded
      this.relaunchLater(e, `xcodebuild exited (${code})${tail.length ? `: ${tail.join(' | ')}` : ''}`);
    });

    // poll WDA /status until it answers, then warm a session
    const waitReady = async () => {
      // by the clock (2026-11-18): it counted 360 tries, and a /status that timed out each time made that 15 minutes
      const until = Date.now() + START_MS;
      while (Date.now() < until && e.wanted && e.runner === xcode) {
        if ((await this.ping(e, 2000)).ok) {
          if (e.runner !== xcode) return;
          // which WebDriverAgent answered: ours says so (and its version); a stock one doesn't know the route
          e.forkInfo = await this.askFork(e);
          if (e.runner !== xcode) return;
          if (e.forkInfo) this.log(e, `our own build answers (v${e.forkInfo.lotus}${e.forkInfo.upstream ? `, ${e.forkInfo.upstream}` : ''})`);
          e.readyAt = Date.now();
          e.status = 'ready';
          e.restarts = 0;
          e.lastOk = Date.now();
          if (!e.restartP) {
            // WDA answering again by itself (after the restarts gave up): control is back, the count starts afresh
            if (e.downWhy) this.restartLog(e, `WDA answers again; control is back (it was down: ${e.downWhy})`);
            e.downWhy = null;
            e.needsReplug = false;
            e.attempt = 0;
          }
          this.log(e, 'ready');
          try {
            await this.session(e);
            this.setControl(e, 'ready');
          } catch (err) {
            this.log(e, `could not make a session yet: ${(err as Error).message}`);
          }
          return;
        }
        await sleep(500);
      }
      if (e.wanted && e.runner === xcode) this.relaunchLater(e, `WDA did not answer within ${Math.round(START_MS / 60000)} minutes`);
    };
    void waitReady();
  }

  // ---- WDA HTTP client ----
  /**
   * One HTTP request to WDA over the entry's keep-alive agent (Nagle off). A request that fails on a reused idle
   * connection the other side had already closed is retried once on a fresh one, so a stale socket never looks
   * like WDA being down (which would trigger a session recovery).
   */
  private async request(e: Entry, method: string, p: string, body: string | undefined, timeout: number, resend = true): Promise<{ status: number; text: string }> {
    e.busy++;
    try {
      // `resend: false` (typing): never sent a second time, even on a stale socket (WDA may have typed it already)
      const r = await this.requestOnce(e, method, p, body, timeout, !resend);
      // any answer at all, whatever it says: WDA is there
      e.lastAnswer = Date.now();
      e.misses = 0;
      return r;
    } finally {
      e.busy--;
    }
  }

  private requestOnce(e: Entry, method: string, p: string, body: string | undefined, timeout: number, retried: boolean): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const headers: Record<string, string | number> = {};
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(body);
      }
      // our build answers nothing without its token (never logged: this header is the only place it goes)
      if (e.token) headers[TOKEN_HEADER] = e.token;
      const req = http.request({ host: '127.0.0.1', port: e.wdaPort, path: p, method, agent: e.agent, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', fail);
      });
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeout);
      function fail(err: HttpErr) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stale = req.reusedSocket && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || /socket hang up/i.test(err.message));
        if (stale && !retried) resolve(thisRef.requestOnce(e, method, p, body, timeout, true));
        else reject(err);
      }
      const thisRef = this;
      req.on('error', fail);
      req.on('socket', (s) => s.setNoDelay(true));
      req.end(body);
    });
  }

  private async raw(e: Entry, method: string, p: string, body?: unknown, timeout = 30000, resend = true): Promise<any> {
    let res: { status: number; text: string; ok?: boolean };
    try {
      res = await this.request(e, method, p, body === undefined ? undefined : JSON.stringify(body), timeout, resend);
    } catch (err) {
      const x = err as HttpErr;
      const why = x.code === 'TIMEOUT' ? `no answer within ${Math.round(timeout / 1000)}s` : `unreachable (${x.code ?? x.message})`;
      const werr = new WdaError('unreachable', why);
      werr.timeout = x.code === 'TIMEOUT';
      throw werr;
    }
    res.ok = res.status >= 200 && res.status < 300;
    const text = res.text;
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    const v = json?.value;
    const werr: unknown = v && typeof v === 'object' ? v.error : undefined;
    const legacy = typeof json?.status === 'number' && json.status !== 0 ? (json.status as number) : 0; // JSONWP status
    if (res.ok && !werr && !legacy) return json;
    const msg = String((v && typeof v === 'object' ? v.message : v) || werr || `HTTP ${res.status}`).split('\n')[0]!.slice(0, 200);
    let kind: Kind;
    if (werr === 'invalid session id' || legacy === 6 || /session .*(does not exist|not found|is not active|terminated)/i.test(msg)) kind = 'session';
    else if (werr === 'unknown command' || werr === 'unknown method' || legacy === 9 || (res.status === 404 && !werr)) kind = 'unknown';
    else if (res.status >= 500 || legacy === 13) kind = 'server';
    else kind = 'rejected';
    throw new WdaError(kind, msg);
  }

  private async ping(e: Entry, timeout: number): Promise<{ ok: boolean; sessionId?: string; why?: string }> {
    try {
      const r = await this.request(e, 'GET', '/status', undefined, timeout);
      let j: any = {};
      try {
        j = JSON.parse(r.text);
      } catch {
        /* not JSON */
      }
      const sid = j?.sessionId ?? j?.value?.sessionId;
      if (typeof sid === 'string' && sid) e.statusNamesSession = true;
      const ok = r.status >= 200 && r.status < 300;
      return { ok, sessionId: typeof sid === 'string' && sid ? sid : undefined, ...(ok ? {} : { why: `HTTP ${r.status}` }) };
    } catch (err) {
      const x = err as HttpErr;
      return { ok: false, why: x.code === 'TIMEOUT' ? `no answer in ${(timeout / 1000).toFixed(1)} s` : `unreachable (${x.code ?? x.message})` };
    }
  }

  /** GET /lotus/info: what our build says of itself; null when this WDA isn't ours (a stock one answers "unknown command"). */
  private async askFork(e: Entry): Promise<{ lotus: number; upstream?: string } | null> {
    // a stock WDA is never asked: it would only log an unknown route (and it's launched without a token anyway)
    if (e.flavor !== 'fork') return null;
    for (let n = 0; n < 2; n++) {
      try {
        const v = (await this.raw(e, 'GET', FORK_ROUTES.info, undefined, 4000))?.value;
        const lotus = Number(v?.lotus);
        return Number.isInteger(lotus) && lotus >= 1 ? { lotus, ...(typeof v.upstream === 'string' ? { upstream: v.upstream } : {}) } : null;
      } catch (err) {
        // "unknown command": not our build. Anything else (it answered /status a moment ago): asked once more.
        if (err instanceof WdaError && err.kind === 'unknown') return null;
      }
    }
    return null;
  }

  private session(e: Entry): Promise<string> {
    if (e.sessionId) return Promise.resolve(e.sessionId);
    e.sessionP ??= this.createSession(e).finally(() => {
      e.sessionP = undefined;
    });
    return e.sessionP;
  }

  private async createSession(e: Entry): Promise<string> {
    const j = await this.raw(e, 'POST', '/session', { capabilities: { alwaysMatch: CAPS }, desiredCapabilities: CAPS }, 15000);
    const id = j.sessionId ?? j.value?.sessionId;
    if (!id) throw new WdaError('server', 'WDA did not return a session id');
    e.sessionId = id;
    e.lastOk = Date.now();
    await Promise.all([this.readScreen(e, id), this.applySettings(e, id)]);
    return id;
  }

  /**
   * Screen size in points (window size), scale (/wda/screen) and orientation, read with each new session. WDA's
   * window size is the foreground app's, so it's wide when the phone is in landscape at that moment: it's kept as
   * held in portrait, and `screen()` turns it by the orientation, which is asked again as the phone turns
   * (refreshOrientation). Before this the size was kept as it came, for the whole session: a phone that was (or
   * went) landscape had a list size, a clamp and an HID check for the wrong shape.
   */
  private async readScreen(e: Entry, sid: string): Promise<void> {
    const [size, scr, orient] = await Promise.allSettled([
      this.raw(e, 'GET', `/session/${sid}/window/size`, undefined, 5000),
      this.raw(e, 'GET', '/wda/screen', undefined, 5000),
      this.readOrientation(e, sid),
    ]);
    const w = size.status === 'fulfilled' ? Number(size.value?.value?.width) : NaN;
    const h = size.status === 'fulfilled' ? Number(size.value?.value?.height) : NaN;
    const s = scr.status === 'fulfilled' ? Number(scr.value?.value?.scale) : NaN;
    const before = JSON.stringify([e.screen, e.orientation]);
    if (w > 0 && h > 0) e.screen = { ...portraitSize({ width: w, height: h }), scale: s > 0 ? s : e.screen?.scale ?? null };
    else if (s > 0 && e.screen) e.screen.scale = s;
    // WDA without /orientation: the window's shape still says wide or tall
    const shape: Orientation | null = w > 0 && h > 0 ? (w > h ? (isLandscape(e.orientation) ? e.orientation : 'landscape-left') : isLandscape(e.orientation) || !e.orientation ? 'portrait' : e.orientation) : null;
    const o = (orient.status === 'fulfilled' ? orient.value : null) ?? shape;
    if (o) {
      e.orientation = o;
      e.orientAt = Date.now();
    }
    if (JSON.stringify([e.screen, e.orientation]) !== before) this.onOrientation?.(e.udid);
  }

  private async readOrientation(e: Entry, sid: string): Promise<Orientation | null> {
    try {
      return orientationFromWda((await this.raw(e, 'GET', `/session/${sid}/orientation`, undefined, 4000))?.value);
    } catch (err) {
      this.sessionGone(e, sid, err);
      return null;
    }
  }

  /**
   * A quiet session call (orientation, settings) was told its session is gone: make a new one now, in the background
   * (it reads the screen and applies the settings again), rather than leaving it to the next action or health check.
   */
  private sessionGone(e: Entry, sid: string, err: unknown): void {
    if (!(err instanceof WdaError) || err.kind !== 'session' || e.sessionId !== sid || e.recovering || e.status !== 'ready') return;
    if (e.goneAt && Date.now() - e.goneAt < 5000) return; // a WDA that refuses every session: the health check's job
    e.goneAt = Date.now();
    this.healed(e, `the session expired (${err.message}); making a new one`);
    e.sessionId = undefined;
    e.mjpegApplied = undefined;
    void this.session(e).then(
      () => {
        this.setControl(e, 'ready');
      },
      () => {},
    );
  }

  /**
   * After WDA refused a session call (a 4xx that didn't name the session): whether our session is no longer WDA's
   * (the runner restarted on the phone, or something else made a session, which ends ours). Asks /status, whose
   * `sessionId` is the one WDA has now; ours is dropped when it isn't that one.
   */
  private async sessionExpired(e: Entry, sid: string): Promise<boolean> {
    if (e.sessionId !== sid) return true; // dropped meanwhile (the health check, another call)
    const st = await this.ping(e, 2500);
    if (!st.ok || st.sessionId === sid) return false;
    if (!st.sessionId && !e.statusNamesSession) return false; // a WDA whose /status never names a session: can't tell
    if (e.sessionId === sid) {
      e.sessionId = undefined;
      e.mjpegApplied = undefined;
    }
    return true;
  }

  /**
   * How the phone is turned, asked again unless it was within `maxAgeMs` (one ask at a time per phone). Never
   * recovers WDA: an ask that fails keeps what was known.
   */
  refreshOrientation(udid: string, maxAgeMs = 1500): Promise<Orientation | null> {
    const e = this.entries.get(udid);
    if (!e) return Promise.resolve(null);
    if (e.orientP) return e.orientP;
    if (e.status !== 'ready' || !e.sessionId || e.recovering || Date.now() - e.orientAt < maxAgeMs) return Promise.resolve(e.orientation);
    const sid = e.sessionId;
    e.orientP = this.readOrientation(e, sid)
      .then((o) => {
        e.orientAt = Date.now();
        if (o && o !== e.orientation) {
          this.log(e, `orientation ${e.orientation ?? 'unknown'} -> ${o}`);
          e.orientation = o;
          this.onOrientation?.(e.udid);
        }
        return e.orientation;
      })
      .finally(() => {
        e.orientP = undefined;
      });
    return e.orientP;
  }

  private async applySettings(e: Entry, sid: string): Promise<void> {
    const key = JSON.stringify(e.mjpeg);
    const settings = {
      animationCoolOffTimeout: 0,
      waitForIdleTimeout: 0,
      mjpegServerFramerate: e.mjpeg.fps,
      mjpegServerScreenshotQuality: e.mjpeg.quality,
      mjpegScalingFactor: e.mjpeg.scale,
      // WDA's MJPEG frames are the panel's (portrait) unless told to turn them: a landscape phone came out sideways
      mjpegFixOrientation: true,
    };
    try {
      await this.raw(e, 'POST', `/session/${sid}/appium/settings`, { settings }, 5000);
      e.mjpegApplied = key;
    } catch (err) {
      this.log(e, `settings not applied: ${(err as Error).message}`);
      this.sessionGone(e, sid, err); // a new session applies them
    }
  }

  /** Wanted MJPEG settings; applied now if a session exists, else when the next one is made. */
  async setMjpeg(udid: string, s: StreamSettings): Promise<void> {
    const e = this.entries.get(udid);
    if (!e) return;
    e.mjpeg = { ...s };
    if (e.sessionId && e.mjpegApplied !== JSON.stringify(s)) await this.applySettings(e, e.sessionId);
  }

  private async waitReady(e: Entry, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (e.wanted && e.status !== 'ready' && Date.now() < until) await sleep(250);
  }

  private downError(e: Entry, why: string): WdaError {
    const err = new WdaError('unreachable', `WDA session for ${this.nameOf(e.udid)} is down: ${why}`);
    err.named = true;
    return err;
  }

  private named(e: Entry, err: unknown): HttpError {
    if (err instanceof WdaError) {
      if (err.named) return err;
      const name = this.nameOf(e.udid);
      const out = new WdaError(err.kind, err.down ? `WDA session for ${name} is down: ${err.message}` : `WDA refused the request on ${name}: ${err.message}`);
      out.named = true;
      return out;
    }
    if (err instanceof HttpError) return err;
    return this.downError(e, (err as Error)?.message ?? String(err));
  }

  /**
   * The phone's entry once WDA can take a request. Never waits on a restart (2026-11-18): while one is under way, or
   * control is down after the restarts gave up, a 503 at once; a WDA that's starting gets START_WAIT_MS, then a 503.
   */
  private async usable(udid: string): Promise<Entry> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted) {
      const err = new WdaError('unreachable', `WDA session for ${this.nameOf(udid)} is down: WebDriverAgent is not running`);
      err.named = true;
      throw err;
    }
    this.gate(udid);
    if (e.status === 'failed' && e.timer) {
      // a runner a switch of flavor left failed, waiting to be started again: start it now
      clearTimeout(e.timer);
      e.timer = undefined;
      this.launch(e);
    }
    if (e.status === 'starting') await this.waitReady(e, this.timeouts.startWait ?? START_WAIT_MS);
    this.gate(udid);
    if (e.status !== 'ready') {
      const starting = e.status === 'starting';
      throw new HttpError(503, starting ? "The phone's control link is starting" : `The phone's control link is not running (WebDriverAgent ${e.status})`, { state: starting ? 'starting' : 'down' });
    }
    return e;
  }

  /** A restart's line in server.log: `[wda-restart] <udid end> ...` (never a token). */
  private restartLog(e: Entry, m: string): void {
    console.log(`[wda-restart] ${e.udid.slice(-8)} ${this.clean(e, m)}`);
  }

  /**
   * Is WDA really dead? /status is asked `probes` times, `probeEvery` apart, each given `status` ms. Any answer at
   * all (that one, or any other request's meanwhile) means it's there. Null when it is; else how each ask failed.
   * 'moot' when the phone changed meanwhile (a restart began, the runner ended, it was unplugged).
   */
  private async confirmDead(e: Entry): Promise<string | null | 'moot'> {
    const n = Math.max(1, this.timeouts.probes ?? DEAD_PROBES);
    const every = this.timeouts.probeEvery ?? PROBE_EVERY_MS;
    const ms = this.timeouts.status ?? STATUS_MS;
    const fails: string[] = [];
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      if (!e.wanted || e.status !== 'ready' || e.restartP) return 'moot';
      const at = Date.now();
      const r = await this.ping(e, ms);
      if (r.ok || e.lastAnswer >= at) return null;
      fails.push(r.why ?? 'no answer');
      if (i < n - 1) {
        const wait = every - (Date.now() - at);
        if (wait > 0) await sleep(wait);
        if (e.lastAnswer >= at) return null; // something else got an answer meanwhile: WDA is there
      }
    }
    const counts = new Map<string, number>();
    for (const f of fails) counts.set(f, (counts.get(f) ?? 0) + 1);
    const how = [...counts].map(([f, c]) => (c > 1 ? `${f} x${c}` : f)).join(', ');
    return `/status asked ${n} times over ${((Date.now() - t0) / 1000).toFixed(1)} s, never answered (${how})`;
  }

  /**
   * Find out what's wrong and fix only that (shared by concurrent callers; every step bounded). WDA counts as dead
   * only when /status went unanswered `probes` times over ~12-15 s (confirmDead): then a restart begins (beginRestart)
   * and this rejects with its 503. A WDA that answers keeps its session when that still answers too; one that's gone
   * (`sessionGone`: WDA said so itself) is made anew; a WDA that answers but makes no session twice is restarted.
   */
  private recover(e: Entry, why: string, sessionGone = false): Promise<void> {
    if (e.restartP) return Promise.reject(this.restartingError(e));
    if (e.downWhy) return Promise.reject(this.controlDownError(e));
    if (e.recovering) return e.recovering;
    const run = (async () => {
      if (e.status !== 'ready') throw this.downError(e, `WebDriverAgent is ${e.status === 'starting' ? 'still starting' : e.status}`);
      e.recoveries++;
      e.misses = 0;
      this.healed(e, `recovering: ${why}`);
      const dead = await this.confirmDead(e);
      if (dead !== null && dead !== 'moot') {
        void this.beginRestart(e, `${why}; then ${dead}`);
        throw this.restartingError(e);
      }
      if (e.restartP) throw this.restartingError(e);
      if (e.downWhy) throw this.controlDownError(e);
      if (e.status !== 'ready') throw this.downError(e, `WebDriverAgent is ${e.status === 'starting' ? 'still starting' : e.status}`);
      // WDA answers. Its session is kept when it still answers too; dropped when it's gone, or when it says nothing
      const sid = e.sessionId;
      if (sid) {
        let gone = sessionGone;
        if (!gone) {
          try {
            await this.raw(e, 'GET', `/session/${sid}`, undefined, this.timeouts.probe * 2);
          } catch (err) {
            gone = !(err instanceof WdaError) || err.down || err.kind === 'session' || (await this.sessionExpired(e, sid));
          }
        }
        if (gone && e.sessionId === sid) {
          e.sessionId = undefined;
          e.mjpegApplied = undefined;
        }
      }
      const wait = this.timeouts.sessionWait ?? SESSION_WAIT_MS;
      const made = () => within(this.session(e), wait, () => new WdaError('unreachable', `no session within ${Math.round(wait / 1000)} s`));
      try {
        await made();
      } catch (err) {
        // /status answers but no session: asked once more a moment later; still none (XCTest hung under it): only a
        // fresh runner fixes that
        await sleep(Math.min(1000, this.timeouts.probeEvery ?? PROBE_EVERY_MS));
        try {
          await made();
        } catch (err2) {
          if (!(err2 instanceof WdaError) || !err2.down || !e.wanted || e.status !== 'ready') throw err2;
          void this.beginRestart(e, `${why}; then /status answered but no session could be made, twice (${(err as Error).message}; ${err2.message})`);
          throw this.restartingError(e);
        }
      }
      e.lastOk = Date.now();
      this.setControl(e, 'ready');
      this.log(e, 'recovered');
    })();
    const p: Promise<void> = run.finally(() => {
      if (e.recovering === p) e.recovering = undefined;
    });
    e.recovering = p;
    return p;
  }

  /**
   * Restart the phone's WDA: one restart at a time per phone (every caller gets the same promise), attempts backed off
   * (`backoff`: 5 s, 15 s, 60 s) and capped (`attempts`), each step bounded (the runner's /status within `restart`, its
   * session within `sessionWait`). After the last attempt failed, control is "down" with the last error until a
   * recover, or WDA answering again. Every attempt goes to server.log with why, how it ended and how long it took.
   */
  private beginRestart(e: Entry, reason: string): Promise<void> {
    if (e.restartP) return e.restartP;
    if (!e.wanted || e.switching) return Promise.resolve();
    const epoch = e.epoch;
    const live = () => e.wanted && !e.switching && e.epoch === epoch;
    const max = this.maxAttempts;
    const backoff = this.timeouts.backoff ?? RESTART_BACKOFF_MS;
    const secs = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)} s`;
    e.downWhy = null;
    e.restartSince = Date.now();
    reason = this.clean(e, reason).slice(0, 400);
    const jamAfter = Math.max(1, this.timeouts.jamAfter ?? JAM_AFTER);
    const run = async (): Promise<void> => {
      let last = reason;
      /** Attempts in a row whose runner didn't come up (not a locked phone or a signing problem), and the reset made. */
      let stuck = 0;
      let reset = false;
      while (live()) {
        if (e.attempt >= max) {
          if (reset && stuck > 0) {
            // XCTest stays jammed after a reset of the device link too: only a replug fixes that; said so, not "recovering"
            e.needsReplug = true;
            e.downWhy = `needs replug: WebDriverAgent did not come back after ${max} restarts and a reset of the device link (last: ${last}); the phone's XCTest session looks jammed: unplug its USB cable and plug it back in`.slice(0, 500);
          } else {
            e.downWhy = `WebDriverAgent did not come back after ${max} restarts (last: ${last})`.slice(0, 400);
          }
          this.setControl(e, 'down');
          this.restartLog(e, `control down${e.needsReplug ? ' (needs replug)' : ''} after ${max} attempts in ${secs(e.restartSince)}: ${last}; it stays down until a recover, a replug, or WDA answering again`);
          return;
        }
        if (stuck >= jamAfter && !reset) {
          // the runner didn't come up `jamAfter` times in a row: restarting it once more the same way only adds to the
          // pile. The device link is reset first (one phone at a time), then the attempts go on
          reset = true;
          this.restartLog(e, `the runner did not come up ${stuck} times in a row: the XCTest session looks jammed; resetting the device link`);
          await this.exclusive(e, () => this.resetLink(e, live));
          if (!live()) return;
        }
        if (e.attempt > 0) {
          const wait = backoff[Math.min(e.attempt - 1, backoff.length - 1)] ?? 0;
          this.restartLog(e, `waiting ${(wait / 1000).toFixed(1)} s before attempt ${e.attempt + 1}/${max}`);
          // the last attempt's runner may still come up meanwhile: then WDA is back and nothing more is restarted
          if (await this.readyWithin(e, wait, live)) {
            e.attempt = 0;
            this.setControl(e, 'ready');
            this.restartLog(e, `WDA came back while waiting; restart done in ${secs(e.restartSince)}`);
            return;
          }
          if (!live()) return;
        }
        e.attempt++;
        const n = e.attempt;
        const t = Date.now();
        const why = n === 1 ? reason : `attempt ${n - 1} failed: ${last}`;
        this.restartLog(e, `attempt ${n}/${max}: restarting WDA (${why})`);
        this.healed(e, `restarting WDA (attempt ${n}/${max}): ${why}`);
        // one phone at a time: the old runner torn down for good, then the new one up (or given up on), then the next phone
        const r = await this.exclusive(e, async () => {
          if (!live()) return { ok: false, why: 'the phone was stopped' };
          this.restart(e);
          return this.awaitUp(e, this.timeouts.restart, live);
        });
        if (!live()) return;
        if (r.ok) {
          e.attempt = 0;
          this.setControl(e, 'ready');
          this.restartLog(e, `attempt ${n}/${max} ok: WDA is back in ${secs(t)} (${secs(e.restartSince)} since the restart began)`);
          return;
        }
        last = r.why;
        stuck = jammedStart(last) ? stuck + 1 : 0;
        this.restartLog(e, `attempt ${n}/${max} failed after ${secs(t)}: ${last}`);
      }
    };
    const p: Promise<void> = Promise.resolve()
      .then(run)
      .catch((err) => {
        // never expected (every step is bounded and caught); the phone is said to be down rather than left restarting
        this.restartLog(e, `the restart stopped: ${(err as Error)?.message ?? err}`);
        if (live()) {
          e.downWhy = `the restart stopped: ${(err as Error)?.message ?? err}`.slice(0, 400);
          this.setControl(e, 'down');
        }
      })
      .finally(() => {
        if (e.restartP === p) e.restartP = undefined;
      });
    e.restartP = p;
    return p;
  }

  /**
   * A software reset of the phone's device link, when its XCTest session looks jammed (the runner didn't come up
   * several times in a row): the runner and its forwards torn down and every stray for the phone killed (reap), the
   * WebDriverAgent runner app ended on the phone itself (devicectl: SIGTERM, then SIGKILL), the pairing re-validated
   * over usbmuxd (idevicepair), and a moment for the phone to settle. usbmuxd itself isn't restarted (that needs root).
   * Every step bounded and logged; nothing here throws.
   */
  private async resetLink(e: Entry, live: () => boolean): Promise<void> {
    const t0 = Date.now();
    this.killProcs(e);
    await this.settled(e);
    if (!live() || !this.sys.real) return void this.restartLog(e, `device link reset (runner and forwards ended) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // the runner app on the phone (XCTest's side), found by its executable
    const pids: number[] = [];
    fs.mkdirSync('data', { recursive: true });
    const file = path.resolve('data', `devicectl-processes-${e.udid.slice(-8)}.json`);
    try {
      const r = await this.sys.run('xcrun', ['devicectl', 'device', 'info', 'processes', '--device', e.udid, '--json-output', file], 30_000);
      const list = JSON.parse(fs.readFileSync(file, 'utf8'))?.result?.runningProcesses;
      for (const p of Array.isArray(list) ? list : []) {
        if (/WebDriverAgentRunner/i.test(String(p?.executable ?? '')) && Number.isInteger(p?.processIdentifier)) pids.push(p.processIdentifier);
      }
      if (!r.ok) this.restartLog(e, "devicectl could not list the phone's processes");
    } catch (err) {
      this.restartLog(e, `devicectl's process list could not be read (${(err as Error).message.slice(0, 120)})`);
    } finally {
      fs.rmSync(file, { force: true });
    }
    for (const pid of pids) await this.sys.run('xcrun', ['devicectl', 'device', 'process', 'terminate', '--device', e.udid, '--pid', String(pid)], 30_000);
    if (pids.length) {
      await sleep(2000);
      // SIGTERM can be ignored by a jammed runner: SIGKILL (an error when it's already gone is fine)
      for (const pid of pids) await this.sys.run('xcrun', ['devicectl', 'device', 'process', 'signal', '--device', e.udid, '--pid', String(pid), '--signal', 'SIGKILL'], 30_000);
    }
    const pair = await this.sys.run('idevicepair', ['-u', e.udid, 'validate'], 20_000);
    await sleep(3000);
    this.restartLog(e, `device link reset in ${((Date.now() - t0) / 1000).toFixed(1)} s: runner and forwards ended, ${pids.length ? `the runner app on the phone ended (pid ${pids.join(', ')})` : 'no runner app found on the phone'}, pairing ${pair.ok ? 'valid' : 'NOT validated'}`);
  }

  /** The runner just launched answers /status within `ms` and makes its session within `sessionWait`. */
  private async awaitUp(e: Entry, ms: number, live: () => boolean): Promise<{ ok: boolean; why: string }> {
    await this.settled(e); // the old runner's teardown first: the new one's clock starts when it's launched
    const until = Date.now() + ms;
    while (live() && e.status === 'starting' && Date.now() < until) await sleep(100);
    if (!live()) return { ok: false, why: 'the phone was stopped' };
    if (e.status === 'failed') return { ok: false, why: e.launchError ?? 'the runner ended before WDA answered' };
    if (e.status !== 'ready') return { ok: false, why: `WDA did not answer /status within ${Math.round(ms / 1000)} s` };
    const wait = this.timeouts.sessionWait ?? SESSION_WAIT_MS;
    try {
      await within(this.session(e), wait, () => new Error(`none within ${Math.round(wait / 1000)} s`));
      return { ok: true, why: '' };
    } catch (err) {
      return { ok: false, why: `WDA answers but made no session (${(err as Error).message})` };
    }
  }

  /** The last runner came up (and made its session) within `ms`. */
  private async readyWithin(e: Entry, ms: number, live: () => boolean): Promise<boolean> {
    const until = Date.now() + ms;
    while (live() && e.status !== 'ready' && Date.now() < until) await sleep(Math.max(1, Math.min(100, until - Date.now())));
    if (!live() || e.status !== 'ready') return false;
    return (await this.awaitUp(e, 0, live)).ok;
  }

  private async withRecovery<T>(udid: string, fn: (e: Entry) => Promise<T>): Promise<T> {
    const e = await this.usable(udid);
    e.inflight++;
    try {
      return await this.retryOnce(e, fn);
    } finally {
      e.inflight--;
    }
  }

  private async retryOnce<T>(e: Entry, fn: (e: Entry) => Promise<T>): Promise<T> {
    try {
      const r = await fn(e);
      e.lastOk = Date.now();
      return r;
    } catch (err) {
      if (!(err instanceof WdaError) || !err.down) throw this.named(e, err);
      // 2026-11-18: no answer in time may only be a slow WDA (or a long action still playing): never asked again (it
      // may yet happen on the phone) and never a restart by itself; WDA is checked in the background
      if (err.timeout) {
        void this.recover(e, err.message).catch(() => {});
        throw this.named(e, err);
      }
      try {
        await this.recover(e, err.message, err.kind === 'session');
      } catch (err2) {
        if (err2 instanceof HttpError && !(err2 instanceof WdaError)) throw err2; // restarting, or control down: a 503
        throw this.named(e, err2 instanceof WdaError ? err2 : err);
      }
      try {
        const r = await fn(e); // retry once
        e.lastOk = Date.now();
        return r;
      } catch (err3) {
        if (err3 instanceof WdaError && err3.down) void this.recover(e, err3.message).catch(() => {});
        throw this.named(e, err3);
      }
    }
  }

  /**
   * Asked for (POST /recover): WDA checked, and fixed as needed (a new session; a restart only when it's dead). A
   * recover during a restart joins it (never a second one); one while control is down starts the attempts afresh.
   * Waits for a restart at most `recoverWait`, then answers with the state as it is.
   */
  async recoverNow(udid: string): Promise<ControlState> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted) {
      const err = new WdaError('unreachable', `WDA session for ${this.nameOf(udid)} is down: WebDriverAgent is not running`);
      err.named = true;
      throw err;
    }
    const wait = this.timeouts.recoverWait ?? RECOVER_WAIT_MS;
    const join = async (p: Promise<void>): Promise<ControlState> => {
      await within(p, wait, () => new Error('wait')).catch(() => {});
      return this.state(udid);
    };
    if (e.restartP) {
      this.restartLog(e, `a recover was asked during attempt ${Math.max(1, e.attempt)}: it joins the restart under way`);
      return join(e.restartP);
    }
    if (e.downWhy || e.attempt) {
      this.restartLog(e, `a recover was asked${e.downWhy ? ` (control was down: ${e.downWhy})` : ''}: the attempts start afresh`);
      const was = e.downWhy;
      e.downWhy = null;
      e.needsReplug = false;
      e.attempt = 0;
      if (was && e.status !== 'ready' && !e.switching) return join(this.beginRestart(e, `a recover was asked while control was down (${was})`));
    }
    if (e.switching) return this.state(udid); // a switch of flavor owns the runner now
    if (e.status === 'failed') return join(this.beginRestart(e, 'a recover was asked while the runner was not running'));
    if (e.status === 'starting') return this.state(udid); // on its way up already
    try {
      await this.recover(e, 'requested by the client');
    } catch (err) {
      if (e.restartP) return join(e.restartP);
      if (err instanceof HttpError && !(err instanceof WdaError)) throw err;
      throw this.named(e, err);
    }
    return this.state(udid);
  }

  /**
   * Call a session-scoped WDA endpoint; on a WDA failure recover (new session / restarted runner) and retry once. A
   * refusal (a 4xx) that doesn't name the session is checked too: when WDA's session is no longer ours, ours expired
   * without WDA saying so in that answer, so a new one is made and the call asked once more.
   */
  call(udid: string, method: string, sub: string, body?: unknown, timeout = 30000): Promise<any> {
    return this.withRecovery(udid, async (e) => {
      const sid = await this.session(e);
      try {
        return await this.raw(e, method, `/session/${sid}${sub}`, body, timeout);
      } catch (err) {
        if (!(err instanceof WdaError) || err.down || !(await this.sessionExpired(e, sid))) throw err;
        this.healed(e, `the session expired (${err.message}); making a new one`);
        const r = await this.raw(e, method, `/session/${await this.session(e)}${sub}`, body, timeout);
        this.setControl(e, 'ready');
        return r;
      }
    });
  }

  /**
   * A quick read for the detail card: null unless WDA is up and not recovering right now; never waits for a start,
   * never recovers, never throws. `session`: a session route (asked only when a session exists).
   */
  async peek(udid: string, p: string, timeout = 2500, session = false): Promise<unknown> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted || e.status !== 'ready' || e.recovering) return null;
    if (session && !e.sessionId) return null;
    if (e.inflight > 0) return null; // WDA is busy with an action: a card's read never piles on top of it
    try {
      return (await this.raw(e, 'GET', session ? `/session/${e.sessionId}${p}` : p, undefined, timeout))?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A best-effort call that never heals (2026-11-16, for the lock): WDA must be ready already, nothing is waited for or
   * recovered, and any failure (a timeout, WDA's own "Timed out while waiting until the screen gets locked") comes back
   * as a plain rejection, so it never marks the session or the phone down.
   */
  async callSoft(udid: string, method: string, p: string, body?: unknown, timeout = 3000): Promise<any> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted || e.status !== 'ready' || e.recovering) throw new WdaError('rejected', `WebDriverAgent on ${this.nameOf(udid)} isn't ready`);
    try {
      return await this.raw(e, method, p, body, timeout);
    } catch (err) {
      if (err instanceof WdaError && err.kind === 'unknown') throw err; // an older WDA: the caller tries the session route
      throw new WdaError('rejected', (err as Error)?.message ?? String(err));
    }
  }

  /**
   * A Home press that never heals (2026-11-16, the wake of a dark phone): the session's pressButton, else the
   * session-less /wda/homescreen. Rejects like callSoft.
   */
  async homeSoft(udid: string, timeout = 4000): Promise<void> {
    const sid = this.entries.get(udid)?.sessionId;
    if (sid) {
      try {
        await this.callSoft(udid, 'POST', `/session/${sid}/wda/pressButton`, { name: 'home' }, timeout);
        return;
      } catch {
        /* the session-less route */
      }
    }
    await this.callSoft(udid, 'POST', '/wda/homescreen', {}, timeout);
  }

  callNoSession(udid: string, method: string, p: string, body?: unknown, timeout = 30000): Promise<any> {
    return this.withRecovery(udid, (e) => this.raw(e, method, p, body, timeout));
  }

  /** A read that never triggers a recovery (a slow /source on a heavy screen must not restart WDA). */
  private async read(udid: string, p: string, timeout: number): Promise<any> {
    const e = await this.usable(udid);
    e.inflight++;
    try {
      const r = await this.raw(e, 'GET', p, undefined, timeout);
      e.lastOk = Date.now();
      return r;
    } catch (err) {
      throw this.named(e, err);
    } finally {
      e.inflight--;
    }
  }

  /**
   * Is the phone's WDA really there? Asks the session itself (GET /session/:id: /status alone answers while the
   * session is long gone or XCTest under it is stuck), within the probe timeout, and heals what it finds: a session
   * that expired is remade, a WDA that doesn't answer is recovered (restarted when /status fails too), a WDA waiting
   * out a restart back-off is started now. True when WDA can take an action afterwards. One probe at a time per
   * phone; never throws. `reason` names who asked (logged with any heal).
   */
  probe(udid: string, reason: string): Promise<boolean> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted) return Promise.resolve(false);
    e.probeP ??= this.probeNow(e, reason)
      .catch(() => false)
      .finally(() => {
        e.probeP = undefined;
      });
    return e.probeP;
  }

  private async probeNow(e: Entry, reason: string): Promise<boolean> {
    // a restart under way, or control down after the restarts: nothing to probe, and nobody is kept waiting
    if (e.restartP || e.downWhy) return false;
    if (e.status === 'failed' && e.timer) {
      clearTimeout(e.timer);
      e.timer = undefined;
      this.healed(e, `${reason}: WDA was waiting to start again; starting it now`);
      this.launch(e);
    }
    if (e.status === 'starting') await this.waitReady(e, this.timeouts.startWait ?? START_WAIT_MS);
    if (e.recovering) await e.recovering.catch(() => {});
    if (e.status !== 'ready' || e.restartP || e.downWhy) return false;
    // something is on its way to WDA (a long gesture, a big /source, a screenshot, a lock, a card's read): WDA
    // works one thing at a time, so a probe now would only wait behind it and look like a hang; that request finds
    // out for itself.
    if (e.inflight > 0 || e.busy > 0) return true;
    const sid = e.sessionId;
    try {
      if (!sid) {
        await this.session(e);
      } else {
        e.inflight++;
        try {
          await this.raw(e, 'GET', `/session/${sid}`, undefined, this.timeouts.probe);
        } finally {
          e.inflight--;
        }
      }
      e.lastOk = Date.now();
      this.setControl(e, 'ready');
      return true;
    } catch (err) {
      if (!(err instanceof WdaError)) throw err;
      // no answer in time, once: WDA may only be busy. It counts as down after several in a row (missed())
      if (err.down && !this.missed(e, err)) return true;
      if (!sid) {
        await this.recover(e, `${reason}: no session could be made (${err.message})`);
      } else if (err.kind === 'session' || (!err.down && (await this.sessionExpired(e, sid)))) {
        this.healed(e, `${reason}: the session expired (${err.message}); making a new one`);
        if (e.sessionId === sid) {
          e.sessionId = undefined;
          e.mjpegApplied = undefined;
        }
        try {
          await this.session(e);
        } catch (err2) {
          await this.recover(e, `${reason}: no new session (${(err2 as Error).message})`);
        }
      } else if (!err.down) {
        // this WDA has no GET /session/:id (or refuses it) and the session is still its own: alive
        e.lastOk = Date.now();
        return true;
      } else {
        await this.recover(e, `${reason}: ${err.message}`);
      }
      e.lastOk = Date.now();
      this.setControl(e, 'ready');
      return true;
    }
  }

  /** What's on screen: WDA's accessibility tree as JSON (src/ui.ts flattens it). */
  async source(udid: string): Promise<unknown> {
    return (await this.read(udid, '/source?format=json', 25000))?.value ?? null;
  }

  /** The foreground app's bundle id, or null. */
  async activeApp(udid: string): Promise<string | null> {
    try {
      const v = (await this.read(udid, '/wda/activeAppInfo', 6000))?.value;
      return typeof v?.bundleId === 'string' && v.bundleId ? v.bundleId : null;
    } catch {
      return null;
    }
  }

  /** A hardware button (XCUIDevice's: volumeUp, volumeDown, home). */
  async pressButton(udid: string, name: ButtonName | 'home'): Promise<void> {
    await this.call(udid, 'POST', '/wda/pressButton', { name }, this.timeouts.input);
  }

  /**
   * Text through XCTest's keyboard (2026-11-18): the whole text is one event record the phone plays itself, key by key
   * at `keysPerSecond`, on the on-screen keyboard (each key's press and lift are played on the phone, so no delay on
   * the cable can hold a key down long enough for iOS to repeat it). Sent once only: never again after a recovery or
   * on a stale socket, since part of it may be typed already; only a refused session (nothing typed) is asked again.
   */
  async typeText(udid: string, text: string, keysPerSecond: number): Promise<void> {
    const e = await this.usable(udid);
    const timeout = 10000 + Math.ceil((text.length * 1000) / Math.max(1, keysPerSecond)) * 2;
    const body = { value: Array.from(text), frequency: Math.max(1, Math.round(keysPerSecond)) };
    e.inflight++;
    try {
      const sid = await this.session(e);
      try {
        await this.raw(e, 'POST', `/session/${sid}/wda/keys`, body, timeout, false);
      } catch (err) {
        // a session WDA no longer knows refused the request before typing anything: once more on a new one
        if (!(err instanceof WdaError) || err.kind !== 'session') throw err;
        e.sessionId = undefined;
        await this.raw(e, 'POST', `/session/${await this.session(e)}/wda/keys`, body, timeout, false);
      }
      e.lastOk = Date.now();
    } catch (err) {
      // never the text in a log or an answer (XCTest names its event after the first letters)
      const safe = err instanceof WdaError ? Object.assign(new WdaError(err.kind, scrubTyped(err.message, text)), { timeout: err.timeout }) : err;
      if (safe instanceof WdaError && safe.down) void this.recover(e, safe.message, safe.kind === 'session').catch(() => {});
      throw this.named(e, safe);
    } finally {
      e.inflight--;
    }
  }

  /**
   * The focused field (2026-11-18): read it, or with `clear` empty it in one go first. Our build (v4+) does it all on
   * the phone (POST /lotus/field); a stock WDA through its element routes: the active element, its clear, then select
   * all and one Delete when that left something (nextClearStep). Null when no field can be read; a clear that can't
   * be done here throws.
   */
  async field(udid: string, clear: boolean): Promise<FieldState | null> {
    const e = this.entries.get(udid);
    if (e && e.forkInfo && e.forkInfo.lotus >= FIELD_FORK_VERSION) {
      const v = (await this.callNoSession(udid, 'POST', FORK_ROUTES.field, { clear }, clear ? 20000 : 8000))?.value;
      return fieldFrom(v);
    }
    if (e && (e.forkInfo || e.flavor === 'fork' || e.token)) {
      // an older build of ours serves only the routes it knows: no element routes
      if (!clear) return null;
      throw new HttpError(501, `the WebDriverAgent build on ${this.nameOf(udid)} can't clear a field yet: the server installs the new one by itself, try again in a few minutes`);
    }
    const id = await this.activeElement(udid);
    if (!id) {
      if (clear) throw new HttpError(409, 'no field has the keyboard: tap the field first');
      return null;
    }
    let now = await this.readElement(udid, id);
    if (!clear) return now;
    const done: ClearStep[] = [];
    let step: ClearStep | null;
    while ((step = nextClearStep(now, done))) {
      done.push(step);
      if (step === 'element-clear') {
        await this.call(udid, 'POST', `/element/${id}/clear`, {}, 15000).catch(() => {});
      } else {
        // Cmd+A selects the whole field; one Delete empties it (a Delete after nothing was selected takes one letter)
        await this.call(udid, 'POST', '/wda/element/0/keyboardInput', { keys: [{ key: 'a', modifierFlags: 1 << 4 }] }, 8000);
        await this.call(udid, 'POST', '/wda/keys', { value: [''] }, 8000);
      }
      now = await this.readElement(udid, id);
    }
    const method = done.length ? done[done.length - 1]! : 'empty';
    return now ? { ...now, method, cleared: now.found && now.len === 0 } : { found: false, secure: false, len: null, method, cleared: false };
  }

  /** The id of the element with the keyboard (GET /element/active), or null. */
  private async activeElement(udid: string): Promise<string | null> {
    try {
      const v = (await this.call(udid, 'GET', '/element/active', undefined, 8000))?.value;
      // {ELEMENT: id} or the W3C form {"element-6066-…": id}: the one string in it
      const id = v?.ELEMENT ?? (v && typeof v === 'object' ? Object.values(v).find((x) => typeof x === 'string') : undefined);
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  }

  /** One element's type, value and placeholder as a field (a secure one keeps only its length). */
  private async readElement(udid: string, id: string): Promise<FieldState | null> {
    const attr = async (name: string) => {
      try {
        return (await this.call(udid, 'GET', `/element/${id}/attribute/${name}`, undefined, 6000))?.value ?? null;
      } catch {
        return undefined;
      }
    };
    const type = await attr('type');
    if (type === undefined) return null;
    const [value, placeholder] = [await attr('value'), await attr('placeholderValue')];
    return fieldFrom({ found: true, type, value, placeholder });
  }

  /** Whether this phone's WDA has the fast touch route (unknown until the first touch tries it). */
  fastStatus(udid: string): 'yes' | 'no' | 'unknown' {
    return this.entries.get(udid)?.fast ?? 'unknown';
  }

  /**
   * The patched WDA's fast route (docs/BEST_METHOD.md, plan item 1b): one touch path built at absolute coordinates
   * with no active-app lookup, queued on the phone and answered before XCTest plays it (the phone keeps the order).
   * False when this WDA build hasn't got it, or the phone isn't in portrait (the old routes turn the touch themselves;
   * WDA_FAST_LANDSCAPE=1 sends it here too, turned onto the panel as XCTest's portrait event record expects).
   */
  private async fast(udid: string, body: { points: PathPoint[]; hold?: number }): Promise<boolean> {
    const e = this.entries.get(udid);
    if (!e || e.fast === 'no' || process.env.WDA_FAST === '0') return false;
    const turned = !!e.orientation && e.orientation !== 'portrait';
    if (turned && (process.env.WDA_FAST_LANDSCAPE !== '1' || !e.screen)) return false;
    try {
      const up = e.screen ? uprightSize(e.screen, e.orientation) : null;
      const points = body.points.map(([x, y, t]) => {
        if (turned && up && e.screen) {
          const [px, py] = uprightToPanel(x / up.width, y / up.height, e.orientation);
          [x, y] = [px * e.screen.width, py * e.screen.height];
        }
        return [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(t)];
      });
      await this.callNoSession(udid, 'POST', gestureRoute(e.forkInfo ? 'fork' : 'stock'), gestureBody(points as PathPoint[], body.hold), Math.min(5000, this.timeouts.input));
      if (e.fast !== 'yes') this.log(e, e.forkInfo ? 'whole gestures go as one command each (our build)' : 'fast touch route answers (patched WDA)');
      e.fast = 'yes';
      e.fastFails = 0;
      return true;
    } catch (err) {
      if (err instanceof WdaError && err.kind === 'unknown') {
        e.fast = 'no';
        this.log(e, 'this WDA build has no fast touch route (rebuild it with scripts/build-wda.sh); using the XCTest route');
        return false;
      }
      if (err instanceof WdaError && !err.down) {
        // the route refused it: this touch goes the old way; after 3 in a row, every touch does until WDA restarts
        if (++e.fastFails >= 3) e.fast = 'no';
        this.log(e, `fast touch route refused a touch (${err.message})${e.fast === 'no' ? '; using the XCTest route from now on' : ''}`);
        return false;
      }
      throw err;
    }
  }

  /** Tap: the fast route, else /wda/tap, else the older /wda/tap/0, else a W3C pointer tap. */
  async tap(udid: string, x: number, y: number, holdMs?: number): Promise<'wda-fast' | 'wda'> {
    const hold = holdMs && holdMs > 0 ? Math.round(holdMs) : undefined;
    if (await this.fast(udid, { points: [[x, y, 0]], hold: hold ?? FAST_TAP_HOLD_MS })) return 'wda-fast';
    const e = this.entries.get(udid);
    const unknown = (err: unknown) => err instanceof WdaError && err.kind === 'unknown';
    if (!e || e.tapRoute === 0) {
      try {
        await this.call(udid, 'POST', '/wda/tap', { x, y }, this.timeouts.input);
        return 'wda';
      } catch (err) {
        if (!unknown(err)) throw err;
        if (e) e.tapRoute = 1;
      }
    }
    if (!e || e.tapRoute <= 1) {
      try {
        await this.call(udid, 'POST', '/wda/tap/0', { x, y }, this.timeouts.input);
        return 'wda';
      } catch (err) {
        if (!unknown(err)) throw err;
        if (e) e.tapRoute = 2;
      }
    }
    await this.w3c(udid, [[x, y, 0], [x, y, hold ?? 50]]);
    return 'wda';
  }

  /** One finger through the points with their real timing: the fast route, else W3C actions. */
  async actions(udid: string, pts: PathPoint[]): Promise<'wda-fast' | 'wda'> {
    if (await this.fast(udid, { points: pts })) return 'wda-fast';
    await this.w3c(udid, pts);
    return 'wda';
  }

  /**
   * W3C actions: one finger, pointerDown ... pointerUp. 2026-11-17: when the request fails or times out partway, the
   * input state is released (DELETE /session/:id/actions: every pointer still down is lifted), so a gesture that
   * broke off never leaves a finger on the screen.
   */
  private async w3c(udid: string, pts: PathPoint[]): Promise<void> {
    const ms = pts[pts.length - 1]![2];
    const actions = [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: pointerActions(pts) }];
    try {
      await this.call(udid, 'POST', '/actions', { actions }, this.timeouts.input + ms);
    } catch (err) {
      await this.releaseActions(udid);
      throw err;
    }
  }

  /** Best effort: lift whatever W3C actions left down (DELETE /session/:id/actions); never recovers anything. */
  async releaseActions(udid: string): Promise<void> {
    const sid = this.entries.get(udid)?.sessionId;
    if (!sid) return;
    await this.callSoft(udid, 'DELETE', `/session/${sid}/actions`, undefined, 3000).catch(() => {});
  }

  /** Every ~10 s per phone: /status; recover before the owner notices. Skipped right after a successful action. */
  private healthCheck(): void {
    for (const e of this.entries.values()) {
      if (!e.wanted || e.status !== 'ready' || e.recovering || e.restartP || e.downWhy || e.checking) continue;
      if (e.sessionId && Date.now() - Math.max(e.lastOk, e.lastAnswer) < HEALTH_MS - 1000) continue; // it answered lately
      if (e.inflight > 0 || e.busy > 0) continue; // busy with something: that request finds out for itself
      e.checking = true;
      if (this.watched?.(e.udid)) {
        // someone is looking at this phone: ask the session itself, not just /status
        void this.probe(e.udid, 'health check').finally(() => {
          e.checking = false;
        });
        continue;
      }
      void (async () => {
        const st = await this.ping(e, 3000);
        if (!st.ok) {
          // once isn't down: several in a row are (a /status that waited behind a slow request answers the next time)
          const quiet = new WdaError('unreachable', '/status did not answer');
          quiet.timeout = true;
          if (this.missed(e, quiet)) await this.recover(e, 'health check: /status did not answer').catch(() => {});
          return;
        }
        e.lastOk = Date.now();
        if (e.sessionId && st.sessionId && st.sessionId !== e.sessionId) {
          this.healed(e, 'health check: the session was replaced on the phone; making a new one');
          e.sessionId = undefined;
        }
        if (!e.sessionId) {
          try {
            await this.session(e);
          } catch (err) {
            await this.recover(e, `health check: ${(err as Error).message}`).catch(() => {});
            return;
          }
        }
        this.setControl(e, 'ready');
      })().finally(() => {
        e.checking = false;
      });
    }
  }

  // ---- our build only: live touch, stills, the self-test ----

  /** A point of the upright screen as our build's portrait record wants it (turned onto the panel in landscape). */
  private panel(e: Entry, x: number, y: number): [number, number] {
    const turned = !!e.orientation && e.orientation !== 'portrait';
    if (turned && e.screen) {
      const up = uprightSize(e.screen, e.orientation);
      const [px, py] = uprightToPanel(x / up.width, y / up.height, e.orientation);
      [x, y] = [px * e.screen.width, py * e.screen.height];
    }
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }

  /**
   * Why this phone's WDA can't hold a finger down across requests right now, or null when it can: our build is up,
   * its self-test found a working mode (src/fork.ts), nothing broke since, and the phone is in portrait (or
   * WDA_FAST_LANDSCAPE=1). WDA_LIVE_TOUCH=off turns it off; segmented drags (modes 4-5) only with WDA_LIVE_TOUCH=segmented (2026-11-17).
   */
  liveWhy(udid: string): string | null {
    const e = this.entries.get(udid);
    if ((this.cfg.wdaLiveTouch ?? 'auto') === 'off') return 'live touch through WebDriverAgent is turned off (WDA_LIVE_TOUCH=off)';
    if (!e || e.status !== 'ready' || !e.forkInfo) return 'the stock WebDriverAgent cannot hold a finger down between requests: the drag plays on "up" (our own build can)';
    if (e.liveFailed) return `live touch stopped working on this phone (${e.liveFailed}): the drag plays on "up"`;
    if (!this.liveModeOf(udid)) {
      // 2026-11-17: segmented drags (modes 4-5) broke quick swipes and could leave a touch down: opt-in only
      const found = this.fork?.liveMode(udid) ?? 0;
      if (found >= LIVE_SEGMENTED) return 'this phone can only do segmented drags, which break quick swipes: the touch plays whole on "up" (liveTouch "segmented" turns them on)';
      return 'the self-test on this phone found no way to hold a finger down (or has not run yet): the drag plays on "up"';
    }
    if (e.orientation && e.orientation !== 'portrait' && process.env.WDA_FAST_LANDSCAPE !== '1') return `live touch is portrait only here and the phone is ${e.orientation}: the drag plays on "up"`;
    return null;
  }

  /** The mode the owner's live touch uses on this phone (src/fork.ts usableLiveMode): 0 plays it whole on "up". */
  private liveModeOf(udid: string): number {
    return usableLiveMode(this.fork?.liveMode(udid) ?? 0, this.cfg.wdaLiveTouch ?? 'auto');
  }

  /**
   * One event of a live touch to our build (POST /lotus/touch): the finger stays down on the phone between requests.
   * Never recovers or restarts anything: a failure throws, and the caller lifts and says so.
   */
  async liveTouch(udid: string, phase: 'down' | 'move' | 'up', x: number, y: number): Promise<void> {
    const e = this.entries.get(udid);
    const why = this.liveWhy(udid);
    if (!e || why) throw new HttpError(503, why ?? 'WebDriverAgent is not running for this phone');
    const mode = this.liveModeOf(udid);
    const at = this.panel(e, x, y);
    if (mode === LIVE_SEGMENTED || mode === LIVE_GAPPED) {
      // 2026-11-17: no finger can stay down between XCTest's records on iOS 18: the drag goes in short whole
      // gestures as it happens (src/segments.ts), each starting where the last ended; mode 5 (fork v3) with the
      // pause between two segments the phone's self-test found (iOS 18.5 lost one of two back-to-back segments)
      const seg = (e.seg ??= new Segmenter((points, hold, gap) => this.raw(e, 'POST', FORK_ROUTES.gesture, gestureBody(points, hold, gap), LIVE_TOUCH_TIMEOUT_MS)));
      if (phase === 'down') {
        if (seg.isDown) await seg.up(at[0], at[1]).catch(() => {});
        seg.gapMs = mode === LIVE_GAPPED ? this.fork?.liveGap?.(udid) ?? 0 : 0;
        return seg.down(at[0], at[1]);
      }
      return phase === 'move' ? seg.move(at[0], at[1]) : seg.up(at[0], at[1]);
    }
    const v = (await this.raw(e, 'POST', FORK_ROUTES.touch, liveBody(phase, at, mode), LIVE_TOUCH_TIMEOUT_MS))?.value;
    if (typeof v?.failed === 'string' && v.failed) {
      // XCTest refused (or never answered) a live record: not used again until the runner restarts. Whatever of the
      // touch did reach the screen is lifted now (the phone would lift it by itself only after its own 10 s).
      if (phase !== 'up') void this.raw(e, 'POST', FORK_ROUTES.touch, liveBody('up', at, mode), LIVE_TOUCH_TIMEOUT_MS).catch(() => {});
      e.liveFailed = v.failed.slice(0, 160);
      this.log(e, `live touch failed on the phone (${e.liveFailed}); drags play whole from now on`);
      throw new HttpError(502, `the phone could not play the live touch (${e.liveFailed})`);
    }
  }

  /**
   * After a switch to our build: does it do the work, not just answer? A session could be made, the screen's size is
   * known, and a still comes. Null when it does; else what's missing (the caller puts the stock one back).
   */
  async forkWorks(udid: string, waitMs = 20_000): Promise<string | null> {
    const e = this.entries.get(udid);
    if (!e || !e.forkInfo) return "our build isn't up";
    const until = Date.now() + waitMs;
    while (Date.now() < until && e.status === 'ready' && !(e.sessionId && e.screen)) {
      await this.session(e).catch(() => {});
      if (!(e.sessionId && e.screen)) await sleep(500);
    }
    if (e.status !== 'ready') return 'its runner stopped right after it started';
    if (!e.sessionId) return 'it answers, but no session could be made';
    if (!e.screen) return "it answers, but doesn't say the screen's size";
    try {
      const jpeg = await this.shot(udid, 25, 40, 10_000);
      if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return 'its still is not a JPEG';
    } catch (err) {
      return `it gave no still (${(err as Error).message})`;
    }
    this.setControl(e, 'ready');
    return null;
  }

  /** One still as a JPEG from our build (GET /lotus/shot), `scale` and `quality` 1-100; never recovers anything. */
  async shot(udid: string, scale: number, quality: number, timeout = 8000): Promise<Buffer> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted || e.status !== 'ready' || !e.forkInfo) throw new WdaError('rejected', `our WebDriverAgent build isn't up on ${this.nameOf(udid)}`);
    const v = (await this.raw(e, 'GET', `${FORK_ROUTES.shot}?scale=${Math.round(scale)}&quality=${Math.round(quality)}`, undefined, timeout))?.value;
    if (typeof v?.jpeg !== 'string' || !v.jpeg) throw new WdaError('rejected', 'the phone gave no still');
    return Buffer.from(v.jpeg, 'base64');
  }

  /** The phone's own live-touch self-test (POST /lotus/selftest, our build): which way of holding a finger down works. */
  async selftest(udid: string): Promise<{ tested: boolean; mode: number; why?: string | null; notes?: string[]; modes?: { mode: number; works: boolean; why: string | null }[] }> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted || e.status !== 'ready' || !e.forkInfo) return { tested: false, mode: 0, why: "our WebDriverAgent build isn't up on the phone" };
    e.inflight++;
    try {
      const v = (await this.raw(e, 'POST', FORK_ROUTES.selftest, {}, 40_000))?.value;
      return {
        tested: v?.tested === true, mode: Number.isInteger(v?.mode) ? v.mode : 0, why: typeof v?.why === 'string' ? v.why : null,
        notes: Array.isArray(v?.notes) ? v.notes.filter((n: unknown) => typeof n === 'string') : undefined,
        // 2026-11-17 (v2): each mode's result
        ...(Array.isArray(v?.modes) ? { modes: v.modes } : {}),
      };
    } catch (err) {
      return { tested: false, mode: 0, why: (err as Error).message };
    } finally {
      e.inflight--;
    }
  }

  /** Every runner and forward ended (their WDA sessions deleted first); resolves once they're gone, at most `ms`. */
  async shutdown(ms = 8000): Promise<void> {
    clearInterval(this.health);
    const all = [...this.entries.values()];
    for (const e of all) {
      e.wanted = false;
      e.epoch++;
      this.killProcs(e);
    }
    await Promise.all(all.map((e) => this.settled(e, ms)));
  }
}
