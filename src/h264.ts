import { ChildProcess, spawn } from 'node:child_process';

/**
 * H.264 live view: one capture helper (native/phonecap, or the mock) per phone, shared by every viewer.
 *
 * Helper -> server framing (stdout), one record after another:
 *   1 byte kind | 8 bytes capture time (float64 BE, ms since the epoch) | 4 bytes payload length (uint32 BE) | payload
 * Kinds: 0 info (JSON {width, height, fps, scale?}), 1 config (SPS+PPS, Annex B), 2 keyframe (Annex B),
 *        3 delta (Annex B), 4 stats (JSON {encode_ms, capture_to_encoded_ms}).
 * Server -> helper (stdin): "key\n" forces an IDR now, "quit\n" exits.
 *
 * Server -> WebSocket viewer: the same record minus the length: 1 byte kind (1/2/3) | 8 bytes time | payload.
 */
export const KIND = { INFO: 0, CONFIG: 1, KEY: 2, DELTA: 3, STATS: 4 } as const;
const HEADER = 13;
const MAX_PAYLOAD = 32 * 1024 * 1024;

export interface Rec {
  kind: number;
  time: number; // capture time, ms since the epoch (server clock)
  payload: Buffer;
  arrived: number; // Date.now() when the server got it
  msg?: Buffer; // cached WebSocket message
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
      const kind = head[0]!;
      const size = head.readUInt32BE(9);
      if (kind > 4 || size > MAX_PAYLOAD) throw new Error(`bad record from the capture helper (kind ${kind}, ${size} bytes)`);
      if (this.len < HEADER + size) return;
      const all = this.take(HEADER + size);
      this.onRecord({ kind, time: all.readDoubleBE(1), payload: all.subarray(HEADER), arrived: Date.now() });
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
  bitrate: number; // bits per second
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
}
export interface Producer {
  key(): void;
  stop(): void;
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
  send(r: Rec): void;
  fail(reason: string): void;
  path?(): string | null;
}

const DROP_FLOOR = 256 * 1024;

/**
 * One viewer. Latest-only: when the transport is backed up, deltas are dropped until the next keyframe
 * (and one is asked for); nothing is ever queued here. Config always goes out right before a keyframe.
 */
export class H264Viewer {
  needKey = true;
  dropped = 0;
  private sentConfig?: Buffer;
  private lastAsk = 0;
  constructor(readonly t: Transport, private src: H264Source) {}

  private over(): boolean {
    const keySize = this.src.key?.payload.length ?? 0;
    return this.t.buffered() > Math.max(DROP_FLOOR, keySize * 1.5);
  }

  private ask(): void {
    const now = Date.now();
    if (now - this.lastAsk < 1000) return;
    this.lastAsk = now;
    this.src.requestKey(true);
  }

  /** First frames for a new viewer: the cached config + keyframe right away. `stale` = deltas followed it. */
  prime(config: Rec | undefined, key: Rec | undefined, stale: boolean): void {
    if (key && this.t.open()) {
      this.sendKey(config, key);
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
        return;
      }
      if (this.over()) {
        this.needKey = true;
        this.dropped++;
        this.ask();
        return;
      }
      this.t.send(r);
      this.src.noteSent(r);
    }
  }

  /** The client asked for a keyframe (decoder reset, PLI/FIR): skip deltas until it comes. */
  forceKey(): void {
    this.needKey = true;
    this.src.requestKey(true);
  }

  private sendKey(config: Rec | undefined, key: Rec): void {
    if (config && !(this.sentConfig && this.sentConfig.equals(config.payload))) {
      this.t.send(config);
      this.sentConfig = config.payload;
    }
    this.t.send(key);
    this.src.noteSent(key);
  }
}

export interface SourceOptions {
  idleMs?: number; // stop the helper this long after the last viewer leaves
  openTimeoutMs?: number; // give up on the first keyframe after this long
  log?: (m: string) => void;
}

