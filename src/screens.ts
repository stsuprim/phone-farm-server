import type { Size } from './orient.js';

/**
 * The phone's screen in points, and its pixel scale: what every fraction -> point conversion stands on (taps,
 * element middles, the live view's touches, HID). 2026-11-18, the taps that landed in the wrong place on iPhone-1:
 * the size used to be WDA's `/session/:id/window/size` alone, read once when a session was made and kept for the
 * whole session. That is the FRAME OF THE APP IN FRONT, not the screen: right after our build was installed, the
 * self-test had WebDriverAgent's own runner app in front, which runs letterboxed (an app without a launch storyboard
 * gets a legacy window such as 320 x 568), so the server took a 428 x 926 iPhone 14 Plus for a far smaller screen.
 * A tap at a fraction of the picture then landed up and to the left, and the elements' places (a tree in real
 * points over that small size) came out beyond 1.5, which Lotus's reader then showed rounded to 0 or 1.
 *
 * Now the size comes from the screen itself (`/wda/screen`'s `screenSize`: UIScreen's bounds in points, whatever app
 * is in front), checked against what the phone's model is known to have, and the app's window only when nothing
 * better answers; anything that isn't a sane phone screen is never used (no zero, no pixels taken for points).
 */

export interface ScreenPick extends Size {
  scale: number | null;
  /** Where the size came from: the screen itself, the app's window, the model's known size, or kept from before. */
  from: 'screen' | 'window' | 'model' | 'previous';
  /** Why another reading was passed over (for the log), or null. */
  note: string | null;
}

/** Portrait points and scale of the iPhones by model identifier (ideviceinfo's ProductType), at Standard zoom. */
export const KNOWN_SCREENS: Record<string, [number, number, number]> = {
  'iPhone10,1': [375, 667, 2], 'iPhone10,4': [375, 667, 2], 'iPhone10,2': [414, 736, 3], 'iPhone10,5': [414, 736, 3],
  'iPhone10,3': [375, 812, 3], 'iPhone10,6': [375, 812, 3],
  'iPhone11,2': [375, 812, 3], 'iPhone11,4': [414, 896, 3], 'iPhone11,6': [414, 896, 3], 'iPhone11,8': [414, 896, 2],
  'iPhone12,1': [414, 896, 2], 'iPhone12,3': [375, 812, 3], 'iPhone12,5': [414, 896, 3], 'iPhone12,8': [375, 667, 2],
  'iPhone13,1': [375, 812, 3], 'iPhone13,2': [390, 844, 3], 'iPhone13,3': [390, 844, 3], 'iPhone13,4': [428, 926, 3],
  'iPhone14,4': [375, 812, 3], 'iPhone14,5': [390, 844, 3], 'iPhone14,2': [390, 844, 3], 'iPhone14,3': [428, 926, 3],
  'iPhone14,6': [375, 667, 2], 'iPhone14,7': [390, 844, 3], 'iPhone14,8': [428, 926, 3],
  'iPhone15,2': [393, 852, 3], 'iPhone15,3': [430, 932, 3], 'iPhone15,4': [393, 852, 3], 'iPhone15,5': [430, 932, 3],
  'iPhone16,1': [393, 852, 3], 'iPhone16,2': [430, 932, 3],
  'iPhone17,1': [402, 874, 3], 'iPhone17,2': [440, 956, 3], 'iPhone17,3': [393, 852, 3], 'iPhone17,4': [430, 932, 3],
  'iPhone17,5': [390, 844, 3],
};

/** The legacy window sizes iOS gives an app that runs letterboxed (no launch storyboard): never the screen's own. */
const COMPAT_SIZES: [number, number][] = [[320, 480], [320, 568], [375, 667], [414, 736]];

const finite = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);

/** A size that can be a phone's (or tablet's) screen in points: not zero, not pixels, a screen's shape. Portrait. */
export function saneSize(s: { width?: unknown; height?: unknown } | null | undefined): Size | null {
  if (!s) return null;
  const w = finite(s.width);
  const h = finite(s.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  // points: the smallest iPhone is 320 across, the largest iPad 1366 long; pixels (x2, x3) are far beyond that
  if (short < 300 || long > 1400) return null;
  const aspect = long / short;
  if (aspect < 1.2 || aspect > 2.4) return null;
  return { width: short, height: long };
}

/** A pixel scale that can be a screen's (1, 2, 3; a few phones report 2.88 or similar). */
export function saneScale(v: unknown): number | null {
  const s = finite(v);
  return Number.isFinite(s) && s >= 1 && s <= 4 ? s : null;
}

/** The model's known screen (portrait points, scale), or null for a model not in the table. */
export function knownScreen(model: string | null | undefined): (Size & { scale: number }) | null {
  const k = model ? KNOWN_SCREENS[model.trim()] : undefined;
  return k ? { width: k[0], height: k[1], scale: k[2] } : null;
}

const near = (a: Size, b: Size, tol = 0.03) => Math.abs(a.width - b.width) <= b.width * tol && Math.abs(a.height - b.height) <= b.height * tol;
const isCompat = (s: Size) => COMPAT_SIZES.some(([w, h]) => Math.abs(s.width - w) < 1 && Math.abs(s.height - h) < 1);
const say = (s: Size) => `${Math.round(s.width)} x ${Math.round(s.height)}`;

/**
 * The screen to use, from what WDA said and what's known. `screen`: /wda/screen's `screenSize` (the screen's own, any
 * app); `window`: the app in front's window; `model`: ideviceinfo's ProductType; `previous`: the last good one for this
 * phone. Null when nothing sane is at hand (callers then say the size isn't known rather than guess).
 *
 * The screen's own size wins. The app's window is used only without it, and never when it's a letterboxed app's
 * legacy size smaller than the model's screen. Display Zoom changes a phone's points, so a sane reading that differs
 * from the model's table is believed (the table is for when WDA says nothing usable).
 */
export function pickScreen(r: {
  screen?: { width?: unknown; height?: unknown } | null;
  window?: { width?: unknown; height?: unknown } | null;
  scale?: unknown;
  model?: string | null;
  previous?: (Size & { scale: number | null }) | null;
}): ScreenPick | null {
  const known = knownScreen(r.model);
  const screen = saneSize(r.screen);
  const win = saneSize(r.window);
  const scale = saneScale(r.scale) ?? known?.scale ?? saneScale(r.previous?.scale) ?? null;
  const notes: string[] = [];
  if (r.window && !win) notes.push(`the app's window size ${JSON.stringify(r.window)} isn't a screen's`);
  if (r.screen && !screen) notes.push(`the screen size ${JSON.stringify(r.screen)} isn't a screen's`);
  if (screen) {
    if (win && !near(win, screen, 0.01)) notes.push(`the app in front has a ${say(win)} window (letterboxed or split), not the screen's ${say(screen)}`);
    return { ...screen, scale, from: 'screen', note: notes.length ? notes.join('; ') : null };
  }
  if (win) {
    const letterboxed = isCompat(win) && !!known && (win.width < known.width - 1 || win.height < known.height - 1);
    if (!letterboxed) return { ...win, scale, from: 'window', note: notes.length ? notes.join('; ') : null };
    notes.push(`the app in front runs letterboxed (${say(win)}), not the screen's ${say(known!)}`);
  }
  if (known) return { width: known.width, height: known.height, scale: saneScale(r.scale) ?? known.scale, from: 'model', note: notes.length ? notes.join('; ') : null };
  const prev = saneSize(r.previous);
  if (prev) return { ...prev, scale, from: 'previous', note: notes.length ? notes.join('; ') : null };
  return null;
}
