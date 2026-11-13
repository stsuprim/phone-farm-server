import { ChildProcess, spawn } from 'node:child_process';
import { ScreenInfo } from './types.js';

/**
 * Live touch through Apple's CoreDevice HID path (docs/BEST_METHOD.md, plan item 1): one long-lived
 * native/hid/hid_input.py per phone, holding a touch session (the media-stream auth gate) open while someone is
 * viewing the phone, so a tap is one 58-byte report on an open connection instead of an XCTest round trip.
 *
 * off = no session (opened on the next hold or input); starting = opening; ready = touches go now;
 * failed = the last open failed (retried after `retryMs`, WDA takes the input meanwhile).
 */
export type HidState = 'off' | 'starting' | 'ready' | 'failed';

export interface HidReply {
  ok: boolean;
  error?: string;
  /** Receive -> report written, measured inside the sidecar. */
  ms?: number;
}

export type HidSpawn = (cmd: string, args: string[]) => ChildProcess;
const realSpawn: HidSpawn = (cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

export interface HidOptions {
  python: string;
  script: string;
  /** Close the touch session after this long with no viewer and no input (frees the phone's camera/mic). */
  idleMs: number;
  /** After a failed open, WDA takes the input for this long before HID is tried again. */
  retryMs: number;
  /** Extra sidecar arguments (tests: --mock). */
  extraArgs?: string[];
  spawn?: HidSpawn;
  log?: (m: string) => void;
  /** A queued path/type finished on the phone (its own receive -> done time). */
  onDone?: (op: string, reply: HidReply) => void;
}

const OPEN_TIMEOUT_MS = 30000;
const INPUT_TIMEOUT_MS = 5000;

/** Points (WDA's portrait space) -> the HID report's 0..65535 across the screen. */
export function toHid(x: number, y: number, s: ScreenInfo): [number, number] {
  const f = (v: number, size: number) => Math.max(0, Math.min(65535, Math.round((v / Math.max(1, size)) * 65535)));
  return [f(x, s.width), f(y, s.height)];
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
  private holders = 0;
  private idleTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private udid: string, private o: HidOptions) {}

  private log(m: string): void {
    (this.o.log ?? console.log)(`[hid ${this.udid.slice(-8)}] ${m}`);
  }

  /** Touches can go now. */
  ready(): boolean {
    return this.state === 'ready' && !this.closed;
  }

  /** Not inside a failure's back-off. */
  usable(): boolean {
    return !this.closed && (this.state !== 'failed' || Date.now() - this.failedAt >= this.o.retryMs);
  }

  /** Keep the session open while someone views the phone; returns the release. */
  hold(): () => void {
    this.holders++;
    this.kick();
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

  /** One input on the open session; throws if HID isn't ready or the phone refused it. */
  async input(op: 'down' | 'move' | 'up' | 'tap' | 'path' | 'type', fields: Record<string, unknown>): Promise<HidReply> {
    if (!this.ready()) throw new Error(`HID is ${this.state}${this.reason ? `: ${this.reason}` : ''}`);
    this.touchIdle();
    const r = await this.send(op, fields, INPUT_TIMEOUT_MS);
    if (!r.ok) throw new Error(r.error || `HID ${op} failed`);
    return r;
  }

  private fail(why: string): void {
    this.state = 'failed';
    this.failedAt = Date.now();
    if (this.reason !== why) this.log(`unavailable, WDA takes the input: ${why}`);
    this.reason = why;
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
      if (this.state === 'ready') this.state = 'off';
      if (typeof m.why === 'string' && m.why.startsWith('error')) this.log(`touch session closed (${m.why})`);
      return;
    }
    if (m.ev === 'done') {
      this.o.onDone?.(String(m.op ?? ''), reply);
      if (!reply.ok) this.log(`queued input failed on the phone: ${reply.error ?? 'unknown'}`);
      return;
    }
    if (m.ev) return; // hello, open
    const id = typeof m.id === 'number' ? m.id : NaN;
    const w = this.pending.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    this.pending.delete(id);
    w.resolve(reply);
  }

  private send(op: string, fields: Record<string, unknown>, timeoutMs: number): Promise<HidReply> {
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
        reject(new Error(`no answer from the HID helper within ${Math.round(timeoutMs / 1000)} s (${op})`));
        // a stuck helper: start over (the next input reopens)
        if (op !== 'close' && this.proc === p) {
          this.state = 'failed';
          this.failedAt = Date.now();
          this.reason = `HID ${op} timed out`;
          p.kill('SIGKILL');
        }
      }, timeoutMs);
      this.pending.set(id, { op, resolve, reject, timer });
      p.stdin?.write(`${JSON.stringify({ ...fields, id, op })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
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
