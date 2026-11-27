import { ChildProcess, spawn } from 'node:child_process';
import { trace } from './trace.js';

/**
 * H.264 live view: one capture helper (native/phonecap, or the mock) per phone, shared by every viewer.
 *
 * Helper -> server framing (stdout), one record after another:
 *   1 byte lane << 4 | kind | 8 bytes capture time (float64 BE, ms since the epoch) | 4 bytes length (uint32 BE) | payload
 * Kinds: 0 info (JSON {width, height, fps, scale?}), 1 config (SPS+PPS, Annex B), 2 keyframe (Annex B),
 *        3 delta (Annex B), 4 stats (JSON {encode_ms, capture_to_encoded_ms}); with --audio also 5 an audio frame and
 *        6 audio JSON (src/audio.ts), never handed to the video's lanes.
 *        2026-11-27 (docs/root-cause.md 3, 6): 7 heartbeat (JSON {running, finding, frames_in, frames_out, last_frame,
 *        lanes}, once a second, lane nibble 0), 8 still (a JPEG of the newest captured picture, asked with "still"; its
 *        time is that picture's own capture time), 9 and 10 a keyframe and a delta that RE-ENCODE an earlier picture (a
 *        key asked on a still screen, a turn, a lane added): their time is that picture's original capture time, never
 *        "now". The parser hands 9 and 10 on as 2 and 3 with `repeat: true`.
 * Lanes (a helper whose build/phonecap.caps says "lanes"): one capture, up to 8 encoders, each with its own size, fps
 * and bitrate (src/lanes.ts). Lane 0 comes from the command line; an older helper only has lane 0 (high nibble 0).
 * Server -> helper (stdin): "key [lane]\n" forces an IDR now, "bitrate [lane] <bit/s>\n" changes the encoder's target
 * (congestion control; an older helper ignores it), "fps <lane> <fps>\n", "lane <id> <fps> <scale> <bit/s> <key s>\n",
 * "unlane <id>\n", "still [<long side px>]\n" (a kind 8 record of the newest picture), "quit\n" exits.
 *
 * Server -> WebSocket viewer: the same record minus the length: 1 byte kind (1/2/3) | 8 bytes time | payload.
 */
export const KIND = { INFO: 0, CONFIG: 1, KEY: 2, DELTA: 3, STATS: 4, BEAT: 7, STILL: 8, KEY_REPEAT: 9, DELTA_REPEAT: 10 } as const;
const MAX_KIND = 10;
const HEADER = 13;
const MAX_PAYLOAD = 32 * 1024 * 1024;

export interface Rec {
  kind: number;
  time: number; // capture time, ms since the epoch (server clock)
  payload: Buffer;
  arrived: number; // Date.now() when the server got it
  lane?: number; // the helper's encoder lane (0 for an older helper)
  msg?: Buffer; // cached WebSocket message
  /** 2026-11-27: an earlier picture encoded again (kinds 9 and 10); `time` is that picture's own capture time. */
  repeat?: boolean;
}

export function encodeRecord(kind: number, time: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(HEADER + payload.length);
  out[0] = kind;
  out.writeDoubleBE(time, 1);
  out.writeUInt32BE(payload.length, 9);
  payload.copy(out, HEADER);
  return out;
}

/** The WebSocket message for a record: kind, capture time, payload. Built once, shared by all viewers. */
export function wsMessage(r: Rec): Buffer {
  if (!r.msg) {
    const m = Buffer.allocUnsafe(9 + r.payload.length);
    m[0] = r.kind;
    m.writeDoubleBE(r.time, 1);
    r.payload.copy(m, 9);
    r.msg = m;
  }
  return r.msg;
}

/** Incremental parser for the helper's stdout. Throws on a corrupt stream (the caller restarts the helper). */
export class RecordParser {
  private chunks: Buffer[] = [];
  private len = 0;
  constructor(private onRecord: (r: Rec) => void) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.len += chunk.length;
    for (;;) {
      if (this.len < HEADER) return;
      const head = this.peek(HEADER);
      const kind = head[0]! & 0x0f;
      const lane = head[0]! >> 4;
      const size = head.readUInt32BE(9);
      if (kind > MAX_KIND || size > MAX_PAYLOAD) throw new Error(`bad record from the capture helper (kind ${head[0]}, ${size} bytes)`);
      if (this.len < HEADER + size) return;
      const all = this.take(HEADER + size);
      const rec: Rec = { kind, time: all.readDoubleBE(1), payload: all.subarray(HEADER), arrived: Date.now(), lane };
      if (kind === KIND.KEY_REPEAT || kind === KIND.DELTA_REPEAT) {
        rec.kind = kind === KIND.KEY_REPEAT ? KIND.KEY : KIND.DELTA;
        rec.repeat = true;
      }
      this.onRecord(rec);
    }
  }

  private peek(n: number): Buffer {
    if (this.chunks[0]!.length >= n) return this.chunks[0]!;
    const b = Buffer.concat(this.chunks);
    this.chunks = [b];
    return b;
  }

  private take(n: number): Buffer {
    let b = this.chunks[0]!;
    if (b.length < n) {
      b = Buffer.concat(this.chunks);
      this.chunks = [b];
    }
    const out = b.subarray(0, n);
    const rest = b.subarray(n);
    if (rest.length) this.chunks[0] = rest;
    else this.chunks.shift();
    this.len -= n;
    return out;
  }
}

/** Events per second over the last second. */
export class RateMeter {
  private ts: number[] = [];
  tick(now = Date.now()): void {
    this.ts.push(now);
    if (this.ts.length > 240) this.ts.splice(0, this.ts.length - 240);
  }
  rate(now = Date.now()): number {
    while (this.ts.length && now - this.ts[0]! > 1000) this.ts.shift();
    return this.ts.length;
  }
}

const ewma = (prev: number | null, v: number, a = 0.1) => (prev === null ? v : prev + (v - prev) * a);
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

export interface H264Settings {
  fps: number; // 1-60
  scale: number; // 10-100 %
  bitrate: number; // bits per second the encoder starts at
  /** The most the viewers' targets may raise it to (default: `bitrate`). A far viewer starts low and climbs to this. */
  maxBitrate?: number;
  /** Lower the frame rate with the bitrate (a far link): see fpsFor. */
  adaptFps?: boolean;
  /** Keyframe interval, seconds (default 2). */
  keySeconds?: number;
  /** 2026-11-27: a far viewer's lane: the picture gets smaller as the bitrate falls (scaleFor), so it never freezes. */
  adaptScale?: boolean;
  /** The fewest frames a second adaptFps goes to (the link class's floor, at most 12; default fpsFor's own). */
  floorFps?: number;
}

/**
 * The frame rate for a far viewer's lane at a bitrate: fewer, better frames when the link is thin (each frame keeps
 * enough bits to stay sharp, and the encoder's budget isn't spent on frames that would only queue).
 */
export function fpsFor(bps: number, maxFps: number, floorFps = 1): number {
  const f = bps >= 1_000_000 ? maxFps : bps >= 650_000 ? 20 : 12;
  return Math.max(1, Math.min(maxFps, Math.max(f, Math.min(floorFps, 12))));
}

/**
 * 2026-11-27: the picture's scale (% of the screen) for a far lane at a bitrate: the lane's own scale while the link
 * carries 900 kbit/s, three quarters of it down to 500 kbit/s, half below that (at least 20 %). Fewer pixels keep
 * each frame sharp and small, so a thin link degrades instead of dropping frames and freezing.
 */
