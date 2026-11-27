import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInstalled, withKnown } from './apps.js';
import { AudioFeed, AudioHub, VolumeGuard } from './audio.js';
import { Config } from './config.js';
import { jpegMaybeBlack, pngIsBlack, wakeScreen } from './dark.js';
import { H264Info, H264Source, H264Viewer, helperProducer, phoneStats, Rec, StartProducer } from './h264.js';
import { basicFacts, mergeBattery, parseActiveApp, parseBatteryDomain, parseDeviceInfo, parseIoreg, parseWdaBattery } from './info.js';
import { noteSource, noteUnlocked, PhonecapHost, profileFor, setCaptureBackend } from './lanes.js';
import { FieldState, scrubTyped } from './field.js';
import { PhoneFiles, RealFiles } from './phonefiles.js';
import { TOKEN_HEADER } from './fork.js';
import { isText, KeyStep, pieces } from './keys.js';
import { HidHost, HidPartial, hidPlayMs, HidTimeout, hidTypable, iosMajor, toHid } from './hid.js';
import type { InputResult } from './inputlog.js';
import { MjpegSource } from './mjpeg.js';
import { imageSize } from './imgsize.js';
import { frameAgrees, Orientation, Size } from './orient.js';
import { actorsFor, Actors, Job } from './phone/actor.js';
import { Budgeted, CaptureLook, isVideoApp, LOOK_GAP_VIDEO_MS, PictureToken, tokenHash } from './phone/look.js';
import type { PowerFeed, PowerObservation } from './phone/power.js';
import { still, stillHash, StillSource } from './stills.js';
import { AppInfo, Backend, ButtonName, ControlState, H264Want, HttpError, Image, ImageFormat, InputMethods, PathPoint, PhoneFacts, PhoneInfo, PhoneState, ScreenInfo, StreamSettings } from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // src/ or dist/ -> project root
// inside a minimal app bundle so macOS gives it its own Camera (TCC) entry (scripts/build-native.mjs)
const HELPER = process.env.PHONECAP_PATH || path.join(ROOT, 'native', 'phonecap', 'build', 'PhoneCap.app', 'Contents', 'MacOS', 'phonecap');
const HELPER_ERROR = path.join(ROOT, 'native', 'phonecap', 'build', 'phonecap.error');
// what the built helper speaks (scripts/build-native.mjs writes it from main.swift's "phonecap-caps:" line)
const HELPER_CAPS = path.join(ROOT, 'native', 'phonecap', 'build', 'phonecap.caps');
// CoreDevice HID live touch (docs/BEST_METHOD.md, plan item 1): one sidecar per phone
const HID_SCRIPT = path.join(ROOT, 'native', 'hid', 'hid_input.py');
// the venv RINOR_TAP_CHECK.md makes; HID_PYTHON wins
const HID_VENV_PYTHON = path.join(os.homedir(), '.phonefarm-hid', 'bin', 'python');
const HID_RETRY_MS = 60000;
/** 2026-11-18: text through the HID keyboard only when asked (see type()). */
const HID_TYPING = process.env.HID_TYPING === '1';
/** How fast the phone's keyboard types (keys a second; about HID's old pace, readable on the phone's screen). */
const TYPE_KEYS_PER_SECOND = Math.min(60, Math.max(4, Number(process.env.TYPE_KEYS_PER_SECOND) || 15));
/** 2026-11-24: the owner's own keyboard keeps up with a fast typist; pasted text at WDA's own full speed. */
const OWNER_KEYS_PER_SECOND = 40;
const PASTE_KEYS_PER_SECOND = 60;
/**
 * 2026-11-16: a phone's USB screen capture runs only while a live view of it is open. It starts with the first viewer
 * and stops this long after the last one left (long enough for a page to redraw or a WebRTC session to be made anew,
 * no longer): iOS tells apps while the screen is captured (UIScreen.isCaptured), so it's never kept warm, started
 * ahead or kept for the phone in focus. The live touch session (HID) goes by the same rule.
 */
export const CAPTURE_GRACE_MS = 2500;
/** How long a picture may disagree with the phone's orientation (wide against tall) before the capture starts over. */
const CAPTURE_SETTLE_MS = 1200;
const CAPTURE_RESTARTS = 2;
const APPS_FRESH_MS = 5 * 60_000;

/** What to do about a capture whose picture hasn't got the phone's shape (pure; `rotate` = CAPTURE_ROTATE). */
export function captureFix(frame: Size, o: Orientation | null, s: { rotated: number; tries: number; rotate: 'off' | 'cw' | 'ccw' }): 'ok' | 'unrotate' | 'restart' | 'rotate' | 'give-up' {
  if (frameAgrees(frame, o)) return 'ok';
  if (s.rotated % 180 !== 0) return 'unrotate'; // it's our own quarter turn that disagrees now
  if (s.tries < CAPTURE_RESTARTS) return 'restart'; // a new capture session takes the screen's size as it is now
  return s.rotate === 'off' ? 'give-up' : 'rotate';
}

interface CaptureState {
  size?: Size;
  timer?: NodeJS.Timeout;
  tries: number;
  mismatch: string | null;
}

/** The built helper's capabilities ("lanes": several encoders from one capture); none for an older build. */
function helperCaps(): string[] {
  if (process.env.PHONECAP_LANES === '0') return [];
  try {
    return fs.readFileSync(HELPER_CAPS, 'utf8').split(/[\s,]+/).filter(Boolean);
  } catch {
    return [];
  }
}
import { FAST_TAP_HOLD_MS, WdaError, WdaManager } from './wda.js';
import { LaneBusy } from './lane.js';
import { OFFLINE_AFTER_MS, Presence } from './presence.js';
import type { WdaFlavor } from './fork.js';

/** Our build's quick still (GET /lotus/shot): the size and quality the stock WDA's MJPEG frames had (percent). */
const FORK_STILL = { scale: 50, quality: 50 };

