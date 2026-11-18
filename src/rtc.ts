import type NdcModule from 'node-datachannel';
import { AudioFeed, AudioFrame, audioPlan, AudioRtpClock, parseOfferAudio } from './audio.js';
import { bitrateAsk, DEFAULT_CEILING_BPS, DelayTracker, parseRtcp, RateControl, REMOTE_START_BPS } from './congestion.js';
import { Control, touchAck } from './control.js';
import { H264Info, H264Settings, H264Source, H264Viewer, KIND, Rec, REMOTE_DROP_BYTES, Transport } from './h264.js';
import { THUMB_DEFAULT_FPS } from './lanes.js';
import { Backend, HttpError, Profile, QualityTier } from './types.js';

/**
 * WebRTC live view (node-datachannel / libdatachannel). Signaling rides the control WebSocket:
 *   client -> {type:"rtc-offer", sdp, want:{fps, scale, quality?}}   server -> {type:"rtc-answer", sdp}
 *   (every offer is a new session. An ICE restart of a running one isn't possible here: libdatachannel's libjuice
 *   refuses a second ICE generation, "Invalid ICE settings from remote SDP"; tried 2026-11-16. A client whose link
 *   drops waits a few seconds for ICE to come back by itself, then sends a new offer.)
 *   both ways {type:"rtc-ice", candidate, mid}; server -> {type:"rtc-hello", ...} once frames flow,
 *   client -> {type:"rtc-key"} (a keyframe now: its picture stalled), {type:"rtc-close"},
 *   or {type:"rtc-error", reason} (the client falls back to the H.264 WebSocket / MJPEG).
 * Host candidates only (no STUN/TURN): the path is always direct (LAN or Tailscale), never relayed.
 * The phone's sound (2026-11-16, src/audio.ts): an offer with an audio m-section (recvonly, Opus) gets a sendonly track
 * on it when the phone's sound can come (else that section is answered inactive): its own SSRC and RTP clock, the same
 * stream id as the picture (so the browser keeps them in step from the RTCP sender reports; AUDIO_SYNC=0 puts it in a
 * stream of its own, never waiting on the picture). rtc-hello says `audio` (true/false) and `audio_reason`;
 * {type:"rtc-audio", audio, reason} follows when that changes. A sound that fails is dropped alone; the picture goes on.
 */
type Ndc = typeof NdcModule;
type PeerConnection = InstanceType<Ndc['PeerConnection']>;
type Track = ReturnType<PeerConnection['addTrack']>;
type DataChannel = ReturnType<PeerConnection['createDataChannel']>;
type RtpConfig = InstanceType<Ndc['RtpPacketizationConfig']>;

/** A frame whose capture time is this far from now when it's sent (a cached keyframe) is stamped as just captured. */
export const STALE_FRAME_MS = 500;

/**
 * A WebRTC keyframe's access unit: SPS and PPS in front of EVERY IDR (one RTP timestamp, the marker on the last NAL).
 * 2026-11-16, the freeze (frames arriving, none shown, PLI after PLI): only a session's first keyframe carried them
 * (the WebSocket viewers need them once), so the next IDR came bare. Chromium's hardware decoder for WebRTC reads the
 * picture's size from each keyframe's SPS; a bare IDR fails it ("Failed parsing stream to get resolution"), WebRTC
 * falls back to its software decoder, and that one, new, never saw an SPS or PPS: nothing decodes again, whatever
 * keyframes its PLIs bring. libwebrtc's own senders do the same (sps-pps-idr-in-keyframe).
 */
export function keyUnit(config: Buffer | undefined, key: Buffer): Buffer {
  return config?.length ? Buffer.concat([config, key]) : key;
}