export function scaleFor(bps: number, base: number): number {
  if (bps >= 900_000) return base;
  if (bps >= 500_000) return Math.max(20, Math.round(base * 0.75));
  return Math.max(20, Math.round(base * 0.5));
}
export interface H264Info {
  width: number;
  height: number;
  fps: number;
  scale: number;
}
export interface ProducerHooks {
  record(r: Rec): void;
  exit(reason: string): void;
  /** 2026-11-23: the helper found the phone's screen and its capture session runs (its "capturing ..." line). */
  capturing?(): void;
}
export interface Producer {
  key(): void;
  /**
   * Ends it. 2026-11-27: a producer whose process outlives the call returns a promise that settles once it has exited
   * (the source is Stopping until then, and starts no other capture of the same screen device meanwhile).
   */
  stop(): void | Promise<void>;
  /** 2026-11-27: a still of the newest picture (a kind 8 record follows; absent: no stills). */
  still?(longSide?: number): void;
  /** 2026-11-27: a new picture scale (%) for the running encoder (absent: fixed). */
  scale?(pct: number): void;
  /**
   * It calls hooks.capturing() once its capture session runs (the real helper), so the first-keyframe watchdog
   * counts from then, not while the helper still waits for the phone's screen device (up to 12 s after a replug).
   */
  reportsCapturing?: boolean;
  /** A new target bitrate for the running encoder (absent: fixed bitrate). */
  bitrate?(bps: number): void;
  /** A new frame rate for the running encoder (absent: fixed). */
  fps?(fps: number): void;
  /**
   * 2026-11-23: it ran without giving a picture: end it so a new start makes a new capture session (absent: stop()).
   * A lanes host (src/lanes.ts) ends its whole process unless that process gave pictures. Its exit hook isn't needed
   * afterwards (the source has already moved on). `whole` (2026-11-27, a hung helper: its heartbeat stopped): the
   * whole process is ended even when it gave pictures.
   */
  restart?(why: string, whole?: boolean): void;
}
export type StartProducer = (want: H264Settings, hooks: ProducerHooks) => Producer;

/** `quality` 1-100 maps to 2-12 Mbps; null keeps the default. */
export function bitrateFor(quality: number | null, dfltBps: number): number {
  if (quality === null) return dfltBps;
  return Math.round((2 + (10 * Math.min(100, Math.max(1, quality))) / 100) * 1_000_000);
}

/** Where a viewer's frames go: a WebSocket or a WebRTC track. */
export interface Transport {
  readonly kind: 'ws' | 'rtc';
  buffered(): number;
  open(): boolean;
  /** `meta.primed` (2026-11-27): the cached keyframe a new viewer starts from, sent again however old it is. */
  send(r: Rec, meta?: { primed?: boolean }): void;
  fail(reason: string): void;
  path?(): string | null;
  /** WebRTC: the round trip from the receiver reports, its base and the queue beyond it (ms). */
  net?(): { rtt_ms: number | null; base_rtt_ms: number | null; queue_ms: number | null };
  /** True while frames sent earlier still wait on the way (flow control): frames are skipped, never queued. */
  congested?(): boolean;
  /** Bytes waiting in the socket that count as backed up (default 256 KB; small for a far viewer). */
  dropBytes?: number;
}

const DROP_FLOOR = 256 * 1024;
/** A far viewer's socket: a few frames at its bitrate, not seconds of them. */
export const REMOTE_DROP_BYTES = 64 * 1024;

/**
 * One viewer. Latest-only: when the transport is backed up, deltas are dropped until the next keyframe
 * (and one is asked for); nothing is ever queued here. Config always goes out right before a keyframe.
 */
export class H264Viewer {
  needKey = true;
  dropped = 0;
  private sentConfig?: Buffer;
  private lastAsk = 0;
  /** Frames sent to this viewer (its own fps) and its capture -> sent time (ms, smoothed). */
  readonly meter = new RateMeter();
  capToSent: number | null = null;
  constructor(readonly t: Transport, private src: H264Source) {}

  /** This viewer's numbers for `stats.sessions`: fps and capture -> sent (+ half the round trip when known). */
  sessionStats(): { fps: number; latencyMs: number | null; lane: 'lan' | 'remote' | 'thumb' | null } {
    const rtt = this.t.net?.().rtt_ms ?? null;
    const lat = this.capToSent === null ? null : this.capToSent + (rtt !== null ? rtt / 2 : 0);
    return { fps: this.meter.rate(), latencyMs: lat === null ? null : Math.round(lat), lane: this.src.kind };
  }

  private sent(r: Rec): void {
    this.meter.tick();
    this.capToSent = ewma(this.capToSent, Date.now() - r.time);
    this.src.noteSent(r);
  }

  private over(): boolean {
    const keySize = this.src.key?.payload.length ?? 0;
    return this.t.buffered() > Math.max(this.t.dropBytes ?? DROP_FLOOR, keySize * 1.5) || !!this.t.congested?.();
  }

  private ask(): void {
    const now = Date.now();
    if (now - this.lastAsk < 500) return;
    this.lastAsk = now;
    this.src.requestKey(true);
  }

  /**
   * First frames for a new viewer: the cached config + keyframe right away. `stale` = deltas followed it (a fresh
   * keyframe is on its way). A WebRTC viewer skips a stale one: the fresh keyframe is a frame away, and two keyframes
   * back to back are a burst that a far link's pacer holds every later frame behind.
   */
  prime(config: Rec | undefined, key: Rec | undefined, stale: boolean): void {
    if (key && this.t.open() && !(stale && this.t.kind === 'rtc')) {
      this.sendKey(config, key, true);
      this.needKey = stale;
    } else this.needKey = true;
  }

  deliver(r: Rec): void {
    if (!this.t.open()) return;
    if (r.kind === KIND.KEY) {
      if (this.over()) {
        this.needKey = true;
        this.dropped++;
        this.ask();
        return;
      }
      this.sendKey(this.src.config, r);
      this.needKey = false;
    } else if (r.kind === KIND.DELTA) {
      if (this.needKey) {
        this.dropped++;
        if (!this.over()) this.ask(); // the link has room again: the keyframe now, not at the next interval
        return;
      }
      if (this.over()) {
        this.needKey = true;
        this.dropped++;
        this.ask();
        return;
      }
      this.t.send(r);
      this.sent(r);
    }
  }

  /** The client asked for a keyframe (decoder reset, PLI/FIR): skip deltas until it comes. */
  forceKey(): void {
    this.needKey = true;
    this.src.requestKey(true);
  }

  private sendKey(config: Rec | undefined, key: Rec, primed = false): void {
    if (config && !(this.sentConfig && this.sentConfig.equals(config.payload))) {
      this.t.send(config);
      this.sentConfig = config.payload;
    }
    if (primed) this.t.send(key, { primed: true });
    else this.t.send(key);
    this.sent(key);
  }
}

export interface SourceOptions {
  idleMs?: number; // stop the helper this long after the last viewer (and holder) leaves
  /**
   * An outer deadline on each open() (ms). 2026-11-27: none by default. An open resolves on the capture's state (a
   * picture; openState() also on WaitingUnlock) and rejects when the capture gives up; the watchdogs below bound every
   * state. Given, it rejects that open as before ("no H.264 keyframe within N s") and ends a silent capture nobody
   * else waits on.
   */
  openTimeoutMs?: number;
  /**
   * 2026-11-23: a capture that has given no keyframe this long after its session runs (the helper's "capturing" line;
   * a producer that doesn't tell: after its start) is ended and started over, counted as a failed start. Default 8 s.
   * A helper that runs without frames is never left running.
   */
  firstKeyMs?: number;
  /**
   * A helper that tells when it's capturing but hasn't this long after its start (it waits up to 12 s for the phone's
   * screen device, then exits by itself) is ended the same way. Default 20 s.
   */
  deviceWaitMs?: number;
  /** 2026-11-27: a helper that sent heartbeats and then none for this long is Stale and started over (default 3 s). */
  staleMs?: number;
  /** 2026-11-27: no new picture from the screen for this long: Live -> Still (default 1 s). */
  stillMs?: number;
  /**
   * 2026-11-27: whether the phone is locked now, when known (Power). A start that gives no frame while it is waits in
   * WaitingUnlock (a quiet try every unlockRetryMs, none counted) instead of burning its tries and giving up.
   */
  locked?: () => boolean | null;
  /** In WaitingUnlock, a quiet new try this often (default 5 s; unlocked() tries at once). */
  unlockRetryMs?: number;
  /** 2026-11-27: the phone this source captures, for the trace journal (src/trace.ts: capture.state, capture.beat). */
  udid?: string;
  log?: (m: string) => void;
  /** Whose lane this is: "lan" (full settings) or "remote" (a far viewer's), for the stats. */
  kind?: 'lan' | 'remote' | 'thumb';
  /** The picture's size is known or changed (the phone turned): the backend checks it against the orientation. */
  onInfo?: (info: H264Info) => void;
}

