import { trace } from './trace.js';

/**
 * Congestion control for the live view, so a slow or far link (Tailscale across countries) gets a picture that fits it
 * instead of seconds of queue (TCP) or a lossy, frozen stream (WebRTC):
 *
 * - RateControl: one viewer's target bitrate, cut on congestion, raised slowly while the link is clean. The shared
 *   encoder runs at the lowest target of its viewers (H264Source.setTarget).
 * - WsFlow: WebSocket viewers. A protocol ping goes after the frames (every client answers pings with a pong, in
 *   order), so a pong says everything before it arrived: the round trip includes the queue in front of the viewer.
 *   While the oldest unanswered ping has waited too long the viewer counts as congested (frames are skipped, never
 *   queued) and the bitrate goes down; the delivered rate comes from the acknowledged bytes.
 * - parseRtcp: WebRTC viewers. Receiver reports' fraction lost, NACKed packets, REMB, PLI/FIR and the round trip
 *   (LSR/DLSR against our own sender reports) from the browser.
 * - DelayTracker: WebRTC viewers' queue, the round trip beyond the quickest of the last 30 s (kept for its stats; the
 *   live view's control uses JitterDelay since 2026-11-27).
 * - JitterDelay (2026-11-27, docs/root-cause.md 5): the delay signal made jitter-aware. Tailscale across countries has
 *   a ~185 ms round trip with ~127 ms of jitter; read as "the latest round trip minus the quickest of 30 s", every
 *   second sample looked like 150+ ms of queue and the bitrate was cut every 2 s down to the floor (22 freezes of
 *   ~7 s on iPhone-2). Now the base is a low percentile, the queue a smoothed median, and over-use needs a queue
 *   above max(cut, 2x the measured jitter) that is also rising by more than the jitter (or a standing queue above
 *   max(hard, 4x jitter)). The jitter is the larger of the receiver's RTCP interarrival jitter and the round trips' own
 *   spread.
 * - LinkControl: one WebRTC viewer's whole loop (loss, JitterDelay, RateControl with fast recovery), its link class
 *   (lan, remote, far) with per-class floors, and the playout delay a far link should ask for.
 * - FreezeTracker: every gap in a viewer's picture labelled by its cause (src, encoder, network, client), or as a
 *   still screen (no new frames from a running capture: not a freeze).
 */

export const MIN_BPS = 400_000;
/** Where a viewer that isn't on the Mac's LAN starts; it climbs from here while the link keeps up. */
export const REMOTE_START_BPS = 1_500_000;
/** A far viewer's ceiling when it asks for no bitrate (its `bitrate` ask is the ceiling otherwise). */
export const REMOTE_CEILING_BPS = 2_500_000;
/** A far viewer's lane: at most this frame rate and about this many pixels on the long side (src/lanes.ts). */
export const REMOTE_MAX_FPS = 30;
export const REMOTE_LONG_SIDE = 1400;
/**
 * A far viewer's lane makes a keyframe only every this many seconds (phonecap's most), else when it's asked (PLI, a
 * new viewer, a dropped frame): a periodic 100+ KB burst on a long link was loss, then a PLI, then another keyframe
 * (docs/BEST_METHOD.md 2c). LAN lanes keep 2 s.
 */
export const REMOTE_KEY_SECONDS = 10;
export const DEFAULT_CEILING_BPS = 8_000_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A client's bitrate ask: kbit/s (what Lotus sends), or bit/s when it's above 100000. Null when absent or bad. */
export function bitrateAsk(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(clamp(n > 100_000 ? n : n * 1000, MIN_BPS, 50_000_000));
}

/**
 * One viewer's target bitrate: multiplicative decrease on congestion, +8 % a second after 2 clean seconds. With
 * `recover` (2026-11-27), a target well under the rate it held before its last run of cuts climbs back by that factor
 * a second (a jitter burst or a short congestion is over in seconds, not in the half minute +8 % takes).
 */
export class RateControl {
  bps: number;
  readonly max: number;
  private lastDown = -Infinity;
  private lastUp: number;
  /** The target before the current run of cuts (fast recovery climbs back to it); 0 = none. */
  private good = 0;
  private recover: number;
  constructor(max: number, start: number, private min = MIN_BPS, private now: () => number = Date.now, opts: { recover?: number } = {}) {
    this.max = Math.max(min, max);
    this.bps = Math.round(clamp(start, min, this.max));
    this.lastUp = now();
    this.recover = opts.recover ?? 1.08;
  }

  get floor(): number {
    return this.min;
  }

