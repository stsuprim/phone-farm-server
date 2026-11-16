import zlib from 'node:zlib';
import { imageSize } from './imgsize.js';

/**
 * Is the phone's screen dark (off)? 2026-11-16, the black picture: a phone without a passcode never says "locked"
 * (WDA's /wda/locked reads SpringBoard's lock state, which stays 0 with no passcode), so after a lock or iOS's own
 * Auto-Lock its screen is off while everything says it's awake, WDA's /wda/unlock does nothing ("not locked"), the
 * H.264 capture has no frames to give and every screenshot is black. A screenshot is the one thing that tells: a
 * screen that's on always shows something (the clock at least).
 */

/** A pixel this bright or less (0-255, its brightest channel) is black. */
export const BLACK_MAX = 24;
/** A screenshot with at most this share of brighter pixels is a dark screen (a screen that's on has a clock: far more). */
export const BLACK_SHARE = 0.001;
/** A JPEG under this many bytes a pixel may be all black (4:2:0 flat blocks are ~0.016; a picture with anything on it is far over). */
export const JPEG_BLACK_BPP = 0.035;

/**
 * True when a JPEG is small enough to be an all-black picture (it may still be a very dark screen: a PNG says for
 * sure); false when it clearly shows something; null when its size can't be read.
 */
export function jpegMaybeBlack(jpeg: Buffer): boolean | null {
  const size = imageSize(jpeg);
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  return jpeg.length / (size.width * size.height) < JPEG_BLACK_BPP;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * True when a PNG screenshot is black all over (at most BLACK_SHARE of its pixels brighter than BLACK_MAX), false
 * when it shows anything, null when it isn't a PNG this reads (8 or 16 bit grey, RGB or RGBA, not interlaced).
 */
export function pngIsBlack(png: Buffer): boolean | null {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = -1;
  const idat: Buffer[] = [];
  while (off + 12 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (data.length < len) return null;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      color = data[9]!;
      if (data[12] !== 0) return null; // interlaced
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (!channels || (depth !== 8 && depth !== 16) || !width || !height || !idat.length) return null;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(idat.length === 1 ? idat[0]! : Buffer.concat(idat));
  } catch {
    return null;
  }
  const bytes = depth / 8;
  const bpp = channels * bytes; // bytes a pixel
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const colors = color === 0 || color === 4 ? 1 : 3; // the channels that are colour (alpha left out)
  const most = Math.floor(width * height * BLACK_SHARE);
  let bright = 0;
  let prev = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at]!;
    const line = raw.subarray(at + 1, at + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const x = line[i]!;
      row[i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xff;
    }
    if (filter > 4) return null;
    for (let px = 0; px < stride; px += bpp) {
      for (let ch = 0; ch < colors; ch++) {
        if (row[px + ch * bytes]! > BLACK_MAX) {
          // 16 bit: the high byte comes first
          if (++bright > most) return false;
          break;
        }
      }
    }
    const t = prev;
    prev = row;
    row = t;
  }
  return true;
}

/** Waking a dark phone: Home, this long, Home again (as WDA's own unlock), then this long for the screen to show. */
export const WAKE_PRESS_GAP_MS = 900;
export const WAKE_SETTLE_MS = 600;

/** What waking a phone needs of it (src/real.ts gives WDA's; tests their own). */
export interface WakeOps {
  /** WDA's own word on the lock (always false on a phone without a passcode); null when it doesn't say. */
  locked(): Promise<boolean | null>;
  /** WDA's /wda/unlock: past the lock screen of a phone that says it's locked; does nothing on one that doesn't. */
  unlock(): Promise<unknown>;
  /** Whether the screen is dark (a screenshot); null when it can't be told. */
  dark(): Promise<boolean | null>;
  /** One Home press that never heals or throws for long. */
  home(): Promise<unknown>;
  sleep?(ms: number): Promise<void>;
  log?(m: string): void;
}

/**
 * Wake and unlock. A phone that says it's locked (or doesn't say) gets WDA's unlock. Then the screen itself is looked
 * at: one still dark (a phone without a passcode never says "locked": its screen is just off after a lock or iOS's
 * Auto-Lock, and WDA's unlock did nothing) gets what WDA's unlock does, Home (the screen comes on), a moment, Home
 * again (past the lock screen), twice at most. Home is never pressed on a screen that shows something (it would leave
 * the app in front), nor when the screen can't be told. Throws when it stays dark.
 */
export async function wakeScreen(ops: WakeOps): Promise<void> {
  const sleep = ops.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const locked = await ops.locked();
  if (locked !== false) {
    try {
      await ops.unlock();
    } catch (err) {
      if (locked === true) throw err;
    }
  }
  for (let n = 0; n < 2; n++) {
    if ((await ops.dark()) !== true) return;
    ops.log?.(`the screen is dark${locked === false ? ' (the phone says it is not locked)' : ''}: pressing Home`);
    await ops.home().catch(() => {});
    await sleep(WAKE_PRESS_GAP_MS);
    await ops.home().catch(() => {});
    await sleep(WAKE_SETTLE_MS);
  }
  if ((await ops.dark()) === true) throw new Error('the screen stayed dark after two wakes');
}