/**
 * 2026-11-27, the capture's state machine (docs/root-cause.md 13.3b):
 *   Off -> Finding (the helper looks for the phone's screen device) -> Starting (its session runs, no picture yet)
 *   Starting -> Live <-> Still (Still: no new picture for stillMs; with heartbeats, the session is confirmed running)
 *   Starting, no picture, the phone locked -> WaitingUnlock (quiet tries, none counted)
 *   Live|Still, heartbeat silent for staleMs, the session not running, or frames in with none encoded -> Stale ->
 *   (backoff) -> Finding; a start that fails -> Restarting (backoff); 3 failed starts in a row -> GaveUp (60 s)
 *   the last viewer and holder gone -> (idleMs) -> Stopping (until the helper has exited) -> Off; no start meanwhile.
 */
export type CaptureState = 'Off' | 'Finding' | 'Starting' | 'Live' | 'Still' | 'Stale' | 'Restarting' | 'GaveUp' | 'WaitingUnlock' | 'Stopping';

/** The helper's last heartbeat (kind 7). */
export interface Heartbeat {
  /** When it arrived (Date.now()). */
  at: number;
  /** Its capture session runs (AVCaptureSession.isRunning). */
  running: boolean;
  /** It's still looking for the phone's screen device. */
  finding: boolean;
  /** Frames the device handed over, and frames given to the encoders, since the last heartbeat. */
  framesIn: number;
  framesOut: number;
  /** The newest device frame's capture time (ms since the epoch; 0: none yet). */
  lastFrame: number;
}

/** A decoded still of the capture's newest picture (latestFrame). */
export interface CaptureStill {
  data: Buffer;
  mime: 'image/jpeg' | 'image/png';
  /** The picture's own capture time (ms since the epoch). */
  capturedAt: number;
  /**
   * Until when it's known to still be the screen (ms since the epoch): its capture time, or, on a still screen, the
   * last heartbeat that said no newer frame had come.
   */
  validAt: number;
  /** now - validAt. */
  ageMs: number;
  state: CaptureState;
}

export const FIRST_KEY_MS = 8_000;
export const STALE_MS = 3_000;
export const STILL_AFTER_MS = 1_000;
export const UNLOCK_RETRY_MS = 5_000;
/** The longest a source waits for its helper to exit before it may start another (it was SIGKILLed by then). */
export const STOP_WAIT_MS = 3_000;
/** A far lane's picture shrinks after the bitrate stayed low this long, and grows back after this long above. */
export const SCALE_DOWN_MS = 3_000;
export const SCALE_UP_MS = 15_000;

/** A lane's network numbers: its WebRTC viewers' longest round trip and queue (the worst one counts). */
function netOf(list: ({ rtt_ms: number | null; queue_ms: number | null } | null)[]): { rtt_ms: number | null; queue_ms: number | null } {
  let rtt: number | null = null;
  let queue: number | null = null;
  for (const n of list) {
    if (n?.rtt_ms != null) rtt = Math.max(rtt ?? 0, n.rtt_ms);
    if (n?.queue_ms != null) queue = Math.max(queue ?? 0, n.queue_ms);
  }
  return { rtt_ms: rtt, queue_ms: queue };
}

const isPromise = (v: unknown): v is Promise<void> => !!v && typeof (v as Promise<void>).then === 'function';

/** One capture helper per phone, started on demand, shared, restarted with backoff, stopped when idle. */
export class H264Source {
  info?: H264Info;
  config?: Rec;
  key?: Rec;
  private deltasSinceKey = 0;
  private producer?: Producer;
  private gen = 0;
  private sinks = new Set<H264Viewer>();
  private waiters: { resolve: (i: H264Info) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }[] = [];
  private idle?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private failures = 0;
  private gotKey = false;
  // 2026-11-23, the first-keyframe watchdog: a helper alive but silent (iPhone-2 after a replug) is ended, never waited on
  private watch?: NodeJS.Timeout;
  private startedAt = 0;
  private attempts = 0; // starts since the last keyframe (1: the first try; more: restarts)
  private capturingAt = 0; // when the running helper said its capture session runs (0: not yet)
  private reports = false; // the running producer tells when it's capturing
  private firstKeyMs: number;
  private deviceWaitMs: number;
  private brokenUntil = 0;
  private lastKeyReq = 0;
  private keyPending = false;
  lastError: string | null = null;
  private meter = new RateMeter();
  private targets = new Map<H264Viewer, number>(); // each viewer's link: the bitrate it carries
  private applied = 0; // the bitrate the running helper was last given
  private appliedFps = 0; // the frame rate the running helper was last given
  readonly kind: 'lan' | 'remote' | 'thumb' | null;
  private encodeMs: number | null = null;
  private capToEnc: number | null = null;
  private capToSent: number | null = null;
  private idleMs: number;
  private openTimeoutMs: number;
  private log: (m: string) => void;
  private infoSubs = new Set<(info: H264Info) => void>();
  /**
   * 2026-11-21: when the capture last gave a frame that differs from the one before (a delta: a still screen gives
   * none, and a keyframe may be the last picture encoded again), Date.now(); 0 = never. While it's recent the screen
   * is on, so the server needn't ask WebDriverAgent for a screenshot to know.
   */
  movedAt = 0;
  // ---- 2026-11-27: the state machine's own facts ----
  private opts: SourceOptions;
  private staleMs: number;
  private stillMs: number;
  private unlockRetryMs: number;
  private holds = new Map<number, string>(); // who keeps the capture on besides its viewers (acquireCapture, a connecting session)
  private holdSeq = 0;
  private stateWaiters: { resolve: (s: { state: CaptureState; info: H264Info | null }) => void; reject: (e: Error) => void }[] = [];
  private stateSubs = new Set<(state: CaptureState, why: string | null) => void>();
  private lastState: CaptureState = 'Off';
  private stopping?: Promise<void>;
  private startAfterStop = false;
  private waitingUnlock = false;
  private staleReason: string | null = null;
  private beat?: Heartbeat;
  private beatsSeen = false; // the running helper sends heartbeats (a newer phonecap)
  private devFrames = 0; // frames the device handed over, from the heartbeats (all runs)
  private notRunning = 0; // heartbeats in a row that said the session isn't running
  private inWithoutOut = 0; // heartbeats in a row with frames in and no picture out of this lane
  private videoSinceBeat = 0;
  private tickTimer?: NodeJS.Timeout;
  private lastVideoAt = 0; // when the newest new (not repeated) picture arrived (Date.now())
  private lastSourceTime = 0; // that picture's own capture time
  private srcFrames = 0; // new pictures (keyframes and deltas) from the encoder, all runs
  private repeats = 0; // earlier pictures encoded again
  private stillCache?: { data: Buffer; time: number; arrived: number };
  private stillWaiters: ((ok: boolean) => void)[] = [];
  private scaleApplied = 0;
  private belowSince = 0;
  private aboveSince = 0;
  private closed = false;

