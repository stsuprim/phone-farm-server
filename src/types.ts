import type { H264Source } from './h264.js';
import type { InputResult, InputStats } from './inputlog.js';
import type { Orientation } from './orient.js';

/** Whether a phone can be driven right now: WDA session warm, being recovered, or unavailable. */
export type ControlState = 'ready' | 'recovering' | 'down';

export interface PhoneInfo {
  udid: string;
  name: string;
  model: string;
  ios: string;
  battery: number | null; // percent, null if unknown
  online: boolean;
  ready: boolean; // true when the phone can be controlled (WDA up)
  control: ControlState;
  /** Screen scale (points -> pixels), from WDA; null until a WDA session has been made. */
  scale: number | null;
  /** Screen size in points (WDA's coordinate space), upright: as the phone is turned now; null until known. */
  point_width: number | null;
  point_height: number | null;
  /** Screen size in pixels (points x scale), upright: the picture's true shape now; null until known. */
  width: number | null;
  height: number | null;
  /** How the phone is turned now (src/orient.ts); null until WDA has said. */
  orientation?: Orientation | null;
  /** Live view numbers for this phone (see README). */
  stats?: StreamStats;
  /** The Mac's own base URLs on its LAN (private IPv4), e.g. "http://192.168.1.20:8787". */
  lan?: string[];
  /** The Mac's Tailscale base URLs (100.64.0.0/10), apart from `lan`: a tailnet address is not a local one. */
  tailnet?: string[];
  /** Idle lock (src/idle.ts): the phone is locked (null = not known yet). */
  locked?: boolean | null;
  /** The screen is on (an estimate: off after a lock, on after a wake or while unlocked; null = not known). */
  screenOn?: boolean | null;
  /** Last input or viewer on this phone, ms since the epoch (null = none since the server started). */
  lastActive?: number | null;
  /** The detail card's data (src/info.ts), as it was last gathered (at most ~15 s old while someone lists the phones). */
  info?: DeviceInfo;
}

/**
 * What a phone's detail card shows (GET /phones/:udid/info, and `info` on each phone in GET /phones). Anything the
 * phone (or its tools) couldn't say is null.
 */
export interface DeviceInfo {
  /** `level` 0..1 (a fraction); `percent` the same as 0..100 (an integer); `charging` true while it takes charge. */
  battery: { level: number | null; percent?: number | null; charging: boolean | null };
  /** The battery's temperature in degrees Celsius (IORegistry AppleSmartBattery Temperature / 100). */
  temperatureC: number | null;
  /** The app in front. */
  app: { bundleId: string | null; name: string | null };
  /** Seconds since the phone booted, and when that was (ms since the epoch); null when the phone doesn't say. */
  uptimeSec: number | null;
  /** The product type ("iPhone14,5") and the iOS version ("18.1"). */
  model: string | null;
  ios: string | null;
  bootedAt: number | null;
  /** WebDriverAgent's signing: when it expires (ISO 8601, as GET /api/wda) and the days left. */
  wda: { expiresAt: string | null; daysLeft: number | null; state: string | null };
  /** iOS's own word on heat (WDA's device info): nominal, fair, serious, critical. */
  thermal: 'nominal' | 'fair' | 'serious' | 'critical' | null;
  /** When the server first saw the phone connected (ms since the epoch; since the server started). */
  connectedAt: number | null;
  /** When this was gathered (ms since the epoch); `fresh` false = the quick answer from what the list already knew. */
  at: number;
  fresh: boolean;
}

/** The phone's own part of DeviceInfo, as a backend gathers it (the server adds `wda`, `at`, `fresh`). */
export type PhoneFacts = Omit<DeviceInfo, 'wda' | 'at' | 'fresh'>;

/**
 * A phone's capture as POST /warm and /focus say it (2026-11-16: neither starts it any more; it runs only while a
 * live view is open): "warm" a view is open and it has a picture, "starting" it's on its way up for one, "off" nobody
 * is watching, "unavailable" this backend can't say.
 */
