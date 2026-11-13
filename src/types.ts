import type { H264Source } from './h264.js';

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
  /** Screen size in points (WDA's coordinate space); null until known. */
  point_width: number | null;
  point_height: number | null;
  /** Screen size in pixels (points x scale); null until known. */
  width: number | null;
  height: number | null;
  /** Live view numbers for this phone (see README). */
  stats?: StreamStats;
  /** The Mac's own base URLs on its LAN/Tailscale addresses, e.g. "http://192.168.1.20:8787". */
  lan?: string[];
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
  dropped: number; // frames dropped by latest-only since the viewers joined
  bitrate_kbps: number | null; // the encoder's target now (congestion control lowers it for a slow viewer)
  h264_available: boolean;
  h264_reason: string | null; // why H.264 isn't available (helper not built, capture failing...)
  /** Each running encoder lane: "lan" (as asked) or "remote" (a far viewer's: smaller, 30 fps, follows its link). */
  lanes?: LaneStats[];
  /** The last phonecap build failed; the previous helper still runs (null when the build is fine). */
  helper_build_error?: string | null;
}

export interface LaneStats {
  kind: 'lan' | 'remote' | null;
  fps: number;
  fps_target: number | null;
  scale: number;
  width: number | null;
  height: number | null;
  bitrate_kbps: number | null;
  viewers: number;
  dropped: number;
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
}

/** Screen size in points plus the scale, as WDA reports it. */
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
  /** Cached screen size in points (for clamping); null when not known yet. */
  screen(udid: string): ScreenInfo | null;
  screenshot(udid: string, format: ImageFormat): Promise<Image>;
  /** Quick tap at a point. */
  tap(udid: string, x: number, y: number): Promise<void>;
  /** One continuous touch through the points (>= 2), with their timing; used for swipe, path and hold. */
  gesture(udid: string, points: PathPoint[]): Promise<void>;
  type(udid: string, text: string): Promise<void>;
  home(udid: string): Promise<void>;
  launch(udid: string, bundleId: string): Promise<void>;
  /** Drop the WDA session, restart the runner if WDA doesn't answer, make a new warm session. */
  recover(udid: string): Promise<ControlState>;
  /** Subscribe to image frames. Returns unsubscribe and the settings actually used. Throws HttpError if unknown/not ready. */
  subscribe(
    udid: string,
    onFrame: (frame: Buffer) => void,
    want: StreamSettings,
  ): { contentType: string; unsubscribe: () => void } & StreamSettings;
  /** The phone's shared H.264 capture, or the reason H.264 isn't available (then clients get MJPEG). */
  h264(udid: string, want: H264Want): H264Source | string;
  close(): Promise<void>;
}