  /**
   * Congestion: down to `factor` of now, or to 90 % of the rate the link delivered when that's lower (never below
   * half at once). At most once per `holdMs` (a cut needs a round trip to show). True if the target changed.
   */
  down(factor: number, delivered?: number | null, holdMs = 800): boolean {
    const t = this.now();
    if (t - this.lastDown < holdMs) return false;
    // a new run of cuts (none in the last 10 s): remember what the link carried before it
    if (t - this.lastDown > 10_000) this.good = this.bps;
    this.lastDown = t;
    this.lastUp = t;
    let next = this.bps * factor;
    if (delivered && delivered > 0 && delivered * 0.9 < next) next = Math.max(delivered * 0.9, this.bps * 0.5);
    next = Math.round(clamp(next, this.min, this.max));
    if (next >= this.bps) return false;
    this.bps = next;
    return true;
  }

  /** A clean stretch: +8 %, once a second, starting 2 s after the last cut. True if the target changed. */
  up(): boolean {
    const t = this.now();
    if (this.bps >= this.max || t - this.lastDown < 2000 || t - this.lastUp < 1000) return false;
    this.lastUp = t;
    const fast = this.recover > 1.08 && this.good > 0 && this.bps < this.good * 0.85;
    const next = this.bps * (fast ? this.recover : 1.08);
    this.bps = Math.round(Math.min(this.max, fast ? Math.min(next, this.good) : next));
    if (this.bps >= this.good) this.good = 0;
    return true;
  }

  /** A hard ceiling from the receiver (REMB). True if the target changed. */
  cap(bps: number): boolean {
    const next = Math.round(clamp(bps, this.min, this.max));
    if (next >= this.bps) return false;
    this.bps = next;
    return true;
  }
}

/** What WsFlow needs of a `ws` WebSocket. */
export interface PingSocket {
  ping(data?: Buffer): void;
  on(event: 'pong', listener: (data: Buffer) => void): unknown;
}

export interface WsFlowOptions {
  /** Queue (round trip beyond the path's own) that counts as congested. */
  targetMs?: number;
  /** After each pong (a chance to send what was held back). */
  onAck?: () => void;
  now?: () => number;
}

/** Ping-based flow control for one WebSocket viewer (see the top of this file). */
export class WsFlow {
  private sentBytes = 0;
  private ackedBytes = 0;
  private seq = 0;
  private out: { id: number; bytes: number; t: number }[] = [];
  private lastPing = -Infinity;
  private firstPing = 0;
  private gotPong = false;
  private rtts: { t: number; rtt: number }[] = [];
  private lastAck: { bytes: number; t: number } | null = null;
  /** Delivered bit/s (smoothed), from the acknowledged bytes. */
  delivered: number | null = null;
  /** The last round trip, ms. */
  rtt: number | null = null;
  /** The client never answers pings: no flow control (the old behaviour). */
  disabled = false;
  private targetMs: number;
  private now: () => number;

  constructor(ws: PingSocket, private send: (id: Buffer) => void, private opts: WsFlowOptions = {}) {
    this.targetMs = opts.targetMs ?? 250;
    this.now = opts.now ?? Date.now;
    ws.on('pong', (d) => this.pong(d));
  }

  /** Builds one for a `ws` WebSocket. */
  static of(ws: PingSocket, opts: WsFlowOptions = {}): WsFlow {
    return new WsFlow(ws, (b) => ws.ping(b), opts);
  }

  /** After a message of `n` bytes went to ws.send: a ping behind it (at most every 15 ms). */
  sent(n: number): void {
    this.sentBytes += n;
    if (this.disabled) return;
    const t = this.now();
    if (t - this.lastPing < 15) return;
    if (!this.firstPing) this.firstPing = t;
    this.probe();
  }

  private pong(d: Buffer): void {
    if (!Buffer.isBuffer(d) || d.length !== 4) return;
    const id = d.readUInt32BE(0);
    const i = this.out.findIndex((p) => p.id === id);
    if (i < 0) return;
    const p = this.out[i]!;
    this.out.splice(0, i + 1);
    const t = this.now();
    this.gotPong = true;
    this.ackedBytes = Math.max(this.ackedBytes, p.bytes);
    this.rtt = t - p.t;
    this.rtts.push({ t, rtt: this.rtt });
    while (this.rtts.length && (t - this.rtts[0]!.t > 20_000 || this.rtts.length > 600)) this.rtts.shift();
    if (!this.lastAck) this.lastAck = { bytes: p.bytes, t };
    else if (t - this.lastAck.t >= 300) {
      const bps = ((p.bytes - this.lastAck.bytes) * 8000) / (t - this.lastAck.t);
      this.delivered = this.delivered === null ? bps : this.delivered * 0.6 + bps * 0.4;
      this.lastAck = { bytes: p.bytes, t };
    }
    this.opts.onAck?.();
  }

