import crypto from 'node:crypto';
import { imageSize } from './imgsize.js';
import { frameAgrees, Orientation } from './orient.js';
import { Image, ImageFormat } from './types.js';

/**
 * WebDriverAgent's stills (2026-11-16): WDA's own single screenshot of the screen. 2026-11-27 (docs/root-cause.md
 * G5): only what the agent, Lotus's phone tools and the server's own checks fall back to when the phone's USB screen
 * capture doesn't run (or the owner's `agentSeesCapture` keeps the agent from it): src/real.ts then asks for them as
 * looks of the phone's actor, single-flight, coalesced and budgeted (src/phone/look.ts). Nothing here knows the
 * capture.
 *
 * Two ways WDA gives a still: its PNG screenshot (GET /screenshot, always there), and, on a stock WDA, a frame of its
 * own MJPEG server (WDA's screenshots as JPEG, quicker and smaller). A WDA without the MJPEG server (our fork) gives
 * `mjpeg: null`, and everything comes from the PNG.
 */
export interface StillSource {
  /** One frame of WDA's own MJPEG server, at most `maxAgeMs` old, waited for `waitMs` at most; null when none came. Null itself: this WDA has no MJPEG server. */
  mjpeg: ((maxAgeMs: number, waitMs: number) => Promise<Buffer | null>) | null;
  /** WDA's PNG screenshot (GET /screenshot). */
  png: (timeoutMs?: number) => Promise<Buffer>;
  /** How the phone is turned now (an older WDA's MJPEG frames stay the panel's: its PNG turns its own). */
  orientation: () => Orientation | null;
}

/** A still for GET /screenshot: `jpeg` is WDA's MJPEG frame when it has one that's upright, else (and for `png`) its PNG. */
export async function still(src: StillSource, format: ImageFormat, waitMs = 5000): Promise<Image> {
  if (format === 'jpeg' && src.mjpeg) {
    const jpeg = await src.mjpeg(0, waitMs).catch(() => null);
    if (jpeg && frameAgrees(imageSize(jpeg), src.orientation())) return { data: jpeg, contentType: 'image/jpeg' };
  }
  return { data: await src.png(), contentType: 'image/png' };
}

/**
 * A cheap hash of what the screen shows now (identical screens give identical bytes), to tell whether an action
 * changed it: WDA's MJPEG frame when it has that server, else its PNG screenshot. Null when neither came.
 */
export async function stillHash(src: StillSource, maxAgeMs = 150, waitMs = 1500): Promise<string | null> {
  let data: Buffer | null = null;
  if (src.mjpeg) data = await src.mjpeg(maxAgeMs, waitMs).catch(() => null);
  else data = await src.png(Math.max(waitMs, 4000)).catch(() => null);
  return data ? crypto.createHash('sha1').update(data).digest('hex').slice(0, 16) : null;
}
