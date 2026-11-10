export interface PhoneInfo {
  udid: string;
  name: string;
  model: string;
  ios: string;
  battery: number | null; // percent, null if unknown
  online: boolean;
  ready: boolean; // true when the phone can be controlled (WDA up)
}

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
  screenshot(udid: string, format: ImageFormat): Promise<Image>;
  tap(udid: string, x: number, y: number): Promise<void>;
  swipe(udid: string, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>;
  type(udid: string, text: string): Promise<void>;
  home(udid: string): Promise<void>;
  launch(udid: string, bundleId: string): Promise<void>;
  /** Subscribe to image frames. Returns unsubscribe. Throws HttpError if unknown/not ready. */
  subscribe(udid: string, onFrame: (frame: Buffer) => void): { contentType: string; unsubscribe: () => void };
  close(): Promise<void>;
}