  constructor(private label: string, private startFn: StartProducer, private want: H264Settings, opts: SourceOptions = {}) {
    this.opts = opts;
    this.idleMs = opts.idleMs ?? 10_000;
    this.openTimeoutMs = opts.openTimeoutMs ?? 0;
    this.firstKeyMs = opts.firstKeyMs ?? (opts.openTimeoutMs || FIRST_KEY_MS);
    this.deviceWaitMs = opts.deviceWaitMs ?? 20_000;
    this.staleMs = opts.staleMs ?? STALE_MS;
    this.stillMs = opts.stillMs ?? STILL_AFTER_MS;
    this.unlockRetryMs = opts.unlockRetryMs ?? UNLOCK_RETRY_MS;
    this.log = opts.log ?? ((m) => console.log(`[h264 ${label}] ${m}`));
    this.kind = opts.kind ?? null;
    if (opts.onInfo) this.infoSubs.add(opts.onInfo);
  }

  /** Hear when the picture's size changes (the phone turned: a new config and keyframe follow). Returns the unsubscribe. */
  onInfo(cb: (info: H264Info) => void): () => void {
    this.infoSubs.add(cb);
    return () => {
      this.infoSubs.delete(cb);
    };
  }

  /** 2026-11-27: hear every change of the capture's state (and why, for the bad ones). Returns the unsubscribe. */
  onState(cb: (state: CaptureState, why: string | null) => void): () => void {
    this.stateSubs.add(cb);
    return () => {
      this.stateSubs.delete(cb);
    };
  }

  get running(): boolean {
    return !!this.producer;
  }
  /** A picture is at hand: a viewer joining now gets a keyframe at once (the capture is warm). */
  get ready(): boolean {
    return !!this.info && !!this.key;
  }
  get viewers(): number {
    return this.sinks.size;
  }

  /** Why new viewers can't use H.264 right now (the helper kept failing), else null. */
  unavailable(): string | null {
    return Date.now() < this.brokenUntil ? `H.264 capture failed: ${this.lastError ?? 'unknown error'}` : null;
  }

  /** 2026-11-27: the capture's state (see CaptureState). */
  captureState(): CaptureState {
    const now = Date.now();
    if (now < this.brokenUntil) return 'GaveUp';
    if (this.stopping && !this.producer) return 'Stopping';
    if (this.waitingUnlock) return 'WaitingUnlock';
    if (!this.producer) return this.restartTimer ? (this.staleReason ? 'Stale' : 'Restarting') : 'Off';
    if (!this.gotKey) return (this.reports && !this.capturingAt) || this.beat?.finding ? 'Finding' : 'Starting';
    return this.lastVideoAt && now - this.lastVideoAt < this.stillMs ? 'Live' : 'Still';
  }

  /** Why the capture is in a bad state (Stale, Restarting, GaveUp, WaitingUnlock), else null. */
  stateWhy(): string | null {
    const s = this.captureState();
    if (s === 'Stale') return this.staleReason;
    if (s === 'Restarting' || s === 'GaveUp' || s === 'WaitingUnlock') return this.lastError;
    return null;
  }

  /** How old the newest NEW picture from the screen is (ms; repeats don't count), or null before any. */
  sourceAgeMs(now = Date.now()): number | null {
    return this.lastVideoAt ? now - this.lastVideoAt : null;
  }
  /** The newest new picture's own capture time (ms since the epoch), or null before any. */
  sourceTime(): number | null {
    return this.lastSourceTime || null;
  }
  /** The last heartbeat (null: none from the running helper). */
  heartbeat(): Heartbeat | null {
    return this.beatsSeen && this.producer ? this.beat ?? null : null;
  }
  /** Counters for a viewer's freeze labels (src/congestion.ts FreezeTracker). */
  counters(): { state: CaptureState; srcFrames: number; devFrames: number | null; repeats: number } {
    return { state: this.captureState(), srcFrames: this.srcFrames, devFrames: this.beatsSeen ? this.devFrames : null, repeats: this.repeats };
  }
  /** Who keeps the capture on besides its viewers (acquireCapture's reasons). */
  holders(): string[] {
    return [...this.holds.values()];
  }

  /**
   * What the capture is doing, for the stats (why there's no picture): "off", "running", "waiting for first frame
   * (restart 2)", "starting over (restart 1): <why>", or "gave up until <time> (tries again then): <why>"; 2026-11-27
   * also "looking for the phone's screen", "waiting for the phone to be unlocked: <why>", "stale: <why>", "stopping".
   */
  state(): string {
    const n = this.attempts - 1;
    const again = n > 0 ? ` (restart ${n})` : '';
    if (Date.now() < this.brokenUntil) return `gave up until ${new Date(this.brokenUntil).toLocaleTimeString()} (tries again then): ${this.lastError ?? 'unknown error'}`;
    if (this.stopping && !this.producer) return 'stopping';
    if (this.waitingUnlock) return `waiting for the phone to be unlocked: ${this.lastError ?? 'no picture while it is locked'}`;
    if (this.producer && this.gotKey) return 'running';
    if (this.producer) return (this.reports && !this.capturingAt) || this.beat?.finding ? `looking for the phone's screen${again}` : `waiting for first frame${again}`;
    if (this.restartTimer && this.staleReason) return `stale: ${this.staleReason}; starting over`;
    // the next start is restart number `attempts`
    if (this.restartTimer) return `starting over (restart ${Math.max(1, this.attempts)}): ${this.lastError ?? 'the capture stopped'}`;
    return 'off';
  }

  /** Settings for the next start; a running helper keeps its settings (it's shared). */
  setWant(w: H264Settings): void {
    if (!this.producer) this.want = { ...w };
  }

  private wanted(): boolean {
    return this.sinks.size > 0 || this.waiters.length > 0 || this.holds.size > 0 || this.stateWaiters.length > 0;
  }

  /** Start it unless it runs, is due to start again, or is closed (a Stopping one starts once its helper has exited). */
  private ensure(): void {
    if (!this.producer && !this.restartTimer && !this.closed) this.start();
  }