/** One capture helper per phone, started on demand, shared, restarted with backoff, stopped when idle. */
export class H264Source {
  info?: H264Info;
  config?: Rec;
  key?: Rec;
  private deltasSinceKey = 0;
  private producer?: Producer;
  private gen = 0;
  private sinks = new Set<H264Viewer>();
  private waiters: { resolve: (i: H264Info) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private idle?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private failures = 0;
  private gotKey = false;
  private brokenUntil = 0;
  private lastKeyReq = 0;
  private keyPending = false;
  lastError: string | null = null;
  private meter = new RateMeter();
  private encodeMs: number | null = null;
  private capToEnc: number | null = null;
  private capToSent: number | null = null;
  private idleMs: number;
  private openTimeoutMs: number;
  private log: (m: string) => void;

  constructor(private label: string, private startFn: StartProducer, private want: H264Settings, opts: SourceOptions = {}) {
    this.idleMs = opts.idleMs ?? 10_000;
    this.openTimeoutMs = opts.openTimeoutMs ?? 8_000;
    this.log = opts.log ?? ((m) => console.log(`[h264 ${label}] ${m}`));
  }

  get running(): boolean {
    return !!this.producer;
  }
  get viewers(): number {
    return this.sinks.size;
  }

  /** Why new viewers can't use H.264 right now (the helper kept failing), else null. */
  unavailable(): string | null {
    return Date.now() < this.brokenUntil ? `H.264 capture failed: ${this.lastError ?? 'unknown error'}` : null;
  }

  /** Settings for the next start; a running helper keeps its settings (it's shared). */
  setWant(w: H264Settings): void {
    if (!this.producer) this.want = { ...w };
  }

  /** Make sure the helper runs; resolves once a keyframe (and the size) is known. */
  open(): Promise<H264Info> {
    this.cancelIdle();
    if (this.info && this.key) return Promise.resolve(this.info);
    const p = new Promise<H264Info>((resolve, reject) => {
      const w = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error(this.lastError ? `H.264 capture did not start: ${this.lastError}` : `no H.264 keyframe within ${this.openTimeoutMs / 1000}s`));
          this.maybeIdle();
        }, this.openTimeoutMs),
      };
      this.waiters.push(w);
    });
    if (!this.producer && !this.restartTimer) this.start();
    return p;
  }

  add(v: H264Viewer): void {
    this.sinks.add(v);
    this.cancelIdle();
    const stale = this.deltasSinceKey > 0;
    v.prime(this.config, this.key, stale);
    if (stale || !this.key) this.requestKey(true);
  }

  remove(v: H264Viewer): void {
    if (this.sinks.delete(v)) this.maybeIdle();
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

  stats() {
    const ws = [...this.sinks].filter((v) => v.t.kind === 'ws').length;
    const rtc = [...this.sinks].filter((v) => v.t.kind === 'rtc');
    const encToSent = this.capToSent !== null && this.capToEnc !== null ? Math.max(0, this.capToSent - this.capToEnc) : null;
    return {
      running: this.running,
      fps: this.running ? this.meter.rate() : 0,
      encode_ms: round1(this.encodeMs),
      capture_to_encoded_ms: round1(this.capToEnc),
      encoded_to_sent_ms: round1(encToSent),
      capture_to_sent_ms: round1(this.capToSent),
      viewers_ws: ws,
      viewers_rtc: rtc.length,
      path: rtc.map((v) => v.t.path?.() ?? null).find((p) => p) ?? null,
      dropped: [...this.sinks].reduce((n, v) => n + v.dropped, 0),
      width: this.info?.width ?? null,
      height: this.info?.height ?? null,
    };
  }

  private start(): void {
    const gen = ++this.gen;
    this.gotKey = false;
    this.log(`starting capture (${this.want.fps} fps, ${this.want.scale}%, ${(this.want.bitrate / 1e6).toFixed(1)} Mbps)`);
    try {
      this.producer = this.startFn(this.want, {
        record: (r) => {
          if (gen === this.gen) this.onRecord(r);
        },
        exit: (reason) => {
          if (gen === this.gen) this.onExit(reason);
        },
      });
    } catch (err) {
      this.onExit((err as Error).message);
    }
  }

  private onRecord(r: Rec): void {
    switch (r.kind) {
      case KIND.INFO: {
        try {
          const j = JSON.parse(r.payload.toString('utf8'));
          this.info = { width: Number(j.width) || 0, height: Number(j.height) || 0, fps: Number(j.fps) || this.want.fps, scale: Number(j.scale) || this.want.scale };
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
      case KIND.CONFIG:
        this.config = r;
        return;
      case KIND.KEY:
        this.key = r;
        this.keyPending = false;
        this.deltasSinceKey = 0;
        this.gotKey = true;
        this.failures = 0;
        this.meter.tick();
        if (this.info) {
          const ws = this.waiters;
          this.waiters = [];
          for (const w of ws) {
            clearTimeout(w.timer);
            w.resolve(this.info);
          }
        }
        this.fanOut(r);
        return;
      case KIND.DELTA:
        this.deltasSinceKey++;
        this.meter.tick();
        this.fanOut(r);
        return;
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

  private onExit(reason: string): void {
    this.producer = undefined;
    this.info = this.config = this.key = undefined;
    this.lastError = reason;
    this.failures++;
    this.log(`capture stopped: ${reason}`);
    if (!this.gotKey && this.failures >= 3) {
      this.brokenUntil = Date.now() + 60_000;
      this.failures = 0;
      this.log('giving up for 60 s; viewers fall back to MJPEG');
      this.failAll(`H.264 capture failed: ${reason}`);
      return;
    }
    if (this.sinks.size || this.waiters.length) {
      const delay = Math.min(30_000, 500 * 2 ** (this.failures - 1));
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.sinks.size || this.waiters.length) this.start();
      }, delay);
    }
  }

  private failAll(reason: string): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    const sinks = [...this.sinks];
    this.sinks.clear();
    for (const v of sinks) v.t.fail(reason);
  }

  private cancelIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
  }

  private maybeIdle(): void {
    if (this.sinks.size || this.waiters.length || this.idle || !this.producer) return;
    this.idle = setTimeout(() => {
      this.idle = undefined;
      if (!this.sinks.size && !this.waiters.length) {
        this.log('no viewers for a while; stopping capture');
        this.stop();
      }
    }, this.idleMs);
    this.idle.unref?.();
  }

  private stop(): void {
    this.gen++;
    this.producer?.stop();
    this.producer = undefined;
    this.info = this.config = this.key = undefined;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  close(reason = 'server shutting down'): void {
    this.cancelIdle();
    this.failAll(reason);
    this.stop();
  }
}