export interface WarmState {
  capture: 'warm' | 'starting' | 'off' | 'unavailable';
  reason?: string;
}

/** Which way a viewer is connected: lan = full quality + live HID touch; remote = adaptive lane, swipes as one command. */
export type Profile = 'lan' | 'remote';
/** thumb = a small, ~6 fps lane (grids); full = the profile's normal lane. */
export type QualityTier = 'thumb' | 'full';

/** One open live view in the stats (`stats.sessions`). */
export interface SessionStats {
  id: string;
  /** The video path: "h264" (phonecap capture + VideoToolbox) or "mjpeg" (the old WDA screenshots). */
  path: 'h264' | 'mjpeg';
  transport: 'webrtc' | 'h264-ws' | 'mjpeg-ws';
  /** The network path: lan, tailscale, loopback or direct (WebRTC: the chosen pair; WebSocket: the client address). */
  net: string | null;
  profile: Profile;
  quality: QualityTier;
  lane: 'lan' | 'remote' | 'thumb' | null;
  /** Frames sent to this viewer in the last second. */
  fps: number;
  /** Capture -> sent at the server plus half the round trip when known (ms; an estimate of glass-to-network-out). */
  latencyMs: number | null;
  /** Why it's on MJPEG (when the H.264 path wasn't available). */
  reason?: string | null;
  since: number;
  /** The request (the stream's upgrade, the rtc-offer) -> its first frame sent, ms; null until that frame. */
  connectMs?: number | null;
  /** WebRTC: keyframes the viewer asked for (PLI, FIR, rtc-key); one that keeps climbing is a picture that won't decode. */
  keysAsked?: number;
}

/** Per-phone live view stats in GET /phones. Timings are averages in ms; null when unknown. */
export interface StreamStats {
  codec: 'h264' | 'mjpeg' | null; // what viewers get now (h264 if any WebRTC/H.264 viewer)
  fps: number | null;
  encode_ms: number | null;
  capture_to_encoded_ms: number | null;
  encoded_to_sent_ms: number | null;
  viewers: number;
  viewers_webrtc: number;
  viewers_h264_ws: number;
  viewers_mjpeg: number;
  path: string | null; // WebRTC path of a viewer: "lan", "tailscale", "loopback" or "direct" (always host, never relayed)
  /** WebRTC: the round trip from RTCP receiver reports (ms), and the queue beyond the path's own (delay-based control). */
  rtt_ms?: number | null;
  queue_ms?: number | null;
  dropped: number; // frames dropped by latest-only since the viewers joined
  bitrate_kbps: number | null; // the encoder's target now (congestion control lowers it for a slow viewer)
  h264_available: boolean;
  h264_reason: string | null; // why H.264 isn't available (helper not built, capture failing...)
  /** Each running encoder lane: "lan" (as asked) or "remote" (a far viewer's: smaller, 30 fps, follows its link). */
  lanes?: LaneStats[];
  /** The last phonecap build failed; the previous helper still runs (null when the build is fine). */
  helper_build_error?: string | null;
  /** Touch/tap latency on the server (receive -> injected) and the input methods the phone has now. */
  input?: InputStats & { methods?: InputMethods };
  /** The video path new viewers get now: "h264" (phonecap) when it's available, else "mjpeg" (see h264_reason). */
  video_path?: 'h264' | 'mjpeg';
  /** Each open live view (server.ts fills it in). */
  sessions?: SessionStats[];
  /** The capture's picture doesn't have the phone's shape (wide against tall) and couldn't be put right: why. */
  capture_mismatch?: string | null;
  /** WDA's own link (src/wda.ts linkHealth): the state as told and as it is, missed liveness checks, recoveries, restarts. */
  wda_link?: unknown;
  /** WDA self-heals since the server started (a session remade, WDA restarted, a port forward respawned). */
  heals?: number;
  /** The last self-heal: when (ms since the epoch) and why; null when there was none. */
  lastHeal?: { at: number; reason: string } | null;
}