/** True if an Annex B access unit holds an SPS, a PPS and an IDR slice, in that order (tests). */
export function hasParameterSets(unit: Buffer): boolean {
  let need = 7; // 7 SPS -> 8 PPS -> 5 IDR
  for (let i = 0; i + 3 < unit.length; i++) {
    if (unit[i] !== 0 || unit[i + 1] !== 0 || unit[i + 2] !== 1) continue;
    const type = unit[i + 3]! & 0x1f;
    if (type === need) {
      if (need === 5) return true;
      need = need === 7 ? 8 : 5;
    }
    i += 2;
  }
  return false;
}

/**
 * The 90 kHz RTP clock of one session, from the frames' capture times: never backwards, and never far from the send
 * time. A frame whose capture time is over STALE_FRAME_MS from now (the cached keyframe a new viewer is primed with,
 * up to REMOTE_KEY_SECONDS old on a far lane; a stepped clock) is stamped as just captured: stamped with its real
 * age, the next frame's timestamp would jump seconds ahead of its arrival and throw the browser's playout timing.
 */
export class RtpClock {
  private t0 = 0;
  private last = -1;
  /** Capture -> sent of the frames flowing (ms, smoothed); null before any. */
  lag: number | null = null;

  /** The timestamp (90 kHz ticks since the first frame) for a frame captured at `captured`, sent at `now` (ms). */
  stamp(captured: number, now: number): { ts: number; stale: boolean } {
    const age = now - captured;
    const stale = !Number.isFinite(age) || Math.abs(age) > STALE_FRAME_MS;
    const time = stale ? now - (this.lag ?? 0) : captured;
    if (!stale) this.lag = this.lag === null ? age : this.lag + (age - this.lag) * 0.1;
    if (!this.t0) this.t0 = time;
    let ts = Math.round((time - this.t0) * 90);
    if (ts <= this.last) ts = this.last + 1;
    this.last = ts;
    return { ts, stale };
  }
}

/**
 * What waits in a far viewer's pacer (libdatachannel's PacingHandler has no bound and says nothing): the bytes handed
 * to it less what its pace has let out since. The viewer counts it as its send buffer, so frames are skipped until the
 * next keyframe (H264Viewer.over) rather than the picture falling seconds behind.
 */
export class PaceQueue {
  private bytes = 0;
  private at = 0;
  constructor(private bps: number) {}

  private drain(now: number): void {
    if (this.at) this.bytes = Math.max(0, this.bytes - ((now - this.at) * this.bps) / 8000);
    this.at = now;
  }
  add(n: number, now = Date.now()): void {
    this.drain(now);
    this.bytes += n;
  }
  waiting(now = Date.now()): number {
    this.drain(now);
    return Math.round(this.bytes);
  }
  /** How long what waits takes to leave (ms). */
  waitingMs(now = Date.now()): number {
    return (this.waiting(now) * 8000) / this.bps;
  }
}

/**
 * How long after a keyframe was sent an ask for one (PLI, FIR, rtc-key) is taken to have crossed it: the round trip
 * (the ask left before the keyframe arrived) plus what the pacer still holds, and a little. At most 2 s.
 */
export function keyInFlightMs(rttMs: number | null, pacedMs: number): number {
  return Math.min(2000, (rttMs ?? 0) + pacedMs + 50);
}

const PLAYOUT_DELAY_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';

/**
 * Delay-based congestion control (the round trip from RTCP beyond the path's own): a queue over `cut` ms lowers the
 * bitrate (x0.85, x0.6 over `hard`), and the bitrate only climbs while it stays under `clear`. A far link (Tailscale
 * across countries) has a long, jittery path, so its marks are higher than the LAN's.
 */
