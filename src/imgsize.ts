import type { Size } from './orient.js';

/** The pixel size of a JPEG (its SOF marker) or a PNG (IHDR), read from the header only; null when it's neither. */
export function imageSize(buf: Buffer): Size | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1]!;
    if (marker === 0xff) {
      off++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // image data began: no frame header
    const len = buf.readUInt16BE(off + 2);
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
    }
    if (len < 2) return null;
    off += 2 + len;
  }
  return null;
}