/**
 * The phone's input methods now (docs/BEST_METHOD.md): hid = CoreDevice HID live touch (iOS 27+), wda_fast = the
 * patched WDA route that answers before XCTest plays the event, else the old WDA route.
 */
export interface InputMethods {
  hid: 'off' | 'starting' | 'ready' | 'failed' | 'unsupported';
  hid_reason: string | null;
  wda_fast: 'yes' | 'no' | 'unknown';
  /** Which WebDriverAgent answers on the phone: the stock one, or our own build (src/fork.ts). */
  wda?: 'stock' | 'fork';
  /** Live touch through our build (a finger held down between requests): ready, or off with why. */
  wda_live?: 'ready' | 'off';
  wda_live_reason?: string | null;
}

export interface LaneStats {
  kind: 'lan' | 'remote' | 'thumb' | null;
  fps: number;
  fps_target: number | null;
  scale: number;
  width: number | null;
  height: number | null;
  bitrate_kbps: number | null;
  viewers: number;
  dropped: number;
  rtt_ms?: number | null;
  queue_ms?: number | null;
}

/** What a client asked of the H.264 stream. */
export interface H264Want {
  fps: number;
  scale: number;
  quality: number | null;
  bitrate?: number | null; // bit/s the client asked for (its `bitrate` in kbit/s); wins over quality
  /** The viewer isn't on the Mac's LAN (Tailscale, the Internet): it gets a far viewer's lane (src/lanes.ts). */
  remote?: boolean;
  /** `full=1`: a far viewer that wants exactly what it asked (no far caps). */
  full?: boolean;
  /** `quality=thumb`: a small, ~6 fps lane (src/lanes.ts); `full` (or none): the profile's normal lane. */
  tier?: QualityTier;
}

/** An app on the phone (GET /apps): `installed` null when the phone's own list couldn't be read (a well-known app). */
export interface AppInfo {
  bundleId: string;
  name: string;
  installed: boolean | null;
}

/** A hardware button POST /key presses through the backend. */
export type ButtonName = 'volumeUp' | 'volumeDown';

/** Screen size in points (upright: as the phone is turned now) plus the scale, as WDA reports it. */
export interface ScreenInfo {
  width: number;
  height: number;
  scale: number | null;
}

/** MJPEG stream settings: frames per second, JPEG quality (1-100), scaling factor in percent (1-100). */
export interface StreamSettings {
  fps: number;
  quality: number;
  scale: number;
}

/** One point of a gesture: x, y in points, ms since the gesture started. */
export type PathPoint = [number, number, number];

