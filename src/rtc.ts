import type NdcModule from 'node-datachannel';
import { bitrateAsk, DEFAULT_CEILING_BPS, parseRtcp, RateControl, REMOTE_START_BPS } from './congestion.js';
import type { Control } from './control.js';
import { H264Settings, H264Source, H264Viewer, KIND, Rec, Transport } from './h264.js';
import { Backend, HttpError } from './types.js';

/**
 * WebRTC live view (node-datachannel / libdatachannel). Signaling rides the control WebSocket:
 *   client -> {type:"rtc-offer", sdp, want:{fps, scale, quality?}}   server -> {type:"rtc-answer", sdp}
 *   both ways {type:"rtc-ice", candidate, mid}; server -> {type:"rtc-hello", ...} once frames flow,
 *   or {type:"rtc-error", reason} (the client falls back to the H.264 WebSocket / MJPEG).
 * Host candidates only (no STUN/TURN): the path is always direct (LAN or Tailscale), never relayed.
 */
type Ndc = typeof NdcModule;
type PeerConnection = InstanceType<Ndc['PeerConnection']>;
type Track = ReturnType<PeerConnection['addTrack']>;
type DataChannel = ReturnType<PeerConnection['createDataChannel']>;
type RtpConfig = InstanceType<Ndc['RtpPacketizationConfig']>;

const PLAYOUT_DELAY_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';

let lib: Ndc | null | undefined;
let libError = '';

/** node-datachannel is loaded lazily, so the server still runs (WebSocket/MJPEG only) where it can't load. */
export async function loadRtc(): Promise<Ndc | null> {
  if (lib !== undefined) return lib;
  try {
    const m = (await import('node-datachannel')) as unknown as { default?: Ndc } & Ndc;
    lib = m.default ?? m;
  } catch (err) {
    lib = null;
    libError = (err as Error).message.split('\n')[0]!.slice(0, 200);
    console.error(`[rtc] node-datachannel unavailable: ${libError}`);
  }
  return lib;
}

/** Free libdatachannel's threads (call on shutdown so the process can exit). */
export function rtcCleanup(): void {
  try {
    lib?.cleanup();
  } catch {
    /* ignore */
  }
}

export interface OfferVideo {
  mid: string;
  pt: number;
  fmtp: string;
  playoutDelayId: number | null;
}

/** The first video m-section of an offer: its mid, the best H.264 payload type (packetization-mode=1), playout-delay id. */
export function parseOffer(sdp: string): OfferVideo {
  const sections = sdp.split(/\r?\n(?=m=)/);
  const video = sections.find((s) => s.startsWith('m=video'));
  if (!video) throw new Error('the offer has no video section');
  const lines = video.split(/\r?\n/);
  const mid = lines.find((l) => l.startsWith('a=mid:'))?.slice(6).trim() ?? '0';
  const h264: number[] = [];
  const fmtp = new Map<number, string>();
  let playoutDelayId: number | null = null;
  for (const l of lines) {
    let m = /^a=rtpmap:(\d+) H264\/90000/i.exec(l);
    if (m) h264.push(Number(m[1]));
    m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (m) fmtp.set(Number(m[1]), m[2]!.trim());
    m = /^a=extmap:(\d+)(?:\/\w+)? (\S+)/.exec(l);
    if (m && m[2] === PLAYOUT_DELAY_URI) playoutDelayId = Number(m[1]);
  }
  const pm1 = h264.filter((pt) => /packetization-mode=1/.test(fmtp.get(pt) ?? ''));
  const prof = (pt: number) => /profile-level-id=([0-9a-f]{6})/i.exec(fmtp.get(pt) ?? '')?.[1]?.toLowerCase() ?? '';
  const pt = pm1.find((p) => prof(p).startsWith('42e0')) ?? pm1.find((p) => prof(p).startsWith('4200')) ?? pm1[0];
  if (pt === undefined) throw new Error('the offer has no H.264 (packetization-mode=1) codec');
  return { mid, pt, fmtp: fmtp.get(pt) ?? '', playoutDelayId };
}