/** Runs the native helper (native/phonecap) and parses its stdout. */
export function helperProducer(bin: string, args: string[], label: string): StartProducer {
  return (want, hooks) => {
    const full = [...args, '--fps', String(want.fps), '--scale', String(want.scale), '--bitrate', String(want.bitrate)];
    const p: ChildProcess = spawn(bin, full, { stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false;
    const exit = (why: string) => {
      if (done) return;
      done = true;
      hooks.exit(why);
    };
    const tail: string[] = [];
    const parser = new RecordParser(hooks.record);
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
        tail.push(line.replace(/^phonecap:\s*/, ''));
        if (tail.length > 3) tail.shift();
      }
    });
    p.stdin!.on('error', () => {});
    p.on('error', (err) => exit(`could not start the capture helper: ${err.message}`));
    p.on('exit', (code, sig) => exit(tail.length ? tail[tail.length - 1]! : `capture helper exited (${code ?? sig})`));
    return {
      key: () => {
        if (p.stdin!.writable) p.stdin!.write('key\n');
      },
      stop: () => {
        done = true;
        if (p.stdin!.writable) p.stdin!.write('quit\n');
        p.kill('SIGTERM');
        setTimeout(() => p.kill('SIGKILL'), 1500).unref();
      },
    };
  };
}

/** GET /phones `stats` for one phone from its H.264 source (if any) and its MJPEG viewers. */
export function phoneStats(
  src: H264Source | undefined,
  mjpeg: { fps: number; viewers: number },
  h264Reason: string | null,
): import('./types.js').StreamStats {
  const h = src?.stats();
  const h264Viewers = h ? h.viewers_ws + h.viewers_rtc : 0;
  const codec = h264Viewers ? 'h264' : mjpeg.viewers ? 'mjpeg' : null;
  return {
    codec,
    fps: codec === 'h264' ? h!.fps : codec === 'mjpeg' ? mjpeg.fps : null,
    encode_ms: h?.encode_ms ?? null,
    capture_to_encoded_ms: h?.capture_to_encoded_ms ?? null,
    encoded_to_sent_ms: h?.encoded_to_sent_ms ?? null,
    viewers: h264Viewers + mjpeg.viewers,
    viewers_webrtc: h?.viewers_rtc ?? 0,
    viewers_h264_ws: h?.viewers_ws ?? 0,
    viewers_mjpeg: mjpeg.viewers,
    path: h?.path ?? null,
    dropped: h?.dropped ?? 0,
    h264_available: h264Reason === null,
    h264_reason: h264Reason,
  };
}
