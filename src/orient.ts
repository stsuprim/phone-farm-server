/**
 * Orientation and coordinate spaces.
 *
 * - **Upright** is the picture as a person sees it: the phone's current orientation, (0, 0) at its top left. Clients
 *   send touches there, normalized 0..1 (preferred), in the upright picture's pixels, or in points.
 * - **Points** are WebDriverAgent's coordinates: upright too (WDA works in the app's current orientation), so a
 *   landscape phone is e.g. 844 x 390.
 * - **Panel** is the glass itself, as when the phone is held in portrait: what CoreDevice HID reports use. In
 *   landscape the upright picture is turned on the panel, so touches are turned back (uprightToPanel).
 *
 * The names are the device's (UIDeviceOrientation, and what WDA's GET /orientation says):
 *   portrait              upright
 *   landscape-left        turned 90° counter-clockwise: its top edge points left, the home bar is on the right
 *                         (WDA "LANDSCAPE", UIInterfaceOrientation 3)
 *   landscape-right       turned 90° clockwise: its top edge points right
 *                         (WDA "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT", UIInterfaceOrientation 4)
 *   portrait-upside-down  turned 180° (WDA "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN", UIInterfaceOrientation 2)
 */
export type Orientation = 'portrait' | 'landscape-left' | 'landscape-right' | 'portrait-upside-down';

export const ORIENTATIONS: readonly Orientation[] = ['portrait', 'landscape-left', 'landscape-right', 'portrait-upside-down'];

export const isLandscape = (o: Orientation | null | undefined): boolean => o === 'landscape-left' || o === 'landscape-right';

/** WDA's GET /orientation value -> ours (null when it says nothing we know). */
export function orientationFromWda(v: unknown): Orientation | null {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (s.includes('UPSIDEDOWN')) return 'portrait-upside-down';
  if (s.includes('LANDSCAPERIGHT')) return 'landscape-right';
  if (s.includes('LANDSCAPE')) return 'landscape-left';
  if (s.includes('PORTRAIT')) return 'portrait';
  return null;
}

/** The UIInterfaceOrientation number (what XCTest's event records take). */
export function uiOrientation(o: Orientation | null | undefined): 1 | 2 | 3 | 4 {
  return o === 'portrait-upside-down' ? 2 : o === 'landscape-left' ? 3 : o === 'landscape-right' ? 4 : 1;
}

export interface Size {
  width: number;
  height: number;
}

/** A size as held in portrait (short side across). */
export function portraitSize(s: Size): Size {
  return { width: Math.min(s.width, s.height), height: Math.max(s.width, s.height) };
}

/** The upright size in an orientation, from any size of the same screen. */
export function uprightSize(s: Size, o: Orientation | null | undefined): Size {
  const p = portraitSize(s);
  return isLandscape(o) ? { width: p.height, height: p.width } : p;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Upright normalized (u, v) -> panel normalized (0..1 across the glass as held in portrait). */
export function uprightToPanel(u: number, v: number, o: Orientation | null | undefined): [number, number] {
  u = clamp01(u);
  v = clamp01(v);
  switch (o) {
    case 'landscape-left':
      return [1 - v, u];
    case 'landscape-right':
      return [v, 1 - u];
    case 'portrait-upside-down':
      return [1 - u, 1 - v];
    default:
      return [u, v];
  }
}

/** The inverse: panel normalized -> upright normalized. */
export function panelToUpright(px: number, py: number, o: Orientation | null | undefined): [number, number] {
  px = clamp01(px);
  py = clamp01(py);
  switch (o) {
    case 'landscape-left':
      return [py, 1 - px];
    case 'landscape-right':
      return [1 - py, px];
    case 'portrait-upside-down':
      return [1 - px, 1 - py];
    default:
      return [px, py];
  }
}

/** norm = 0..1 of the upright picture; px = the upright picture's pixels; pt = WDA points (upright). */
export type Unit = 'norm' | 'px' | 'pt';

/** A message's `unit` field, or null when it has none we know. */
export function parseUnit(v: unknown): Unit | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'norm' || s === 'n' || s === 'normalized' || s === 'normalised' || s === 'ratio' || s === 'fraction') return 'norm';
  if (s === 'px' || s === 'pixel' || s === 'pixels') return 'px';
  if (s === 'pt' || s === 'point' || s === 'points') return 'pt';
  return null;
}

/**
 * The unit of coordinates sent without one: all within 0..1 (and not all whole numbers, which a point at the very
 * corner would be) = normalized; anything else = points, as before units existed. Pixels always say `unit: "px"`.
 */
export function guessUnit(coords: number[]): Unit {
  if (!coords.length) return 'pt';
  const inside = coords.every((c) => c >= 0 && c <= 1);
  return inside && !coords.every((c) => Number.isInteger(c)) ? 'norm' : 'pt';
}

/** The upright screen in points with its pixel scale, as the backends report it. */
export interface UprightScreen extends Size {
  scale: number | null;
}

/**
 * One coordinate pair in any unit -> upright points (not clamped). `frame` is the picture the pixels refer to (a
 * stream's frame, a screenshot); without it pixels are the screen's own (points x scale). Null when the screen (or
 * its scale, for pixels) isn't known yet.
 */
export function toPoints(x: number, y: number, unit: Unit, screen: UprightScreen | null, frame?: Size | null): [number, number] | null {
  if (unit === 'pt') return [x, y];
  if (!screen || !(screen.width > 0) || !(screen.height > 0)) return null;
  if (unit === 'norm') return [x * screen.width, y * screen.height];
  if (frame && frame.width > 0 && frame.height > 0) return [(x / frame.width) * screen.width, (y / frame.height) * screen.height];
  if (!screen.scale || !(screen.scale > 0)) return null;
  return [x / screen.scale, y / screen.scale];
}

/** Upright points -> upright normalized. */
export function toNorm(x: number, y: number, screen: Size): [number, number] {
  return [clamp01(x / Math.max(1, screen.width)), clamp01(y / Math.max(1, screen.height))];
}

/** Upright points -> the HID report's 0..65535 across the panel, per orientation. */
export function pointsToHid(x: number, y: number, screen: Size, o: Orientation | null | undefined): [number, number] {
  const [u, v] = toNorm(x, y, screen);
  const [px, py] = uprightToPanel(u, v, o);
  return [Math.round(px * 65535), Math.round(py * 65535)];
}

/** Whether a frame's shape (wide or tall) agrees with the orientation; true when either isn't known. */
export function frameAgrees(frame: Size | null | undefined, o: Orientation | null | undefined): boolean {
  if (!frame || !o || !(frame.width > 0) || !(frame.height > 0) || frame.width === frame.height) return true;
  return frame.width > frame.height === isLandscape(o);
}