/** True if a (compound) RTCP packet holds a PLI or FIR, i.e. the receiver wants a keyframe. */
export function rtcpWantsKey(buf: Buffer): boolean {
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf[off]! >> 6 !== 2) return false;
    const fmt = buf[off]! & 0x1f;
    const pt = buf[off + 1]!;
    if (pt === 206 && (fmt === 1 || fmt === 4)) return true;
    off += (buf.readUInt16BE(off + 2) + 1) * 4;
  }
  return false;
}

function isTailscale(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0');
}
function isPrivate(ip: string): boolean {
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^f[cde]/i.test(ip);
}

/** "lan", "tailscale", "loopback" or "direct" (a public address, still peer to peer) for the peer's address. */
export function pathKind(remoteAddress: string): string {
  const a = remoteAddress.replace(/^::ffff:/, '');
  return /^127\.|^::1$/.test(a) ? 'loopback' : isTailscale(a) ? 'tailscale' : isPrivate(a) ? 'lan' : 'direct';
}

/** True for a client that isn't on the Mac's LAN (Tailscale or the Internet): it starts at a lower bitrate. */
export function isRemote(remoteAddress: string): boolean {
  if (!remoteAddress) return false;
  const k = pathKind(remoteAddress);
  return k === 'tailscale' || k === 'direct';
}