  /** The path's own round trip: the quickest of the last 20 s. */
  baseRtt(): number {
    let m = Infinity;
    for (const r of this.rtts) m = Math.min(m, r.rtt);
    return Number.isFinite(m) ? m : 0;
  }

  /** The last pong's queue: its round trip beyond the base (0 before any). */
  lastQueueMs(): number {
    return this.rtt === null ? 0 : Math.max(0, this.rtt - this.baseRtt());
  }

  /** How long the oldest unanswered ping has waited beyond the base round trip. */
  waitingMs(): number {
    if (this.disabled) return 0;
    const oldest = this.out[0];
    if (!oldest) return 0;
    const t = this.now();
    if (!this.gotPong && t - this.firstPing > 10_000) {
      // a client that never answers pings: back to the old behaviour rather than starving it
      this.disabled = true;
      this.out = [];
      return 0;
    }
    return Math.max(0, t - oldest.t - this.baseRtt());
  }

  /**
   * True while frames sent earlier still wait in the network or the socket's buffers longer than the target. While
   * it is, a bare ping goes out every 250 ms, so a pong that never came (a client that skipped one) can't stall it.
   */
  congested(): boolean {
    if (this.waitingMs() <= this.targetMs) return false;
    if (this.now() - this.lastPing >= 250) this.probe();
    return true;
  }

  /** Bytes sent that no pong has acknowledged yet (on the way, or waiting in a buffer). */
  inflight(): number {
    return this.disabled ? 0 : this.sentBytes - this.ackedBytes;
  }

  /**
   * Whether a message of `n` bytes may go now (frames that stand alone, like JPEGs): always when nothing is on the way;
   * one more right behind a single frame still on its way (so a long link isn't left idle for a round trip after each
   * frame); otherwise only while the oldest unanswered ping is within the target.
   */
  canSend(n: number): boolean {
    if (this.disabled) return true;
    const inflight = this.inflight();
    if (inflight <= 0) return true;
    if (!this.congested()) return true;
    return inflight <= Math.max(n, 32 * 1024) && this.waitingMs() <= this.targetMs * 3;
  }

  private probe(): void {
    const t = this.now();
    this.lastPing = t;
    const id = (++this.seq) >>> 0;
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(id, 0);
    try {
      this.send(b);
    } catch {
      return;
    }
    this.out.push({ id, bytes: this.sentBytes, t });
    if (this.out.length > 2000) this.out.shift();
  }

  stats() {
    return {
      rtt_ms: this.rtt === null ? null : Math.round(this.rtt),
      base_rtt_ms: Math.round(this.baseRtt()),
      queue_ms: Math.round(Math.max(this.lastQueueMs(), this.waitingMs())),
      delivered_kbps: this.delivered === null ? null : Math.round(this.delivered / 1000),
    };
  }
}

export interface RtcpInfo {
  /** The highest fraction lost (0-1) in the receiver reports, or null if none. */
  fractionLost: number | null;
  /**
   * The round trip (ms) from a report block's LSR/DLSR (RFC 3550 6.4.1): now - the sender report it answers - the time
   * it was held. Null without one (no sender report seen yet). Our SRs carry the system clock (libdatachannel's
   * ntp_time), the same as Date.now().
   */
  rttMs: number | null;
  /** Packets the receiver asked again (generic NACK). */
  nacked: number;
  /** The receiver's estimate (REMB), bit/s, or null. */
  remb: number | null;
  /** A PLI or FIR: the receiver wants a keyframe. */
  wantsKey: boolean;
  /**
   * 2026-11-27: each report block (RFC 3550 6.4.1): the source it reports on, its fraction lost and its interarrival
   * jitter in that source's RTP clock units (90 kHz for the video: ms = jitter / 90).
   */
  blocks: { ssrc: number; fractionLost: number; jitter: number }[];
}

/** NTP's middle 32 bits (RTCP's LSR units: 1/65536 s) of a Date.now() time. */
export function ntpMid32(ms: number): number {
  return Math.floor((ms / 1000 + 2_208_988_800) * 65536) % 0x1_0000_0000;
}

