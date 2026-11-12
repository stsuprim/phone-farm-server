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
  /** Subscribe to image frames. Returns unsubscribe and the settings actually used. Throws HttpError if unknown/not ready. */
  subscribe(
    udid: string,
    onFrame: (frame: Buffer) => void,
    want: StreamSettings,
  ): { contentType: string; unsubscribe: () => void } & StreamSettings;
  close(): Promise<void>;
}