  /**
   * Make sure the helper runs; resolves once a keyframe (and the size) is known. 2026-11-27: on the capture's state, not
   * on a timer (see openTimeoutMs); it rejects when the capture gives up.
   */
  open(): Promise<H264Info> {
    this.cancelIdle();
    if (this.info && this.key) {
      // running: the caller's viewer (add) cancels this; a caller that never adds one doesn't leave it running
      this.maybeIdle();
      return Promise.resolve(this.info);
    }
    const p = new Promise<H264Info>((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { resolve, reject };
      if (this.openTimeoutMs > 0) {
        w.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          const err = new Error(this.lastError ? `H.264 capture did not start: ${this.lastError}` : `no H.264 keyframe within ${this.openTimeoutMs / 1000}s`);
          // 2026-11-23: a capture that gave this open nothing and that nobody else waits on is ended now, so the next
          // open starts a fresh one (a helper still looking for the phone's screen is left to find it or exit by
          // itself; one capturing for only a moment is left to the watchdog)
          const since = this.reports ? this.capturingAt : this.startedAt;
          const settled = Math.min(this.firstKeyMs, this.openTimeoutMs / 2, 3000);
          if (this.producer && !this.gotKey && !this.wanted() && since && Date.now() - since >= settled) {
            this.silent(`no picture from the phone's screen within ${this.openTimeoutMs / 1000} s (the capture ran without giving a frame); it starts over with the next viewer`);
          }
          reject(err);
          this.maybeIdle();
        }, this.openTimeoutMs);
      }
      this.waiters.push(w);
    });
    this.ensure();
    return p;
  }

  /**
   * 2026-11-27: like open(), but resolves on the state the viewer should be told: Live or Still (with the picture's
   * size), or WaitingUnlock (no picture until the phone is unlocked; the capture keeps trying quietly). Rejects when
   * the capture gives up.
   */
  openState(): Promise<{ state: CaptureState; info: H264Info | null }> {
    this.cancelIdle();
    const s = this.captureState();
    if ((s === 'Live' || s === 'Still') && this.info && this.key) {
      this.maybeIdle();
      return Promise.resolve({ state: s, info: this.info });
    }
    if (s === 'WaitingUnlock') return Promise.resolve({ state: s, info: null });
    const p = new Promise<{ state: CaptureState; info: H264Info | null }>((resolve, reject) => this.stateWaiters.push({ resolve, reject }));
    this.ensure();
    return p;
  }

  /**
   * 2026-11-27: keep the capture on (started now if it's off) until the returned release is called, viewers or not:
   * acquireCapture (an agent or client working on the phone), a WebRTC session while it connects. Released, the
   * capture stops after idleMs unless someone else wants it.
   */
  hold(reason: string): () => void {
    const id = ++this.holdSeq;
    this.holds.set(id, reason);
    this.cancelIdle();
    this.ensure();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.holds.delete(id);
      this.maybeIdle();
    };
  }

  /** 2026-11-27: the phone was unlocked: a capture waiting for that tries again now. */
  unlocked(): void {
    if (!this.waitingUnlock || this.producer) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.wanted()) this.start();
  }

  add(v: H264Viewer): void {
    this.sinks.add(v);
    this.cancelIdle();
    this.ensure(); // it stopped between its open and this (it never should)
    const stale = this.deltasSinceKey > 0;
    v.prime(this.config, this.key, stale);
    if (stale || !this.key) this.requestKey(true);
  }

  remove(v: H264Viewer): void {
    if (this.targets.delete(v)) this.applyBitrate();
    if (this.sinks.delete(v)) this.maybeIdle();
  }

  /** The most the encoder goes to (the viewers' targets climb to it). */
  get ceiling(): number {
    return this.want.maxBitrate ?? this.want.bitrate;
  }

  /** The bitrate the helper starts with. */
  get startBps(): number {
    return this.want.bitrate;
  }

  /** One viewer's link estimate (null: none). The encoder runs at the lowest one, never above the ceiling. */
  setTarget(v: H264Viewer, bps: number | null): void {
    if (bps === null) this.targets.delete(v);
    else this.targets.set(v, bps);
    this.applyBitrate();
  }

  /**
   * The encoder's bitrate now: what the slowest viewer's link carries, never above the ceiling; the start setting while
   * no viewer has a target.
   */
  bitrateNow(): number {
    if (!this.targets.size) return Math.round(this.want.bitrate);
    const cap = this.ceiling;
    let b = Infinity;
    for (const t of this.targets.values()) b = Math.min(b, t);
    return Math.round(cap > 0 ? Math.min(cap, b) : b);
  }

  /** The frame rate now (a far viewer's lane runs fewer frames on a thin link). */
  fpsNow(): number {
    return this.want.adaptFps ? fpsFor(this.bitrateNow(), this.want.fps, this.want.floorFps) : this.want.fps;
  }

  /** 2026-11-27: the picture's scale now (a far lane's shrinks on a thin link, scaleFor). */
  scaleNow(): number {
    return this.scaleApplied || this.want.scale;
  }

  private applyBitrate(): void {
    const p = this.producer;
    if (!p) return;
    if (p.fps && this.want.adaptFps) {
      const f = this.fpsNow();
      if (f !== this.appliedFps) {
        this.log(`frame rate ${f} fps`);
        this.appliedFps = f;
        p.fps(f);
      }
    }
    this.adaptScale();
    if (!p.bitrate) return;
    const b = this.bitrateNow();
    if (b <= 0 || (this.applied && Math.abs(b - this.applied) < this.applied * 0.03)) return;
    if (!this.applied || Math.abs(b - this.applied) >= this.applied * 0.3) this.log(`bitrate ${(b / 1e6).toFixed(2)} Mbps`);
    this.applied = b;
    p.bitrate(b);
  }

  /** A far lane's picture follows the bitrate (smaller on a thin link), with hysteresis: each change is a keyframe. */
  private adaptScale(): void {
    const p = this.producer;
    if (!p?.scale || !this.want.adaptScale || !this.gotKey) return;
    const target = scaleFor(this.bitrateNow(), this.want.scale);
    const cur = this.scaleNow();
    const now = Date.now();
    if (target < cur) {
      this.aboveSince = 0;
      if (!this.belowSince) this.belowSince = now;
      if (now - this.belowSince < SCALE_DOWN_MS) return;
    } else if (target > cur) {
      this.belowSince = 0;
      if (!this.aboveSince) this.aboveSince = now;
      if (now - this.aboveSince < SCALE_UP_MS) return;
    } else {
      this.belowSince = this.aboveSince = 0;
      return;
    }
    this.belowSince = this.aboveSince = 0;
    this.log(`picture ${cur}% -> ${target}% (${Math.round(this.bitrateNow() / 1000)} kbit/s)`);
    this.scaleApplied = target;
    p.scale(target);
  }

  requestKey(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastKeyReq < 200) return;
    if (this.keyPending && now - this.lastKeyReq < 50) return; // several viewers asking at once: one IDR is enough
    this.lastKeyReq = now;
    this.keyPending = true;
    this.producer?.key();
  }

  /** Called when a frame left for a viewer (capture -> sent timing). */
  noteSent(r: Rec): void {
    this.capToSent = ewma(this.capToSent, Date.now() - r.time);
  }

  /**
   * 2026-11-27: a decoded still of the newest picture (JPEG from phonecap, PNG from the mock), no older than maxAgeMs
   * (see CaptureStill.validAt), or null: the capture isn't Live or Still, the helper makes no stills, or none came in
   * timeoutMs. Never starts the capture (acquireCapture does) and never asks WebDriverAgent.
   */
  async still(maxAgeMs: number, timeoutMs = 1500): Promise<CaptureStill | null> {
    const s = this.captureState();
    if (s !== 'Live' && s !== 'Still') return null;
    const have = this.stillResult(maxAgeMs);
    if (have) return have;
    const p = this.producer;
    if (!p?.still) return null;
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        this.stillWaiters = this.stillWaiters.filter((x) => x !== done);
        resolve(false);
      }, timeoutMs);
      t.unref?.();
      const done = (v: boolean) => {
        clearTimeout(t);
        resolve(v);
      };
      this.stillWaiters.push(done);
      if (this.stillWaiters.length === 1) p.still!();
    });
    return ok ? this.stillResult(maxAgeMs) : null;
  }

  private stillResult(maxAgeMs: number): CaptureStill | null {
    const c = this.stillCache;
    const state = this.captureState();
    if (!c || (state !== 'Live' && state !== 'Still')) return null;
    if (c.time + 0.5 < this.lastSourceTime) return null; // a newer picture came since
    let validAt = c.time;
    const b = this.heartbeat();
    // a still screen: the last heartbeat after the picture said no newer device frame had come, so it still shows
    if (b && b.running && b.at > c.arrived && b.lastFrame > 0 && b.lastFrame <= c.time + 0.5) validAt = Math.max(validAt, b.at);
    const now = Date.now();
    if (now - validAt > maxAgeMs) return null;
    const mime = c.data[0] === 0x89 && c.data[1] === 0x50 ? 'image/png' : 'image/jpeg';
    return { data: c.data, mime, capturedAt: c.time, validAt, ageMs: now - validAt, state };
  }

  stats() {
    const ws = [...this.sinks].filter((v) => v.t.kind === 'ws').length;
    const rtc = [...this.sinks].filter((v) => v.t.kind === 'rtc');
    const encToSent = this.capToSent !== null && this.capToEnc !== null ? Math.max(0, this.capToSent - this.capToEnc) : null;
    const beat = this.heartbeat();
    return {
      running: this.running,
      fps: this.running ? this.meter.rate() : 0,
      encode_ms: round1(this.encodeMs),
      capture_to_encoded_ms: round1(this.capToEnc),
      encoded_to_sent_ms: round1(encToSent),
      capture_to_sent_ms: round1(this.capToSent),
      state: this.state(),
      viewers_ws: ws,
      viewers_rtc: rtc.length,
      path: rtc.map((v) => v.t.path?.() ?? null).find((p) => p) ?? null,
      ...netOf(rtc.map((v) => v.t.net?.() ?? null)),
      dropped: [...this.sinks].reduce((n, v) => n + v.dropped, 0),
      bitrate_kbps: this.running && this.applied ? Math.round(this.applied / 1000) : null,
      fps_target: this.running ? this.appliedFps || this.want.fps : null,
      scale: this.info?.scale ?? this.want.scale,
      kind: this.kind,
      width: this.info?.width ?? null,
      height: this.info?.height ?? null,
      // 2026-11-27: the state machine and the picture's true age
      capture: this.captureState(),
      capture_why: this.stateWhy(),
      source_age_ms: this.sourceAgeMs(),
      // the newest picture's age, as the regression contract and the clients name it (the same number)
      frame_age_ms: this.sourceAgeMs(),
      heartbeat_age_ms: beat ? Date.now() - beat.at : null,
      device_fps: beat ? beat.framesIn : null,
      repeats: this.repeats,
      holders: this.holders(),
      scale_now: this.scaleNow(),
    };
  }

  private start(): void {
    if (this.closed) return;
    if (this.stopping) {
      // Stopping completes before Starting: never a second helper on a screen device the first one still holds
      this.startAfterStop = true;
      return;
    }
    const gen = ++this.gen;
    this.gotKey = false;
    this.startedAt = Date.now();
    this.capturingAt = 0;
    this.reports = false;
    this.staleReason = null;
    this.beat = undefined;
    this.beatsSeen = false;
    this.notRunning = this.inWithoutOut = this.videoSinceBeat = 0;
    this.scaleApplied = 0;
    this.belowSince = this.aboveSince = 0;
    if (!this.waitingUnlock) this.attempts++;
    this.log(`starting capture (${this.want.fps} fps, ${this.want.scale}%, ${(this.want.bitrate / 1e6).toFixed(1)} Mbps${this.want.maxBitrate ? ` up to ${(this.want.maxBitrate / 1e6).toFixed(1)}` : ''})`);
    try {
      this.producer = this.startFn(this.want, {
        record: (r) => {
          if (gen === this.gen) this.onRecord(r);
        },
        exit: (reason) => {
          if (gen === this.gen) this.onExit(reason);
        },
        capturing: () => {
          if (gen !== this.gen || this.capturingAt) return;
          this.capturingAt = Date.now();
          // the first keyframe is due firstKeyMs from now (a call from inside startFn: armed just below)
          if (this.producer && !this.gotKey) this.armWatch(gen);
          this.notify();
        },
      });
    } catch (err) {
      this.onExit((err as Error).message);
      return;
    }
    this.reports = !!this.producer.reportsCapturing;
    this.applied = this.want.bitrate;
    this.appliedFps = this.want.fps;
    if (this.targets.size) this.applyBitrate();
    this.armWatch(gen);
    this.armTick(gen);
    this.notify();
  }

  /**
   * 2026-11-23, the root cause of iPhone-2 on "connecting" for good: a helper can run without ever giving a frame (a
   * CoreMediaIO screen device opened right after a replug, or before the phone is ready, runs its session without
   * handing over a buffer until it's opened again). Only an exit restarted a helper, and every open found the silent
   * one running and waited on it again. Now a capture with no keyframe firstKeyMs after its start is ended and
   * started over with backoff, counted as a failed start (3 in a row: given up for 60 s with the reason, then tried
   * again with the next viewer).
   */
  private armWatch(gen: number): void {
    this.clearWatch();
    // a helper that tells when it's capturing and hasn't yet: it may still be waiting for the phone's screen device
    const looking = this.reports && !this.capturingAt;
    const ms = looking ? this.deviceWaitMs : this.firstKeyMs;
    const secs = +(ms / 1000).toFixed(2);
    const t = setTimeout(() => {
      if (this.watch === t) this.watch = undefined;
      if (gen !== this.gen || this.gotKey || !this.producer) return;
      this.silent(
        looking
          ? `the capture helper found no screen to capture for this iPhone within ${secs} s; starting it over`
          : `no picture from the phone's screen within ${secs} s after the capture started (it ran without giving a frame); starting it over`,
      );
    }, ms);
    t.unref?.();
    this.watch = t;
  }

  private clearWatch(): void {
    if (this.watch) clearTimeout(this.watch);
    this.watch = undefined;
  }

  /** 2026-11-27: once a second while the helper runs: the heartbeat watch, Live <-> Still, a far lane's picture size. */
  private armTick(gen: number): void {
    this.clearTick();
    const t = setInterval(() => {
      if (gen !== this.gen || !this.producer) return this.clearTick();
      this.checkStale();
      if (this.producer) this.adaptScale();
      this.notify();
    }, Math.min(1000, Math.max(20, Math.floor(this.staleMs / 3))));
    t.unref?.();
    this.tickTimer = t;
  }

  private clearTick(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }

  /**
   * 2026-11-27: after its first picture a capture was never watched again: a CoreMediaIO session that died mid-stream,
   * or a helper that hung, ran on "silent" for good and every look at it showed an old picture. With heartbeats (a
   * newer phonecap) a still screen and a dead capture are told apart: no heartbeat for staleMs, a session that says
   * it isn't running, or frames handed over with none encoded for 3 heartbeats is Stale, and it's started over.
   */
  private checkStale(): void {
    if (!this.producer || !this.gotKey || !this.beatsSeen || !this.beat) return;
    const quiet = Date.now() - this.beat.at;
    if (quiet > this.staleMs) return this.stale(`the capture helper's heartbeat stopped ${Math.round(quiet / 100) / 10} s ago (it hung)`);
    if (this.notRunning >= 2) return this.stale('the capture session stopped running');
    if (this.inWithoutOut >= 3) return this.stale("the phone's screen hands frames to the helper but no picture comes out of its encoder");
  }

  /** End a capture that went stale after giving pictures; restarted with backoff (it isn't a failed start). */
  private stale(why: string): void {
    const p = this.producer;
    this.gen++;
    this.producer = undefined;
    this.clearWatch();
    this.clearTick();
    this.staleReason = why;
    this.log(`stale: ${why}; starting the capture over`);
    try {
      if (p?.restart) p.restart(why, true);
      else void p?.stop();
    } catch (err) {
      this.log(`ending the stale capture: ${(err as Error).message}`);
    }
    this.onExit(why, true);
  }

  /** End a capture that runs without giving a picture; it counts as a failed start (restart with backoff, give-up). */
  private silent(why: string): void {
    const p = this.producer;
    this.gen++; // its records and its exit no longer count
    this.producer = undefined;
    this.clearWatch();
    this.clearTick();
    this.log(`no keyframe ${Math.round((Date.now() - this.startedAt) / 100) / 10} s after the start: ending the silent capture`);
    try {
      if (p?.restart) p.restart(why);
      else void p?.stop();
    } catch (err) {
      this.log(`ending the silent capture: ${(err as Error).message}`);
    }
    this.onExit(why);
  }

  private onRecord(r: Rec): void {
    switch (r.kind) {
      case KIND.INFO: {
        try {
          const j = JSON.parse(r.payload.toString('utf8'));
          const was = this.info;
          this.info = { width: Number(j.width) || 0, height: Number(j.height) || 0, fps: Number(j.fps) || this.want.fps, scale: Number(j.scale) || this.want.scale };
          if (!was || was.width !== this.info.width || was.height !== this.info.height) {
            if (was) this.log(`picture ${was.width}x${was.height} -> ${this.info.width}x${this.info.height}`);
            for (const cb of [...this.infoSubs]) cb(this.info);
          }
        } catch {
          /* ignore a bad info record */
        }
        return;
      }
      case KIND.STATS: {
        try {
          const j = JSON.parse(r.payload.toString('utf8'));
          if (Number.isFinite(j.encode_ms)) this.encodeMs = j.encode_ms;
          if (Number.isFinite(j.capture_to_encoded_ms)) this.capToEnc = j.capture_to_encoded_ms;
        } catch {
          /* ignore */
        }
        return;
      }
      case KIND.BEAT:
        this.onBeat(r);
        return;
      case KIND.STILL: {
        this.stillCache = { data: r.payload, time: r.time, arrived: r.arrived };
        const ws = this.stillWaiters;
        this.stillWaiters = [];
        for (const w of ws) w(true);
        return;
      }
      case KIND.CONFIG:
        this.config = r;
        return;
      case KIND.KEY:
        this.key = r;
        this.keyPending = false;
        this.deltasSinceKey = 0;
        this.picture(r);
        if (!this.gotKey) {
          this.gotKey = true;
          this.waitingUnlock = false;
          this.staleReason = null;
          this.clearWatch();
          if (this.attempts > 1) this.log(`picture after ${this.attempts - 1} restart${this.attempts > 2 ? 's' : ''}`);
          this.attempts = 0;
          this.lastError = null;
        }
        this.failures = 0;
        this.meter.tick();
        if (this.info && this.waiters.length) {
          const ws = this.waiters;
          this.waiters = [];
          for (const w of ws) {
            if (w.timer) clearTimeout(w.timer);
            w.resolve(this.info);
          }
          // whoever waited adds its viewer now (which cancels this); a capture nobody joins (a warm-up, a viewer
          // that left while it started) stops after the idle time instead of running on unwatched
          this.maybeIdle();
        }
        this.notify();
        this.fanOut(r);
        return;
      case KIND.DELTA:
        this.deltasSinceKey++;
        if (!r.repeat) this.movedAt = Date.now();
        this.picture(r);
        this.meter.tick();
        if (this.lastState !== 'Live') this.notify();
        this.fanOut(r);
        return;
    }
  }

  /** A picture's accounting: a new one moves the source's time; an earlier one encoded again doesn't. */
  private picture(r: Rec): void {
    if (r.repeat) {
      this.repeats++;
      return;
    }
    this.srcFrames++;
    this.videoSinceBeat++;
    this.lastVideoAt = Date.now();
    if (r.time > this.lastSourceTime) this.lastSourceTime = r.time;
  }

  /** The helper's heartbeat (kind 7): its session runs, frames in and out, still looking for the screen. */
  private onBeat(r: Rec): void {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(r.payload.toString('utf8'));
    } catch {
      return;
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const b: Heartbeat = { at: r.arrived, running: j.running === true, finding: j.finding === true, framesIn: num(j.frames_in), framesOut: num(j.frames_out), lastFrame: num(j.last_frame) };
    this.beat = b;
    this.beatsSeen = true;
    this.devFrames += b.framesIn;
    this.notRunning = !b.running && !b.finding ? this.notRunning + 1 : 0;
    // frames handed over while this lane gave nothing new since the last heartbeat (a lane slower than the device
    // still encodes at least one of them a second)
    this.inWithoutOut = this.gotKey && b.framesIn > 0 && this.videoSinceBeat === 0 ? this.inWithoutOut + 1 : 0;
    this.videoSinceBeat = 0;
    trace('capture.beat', { udid: this.opts.udid, lane: this.label, running: b.running, finding: b.finding, framesIn: b.framesIn, framesOut: b.framesOut });
    this.checkStale();
    if (this.producer) this.notify();
  }

  /** Tell the state's listeners and settle openState() waiters when the state changed. */
  private notify(): void {
    const s = this.captureState();
    if (s === this.lastState) return;
    this.lastState = s;
    if (((s === 'Live' || s === 'Still') && this.info && this.key) || s === 'WaitingUnlock') {
      const ws = this.stateWaiters;
      this.stateWaiters = [];
      for (const w of ws) w.resolve({ state: s, info: s === 'WaitingUnlock' ? null : this.info ?? null });
      if (ws.length) this.maybeIdle();
    }
    const why = this.stateWhy();
    trace('capture.state', { udid: this.opts.udid, lane: this.label, state: s, why, ageMs: this.sourceAgeMs() });
    for (const cb of [...this.stateSubs]) {
      try {
        cb(s, why);
      } catch (err) {
        this.log(`a state listener failed: ${(err as Error).message}`);
      }
    }
  }

  /** One viewer's failure never stops the others (or the server). */
  private fanOut(r: Rec): void {
    for (const v of this.sinks) {
      try {
        v.deliver(r);
      } catch (err) {
        this.log(`viewer dropped: ${(err as Error).message}`);
        this.sinks.delete(v);
        try {
          v.t.fail('send failed');
        } catch {
          /* ignore */
        }
      }
    }
  }

  private onExit(reason: string, stale = false): void {
    this.producer = undefined;
    this.clearWatch();
    this.clearTick();
    this.movedAt = 0;
    this.info = this.config = this.key = undefined;
    this.lastError = reason;
    if (!stale) this.staleReason = null;
    this.log(`capture stopped: ${reason}`);
    const failedStart = !this.gotKey && !stale;
    // 2026-11-27: no picture because the phone is locked: wait for the unlock (quiet tries), burning no tries
    if (failedStart && this.wanted() && this.opts.locked?.() === true) {
      if (!this.waitingUnlock) this.log('no picture while the phone is locked: waiting for it to be unlocked (no tries counted)');
      this.waitingUnlock = true;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.wanted()) this.start();
        else {
          this.waitingUnlock = false;
          this.notify();
        }
      }, this.unlockRetryMs);
      this.restartTimer.unref?.();
      this.notify();
      return;
    }
    this.waitingUnlock = false;
    this.failures++;
    if (failedStart && this.failures >= 3) {
      this.brokenUntil = Date.now() + 60_000;
      this.failures = 0;
      this.log('giving up for 60 s; viewers fall back to MJPEG');
      this.notify();
      this.failAll(`H.264 capture failed: ${reason}`);
      return;
    }
    if (this.wanted()) {
      const delay = Math.min(30_000, 500 * 2 ** (this.failures - 1));
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.wanted()) this.start();
        else this.notify();
      }, delay);
    }
    this.notify();
  }

  private failAll(reason: string): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    const ss = this.stateWaiters;
    this.stateWaiters = [];
    for (const w of ss) w.reject(new Error(reason));
    const stills = this.stillWaiters;
    this.stillWaiters = [];
    for (const w of stills) w(false);
    const sinks = [...this.sinks];
    this.sinks.clear();
    for (const v of sinks) v.t.fail(reason);
  }

  private cancelIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
  }

  private maybeIdle(): void {
    if (this.wanted() || this.idle || !this.producer) return;
    this.idle = setTimeout(() => {
      this.idle = undefined;
      if (!this.wanted()) {
        this.log('no viewers for a while; stopping capture');
        this.stop();
      }
    }, this.idleMs);
    this.idle.unref?.();
  }

  private stop(): void {
    this.gen++;
    this.clearWatch();
    this.clearTick();
    const p = this.producer;
    this.producer = undefined;
    this.info = this.config = this.key = undefined;
    this.waitingUnlock = false;
    this.staleReason = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    let ended: void | Promise<void> = undefined;
    try {
      ended = p?.stop();
    } catch (err) {
      this.log(`stopping the capture: ${(err as Error).message}`);
    }
    if (isPromise(ended)) {
      // Stopping until the helper has exited (at most STOP_WAIT_MS: it was SIGKILLed by then)
      let t: NodeJS.Timeout | undefined;
      const cap = new Promise<void>((r) => {
        t = setTimeout(r, STOP_WAIT_MS);
        t.unref?.();
      });
      const done: Promise<void> = Promise.race([ended.catch(() => {}), cap]).then(() => {
        if (t) clearTimeout(t);
        if (this.stopping !== done) return;
        this.stopping = undefined;
        const again = this.startAfterStop;
        this.startAfterStop = false;
        this.notify();
        if (again && this.wanted()) this.ensure();
      });
      this.stopping = done;
    }
    this.notify();
  }

  close(reason = 'server shutting down'): void {
    this.cancelIdle();
    this.failAll(reason);
    this.stop();
    this.closed = true;
    this.holds.clear();
  }
}