/** Reads a (compound) RTCP packet from the receiver; `nowMs` is when it arrived (for the round trip). */
export function parseRtcp(buf: Buffer, nowMs: number = Date.now()): RtcpInfo {
  const info: RtcpInfo = { fractionLost: null, rttMs: null, nacked: 0, remb: null, wantsKey: false, blocks: [] };
  const arrived = ntpMid32(nowMs);
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf[off]! >> 6 !== 2) break;
    const count = buf[off]! & 0x1f;
    const pt = buf[off + 1]!;
    const end = Math.min(buf.length, off + (buf.readUInt16BE(off + 2) + 1) * 4);
    if (pt === 200 || pt === 201) {
      // SR: 28 bytes before the report blocks; RR: 8
      let b = off + (pt === 200 ? 28 : 8);
      for (let i = 0; i < count && b + 24 <= end; i++, b += 24) {
        const f = buf[b + 4]! / 256;
        info.fractionLost = info.fractionLost === null ? f : Math.max(info.fractionLost, f);
        info.blocks.push({ ssrc: buf.readUInt32BE(b), fractionLost: f, jitter: buf.readUInt32BE(b + 12) });
        const lsr = buf.readUInt32BE(b + 16);
        const dlsr = buf.readUInt32BE(b + 20);
        if (lsr !== 0) {
          const rtt = ((((arrived - lsr - dlsr) % 0x1_0000_0000) + 0x1_0000_0000) % 0x1_0000_0000) / 65.536; // ms
          if (rtt < 60_000) info.rttMs = info.rttMs === null ? rtt : Math.min(info.rttMs, rtt);
        }
      }
    } else if (pt === 205 && count === 1) {
      for (let b = off + 12; b + 4 <= end; b += 4) {
        let blp = buf.readUInt16BE(b + 2);
        let n = 1;
        while (blp) {
          n += blp & 1;
          blp >>= 1;
        }
        info.nacked += n;
      }
    } else if (pt === 206) {
      if (count === 1 || count === 4) info.wantsKey = true;
      else if (count === 15 && off + 20 <= end && buf.toString('latin1', off + 12, off + 16) === 'REMB') {
        const exp = buf[off + 17]! >> 2;
        const mantissa = ((buf[off + 17]! & 3) << 16) | buf.readUInt16BE(off + 18);
        info.remb = mantissa * 2 ** exp;
      }
    }
    if (end <= off) break;
    off = end;
  }
  return info;
}

/** A WebRTC viewer's queue: base round trip (quickest of the last `windowMs`) and the latest one beyond it. */
export class DelayTracker {
  private samples: { t: number; rtt: number }[] = [];
  /** The last round trip, ms (null before any). */
  rtt: number | null = null;
  private lastT = 0;
  constructor(private windowMs = 30_000, private now: () => number = Date.now) {}

  add(rtt: number | null): void {
    if (rtt === null || !Number.isFinite(rtt) || rtt < 0 || rtt > 10_000) return;
    const t = this.now();
    this.samples.push({ t, rtt });
    this.rtt = rtt;
    this.lastT = t;
    while (this.samples.length && (t - this.samples[0]!.t > this.windowMs || this.samples.length > 600)) this.samples.shift();
  }

  /** The path's own round trip: the quickest of the window (0 before any). */
  base(): number {
    let m = Infinity;
    for (const s of this.samples) m = Math.min(m, s.rtt);
    return Number.isFinite(m) ? m : 0;
  }

  /** The latest round trip beyond the base, or null when there's no recent one (older than `freshMs`). */
  queueMs(freshMs = 3000): number | null {
    if (this.rtt === null || this.now() - this.lastT > freshMs) return null;
    return Math.max(0, this.rtt - this.base());
  }

  stats() {
    const q = this.queueMs();
    return { rtt_ms: this.rtt === null ? null : Math.round(this.rtt), base_rtt_ms: this.samples.length ? Math.round(this.base()) : null, queue_ms: q === null ? null : Math.round(q) };
  }
}

// ---- 2026-11-27: the jitter-aware delay signal, the per-viewer link loop and freeze labels (docs/root-cause.md 5) ----

/**
 * Delay marks (ms of queue: the round trip beyond the path's own). A queue over `cut` may lower the bitrate (x0.85,
 * x0.6 over `hard`), and it only climbs under `clear`. JitterDelay raises each to a multiple of the measured jitter.
 */
export const DELAY_MARKS = {
  remote: { cut: 150, hard: 500, clear: 50 },
  lan: { cut: 80, hard: 300, clear: 25 },
};
export type DelayMarks = (typeof DELAY_MARKS)['lan'];
/** After a delay cut, the next waits this long: the queue needs a round trip or two to drain. */
export const DELAY_HOLD_MS = 2000;

