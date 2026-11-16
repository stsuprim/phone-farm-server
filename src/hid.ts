import { ChildProcess, spawn } from 'node:child_process';
import { Orientation, pointsToHid } from './orient.js';
import { ScreenInfo } from './types.js';

/**
 * Live touch through Apple's CoreDevice HID path (docs/BEST_METHOD.md, plan item 1): one long-lived
 * native/hid/hid_input.py per phone, holding a touch session (the media-stream auth gate) open while someone is
 * viewing the phone, so a tap is one 58-byte report on an open connection instead of an XCTest round trip.
 *
 * off = no session (opened on the next hold or input); starting = opening; ready = touches go now;
 * failed = the last open failed (WDA takes the input meanwhile). A failure reconnects by itself: a session that
 * broke under a touch reopens at once, and a failed open is tried again after 1 s, 2 s, 5 s, 15 s, 30 s, then every
 * `retryMs`, for as long as someone is viewing the phone (and on the next input otherwise).
 */
export type HidState = 'off' | 'starting' | 'ready' | 'failed';

export interface HidReply {
  ok: boolean;
  error?: string;
  /** Receive -> report written, measured inside the sidecar. */
  ms?: number;
  /** This is a queued path's or text's end on the phone (the sidecar's {"ev": "done"}), not its "queued" answer. */
  done?: boolean;
}

export type HidSpawn = (cmd: string, args: string[]) => ChildProcess;
const realSpawn: HidSpawn = (cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

export interface HidOptions {
  python: string;
  script: string;
  /** Close the touch session after this long with no viewer and no input (frees the phone's camera/mic). */
  idleMs: number;
  /** The longest wait between tries after failed opens (the first ones come sooner: `backoffMs`). */
  retryMs: number;
  /** The waits after the 1st, 2nd... failed open in a row (default 1 s, 2 s, 5 s, 15 s, 30 s), then `retryMs`. */
  backoffMs?: number[];
  /** Extra sidecar arguments (tests: --mock). */
  extraArgs?: string[];
  spawn?: HidSpawn;
  log?: (m: string) => void;
  /** A queued path/type finished on the phone (its own receive -> done time). */
  onDone?: (op: string, reply: HidReply) => void;
  /** How long one input may take to be answered (default 5 s; tests shorten it). */
  inputTimeoutMs?: number;
}

const OPEN_TIMEOUT_MS = 30000;
const INPUT_TIMEOUT_MS = 5000;

const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];

/**
 * Upright points (WDA's space, as the phone is turned) -> the HID report's 0..65535 across the panel (the glass as
 * held in portrait): in landscape the touch is turned back onto the panel (src/orient.ts).
 */
export function toHid(x: number, y: number, s: ScreenInfo, o: Orientation | null = 'portrait'): [number, number] {
  return pointsToHid(x, y, s, o);
}