function run(cmd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

/** How the backend runs a command and gets its output (tests give their own). */
export type RunCmd = (cmd: string, args: string[], timeout?: number) => Promise<string>;

/** The lock's own wait (2026-11-16): short; the state is asked afterwards. */
const LOCK_TIMEOUT_MS = 3000;
/** The screenshot that says whether the screen is dark waits this long at most. */
const DARK_SHOT_MS = 5000;
/** A wake waits this long at most for the phone's WDA to come up (a restart under way) before it says it can't. */
const WAKE_WDA_WAIT_MS = 15_000;
/**
 * 2026-11-21: a still (GET /screenshot) is answered within this, whatever the phone is doing: Lotus waits 20 s and
 * said "The phone server can't be reached" for a still that took longer (an 8 s still, a 5 s one, a 30 s PNG behind
 * them, all waiting on the same busy phone). A still that can't come in time says why instead.
 */
export const STILL_BUDGET_MS = 15_000;
/** The live view's capture gave a changed frame this recently: the screen is on (no screenshot asked to know). */
export const MOVING_MS = 1000;
/** A look (a still, a tree, the app in front, the lock word) must start within this long, else it's refused: busy. */
const LOOK_START_MS = 15_000;
/** The detail card's reads wait this long at most for their turn (they're never worth waiting for). */
const CARD_START_MS = 2500;
/** A still of the capture may be this old (its picture known to still be the screen) to answer a screenshot. */
const CAPTURE_STILL_AGE_MS = 500;
/**
 * The lane the agent's capture runs on when no viewer's lane runs (2026-11-27): the frame rate is what tells a
 * settled screen (no new frame for 150 ms) from a moving one, so it's a full-rate lane at a small size.
 */
const AGENT_LANE = { fps: 30, scale: 35, quality: null } as const;

/**
 * 2026-11-27: what src/h264.ts's H264Source gains with the capture's state machine (CaptureNet, docs/root-cause.md
 * G7): feature-detected, so this works with the source as it is and as it becomes.
 */
interface SourceExtras {
  hold?(reason: string): () => void;
  still?(maxAgeMs: number, timeoutMs?: number): Promise<{ data: Buffer; mime: string; capturedAt: number; validAt: number } | null>;
  counters?(): { srcFrames: number };
  captureState?(): string;
  sourceTime?(): number | null;
}

/** The agent's (or a client's) hold on a phone's capture, and what it counts of the picture. */
interface PictureHold {
  src: H264Source;
  reasons: Map<number, string>;
  release: () => void;
  /** Counted by our own sink when the source has no counters: new frames, the last one's time, the last keyframe's. */
  gen: number;
  movedAt: number;
  keyAt: number;
}


export class RealBackend implements Backend, CaptureLook, PowerFeed {
  readonly mock = false;
  private phones = new Map<string, PhoneInfo>();
  private wda: WdaManager;
  private sources = new Map<string, MjpegSource>();
  private h264Sources = new Map<string, H264Source>(); // "udid" (an older helper) or "udid|lane key"
  private hosts = new Map<string, PhonecapHost>(); // one phonecap process per phone, shared by its lanes
  private streams = new Map<string, Set<StreamSettings>>(); // what each stream subscriber asked for
  private timer: NodeJS.Timeout;
  private polling = false;
  private hid = new Map<string, HidHost>(); // CoreDevice HID live touch, per phone (iOS 27+)
  private capture = new Map<string, CaptureState>(); // each phone's picture shape against its orientation
  private appCache = new Map<string, { at: number; apps: AppInfo[] }>();
  private seen = new Map<string, number>(); // when each phone was last plugged in (Date.now())
  private playFails = new Map<string, { at: number; error: string }>(); // a queued HID gesture that failed while playing
  private audioHubs = new Map<string, AudioHub>(); // each phone's sound (src/audio.ts)
  private volume: VolumeGuard; // the phone's media volume while its sound is on the Mac
  /** Which phones are plugged in: one poll that misses a phone never counts as an unplug (src/presence.ts). */
  private presence = new Presence();
  /** A closed capture host's start and stop times (the host itself is gone). */
  private capTimes = new Map<string, { startedAt: number | null; stoppedAt: number | null }>();
  private runCmd: RunCmd;
  /** Set by the server: a phone's orientation or upright size changed. */
  onOrientation?: (udid: string) => void;
  readonly files: PhoneFiles;
  /** 2026-11-27: every phone's actor (src/phone/actor.ts): every WDA request of this backend goes through it. */
  private readonly actors: Actors;
  /** Who hears what was seen of a phone's screen (src/idle.ts's power state). */
  private powerWatchers = new Set<(udid: string, o: PowerObservation) => void>();
  /** The screen as last seen (lit, dark or locked) and when, per phone. */
  private screenSeen = new Map<string, { screen: PowerObservation['screen']; at: number }>();
  /** The captures held open for the agent or a client (holdPicture). */
  private pictureHolds = new Map<string, PictureHold>();
  private holdSeq = 0;
  /** WDA stills' hashes (no capture): single-flight, coalesced, at most one per LOOK_GAP_VIDEO_MS on a video app. */
  private stillLooks: Budgeted<string | null>;
  /** When each phone's last WDA still was taken (performance.now()), for the budget and to give it again when no input came since. */
  private stillLookAt = new Map<string, number>();
  /** Explicit stills on their way (the same ask shares one). */
  private shotFlights = new Map<string, Promise<Image>>();
  /** The owner's `agentSeesCapture` (default on): the agent may start and read the phone's capture. */
  private seesCapture: () => boolean;

  /** `opts` (tests): the command runner, a WdaManager and a Presence of their own, and no polling timer. */
  constructor(private cfg: Config, opts: { run?: RunCmd; wda?: WdaManager; presence?: Presence; timer?: boolean } = {}) {
    this.runCmd = opts.run ?? run;
    this.actors = actorsFor(this);
    const asked = (cfg as Config & { agentSeesCapture?: boolean }).agentSeesCapture;
    const env = process.env.AGENT_SEES_CAPTURE;
    const fixed = asked ?? (env === undefined ? true : !/^(0|false|off|no)$/i.test(env.trim()));
    this.seesCapture = () => fixed;
    // the capture registry (src/lanes.ts acquireCapture, latestFrame) reaches this backend's sources
    setCaptureBackend(this);
    this.stillLooks = new Budgeted<string | null>(
      (udid, signal) =>
        this.look(udid, 'still', () => {
          if (signal.aborted) return Promise.resolve(null);
          this.stillLookAt.set(udid, performance.now());
          return stillHash(this.stills(udid, true));
        }),
      { gapMs: (udid) => (this.videoInFront(udid) ? LOOK_GAP_VIDEO_MS : 0) },
    );
    if (opts.presence) this.presence = opts.presence;
    this.wda = opts.wda ?? new WdaManager(cfg, (udid) => this.phones.get(udid)?.name ?? udid);
    // 2026-11-24: files straight to each phone's control app, past its request lane (routes off WDA's main queue)
    this.files = new RealFiles({ target: (udid) => this.wda.filesTarget(udid), ask: (udid) => this.wda.filesAsk(udid), tokenHeader: TOKEN_HEADER });
    const silent = cfg.phoneSilent !== false;
    this.volume = new VolumeGuard({
      percent: cfg.audio === false || silent ? 0 : cfg.audioPhoneVolume ?? 0,
      silent,
      // 2026-11-18: presses that never recover WDA (a silence is tried again when it comes up); never "up" while silent
      // 2026-11-27: power jobs of the phone's actor (never in an input's turn)
      press: (udid, dir) =>
        dir === 'up'
          ? silent
            ? Promise.reject(new Error('the phones stay silent'))
            : this.job(udid, { kind: 'power', label: 'volume up', startWithinMs: 30_000, run: () => this.wda.pressButton(udid, 'volumeUp') })
          : this.job(udid, { kind: 'power', label: 'volume down', startWithinMs: 30_000, run: () => this.wda.pressSoft(udid, 'volumeDown') }),
      file: path.join(cfg.dataDir, 'audio-volume.json'),
      gapMs: 60,
    });
    // a phone left raised by a crash or a restart goes back to 0 first (tried again while its WDA isn't up yet)
    this.volume.recover();
    // its known screen size by model (src/screens.ts), when WDA gives nothing usable
    this.wda.modelOf = (udid) => this.phones.get(udid)?.model || null;
    // 2026-11-18: every time a phone's WDA comes up (a start, a restart, a rebuild), its volume goes all the way down
    this.wda.onSession = (udid, fresh) => {
      if (silent && fresh) void this.volume.silence(udid, true, 'its WebDriverAgent came up').catch(() => {});
    };
    this.wda.onOrientation = (udid) => {
      const c = this.capture.get(udid);
      if (c) c.tries = 0; // the phone turned: a new chance for the capture to follow
      this.captureCheck(udid);
      this.onOrientation?.(udid);
    };
    // 2026-11-22: when the live view's capture started and stopped, for the record of how a WDA runner ended
    this.wda.captureTimes = (udid) => {
      const h = this.hosts.get(udid);
      return h ? { startedAt: h.startedAt, stoppedAt: h.stoppedAt } : this.capTimes.get(udid) ?? { startedAt: null, stoppedAt: null };
    };
    void this.poll();
    this.timer = setInterval(() => void this.poll(), cfg.pollMs);
    if (opts.timer === false) clearInterval(this.timer);
  }

  private info(udid: string, args: string[]): Promise<string> {
    return this.runCmd('ideviceinfo', ['-u', udid, ...args]).catch(() => '');
  }

  /**
   * Which phones are plugged in (src/presence.ts). 2026-11-21: a phone missing from one `idevice_id -l` is only
   * missing (its USB screen capture starting makes it re-enumerate; a usbmux hiccup): nothing is torn down and WDA
   * waits for it rather than restarting. Only one missed for OFFLINE_AFTER_MS (several polls in a row) is unplugged:
   * then its WDA stops and its live view, HID and app list go. A phone that's known is updated in place, never
   * replaced (its name, model and iOS stay; the battery is read again).
   */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let ids: string[] = [];
      try {
        ids = (await this.runCmd('idevice_id', ['-l'])).split(/\s+/).filter(Boolean);
      } catch (err) {
        // the list itself failed (a timeout while usbmuxd or CoreDevice is busy): nobody is missed for it
        console.error('idevice_id failed (is libimobiledevice installed?):', (err as Error).message);
        return;
      }
      const change = this.presence.update(ids);
      for (const udid of ids) {
        const prev = this.phones.get(udid);
        const [name, model, ios, batt] = await Promise.all([
          prev?.name && prev.name !== udid ? prev.name : this.info(udid, ['-k', 'DeviceName']),
          prev?.model ? prev.model : this.info(udid, ['-k', 'ProductType']),
          prev?.ios ? prev.ios : this.info(udid, ['-k', 'ProductVersion']),
          this.info(udid, ['-q', 'com.apple.mobile.battery', '-k', 'BatteryCurrentCapacity']),
        ]);
        // it may have gone (or come) while ideviceinfo was asked: the newest word on it counts
        if (!this.presence.has(udid)) continue;
        const paired = !!name; // empty output = not trusted/paired yet
        const b = Number.parseInt(batt, 10);
        const battery = Number.isFinite(b) ? b : prev?.battery ?? null;
        if (prev) {
          if (!prev.online) this.seen.set(udid, Date.now());
          if (name) prev.name = name;
          else if (!prev.name) prev.name = udid;
          if (model) prev.model = model;
          if (ios) prev.ios = ios;
          prev.battery = battery;
          prev.online = true;
        } else {
          this.seen.set(udid, Date.now());
          this.phones.set(udid, {
            udid, name: name || udid, model, ios,
            battery, online: true, ready: false,
            control: 'down', scale: null, point_width: null, point_height: null, width: null, height: null,
          });
        }
        this.wda.setPresent(udid, true);
        // start() does nothing for a phone whose WDA is wanted already (one that was only missing a moment)
        if (paired && this.cfg.autostartWda) this.wda.start(udid);
      }
      for (const udid of change.back) console.log(`[usb ${udid.slice(-8)}] back after a moment off the USB list: nothing was torn down`);
      for (const udid of change.missing) {
        if (!this.phones.get(udid)?.online) continue;
        console.log(`[usb ${udid.slice(-8)}] not in idevice_id's list this time (a re-enumeration or a usbmux blip?): kept as it is; it counts as unplugged only after ${OFFLINE_AFTER_MS / 1000} s`);
        this.wda.setPresent(udid, false);
      }
      for (const udid of change.gone) this.unplugged(udid);
    } finally {
      this.polling = false;
    }
  }

  /** The phone was missed long enough to count as unplugged: its WDA, live view, HID and app list go. */
  private unplugged(udid: string): void {
    const p = this.phones.get(udid);
    if (!p?.online) return;
    console.log(`[usb ${udid.slice(-8)}] unplugged (missing from idevice_id for ${OFFLINE_AFTER_MS / 1000} s or more)`);
    p.online = false;
    this.wda.stop(udid);
    this.closeH264(udid, 'phone unplugged');
    this.hid.get(udid)?.close();
    this.hid.delete(udid);
    this.appCache.delete(udid);
  }

  async list(): Promise<PhoneInfo[]> {
    return [...this.phones.values()].map((p) => {
      const s = this.wda.screen(p.udid);
      const px = (v: number | undefined) => (s?.scale && v ? Math.round(v * s.scale) : null);
      return {
        ...p,
        ready: p.online && this.wda.status(p.udid) === 'ready',
        control: p.online ? this.wda.state(p.udid) : 'down',
        controlDown: p.online ? this.wda.controlDown(p.udid) : null,
        restarting: p.online ? this.wda.restarting(p.udid) : null,
        needsReplug: p.online ? this.wda.needsReplug(p.udid) : false,
        scale: s?.scale ?? null,
        point_width: s?.width ?? null,
        point_height: s?.height ?? null,
        width: px(s?.width),
        height: px(s?.height),
        orientation: this.wda.orientation(p.udid),
        stats: this.stats(p.udid),
      };
    });
  }

  /** The phone's H.264 sources: one per lane (or the one shared source of an older helper). */
  /** 2026-11-27: the phone's state as the clients name it (src/wda.ts phoneState). */
  phoneState(udid: string): PhoneState {
    return this.phones.get(udid)?.online ? this.wda.phoneState(udid) : 'down';
  }

  /** What of ours is on the phone now (the control link's journal). */
  onPhone(udid: string): { op: string; since: number; held: boolean }[] {
    return this.wda.linkHealth(udid)?.onPhone ?? [];
  }

  /** The capture as it is: the held source's, else the freshest running one's; null when none runs. */
  captureState(udid: string): { state: string; why: string | null; pictureAgeMs: number | null } | null {
    const all = this.phoneSources(udid);
    const held = this.pictureSource(udid);
    const pick = held ?? all.filter((s) => s.running).sort((a, b) => (a.sourceAgeMs() ?? Infinity) - (b.sourceAgeMs() ?? Infinity))[0] ?? all[0];
    if (!pick) return null;
    return { state: pick.captureState(), why: pick.stateWhy(), pictureAgeMs: pick.sourceAgeMs() };
  }

  private phoneSources(udid: string): H264Source[] {
    return [...this.h264Sources].filter(([k]) => k === udid || k.startsWith(`${udid}|`)).map(([, s]) => s);
  }

  private closeH264(udid: string, why: string): void {
    for (const [k, s] of [...this.h264Sources]) {
      if (k === udid || k.startsWith(`${udid}|`)) {
        s.close(why);
        this.h264Sources.delete(k);
      }
    }
    const host = this.hosts.get(udid);
    host?.close();
    if (host) this.capTimes.set(udid, { startedAt: host.startedAt, stoppedAt: host.stoppedAt });
    this.hosts.delete(udid);
    const c = this.capture.get(udid);
    if (c?.timer) clearTimeout(c.timer);
    this.capture.delete(udid);
    // its sources are gone: a hold on them is too (the next holdPicture makes a new one)
    this.pictureHolds.delete(udid);
  }

  // ---- the phone's actor (src/phone/actor.ts, 2026-11-27): every WDA request goes through it ----

  /** One job of the phone's actor (inside another of its jobs, e.g. Control's input turn, it runs in that turn). */
  private job<T>(udid: string, j: Job<T>): Promise<T> {
    return this.actors.of(udid).submit(j);
  }

  /** A look at the phone (a still, a tree, the app in front, the lock word): never while an input waits or runs. */
  private look<T>(udid: string, label: string, run: () => Promise<T>, startWithinMs = LOOK_START_MS, appBound = false): Promise<T> {
    // 2026-11-27: a read of the app in front (the tree, its name, its orientation) holds WDA's one main queue for as
    // long as the app takes to answer: it never starts while the owner drives the phone (root cause section 8)
    return this.job(udid, { kind: 'look', label, startWithinMs, who: { server: 'look' }, run, ...(appBound ? { yieldToOwner: true } : {}) });
  }

  /** An input of the backend's own (a caller outside Control's queue); inside Control's input turn it's that turn. */
  private input<T>(udid: string, label: string, run: () => Promise<T>): Promise<T> {
    return this.job(udid, { kind: 'input', label, must: true, run });
  }

  /** The app in front is a video app, as last known (only the look budget uses this). */
  private videoInFront(udid: string): boolean {
    const k = this.wda.knownApp(udid);
    const id = k?.info && typeof k.info === 'object' ? (k.info as { bundleId?: unknown }).bundleId : null;
    return isVideoApp(typeof id === 'string' ? id : null);
  }

  // ---- what was seen of the screen (src/phone/power.ts): told to the idle lock's power state ----

  watchPower(cb: (udid: string, o: PowerObservation) => void): () => void {
    this.powerWatchers.add(cb);
    return () => void this.powerWatchers.delete(cb);
  }

  private observe(udid: string, screen: PowerObservation['screen'], from: string): void {
    // the capture's WaitingUnlock (src/h264.ts `locked`): what was last seen; a lit screen after a lock lets it retry
    const before = this.screenSeen.get(udid)?.screen;
    this.screenSeen.set(udid, { screen, at: Date.now() });
    if (screen === 'on' && before && before !== 'on') noteUnlocked(udid);
    for (const cb of this.powerWatchers) {
      try {
        cb(udid, { screen, from, at: Date.now() });
      } catch {
        /* a watcher's failure is its own */
      }
    }
  }

  /** Seen locked or dark, and not lit since: true; seen lit: false; never seen: null (src/h264.ts `locked`). */
  private seenLocked(udid: string): boolean | null {
    const s = this.screenSeen.get(udid);
    if (!s) return null;
    return s.screen !== 'on';
  }

  // ---- the agent's eyes: the phone's capture (src/phone/look.ts CaptureLook, 2026-11-27) ----

  /** The owner's `agentSeesCapture` (the server wires it to its settings; default on, AGENT_SEES_CAPTURE=0 turns it off). */
  setAgentSeesCapture(fn: () => boolean): void {
    this.seesCapture = () => {
      try {
        return fn() !== false;
      } catch {
        return true;
      }
    };
  }

  /** The phone's source the agent reads: the held one, else a running one with a picture. */
  private pictureSource(udid: string): H264Source | null {
    const h = this.pictureHolds.get(udid);
    if (h && this.h264Sources.has(this.sourceKey(udid, h.src))) return h.src;
    return this.phoneSources(udid).find((s) => s.running && s.ready) ?? null;
  }

  private sourceKey(udid: string, src: H264Source): string {
    for (const [k, s] of this.h264Sources) if (s === src && (k === udid || k.startsWith(`${udid}|`))) return k;
    return '';
  }

  /** The capture's picture token, when it runs with a picture and the agent may see it; else null. */
  pictureToken(udid: string): PictureToken | null {
    if (!this.seesCapture()) return null;
    const src = this.pictureSource(udid);
    if (!src || !src.ready) return null;
    const x = src as unknown as SourceExtras;
    const state = x.captureState?.();
    if (state && state !== 'Live' && state !== 'Still') return null;
    const h = this.pictureHolds.get(udid);
    const own = h && h.src === src ? h : null;
    const gen = x.counters ? x.counters().srcFrames : own ? own.gen : src.movedAt;
    return {
      gen,
      movedAt: src.movedAt || own?.movedAt || 0,
      keyAt: x.sourceTime?.() ?? own?.keyAt ?? 0,
      width: src.info?.width ?? null,
      height: src.info?.height ?? null,
    };
  }

  /**
   * Keep the phone's capture running for `reason` until the returned release (2026-11-27: the capture runs whenever
   * a client or an agent works on the phone, not only under a live view). Null when it can't run here, or (an
   * agent's) when the owner keeps the agent from it.
   */
  holdPicture(udid: string, reason: string): (() => void) | null {
    if (reason !== 'client' && !this.seesCapture()) return null;
    if (this.helperProblem() || !this.phones.get(udid)?.online) return null;
    let h = this.pictureHolds.get(udid);
    if (!h || !this.h264Sources.has(this.sourceKey(udid, h.src))) {
      // a viewer's lane that runs, else the agent's own (a full-rate lane at a small size)
      let src: H264Source | string | null = this.phoneSources(udid).find((s) => s.running) ?? null;
      if (!src) {
        try {
          src = this.h264(udid, { ...AGENT_LANE });
        } catch {
          return null;
        }
      }
      if (typeof src === 'string') return null;
      h = this.holdOn(udid, src);
      this.pictureHolds.set(udid, h);
    }
    const hold = h;
    const id = ++this.holdSeq;
    hold.reasons.set(id, reason);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      hold.reasons.delete(id);
      if (!hold.reasons.size && this.pictureHolds.get(udid) === hold) {
        this.pictureHolds.delete(udid);
        hold.release();
      }
    };
  }

  /** Hold one source open: its own hold when it has one (CaptureNet), else a viewer of ours that counts its frames. */
  private holdOn(udid: string, src: H264Source): PictureHold {
    const x = src as unknown as SourceExtras;
    const h: PictureHold = { src, reasons: new Map(), release: () => {}, gen: 0, movedAt: 0, keyAt: 0 };
    const releases: (() => void)[] = [];
    if (typeof x.hold === 'function') releases.push(x.hold('agent or client working on the phone'));
    if (typeof x.hold !== 'function' || !x.counters) {
      // our own viewer: keeps the capture on (a source runs while it has viewers) and counts the new frames
      const sink = new H264Viewer(
        {
          kind: 'ws',
          dropBytes: Number.MAX_SAFE_INTEGER,
          buffered: () => 0,
          open: () => true,
          send: (r: Rec & { repeat?: boolean }) => {
            if (r.repeat) return;
            if (r.kind === 3) {
              h.gen++;
              h.movedAt = Date.now();
            } else if (r.kind === 2) h.keyAt = Date.now();
          },
          fail: () => {
            if (this.pictureHolds.get(udid) === h) this.pictureHolds.delete(udid);
          },
        },
        src,
      );
      src.add(sink);
      releases.push(() => src.remove(sink));
    }
    h.release = () => {
      for (const r of releases) r();
    };
    return h;
  }

  /** A still of the capture's own picture (when the capture makes stills), else null: never WDA. */
  async capturePicture(udid: string, format: ImageFormat): Promise<Image | null> {
    if (!this.seesCapture()) return null;
    const src = this.pictureSource(udid) as (H264Source & SourceExtras) | null;
    if (!src || typeof src.still !== 'function') return null;
    const s = await src.still(CAPTURE_STILL_AGE_MS).catch(() => null);
    if (!s) return null;
    const type = s.mime === 'image/png' ? 'png' : 'jpeg';
    if (type !== format) return null;
    return { data: s.data, contentType: s.mime === 'image/png' ? 'image/png' : 'image/jpeg' };
  }

  // ---- orientation: the phone's (WDA) against the capture's picture ----

  orientation(udid: string): Orientation | null {
    return this.wda.orientation(udid);
  }

  /** 2026-11-22: WDA is asked only for Lotus's own read of the screen (`explicit`); everyone else gets what's known. */
  refreshOrientation(udid: string, maxAgeMs?: number, explicit = false): Promise<Orientation | null> {
    // only an explicit read asks the phone: a look of the actor's (never while an input waits)
    if (!explicit) return this.wda.refreshOrientation(udid, maxAgeMs, false);
    return this.look(udid, 'orientation', () => this.wda.refreshOrientation(udid, maxAgeMs, true), LOOK_START_MS, true);
  }

  /** CAPTURE_ROTATE: off (default), cw / ccw (turn a sideways picture upright that way), or 90 / 180 / 270 (always). */
  private rotateMode(): 'off' | 'cw' | 'ccw' | number {
    const v = (process.env.CAPTURE_ROTATE ?? 'off').trim().toLowerCase();
    if (v === 'cw' || v === 'ccw') return v;
    return v === '90' || v === '180' || v === '270' ? Number(v) : 'off';
  }

  /**
   * A lane's picture size came or changed: the phone may just have turned. 2026-11-22: its shape says how (the USB
   * capture follows the phone as it turns), and WDA is never asked (the app in front's orientation is an accessibility
   * read: a live view opening on TikTok's feed used to send one, which held WDA's main thread).
   */
  private captureInfo(udid: string, info: H264Info): void {
    if (!(info.width > 0) || !(info.height > 0)) return;
    let c = this.capture.get(udid);
    if (!c) this.capture.set(udid, (c = { tries: 0, mismatch: null }));
    c.size = { width: info.width, height: info.height };
    // the picture as the phone is turned: our own quarter turn (CAPTURE_ROTATE) undone first
    const turned = (this.hosts.get(udid)?.rotated ?? 0) % 180 !== 0;
    this.wda.noteFrame(udid, turned ? info.height : info.width, turned ? info.width : info.height);
    this.captureCheck(udid);
  }

  /**
   * Every frame goes out upright with the phone's shape. USB screen capture follows the phone as it turns, but a
   * running capture session can keep the size it started with, so a picture that stays wide while the phone is tall
   * (or the other way) for CAPTURE_SETTLE_MS gets a new capture session (twice at most per turn); if that doesn't
   * put it right, CAPTURE_ROTATE says which way to turn it, else stats.capture_mismatch says what's wrong.
   */
  private captureCheck(udid: string): void {
    const c = this.capture.get(udid);
    if (!c?.size) return;
    const host = this.hosts.get(udid);
    const mode = this.rotateMode();
    if (typeof mode === 'number') return; // a fixed turn: the owner's word
    const canTurn = helperCaps().includes('rotate');
    const state = () => ({ rotated: host?.rotated ?? 0, tries: host?.running ? c.tries : CAPTURE_RESTARTS, rotate: canTurn ? mode : ('off' as const) });
    const tag = `[orient ${udid.slice(-8)}]`;
    if (captureFix(c.size, this.wda.orientation(udid), state()) === 'ok') {
      if (c.mismatch) console.log(`${tag} the picture has the phone's shape again`);
      c.mismatch = null;
      return;
    }
    if (c.timer) return;
    c.timer = setTimeout(() => {
      c.timer = undefined;
      void this.wda.refreshOrientation(udid, 0).then(() => {
        if (!c.size || this.capture.get(udid) !== c) return;
        const o = this.wda.orientation(udid);
        const what = `the capture is ${c.size.width}x${c.size.height} but the phone is ${o}`;
        switch (captureFix(c.size, o, state())) {
          case 'ok':
            c.mismatch = null;
            return;
          case 'unrotate':
            console.log(`${tag} ${what}: no longer turning the picture`);
            host?.rotate(0);
            return;
          case 'restart':
            c.tries++;
            console.log(`${tag} ${what}: starting the capture over (${c.tries}/${CAPTURE_RESTARTS})`);
            host?.restart('the picture kept its old shape after the phone turned; starting the capture over');
            return;
          case 'rotate':
            console.log(`${tag} ${what}: turning the picture (CAPTURE_ROTATE=${mode})`);
            host?.rotate(mode === 'ccw' ? 270 : 90);
            return;
          default:
            if (c.mismatch !== what) console.log(`${tag} ${what}, and a new capture didn't change that. If the picture is sideways set CAPTURE_ROTATE=cw (or ccw) in .env`);
            c.mismatch = what;
        }
      });
    }, CAPTURE_SETTLE_MS);
    c.timer.unref?.();
  }

  private stats(udid: string) {
    const m = this.sources.get(udid);
    const srcs = this.phoneSources(udid);
    const reason = this.helperProblem() ?? srcs.map((s) => s.unavailable()).find((r) => r) ?? null;
    return {
      ...phoneStats(srcs, { fps: m?.viewers ? m.meter.rate() : 0, viewers: m?.viewers ?? 0 }, reason, this.buildError()),
      capture_mismatch: this.capture.get(udid)?.mismatch ?? null,
      audio: this.audioStats(udid),
      ...this.wda.healStats(udid),
      wda_link: this.wda.linkHealth(udid),
    };
  }

  /** Whether the phone's USB screen capture runs right now (a live view is open, or closed a moment ago). */
  capturing(udid: string): boolean {
    return !!this.hosts.get(udid)?.running || this.phoneSources(udid).some((s) => s.running);
  }

  /** The last phonecap build's error while an older helper still runs, else null. */
  private buildError(): string | null {
    if (!fs.existsSync(HELPER) || !fs.existsSync(HELPER_ERROR)) return null;
    try {
      return firstErrorLine(fs.readFileSync(HELPER_ERROR, 'utf8'));
    } catch {
      return null;
    }
  }

  /** The phone's screen, long side in pixels (WDA's points x scale), or null before WDA knows it. */
  private longSide(udid: string): number | null {
    const s = this.wda.screen(udid);
    return s?.scale ? Math.round(Math.max(s.width, s.height) * s.scale) : null;
  }

  /** Why the native H.264 helper can't be used on this Mac, or null. */
  private helperProblem(): string | null {
    if (!this.cfg.h264) return 'H.264 is turned off (H264=false in .env)';
    if (process.platform !== 'darwin') return 'H.264 capture needs macOS';
    if (fs.existsSync(HELPER)) return null;
    try {
      return `the phonecap helper failed to build: ${firstErrorLine(fs.readFileSync(HELPER_ERROR, 'utf8'))}`;
    } catch {
      return 'the phonecap helper is not built (run npm run build on the Mac)';
    }
  }

  /**
   * The H.264 source for a viewer. With a lanes helper: one per lane (a LAN viewer's settings as asked; a far viewer's
   * smaller, 30 fps and following its link), all fed by the phone's one phonecap. With an older helper: one shared
   * source per phone, as before.
   */
  h264(udid: string, want: H264Want): H264Source | string {
    const p = this.known(udid);
    const problem = this.helperProblem();
    if (problem) return problem;
    const lanes = helperCaps().includes('lanes');
    const prof = profileFor(want, this.cfg.h264BitrateMbps * 1_000_000, this.longSide(udid));
    const key = lanes ? `${udid}|${prof.key}` : udid;
    let src = this.h264Sources.get(key);
    if (!src) {
      const online = [...this.phones.values()].filter((x) => x.online).length;
      const args = ['--udid', udid, '--name', p.name];
      if (online === 1) args.push('--any-if-single');
      const tag = udid.slice(-8);
      let start: StartProducer;
      if (lanes) {
        let host = this.hosts.get(udid);
        if (!host) {
          const sound = this.cfg.audio !== false && helperCaps().includes('audio') ? this.audioHub(udid) : undefined;
          this.hosts.set(udid, (host = new PhonecapHost(HELPER, args, tag, undefined, sound)));
          if (sound?.listeners) host.setAudio(true);
          const fixed = this.rotateMode();
          if (typeof fixed === 'number' && helperCaps().includes('rotate')) host.rotate(fixed);
        }
        start = host.start;
      } else start = helperProducer(HELPER, args, tag);
      const kind = prof.thumb ? 'thumb' : prof.remote ? 'remote' : 'lan';
      // it stops a moment after its last viewer left (CAPTURE_GRACE_MS): never kept warm
      src = new H264Source(lanes ? `${tag} ${kind}` : tag, start, prof.settings, {
        kind, onInfo: (info) => this.captureInfo(udid, info), idleMs: CAPTURE_GRACE_MS,
        // 2026-11-27: a start with no picture on a phone seen locked waits for the unlock (no retries burned)
        locked: () => this.seenLocked(udid),
        udid,
      });
      this.h264Sources.set(key, src);
      noteSource(udid, src);
    }
    const down = src.unavailable();
    if (down) return down;
    src.setWant(prof.settings);
    return src;
  }

  // ---- the phone's sound (src/audio.ts) ----

  private audioHub(udid: string): AudioHub {
    let hub = this.audioHubs.get(udid);
    if (hub) return hub;
    const tag = udid.slice(-8);
    hub = new AudioHub(tag, {
      enable: (on) => this.hosts.get(udid)?.setAudio(on),
      // the first frame: the sound is on the Mac now, so the phone's volume can go up (it plays nowhere else)
      flowing: () => void this.volume.raise(udid),
      // nobody listens: back to 0 while the capture still holds the sound (held open until it's done); the capture
      // ended: back to 0 at once
      quiet: (ended) => {
        const release = ended ? undefined : this.hosts.get(udid)?.hold();
        void this.volume.lower(udid).finally(() => release?.());
      },
    });
    this.audioHubs.set(udid, hub);
    return hub;
  }

  /** The phone's sound for a WebRTC live view, or why there's none. */
  audio(udid: string): AudioFeed | string {
    this.known(udid);
    if (this.cfg.audio === false) return 'sound is turned off on the server (AUDIO=false)';
    if (this.helperProblem()) return 'no capture helper on the Mac';
    if (!helperCaps().includes('lanes')) return 'the capture helper on the Mac is too old for sound';
    if (!helperCaps().includes('audio')) return "the capture helper on the Mac has no sound yet (it's rebuilt with the next update)";
    return this.audioHub(udid);
  }

  /** The sound's numbers for GET /phones `stats.audio` (null before anyone asked for it). */
  private audioStats(udid: string) {
    const hub = this.audioHubs.get(udid);
    if (!hub) return null;
    const i = hub.info();
    return { ...i, listeners: hub.listeners, volume_raised: this.volume.isRaised(udid) };
  }

  // ---- the detail card (src/info.ts) ----

  /**
   * Battery and charging from lockdown's battery domain, the temperature from the IORegistry's AppleSmartBattery
   * (both through libimobiledevice, so they work while WDA is down), the app in front and iOS's thermal state from
   * WDA when it's up (quick reads that never wait for it or recover it). Whatever doesn't answer is null.
   */
  async facts(udid: string): Promise<PhoneFacts> {
    const p = this.phones.get(udid);
    if (!p) throw new HttpError(404, `unknown phone ${udid}`);
    const basic: PhoneFacts = { ...basicFacts(p), connectedAt: p.online ? this.seen.get(udid) ?? null : null };
    if (!p.online) return basic;
    const quiet = (cmd: string, args: string[], ms: number) => run(cmd, args, ms).catch(() => '');
    // 2026-11-22: the app in front is never asked for the card (WDA reads it through accessibility, which TikTok's feed
    // left hanging on WDA's one main thread, every time the card looked again): it's what's known (Lotus's own last
    // read, the server's launch, Home), with when and whether the phone had input since
    const known = this.wda.knownApp(udid);
    // 2026-11-27: WDA's reads are looks of the phone's actor, given up at once when the phone is busy (a card's read
    // is never worth a turn on the phone's main queue while input waits)
    const peek = (route: string, alt = false) => this.look(udid, 'card', () => this.wda.peek(udid, route, 2500, alt), CARD_START_MS).catch(() => null);
    const [lockdown, ioreg, dev] = await Promise.all([
      quiet('ideviceinfo', ['-u', udid, '-q', 'com.apple.mobile.battery'], 4000),
      quiet('idevicediagnostics', ['-u', udid, 'ioregentry', 'AppleSmartBattery'], 5000),
      peek('/wda/device/info'),
    ]);
    let batt = mergeBattery(parseBatteryDomain(lockdown), parseIoreg(ioreg));
    if (batt.level === null || batt.charging === null) batt = mergeBattery(batt, parseWdaBattery(await peek('/wda/batteryInfo', true)));
    const d = parseDeviceInfo(dev, Date.now());
    const app = parseActiveApp(known?.info ?? null, this.appCache.get(udid)?.apps ?? null);
    return {
      ...basic,
      battery: { level: batt.level ?? basic.battery.level, charging: batt.charging },
      temperatureC: batt.temperatureC,
      // 2026-11-27 (docs/root-cause.md 13.3d): only a read is an observation (`asOf` its time); the server's own launch
      // or Home press is what it asked for, not what the phone shows: `maybeChanged`, no `asOf`
      app: app && known
        ? known.from === 'read'
          ? { ...app, asOf: known.at, from: known.from, ...(known.changedSince ? { maybeChanged: true } : {}) }
          : { ...app, from: known.from, maybeChanged: true }
        : app,
      uptimeSec: d.uptimeSec,
      bootedAt: d.bootedAt,
      thermal: d.thermal,
    };
  }

  playFailure(udid: string, since: number): string | null {
    const f = this.playFails.get(udid);
    return f && f.at >= since ? f.error : null;
  }

  screen(udid: string): ScreenInfo | null {
    return this.wda.screen(udid);
  }

  private known(udid: string): PhoneInfo {
    const p = this.phones.get(udid);
    if (!p) throw new HttpError(404, `unknown phone ${udid}`);
    if (!p.online) throw new HttpError(503, 'phone is offline');
    return p;
  }

  private source(udid: string): MjpegSource {
    let s = this.sources.get(udid);
    if (!s) {
      s = new MjpegSource(() => this.wda.mjpegPort(udid));
      this.sources.set(udid, s);
    }
    return s;
  }

  /**
   * The phone's stills (src/stills.ts): WDA's own screenshots, never the USB capture's frames. `soft`: the PNG is
   * asked without ever recovering WDA (the server's own looks at the screen).
   */
  private stills(udid: string, soft = false, quiet = false): StillSource {
    return {
      // a stock WDA: a frame of its MJPEG server. Our build has none: its quick JPEG still (GET /lotus/shot), at
      // the size and quality the MJPEG frames had, takes that place; before it's up, the PNG says.
      mjpeg: this.wda.mjpegAvailable(udid)
        ? (maxAgeMs, waitMs) => this.source(udid).grab(maxAgeMs, waitMs)
        : this.wda.forkInfo(udid)
          ? (_maxAgeMs, waitMs) => this.wda.shot(udid, FORK_STILL.scale, FORK_STILL.quality, Math.max(3000, waitMs), quiet).catch(() => null)
          : null,
      png: async (timeoutMs) => {
        // 2026-11-21: never without a bound (it was 30 s), so a still is answered inside a client's wait
        const j = soft
          ? await this.wda.callSoft(udid, 'GET', '/screenshot', undefined, timeoutMs ?? DARK_SHOT_MS, quiet)
          : await this.wda.callNoSession(udid, 'GET', '/screenshot', undefined, timeoutMs ?? STILL_BUDGET_MS - 3000);
        if (typeof j?.value !== 'string') throw new HttpError(502, 'WDA gave no screenshot');
        return Buffer.from(j.value, 'base64');
      },
      orientation: () => this.wda.orientation(udid),
    };
  }

  /**
   * 2026-11-21: the live view's capture (only while one is open: it's never started for this) gave a changed frame
   * within MOVING_MS, so the phone's screen is on and moving. Lets the checks for a dark screen skip WDA's screenshot.
   */
  private screenMoving(udid: string): boolean {
    const now = Date.now();
    return this.phoneSources(udid).some((s) => s.running && s.movedAt > 0 && now - s.movedAt < MOVING_MS);
  }

  /**
   * One still: WDA's screenshot (JPEG from its MJPEG server when it has one, else its PNG). Never the live capture.
   * 2026-11-21: answered within STILL_BUDGET_MS, and a still the phone was too busy for (or gave no answer in time)
   * is said so at once, never followed by a slower one behind it on the same busy phone.
   */
  async screenshot(udid: string, format: ImageFormat, size?: { maxSide?: number; quality?: number }): Promise<Image> {
    const p = this.known(udid);
    const work = this.takeStill(udid, format, size);
    return new Promise<Image>((resolve, reject) => {
      const t = setTimeout(() => {
        work.catch(() => {});
        reject(new HttpError(504, `${p.name} gave no still within ${STILL_BUDGET_MS / 1000} s: its WebDriverAgent is busy or stuck (nothing was restarted); try again in a moment`));
      }, STILL_BUDGET_MS);
      work.then(
        (img) => {
          clearTimeout(t);
          resolve(img);
        },
        (err) => {
          clearTimeout(t);
          reject(err);
        },
      );
    });
  }

  /**
   * 2026-11-27: the capture's own still when it runs (never WDA then); else WDA's, as a look of the phone's actor
   * (never while an input waits), one at a time per phone (the same ask shares one on its way) and, while a video
   * app is in front, at most one per LOOK_GAP_VIDEO_MS.
   */
  private async takeStill(udid: string, format: ImageFormat, size?: { maxSide?: number; quality?: number }): Promise<Image> {
    const cap = await this.capturePicture(udid, format).catch(() => null);
    if (cap) return cap;
    const key = `${udid}|${format}|${size?.maxSide ?? ''}|${size?.quality ?? ''}`;
    const on = this.shotFlights.get(key);
    if (on) return on;
    const p = (async () => {
      const gap = this.videoInFront(udid) ? LOOK_GAP_VIDEO_MS : 0;
      const left = gap - (performance.now() - (this.stillLookAt.get(udid) ?? -Infinity));
      if (left > 0) await new Promise((r) => setTimeout(r, Math.min(left, STILL_BUDGET_MS / 2)));
      return this.look(udid, 'still', () => {
        this.stillLookAt.set(udid, performance.now());
        return this.wdaStill(udid, format, size);
      }, STILL_BUDGET_MS - 1000);
    })();
    this.shotFlights.set(key, p);
    void p.then(() => this.shotFlights.delete(key), () => this.shotFlights.delete(key));
    return p;
  }

  private async wdaStill(udid: string, format: ImageFormat, size?: { maxSide?: number; quality?: number }): Promise<Image> {
    // 2026-11-17: a smaller read on our build: the phone scales its JPEG itself (GET /lotus/shot), so a long side
    // of 800 px at quality 60 comes in a fraction of the PNG's time and bytes
    if (format === 'jpeg' && size?.maxSide && this.wda.forkInfo(udid)) {
      const s = this.wda.screen(udid);
      const long = s ? Math.max(s.width, s.height) * (s.scale || 1) : 0;
      const scale = long > 0 ? Math.min(100, Math.max(10, Math.ceil((size.maxSide / long) * 100))) : FORK_STILL.scale;
      const quality = Math.min(100, Math.max(10, Math.round(size.quality ?? 60)));
      const t0 = performance.now();
      const jpeg = await this.wda.shot(udid, scale, quality, 8000).catch((err) => {
        // busy (never sent) or no answer in time: a PNG behind it would only wait on the same busy phone
        if (err instanceof LaneBusy || (err instanceof WdaError && err.timeout)) throw err;
        return null;
      });
      if (jpeg && frameAgrees(imageSize(jpeg), this.wda.orientation(udid))) {
        if (process.env.INPUT_LOG !== '0') console.log(`[timing] ${udid.slice(-8)} still: ${scale} % at q${quality}, ${jpeg.length} bytes in ${Math.round(performance.now() - t0)} ms`);
        return { data: jpeg, contentType: 'image/jpeg' };
      }
    }
    return still(this.stills(udid), format);
  }

  // ---- input (docs/BEST_METHOD.md): CoreDevice HID when the phone's session is open, else WDA (fast route first) ----

  /** Why this phone can't use HID live touch, or null. */
  private hidProblem(udid: string): string | null {
    if (this.cfg.hidInput === 'off') return 'turned off (HID_INPUT=off)';
    if (process.platform !== 'darwin' && this.cfg.hidInput !== 'on') return 'needs macOS';
    const ios = this.phones.get(udid)?.ios;
    if (this.cfg.hidInput === 'auto' && iosMajor(ios) < 27) return `needs iOS 27 or later (this phone runs iOS ${ios || 'unknown'})`;
    if (!fs.existsSync(HID_SCRIPT)) return 'native/hid/hid_input.py is missing';
    return null;
  }

  private hidHost(udid: string): HidHost | null {
    if (this.hidProblem(udid)) return null;
    let h = this.hid.get(udid);
    if (!h) {
      const python = process.env.HID_PYTHON ? this.cfg.hidPython : fs.existsSync(HID_VENV_PYTHON) ? HID_VENV_PYTHON : this.cfg.hidPython;
      h = new HidHost(udid, {
        python, script: HID_SCRIPT, idleMs: CAPTURE_GRACE_MS, retryMs: HID_RETRY_MS,
        // a path or text answered "queued" that then failed on the phone: the report of that action says so
        onDone: (op, reply) => {
          if (!reply.ok) this.playFails.set(udid, { at: Date.now(), error: `the ${op === 'type' ? 'text' : 'gesture'} broke off on the phone (HID: ${reply.error ?? 'unknown'})` });
        },
      });
      this.hid.set(udid, h);
    }
    return h;
  }

  /**
   * The phone's HID session when it can take a touch right now, with the upright screen and the orientation its
   * reports are turned by (HID's axes are the panel's: src/orient.ts); else why not (null: this phone never has
   * HID), after starting to open it for the next one.
   */
  private hidReady(udid: string): { h: HidHost; s: ScreenInfo; o: Orientation | null } | { why: string | null } {
    const h = this.hidHost(udid);
    if (!h) return { why: null };
    const s = this.wda.screen(udid);
    if (!s) return { why: "HID waits for the screen size (WDA has no session yet)" };
    let o = this.wda.orientation(udid);
    if (o && o !== 'portrait') {
      // HID_LANDSCAPE: on (default), off (WDA takes a turned phone), swap (the two landscapes the other way round)
      const mode = (process.env.HID_LANDSCAPE ?? 'on').trim().toLowerCase();
      if (mode === 'off' || mode === '0' || mode === 'false') return { why: `HID is portrait only here (HID_LANDSCAPE=off) and the phone is ${o}` };
      if (mode === 'swap') o = o === 'landscape-left' ? 'landscape-right' : o === 'landscape-right' ? 'landscape-left' : o;
    }
    if (h.ready()) return { h, s, o };
    // its touch session is a media session on the phone: opened only while a live view holds it (warmInput), never
    // for an agent's tap on a phone nobody watches (WDA takes that)
    if (!h.held) return { why: 'HID live touch opens with a live view (nobody is watching this phone)' };
    h.kick(); // open it for the next one; WDA takes this one
    return { why: `HID is ${h.state}${h.reason ? ` (${h.reason})` : ''}` };
  }

  /**
   * Live touch (a finger held down on the phone from "down" to "up", moved as the moves come) has two ways to the
   * phone: CoreDevice HID (iOS 27+, while a live view holds its session), else our own WebDriverAgent build's
   * /lotus/touch, once the phone's self-test found a way of holding a finger that works there (src/wda.ts liveWhy).
   * A stock WebDriverAgent has neither: the touch is buffered and played whole on "up".
   */
  liveTouchReady(udid: string): boolean {
    if (!this.phones.get(udid)?.online) return false;
    return 'h' in this.hidReady(udid) || this.wda.liveWhy(udid) === null;
  }

  liveTouchWhy(udid: string): string | null {
    const r = this.hidReady(udid);
    if ('h' in r) return null;
    const w = this.wda.liveWhy(udid);
    return w === null ? null : r.why ?? w;
  }

  async liveTouch(udid: string, phase: 'down' | 'move' | 'up', x: number, y: number): Promise<InputResult> {
    this.known(udid);
    return this.input(udid, `touch-${phase}`, () => this.liveTouchNow(udid, phase, x, y));
  }

  private async liveTouchNow(udid: string, phase: 'down' | 'move' | 'up', x: number, y: number): Promise<InputResult> {
    const r = this.hidReady(udid);
    if ('h' in r) {
      const [hx, hy] = toHid(x, y, r.s, r.o);
      await r.h.input(phase, { x: hx, y: hy });
      return { via: 'hid' };
    }
    if (this.wda.liveWhy(udid) !== null) throw new HttpError(503, r.why ?? this.wda.liveWhy(udid) ?? 'live touch is not available on this phone');
    await this.wda.liveTouch(udid, phase, x, y);
    return { via: 'wda-live' };
  }

  // ---- our own WebDriverAgent build (src/fork.ts installs it) ----

  /** How each phone's WebDriverAgent starts and what our build needs (set once, before the phones are found). */
  useFork(fork: NonNullable<WdaManager['fork']>): void {
    this.wda.fork = fork;
  }

  /** Restart the phone's runner as the stock WebDriverAgent or our build, waiting until it answers. */
  async switchWda(udid: string, flavor: WdaFlavor): Promise<{ ok: boolean; why?: string }> {
    const r = await this.wda.switchFlavor(udid, flavor);
    if (!r.ok || flavor !== 'fork') return r;
    // ours answers: it must also do the work (a session, the screen's size, a still) before it's kept
    const missing = await this.wda.forkWorks(udid);
    return missing ? { ok: false, why: missing } : r;
  }

  /** The phone's index (its Mac ports are the bases plus it; our build's port on the phone too). */
  wdaSlot(udid: string): number {
    return this.wda.slotOf(udid);
  }

  /** The builds the plugged-in phones run now ("stock", "fork"). */
  wdaFlavors(): WdaFlavor[] {
    return [...new Set([...this.phones.values()].filter((p) => p.online).map((p) => this.wda.flavor(p.udid)))];
  }

  /** Which WebDriverAgent the phone runs, and our build's version when it's ours that answers. */
  wdaBuild(udid: string): { flavor: WdaFlavor; version: number | null } {
    return { flavor: this.wda.flavor(udid), version: this.wda.forkInfo(udid)?.lotus ?? null };
  }

  /** The phone's own live-touch self-test (our build). */
  wdaSelftest(udid: string): ReturnType<WdaManager['selftest']> {
    return this.wda.selftest(udid);
  }

  /**
   * A live view's control link opened: its touch session (HID) is kept open, and (2026-11-27) the phone's capture is
   * kept running while the client works on the phone, whether or not a picture is shown yet.
   */
  warmInput(udid: string): () => void {
    const hid = this.hidHost(udid)?.hold() ?? (() => {});
    const picture = this.holdPicture(udid, 'client');
    return () => {
      hid();
      picture?.();
    };
  }

  inputMethods(udid: string): InputMethods {
    const problem = this.hidProblem(udid);
    const h = this.hid.get(udid);
    return {
      hid: problem ? 'unsupported' : h?.state ?? 'off',
      hid_reason: problem ?? h?.reason ?? null,
      wda_fast: this.wda.fastStatus(udid),
      // 2026-11-21: the build this phone runs (or is being started with), as the control app's status says it; it
      // said "stock" for our build whenever WDA wasn't up at that moment (forkInfo is only known once it answers)
      wda: this.wda.flavor(udid),
      keys: this.wda.keysMode(udid),
      wda_live: this.wda.liveWhy(udid) === null ? 'ready' : 'off',
      wda_live_reason: this.wda.liveWhy(udid),
    };
  }

  /**
   * HID if its session is open, else WDA for this one gesture, with the reason (`why`; null on a phone that never
   * has HID). A failed HID input falls back at once, and the session reconnects by itself (src/hid.ts). Not when the
   * outcome isn't known (no answer in time) or it broke off partway (text half typed): doing it again through WDA
   * could tap twice or type the text twice, so that's an error that says to look at the screen first.
   */
  private async viaHid(
    udid: string, what: string, send: (r: { h: HidHost; s: ScreenInfo; o: Orientation | null }) => Promise<unknown>,
  ): Promise<{ done: InputResult } | { why: string | null }> {
    const r = this.hidReady(udid);
    if (!('h' in r)) return r;
    try {
      await send(r);
      return { done: { via: 'hid' } };
    } catch (err) {
      const f = hidFailure(what, err);
      if (f instanceof HttpError) {
        console.log(`[hid ${udid.slice(-8)}] ${f.message}`);
        throw f;
      }
      console.log(`[hid ${udid.slice(-8)}] ${what} failed, WDA takes it: ${(err as Error).message}`);
      return { why: f };
    }
  }

  async tap(udid: string, x: number, y: number, holdMs?: number): Promise<InputResult> {
    this.known(udid);
    return this.input(udid, 'tap', () => this.tapNow(udid, x, y, holdMs));
  }

  private async tapNow(udid: string, x: number, y: number, holdMs?: number): Promise<InputResult> {
    const hold = typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs > 0 ? Math.min(2000, Math.round(holdMs)) : undefined;
    const fields = hold ? { hold_ms: hold } : {};
    const hid = await this.viaHid(udid, 'tap', ({ h, s, o }) => {
      const [hx, hy] = toHid(x, y, s, o);
      return h.input('tap', { x: hx, y: hy, ...fields });
    });
    // both quick routes answer at the press; the lift follows a moment later
    if ('done' in hid) return { ...hid.done, play_ms: hidPlayMs('tap', fields) };
    const via = await this.wda.tap(udid, x, y, hold);
    const play = via === 'wda-fast' ? { play_ms: hold ?? FAST_TAP_HOLD_MS } : {};
    return hid.why ? { via, reason: hid.why, ...play } : { via, ...play };
  }
  async gesture(udid: string, points: PathPoint[]): Promise<InputResult> {
    this.known(udid);
    return this.input(udid, 'gesture', () => this.gestureNow(udid, points));
  }

  private async gestureNow(udid: string, points: PathPoint[]): Promise<InputResult> {
    const hid = await this.viaHid(udid, 'gesture', ({ h, s, o }) =>
      h.input('path', { points: points.map(([x, y, t]) => [...toHid(x, y, s, o), Math.round(t)]) }),
    );
    // HID and the fast WDA route answer once the gesture is queued; the phone then plays it for its length
    const length = Math.max(0, points[points.length - 1]![2]); // its times count from the gesture's start
    if ('done' in hid) return { ...hid.done, play_ms: length };
    const via = await this.wda.actions(udid, points);
    const play = via === 'wda-fast' ? { play_ms: length } : {};
    return hid.why ? { via, reason: hid.why, ...play } : { via, ...play };
  }
  /**
   * Text goes through the phone's own on-screen keyboard (XCTest, one event record the phone plays at
   * TYPE_KEYS_PER_SECOND), so it can be watched as it's typed. 2026-11-18: no longer through the HID keyboard by
   * default: its every key was a press and a lift sent as two messages down the cable, and a lift that came late (the
   * first key, while the web view made room for the newly attached keyboard) held the key long enough for iOS to repeat
   * it ("aaa" in a password); a HID keyboard also hides the on-screen one. HID_TYPING=1 brings it back.
   */
  async type(udid: string, text: string): Promise<InputResult> {
    return this.typeAt(udid, text, TYPE_KEYS_PER_SECOND);
  }

  private async typeAt(udid: string, text: string, keysPerSecond: number): Promise<InputResult> {
    this.known(udid);
    return this.input(udid, 'type', () => this.typeNow(udid, text, keysPerSecond));
  }

  private async typeNow(udid: string, text: string, keysPerSecond: number): Promise<InputResult> {
    let why: string | null = null;
    if (HID_TYPING && hidTypable(text)) {
      // answered when the last key is typed (not when it's queued): what follows finds the whole text there
      const hid = await this.viaHid(udid, 'type', ({ h }) => h.input('type', { text }, { done: true }));
      if ('done' in hid) return hid.done;
      why = hid.why;
    }
    try {
      await this.wda.typeText(udid, text, keysPerSecond);
    } catch (err) {
      // never the text itself in an answer or a log (XCTest names its record after the first letters)
      const m = scrubTyped((err as Error)?.message ?? String(err), text);
      throw new HttpError(err instanceof HttpError ? err.status : 502, `${m}; it was not typed again: look at the field before trying again`);
    }
    return why ? { via: 'wda', reason: why } : { via: 'wda' };
  }

  /** 2026-11-24, the PC keyboard: the steps in order, each sent once (a failed one stops the rest: nothing is typed out of order). */
  async keyboard(udid: string, steps: KeyStep[], opts: { paste?: boolean } = {}): Promise<InputResult> {
    this.known(udid);
    return this.input(udid, 'keyboard', async () => {
      let r: InputResult = { via: 'wda' };
      for (const s of steps) {
        if (!isText(s)) await this.wda.pressKey(udid, s);
        else for (const t of pieces(s.text)) r = await this.typeAt(udid, t, opts.paste ? PASTE_KEYS_PER_SECOND : OWNER_KEYS_PER_SECOND);
      }
      return r;
    });
  }

  /** The focused field: read it, or with `clear` empty it in one go first (WdaManager.field). */
  async field(udid: string, opts: { clear?: boolean } = {}): Promise<FieldState | null> {
    this.known(udid);
    // part of a typing action's turn (Control's); on its own, a turn of its own in the input line
    if (opts.clear) return this.input(udid, 'clear', () => this.wda.field(udid, true));
    try {
      return await this.input(udid, 'field', () => this.wda.field(udid, false));
    } catch {
      return null; // a read that fails is "not verified", never a failed action
    }
  }

  // ---- what an agent needs: the UI tree, the foreground app, the apps, buttons, a frame hash ----

  async uiSource(udid: string): Promise<unknown> {
    this.known(udid);
    return this.look(udid, 'ui tree', () => this.wda.source(udid), LOOK_START_MS, true);
  }

  knownApp(udid: string): { bundleId: string | null; at: number } | null {
    const k = this.wda.knownApp(udid);
    if (!k) return null;
    const id = k.info && typeof k.info === 'object' ? (k.info as { bundleId?: unknown }).bundleId : null;
    return { bundleId: typeof id === 'string' ? id : null, at: k.at };
  }

  async activeApp(udid: string): Promise<string | null> {
    if (!this.phones.get(udid)?.online) return null;
    return this.look(udid, 'app in front', () => this.wda.activeApp(udid), LOOK_START_MS, true).catch(() => null);
  }

  /** The phone's apps from ideviceinstaller (either version's list), kept 5 minutes, plus the well-known ones. */
  async apps(udid: string): Promise<AppInfo[]> {
    this.known(udid);
    const kept = this.appCache.get(udid);
    if (kept && Date.now() - kept.at < APPS_FRESH_MS) return kept.apps;
    let installed: AppInfo[] | null = null;
    for (const args of [['-u', udid, 'list', '--all'], ['-u', udid, '-l', '-o', 'list_all'], ['-u', udid, '-l']]) {
      try {
        const found = parseInstalled(await run('ideviceinstaller', args, 25000));
        if (found.length) {
          installed = found;
          break;
        }
      } catch {
        /* not installed, or this version wants the other form */
      }
    }
    const apps = withKnown(installed);
    // without the phone's list, look again sooner
    this.appCache.set(udid, { at: installed ? Date.now() : Date.now() - APPS_FRESH_MS + 60_000, apps });
    return apps;
  }

  async pressButton(udid: string, name: ButtonName): Promise<InputResult> {
    this.known(udid);
    // 2026-11-18 (the owner: the phones never make a sound): nothing on this server turns a phone's volume up
    if (name === 'volumeUp' && this.cfg.phoneSilent !== false) {
      throw new HttpError(403, "the phones stay silent: volume up is never pressed (the sound plays on the owner's PC through the live view; PHONE_SILENT=false allows it)");
    }
    await this.input(udid, `key-${name}`, () => this.wda.pressButton(udid, name));
    return { via: 'wda' };
  }

  /** 2026-11-18: after a wake, the phone's volume goes down again (at most every few minutes: src/audio.ts). */
  silence(udid: string, why: string): void {
    if (this.cfg.phoneSilent === false || !this.phones.get(udid)?.online) return;
    void this.volume.silence(udid, false, why).catch(() => {});
  }

  /**
   * A hash of the picture now (identical screens give identical bytes); null without one. 2026-11-27: the capture's
   * picture token when it runs and the agent may see it (no WDA at all); else a WDA still's hash, single-flight,
   * coalesced and budgeted (src/phone/look.ts): on a video app at most one per LOOK_GAP_VIDEO_MS, and the last one is
   * given again while no input came since it was taken.
   */
  async frameHash(udid: string): Promise<string | null> {
    if (!this.phones.get(udid)?.online || this.wda.status(udid) !== 'ready') return null;
    const t = this.pictureToken(udid);
    if (t) return tokenHash(t);
    const video = this.videoInFront(udid);
    const gap = video ? LOOK_GAP_VIDEO_MS : 0;
    const quietSince = this.actors.of(udid).lastInputAt < (this.stillLookAt.get(udid) ?? -Infinity);
    const r = await this.stillLooks.get(udid, { maxAgeMs: video && quietSince ? gap : 150, waitMs: gap }).catch(() => null);
    return r?.value ?? null;
  }
  async home(udid: string): Promise<InputResult> {
    this.known(udid);
    await this.input(udid, 'home', () => this.wda.callNoSession(udid, 'POST', '/wda/homescreen', {}, 8000));
    return { via: 'wda' };
  }
  async launch(udid: string, bundleId: string): Promise<InputResult> {
    this.known(udid);
    await this.input(udid, 'launch', () => this.wda.call(udid, 'POST', '/wda/apps/launch', { bundleId }, 20000));
    return { via: 'wda' };
  }

  // ---- idle lock and wake (src/idle.ts): WDA's session-less routes, the session ones on an older WDA ----

  private async wdaPower(udid: string, method: 'GET' | 'POST', route: string, timeout = 15000): Promise<any> {
    try {
      return await this.wda.callNoSession(udid, method, route, method === 'POST' ? {} : undefined, timeout);
    } catch (err) {
      if (err instanceof WdaError && err.kind === 'unknown') return this.wda.call(udid, method, route, method === 'POST' ? {} : undefined, timeout);
      throw err;
    }
  }

  /**
   * 2026-11-16: a short, soft lock. WDA's /wda/lock can time out ("Timed out while waiting until the screen gets
   * locked") while the screen does go dark: that never marks the WDA session or the phone down (no recovery, no heal);
   * the lock state is asked afterwards instead, and only a phone still unlocked is a failure. 2026-11-27: a power job
   * of the phone's actor (inside the owner's lock key, that key's own turn).
   */
  async lock(udid: string): Promise<void> {
    this.known(udid);
    return this.job(udid, { kind: 'power', label: 'lock', startWithinMs: 30_000, run: () => this.lockNow(udid) });
  }

  private async lockNow(udid: string): Promise<void> {
    // already dark: nothing to press (the lock button on a dark phone would turn its screen on)
    if ((await this.dark(udid)) === true) return;
    let why = '';
    try {
      await this.wda.callSoft(udid, 'POST', '/wda/lock', {}, LOCK_TIMEOUT_MS);
      return;
    } catch (err) {
      if (err instanceof WdaError && err.kind === 'unknown') {
        await this.wda.call(udid, 'POST', '/wda/lock', {}, LOCK_TIMEOUT_MS).catch((e2: Error) => (why = e2.message));
        if (!why) return;
      } else why = (err as Error).message;
    }
    const locked = await this.wdaLocked(udid, 2000);
    if (locked === true) return;
    // 2026-11-16: a phone without a passcode never says "locked" (so WDA's lock times out waiting for it) while its
    // screen did go off: a dark screen is a lock that took
    if ((await this.dark(udid)) === true) return;
    throw new Error(`the lock didn't take (${why.slice(0, 120)})`);
  }

  /** WDA's own word on the lock (SpringBoard's lock state: always false on a phone without a passcode); null when it doesn't say. */
  private async wdaLocked(udid: string, timeout = 5000, quiet = false): Promise<boolean | null> {
    const v = await this.wda.callSoft(udid, 'GET', '/wda/locked', undefined, timeout, quiet).then(
      (j) => (typeof j?.value === 'boolean' ? j.value : null),
      (err) =>
        err instanceof WdaError && err.kind === 'unknown'
          ? this.wda.call(udid, 'GET', '/wda/locked', undefined, timeout).then((j) => (typeof j?.value === 'boolean' ? j.value : null), () => null)
          : null,
    );
    // "locked" is an observation; "not locked" says nothing of the screen (a phone without a passcode says it dark)
    if (v === true) this.observe(udid, 'locked', 'wda-locked');
    return v;
  }

  /**
   * Whether the screen is dark (off); null when it can't be told. 2026-11-27: the capture first (a moving picture, or
   * its own still that clearly shows something: no WDA at all), then a frame WDA's MJPEG gives within a moment, then
   * WDA's PNG. What it finds is told to the power state (src/phone/power.ts).
   */
  private async dark(udid: string, quiet = false): Promise<boolean | null> {
    if (!this.phones.get(udid)?.online) return null;
    // 2026-11-21: the live view shows the screen changing right now: it's on, no screenshot needed to know
    if (this.screenMoving(udid)) {
      this.observe(udid, 'on', 'capture');
      return false;
    }
    const cap = await this.capturePicture(udid, 'jpeg').catch(() => null);
    if (cap && jpegMaybeBlack(cap.data) === false) {
      this.observe(udid, 'on', 'capture');
      return false;
    }
    if (this.wda.status(udid) !== 'ready' || this.wda.stuck(udid)) return null;
    const s = this.stills(udid, true, quiet);
    try {
      const f = s.mjpeg ? await s.mjpeg(300, 900) : null;
      if (f && jpegMaybeBlack(f) === false) {
        this.observe(udid, 'on', 'still');
        return false;
      }
    } catch {
      /* no MJPEG frame: the screenshot says */
    }
    try {
      const black = pngIsBlack(await s.png(DARK_SHOT_MS));
      if (black !== null) this.observe(udid, black ? 'dark' : 'on', 'still');
      return black;
    } catch {
      return null;
    }
  }

  /**
   * Wake and unlock. WDA's /wda/unlock gets a locked phone past its lock screen, but does nothing on one that says
   * it isn't locked; 2026-11-16: a phone without a passcode never says so, its screen is just off (after a lock, or
   * iOS's own Auto-Lock), so a dark screen gets what WDA's unlock does: Home (the screen comes on), a moment, Home
   * again (past the lock screen). Never pressed on a screen that shows something (it would leave the app in front),
   * and (2026-11-27) never on one that couldn't be looked at (src/dark.ts). `explicit` (the owner's own wake): WDA's
   * unlock also goes when the phone doesn't say whether it's locked. A power job of the phone's actor.
   */
  async unlock(udid: string, opts: { force?: boolean; explicit?: boolean } = {}): Promise<void> {
    this.known(udid);
    // 2026-11-18 (iPhone-2's live view stuck on "connecting" with its screen off): a wake used to find nothing to
    // ask while the phone's WDA was starting or restarting, and quietly did nothing. It waits for WDA first now, and
    // says plainly when it can't.
    if (!(await this.wda.whenReady(udid, WAKE_WDA_WAIT_MS))) {
      const st = this.wda.state(udid);
      throw new Error(st === 'recovering' ? "the phone's control link is restarting, so its screen can't be woken yet" : "the phone's control link is down, so its screen can't be woken");
    }
    // 2026-11-27: its main queue still holds an earlier request of ours and doesn't move: a wake would only wait behind it
    const stuck = this.wda.stuck(udid);
    if (stuck) throw new HttpError(503, `the phone is still on ${stuck.op} (sent ${Math.round((Date.now() - stuck.since) / 1000)} s ago, no answer yet), so its screen can't be woken now`, { state: 'busy', op: stuck.op, since: stuck.since });
    await this.job(udid, {
      kind: 'power', label: 'wake', startWithinMs: 30_000,
      run: () =>
        wakeScreen({
          explicit: opts.explicit === true,
          force: opts.force,
          locked: () => this.wdaLocked(udid),
          // home press + swipe up: past the lock screen when the phone has no passcode
          unlock: () => this.wdaPower(udid, 'POST', '/wda/unlock', 20000),
          dark: () => this.dark(udid),
          home: () => this.wda.homeSoft(udid),
          observed: (screen) => this.observe(udid, screen, 'wake'),
          log: (m) => console.log(`[wake ${udid.slice(-8)}] ${m}`),
        }),
    });
  }

  /**
   * Locked, or dark: WDA's word, and the screen itself when WDA says "not locked", since a phone without a passcode
   * says that with its screen off. `quick`: no look at the screen, so only "locked" (true) or can't tell (null).
   * null when it can't tell. A look of the phone's actor; `quiet` (the watch's own): skipped while the phone has
   * anything else on (null).
   */
  async isLocked(udid: string, quick = false, quiet = false): Promise<boolean | null> {
    const p = this.phones.get(udid);
    if (!p?.online || this.wda.status(udid) !== 'ready') return null;
    const r = await this.actors
      .of(udid)
      .submit({ kind: 'look', label: 'lock state', who: { server: 'look' }, skipIfBusy: quiet, startWithinMs: LOOK_START_MS, run: () => this.isLockedNow(udid, quick, quiet) })
      .catch(() => null);
    return r ?? null;
  }

  private async isLockedNow(udid: string, quick: boolean, quiet: boolean): Promise<boolean | null> {
    // 2026-11-21, `quiet` (the watch's own look): skipped while the phone is busy with anything else (null: can't tell)
    const locked = await this.wdaLocked(udid, 5000, quiet);
    if (locked === true) return true;
    // "not locked" alone says nothing of the screen: without a look it can't be told
    if (quick) return null;
    const dark = await this.dark(udid, quiet);
    return dark === true ? true : locked;
  }

  /** The phone's actor (src/phone/actor.ts): its lease, its queue (re-sign, fork install and self-test take `system`). */
  phoneActor(udid: string) {
    return this.actors.of(udid);
  }

  restartWda(udid: string): void {
    this.wda.restartRunner(udid);
  }

  /** 2026-11-22: the phone's control link takes requests within `ms` (it may be starting after a replug). */
  whenControlReady(udid: string, ms: number): Promise<boolean> {
    if (!this.phones.get(udid)?.online) return Promise.resolve(false);
    return this.wda.whenReady(udid, ms);
  }

  /** Probe the phone's WDA session and heal what's wrong (src/wda.ts probe); false when WDA can't take input. */
  async heal(udid: string, reason: string): Promise<boolean> {
    if (!this.phones.get(udid)?.online) return false;
    return this.wda.probe(udid, reason);
  }

  setWatched(fn: (udid: string) => boolean): void {
    this.wda.watched = fn;
  }

  /** Stop the phone's capture now, whoever watches it: its viewers are told why. */
  stopCapture(udid: string, why: string): void {
    if (this.phoneSources(udid).length || this.hosts.has(udid)) console.log(`[capture ${udid.slice(-8)}] stopped: ${why}`);
    this.closeH264(udid, why);
  }

  async recover(udid: string): Promise<ControlState> {
    this.known(udid);
    return this.wda.recoverNow(udid);
  }

  controlGate(udid: string): void {
    this.wda.gate(udid);
  }

  /** The MJPEG server is one per phone: it runs at the most any current subscriber asked for. */
  private streamSettings(udid: string): StreamSettings {
    const set = this.streams.get(udid);
    const all = set?.size ? [...set] : [];
    const most = (k: keyof StreamSettings) => Math.max(...all.map((s) => s[k]));
    return all.length ? { fps: most('fps'), quality: most('quality'), scale: most('scale') } : { fps: 60, quality: 50, scale: 50 };
  }

  subscribe(udid: string, onFrame: (f: Buffer) => void, want: StreamSettings) {
    this.known(udid);
    if (this.wda.status(udid) !== 'ready') throw new HttpError(503, 'WebDriverAgent is not ready');
    if (!this.wda.mjpegAvailable(udid)) throw new HttpError(503, 'this phone runs our own WebDriverAgent build, which has no MJPEG stream (the live view is WebRTC)');
    let set = this.streams.get(udid);
    if (!set) this.streams.set(udid, (set = new Set()));
    const mine = { ...want };
    set.add(mine);
    const eff = this.streamSettings(udid);
    void this.wda.setMjpeg(udid, eff);
    const off = this.source(udid).add(onFrame, true);
    return {
      contentType: 'image/jpeg',
      ...eff,
      unsubscribe: () => {
        off();
        if (set!.delete(mine) && set!.size) void this.wda.setMjpeg(udid, this.streamSettings(udid));
      },
    };
  }

  /**
   * 2026-11-27 (root cause §11, P6): the API layer's close (an update, a signal, a crash). Its own parts end (timers,
   * captures, HID helpers), but the WDA runners and forwards are left running with their sessions, for the next server
   * process to adopt (data/runners.json). A real stop of the device layer too is `stop()`.
   */
  async close(): Promise<void> {
    this.closeOwn();
    await this.wda.shutdown(8000, { keepRunners: true });
  }

  /** The same as close() (src/lifecycle.ts releaseDevices 'keep'). */
  detach(): Promise<void> {
    return this.close();
  }

  /** A real stop: everything ends, runners' sessions deleted and their processes gone (SIGUSR2, STOP_DEVICES_ON_EXIT). */
  async stop(): Promise<void> {
    this.closeOwn();
    await this.wda.shutdown(8000, { keepRunners: false });
  }

  private closeOwn(): void {
    clearInterval(this.timer);
    for (const h of this.pictureHolds.values()) h.release();
    this.pictureHolds.clear();
    for (const s of this.h264Sources.values()) s.close();
    for (const h of this.hosts.values()) h.close();
    for (const h of this.hid.values()) h.close();
    this.volume.close();
    this.files.close?.();
    setCaptureBackend(null);
  }
}

/**
 * What a failed HID input means for its action. A refusal (nothing reached the phone) is a reason: WDA does it
 * instead. No answer in time, or a text or gesture that broke off partway, is an error and WDA does NOT do it again:
 * it may have happened (or half of it has), and a repeat would tap twice or type the text twice.
 */
export function hidFailure(what: string, err: unknown): HttpError | string {
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof HidTimeout) {
    return new HttpError(504, `the phone didn't confirm the ${what} in time (HID: ${message}); it may or may not have happened, so it was not repeated: look at the screen before trying again`);
  }
  if (err instanceof HidPartial) {
    return new HttpError(502, `the ${what} broke off partway on the phone (HID: ${message}); part of it may be there, so it was not repeated: look at the screen before trying again`);
  }
  return `HID ${what} failed (${message})`;
}

/** The first line of a build log that is a real compiler error ("error:"), else its first non-empty line. */
export function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /\berror:/i.test(l)) ?? lines[0] ?? 'unknown build error').slice(0, 300);
}