/** The p-th percentile (0-1) of a list (nearest rank on a sorted copy); null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
}

export type DelayState = 'overuse' | 'normal' | 'underuse' | 'unknown';
export interface DelaySignal {
  state: DelayState;
  /** The path's own round trip: the 10th percentile of the window (ms). */
  base: number | null;
  /** The median round trip of the last few seconds (ms). */
  smoothed: number | null;
  /** smoothed - base (ms). */
  queue: number | null;
  /** How much the median rose over the trend window (ms; > 0 = a queue building). */
  rise: number | null;
  /** The measured jitter (ms): the larger of RTCP's interarrival jitter and the round trips' own spread. */
  jitter: number;
  /** The queue that counts as over-use now: max(cut, 2 x jitter) (ms). */
  threshold: number;
  /** A standing queue this big is over-use even when it isn't rising: max(hard, 4 x jitter) (ms). */
  hard: number;
}

export interface JitterDelayOptions {
  /** The base's window (default 30 s). */
  windowMs?: number;
  /** The median's window (default 5 s): long enough for several receiver reports. */
  smoothMs?: number;
  /** A round trip older than this is no signal (default 4 s). */
  freshMs?: number;
  marks?: DelayMarks;
  now?: () => number;
}

/**
 * A WebRTC viewer's delay signal, jitter-aware (see the top of this file). Over-use needs BOTH a queue above
 * max(cut, 2 x jitter) AND a median that rose by more than max(jitter, clear) over the last ~6 s (a queue building),
 * or a standing queue above max(hard, 4 x jitter). A jittery but steady path is "normal" or "underuse", never a cut.
 */
export class JitterDelay {
  private samples: { t: number; rtt: number }[] = [];
  private rtcpJitter: number | null = null;
  private rtcpJitterAt = 0;
  /** The last round trip, ms (null before any). */
  rtt: number | null = null;
  private lastT = 0;
  private windowMs: number;
  private smoothMs: number;
  private freshMs: number;
  marks: DelayMarks;
  private now: () => number;

  constructor(opts: JitterDelayOptions = {}) {
    this.windowMs = opts.windowMs ?? 30_000;
    this.smoothMs = opts.smoothMs ?? 5_000;
    this.freshMs = opts.freshMs ?? 4_000;
    this.marks = opts.marks ?? DELAY_MARKS.remote;
    this.now = opts.now ?? Date.now;
  }

  /** A round trip from a receiver report (ms). */
  add(rtt: number | null): void {
    if (rtt === null || !Number.isFinite(rtt) || rtt < 0 || rtt > 10_000) return;
    const t = this.now();
    this.samples.push({ t, rtt });
    this.rtt = rtt;
    this.lastT = t;
    while (this.samples.length && (t - this.samples[0]!.t > this.windowMs || this.samples.length > 600)) this.samples.shift();
  }

  /** The receiver's RTCP interarrival jitter (ms), smoothed. */
  addJitter(ms: number | null): void {
    if (ms === null || !Number.isFinite(ms) || ms < 0 || ms > 5_000) return;
    this.rtcpJitter = this.rtcpJitter === null ? ms : this.rtcpJitter + (ms - this.rtcpJitter) * 0.3;
    this.rtcpJitterAt = this.now();
  }

  private since(ms: number, upto = 0): number[] {
    const t = this.now();
    return this.samples.filter((s) => t - s.t <= ms && t - s.t > upto).map((s) => s.rtt);
  }

  /** The path's own round trip: a low percentile (the minimum on few samples), 0 before any. */
  base(): number {
    const all = this.samples.map((s) => s.rtt);
    if (!all.length) return 0;
    return all.length >= 8 ? percentile(all, 0.1)! : Math.min(...all);
  }

  /**
   * The measured jitter (ms): the receiver's RTCP interarrival jitter while it reports one (a queue that builds
   * steadily barely moves it, so it never hides the queue), else the round trips' mean change from one to the next
   * (RFC 3550's own estimator, on the round trips).
   */
  jitter(): number {
    if (this.rtcpJitter !== null && this.now() - this.rtcpJitterAt < this.windowMs) return this.rtcpJitter;
    if (this.samples.length < 5) return 0;
    let sum = 0;
    for (let i = 1; i < this.samples.length; i++) sum += Math.abs(this.samples[i]!.rtt - this.samples[i - 1]!.rtt);
    return sum / (this.samples.length - 1);
  }