/** phonecap's stderr line once its capture session runs (main.swift: `log("capturing <name> [<id>]")`). */
export const CAPTURING_LINE = /^phonecap: capturing /;

/** The helper's command line for its first lane (lane 0). */
export function helperArgs(want: H264Settings): string[] {
  return ['--fps', String(want.fps), '--scale', String(want.scale), '--bitrate', String(Math.round(want.bitrate)), '--key-seconds', String(want.keySeconds ?? 2)];
}

/** Runs the native helper (native/phonecap) and parses its stdout (lane 0 only: see src/lanes.ts for lanes). */
export function helperProducer(bin: string, args: string[], label: string): StartProducer {
  return (want, hooks) => {
    const full = [...args, ...helperArgs(want)];
    const p: ChildProcess = spawn(bin, full, { stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false;
    const exit = (why: string) => {
      if (done) return;
      done = true;
      hooks.exit(why);
    };
    const tail: string[] = [];
    // an older helper only has lane 0; a lanes helper run this way only gets lane 0 too (never its sound, kinds 5 and 6)
    const parser = new RecordParser((r) => (r.lane ?? 0) === 0 && r.kind !== 5 && r.kind !== 6 && hooks.record(r));
    p.stdout!.on('data', (c: Buffer) => {
      try {
        parser.push(c);
      } catch (err) {
        exit((err as Error).message);
        p.kill('SIGKILL');
      }
    });
    p.stderr!.on('data', (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/).filter(Boolean)) {
        console.log(`[phonecap ${label}] ${line}`);
        if (!done && CAPTURING_LINE.test(line)) hooks.capturing?.();
        tail.push(line.replace(/^phonecap:\s*/, ''));
        if (tail.length > 3) tail.shift();
      }
    });
    p.stdin!.on('error', () => {});
    let exited = false;
    const gone = new Promise<void>((resolve) => {
      p.once('exit', () => {
        exited = true;
        resolve();
      });
      p.once('error', () => resolve());
    });
    p.on('error', (err) => exit(`could not start the capture helper: ${err.message}`));
    p.on('exit', (code, sig) => exit(tail.length ? tail[tail.length - 1]! : `capture helper exited (${code ?? sig})`));
    return {
      reportsCapturing: true,
      key: () => {
        if (p.stdin!.writable) p.stdin!.write('key\n');
      },
      bitrate: (bps) => {
        if (p.stdin!.writable) p.stdin!.write(`bitrate ${Math.round(bps)}\n`);
      },
      still: (longSide) => {
        if (p.stdin!.writable) p.stdin!.write(longSide ? `still ${Math.round(longSide)}\n` : 'still\n');
      },
      // settles once the helper has exited (the source is Stopping until then)
      stop: () => {
        done = true;
        if (exited) return;
        if (p.stdin!.writable) p.stdin!.write('quit\n');
        p.kill('SIGTERM');
        setTimeout(() => !exited && p.kill('SIGKILL'), 1500).unref();
        return gone;
      },
    };
  };
}

