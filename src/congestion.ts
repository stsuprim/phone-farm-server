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
 * - DelayTracker: WebRTC viewers' queue, the round trip beyond the quickest of the last 30 s. A queue in front of a far
 *   viewer (a router's buffer filling before it drops anything) is cut on before any loss shows (delay-based, like
 *   GCC), so seconds of video and acks never wait in the network.
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

/** One viewer's target bitrate: multiplicative decrease on congestion, +8 % a second after 2 clean seconds. */
export class RateControl {
  bps: number;
  readonly max: number;
  private lastDown = -Infinity;
  private lastUp: number;
  constructor(max: number, start: number, private min = MIN_BPS, private now: () => number = Date.now) {
    this.max = Math.max(min, max);
    this.bps = Math.round(clamp(start, min, this.max));
    this.lastUp = now();
  }

  /**
   * Congestion: down to `factor` of now, or to 90 % of the rate the link delivered when that's lower (never below
   * half at once). At most once per `holdMs` (a cut needs a round trip to show). True if the target changed.
   */
  down(factor: number, delivered?: number | null, holdMs = 800): boolean {
    const t = this.now();
    if (t - this.lastDown < holdMs) return false;
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
    this.bps = Math.round(Math.min(this.max, this.bps * 1.08));
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
}

/** NTP's middle 32 bits (RTCP's LSR units: 1/65536 s) of a Date.now() time. */
export function ntpMid32(ms: number): number {
  return Math.floor((ms / 1000 + 2_208_988_800) * 65536) % 0x1_0000_0000;
}

/** Reads a (compound) RTCP packet from the receiver; `nowMs` is when it arrived (for the round trip). */
export function parseRtcp(buf: Buffer, nowMs: number = Date.now()): RtcpInfo {
  const info: RtcpInfo = { fractionLost: null, rttMs: null, nacked: 0, remb: null, wantsKey: false };
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