  signal(): DelaySignal {
    const jitter = this.jitter();
    const threshold = Math.max(this.marks.cut, 2 * jitter);
    const hard = Math.max(this.marks.hard, 4 * jitter);
    const out: DelaySignal = { state: 'unknown', base: null, smoothed: null, queue: null, rise: null, jitter, threshold, hard };
    if (this.rtt === null || this.now() - this.lastT > this.freshMs) return out;
    // the median of the last smoothMs, and of at least 7 reports (one report a second is a noisy median otherwise)
    let recent = this.since(this.smoothMs);
    if (recent.length < 7) recent = this.samples.slice(-7).map((x) => x.rtt);
    if (!recent.length) return out;
    const base = this.base();
    const smoothed = percentile(recent, 0.5)!;
    const queue = Math.max(0, smoothed - base);
    const half = Math.max(2000, this.smoothMs * 0.6);
    const now3 = percentile(this.since(half), 0.5);
    const before3 = percentile(this.since(2 * half, half), 0.5);
    const rise = now3 !== null && before3 !== null ? now3 - before3 : null;
    out.base = base;
    out.smoothed = smoothed;
    out.queue = queue;
    out.rise = rise;
    const rising = rise !== null && rise > Math.max(jitter, this.marks.clear);
    if (queue > hard || (queue > threshold && rising)) out.state = 'overuse';
    else if (queue < Math.max(this.marks.clear, jitter) && (rise === null || rise <= Math.max(jitter / 2, this.marks.clear))) out.state = 'underuse';
    else out.state = 'normal';
    return out;
  }

  /** The latest queue (smoothed median beyond the base), or null without a fresh round trip. */
  queueMs(): number | null {
    return this.signal().queue;
  }

  stats() {
    const s = this.signal();
    const r = (v: number | null) => (v === null ? null : Math.round(v));
    return {
      rtt_ms: r(this.rtt),
      base_rtt_ms: this.samples.length ? Math.round(this.base()) : null,
      queue_ms: r(s.queue),
      jitter_ms: Math.round(s.jitter),
      threshold_ms: Math.round(s.threshold),
      rise_ms: r(s.rise),
      delay_state: s.state,
    };
  }
}

/** A viewer's link class: what it may degrade to, and how its picture is paced and buffered. */
export type LinkClassName = 'lan' | 'remote' | 'far';
export interface LinkClass {
  name: LinkClassName;
  /** The lowest bitrate the controller goes to (the picture gets smaller and fewer frames before this). */
  floorBps: number;
  /** The fewest frames a second its lane runs (fpsFor's floor). */
  floorFps: number;
  marks: DelayMarks;
}
/**
 * Per-link floors (2026-11-27): a LAN never needs to drop below 1 Mbit/s; a far link degrades further (its lane's
 * picture shrinks first, src/h264.ts scaleFor), so it keeps moving instead of freezing.
 */
export const LINK_CLASSES: Record<LinkClassName, LinkClass> = {
  lan: { name: 'lan', floorBps: 1_000_000, floorFps: 30, marks: DELAY_MARKS.lan },
  remote: { name: 'remote', floorBps: MIN_BPS, floorFps: 12, marks: DELAY_MARKS.remote },
  far: { name: 'far', floorBps: 300_000, floorFps: 10, marks: DELAY_MARKS.remote },
};
/** Over-use must hold this many ticks (seconds) in a row before a delay cut. */
export const OVERUSE_TICKS = 2;
/** A remote link is "far" (bigger playout delay, lower floor) when its base round trip or jitter is at least this. */
export const FAR_RTT_MS = 120;
export const FAR_JITTER_MS = 40;

/** The playout delay a far viewer is asked for (ms, the browser's jitter buffer): 1.5 x jitter, 60-500 ms. */
export function playoutFor(jitterMs: number): { min: number; max: number } {
  const min = Math.round(clamp(jitterMs * 1.5, 60, 500) / 10) * 10;
  return { min, max: Math.min(2000, Math.max(min * 3, 400)) };
}

export interface LinkTickInput {
  /** RTP packets sent since the last tick. */
  sent: number;
  /** Packets NACKed since the last tick. */
  nacked: number;
  /** The highest RTCP fraction lost since the last tick (null: no report). */
  reportLoss: number | null;
}
export interface LinkTick {
  changed: boolean;
  bps: number;
  loss: number;
  /** What moved it: "loss", "delay" (over-use), "up", or "hold". */
  why: 'loss' | 'delay' | 'up' | 'hold';
  signal: DelaySignal;
  /** Loss bad enough that a fresh keyframe should go now (rather than waiting for the browser's PLI). */
  keyNow: boolean;
}

/**
 * One WebRTC viewer's congestion loop, once a second: loss first (> 10 % -> bitrate x (1 - loss/2)), then the
 * jitter-aware delay signal (over-use -> x0.85, x0.6 over the hard mark, at most every DELAY_HOLD_MS), else a climb
 * while loss < 2 % and the delay says underuse (fast recovery back to the rate held before the last cuts).
 */