/**
 * GET /phones `stats` for one phone from its H.264 source(s) (one per lane) and its MJPEG viewers. The top-level H.264
 * numbers are the busiest lane's (a far viewer's lane when only it runs); `lanes` has each running one.
 */
export function phoneStats(
  src: H264Source | H264Source[] | undefined,
  mjpeg: { fps: number; viewers: number },
  h264Reason: string | null,
  buildError: string | null = null,
): import('./types.js').StreamStats & { capture_state: string; capture: ReturnType<typeof captureSummary> } {
  const all = (Array.isArray(src) ? src : src ? [src] : []).map((s) => s.stats());
  const busy = all.filter((s) => s.viewers_ws + s.viewers_rtc > 0).sort((a, b) => b.viewers_ws + b.viewers_rtc - (a.viewers_ws + a.viewers_rtc));
  const h = busy[0] ?? all[0];
  const sum = (f: (s: (typeof all)[number]) => number) => busy.reduce((n, s) => n + f(s), 0);
  const viewersWs = sum((s) => s.viewers_ws);
  const viewersRtc = sum((s) => s.viewers_rtc);
  const h264Viewers = viewersWs + viewersRtc;
  const codec = h264Viewers ? 'h264' : mjpeg.viewers ? 'mjpeg' : null;
  // 2026-11-23: why there's no picture, from the busiest lane (else any lane that isn't off): "waiting for first frame
  // (restart 2)", "starting over (restart 1): ...", "gave up until ...: ...", "running" or "off"
  const captureState = (h && h.state !== 'off' ? h.state : all.map((s) => s.state).find((s) => s !== 'off')) ?? 'off';
  const out: import('./types.js').StreamStats = {
    codec,
    fps: codec === 'h264' ? h!.fps : codec === 'mjpeg' ? mjpeg.fps : null,
    encode_ms: h?.encode_ms ?? null,
    capture_to_encoded_ms: h?.capture_to_encoded_ms ?? null,
    encoded_to_sent_ms: h?.encoded_to_sent_ms ?? null,
    viewers: h264Viewers + mjpeg.viewers,
    viewers_webrtc: viewersRtc,
    viewers_h264_ws: viewersWs,
    viewers_mjpeg: mjpeg.viewers,
    path: busy.map((s) => s.path).find((p) => p) ?? null,
    rtt_ms: h?.rtt_ms ?? null,
    queue_ms: h?.queue_ms ?? null,
    dropped: all.reduce((n, s) => n + s.dropped, 0),
    bitrate_kbps: h?.bitrate_kbps ?? null,
    h264_available: h264Reason === null,
    h264_reason: h264Reason,
    lanes: busy.map((s) => ({
      kind: s.kind,
      fps: s.fps,
      fps_target: s.fps_target,
      scale: s.scale,
      width: s.width,
      height: s.height,
      bitrate_kbps: s.bitrate_kbps,
      viewers: s.viewers_ws + s.viewers_rtc,
      dropped: s.dropped,
      rtt_ms: s.rtt_ms,
      queue_ms: s.queue_ms,
    })),
    helper_build_error: buildError,
  };
  return Object.assign(out, { capture_state: captureState, capture: captureSummary(h) });
}

/**
 * 2026-11-27: the capture's state machine for GET /phones `stats.capture`, from the busiest lane: its state (Off,
 * Finding, Starting, Live, Still, Stale, Restarting, GaveUp, WaitingUnlock, Stopping), why (the bad ones), how old the
 * newest new picture is, the heartbeat's age and the device's frame rate (null: no heartbeat), who holds it on.
 */
function captureSummary(h: ReturnType<H264Source['stats']> | undefined) {
  return {
    state: h?.capture ?? 'Off',
    why: h?.capture_why ?? null,
    source_age_ms: h?.source_age_ms ?? null,
    heartbeat_age_ms: h?.heartbeat_age_ms ?? null,
    device_fps: h?.device_fps ?? null,
    repeats: h?.repeats ?? 0,
    holders: h?.holders ?? [],
  };
}
