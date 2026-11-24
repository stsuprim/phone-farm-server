import { ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Config } from './config.js';
import { ClearStep, FieldState, fieldFrom, nextClearStep, scrubTyped } from './field.js';
import { isNamed, KeyPress, modFlags, NAMED } from './keys.js';
import { FIELD_FORK_VERSION, FORK_ROUTES, ForkLaunch, KEYS_FORK_VERSION, launchPlan, LIVE_GAPPED, LIVE_SEGMENTED, TOKEN_ENV, TOKEN_HEADER, usableLiveMode, WdaFlavor } from './fork.js';
import { isLandscape, Orientation, orientationFromWda, uprightSize, uprightToPanel } from './orient.js';
import { LaneBusy, LanePrio, LaneState, routeLabel, routePriority, WdaLane } from './lane.js';
import { knownScreen, pickScreen, saneSize, ScreenPick } from './screens.js';
import { Segmenter } from './segments.js';
import { ButtonName, ControlState, HttpError, PathPoint, ScreenInfo, StreamSettings } from './types.js';

export type WdaStatus = 'starting' | 'ready' | 'failed' | 'stopped';

/**
 * unreachable/session = WDA (or its session) is down and worth a recovery + retry; server = WDA answered with an
 * error of its own (a 5xx: "Cannot take a screenshot within ... timeout"): it's there, it only failed that request;
 * rejected = WDA answered but refused the request; unknown = WDA doesn't have that endpoint.
 */
type Kind = 'unreachable' | 'session' | 'server' | 'rejected' | 'unknown';