export class LinkControl {
  readonly rc: RateControl;
  readonly delay: JitterDelay;
  private remote: boolean;
  private now: () => number;
  private lastKeyNow = 0;
  private overuseRun = 0;
  /** Cuts so far, by what made them (for the stats). */
  cuts = { loss: 0, delay: 0 };
  last: LinkTick | null = null;

  /** `delay`: the session's own tracker (it hears receiver reports before the viewer is attached). */
  constructor(opts: { ceiling: number; start: number; remote: boolean; now?: () => number; delay?: JitterDelay }) {
    this.remote = opts.remote;
    this.now = opts.now ?? Date.now;
    const cls = LINK_CLASSES[opts.remote ? 'remote' : 'lan'];
    // a remote viewer may go down to a far link's floor (its picture shrinks on the way); a LAN one to the LAN's
    const floor = Math.min(opts.ceiling, opts.remote ? LINK_CLASSES.far.floorBps : cls.floorBps);
    this.rc = new RateControl(opts.ceiling, opts.start, Math.max(1, floor), this.now, { recover: 1.4 });
    this.delay = opts.delay ?? new JitterDelay({ marks: cls.marks, now: this.now });
  }

  /** lan, remote or far (a remote link with a long or jittery path). */
  linkClass(): LinkClass {
    if (!this.remote) return LINK_CLASSES.lan;
    const base = this.delay.base();
    return base >= FAR_RTT_MS || this.delay.jitter() >= FAR_JITTER_MS ? LINK_CLASSES.far : LINK_CLASSES.remote;
  }

  /** The playout delay to ask the browser for (ms), or null to leave its own (LAN, a near remote). */
  playout(): { min: number; max: number } | null {
    return this.linkClass().name === 'far' ? playoutFor(this.delay.jitter()) : null;
  }

  tick(i: LinkTickInput): LinkTick {
    const byNack = i.sent > 0 ? Math.min(1, i.nacked / i.sent) : 0;
    const loss = Math.max(byNack, i.reportLoss ?? 0);
    const signal = this.delay.signal();
    let changed = false;
    let why: LinkTick['why'] = 'hold';
    let keyNow = false;
    if (i.sent >= 10 && loss > 0.1) {
      changed = this.rc.down(Math.max(0.5, 1 - loss / 2), null, 900);
      if (changed) {
        why = 'loss';
        this.cuts.loss++;
      }
      const t = this.now();
      if (loss > 0.2 && t - this.lastKeyNow > 3000) {
        this.lastKeyNow = t;
        keyNow = true;
      }
    } else if (signal.state === 'overuse' && ++this.overuseRun >= OVERUSE_TICKS) {
      // over-use that held OVERUSE_TICKS seconds (GCC's over-use time threshold): one noisy median is no queue
      changed = this.rc.down(signal.queue !== null && signal.queue > signal.hard ? 0.6 : 0.85, null, DELAY_HOLD_MS);
      if (changed) {
        why = 'delay';
        this.cuts.delay++;
      }
    } else if (loss < 0.02 && (signal.state === 'underuse' || signal.state === 'unknown')) {
      changed = this.rc.up();
      if (changed) why = 'up';
    }
    if (signal.state !== 'overuse') this.overuseRun = 0;
    const out: LinkTick = { changed, bps: this.rc.bps, loss, why, signal, keyNow };
    this.last = out;
    return out;
  }
}

/** What a gap in a viewer's picture is put down to. "still" isn't a freeze: the capture runs, the screen didn't change. */
export type FreezeCause = 'src' | 'encoder' | 'network' | 'client';
/** A gap with no frame for the viewer this long counts (Chrome's freezeCount: over 3 frame intervals and +150 ms). */
export const FREEZE_GAP_MS = 700;

/** The numbers FreezeTracker reads at each frame and when a gap ends. */
export interface FreezeProbe {
  /** The capture's state (src/h264.ts CaptureState). */
  state: string;
  /** Video frames the source got from the encoder (repeats not counted). */
  srcFrames: number;
  /** Frames the capture device handed the helper (its heartbeats; null: a helper without them). */
  devFrames: number | null;
  /** Frames dropped for this viewer (its link was backed up). */
  dropped: number;
  /** The link's loss over the last second (0-1). */
  loss: number;
}
export interface FreezeEvent {
  at: number;
  ms: number;
  cause: FreezeCause | 'still';
  detail: string;
}