/** The iOS major version from "27.0.1" (0 if unknown). */
export function iosMajor(v: string | null | undefined): number {
  const n = Number.parseInt(String(v ?? '').split('.')[0] ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

/** Only what the HID keyboard can type (printable ASCII, newline, tab); anything else goes through WDA. */
export function hidTypable(text: string): boolean {
  return /^[\x20-\x7e\n\t]*$/.test(text);
}

interface Pending {
  op: string;
  resolve: (r: HidReply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** Its answer is the sidecar's {"ev": "done"} (the path or text finished on the phone), not the "queued" one. */
  done: boolean;
}

/** No answer came in time: the input may or may not have reached the phone. */
export class HidTimeout extends Error {}
/** A queued path or text broke off while the phone was playing it: part of it happened. */
export class HidPartial extends Error {}

/** The sidecar's typing pace: three reports and 50 ms a key, 20 ms more with Shift (native/hid/hid_input.py). */
const TYPE_MS_PER_KEY = 70;

/**
 * How long the phone plays an input after the sidecar answered "queued" (ms): a path its last point's time, text its
 * keys, a tap its short hold; the sidecar does one thing at a time, so whatever is sent next waits that long.
 */
export function hidPlayMs(op: string, fields: Record<string, unknown>): number {
  if (op === 'path' && Array.isArray(fields.points)) {
    const last = fields.points[fields.points.length - 1] as unknown;
    const t = Array.isArray(last) ? Number(last[2]) : 0;
    return Number.isFinite(t) && t > 0 ? Math.min(t, 120_000) : 0;
  }
  if (op === 'type' && typeof fields.text === 'string') return fields.text.length * TYPE_MS_PER_KEY;
  if (op === 'tap') {
    const h = Number(fields.hold_ms);
    return Number.isFinite(h) && h > 0 ? Math.min(h, 2000) : 40;
  }
  return 0;
}

export class HidHost {
  state: HidState = 'off';
  /** Why HID isn't taking input (the last failure), or null. */
  reason: string | null = null;
  /** The last session open's time in ms (tunnel + auth gate), for the stats. */
  openMs: number | null = null;
  private proc?: ChildProcess;
  private buf = '';
  private errTail: string[] = [];
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private openP?: Promise<void>;
  private failedAt = 0;
  private fails = 0; // failed opens in a row
  private retryTimer?: NodeJS.Timeout;
  /** Times the session came back after a failure (stats). */
  reconnects = 0;
  private holders = 0;
  private idleTimer?: NodeJS.Timeout;
  private closed = false;
  /** Until when the sidecar is playing what it was already given (Date.now()): what's sent next waits behind it. */
  private busyUntil = 0;
  /** Paths and texts answered "queued" whose end the sidecar hasn't said yet. */
  private playing = 0;

  constructor(private udid: string, private o: HidOptions) {}

  private log(m: string): void {
    (this.o.log ?? console.log)(`[hid ${this.udid.slice(-8)}] ${m}`);
  }

  /** A live view is holding the session open (hold()). */
  get held(): boolean {
    return this.holders > 0;
  }

  /** Touches can go now. */
  ready(): boolean {
    return this.state === 'ready' && !this.closed;
  }

  /** The wait after the latest failed open. */
  private backoff(): number {
    const steps = this.o.backoffMs ?? BACKOFF_MS;
    return Math.min(this.o.retryMs, (this.fails >= 1 && this.fails <= steps.length ? steps[this.fails - 1] : undefined) ?? this.o.retryMs);
  }

  /** Not inside a failure's back-off. */
  usable(): boolean {
    return !this.closed && (this.state !== 'failed' || Date.now() - this.failedAt >= this.backoff());
  }

  /** Keep the session open while someone views the phone; returns the release. */
  hold(): () => void {
    this.holders++;
    this.kick();
    if (this.state === 'failed') this.retryLater();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.holders = Math.max(0, this.holders - 1);
      this.touchIdle();
    };
  }

  /** Open in the background if it's worth trying (the caller uses WDA for now). */
  kick(): void {
    if (this.state === 'ready' || this.state === 'starting' || !this.usable()) return;
    this.open().catch(() => {});
  }

  open(): Promise<void> {
    if (this.ready()) return Promise.resolve();
    if (this.openP) return this.openP;
    this.state = 'starting';
    const t0 = Date.now();
    this.openP = this.send('open', {}, OPEN_TIMEOUT_MS)
      .then((r) => {
        if (!r.ok) throw new Error(r.error || 'the HID session did not open');
        this.state = 'ready';
        if (this.fails || this.reason) this.reconnects++;
        this.fails = 0;
        this.reason = null;
        this.openMs = Date.now() - t0;
        this.log(`touch session open in ${this.openMs} ms`);
        this.touchIdle();
      })
      .catch((err: Error) => {
        this.fail(err.message);
        throw err;
      })
      .finally(() => {
        this.openP = undefined;
      });
    return this.openP;
  }

  /**
   * One input on the open session; throws if HID isn't ready or the phone refused it (HidTimeout when no answer came:
   * it may or may not have happened). A path or text is answered once it's queued; with `done` the answer is its end
   * on the phone instead (the text typed, the gesture lifted). The sidecar plays one thing at a time, so an input sent
   * while a path or text still plays gets that much longer to answer (it used to time out behind a long hold, which
   * killed the sidecar mid-gesture).
   */
  async input(op: 'down' | 'move' | 'up' | 'tap' | 'path' | 'type', fields: Record<string, unknown>, opts: { done?: boolean } = {}): Promise<HidReply> {
    if (!this.ready()) throw new Error(`HID is ${this.state}${this.reason ? `: ${this.reason}` : ''}`);
    this.touchIdle();
    const now = Date.now();
    const start = Math.max(now, this.busyUntil);
    const play = hidPlayMs(op, fields);
    if (play) this.busyUntil = start + play;
    const queued = op === 'path' || op === 'type';
    let r: HidReply;
    try {
      r = await this.send(op, fields, (this.o.inputTimeoutMs ?? INPUT_TIMEOUT_MS) + (start - now) + (opts.done ? play : 0), !!opts.done);
    } catch (err) {
      this.busyUntil = Math.max(Date.now(), this.busyUntil - play);
      throw err;
    }
    if (!r.ok) {
      this.busyUntil = Math.max(Date.now(), this.busyUntil - play); // it isn't playing (any more)
      throw new (r.done ? HidPartial : Error)(r.error || `HID ${op} failed`);
    }
    // queued and playing: its {"ev": "done"} says when the sidecar is free again (sooner or later than reckoned)
    if (queued && !r.done) this.playing++;
    return r;
  }

  private fail(why: string): void {
    // one failure is often reported twice (the helper's exit, then the pending open's rejection): count it once
    const again = this.state === 'failed' && Date.now() - this.failedAt < 250;
    this.state = 'failed';
    this.failedAt = Date.now();
    if (!again) this.fails++;
    if (this.reason !== why) this.log(`unavailable, WDA takes the input: ${why}`);
    this.reason = why;
    this.retryLater();
  }

  /** While someone views the phone, a failed session is opened again by itself after the back-off. */
  private retryLater(): void {
    if (this.retryTimer || this.closed || this.holders <= 0) return;
    const wait = Math.max(50, this.failedAt + this.backoff() - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.closed || this.holders <= 0 || this.state !== 'failed') return;
      this.open().catch(() => {});
    }, wait);
    this.retryTimer.unref?.();
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.holders > 0 || this.state !== 'ready') return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.holders > 0 || this.state !== 'ready') return;
      this.state = 'off';
      this.log('no viewer: touch session closed');
      this.send('close', {}, INPUT_TIMEOUT_MS).catch(() => {});
    }, this.o.idleMs);
    this.idleTimer.unref?.();
  }

  private ensureProc(): ChildProcess {
    if (this.proc) return this.proc;
    const args = [this.o.script, '--udid', this.udid, ...(this.o.extraArgs ?? [])];
    const p = (this.o.spawn ?? realSpawn)(this.o.python, args);
    this.proc = p;
    this.buf = '';
    this.errTail = [];
    p.stdout?.setEncoding('utf8');
    p.stdout?.on('data', (d: string) => this.onData(d));
    p.stderr?.on('data', (d: Buffer) => {
      this.errTail.push(...d.toString().split(/\r?\n/).filter(Boolean));
      if (this.errTail.length > 5) this.errTail.splice(0, this.errTail.length - 5);
    });
    p.stdin?.on('error', () => {});
    p.on('error', (err) => this.onExit(p, `could not start ${this.o.python}: ${err.message}`));
    p.on('exit', (code) => this.onExit(p, `the HID helper exited (${code})${this.errTail.length ? `: ${this.errTail.join(' | ').slice(0, 300)}` : ''}`));
    return p;
  }

  private onExit(p: ChildProcess, why: string): void {
    if (this.proc !== p) return;
    this.proc = undefined;
    this.busyUntil = 0;
    this.playing = 0;
    for (const [id, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(new Error(why));
      this.pending.delete(id);
    }
    if (!this.closed && this.state !== 'failed') this.fail(why);
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(m);
    }
  }

  private onMessage(m: Record<string, unknown>): void {
    const reply: HidReply = { ok: m.ok === true, ms: typeof m.ms === 'number' ? m.ms : undefined };
    if (typeof m.error === 'string') reply.error = m.error;
    if (m.ev === 'fatal') {
      this.fail(String(m.error ?? 'the HID helper stopped'));
      return;
    }
    if (m.ev === 'closed') {
      const broke = typeof m.why === 'string' && m.why.startsWith('error');
      if (this.state === 'ready') {
        this.state = 'off';
        if (broke) this.reason = `the touch session broke (${m.why})`;
      }
      if (broke) {
        this.log(`touch session closed (${m.why})${this.holders > 0 ? '; reconnecting' : ''}`);
        // it broke under an input (that gesture went to WDA): open a new one now for the next
        if (this.holders > 0 && !this.closed) setImmediate(() => !this.closed && this.state === 'off' && this.open().catch(() => {}));
      }
      return;
    }
    const id = typeof m.id === 'number' ? m.id : NaN;
    if (m.ev === 'done') {
      reply.done = true;
      if (this.playing > 0 && !this.pending.get(id)?.done && --this.playing === 0) this.busyUntil = 0; // nothing left playing
      this.o.onDone?.(String(m.op ?? ''), reply);
      if (!reply.ok) this.log(`queued input failed on the phone: ${reply.error ?? 'unknown'}`);
      const waiting = this.pending.get(id);
      if (waiting?.done) {
        clearTimeout(waiting.timer);
        this.pending.delete(id);
        waiting.resolve(reply);
      }
      return;
    }
    if (m.ev) return; // hello, open
    const w = this.pending.get(id);
    if (!w) return;
    if (w.done && reply.ok) return; // queued: its "done" is the answer
    clearTimeout(w.timer);
    this.pending.delete(id);
    w.resolve(reply);
  }

  private send(op: string, fields: Record<string, unknown>, timeoutMs: number, done = false): Promise<HidReply> {
    if (this.closed) return Promise.reject(new Error('closed'));
    let p: ChildProcess;
    try {
      p = this.ensureProc();
    } catch (err) {
      return Promise.reject(err as Error);
    }
    const id = this.nextId++;
    return new Promise<HidReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HidTimeout(`no answer from the HID helper within ${Math.round(timeoutMs / 1000)} s (${op})`));
        // a stuck helper: start over (the next input reopens)
        if (op !== 'close' && this.proc === p) {
          this.fail(`HID ${op} timed out`);
          p.kill('SIGKILL');
        }
      }, timeoutMs);
      this.pending.set(id, { op, resolve, reject, timer, done });
      p.stdin?.write(`${JSON.stringify({ ...fields, id, op })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const p = this.proc;
    this.proc = undefined;
    for (const w of this.pending.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('closed'));
    }
    this.pending.clear();
    if (p) {
      try {
        p.stdin?.end(`${JSON.stringify({ id: 0, op: 'quit' })}\n`);
      } catch {
        /* gone */
      }
      const t = setTimeout(() => p.kill('SIGTERM'), 2000);
      t.unref?.();
    }
    this.state = 'off';
  }
}