export type ImageFormat = 'png' | 'jpeg';
export interface Image {
  data: Buffer;
  contentType: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Backend {
  readonly mock: boolean;
  list(): Promise<PhoneInfo[]>;
  /** Cached screen size in points, upright (as the phone is turned now), for mapping and clamping; null when not known yet. */
  screen(udid: string): ScreenInfo | null;
  /** How the phone is turned now (cached); null when not known. */
  orientation?(udid: string): Orientation | null;
  /** Ask the phone how it's turned unless that was asked within `maxAgeMs`; resolves to what's known then. */
  refreshOrientation?(udid: string, maxAgeMs?: number): Promise<Orientation | null>;
  /** Set by the server: called when a phone's orientation or upright size changed. */
  onOrientation?: (udid: string) => void;
  screenshot(udid: string, format: ImageFormat): Promise<Image>;
  /**
   * Quick tap at a point, held `holdMs` (a natural tap's 50-120 ms; the route's own short hold when not given).
   * Resolves once it's injected (or queued on the phone), saying how it went.
   */
  tap(udid: string, x: number, y: number, holdMs?: number): Promise<InputResult | void>;
  /** One continuous touch through the points (>= 2), with their timing; used for swipe, path and hold. */
  gesture(udid: string, points: PathPoint[]): Promise<InputResult | void>;
  type(udid: string, text: string): Promise<InputResult | void>;
  home(udid: string): Promise<InputResult | void>;
  launch(udid: string, bundleId: string): Promise<InputResult | void>;
  /** The phone takes live touch (down/move/up injected as they come) right now. */
  liveTouchReady?(udid: string): boolean;
  /** Why it doesn't (HID starting, failed, not on this iOS...), for the ack's `reason`; null when it does. */
  liveTouchWhy?(udid: string): string | null;
  /** One live touch event straight to the phone (only after liveTouchReady said yes). */
  liveTouch?(udid: string, phase: 'down' | 'move' | 'up', x: number, y: number): Promise<InputResult | void>;
  /** A live view opened: keep the phone's fast input channel open until the returned release is called. */
  warmInput?(udid: string): () => void;
  /** The phone's input methods now. */
  inputMethods?(udid: string): InputMethods;
  /** Lock the phone (screen off): WDA /wda/lock. */
  lock?(udid: string): Promise<void>;
  /** Wake and unlock the phone (past the lock screen when it has no passcode): WDA /wda/unlock. */
  unlock?(udid: string): Promise<void>;
  /**
   * Whether the phone is locked or its screen is dark now (WDA /wda/locked, and a look at the screen: a phone without
   * a passcode never says "locked"); `quick`: no look at the screen (true, or null). null when it can't tell.
   */
  isLocked?(udid: string, quick?: boolean): Promise<boolean | null>;
  /** WDA's /source tree (format=json) of what's on screen (src/ui.ts flattens it). */
  uiSource?(udid: string): Promise<unknown>;
  /** The foreground app's bundle id; null when it can't tell. */
  activeApp?(udid: string): Promise<string | null>;
  /** The phone's apps (installed ones when they can be listed, plus the well-known ones). */
  apps?(udid: string): Promise<AppInfo[]>;
  /** Press a hardware button. */
  pressButton?(udid: string, name: ButtonName): Promise<InputResult | void>;
  /** A cheap hash of the picture now (the newest frame), to tell whether an action changed the screen; null when none. */
  frameHash?(udid: string): Promise<string | null>;
  /** Restart the phone's WDA runner (reinstalls a freshly signed build). */
  restartWda?(udid: string): void;
  /** The detail card's facts, asked from the phone now (never throws for a known phone: unknown parts are null). */
  facts?(udid: string): Promise<PhoneFacts>;
  /** Whether the phone's USB screen capture runs right now (it does only while a live view is open, and a moment after). */
  capturing?(udid: string): boolean;
  /**
   * A gesture or text that was answered when it was queued on the phone and then failed while playing, since `since`
   * (Date.now()): what went wrong, else null.
   */
  playFailure?(udid: string, since: number): string | null;
  /** Drop the WDA session, restart the runner if WDA doesn't answer, make a new warm session. */
  recover(udid: string): Promise<ControlState>;
  /**
   * Make sure the phone can take input: probe its WDA session and heal what's wrong (a new session, WDA restarted).
   * False when it can't take input even so. `reason` is logged with any heal.
   */
  heal?(udid: string, reason: string): Promise<boolean>;
  /** Tell the backend which phones are being watched (their health check probes the session itself). */
  setWatched?(fn: (udid: string) => boolean): void;
  /** Stop the phone's capture now, whoever watches it; its viewers are told why. */
  stopCapture?(udid: string, why: string): void;
  /** Subscribe to image frames. Returns unsubscribe and the settings actually used. Throws HttpError if unknown/not ready. */
  subscribe(
    udid: string,
    onFrame: (frame: Buffer) => void,
    want: StreamSettings,
  ): { contentType: string; unsubscribe: () => void } & StreamSettings;
  /** The phone's shared H.264 capture, or the reason H.264 isn't available (then clients get MJPEG). */
  h264(udid: string, want: H264Want): H264Source | string;
  /**
   * The phone's sound for a live view (src/audio.ts), or why there's none. It flows only while the phone's capture runs
   * (a live view is open) and someone listens.
   */
  audio?(udid: string): import('./audio.js').AudioFeed | string;
  close(): Promise<void>;
}