/**
 * Labels each gap in a viewer's picture (2026-11-27, docs/root-cause.md 5.3). A gap opens when no frame went to the
 * viewer for FREEZE_GAP_MS and closes with the next frame (or is reported while it runs):
 * - src: the capture wasn't Live or Still (finding, starting, stale, restarting, gave up, waiting for an unlock);
 * - network: frames existed but were dropped for this viewer's link;
 * - encoder: the device handed frames over (heartbeat) but the encoder gave none;
 * - still: the capture ran (heartbeat) and the screen didn't change: not a freeze;
 * - client: the client reported a freeze (or asked for a keyframe) while frames reached it, on a clean link
 *   (a lossy one: network).
 */
export class FreezeTracker {
  private lastSent = 0;
  private atLast: FreezeProbe | null = null;
  private states = new Set<string>();
  readonly events: FreezeEvent[] = [];
  readonly counts: Record<FreezeCause | 'still', number> = { src: 0, encoder: 0, network: 0, client: 0, still: 0 };
  totalMs = 0;
  constructor(private probe: () => FreezeProbe, private now: () => number = Date.now, private gapMs = FREEZE_GAP_MS) {}

  /** A frame went to the viewer. */
  sent(): void {
    const t = this.now();
    if (this.lastSent && t - this.lastSent >= this.gapMs) this.close(t);
    this.lastSent = t;
    this.states.clear();
    this.atLast = this.probe();
  }

  /** Once a second: notes the capture's state since the last frame (what a gap is put down to). */
  tick(): void {
    if (this.lastSent) this.states.add(this.probe().state);
  }

  /** The gap running now, labelled as it stands (null: frames are flowing). */
  ongoing(): FreezeEvent | null {
    const t = this.now();
    if (!this.lastSent || t - this.lastSent < this.gapMs) return null;
    return { at: this.lastSent, ms: t - this.lastSent, ...this.classify() };
  }

  /** The client saw its picture freeze (its own report, or a keyframe ask while frames flowed). */
  client(ms: number | null, why = 'the client reported a freeze'): FreezeEvent | null {
    const t = this.now();
    if (this.lastSent && t - this.lastSent >= this.gapMs) return null; // a gap on our side: labelled when it ends
    const p = this.probe();
    const cause: FreezeCause = p.loss > 0.05 ? 'network' : 'client';
    return this.push({ at: t, ms: ms ?? 0, cause, detail: cause === 'network' ? `${why} on a lossy link (${Math.round(p.loss * 100)} % lost)` : `${why} while frames reached it` });
  }

  private classify(): { cause: FreezeCause | 'still'; detail: string } {
    const a = this.atLast;
    const b = this.probe();
    const states = new Set([...this.states, b.state]);
    const bad = [...states].filter((s) => s !== 'Live' && s !== 'Still');
    if (bad.length) return { cause: 'src', detail: `the capture was ${bad.join(', ')}` };
    // (the frame that ends a gap is counted by the source before it reaches the viewer: one is allowed for, and a
    // device frame or two around it)
    if (a && b.dropped > a.dropped) return { cause: 'network', detail: `${b.dropped - a.dropped} frames dropped for this link` };
    if (a && b.srcFrames > a.srcFrames + 1) return { cause: 'network', detail: 'frames were made but none reached this viewer' };
    if (a && a.devFrames !== null && b.devFrames !== null) {
      if (b.devFrames > a.devFrames + 2) return { cause: 'encoder', detail: `${b.devFrames - a.devFrames} frames reached the helper but no picture came out of the encoder` };
      return { cause: 'still', detail: 'the capture ran and the screen did not change' };
    }
    return { cause: 'still', detail: 'no new frames (a still screen, unconfirmed: the helper sends no heartbeat)' };
  }

  private close(t: number): void {
    this.push({ at: this.lastSent, ms: t - this.lastSent, ...this.classify() });
  }

  /** Whose picture this is (a phone's udid), for the trace journal. */
  udid?: string;

  private push(e: FreezeEvent): FreezeEvent {
    if (e.cause !== 'still') trace('freeze', { udid: this.udid, cause: e.cause, ms: Math.round(e.ms), why: e.detail });
    this.events.push(e);
    if (this.events.length > 50) this.events.shift();
    this.counts[e.cause]++;
    if (e.cause !== 'still') this.totalMs += e.ms;
    return e;
  }

  /** For the stats: freezes (stills apart) by cause, their total time, the last few and the one running now. */
  stats() {
    const { still, ...by } = this.counts;
    return { count: by.src + by.encoder + by.network + by.client, by_cause: by, still_gaps: still, total_ms: Math.round(this.totalMs), ongoing: this.ongoing(), last: this.events.slice(-5) };
  }
}