const wantNum = (v: unknown, dflt: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : dflt;

/**
 * The H.264 settings a client asked for (`want` of rtc-offer); `bitrate` (or `kbps`) in kbit/s; `full: true` keeps a
 * far viewer's ask exactly (no far caps, src/lanes.ts).
 */
export function rtcWant(want: unknown): { fps: number; scale: number; quality: number | null; bitrate: number | null; full: boolean } {
  const w = (want && typeof want === 'object' ? want : {}) as Record<string, unknown>;
  return {
    fps: wantNum(w.fps, 60, 1, 60),
    scale: wantNum(w.scale, 100, 10, 100),
    quality: typeof w.quality === 'number' && Number.isFinite(w.quality) ? wantNum(w.quality, 50, 1, 100) : null,
    bitrate: bitrateAsk(w.bitrate ?? w.kbps),
    full: w.full === true || w.full === 1,
  };
}

/**
 * A far viewer's send pace (bit/s): keyframe bursts spread over tens of ms instead of leaving in one go, which a long
 * path's router queues drop. Fixed per session (libdatachannel's PacingHandler); well above the encoder's target.
 */
export function paceFor(ceilingBps: number): number {
  return Math.round(Math.min(8_000_000, Math.max(3_000_000, ceilingBps * 1.5)));
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One WebRTC session for one control WebSocket: a sendonly H.264 track plus the "input"/"input-r" channels. */
export class RtcSession {
  private pc?: PeerConnection;
  private track?: Track;
  private rtp?: RtpConfig;
  private src?: H264Source;
  private viewer?: H264Viewer;
  private trackOpen = false;
  private ready = false;
  private closed = false;
  private pendingIce: [string, string][] = [];
  private pendingConfig?: Buffer;
  private tsBase = (Math.random() * 0xffffffff) >>> 0;
  private t0 = 0;
  private lastTs = -1;
  private path: string | null = null;
  private pendingMove?: Record<string, unknown>;
  private moveScheduled = false;
  private lastMoveT = -1;
  private inputR?: DataChannel;
  private lastTsMsg = 0;
  // congestion control (libdatachannel has none): the browser's loss reports and NACKs set the bitrate
  private rc?: RateControl;
  private ccTimer?: NodeJS.Timeout;
  private packets = 0; // RTP packets sent since the last tick (estimated from the frame sizes)
  private nacked = 0; // packets the browser asked again since the last tick
  private reportLoss: number | null = null; // the highest fraction lost in its receiver reports since the last tick
  private lastKeyAsk = 0;
  private want?: { bitrate: number | null };

  constructor(
    private backend: Backend,
    private control: Control,
    private udid: string,
    private signal: (msg: Record<string, unknown>) => void,
    private remote = false,
  ) {}

  async start(sdp: string, wantRaw: unknown): Promise<void> {
    const ndc = await loadRtc();
    if (this.closed) return;
    if (!ndc) throw new Error(`WebRTC is unavailable on this server (${libError})`);
    const offer = parseOffer(sdp);
    const want = { ...rtcWant(wantRaw), remote: this.remote };
    this.want = want;
    const src = this.backend.h264(this.udid, want);
    if (typeof src === 'string') throw new Error(src);
    this.src = src;

    const pc = new ndc.PeerConnection(`phone-${this.udid.slice(-8)}`, { iceServers: [] }); // host candidates only
    this.pc = pc;
    // handlers first: libdatachannel may emit as soon as the description is set
    pc.onLocalDescription((answer, type) => {
      if (!this.closed) this.signal({ type: 'rtc-answer', sdp: answer, sdpType: type, server_time: Date.now() });
    });
    pc.onLocalCandidate((cand, mid) => {
      if (!this.closed) this.signal({ type: 'rtc-ice', candidate: cand.replace(/^a=/, ''), mid });
    });
    pc.onStateChange((state) => {
      if (state === 'connected') {
        const pair = pc.getSelectedCandidatePair();
        this.path = pair ? pathKind(pair.remote.address) : null; // the remote may be prflx (mDNS-hidden client)
      }
      if (state === 'failed' || state === 'closed') this.close(`peer connection ${state}`);
    });
    pc.onDataChannel((dc) => this.channel(dc));

    const ssrc = (Math.random() * 0x7fffffff) >>> 0 || 1;
    const video = new ndc.Video(offer.mid, 'SendOnly');
    video.addH264Codec(offer.pt, 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1');
    video.addSSRC(ssrc, 'phone', 'lotus-phone', 'screen');
    if (offer.playoutDelayId !== null) video.parseSdpLine(`a=extmap:${offer.playoutDelayId} ${PLAYOUT_DELAY_URI}`);
    const track = pc.addTrack(video);
    this.track = track;
    const rtp = new ndc.RtpPacketizationConfig(ssrc, 'phone', offer.pt, 90000);
    if (offer.playoutDelayId !== null) {
      // ask the browser to render frames as soon as they're decoded (no jitter buffer delay)
      rtp.playoutDelayId = offer.playoutDelayId;
      rtp.playoutDelayMin = 0;
      rtp.playoutDelayMax = 0;
    }
    this.rtp = rtp;
    const packetizer = new ndc.H264RtpPacketizer('StartSequence', rtp, 1200);
    packetizer.addToChain(new ndc.RtcpSrReporter(rtp));
    packetizer.addToChain(new ndc.RtcpNackResponder(512));
    if (this.remote && process.env.RTC_PACING !== '0' && typeof ndc.PacingHandler === 'function') {
      // a far viewer: packets paced (5 ms slots) rather than a keyframe's ~50 packets at once
      try {
        packetizer.addToChain(new ndc.PacingHandler(paceFor(want.bitrate ?? (src.ceiling || DEFAULT_CEILING_BPS)), 5));
      } catch (err) {
        console.error(`[rtc] pacing unavailable: ${errText(err)}`);
      }
    }
    track.setMediaHandler(packetizer);
    track.onMessage((m) => this.rtcp(m));
    track.onOpen(() => {
      this.trackOpen = true;
      this.attach();
    });
    track.onClosed(() => this.close('track closed'));

    pc.setRemoteDescription(sdp, 'offer');
    for (const [c, mid] of this.pendingIce) this.addIce(c, mid);
    this.pendingIce = [];

    src.open().then(
      (info) => {
        if (this.closed) return;
        this.ready = true;
        this.signal({ type: 'rtc-hello', codec: 'h264', width: info.width, height: info.height, fps: info.fps, scale: info.scale, lane: src.kind, server_time: Date.now() });
        this.attach();
      },
      (err) => this.fail(errText(err)),
    );
  }

  addIce(candidate: unknown, mid: unknown): void {
    if (typeof candidate !== 'string' || !candidate.trim()) return; // end-of-candidates
    const c = candidate.trim().replace(/^a=/, '');
    const m = typeof mid === 'string' ? mid : mid === undefined || mid === null ? '0' : String(mid);
    if (!this.pc) {
      this.pendingIce.push([c, m]);
      return;
    }
    try {
      this.pc.addRemoteCandidate(c, m);
    } catch (err) {
      console.error(`[rtc] bad remote candidate: ${errText(err)}`);
    }
  }

  private attach(): void {
    if (this.viewer || !this.ready || !this.trackOpen || !this.src || this.closed) return;
    const self = this;
    const transport: Transport = {
      kind: 'rtc',
      // not every node-datachannel build has Track.bufferedAmount; RTP over UDP doesn't queue much anyway
      buffered: () => (typeof self.track?.bufferedAmount === 'function' ? self.track.bufferedAmount() : 0),
      open: () => !self.closed && !!self.track?.isOpen(),
      send: (r: Rec) => self.sendFrame(r),
      fail: (reason: string) => self.fail(reason),
      path: () => self.path,
    };
    this.viewer = new H264Viewer(transport, this.src);
    // a far viewer starts low and climbs to its ask (its lane's frame rate follows the bitrate)
    const ceiling = this.want?.bitrate ?? (this.src.ceiling || DEFAULT_CEILING_BPS);
    this.rc = new RateControl(ceiling, this.remote ? Math.min(ceiling, REMOTE_START_BPS) : ceiling);
    this.src.setTarget(this.viewer, this.rc.bps);
    this.src.add(this.viewer);
    this.ccTimer = setInterval(() => this.ccTick(), 1000);
  }

  /** RTCP from the browser: keyframe asks (at most one per 500 ms: a lossy link sends many), loss and NACKs. */
  private rtcp(m: Buffer): void {
    let info;
    try {
      info = parseRtcp(m);
    } catch {
      return;
    }
    if (info.wantsKey) {
      const now = Date.now();
      if (now - this.lastKeyAsk >= 500) {
        this.lastKeyAsk = now;
        this.viewer?.forceKey();
      }
    }
    this.nacked += info.nacked;
    if (info.fractionLost !== null) this.reportLoss = Math.max(this.reportLoss ?? 0, info.fractionLost);
  }

  /**
   * Once a second, loss-based like WebRTC's own (GCC): more than 10 % lost -> bitrate x (1 - loss/2); under 2 % -> up
   * slowly; between: hold. (REMB isn't used: a browser's receive-side estimate starts low and ramps.)
   */
  private ccTick(): void {
    if (!this.rc || !this.viewer || !this.src || this.closed) return;
    const byNack = this.packets > 0 ? Math.min(1, this.nacked / this.packets) : 0;
    const loss = Math.max(byNack, this.reportLoss ?? 0);
    const sent = this.packets;
    this.packets = this.nacked = 0;
    this.reportLoss = null;
    let changed = false;
    if (sent >= 10 && loss > 0.1) changed = this.rc.down(Math.max(0.5, 1 - loss / 2), null, 900);
    else if (loss < 0.02) changed = this.rc.up();
    if (changed) this.src.setTarget(this.viewer, this.rc.bps);
  }

  /** Config is held and sent with the next keyframe as one access unit (same RTP timestamp, marker on the last NAL). */
  private sendFrame(r: Rec): void {
    if (!this.track || !this.rtp) return;
    if (r.kind === KIND.CONFIG) {
      this.pendingConfig = r.payload;
      return;
    }
    let data = r.payload;
    if (r.kind === KIND.KEY && this.pendingConfig) {
      data = Buffer.concat([this.pendingConfig, r.payload]);
      this.pendingConfig = undefined;
    }
    if (!this.t0) this.t0 = r.time;
    // 90 kHz RTP clock from the capture time; never backwards (a re-sent cached keyframe is older)
    let ts = Math.round((r.time - this.t0) * 90);
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    this.rtp.timestamp = (this.tsBase + ts) >>> 0;
    this.packets += Math.ceil(data.length / 1188);
    try {
      this.track.sendMessageBinary(data);
    } catch (err) {
      this.close(`send failed: ${errText(err)}`);
      return;
    }
    // about once a second: which RTP timestamp is which capture time (ms since the epoch, server clock),
    // so the client can measure glass-to-glass latency with the ping/pong clock offset
    const now = Date.now();
    if (now - this.lastTsMsg >= 1000 && this.inputR?.isOpen()) {
      this.lastTsMsg = now;
      try {
        this.inputR.sendMessage(JSON.stringify({ type: 'ts', rtp: this.rtp.timestamp, capture_time: r.time }));
      } catch {
        /* closed */
      }
    }
  }

  // ---- input data channels ----
  private channel(dc: DataChannel): void {
    const label = dc.getLabel();
    if (label !== 'input' && label !== 'input-r') return;
    if (label === 'input-r') this.inputR = dc;
    const reply = (msg: unknown) => {
      try {
        if (dc.isOpen()) dc.sendMessage(JSON.stringify(msg));
      } catch {
        /* closed */
      }
    };
    dc.onMessage((data) => {
      let msg: Record<string, unknown>;
      try {
        const v = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        msg = v;
      } catch {
        return reply({ type: 'ack', id: null, ok: false, error: 'message must be a JSON object' });
      }
      if (msg.type === 'ping') return reply({ type: 'pong', t: msg.t ?? null, server_time: Date.now() });
      if (msg.type === 'touch' && msg.phase === 'move' && msg.id === undefined) return this.move(msg);
      if (msg.type === 'touch' && msg.phase === 'down') this.lastMoveT = -1;
      this.flushMove(); // a down/up after moves keeps their order
      const id = msg.id ?? null;
      this.control.handle(this.udid, msg, this).then(
        () => {
          if (id !== null) reply({ type: 'ack', id, ok: true });
        },
        (err) => reply({ type: 'ack', id, ok: false, error: err instanceof HttpError ? err.message : 'internal error' }),
      );
    });
  }

  /** Moves (unordered, unreliable channel): late ones are dropped, a burst is coalesced to the latest point. */
  private move(msg: Record<string, unknown>): void {
    const t = typeof msg.t === 'number' ? msg.t : null;
    if (t !== null && t < this.lastMoveT) return; // arrived out of order
    if (t !== null) this.lastMoveT = t;
    this.pendingMove = msg;
    if (this.moveScheduled) return;
    this.moveScheduled = true;
    setImmediate(() => this.flushMove());
  }

  private flushMove(): void {
    this.moveScheduled = false;
    const m = this.pendingMove;
    this.pendingMove = undefined;
    if (m) this.control.handle(this.udid, m, this).catch(() => {});
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.signal({ type: 'rtc-error', reason });
    this.close(reason);
  }

  close(_why = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ccTimer) clearInterval(this.ccTimer);
    if (this.viewer) this.src?.remove(this.viewer);
    this.viewer = undefined;
    this.control.release(this);
    try {
      this.track?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Handles the rtc-* messages of one control socket. Returns true if the message was a signaling message. */
export function rtcSignaling(backend: Backend, control: Control, udid: string, send: (m: Record<string, unknown>) => void, remote = false) {
  let session: RtcSession | undefined;
  return {
    handle(msg: Record<string, unknown>): boolean {
      switch (msg.type) {
        case 'rtc-offer': {
          session?.close('replaced by a new offer');
          if (typeof msg.sdp !== 'string' || !msg.sdp) {
            send({ type: 'rtc-error', reason: '"sdp" must be a string' });
            return true;
          }
          const s = new RtcSession(backend, control, udid, send, remote);
          session = s;
          s.start(msg.sdp, msg.want).catch((err) => {
            send({ type: 'rtc-error', reason: errText(err) });
            s.close();
            if (session === s) session = undefined;
          });
          return true;
        }
        case 'rtc-ice':
          session?.addIce(msg.candidate, msg.mid);
          return true;
        case 'rtc-close':
          session?.close('closed by the client');
          session = undefined;
          return true;
        default:
          return false;
      }
    },
    close() {
      session?.close('control socket closed');
      session = undefined;
    },
  };
}

export type { H264Settings };
