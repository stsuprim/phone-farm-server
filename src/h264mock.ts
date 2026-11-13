import { encodeRecord, KIND, ProducerHooks, RecordParser, StartProducer } from './h264.js';

/**
 * A tiny but real H.264 encoder for mock mode, so the client can decode the mock stream (WebCodecs, ffmpeg...).
 * Constrained Baseline, 208x448 (13x28 macroblocks). Keyframes: every macroblock I_PCM (raw samples). Deltas: P slices
 * where unchanged macroblocks are skipped and changed ones are I_PCM. No transforms, no entropy tricks: big keyframes
 * (~140 KB) but tiny deltas, which is all a test needs.
 */
export const MOCK_W = 208;
export const MOCK_H = 448;
const MBW = MOCK_W / 16;
const MBH = MOCK_H / 16;

class Bits {
  private buf = new Uint8Array(4096);
  private len = 0;
  private cur = 0;
  private n = 0;
  private grow(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + extra));
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  bit(b: number) {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.n === 8) {
      this.grow(1);
      this.buf[this.len++] = this.cur;
      this.cur = 0;
      this.n = 0;
    }
  }
  u(v: number, bits: number) {
    for (let i = bits - 1; i >= 0; i--) this.bit((v >>> i) & 1);
  }
  ue(v: number) {
    const x = v + 1;
    const len = 32 - Math.clz32(x);
    this.u(0, len - 1);
    this.u(x, len);
  }
  se(v: number) {
    this.ue(v <= 0 ? -2 * v : 2 * v - 1);
  }
  align() {
    while (this.n) this.bit(0);
  }
  bytes(src: Uint8Array) {
    this.grow(src.length);
    this.buf.set(src, this.len);
    this.len += src.length;
  }
  trailing() {
    this.bit(1);
    this.align();
  }
  done(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** Start code + NAL header + RBSP with emulation prevention. */
function nal(refIdc: number, type: number, rbsp: Uint8Array): Buffer {
  const out: number[] = [0, 0, 0, 1, (refIdc << 5) | type];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

export function mockSpsPps(): Buffer {
  const s = new Bits();
  s.u(66, 8); // profile_idc: baseline
  s.u(0b11000000, 8); // constraint_set0 + set1 (constrained baseline)
  s.u(31, 8); // level 3.1
  s.ue(0); // sps id
  s.ue(0); // log2_max_frame_num_minus4 -> 4-bit frame_num
  s.ue(2); // pic_order_cnt_type 2
  s.ue(1); // max_num_ref_frames
  s.u(0, 1); // gaps
  s.ue(MBW - 1);
  s.ue(MBH - 1);
  s.u(1, 1); // frame_mbs_only
  s.u(1, 1); // direct_8x8_inference
  s.u(0, 1); // cropping
  s.u(0, 1); // vui
  s.trailing();
  const p = new Bits();
  p.ue(0); // pps id
  p.ue(0); // sps id
  p.u(0, 1); // CAVLC
  p.u(0, 1); // bottom_field_pic_order_in_frame_present
  p.ue(0); // one slice group
  p.ue(0); // num_ref_idx_l0_default_active_minus1
  p.ue(0); // l1
  p.u(0, 1); // weighted_pred
  p.u(0, 2); // weighted_bipred_idc
  p.se(0); // pic_init_qp_minus26
  p.se(0); // pic_init_qs_minus26
  p.se(0); // chroma_qp_index_offset
  p.u(1, 1); // deblocking_filter_control_present
  p.u(0, 1); // constrained_intra_pred
  p.u(0, 1); // redundant_pic_cnt_present
  p.trailing();
  return Buffer.concat([nal(3, 7, s.done()), nal(3, 8, p.done())]);
}

/** YUV 4:2:0 frame. */
export interface Yuv {
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

function mbSamples(f: Yuv, mx: number, my: number): Uint8Array {
  const out = new Uint8Array(384);
  let k = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out[k++] = Math.max(1, f.y[(my * 16 + y) * MOCK_W + mx * 16 + x]!);
  for (const plane of [f.u, f.v])
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[k++] = Math.max(1, plane[(my * 8 + y) * (MOCK_W / 2) + mx * 8 + x]!);
  return out;
}

function mbChanged(a: Yuv, b: Yuv, mx: number, my: number): boolean {
  for (let y = 0; y < 16; y++) {
    const o = (my * 16 + y) * MOCK_W + mx * 16;
    for (let x = 0; x < 16; x++) if (a.y[o + x] !== b.y[o + x]) return true;
  }
  for (let y = 0; y < 8; y++) {
    const o = (my * 8 + y) * (MOCK_W / 2) + mx * 8;
    for (let x = 0; x < 8; x++) if (a.u[o + x] !== b.u[o + x] || a.v[o + x] !== b.v[o + x]) return true;
  }
  return false;
}

export function encodeIdr(f: Yuv, idrId: number): Buffer {
  const s = new Bits();
  s.ue(0); // first_mb_in_slice
  s.ue(7); // slice_type: I (all slices)
  s.ue(0); // pps id
  s.u(0, 4); // frame_num
  s.ue(idrId % 65536);
  s.u(0, 1); // no_output_of_prior_pics
  s.u(0, 1); // long_term_reference
  s.se(0); // slice_qp_delta
  s.ue(1); // deblocking off
  for (let my = 0; my < MBH; my++)
    for (let mx = 0; mx < MBW; mx++) {
      s.ue(25); // I_PCM
      s.align();
      s.bytes(mbSamples(f, mx, my));
    }
  s.trailing();
  return nal(3, 5, s.done());
}

export function encodeP(f: Yuv, prev: Yuv, frameNum: number): Buffer {
  const s = new Bits();
  s.ue(0);
  s.ue(5); // P (all slices)
  s.ue(0);
  s.u(frameNum % 16, 4);
  s.u(0, 1); // num_ref_idx_active_override
  s.u(0, 1); // ref_pic_list_modification_flag_l0
  s.u(0, 1); // adaptive_ref_pic_marking_mode
  s.se(0);
  s.ue(1);
  let skip = 0;
  for (let my = 0; my < MBH; my++)
    for (let mx = 0; mx < MBW; mx++) {
      if (!mbChanged(f, prev, mx, my)) {
        skip++;
        continue;
      }
      s.ue(skip);
      skip = 0;
      s.ue(30); // I_PCM in a P slice (5 + 25)
      s.align();
      s.bytes(mbSamples(f, mx, my));
    }
  if (skip) s.ue(skip);
  s.trailing();
  return nal(2, 1, s.done());
}

export interface MockScene {
  hue: number;
  frame: number;
  marks: { x: number; y: number; x2?: number; y2?: number; at: number }[];
  app: string;
}

function rgbToYuv(r: number, g: number, b: number): [number, number, number] {
  return [
    Math.round(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255),
    Math.round(128 + (-37.797 * r - 74.203 * g + 112 * b) / 255),
    Math.round(128 + (112 * r - 93.786 * g - 18.214 * b) / 255),
  ];
}
function hsvRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return [f(5), f(3), f(1)];
}
const hashStr = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);

/** Draws the mock phone screen (points 390x844 mapped onto 208x448). */
export function renderYuv(scene: MockScene): Yuv {
  const f: Yuv = { y: new Uint8Array(MOCK_W * MOCK_H), u: new Uint8Array((MOCK_W / 2) * (MOCK_H / 2)), v: new Uint8Array((MOCK_W / 2) * (MOCK_H / 2)) };
  const top = rgbToYuv(...hsvRgb(scene.hue, 0.55, 0.95));
  const bot = rgbToYuv(...hsvRgb((scene.hue + 40) % 360, 0.7, 0.45));
  for (let y = 0; y < MOCK_H; y++) {
    const t = Math.floor((y / MOCK_H) * 8) / 8; // banded so macroblocks stay identical frame to frame
    const yy = Math.round(top[0] + (bot[0] - top[0]) * t);
    f.y.fill(yy, y * MOCK_W, (y + 1) * MOCK_W);
    if (y % 2 === 0) {
      const cy = y / 2;
      f.u.fill(Math.round(top[1] + (bot[1] - top[1]) * t), cy * (MOCK_W / 2), (cy + 1) * (MOCK_W / 2));
      f.v.fill(Math.round(top[2] + (bot[2] - top[2]) * t), cy * (MOCK_W / 2), (cy + 1) * (MOCK_W / 2));
    }
  }
  const rect = (x: number, y: number, w: number, h: number, c: [number, number, number]) => {
    x = Math.round(x);
    y = Math.round(y);
    for (let j = Math.max(0, y); j < Math.min(MOCK_H, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(MOCK_W, x + w); i++) {
        f.y[j * MOCK_W + i] = c[0];
        f.u[(j >> 1) * (MOCK_W / 2) + (i >> 1)] = c[1];
        f.v[(j >> 1) * (MOCK_W / 2) + (i >> 1)] = c[2];
      }
  };
  const sx = MOCK_W / 390;
  const sy = MOCK_H / 844;
  rect(MOCK_W / 2 - 40, 110, 80, 80, rgbToYuv(...hsvRgb(hashStr(scene.app) % 360, 0.8, 0.9)));
  rect(10 + ((scene.frame * 4) % (MOCK_W - 40)), MOCK_H - 48, 24, 16, rgbToYuv(255, 255, 255)); // moving block
  const now = Date.now();
  for (const m of scene.marks) {
    if (now - m.at > 1500) continue;
    rect(m.x * sx - 6, m.y * sy - 6, 12, 12, rgbToYuv(255, 40, 40));
    if (m.x2 !== undefined && m.y2 !== undefined) rect(m.x2 * sx - 4, m.y2 * sy - 4, 8, 8, rgbToYuv(255, 255, 0));
  }
  return f;
}

/**
 * Mock capture helper: renders at `fps`, keyframe every 2 s or when asked, and talks the helper's byte framing
 * (serialized, then re-parsed in odd-sized chunks) so the same parser path is exercised as with the real helper.
 */
export function mockProducer(scene: () => MockScene): StartProducer {
  return (want, hooks: ProducerHooks) => {
    const fps = Math.min(want.fps, 30);
    const parser = new RecordParser(hooks.record);
    const emit = (kind: number, time: number, payload: Buffer) => {
      const bytes = encodeRecord(kind, time, payload);
      for (let off = 0; off < bytes.length; ) {
        const n = Math.min(bytes.length - off, 1 + Math.floor(Math.random() * 9000));
        parser.push(bytes.subarray(off, off + n));
        off += n;
      }
    };
    const config = mockSpsPps();
    let prev: Yuv | null = null;
    let frameNum = 0;
    let idr = 0;
    let wantKey = true;
    let n = 0;
    let encSum = 0;
    let lastStats = 0; // first stats right away
    emit(KIND.INFO, Date.now(), Buffer.from(JSON.stringify({ width: MOCK_W, height: MOCK_H, fps, scale: 100 })));
    const tick = () => {
      const s = scene();
      const t = Date.now();
      const f = renderYuv(s);
      s.frame++;
      const t0 = performance.now();
      const key = wantKey || !prev || frameNum >= fps * 2;
      if (key) {
        wantKey = false;
        frameNum = 0;
        const data = encodeIdr(f, idr++);
        encSum += performance.now() - t0;
        emit(KIND.CONFIG, t, config);
        emit(KIND.KEY, t, data);
      } else {
        const data = encodeP(f, prev!, frameNum);
        encSum += performance.now() - t0;
        emit(KIND.DELTA, t, data);
      }
      frameNum++;
      prev = f;
      n++;
      if (t - lastStats >= 1000) {
        const enc = encSum / n;
        emit(KIND.STATS, t, Buffer.from(JSON.stringify({ encode_ms: enc, capture_to_encoded_ms: enc })));
        n = 0;
        encSum = 0;
        lastStats = t;
      }
    };
    let timer: NodeJS.Timeout | undefined = setInterval(tick, Math.round(1000 / fps));
    setImmediate(() => timer && tick());
    return {
      key: () => {
        wantKey = true;
        setImmediate(() => timer && tick()); // like the real helper: re-encode the current screen as an IDR now
      },
      stop: () => {
        if (timer) clearInterval(timer);
        timer = undefined;
      },
    };
  };
}