export class WdaError extends HttpError {
  named = false;
  /** No answer came in time (WDA may only be busy: it works one request at a time), rather than a refused connection. */
  timeout = false;
  /**
   * 2026-11-22: the connection itself failed (refused, reset, broken pipe): nothing on the phone took it. A busy WDA
   * still takes connections (its listener isn't on the main queue), so this is WDA's process (or its forward) gone.
   */
  conn = false;
  constructor(public kind: Kind, message: string) {
    super(502, message);
  }
  /**
   * 2026-11-21: a 5xx is no longer "down". WDA's own error (an XCTest screenshot that timed out on the phone) was
   * taken for a dead WDA: a recovery, whose session check and new session then waited behind the same stuck work,
   * and a runner restart after it (iPhone-1: six recoveries, six restarts, "Control down"). An answer is an answer.
   */
  get down(): boolean {
    return this.kind === 'unreachable' || this.kind === 'session';
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
  /** What the log last said of the screen (said again only when it changes), and reads tried again since the last good one. */
  screenSaid?: string;
  screenTries?: number;
  /** A session has been made on this runner (the first one since it started tells onSession it's fresh). */
  runnerSession?: boolean;
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
  /**
   * 2026-11-21: /status and /lotus/info on connections of their own (both answer off WDA's main queue): a liveness
   * ask never waits for a socket behind requests the phone is slow with (6 of them filled the one agent, busy:6, and
   * /status "never answered" while WDA was fine).
   */
  direct: http.Agent;
  /** 2026-11-21: every request to this phone's WDA, one at a time (src/lane.ts). */
  lane: WdaLane;
  /** Self-heals so far (a session remade, WDA restarted, a forward respawned), and the last one with its reason. */
  heals: number;
  lastHeal: HealRecord | null;
  /** Actions and reads on their way to WDA now (a quiet read skips while one is: WDA takes one thing at a time). */
  inflight: number;
  /** A liveness probe in progress (shared by everyone asking). */
  probeP?: Promise<boolean>;
  /** When WDA last answered anything at all, whatever it said (Date.now()). */
  lastAnswer: number;
  /** ...and anything that went through the lane (WDA's main queue and XCTest: not /status, which answers off it). */
  laneAnswer: number;
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
  /**
   * 2026-11-21 (2): the app in front stopped answering accessibility reads (appBound): until when no background read
   * of it is sent, how long the current pause is (it doubles while it keeps happening), since when, and why.
   */
  stallUntil: number;
  stallMs: number;
  stallSince: number;
  stallWhy: string | null;
  /** When a touch, key or other input was last sent, and how many were sent so far. */
  inputAt: number;
  inputSeq: number;
  /**
   * The app in front as last known, and how (2026-11-22: never asked in the background): an explicit read of Lotus's
   * (/wda/activeAppInfo), the server's own launch of an app, or a Home press. `appAt`: when.
   */
  appInfo?: unknown;
  appAt: number;
  /** inputSeq when the app in front became known (any input after it may have changed it). */
  appSeq: number;
  appFrom: 'read' | 'launch' | 'home' | null;
  /** 2026-11-22: reads of the app in front sent (only ever Lotus's own, asked for), refused (anyone else), and stuck. */
  appReads: { sent: number; refused: number; stuck: number };
  /** Reads of the app in front on their way or held for their late answer now (one at most). */
  appInFlight: number;
  /** Where the orientation came from: an explicit read of the app, or the live picture's shape. */
  orientFrom: 'read' | 'picture' | null;
  /**
   * 2026-11-22: a connection to WDA failed (refused or reset) and WDA is being checked: until that's over, every call
   * is answered at once with "reconnecting" (never queued behind the check, then failed: the owner's touches waited
   * 10 s for "restarting" on iPhone-1).
   */
  linkDown: { since: number; why: string } | null;
  /** The runner's xcodebuild output, its last lines (what XCTest said when the runner ended), token-free. */
  xcodeTail: string[];
  /** How the last runner ended or was given up on: when, why, what xcodebuild said last, and what was on its way. */
  lastRunnerEnd: RunnerEnd | null;
  /** Where the screen's size came from: once it's the screen's own (/wda/screen), it's kept and never asked again. */
  screenFrom?: 'screen' | 'window' | 'model' | 'previous';
  /** 2026-11-21: this runner holds the farm's xcodebuild start turn (cleared once it's up, ended or killed). */
  spawnTurn?: () => void;
  /** The runner ended while the phone was off the USB list for a moment: started again once it's back (setPresent). */
  awaitingUsb?: string;
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

/**
 * 2026-11-22: how a runner ended (its xcodebuild exited) or was given up on (a restart began): the evidence of why,
 * kept in the phone's stats (`wda_link.lastRunnerEnd`): what xcodebuild said last (XCTest names a crash, a kill, a
 * lost device there), the request that was on its way, and how long before it the live view's capture started or
 * stopped (its USB configuration change drops the phone off USB for a moment).
 */
export interface RunnerEnd {
  at: number;
  why: string;
  xcodebuild: string[];
  inFlight: string | null;
  captureStartedMsBefore: number | null;
  captureStoppedMsBefore: number | null;
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
  /**
   * A request whose caller stopped waiting (no answer in its time) still holds the phone's lane this long more for
   * the phone's late answer (ms; default HOLD_MS); with none by then it's given up and WDA is checked.
   */
  hold?: number;
  /** How long a touch or a read may wait for its turn in the lane before it's dropped unsent (ms; default LANE_WAIT_MS). */
  laneWait?: number;
  /**
   * 2026-11-21 (2): an orientation read's time (ms) and (2026-11-22) every other explicit read of the app in front's
   * (ms; default APP_READ_MS: the tree 12 s, the app 3 s, an element 6 s, the size 3 s).
   */
  orient?: number;
  appRead?: number;
  /** The first pause of background reads of an app that doesn't answer accessibility, and the longest (ms; STALL_MS, STALL_MAX_MS). */
  stall?: number;
  stallMax?: number;
  /** No background read of the app in front this long after a touch (ms; default INPUT_QUIET_MS). */
  inputQuiet?: number;
  /** A starting runner keeps the other phones' xcodebuild starts waiting this long at most (ms; default SPAWN_HOLD_MS, never above `restart`). */
  spawnHold?: number;
  /** A restart attempt waits this long at most for a phone that's off the USB list for a moment (ms; default USB_WAIT_MS). */
  usbWait?: number;
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
/**
 * 2026-11-21 (iPhone-1's runner died with "xcodebuild exited (65): ... CoreDeviceCLISupport.DiagnoseError" the
 * moment the owner switched the Phones page to iPhone-2): restarts already went one phone at a time, but a runner's
 * first start (a phone found by the poll, or found again after a blip) and a relaunch after xcodebuild exited went
 * straight on, beside another phone's xcodebuild in the middle of its own start (installing, launching the runner
 * through CoreDevice). Now every xcodebuild start on the farm takes its turn: the next one waits until this one's
 * WDA answers, its xcodebuild ends, or SPAWN_HOLD_MS (never longer than a restart is given).
 */
export const SPAWN_HOLD_MS = 30_000;
/**
 * A phone off the USB list for a moment (src/presence.ts: its screen capture starting re-enumerates it) isn't dead:
 * no recover restarts it meanwhile, and a restart attempt waits up to USB_WAIT_MS for it to be back before it launches
 * a runner (one launched at a phone that isn't there fails at once and only uses up an attempt).
 */
export const USB_WAIT_MS = 20_000;
/**
 * 2026-11-21, the lane (src/lane.ts): a request the Mac stopped waiting for keeps the phone's lane until the phone
 * answers it, HOLD_MS at most (XCTest's own waits end within a minute: a still's 20 s, a main run loop's 60 s); with
 * no answer at all by then WDA is checked (recover: /status, the session; restarted only when it's really gone). A
 * touch or a read waits LANE_WAIT_MS at most for its turn, then it's dropped unsent with a "busy" answer; a quiet
 * read (the orientation poll, the card, a probe) waits QUIET_WAIT_MS behind another quiet one, and never behind
 * anything else (it's skipped).
 */
export const HOLD_MS = 60_000;
export const LANE_WAIT_MS = 8000;
export const QUIET_WAIT_MS = 2000;
/**
 * 2026-11-21 (2), "it was working just fine, now it is showing this" (iPhone-1 with TikTok's For You feed playing:
 * window/size 55 s, then /wda/locked 10 s and 43 s, the owner's swipes "busy" and "no answer within 5s"). Some of
 * WDA's routes read the APP IN FRONT through accessibility on the phone (its orientation, window, the active app's
 * name, /wda/screen's orientation, the tree): XCTest asks the app itself, and an app that's busy all the time (a video
 * feed) answers those reads late or not at all, with XCTest's own retries on top (tens of seconds; WDA's
 * accessibilityDeadline, the bound for that, is off by default). WDA runs every route but /status, /screenshot and
 * /lotus/shot|info on the phone's ONE main queue, so a stuck read holds everything behind it, the owner's
 * /lotus/gesture included: /wda/locked itself is one static flag, so its 43 s were spent waiting behind such a read.
 * And the server sent such reads all the time in the background: the orientation poll every 3 s while watched, the
 * card's /wda/activeAppInfo, three more (window/size, /wda/screen, orientation) with every new session and three
 * retries of them, and a recovery that dropped a session that was only busy (making a new one and three more reads).
 * Each held the phone's lane until the phone answered (up to HOLD_MS), so the phone never came free.
 *
 * Now: WDA bounds such a read on the phone (ACCESSIBILITY_DEADLINE_S, a session capability and setting); a read of
 * the app in front that isn't answered in time (or that WDA's deadline cut short) marks the app as stalled, and while
 * it is (STALL_MS, doubling up to STALL_MAX_MS while it keeps happening; cleared by the first quick answer) no
 * background read of the app is sent at all: the orientation, the app's name and the size come from what's known;
 * nor for INPUT_QUIET_MS after a touch (the phone is being used). The screen's size is read once per phone and kept.
 */
export const ACCESSIBILITY_DEADLINE_S = 4;
export const STALL_MS = 60_000;
export const STALL_MAX_MS = 5 * 60_000;
export const INPUT_QUIET_MS = 10_000;
/**
 * 2026-11-22, the root cause behind iPhone-1 breaking "after a few touches" in TikTok, every time: the pauses above
 * only delayed the background reads of the app in front. The detail card's /wda/activeAppInfo still went out each time
 * its 10-s quiet window or its stall pause ran out, and the orientation was still asked when a live view opened and
 * with every new session. WDA answers /wda/activeAppInfo on its one main thread with an accessibility hit-test into the
 * app (FBActiveAppDetectionPoint: the accessibilityDeadline doesn't cover it), which TikTok's feed never answers: the
 * main thread hung (still waiting 15.5 s later), the lane held it a minute, the owner's touches behind it failed, and
 * the runner's process was then gone (/status refused, ECONNRESET, while the phone stayed on USB and its forward up).
 *
 * Now the server never reads the app in front on its own: no card read, no orientation poll, no read at a live view's
 * start, none with a new session or a recovery. Only Lotus's own explicit reads (the UI tree for phones_read and
 * tap-element, the focused field for typing) may, each bounded (APP_READ_MS), one at a time, never while that app is
 * known not to answer, and never in a touch's way (it yields: src/lane.ts). The app's name comes from what was last
 * known (an explicit read, the server's own launch, Home); the orientation from the live picture's shape.
 */
export const APP_READ_MS = { tree: 12_000, app: 3000, orientation: 3000, element: 6000, size: 3000 } as const;
/** A refused or reset connection gets this long to come right (a forward restarted, a stale socket) before the call says "reconnecting". */
export const QUICK_RECOVER_MS = 1500;
/** /status asked this often when the connections themselves fail (WDA's process gone: ~6 s, not ~12; a phone re-enumerating on USB is back within it). */
export const CONN_PROBE_EVERY_MS = 2000;
/** Lines of the runner's xcodebuild output kept for the record of how it ended. */
const XCODE_TAIL = 40;
/** A read of the app in front answered within this long means the app answers accessibility again. */
const APP_OK_MS = 2500;
/** Requests that bring another app to the front (so a stall of the one before no longer counts). */
const APP_SWITCH_RE = /^POST (\/session\/:id)?\/wda\/(homescreen|apps\/(launch|activate|terminate))$/;
/** The Home Screen's bundle id (what the card says after a Home press). */
const SPRINGBOARD = 'com.apple.springboard';
/** WDA's own words when its accessibilityDeadline cut a read short (XCAXClient_iOS+FBSnapshotReqParams.m, #1210). */
const DEADLINE_RE = /main run loop is responsive|likely in an unresponsive state|Aborting the accessibility snapshot/i;

/**
 * Whether a WDA route's handler reads the app in front through accessibility on the phone (an XCTest snapshot or
 * attribute of the app, which an app busy all the time can leave unanswered for tens of seconds), as opposed to
 * routes that never ask the app: /status, /session/:id, /wda/locked (a flag), /wda/batteryInfo, /wda/device/info,
 * buttons, Home, lock, stills, /lotus/gesture (built at absolute coordinates, no lookup of the app).
 */
export function appBound(method: string, p: string): boolean {
  const route = p.split('?')[0]!.replace(/^\/session\/[^/]+/, '').replace(/\/+$/, '');
  if (/^\/(element|elements)(\/|$)/.test(route) || /^\/wda\/element\//.test(route)) return true;
  if (method !== 'GET') return route === '/lotus/field';
  return /^\/(orientation|rotation|window\/(size|rect)|window|source|wda\/screen|wda\/activeAppInfo|wda\/apps\/list)$/.test(route);
}

/** A check whether WDA is dead waits this long at most for the request of ours still with the phone to be over. */
const DRAIN_MS = 15_000;
/** An explicit orientation ask waits this long at most for its turn (it's only part of a UI read). */
const FRESH_ORIENT_WAIT_MS = 4000;
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

const newAgent = (maxSockets = 6) => new http.Agent({ keepAlive: true, maxSockets });
type HttpErr = Error & { code?: string };
/** The connection itself failed: refused, reset or broken (nothing on the phone took the request). */
const connFailed = (x: HttpErr): boolean => /^(ECONNRESET|ECONNREFUSED|EPIPE|ENOTCONN|ECONNABORTED|EHOSTUNREACH)$/.test(x.code ?? '') || /socket hang up/i.test(x.message ?? '');
type Resp = { status: number; text: string };

/** How a request goes: its turn in the lane (default by its route), how long it may wait, or straight past the lane. */
interface Via {
  prio?: LanePrio;
  maxWait?: number;
  /** /status, /lotus/info: off WDA's main queue, on connections of their own, never in the lane. */
  bypass?: boolean;
  /** false: no wait for a late answer (the request is dropped at its timeout and frees the lane at once). */
  hold?: boolean;
  /**
   * 2026-11-22: Lotus asked for this read of the app in front itself (the UI tree, the focused field). A read of the
   * app in front (appBound) without it is never sent, by anyone: the server never reads that app on its own.
   */
  explicit?: boolean;
}

/** What a caller outside may say of a call: Lotus asked for it (a read of the app in front may then go). */
export type CallVia = { explicit?: boolean };

/**
 * One HTTP exchange with WDA. `result`: the answer, or a TIMEOUT error after `timeout` (or the error it failed with);
 * `ended`: once the exchange is really over. After a timeout the request is kept open `holdMs` more for the phone's
 * late answer (it still runs there; `onAnswer` is told when it comes, as for any answer); with none by then it's
 * destroyed and `onStuck` is told. A request that failed on a reused keep-alive connection the other side had already closed is sent once
 * more on a fresh one (unless `resend` is false: typing), so a stale socket never looks like WDA being down.
 */
export function exchange(o: {
  port: number; method: string; path: string; body?: string; headers: Record<string, string | number>; agent: http.Agent;
  timeout: number; holdMs: number; resend: boolean; onAnswer: () => void; onStuck?: (ms: number) => void;
}): { result: Promise<Resp>; ended: Promise<void> } {
  let tellOk!: (r: Resp) => void;
  let tellErr!: (e: Error) => void;
  const result = new Promise<Resp>((a, b) => {
    tellOk = a;
    tellErr = b;
  });
  let endNow!: () => void;
  const ended = new Promise<void>((a) => (endNow = a));
  const t0 = Date.now();
  let told = false;
  let over = false;
  let live: http.ClientRequest | null = null;
  let hold: NodeJS.Timeout | undefined;
  const tell = (v: Resp | Error) => {
    if (told) return;
    told = true;
    clearTimeout(timer);
    if (v instanceof Error) tellErr(v);
    else tellOk(v);
  };
  const end = () => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    if (hold) clearTimeout(hold);
    endNow();
  };
  const timer = setTimeout(() => {
    const err = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    tell(err);
    if (o.holdMs <= 0 || !live) return void live?.destroy(err);
    // the phone still works on it: the lane stays taken until it answers (or this cap)
    hold = setTimeout(() => {
      o.onStuck?.(Date.now() - t0);
      live?.destroy(Object.assign(new Error('given up'), { code: 'ABANDONED' }));
    }, o.holdMs);
    hold.unref?.();
  }, o.timeout);
  const send = (retried: boolean) => {
    const req = http.request({ host: '127.0.0.1', port: o.port, path: o.path, method: o.method, agent: o.agent, headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (live !== req) return;
        o.onAnswer(); // any answer at all, whatever it says and however late: WDA is there
        tell({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        end();
      });
      res.on('error', (err) => fail(err as HttpErr));
    });
    live = req;
    const fail = (err: HttpErr) => {
      if (live !== req || over) return;
      const stale = !told && !retried && o.resend && req.reusedSocket && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || /socket hang up/i.test(err.message));
      if (stale) return send(true);
      tell(err);
      end();
    };
    req.on('error', fail);
    req.on('close', () => {
      // closed without an answer or an error (it never should): over, the lane is free
      if (live === req && !over) fail(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    });
    req.on('socket', (s) => s.setNoDelay(true));
    req.end(o.body);
  };
  send(false);
  return { result, ended };
}

const PORTS_FILE = path.join('data', 'ports.json');
const HEALTH_MS = 10000;
const DEFAULT_MJPEG: StreamSettings = { fps: 60, quality: 50, scale: 50 };
// No waiting for the app to be idle/animations to finish before each action: that's what made taps slow.
// 2026-11-21 (2): accessibilityDeadline bounds a read of an app that doesn't answer accessibility (ACCESSIBILITY_DEADLINE_S).
const CAPS = { shouldWaitForQuiescence: false, waitForIdleTimeout: 0, shouldUseCompactResponses: true, maxTypingFrequency: 60, accessibilityDeadline: ACCESSIBILITY_DEADLINE_S };
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
  /** 2026-11-21: the runner whose xcodebuild is starting now (one at a time across the farm), and the ones waiting. */
  private spawnHeld: Entry | null = null;
  private spawnQueue: { e: Entry; go: () => void }[] = [];
  /** Phones off the USB list right now (since when), but not unplugged (src/presence.ts). */
  private absent = new Map<string, number>();
  /** Called when a phone's orientation (or its screen size, once known) changed. */
  onOrientation?: (udid: string) => void;
  /** Whether someone is watching the phone now: its health check probes the session, not just /status. */
  watched?: (udid: string) => boolean;
  /** The phone's model identifier (ideviceinfo's ProductType: "iPhone14,8"), for its known screen size. */
  modelOf?: (udid: string) => string | null;
  /**
   * Called when a phone's WDA has a new session: `fresh` when it's the first since its runner (re)started (a start,
   * a restart, a rebuild), else a session remade on the same runner. The phone is kept silent from here (src/real.ts).
   */
  onSession?: (udid: string, fresh: boolean) => void;
  /** 2026-11-22: when the phone's live-view capture last started and stopped (ms since the epoch), for the runner's end record. */
  captureTimes?: (udid: string) => { startedAt: number | null; stoppedAt: number | null };

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

  /**
   * 2026-11-22: the runner ended or is given up on: what xcodebuild said last (XCTest says there why a runner ended: a
   * crash, a kill, a lost device), what was on its way, and the capture's timing, kept in stats and logged. Only the
   * lines that say something of an end, else the last few.
   */
  private noteRunnerEnd(e: Entry, why: string): void {
    const said = e.xcodeTail.filter((l) => /crash|signal|kill|lost|terminat|exit|disconnect|error|fail|timed? ?out|watchdog|jetsam|unexpected|restart|interrupt|abort/i.test(l));
    const lines = (said.length ? said : e.xcodeTail).slice(-8);
    const now = Date.now();
    const t = this.captureTimes?.(e.udid);
    const before = (at: number | null | undefined) => (at && at <= now ? now - at : null);
    const st = e.lane.state();
    e.lastRunnerEnd = {
      at: now, why: this.clean(e, why).slice(0, 300), xcodebuild: lines.map((l) => this.clean(e, l).slice(0, 200)),
      inFlight: st.inFlight, captureStartedMsBefore: before(t?.startedAt), captureStoppedMsBefore: before(t?.stoppedAt),
    };
    const cap = e.lastRunnerEnd.captureStartedMsBefore !== null ? `; the live view's capture started ${(e.lastRunnerEnd.captureStartedMsBefore / 1000).toFixed(1)} s before` : '';
    this.restartLog(e, `the runner ended or was given up on (${e.lastRunnerEnd.why})${st.inFlight ? `; on its way then: ${st.inFlight}` : ''}${cap}; xcodebuild's last words: ${lines.length ? lines.join(' | ') : '(none)'}`);
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
  linkHealth(udid: string): {
    state: ControlState; raw: ControlState; misses: number; recoveries: number; runnerRestarts: number; answeredMsAgo: number | null; busy: number; lane: LaneState;
    restarting: { attempt: number; of: number; since: number } | null; controlDown: string | null; needsReplug: boolean; appStall: { since: number; until: number; why: string | null } | null;
    appReads: { sent: number; refused: number; stuck: number }; reconnecting: { since: number; why: string } | null; orientationFrom: 'read' | 'picture' | null; lastRunnerEnd: RunnerEnd | null;
  } | null {
    const e = this.entries.get(udid);
    if (!e) return null;
    return {
      state: this.state(udid), raw: !e.wanted || e.downWhy ? 'down' : e.status === 'starting' ? 'recovering' : e.status !== 'ready' ? 'down' : e.control,
      misses: e.misses, recoveries: e.recoveries, runnerRestarts: e.runnerRestarts,
      // 2026-11-21: requests on their way to WDA or waiting their turn (never more than one on its way: src/lane.ts)
      answeredMsAgo: e.lastAnswer ? Date.now() - e.lastAnswer : null, busy: e.lane.load, lane: e.lane.state(),
      restarting: this.restarting(udid), controlDown: e.downWhy, needsReplug: !!e.downWhy && e.needsReplug,
      appStall: this.appStall(udid),
      // 2026-11-22: reads of the app in front (only Lotus's own, asked for, are ever sent), a check under way after a
      // refused connection, where the orientation came from, and how the last runner ended
      appReads: { ...e.appReads }, reconnecting: e.linkDown ? { ...e.linkDown } : null, orientationFrom: e.orientFrom,
      lastRunnerEnd: e.lastRunnerEnd,
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
    if (e.linkDown) throw this.reconnectingError(e);
  }

  private restartingError(e: Entry): HttpError {
    return new HttpError(503, `The phone's control link is restarting (attempt ${Math.max(1, e.attempt)})`, { state: 'restarting' });
  }

  /** 2026-11-22: a refused or reset connection is being checked (a few seconds): said at once, never waited for. */
  private reconnectingError(e: Entry): HttpError {
    const why = e.linkDown?.why ?? 'its WebDriverAgent stopped answering';
    return new HttpError(503, `The phone's control link is reconnecting (${why}); try again in a few seconds`, { state: 'recovering' });
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
  /**
   * 2026-11-18 (a live view that stayed on "connecting" while a phone's screen was off): waits up to `ms` for the
   * phone's WDA to take requests (up, a session made, no restart under way), so a wake isn't tried, and silently
   * given up, on a control link that's still coming up. True once it can; false when it didn't in time or is down.
   */
  async whenReady(udid: string, ms: number): Promise<boolean> {
    const until = Date.now() + Math.max(0, ms);
    for (;;) {
      const e = this.entries.get(udid);
      if (!e || !e.wanted || e.downWhy) return false;
      if (e.status === 'ready' && !e.restartP && e.sessionId) return true;
      if (e.status === 'ready' && !e.restartP && !e.sessionId && !e.sessionP) {
        // up without a session (one that failed to be made): one is made now
        await this.session(e).catch(() => {});
        if (e.sessionId) return true;
      }
      if (Date.now() >= until) return false;
      await sleep(250);
    }
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
   * 2026-11-22: the live view's picture came or changed size (the USB capture follows the phone as it turns): how the
   * phone is turned, from its shape, without asking WDA (the app in front's orientation is an accessibility read).
   * Tall is portrait (upside down kept when that was known); wide keeps the landscape side last known, else
   * landscape-left (an app's usual landscape: its top edge to the left).
   */
  noteFrame(udid: string, width: number, height: number): void {
    const e = this.entries.get(udid);
    if (!e || !(width > 0) || !(height > 0)) return;
    const wide = width > height * 1.05;
    const tall = height > width * 1.05;
    if (!wide && !tall) return;
    const o: Orientation = tall ? (e.orientation === 'portrait-upside-down' ? e.orientation : 'portrait') : isLandscape(e.orientation) ? e.orientation! : 'landscape-left';
    e.orientAt = Date.now();
    if (o === e.orientation) return;
    this.log(e, `orientation ${e.orientation ?? 'unknown'} -> ${o} (from the live picture's shape, ${width}x${height})`);
    e.orientation = o;
    e.orientFrom = 'picture';
    this.onOrientation?.(e.udid);
  }

  /**
   * 2026-11-22: the app in front as last known (never asked for it: an explicit read of Lotus's, the server's own
   * launch, a Home press), when, how, and whether the phone had input since (it may have changed).
   */
  knownApp(udid: string): { info: unknown; at: number; from: 'read' | 'launch' | 'home'; changedSince: boolean } | null {
    const e = this.entries.get(udid);
    if (!e || !e.appInfo || !e.appFrom) return null;
    return { info: e.appInfo, at: e.appAt, from: e.appFrom, changedSince: e.inputSeq > e.appSeq };
  }

  /** The app in front is known to be this one now (an explicit read, a launch, Home). */
  private setApp(e: Entry, info: unknown, from: 'read' | 'launch' | 'home'): void {
    e.appInfo = info;
    e.appAt = Date.now();
    e.appSeq = e.inputSeq;
    e.appFrom = from;
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

  /**
   * 2026-11-21: the poll's word on the phone's USB presence (src/real.ts). `false`: it's off the list for a moment
   * (a re-enumeration, a usbmux blip), not unplugged: nothing is restarted for it meanwhile. `true` again: a runner that
   * ended while it was away is started again now.
   */
  setPresent(udid: string, present: boolean): void {
    if (!present) {
      if (!this.absent.has(udid)) this.absent.set(udid, Date.now());
      return;
    }
    const since = this.absent.get(udid);
    if (since === undefined) return;
    this.absent.delete(udid);
    const e = this.entries.get(udid);
    if (!e?.wanted) return;
    const why = e.awaitingUsb;
    e.awaitingUsb = undefined;
    if (why && e.status === 'failed' && !e.restartP && !e.downWhy && !e.switching) {
      void this.beginRestart(e, `${why}; the phone is back on USB after ${((Date.now() - since) / 1000).toFixed(1)} s`);
    }
  }

  /** The phone is off the USB list for a moment (not unplugged). */
  offUsb(udid: string): boolean {
    return this.absent.has(udid);
  }

  /** Waits (at most `ms`) while the phone is off the USB list; true when it's there. */
  private async onUsb(e: Entry, ms: number, live: () => boolean): Promise<boolean> {
    if (!this.absent.has(e.udid)) return true;
    this.restartLog(e, `the phone is off the USB list for a moment: waiting up to ${Math.round(ms / 1000)} s for it before launching a runner`);
    const until = Date.now() + ms;
    while (this.absent.has(e.udid) && live() && Date.now() < until) await sleep(100);
    return !this.absent.has(e.udid);
  }

  /**
   * The runner's turn to start its xcodebuild (one at a time across the farm): at once when nobody else's is starting,
   * else once theirs is up, ended or held SPAWN_HOLD_MS. Resolves when it's this one's turn.
   */
  private takeSpawn(e: Entry): Promise<void> {
    if (this.spawnHeld === null || this.spawnHeld === e) {
      this.spawnHeld = e;
      return Promise.resolve();
    }
    this.log(e, `waiting for ${this.nameOf(this.spawnHeld.udid)}'s WebDriverAgent to finish starting first (one xcodebuild start at a time)`);
    return new Promise<void>((go) => this.spawnQueue.push({ e, go }));
  }

  /** This runner's start is over (up, ended, killed or held long enough): the next one in line goes. */
  private releaseSpawn(e: Entry): void {
    const turn = e.spawnTurn;
    e.spawnTurn = undefined;
    turn?.();
    if (this.spawnHeld !== e) return;
    this.spawnHeld = null;
    const next = this.spawnQueue.shift();
    if (next) {
      this.spawnHeld = next.e;
      next.go();
    }
  }

  start(udid: string): void {
    let e = this.entries.get(udid);
    if (e?.wanted) return;
    const n = this.slot(udid);
    e ??= {
      udid, wdaPort: this.cfg.wdaBasePort + n, mjpegPort: this.cfg.mjpegBasePort + n, status: 'starting', control: 'recovering',
      wanted: true, procs: [], restarts: 0, checking: false, lastOk: 0, orientation: null, orientAt: 0, tapRoute: 0, fast: 'unknown', fastFails: 0,
      mjpeg: { ...DEFAULT_MJPEG }, agent: newAgent(), direct: newAgent(2), lane: new WdaLane(() => this.nameOf(udid), { explain: (label) => this.explainBusy(udid, label) }), heals: 0, lastHeal: null, inflight: 0,
      lastAnswer: 0, laneAnswer: 0, misses: 0, missAt: 0, unreadyAt: 0, recoveries: 0, runnerRestarts: 0,
      flavor: 'stock', forkInfo: null, switching: false, launchError: null, liveFailed: null, forkFails: 0, readyAt: 0,
      attempt: 0, restartSince: 0, downWhy: null, epoch: 0, launchSeq: 0, fwdPorts: [], needsReplug: false,
      stallUntil: 0, stallMs: 0, stallSince: 0, stallWhy: null, inputAt: 0, inputSeq: 0,
      appAt: 0, appSeq: 0, appFrom: null, appReads: { sent: 0, refused: 0, stuck: 0 }, appInFlight: 0, orientFrom: null, linkDown: null,
      xcodeTail: [], lastRunnerEnd: null,
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
    if (e.spawnTurn) this.releaseSpawn(e); // its start is over: the next phone's xcodebuild may start
    e.launchSeq++; // a launch waiting for an earlier teardown doesn't go ahead: whoever kills decides what's next
    const old = { procs: e.procs, sessionId: e.sessionId, agent: e.agent, wdaPort: e.wdaPort, ports: e.fwdPorts, token: e.token };
    e.procs = [];
    e.fwdPorts = [];
    e.runner = undefined; // killed on purpose: its exit isn't a failure to act on
    e.sessionId = undefined;
    e.sessionP = undefined;
    e.mjpegApplied = undefined;
    e.agent = newAgent();
    e.direct.destroy();
    e.direct = newAgent(2);
    // 2026-11-21: nothing that waited its turn for the old runner goes to the new one (each hears why at once); the
    // request on its way ends with the old runner's connections (its agent is destroyed below)
    e.lane.flush(e.wanted ? new HttpError(503, `The phone's control link is restarting`, { state: 'restarting' }) : new HttpError(503, `The phone's control link is not running`, { state: 'down' }));
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
    if (e.wanted && !e.switching) this.noteRunnerEnd(e, why);
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
    // 2026-11-21: the phone is off the USB list for a moment (its capture starting re-enumerates it): a runner
    // launched now would fail at once and use up an attempt. It's started again as soon as the phone is back.
    if (this.absent.has(e.udid)) {
      e.awaitingUsb = why;
      return void this.log(e, `${why}; the phone is off the USB list for a moment: started again once it's back`);
    }
    void this.beginRestart(e, why);
  }

  /**
   * Start the phone's runner: at once, or once the old one's teardown ended (it's "starting" meanwhile). Only the
   * newest launch goes ahead, and only while nothing was killed since; never a second runner beside a live one.
   */
  private launch(e: Entry): void {
    e.fast = 'unknown'; // a rebuilt WDA may have (or lack) the fast route
    e.fastFails = 0;
    e.runnerSession = false; // the next session is this runner's first: the screen is read anew, the phone silenced
    e.screenTries = 0;
    e.status = 'starting';
    e.control = 'recovering';
    e.sessionId = undefined;
    e.sessionP = undefined;
    e.mjpegApplied = undefined;
    const seq = ++e.launchSeq;
    // one xcodebuild start at a time across the farm (SPAWN_HOLD_MS): at once when nothing else is starting
    if (!e.stopping && (this.spawnHeld === null || this.spawnHeld === e) && !this.spawnQueue.length) {
      this.spawnHeld = e;
      return this.spawnRunner(e);
    }
    void (async () => {
      while (e.stopping && e.launchSeq === seq) await e.stopping.catch(() => {});
      if (!e.wanted || e.launchSeq !== seq) return;
      await this.takeSpawn(e);
      if (!e.wanted || e.launchSeq !== seq || e.runner || e.procs.length) {
        if (e.wanted && e.launchSeq === seq) this.log(e, 'a runner is already there: not starting a second one');
        // this turn was never used: the next one in line goes (a newer launch of this phone takes it again)
        if (this.spawnHeld === e && !e.spawnTurn) this.releaseSpawn(e);
        return;
      }
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
            e.direct.destroy();
            e.direct = newAgent(2);
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
    // this runner holds the farm's xcodebuild start turn until it's up, it ends, it's killed, or SPAWN_HOLD_MS
    {
      const hold = Math.max(0, Math.min(this.timeouts.spawnHold ?? SPAWN_HOLD_MS, this.timeouts.restart));
      const done = () => clearTimeout(timer);
      const timer = setTimeout(() => {
        if (e.spawnTurn === done) this.releaseSpawn(e);
      }, hold);
      timer.unref?.();
      this.spawnHeld = e;
      e.spawnTurn = done;
    }
    e.procs = fwdMjpeg ? [fwdWda, fwdMjpeg, xcode] : [fwdWda, xcode];
    e.fwdPorts = plan.mjpeg ? [plan.wda.local, plan.mjpeg.local] : [plan.wda.local];
    this.log(e, plan.mjpeg ? `starting (wda :${plan.wda.local}, mjpeg :${plan.mjpeg.local})` : `starting our own build (wda :${plan.wda.local} on the Mac and the phone, token set, no MJPEG)`);

    // what xcodebuild said about a refused install or signing (a locked phone, an expired profile), for the switch's "why"
    const tail: string[] = [];
    // 2026-11-22: and its last lines whatever they say (how the runner ended: noteRunnerEnd)
    const lines: string[] = (e.xcodeTail = []);
    const keep = (d: Buffer) => {
      for (const l of d.toString().split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        if (e.runner === xcode) {
          lines.push(t.slice(0, 240));
          if (lines.length > XCODE_TAIL) lines.splice(0, lines.length - XCODE_TAIL);
        }
        if (/error|fail|unable|cannot|locked|trust|profile|sign/i.test(t)) tail.push(t.slice(0, 160));
      }
      if (tail.length > 4) tail.splice(0, tail.length - 4);
    };
    xcode.stdout?.on('data', keep);
    xcode.stderr?.on('data', keep);
    xcode.on('exit', (code) => {
      if (e.runner !== xcode) return; // superseded
      if (e.spawnTurn) this.releaseSpawn(e);
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
          if (e.spawnTurn) this.releaseSpawn(e); // up: the next phone's xcodebuild may start
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
   * One HTTP request to WDA (Nagle off, keep-alive), in the phone's lane (src/lane.ts): one at a time, a touch before
   * waiting reads, a read that waited too long dropped unsent (a LaneBusy, 503), a quiet read skipped while anything
   * else is on its way. Its `timeout` counts from when it's sent, not while it waits its turn. A request whose caller
   * stopped waiting keeps the lane until the phone answers it (HOLD_MS at most, then WDA is checked). /status and
   * /lotus/info (`bypass`) go straight on connections of their own.
   */
  private request(e: Entry, method: string, p: string, body: string | undefined, timeout: number, resend = true, via: Via = {}): Promise<Resp> {
    const headers: Record<string, string | number> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    // our build answers nothing without its token (never logged: this header is the only place it goes)
    if (e.token) headers[TOKEN_HEADER] = e.token;
    const label = routeLabel(method, p);
    const bound = !via.bypass && appBound(method, p);
    const name = this.nameOf(e.udid);
    // 2026-11-22: the server never reads the app in front on its own (the card, a poll, a live view's start, a new
    // session, a recovery): only Lotus's own reads, asked for (`explicit`), ever go. Anything else is refused here,
    // unsent, and counted (stats: appReads.refused)
    if (bound && !via.explicit) {
      e.appReads.refused++;
      return Promise.reject(new LaneBusy(`${name}: ${label} not sent (the server never reads the app in front on its own)`, { skipped: true, appRead: 'refused' }));
    }
    // ...and an explicit one goes only while no other is on the phone and the app in front is known to answer
    if (bound) {
      const why = this.appReadBlocked(e);
      if (why) return Promise.reject(this.appBusy(e, label, why));
    }
    // a Home press or a launch that WDA did: the app in front is known from it (2026-11-22: never asked)
    let appAfter: { info: unknown; from: 'launch' | 'home' } | null = null;
    const go = (agent: http.Agent, holdMs: number) => {
      if (bound) {
        // checked again at its turn: a read ahead of it may have found the app not answering meanwhile
        const why = this.appReadBlocked(e, true);
        if (why) throw this.appBusy(e, label, why);
        e.appReads.sent++;
        e.appInFlight++;
      }
      const t0 = Date.now();
      const x = exchange({
        port: e.wdaPort, method, path: p, body, headers, agent, timeout, holdMs,
        // `resend: false` (typing): never sent a second time, even on a stale socket (WDA may have typed it already)
        resend,
        onAnswer: () => {
          e.lastAnswer = Date.now();
          if (!via.bypass) e.laneAnswer = e.lastAnswer;
          e.misses = 0;
        },
        onStuck: (ms) => this.stuck(e, label, ms),
      });
      if (appAfter) {
        const known = appAfter;
        x.result.then(
          (r) => void (r.status >= 200 && r.status < 300 && this.setApp(e, known.info, known.from)),
          () => {},
        );
      }
      // a read of the app in front: one that isn't answered in time (or that WDA's deadline cut short) means the app
      // doesn't answer accessibility now; a quick answer means it does again
      if (bound) {
        x.ended.then(() => void (e.appInFlight = Math.max(0, e.appInFlight - 1)));
        x.result.then(
          (r) => {
            if (r.status >= 500 && DEADLINE_RE.test(r.text)) this.markStall(e, label, `WebDriverAgent's ${ACCESSIBILITY_DEADLINE_S} s deadline cut ${label} short`);
            else if (r.status < 500 && Date.now() - t0 <= APP_OK_MS) this.clearStall(e);
          },
          (err: HttpErr) => {
            if (err.code === 'TIMEOUT') this.markStall(e, label, `no answer to ${label} within ${(timeout / 1000).toFixed(1)} s`);
          },
        );
      }
      return x;
    };
    if (via.bypass) return go(e.direct, 0).result;
    const prio = via.prio ?? routePriority(method, p);
    if (prio === 'input') {
      e.inputAt = Date.now();
      e.inputSeq++;
      // another app comes to the front (Home, a launch): the stall was the old app's, and the app in front is known
      const route = p.split('?')[0]!;
      const home = /\/wda\/homescreen$/.test(route) || (/\/pressButton$/.test(route) && /"home"/.test(body ?? ''));
      if (home || APP_SWITCH_RE.test(label)) this.clearStall(e);
      if (home) appAfter = { info: { bundleId: SPRINGBOARD, name: 'Home Screen' }, from: 'home' };
      else if (/\/wda\/apps\/(launch|activate)$/.test(route)) {
        const id = (() => {
          try {
            return JSON.parse(body ?? '{}')?.bundleId;
          } catch {
            return undefined;
          }
        })();
        if (typeof id === 'string' && id) appAfter = { info: { bundleId: id }, from: 'launch' };
      }
    }
    const wait = via.maxWait ?? (prio === 'quiet' ? QUIET_WAIT_MS : this.timeouts.laneWait ?? LANE_WAIT_MS);
    const holdMs = via.hold === false ? 0 : this.timeouts.hold ?? HOLD_MS;
    const agent = e.agent;
    // 2026-11-22: a read of the app in front may be held by the phone for long (an app that doesn't answer
    // accessibility): the owner's touches go beside it, never behind it (src/lane.ts); an input that reads the app
    // itself (the focused field) never does
    return e.lane.run(prio, label, wait, () => go(agent, holdMs), prio === 'quiet' ? label : undefined, { yields: bound, beside: !bound });
  }

  /**
   * A request the phone never answered, not even late (its hold ran out): XCTest may be stuck. WDA is checked (and
   * restarted only when /status goes unanswered, or no session can be made while nothing else is asked of it).
   * 2026-11-22: never for a read of the app in front: that app doesn't answer accessibility (the stall says so), WDA
   * itself is fine and its /status answers; checking it only queued more behind the same read.
   */
  private stuck(e: Entry, label: string, ms: number): void {
    if (!e.wanted || e.status !== 'ready' || e.restartP || e.downWhy) return;
    const why = `no answer within ${(ms / 1000).toFixed(1)} s to ${label}, not even late`;
    const sp = label.indexOf(' ');
    if (sp > 0 && appBound(label.slice(0, sp), label.slice(sp + 1))) {
      e.appReads.stuck++;
      if (!this.stalled(e)) this.markStall(e, label, why);
      return void this.log(e, `${why}: the app in front doesn't answer accessibility; nothing is checked or restarted for it`);
    }
    this.log(e, `${why}: checking WebDriverAgent`);
    void this.recover(e, why).catch(() => {});
  }

  /** The app in front isn't answering accessibility reads now (a read of it would only hold the phone). */
  private stalled(e: Entry): boolean {
    return e.stallUntil > Date.now();
  }

  /**
   * 2026-11-22: why an explicit read of the app in front can't go now (null: it may). `atTurn`: it's its turn in the
   * lane, so one still held on the phone (whose caller gave up on it) means the phone is still stuck on it.
   */
  private appReadBlocked(e: Entry, atTurn = false): string | null {
    const now = Date.now();
    if (e.stallUntil > now) return `the app in front isn't answering accessibility reads (${e.stallWhy ?? 'it was slow'}); asked again in ${Math.ceil((e.stallUntil - now) / 1000)} s at the earliest`;
    if (atTurn && e.appInFlight > 0) return 'an earlier read of the app in front is still on the phone';
    return null;
  }

  /** An explicit read of the app in front that can't go now: a 503 that says why at once (the picture still works). */
  private appBusy(e: Entry, label: string, why: string): LaneBusy {
    return new LaneBusy(`${this.nameOf(e.udid)} can't read the app in front right now: ${why}, so ${label} was not sent (touches and the picture work as usual)`, { skipped: true, appRead: 'busy' });
  }

  /** A read of the app in front went unanswered: reads of it pause, longer each time it happens again. */
  private markStall(e: Entry, label: string, why: string): void {
    const now = Date.now();
    const again = e.stallMs > 0;
    e.stallMs = again ? Math.min(e.stallMs * 2, this.timeouts.stallMax ?? STALL_MAX_MS) : this.timeouts.stall ?? STALL_MS;
    if (!e.stallSince || !again) e.stallSince = now;
    e.stallUntil = now + e.stallMs;
    e.stallWhy = why;
    this.log(e, `the app in front isn't answering accessibility reads (${why}): no read of it for ${Math.round(e.stallMs / 1000)} s (orientation, app name and size stay as known; touches go as usual)`);
  }

  /** A read of the app in front answered quickly: it answers accessibility again. */
  private clearStall(e: Entry): void {
    if (!e.stallMs && !e.stallUntil) return;
    const was = e.stallSince ? ` after ${Math.round((Date.now() - e.stallSince) / 1000)} s` : '';
    e.stallMs = 0;
    e.stallUntil = 0;
    e.stallSince = 0;
    e.stallWhy = null;
    this.log(e, `the app in front answers accessibility reads again${was}`);
  }

  /** Said in a "busy" answer when the request holding the phone is a read of an app that doesn't answer. */
  private explainBusy(udid: string, label: string): string | null {
    const e = this.entries.get(udid);
    const sp = label.indexOf(' ');
    if (!e || sp < 0 || !appBound(label.slice(0, sp), label.slice(sp + 1)) || !this.stalled(e)) return null;
    return "it is reading the app in front, which isn't answering accessibility reads right now (an app busy all the time, such as a video feed); the server no longer asks it in the background, so this clears by itself";
  }

  /** The app in front's accessibility stall, for the phone's stats: null when it answers. */
  appStall(udid: string): { since: number; until: number; why: string | null } | null {
    const e = this.entries.get(udid);
    return e && this.stalled(e) ? { since: e.stallSince, until: e.stallUntil, why: e.stallWhy } : null;
  }

  private async raw(e: Entry, method: string, p: string, body?: unknown, timeout = 30000, resend = true, via: Via = {}): Promise<any> {
    let res: { status: number; text: string; ok?: boolean };
    try {
      res = await this.request(e, method, p, body === undefined ? undefined : JSON.stringify(body), timeout, resend, via);
    } catch (err) {
      if (err instanceof LaneBusy) throw err; // never sent: the phone was busy (its own clear 503)
      const x = err as HttpErr;
      const why = x.code === 'TIMEOUT' ? `no answer within ${Math.round(timeout / 1000)}s` : `unreachable (${x.code ?? x.message})`;
      const werr = new WdaError('unreachable', why);
      werr.timeout = x.code === 'TIMEOUT';
      werr.conn = connFailed(x);
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

  /** GET /status, past the lane on a connection of its own (WDA answers it off its main queue, however busy that is). */
  private async ping(e: Entry, timeout: number): Promise<{ ok: boolean; sessionId?: string; why?: string; conn?: boolean }> {
    try {
      const r = await this.request(e, 'GET', '/status', undefined, timeout, true, { bypass: true });
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
      return { ok: false, why: x.code === 'TIMEOUT' ? `no answer in ${(timeout / 1000).toFixed(1)} s` : `unreachable (${x.code ?? x.message})`, conn: connFailed(x) };
    }
  }

  /** GET /lotus/info: what our build says of itself; null when this WDA isn't ours (a stock one answers "unknown command"). */
  private async askFork(e: Entry): Promise<{ lotus: number; upstream?: string } | null> {
    // a stock WDA is never asked: it would only log an unknown route (and it's launched without a token anyway)
    if (e.flavor !== 'fork') return null;
    for (let n = 0; n < 2; n++) {
      try {
        const v = (await this.raw(e, 'GET', FORK_ROUTES.info, undefined, 4000, true, { bypass: true }))?.value;
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
    // (no hold for a late answer: a session that isn't made in time is asked again, never waited for behind itself)
    const j = await this.raw(e, 'POST', '/session', { capabilities: { alwaysMatch: CAPS }, desiredCapabilities: CAPS }, 15000, true, { hold: false });
    const id = j.sessionId ?? j.value?.sessionId;
    if (!id) throw new WdaError('server', 'WDA did not return a session id');
    e.sessionId = id;
    e.lastOk = Date.now();
    // 2026-11-21 (2): the settings first (they bound reads of the app in front on the phone), then the screen (read
    // only as far as it isn't known yet, and not at all while the app in front doesn't answer accessibility)
    await this.applySettings(e, id);
    await this.readScreen(e, id);
    const fresh = !e.runnerSession;
    e.runnerSession = true;
    try {
      this.onSession?.(e.udid, fresh);
    } catch (err) {
      this.log(e, `after the session: ${(err as Error).message}`);
    }
    return id;
  }

  /**
   * Screen size in points, scale and orientation, read with each new session (so after every start, restart and
   * rebuild of the runner). WDA's window size is the foreground app's, so it's wide when the phone is in landscape at
   * that moment: it's kept as held in portrait, and `screen()` turns it by the orientation, which is asked again as
   * the phone turns (refreshOrientation).
   *
   * 2026-11-18 (taps in the wrong place on iPhone-1 after its runner was rebuilt): the size was the app in front's
   * window alone, read once a session and never checked; after the install the self-test had WebDriverAgent's own
   * (letterboxed) app in front, and every tap and element place was worked out on a far smaller screen. Now it's the
   * screen's own size (/wda/screen `screenSize`), checked (src/screens.ts pickScreen: never zero, never pixels, never
   * a letterboxed app's window), with the model's known size when WDA gives nothing usable; a read that failed is
   * tried again shortly, and what it found and why goes in the log when it changes.
   */
  private async readScreen(e: Entry, sid: string): Promise<void> {
    const before = JSON.stringify([e.screen, e.orientation]);
    const model = this.modelOf?.(e.udid) ?? null;
    const take = (pick: ScreenPick) => {
      e.screen = { width: pick.width, height: pick.height, scale: pick.scale };
      e.screenFrom = pick.from;
      const said = `${pick.width} x ${pick.height} pt @${pick.scale ?? '?'}x from ${pick.from === 'screen' ? 'the screen' : pick.from === 'window' ? "the app's window" : pick.from === 'model' ? "the model's known size" : 'before'}${pick.note ? ` (${pick.note})` : ''}`;
      if (said !== e.screenSaid) this.log(e, `screen ${said}`);
      e.screenSaid = said;
    };
    // 2026-11-22: every WDA read of the size asks the app in front (WDA's window and /wda/screen both look it up and
    // read its orientation), and a new session (a start, a restart, a recovery) is no reason to ask it: the size comes
    // from what's known (the screen's own size read before, else the model's known size), the orientation stays as
    // known (the live picture's shape says it: noteFrame). A phone whose model isn't known (none on the farm) has its
    // size read when Lotus first reads its screen itself (ensureScreen, an explicit read).
    void sid;
    if (!e.screen) {
      const known = pickScreen({ model });
      if (known) take(known);
    }
    // a phone whose model isn't in the table (none on the farm): its size can only come from WDA. Read once, as a
    // setup read of its own (bounded, never while the app in front doesn't answer, never again once it's known)
    if (!e.screen) await this.ensureScreen(e);
    // how it's turned: as known; a phone never seen turned is taken as upright (a phone on a stand) until the live
    // picture's shape or Lotus's own read says otherwise
    if (!e.orientation) e.orientation = 'portrait';
    if (JSON.stringify([e.screen, e.orientation]) !== before) this.onOrientation?.(e.udid);
  }

  /**
   * 2026-11-22: the screen's own size, asked once per phone as part of an explicit read of Lotus's (only until it's
   * known from the screen itself, and only when the model's size isn't known: never on the farm's phones).
   */
  private async ensureScreen(e: Entry): Promise<void> {
    if ((e.screen && e.screenFrom !== 'previous') || this.appReadBlocked(e)) return;
    const model = this.modelOf?.(e.udid) ?? null;
    const ms = this.timeouts.appRead ?? APP_READ_MS.size;
    try {
      const sv = (await this.raw(e, 'GET', '/wda/screen', undefined, ms, true, { explicit: true }))?.value ?? null;
      let win: unknown = null;
      // an older WDA gives no screen size: the app's window then (checked: never a letterboxed app's)
      if (!saneSize(sv?.screenSize) && !knownScreen(model) && e.sessionId) {
        win = (await this.raw(e, 'GET', `/session/${e.sessionId}/window/size`, undefined, ms, true, { explicit: true }).catch(() => null))?.value ?? null;
      }
      const pick = pickScreen({ screen: sv?.screenSize ?? null, window: win as any, scale: sv?.scale, model, previous: e.screen ?? null });
      if (pick && (pick.from === 'screen' || pick.from === 'window')) {
        e.screen = { width: pick.width, height: pick.height, scale: pick.scale };
        e.screenFrom = pick.from;
        this.log(e, `screen ${pick.width} x ${pick.height} pt @${pick.scale ?? '?'}x from ${pick.from === 'screen' ? 'the screen' : "the app's window"}${pick.note ? ` (${pick.note})` : ''}`);
        this.onOrientation?.(e.udid);
      }
    } catch {
      /* not now: asked with the next explicit read */
    }
  }

  private async readOrientation(e: Entry, sid: string, via: Via = {}): Promise<Orientation | null> {
    try {
      return orientationFromWda((await this.raw(e, 'GET', `/session/${sid}/orientation`, undefined, this.timeouts.orient ?? APP_READ_MS.orientation, true, via))?.value);
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
   * How the phone is turned. 2026-11-22: WDA's orientation is the app in front's, read through accessibility, so it's
   * asked only for an explicit read of Lotus's (`explicit`: the UI tree's rectangles are upright, so must the screen
   * be), within `maxAgeMs`, one ask at a time, never while the app doesn't answer. Everyone else (the list, a poll, a
   * still, the live picture) gets what's known: the live picture's shape keeps it current (noteFrame). Never recovers
   * WDA: an ask that fails keeps what was known.
   */
  refreshOrientation(udid: string, maxAgeMs = 1500, explicit = false): Promise<Orientation | null> {
    const e = this.entries.get(udid);
    if (!e) return Promise.resolve(null);
    if (!explicit) return Promise.resolve(e.orientation);
    if (e.orientP) return e.orientP;
    if (e.status !== 'ready' || !e.sessionId || e.recovering || e.linkDown || Date.now() - e.orientAt < maxAgeMs) return Promise.resolve(e.orientation);
    if (this.appReadBlocked(e)) return Promise.resolve(e.orientation);
    const sid = e.sessionId;
    e.orientP = this.readOrientation(e, sid, { prio: 'read', explicit: true, maxWait: FRESH_ORIENT_WAIT_MS })
      .then((o) => {
        e.orientAt = Date.now();
        if (o) e.orientFrom = 'read';
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
      // a read of an app that doesn't answer accessibility fails on the phone after this many seconds instead of
      // holding WDA's main queue (and the owner's touches behind it) for tens of seconds (a WDA without it ignores it)
      accessibilityDeadline: ACCESSIBILITY_DEADLINE_S,
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
      // 2026-11-21: said as it is, per phone: slow is not down (nothing is restarted for it), and WDA's own error is its own
      const said = err.timeout
        ? `${name} did not answer in time (${err.message}): its WebDriverAgent is busy or stuck, nothing was restarted, and the request may still happen on the phone`
        : err.down
          ? `WDA session for ${name} is down: ${err.message}`
          : err.kind === 'server'
            ? `WebDriverAgent on ${name} could not do it: ${err.message}`
            : `WDA refused the request on ${name}: ${err.message}`;
      const out = new WdaError(err.kind, said);
      out.timeout = err.timeout;
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
  private async confirmDead(e: Entry, conn = false): Promise<string | null | 'moot'> {
    const n = Math.max(1, this.timeouts.probes ?? DEAD_PROBES);
    const every = this.timeouts.probeEvery ?? PROBE_EVERY_MS;
    // 2026-11-22: a refused or reset connection is no busy phone (a busy WDA still takes connections): /status is
    // asked as often, but every CONN_PROBE_EVERY_MS while its own connections fail the same way (~6 s, not ~12)
    const fast = Math.min(every, CONN_PROBE_EVERY_MS);
    const ms = this.timeouts.status ?? STATUS_MS;
    const fails: string[] = [];
    // 2026-11-21: never while a request of ours is still with the phone: it's busy, not dead. The lane drains first
    // (that request is answered, fails, or is given up at its hold); any answer meanwhile means WDA is there.
    const asked = Date.now();
    if (!e.lane.idle) {
      const drained = await e.lane.drained(Math.min(this.timeouts.hold ?? HOLD_MS, conn ? Math.min(DRAIN_MS, 3000) : DRAIN_MS));
      if (e.lastAnswer >= asked) return null;
      if (!drained && !conn) return 'moot'; // still busy with a request of ours: checked again when that one is over (stuck)
    }
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      // off the USB list for a moment: unreachable, not dead (checked again once it's back)
      if (!e.wanted || e.status !== 'ready' || e.restartP || this.absent.has(e.udid)) return 'moot';
      const at = Date.now();
      const r = await this.ping(e, ms);
      if (r.ok || e.lastAnswer >= at) return null;
      fails.push(r.why ?? 'no answer');
      if (i < n - 1) {
        const wait = (r.conn ? fast : every) - (Date.now() - at);
        if (wait > 0) await sleep(wait);
        if (e.lastAnswer >= at) return null; // something else got an answer meanwhile: WDA is there
      }
    }
    if (this.absent.has(e.udid)) return 'moot';
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
  private recover(e: Entry, why: string, sessionGone = false, conn = false): Promise<void> {
    if (e.restartP) return Promise.reject(this.restartingError(e));
    if (e.downWhy) return Promise.reject(this.controlDownError(e));
    if (e.recovering) return e.recovering;
    const run = (async () => {
      if (e.status !== 'ready') throw this.downError(e, `WebDriverAgent is ${e.status === 'starting' ? 'still starting' : e.status}`);
      // 2026-11-21: off the USB list for a moment (re-enumerating): unreachable is expected, nothing is restarted
      if (this.absent.has(e.udid)) throw this.downError(e, `the phone is reconnecting over USB (${why})`);
      e.recoveries++;
      e.misses = 0;
      this.healed(e, `recovering: ${why}`);
      // 2026-11-22: its connections are refused or reset: until this check is over every call hears "reconnecting" at
      // once (gate), rather than queueing behind the check and failing 10 s later
      if (conn) e.linkDown = { since: Date.now(), why: `its WebDriverAgent stopped answering: ${why.replace(/^unreachable \((\w+)\)$/, '$1')}` };
      // WDA said itself that the session is gone: it's there (2026-11-21: no /status asks first, a new session at once)
      const dead = sessionGone ? null : await this.confirmDead(e, conn);
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
            // (no hold: a check that isn't answered in time is an answer of its own here)
            await this.raw(e, 'GET', `/session/${sid}`, undefined, this.timeouts.probe * 2, true, { hold: false });
          } catch (err) {
            // never sent: the phone was busy with other requests of ours the whole time, so it's there; the session stays
            if (err instanceof LaneBusy) throw err;
            // 2026-11-21 (2): no answer in time is a busy phone (its main queue still on an earlier read), not a
            // session that's gone: /status (which answers off that queue) says whose session WDA has. Dropping a busy
            // session made a new one, and three more reads of the app in front with it, behind the same stuck work
            gone =
              err instanceof WdaError && err.timeout
                ? await this.sessionExpired(e, sid)
                : !(err instanceof WdaError) || err.down || err.kind === 'session' || (await this.sessionExpired(e, sid));
          }
        }
        if (gone && e.sessionId === sid) {
          e.sessionId = undefined;
          e.mjpegApplied = undefined;
        }
      }
      const wait = this.timeouts.sessionWait ?? SESSION_WAIT_MS;
      // made once WDA gave its id (the screen's size and the settings read after it may take longer: never "no session")
      const made = () => within(this.session(e), wait, () => new WdaError('unreachable', `no session within ${Math.round(wait / 1000)} s`)).then(
        () => {},
        (err) => {
          if (!e.sessionId) throw err;
        },
      );
      const tMade = Date.now();
      try {
        await made();
      } catch (err) {
        if (err instanceof LaneBusy) throw err;
        // /status answers but no session: asked once more a moment later; still none (XCTest hung under it): only a
        // fresh runner fixes that, and only when nothing at all came back from WDA meanwhile (an answer to anything
        // else of ours means it's only slow)
        await sleep(Math.min(1000, this.timeouts.probeEvery ?? PROBE_EVERY_MS));
        try {
          await made();
        } catch (err2) {
          if (!(err2 instanceof WdaError) || !err2.down || !e.wanted || e.status !== 'ready' || e.laneAnswer >= tMade) throw err2;
          void this.beginRestart(e, `${why}; then /status answered but no session could be made, twice, and nothing else was answered either (${(err as Error).message}; ${err2.message})`);
          throw this.restartingError(e);
        }
      }
      e.lastOk = Date.now();
      this.setControl(e, 'ready');
      this.log(e, 'recovered');
    })();
    const p: Promise<void> = run.finally(() => {
      if (e.recovering === p) e.recovering = undefined;
      e.linkDown = null; // over: answered, or a restart under way (which says so itself)
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
        // a phone off the USB list for a moment: its runner is launched once it's back (not counted against it)
        if (!(await this.onUsb(e, this.timeouts.usbWait ?? USB_WAIT_MS, live))) this.restartLog(e, 'the phone is still off the USB list: trying anyway');
        if (!live()) return;
        e.attempt++;
        const n = e.attempt;
        const t = Date.now();
        const why = n === 1 ? reason : `attempt ${n - 1} failed: ${last}`;
        this.restartLog(e, `attempt ${n}/${max}: restarting WDA (${why})`);
        this.healed(e, `restarting WDA (attempt ${n}/${max}): ${why}`);
        // 2026-11-22: what the runner given up on said last (unless its xcodebuild's exit was just recorded)
        if (n === 1 && !(e.lastRunnerEnd && Date.now() - e.lastRunnerEnd.at < 5000)) this.noteRunnerEnd(e, why);
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
      // made once WDA gave its id (the screen's size and the settings read after it are not the session)
      if (e.sessionId) return { ok: true, why: '' };
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
      // may yet happen on the phone) and never a restart by itself. 2026-11-21: not even a check: that request still
      // holds the phone's lane until the phone answers it, and only one that's never answered has WDA checked (stuck)
      if (err.timeout) throw this.named(e, err);
      try {
        const checking = this.recover(e, err.message, err.kind === 'session', err.conn);
        if (err.conn) {
          // 2026-11-22: a refused or reset connection: asked once more only if WDA comes right at once (a forward
          // started again, a stale socket); else this call is answered now ("reconnecting", "restarting") while the
          // check goes on by itself. It used to wait for the check (~12 s of /status asks), the owner's next touches
          // queued behind it, and all of them failed with "restarting" 10 s later.
          const quick = await within(checking.then(() => true), QUICK_RECOVER_MS, () => new Error('wait')).catch((x: unknown) => x);
          if (quick !== true) {
            checking.catch(() => {});
            if (quick instanceof HttpError && !(quick instanceof WdaError)) throw quick; // restarting, or control down
            if (quick instanceof Error && quick.message !== 'wait') throw this.named(e, quick);
            throw e.restartP ? this.restartingError(e) : e.downWhy ? this.controlDownError(e) : this.reconnectingError(e);
          }
        } else {
          await checking;
        }
      } catch (err2) {
        if (err2 instanceof HttpError && !(err2 instanceof WdaError)) throw err2; // restarting, reconnecting, or control down: a 503
        throw this.named(e, err2 instanceof WdaError ? err2 : err);
      }
      try {
        const r = await fn(e); // retry once
        e.lastOk = Date.now();
        return r;
      } catch (err3) {
        if (err3 instanceof WdaError && err3.down && !err3.timeout) void this.recover(e, err3.message, false, err3.conn).catch(() => {});
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
      // 2026-11-21: answered within `recoverWait` (a check that waits for the phone to finish an earlier request
      // goes on by itself); the phone busy with requests of ours is there, not down
      const checking = this.recover(e, 'requested by the client');
      await within(checking, wait, () => new Error('wait')).catch((err) => {
        if ((err as Error)?.message === 'wait') return void checking.catch(() => {});
        throw err;
      });
    } catch (err) {
      if (e.restartP) return join(e.restartP);
      if (err instanceof LaneBusy) return this.state(udid);
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
  call(udid: string, method: string, sub: string, body?: unknown, timeout = 30000, via: CallVia = {}): Promise<any> {
    const how: Via = via.explicit ? { explicit: true } : {};
    return this.withRecovery(udid, async (e) => {
      const sid = await this.session(e);
      try {
        return await this.raw(e, method, `/session/${sid}${sub}`, body, timeout, true, how);
      } catch (err) {
        if (!(err instanceof WdaError) || err.down || !(await this.sessionExpired(e, sid))) throw err;
        this.healed(e, `the session expired (${err.message}); making a new one`);
        const r = await this.raw(e, method, `/session/${await this.session(e)}${sub}`, body, timeout, true, how);
        this.setControl(e, 'ready');
        return r;
      }
    });
  }

  /**
   * A quick read for the detail card: null unless WDA is up and not recovering right now; never waits for a start,
   * never recovers, never throws. `session`: a session route (asked only when a session exists).
   * 2026-11-22: the app in front's name is never asked (an accessibility read): the card gets what's known
   * (knownApp: an explicit read of Lotus's, a launch, Home). Only reads that never touch the app go (device info, battery).
   */
  async peek(udid: string, p: string, timeout = 2500, session = false): Promise<unknown> {
    const e = this.entries.get(udid);
    if (!e) return null;
    const path = session && e.sessionId ? `/session/${e.sessionId}${p}` : p;
    if (appBound('GET', path)) {
      if (p === '/wda/activeAppInfo') return e.appInfo ?? null;
      e.appReads.refused++;
      return null;
    }
    if (!e.wanted || e.status !== 'ready' || e.recovering || e.linkDown) return null;
    if (session && !e.sessionId) return null;
    if (e.inflight > 0) return null; // WDA is busy with an action: a card's read never piles on top of it
    try {
      // quiet: skipped while anything else is on its way to the phone (src/lane.ts)
      return (await this.raw(e, 'GET', path, undefined, timeout, true, { prio: 'quiet' }))?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A best-effort call that never heals (2026-11-16, for the lock): WDA must be ready already, nothing is waited for or
   * recovered, and any failure (a timeout, WDA's own "Timed out while waiting until the screen gets locked") comes back
   * as a plain rejection, so it never marks the session or the phone down.
   */
  async callSoft(udid: string, method: string, p: string, body?: unknown, timeout = 3000, quiet = false): Promise<any> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted || e.status !== 'ready' || e.recovering) throw new WdaError('rejected', `WebDriverAgent on ${this.nameOf(udid)} isn't ready`);
    try {
      // `quiet` (the watch's own looks): skipped while anything else is on its way to the phone
      return await this.raw(e, method, p, body, timeout, true, quiet ? { prio: 'quiet' } : {});
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

  callNoSession(udid: string, method: string, p: string, body?: unknown, timeout = 30000, via: CallVia = {}): Promise<any> {
    return this.withRecovery(udid, (e) => this.raw(e, method, p, body, timeout, true, via.explicit ? { explicit: true } : {}));
  }

  /** A read that never triggers a recovery (a slow /source on a heavy screen must not restart WDA). */
  private async read(udid: string, p: string, timeout: number, via: Via = {}): Promise<any> {
    const e = await this.usable(udid);
    e.inflight++;
    try {
      const r = await this.raw(e, 'GET', p, undefined, timeout, true, via);
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
    // 2026-11-21: off the USB list for a moment (re-enumerating): nothing to probe or heal until it's back
    if (this.absent.has(e.udid)) return false;
    if (e.status === 'failed' && e.timer) {
      clearTimeout(e.timer);
      e.timer = undefined;
      this.healed(e, `${reason}: WDA was waiting to start again; starting it now`);
      this.launch(e);
    }
    if (e.status === 'starting') await this.waitReady(e, this.timeouts.startWait ?? START_WAIT_MS);
    if (e.recovering) await e.recovering.catch(() => {});
    if (e.status !== 'ready' || e.restartP || e.downWhy) return false;
    // something is on its way to WDA (a long gesture, a big /source, a screenshot, a lock, a card's read), or waits
    // its turn: WDA works one thing at a time, so a probe now would only wait behind it and look like a hang; that
    // request finds out for itself (2026-11-21: the lane says so for every request, not just actions)
    if (e.inflight > 0 || !e.lane.idle) return true;
    const sid = e.sessionId;
    try {
      if (!sid) {
        await this.session(e);
      } else {
        e.inflight++;
        try {
          await this.raw(e, 'GET', `/session/${sid}`, undefined, this.timeouts.probe, true, { prio: 'quiet' });
        } finally {
          e.inflight--;
        }
      }
      e.lastOk = Date.now();
      this.setControl(e, 'ready');
      return true;
    } catch (err) {
      if (err instanceof LaneBusy) return true; // something else got there first: busy, not down
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
        await this.recover(e, `${reason}: ${err.message}`, false, err.conn);
      }
      e.lastOk = Date.now();
      this.setControl(e, 'ready');
      return true;
    }
  }

  /**
   * What's on screen: WDA's accessibility tree as JSON (src/ui.ts flattens it). 2026-11-21: 20 s (was 25 s), so with
   * its wait for a turn in the lane a read is still answered inside a client's 30 s.
   */
  async source(udid: string): Promise<unknown> {
    // 2026-11-22: Lotus's own read (explicit), bounded (APP_READ_MS.tree), refused at once while the app in front is
    // known not to answer; the screen's size first when this phone's model isn't known (never on the farm's phones)
    const e = this.entries.get(udid);
    if (e && e.status === 'ready' && !this.appReadBlocked(e)) await this.ensureScreen(e);
    return (await this.read(udid, '/source?format=json', this.timeouts.appRead ?? APP_READ_MS.tree, { explicit: true }))?.value ?? null;
  }

  /**
   * The foreground app's bundle id, or null. 2026-11-22: only ever for Lotus's own read of the screen (explicit),
   * within APP_READ_MS.app; not asked while the app in front doesn't answer (it would only hold the phone): unknown
   * then, never a guess.
   */
  async activeApp(udid: string): Promise<string | null> {
    const e = this.entries.get(udid);
    const said = (v: any) => (typeof v?.bundleId === 'string' && v.bundleId ? (v.bundleId as string) : null);
    if (e && this.stalled(e)) return null;
    try {
      const v = (await this.read(udid, '/wda/activeAppInfo', this.timeouts.appRead ?? APP_READ_MS.app, { explicit: true }))?.value;
      if (e && v && said(v)) this.setApp(e, v, 'read');
      return said(v);
    } catch {
      return null;
    }
  }

  /**
   * 2026-11-18: one press of a button that never heals or recovers WDA (the phone's silence: src/audio.ts), on the
   * session when there is one, else session-less. Rejects like callSoft (a WDA that isn't up is tried again later).
   */
  async pressSoft(udid: string, name: ButtonName, timeout = 4000): Promise<void> {
    const sid = this.entries.get(udid)?.sessionId;
    if (sid) {
      try {
        await this.callSoft(udid, 'POST', `/session/${sid}/wda/pressButton`, { name }, timeout);
        return;
      } catch (err) {
        if (!(err instanceof WdaError) || err.kind !== 'unknown') {
          if (this.entries.get(udid)?.sessionId === sid) throw err;
        }
      }
    }
    await this.callSoft(udid, 'POST', '/wda/pressButton', { name }, timeout);
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
    const timeout = 10000 + Math.ceil((text.length * 1000) / Math.max(1, keysPerSecond)) * 2;
    const body = { value: Array.from(text), frequency: Math.max(1, Math.round(keysPerSecond)) };
    await this.sendOnce(await this.usable(udid), '/wda/keys', body, timeout, text);
  }

  /**
   * One session POST sent once only (typing, keys): never again after a recovery or on a stale socket, since part of
   * it may have happened; only a refused session (nothing happened) is asked again on a new one. `typed`: taken out of
   * any error. Throws the plain WdaError of an unknown route as it is (`kind: "unknown"`), everything else named.
   */
  private async sendOnce(e: Entry, sub: string, body: unknown, timeout: number, typed: string, via: CallVia = {}, sessionless = false): Promise<void> {
    const how: Via = via.explicit ? { explicit: true } : {};
    e.inflight++;
    try {
      if (sessionless) await this.raw(e, 'POST', sub, body, timeout, false, how);
      else {
        const sid = await this.session(e);
        try {
          await this.raw(e, 'POST', `/session/${sid}${sub}`, body, timeout, false, how);
        } catch (err) {
          // a session WDA no longer knows refused the request before typing anything: once more on a new one
          if (!(err instanceof WdaError) || err.kind !== 'session') throw err;
          e.sessionId = undefined;
          await this.raw(e, 'POST', `/session/${await this.session(e)}${sub}`, body, timeout, false, how);
        }
      }
      e.lastOk = Date.now();
    } catch (err) {
      // never the text in a log or an answer (XCTest names its event after the first letters)
      const safe = err instanceof WdaError ? Object.assign(new WdaError(err.kind, scrubTyped(err.message, typed)), { timeout: err.timeout, conn: err.conn }) : err;
      if (safe instanceof WdaError && safe.down && !safe.timeout) void this.recover(e, safe.message, safe.kind === 'session', safe.conn).catch(() => {});
      throw this.named(e, safe);
    } finally {
      e.inflight--;
    }
  }

  /**
   * What the keyboard can do on this phone (2026-11-24): "full" = keys and shortcuts too (a stock WDA, or our build v5+);
   * "text" = only text, Return, Backspace and Tab (an older build of ours serves no other key route).
   */
  keysMode(udid: string): 'full' | 'text' {
    const e = this.entries.get(udid);
    if (!e) return 'text';
    if (e.flavor === 'fork' || e.token || e.forkInfo) return (e.forkInfo?.lotus ?? 0) >= KEYS_FORK_VERSION ? 'full' : 'text';
    return 'full';
  }

  /**
   * One key, `n` times, with its modifiers (2026-11-24, the owner's keyboard). A plain key (an arrow, Tab, Esc, forward
   * delete) goes as a HID keypress, which asks nothing of the app in front: our build's /lotus/keys in one request, a
   * stock WDA's performIoHidEvent press by press. One with modifiers goes through WDA's keyboardInput (XCTest's typeKey),
   * which looks the app in front up: while that app doesn't answer (TikTok's feed), our build plays it as an event
   * record instead (/lotus/keys, no lookup; WDA_KEYS=record always does). Sent once only, like text.
   */
  async pressKey(udid: string, p: KeyPress): Promise<void> {
    const e = await this.usable(udid);
    const named = isNamed(p.key) ? NAMED[p.key] : null;
    const ours = !!(e.flavor === 'fork' || e.token || e.forkInfo);
    if (this.keysMode(udid) !== 'full') {
      const text = !p.mods.length ? named?.text ?? (p.key === 'tab' ? '\t' : undefined) : undefined;
      if (text !== undefined) return this.sendOnce(e, '/wda/keys', { value: Array.from(text.repeat(p.n)), frequency: 30 }, 15_000, text);
      throw this.noKeys(udid);
    }
    const timeout = 6000 + p.n * 150;
    try {
      if (!p.mods.length && named) {
        if (ours) return await this.sendOnce(e, FORK_ROUTES.keys, { keys: [{ usage: named.usage, n: p.n }] }, timeout, '', {}, true);
        for (let i = 0; i < p.n; i++) await this.sendOnce(e, '/wda/performIoHidEvent', { page: 0x07, usage: named.usage, duration: 0.01 }, 6000, '');
        return;
      }
      const key = named?.xcui ?? p.key;
      const modifierFlags = modFlags(p.mods);
      const record = () => this.sendOnce(e, FORK_ROUTES.keys, { keys: [{ key, modifierFlags, n: p.n }] }, timeout, '', {}, true);
      if (ours && process.env.WDA_KEYS === 'record') return await record();
      try {
        await this.sendOnce(e, '/wda/element/0/keyboardInput', { keys: Array.from({ length: p.n }, () => ({ key, modifierFlags })) }, timeout, '', { explicit: true });
      } catch (err) {
        // the app in front doesn't answer accessibility, so nothing was sent: the way that doesn't ask it
        if (ours && err instanceof LaneBusy && err.extra?.appRead === 'busy') return await record();
        throw err;
      }
    } catch (err) {
      if (err instanceof WdaError && (err.kind === 'unknown' || /typeKey API|can't press/i.test(err.message))) throw this.noKeys(udid);
      throw err;
    }
  }

  private noKeys(udid: string): HttpError {
    return new HttpError(501, `the WebDriverAgent build on ${this.nameOf(udid)} can't press shortcuts and arrows yet: the server installs the new one by itself, try again in a few minutes`, { state: 'keys-text' });
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
      const v = (await this.callNoSession(udid, 'POST', FORK_ROUTES.field, { clear }, clear ? 20000 : 8000, { explicit: true }))?.value;
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
        await this.call(udid, 'POST', `/element/${id}/clear`, {}, 15000, { explicit: true }).catch(() => {});
      } else {
        // Cmd+A selects the whole field; one Delete empties it (a Delete after nothing was selected takes one letter)
        await this.call(udid, 'POST', '/wda/element/0/keyboardInput', { keys: [{ key: 'a', modifierFlags: 1 << 4 }] }, 8000, { explicit: true });
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
      const v = (await this.call(udid, 'GET', '/element/active', undefined, this.timeouts.appRead ?? APP_READ_MS.element, { explicit: true }))?.value;
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
        return (await this.call(udid, 'GET', `/element/${id}/attribute/${name}`, undefined, this.timeouts.appRead ?? APP_READ_MS.element, { explicit: true }))?.value ?? null;
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
      if (err instanceof WdaError && !err.down && err.kind !== 'server') {
        // the route refused it: this touch goes the old way; after 3 in a row, every touch does until WDA restarts
        // (a 5xx is WDA failing it, "too many touches waiting": said as it is, never played a second way)
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
      if (!e.wanted || e.status !== 'ready' || e.recovering || e.restartP || e.downWhy || e.checking || this.absent.has(e.udid)) continue;
      if (e.sessionId && Date.now() - Math.max(e.lastOk, e.lastAnswer) < HEALTH_MS - 1000) continue; // it answered lately
      if (e.inflight > 0 || !e.lane.idle) continue; // busy with something: that request finds out for itself
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
          // 2026-11-22: its connection refused or reset: WDA's process (or its forward) is gone, checked now
          if (st.conn) return void (await this.recover(e, `health check: /status ${st.why ?? 'unreachable'}`, false, true).catch(() => {}));
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
            if (err instanceof LaneBusy) return; // the phone is busy with something of ours: asked again next time
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
  async shot(udid: string, scale: number, quality: number, timeout = 8000, quiet = false): Promise<Buffer> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted || e.status !== 'ready' || !e.forkInfo) throw new WdaError('rejected', `our WebDriverAgent build isn't up on ${this.nameOf(udid)}`);
    let v: any;
    try {
      // `quiet` (the watch's look at a dark screen): skipped while anything else is on its way to the phone
      v = (await this.raw(e, 'GET', `${FORK_ROUTES.shot}?scale=${Math.round(scale)}&quality=${Math.round(quality)}`, undefined, timeout, true, quiet ? { prio: 'quiet' } : {}))?.value;
    } catch (err) {
      throw this.named(e, err);
    }
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