export const DELAY_MARKS = {
  remote: { cut: 150, hard: 500, clear: 50 },
  lan: { cut: 80, hard: 300, clear: 25 },
};
/** After a delay cut, the next waits this long: the queue needs a round trip or two to drain. */
export const DELAY_HOLD_MS = 2000;

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
export function rtcWant(want: unknown): {
  fps: number; scale: number; quality: number | null; bitrate: number | null; full: boolean; tier: QualityTier; profile: Profile | null;
} {
  const w = (want && typeof want === 'object' ? want : {}) as Record<string, unknown>;
  const tier: QualityTier = w.quality === 'thumb' || w.tier === 'thumb' ? 'thumb' : 'full';
  return {
    tier,
    profile: w.profile === 'lan' || w.profile === 'remote' ? w.profile : null,
    fps: wantNum(w.fps, tier === 'thumb' ? THUMB_DEFAULT_FPS : 60, 1, 60),
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

/** What the server gives a session beyond the backend (src/server.ts); tests leave it out. */
export interface RtcHooks {
  /** One input message -> its answer (src/agent.ts `dispatch`): acks, touch acks, reports. */
  dispatch?: (msg: Record<string, unknown>, owner: object) => Promise<Record<string, unknown> | null>;
  /** The phone as it's turned now: `{orientation, point_width, point_height, screen_width, screen_height}`. */
  view?: () => Record<string, unknown>;
  /** A viewer asks for the picture (an offer came): the server sees that the phone's screen is on. */
  offer?: () => void;
  /**
   * 2026-11-18: the capture gave no picture for a while (an offer that brought none, or a picture that stopped while
   * the viewer asks for keyframes): the phone's screen is likely off. The server wakes it and resolves null when it's
   * awake, else why not. `force` (an offer that never had a picture): a screen that can't be looked at counts as dark.
   */
  noPicture?: (force: boolean) => Promise<string | null>;
}

/** An offer whose capture has given no picture this long has the phone woken (and again at the second mark). */
export const NO_PICTURE_WAKE_MS = [2500, 6500];
/** A picture that gave no frame this long while the viewer asks for keyframes has the phone woken (at most this often). */
export const STALL_WAKE_MS = 4000;

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
  private config?: Buffer; // the newest SPS + PPS: sent in front of every keyframe (keyUnit)
  private tsBase = (Math.random() * 0xffffffff) >>> 0;
  private clock = new RtpClock();
  private pace?: PaceQueue; // a far viewer's pacer queue (estimated)
  private path: string | null = null;
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
  private keysAsked = 0; // keyframes the viewer asked for (PLI, FIR, rtc-key)
  private lastKeySent = 0;
  private want?: { bitrate: number | null };
  private delay = new DelayTracker(); // the round trip from the browser's receiver reports
  private tier: QualityTier = 'full';
  private uninfo?: () => void;
  readonly since = Date.now();
  /** When the offer came (performance.now()), and the offer -> first frame sent on the track (ms; null until then). */
  private tOffer = 0;
  private connectMs: number | null = null;
  private warm = false;
  // the phone's sound (src/audio.ts): its own track, RTP clock and config; null reason = it's on
  private aTrack?: Track;
  private aRtp?: RtpConfig;
  private aClock?: AudioRtpClock;
  private aOff?: () => void;
  private aOpen = false;
  private aFeed?: AudioFeed;
  private aWanted = false; // the offer asked for sound
  private aReason: string | null = null;
  private aSent = 0;
  private tsBaseA = (Math.random() * 0xffffffff) >>> 0;
  // 2026-11-18: no picture -> wake the phone (NO_PICTURE_WAKE_MS), and why it couldn't be woken (the failure's reason)
  private wakeTimers: NodeJS.Timeout[] = [];
  private waking?: Promise<string | null>;
  private wakeWhy: string | null = null;
  private wokeAt = 0;
  private lastFrameAt = 0;

  constructor(
    private backend: Backend,
    private control: Control,
    private udid: string,
    private signal: (msg: Record<string, unknown>) => void,
    private remote = false,
    private hooks: RtcHooks = {},
  ) {}

  /** The picture's size now (null until frames flow). */
  frame(): H264Info | null {
    return this.ready && !this.closed ? this.src?.info ?? null : null;
  }

  /** The server lifted one of this session's touches itself (src/control.ts): the client hears it on "input-r". */
  touchReleased(info: { id: unknown; reason: string; error?: string }): void {
    try {
      if (this.inputR?.isOpen()) this.inputR.sendMessage(JSON.stringify({ type: 'touch-released', ...info }));
    } catch {
      /* closed */
    }
  }

  /** An input message's answer: the server's dispatch, else (tests) the plain acks. */
  private async answer(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (this.hooks.dispatch) return this.hooks.dispatch(msg, this);
    const t0 = performance.now();
    const id = msg.id ?? null;
    try {
      const r = await this.control.handle(this.udid, msg, this);
      const ack = touchAck(msg, t0, r);
      if (ack) return ack;
      return id !== null ? { type: 'ack', id, ok: true, ...(r ? { via: r.via, ms: Math.round((performance.now() - t0) * 10) / 10 } : {}) } : null;
    } catch (err) {
      const error = err instanceof HttpError ? err.message : 'internal error';
      return touchAck(msg, t0, undefined, error) ?? { type: 'ack', id, ok: false, error };
    }
  }

  async start(sdp: string, wantRaw: unknown): Promise<void> {
    this.tOffer = performance.now();
    const ndc = await loadRtc();
    if (this.closed) return;
    if (!ndc) throw new Error(`WebRTC is unavailable on this server (${libError})`);
    const offer = parseOffer(sdp);
    const w = rtcWant(wantRaw);
    if (w.profile) this.remote = w.profile === 'remote'; // the client's choice wins over its address
    this.tier = w.tier;
    const want = { ...w, remote: this.remote };
    this.want = want;
    const src = this.backend.h264(this.udid, want);
    if (typeof src === 'string') throw new Error(src);
    this.src = src;
    // the capture starts now (when it isn't up already), while the peer connection is put together and ICE runs
    this.warm = src.ready;
    const opening = src.open();
    opening.catch(() => {}); // heard below; this only keeps a failure from going unheard if the setup throws first
    // 2026-11-18: an offer that brings no picture: the phone's screen is likely off, so it's woken (twice at most)
    if (!src.ready && this.hooks.noPicture) {
      for (const ms of NO_PICTURE_WAKE_MS) {
        const t = setTimeout(() => {
          if (!this.closed && !this.ready) void this.wakeForPicture('the capture has given no picture yet', true);
        }, ms);
        t.unref?.();
        this.wakeTimers.push(t);
      }
    }

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
        // the server's word on the media path and the lane it streams, so the client shows it rather than guessing
        // from addresses (Tailscale's IPv6 fd7a:115c:a1e0::/48 looks like a private LAN address)
        if (!this.closed) this.signal({ type: 'rtc-path', path: this.path, remote: this.remote, lane: this.src?.kind ?? null, address: pair?.remote.address ?? null });
      }
      if (state === 'failed' || state === 'closed') this.close(`peer connection ${state}`);
    });
    pc.onDataChannel((dc) => this.channel(dc));

    const ssrc = (Math.random() * 0x7fffffff) >>> 0 || 1;
    const video = new ndc.Video(offer.mid, 'SendOnly');
    video.addH264Codec(offer.pt, 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1');
    video.addSSRC(ssrc, 'phone', 'lotus-phone', 'screen');
    // playout-delay 0/0 makes the browser drop every late frame; on a far (jittery) link that starves the decoder and
    // sends PLI after PLI (docs/BEST_METHOD.md 2a): far viewers don't get it (the client's jitterBufferTarget = 0 still
    // asks for the least delay). LAN viewers keep it.
    const playout = this.remote && process.env.RTC_PLAYOUT_ZERO !== '1' ? null : offer.playoutDelayId;
    if (playout !== null) video.parseSdpLine(`a=extmap:${playout} ${PLAYOUT_DELAY_URI}`);
    const track = pc.addTrack(video);
    this.track = track;
    const rtp = new ndc.RtpPacketizationConfig(ssrc, 'phone', offer.pt, 90000);
    if (playout !== null) {
      // ask the browser to render frames as soon as they're decoded (no jitter buffer delay)
      rtp.playoutDelayId = playout;
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
        const bps = paceFor(want.bitrate ?? (src.ceiling || DEFAULT_CEILING_BPS));
        packetizer.addToChain(new ndc.PacingHandler(bps, 5));
        this.pace = new PaceQueue(bps);
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

    // the phone's sound, when the offer asks for it; anything wrong here leaves the picture alone
    try {
      this.audioSetup(ndc, sdp);
    } catch (err) {
      this.audioDrop(`the sound couldn't be set up: ${errText(err)}`);
    }

    pc.setRemoteDescription(sdp, 'offer');
    for (const [c, mid] of this.pendingIce) this.addIce(c, mid);
    this.pendingIce = [];

    opening.then(
      (info) => {
        if (this.closed) return;
        this.ready = true;
        this.signal({
          type: 'rtc-hello', codec: 'h264', ...(this.hooks.view?.() ?? {}), width: info.width, height: info.height, fps: info.fps, scale: info.scale,
          lane: src.kind, server_time: Date.now(), audio: this.aWanted && !this.aReason && !!this.aTrack, audio_reason: this.aWanted ? this.aReason : 'the viewer asked for no sound',
          // the offer -> the capture has a picture to send (the first frame leaves once ICE connects: "first-frame")
          connectMs: Math.round(performance.now() - this.tOffer), warm: this.warm,
        });
        // the picture changed size (the phone turned): a new config and keyframe follow, and the client hears the size
        this.uninfo = src.onInfo((i) => {
          if (!this.closed) this.signal({ type: 'orientation', udid: this.udid, ...(this.hooks.view?.() ?? {}), width: i.width, height: i.height });
        });
        this.attach();
      },
      (err) => void this.noPictureFail(errText(err)),
    );
  }

  /** The phone woken because the capture gives no picture (one wake at a time); its result kept for the failure's reason. */
  private wakeForPicture(why: string, force: boolean): Promise<string | null> {
    if (this.waking) return this.waking;
    if (!this.hooks.noPicture) return Promise.resolve(null);
    console.log(`[rtc] ${this.udid.slice(-8)}: ${why}: waking the phone`);
    this.wokeAt = Date.now();
    const p = this.hooks
      .noPicture(force)
      .catch((err) => errText(err))
      .then((r) => {
        this.wakeWhy = r;
        if (r) console.log(`[rtc] ${this.udid.slice(-8)}: the phone could not be woken: ${r}`);
        return r;
      })
      .finally(() => {
        if (this.waking === p) this.waking = undefined;
      });
    this.waking = p;
    return p;
  }

  /**
   * The capture gave no picture in time: the session ends with a reason the viewer can show. A wake under way is
   * waited for first (a few seconds at most), so the reason says whether the phone could be woken.
   */
  private async noPictureFail(err: string): Promise<void> {
    if (this.closed) return;
    if (this.waking) await Promise.race([this.waking, new Promise((r) => setTimeout(r, 4000).unref?.())]);
    if (this.closed) return;
    const why = this.wakeWhy;
    if (why) return this.fail(`no picture: the phone's screen is off and could not be woken (${why})`);
    if (this.wokeAt && /no H\.264 keyframe/i.test(err)) return this.fail(`no picture yet: the phone's screen was off and is being woken; trying again (${err})`);
    this.fail(err);
  }

  /** The viewer's picture stalled (it asks for a keyframe): no frame for STALL_WAKE_MS means the screen likely went off. */
  stalled(): void {
    if (this.closed || !this.ready || !this.hooks.noPicture) return;
    const now = Date.now();
    if (!this.lastFrameAt || now - this.lastFrameAt < STALL_WAKE_MS || now - this.wokeAt < 15_000) return;
    void this.wakeForPicture(`no frame for ${Math.round((now - this.lastFrameAt) / 1000)} s`, false);
  }

  // ---- the phone's sound ----

  /** An Opus (or G.711) sendonly track on the offer's audio m-section, fed from the phone's capture. */
  private audioSetup(ndc: Ndc, sdp: string): void {
    const offer = parseOfferAudio(sdp);
    if (!offer) return;
    this.aWanted = true;
    const feed = this.backend.audio?.(this.udid);
    if (!feed) return void (this.aReason = 'this server has no sound for the phones');
    if (typeof feed === 'string') return void (this.aReason = feed);
    const plan = audioPlan(offer, feed.codec());
    if (typeof plan === 'string') return void (this.aReason = plan);
    this.aFeed = feed;
    const ssrc = ((Math.random() * 0x7fffffff) >>> 0) || 2;
    const audio = new ndc.Audio(offer.mid, 'SendOnly');
    if (plan.codec === 'opus') audio.addOpusCodec(plan.pt, offer.opusFmtp.includes('useinbandfec') ? 'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1' : 'minptime=10;stereo=1;sprop-stereo=1');
    else audio.addAudioCodec(plan.pt, 'PCMU/8000');
    // the same stream id as the picture: the browser syncs the two from their sender reports
    const stream = process.env.AUDIO_SYNC === '0' ? 'lotus-phone-sound' : 'lotus-phone';
    audio.addSSRC(ssrc, 'phone', stream, 'sound');
    const track = this.pc!.addTrack(audio);
    this.aTrack = track;
    const rtp = new ndc.RtpPacketizationConfig(ssrc, 'phone', plan.pt, plan.rate);
    this.aRtp = rtp;
    this.aClock = new AudioRtpClock(plan.rate, plan.frameSamples);
    const packetizer = new ndc.RtpPacketizer(rtp);
    packetizer.addToChain(new ndc.RtcpSrReporter(rtp));
    track.setMediaHandler(packetizer);
    track.onOpen(() => {
      this.aOpen = true;
      this.audioListen();
    });
    // the sound's own track closing (or failing) ends only the sound
    track.onClosed(() => this.audioDrop(this.closed ? null : 'the sound track closed'));
    this.aReason = feed.reason();
  }

  /** Frames from the capture onto the sound's track (from its open; the capture says "audio on" while anyone listens). */
  private audioListen(): void {
    if (this.aOff || !this.aFeed || this.closed) return;
    this.aOff = this.aFeed.listen(
      (f) => this.audioSend(f),
      (reason) => {
        if (this.closed || reason === this.aReason) return;
        this.aReason = reason;
        this.signal({ type: 'rtc-audio', audio: !reason, reason });
      },
    );
  }

  private audioSend(f: AudioFrame): void {
    if (!this.aOpen || !this.aTrack || !this.aRtp || !this.aClock || this.closed) return;
    this.aRtp.timestamp = (this.tsBaseA + this.aClock.stamp(f.time)) >>> 0;
    try {
      this.aTrack.sendMessageBinary(f.payload);
      this.aSent++;
    } catch (err) {
      this.audioDrop(`sending the sound failed: ${errText(err)}`);
    }
  }

  /** The sound stops (and says why); the picture goes on. */
  private audioDrop(why: string | null): void {
    this.aOff?.();
    this.aOff = undefined;
    this.aOpen = false;
    if (why && !this.closed) {
      console.error(`[rtc] ${this.udid.slice(-8)}: ${why}`);
      this.aReason = why;
      this.signal({ type: 'rtc-audio', audio: false, reason: why });
    }
  }

  /** The sound's numbers for `stats.sessions`. */
  audioInfo(): { on: boolean; reason: string | null; sent: number } | null {
    if (!this.aWanted) return null;
    return { on: this.aOpen && !this.aReason, reason: this.aReason, sent: this.aSent };
  }

  /** This session for `stats.sessions` (null until its video runs). */
  info(): { profile: Profile; quality: QualityTier; net: string | null; fps: number; latencyMs: number | null; lane: 'lan' | 'remote' | 'thumb' | null; since: number; connectMs: number | null; keysAsked: number; audio: { on: boolean; reason: string | null; sent: number } | null } | null {
    if (!this.viewer || this.closed) return null;
    return { profile: this.remote ? 'remote' : 'lan', quality: this.tier, net: this.path, ...this.viewer.sessionStats(), since: this.since, connectMs: this.connectMs, keysAsked: this.keysAsked, audio: this.audioInfo() };
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
      buffered: () => (typeof self.track?.bufferedAmount === 'function' ? self.track.bufferedAmount() : 0) + (self.pace?.waiting() ?? 0),
      open: () => !self.closed && !!self.track?.isOpen(),
      send: (r: Rec) => self.sendFrame(r),
      fail: (reason: string) => self.fail(reason),
      path: () => self.path,
      net: () => self.delay.stats(),
      // a far viewer: a few frames of pacer queue at most, like its WebSocket (H264Viewer.over)
      dropBytes: this.pace ? REMOTE_DROP_BYTES : undefined,
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
    this.delay.add(info.rttMs);
    if (info.wantsKey) this.key();
    this.nacked += info.nacked;
    if (info.fractionLost !== null) this.reportLoss = Math.max(this.reportLoss ?? 0, info.fractionLost);
  }

  /**
   * A fresh keyframe now (the browser's PLI or FIR, or the client's own `rtc-key` when its picture stalls); at most one
   * per 500 ms. True if it was asked for.
   */
  key(): boolean {
    const now = Date.now();
    if (!this.viewer || this.closed || now - this.lastKeyAsk < 500) return false;
    // a keyframe still on its way (the round trip and the pacer's queue ago, or less): this ask crossed it
    if (now - this.lastKeySent < keyInFlightMs(this.delay.rtt, this.pace?.waitingMs(now) ?? 0)) return false;
    this.lastKeyAsk = now;
    this.keysAsked++;
    this.viewer.forceKey();
    return true;
  }

  /**
   * Once a second, like WebRTC's own (GCC), delay first: a queue building in front of the viewer (its round trip
   * beyond the path's own, from the receiver reports) cuts the bitrate before any loss shows, since a router's buffer
   * holds seconds of video before it drops anything (and the acks of taps wait in the same queue). Then loss: more than
   * 10 % lost -> bitrate x (1 - loss/2). The bitrate climbs only while the queue is short and under 2 % is lost.
   * (REMB isn't used: a browser's receive-side estimate starts low and ramps.)
   */
  private ccTick(): void {
    if (!this.rc || !this.viewer || !this.src || this.closed) return;
    const byNack = this.packets > 0 ? Math.min(1, this.nacked / this.packets) : 0;
    const loss = Math.max(byNack, this.reportLoss ?? 0);
    const sent = this.packets;
    this.packets = this.nacked = 0;
    this.reportLoss = null;
    const marks = this.remote ? DELAY_MARKS.remote : DELAY_MARKS.lan;
    const queue = this.delay.queueMs();
    let changed = false;
    if (sent >= 10 && loss > 0.1) changed = this.rc.down(Math.max(0.5, 1 - loss / 2), null, 900);
    else if (queue !== null && queue > marks.cut) changed = this.rc.down(queue > marks.hard ? 0.6 : 0.85, null, DELAY_HOLD_MS);
    else if (loss < 0.02 && (queue === null || queue < marks.clear)) changed = this.rc.up();
    if (changed) this.src.setTarget(this.viewer, this.rc.bps);
  }

  /** One frame onto the track; a keyframe goes with the SPS and PPS as one access unit (keyUnit). */
  private sendFrame(r: Rec): void {
    if (!this.track || !this.rtp) return;
    if (r.kind === KIND.CONFIG) {
      this.config = r.payload;
      return;
    }
    const data = r.kind === KIND.KEY ? keyUnit(this.config, r.payload) : r.payload;
    // the RTP clock follows the capture time; a cached (old) keyframe is stamped as just captured (RtpClock)
    const now = Date.now();
    this.lastFrameAt = now;
    const { ts, stale } = this.clock.stamp(r.time, now);
    this.rtp.timestamp = (this.tsBase + ts) >>> 0;
    this.pace?.add(data.length, now);
    if (r.kind === KIND.KEY) this.lastKeySent = now;
    this.packets += Math.ceil(data.length / 1188);
    try {
      this.track.sendMessageBinary(data);
    } catch (err) {
      this.close(`send failed: ${errText(err)}`);
      return;
    }
    if (this.connectMs === null && r.kind === KIND.KEY) {
      // the first picture left on the track: the offer -> this is how long the view took to open
      this.connectMs = Math.round(performance.now() - this.tOffer);
      this.signal({ type: 'first-frame', udid: this.udid, transport: 'webrtc', connectMs: this.connectMs, warm: this.warm });
    }
    // about once a second: which RTP timestamp is which capture time (ms since the epoch, server clock),
    // so the client can measure glass-to-glass latency with the ping/pong clock offset
    if (!stale && now - this.lastTsMsg >= 1000 && this.inputR?.isOpen()) {
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
      this.control.alive(this); // its pings too: the channel is alive, so a finger held still stays down
      let msg: Record<string, unknown>;
      try {
        const v = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        msg = v;
      } catch {
        return reply({ type: 'ack', id: null, ok: false, error: 'message must be a JSON object' });
      }
      if (msg.type === 'ping') return reply({ type: 'pong', t: msg.t ?? null, server_time: Date.now() });
      if (msg.type === 'touch' && msg.phase === 'move' && typeof msg.seq !== 'number') {
        // an older client's move on the unordered channel (no `seq` to order it by): one older than the newest is late
        const t = typeof msg.t === 'number' ? msg.t : null;
        if (t !== null && t < this.lastMoveT) return;
        if (t !== null) this.lastMoveT = t;
      }
      if (msg.type === 'touch' && msg.phase === 'down') this.lastMoveT = -1;
      // touches are applied in the order they came (src/control.ts): a down and an up always, moves folded into the
      // newest while the phone is behind, a move older than one already applied skipped by its `seq`; each is answered
      // on the channel it came on
      void this.answer(msg).then((m) => m && reply(m));
    });
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.signal({ type: 'rtc-error', reason });
    this.close(reason);
  }

  close(_why = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.wakeTimers) clearTimeout(t);
    this.wakeTimers = [];
    this.uninfo?.();
    if (this.ccTimer) clearInterval(this.ccTimer);
    if (this.viewer) this.src?.remove(this.viewer);
    this.viewer = undefined;
    this.audioDrop(null);
    try {
      this.aTrack?.close();
    } catch {
      /* ignore */
    }
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
export function rtcSignaling(backend: Backend, control: Control, udid: string, send: (m: Record<string, unknown>) => void, remote = false, hooks: RtcHooks = {}) {
  let session: RtcSession | undefined;
  return {
    handle(msg: Record<string, unknown>): boolean {
      switch (msg.type) {
        case 'rtc-offer': {
          if (typeof msg.sdp !== 'string' || !msg.sdp) {
            session?.close('replaced by a bad offer');
            send({ type: 'rtc-error', reason: '"sdp" must be a string' });
            return true;
          }
          hooks.offer?.();
          session?.close('replaced by a new offer');
          const s = new RtcSession(backend, control, udid, send, remote, hooks);
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
        case 'rtc-key':
          // the client's picture stalled (its watchdog): a fresh keyframe, as a PLI would ask; and when the capture has
          // given nothing for a while, the phone is woken (its screen went off: 2026-11-18)
          session?.key();
          session?.stalled();
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
    /** The WebRTC session's numbers, or null without one. */
    info() {
      return session?.info() ?? null;
    },
    /** The WebRTC picture's size now, or null without one. */
    frame() {
      return session?.frame() ?? null;
    },
  };
}

export type { H264Settings };
