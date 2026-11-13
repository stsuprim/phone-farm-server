/**
 * Server-side input latency, per phone: receive -> start (waiting in the phone's queue) -> injected (handed to the
 * phone's input channel: the HID report written, or WDA's fast route queued it, or the old WDA route finished).
 * Logged one line per action (INPUT_LOG=0 turns the lines off) and kept for GET /phones/:udid/input and the
 * `input` part of GET /phones' stats.
 */

/** How an action reached the phone: hid (CoreDevice HID), wda-fast (patched WDA route), wda (the old XCTest route). */
export type InputVia = 'hid' | 'wda-fast' | 'wda' | 'mock' | 'buffered';

export interface InputResult {
  via: InputVia;
}

export interface InputSample {
  at: number; // Date.now() when it was received
  type: string; // tap, swipe, path, hold, type, home, launch, touch-down, touch-move, touch-up, gesture
  via: InputVia | null;
  ok: boolean;
  wait_ms: number; // receive -> its turn in the phone's queue
  inject_ms: number; // its turn -> injected/queued on the phone
  total_ms: number; // receive -> injected
  error?: string;
}

export interface InputStats {
  /** How the last action went. */
  via: InputVia | null;
  /** Average receive -> injected of the last taps (and touch downs), ms. */
  tap_avg_ms: number | null;
  tap_p90_ms: number | null;
  /** The last action. */
  last: InputSample | null;
  samples: number;
}

const KEEP = 100;
const round = (v: number) => Math.round(v * 10) / 10;

export class InputMeter {
  private rows = new Map<string, InputSample[]>();

  constructor(private logLines = process.env.INPUT_LOG !== '0') {}

  add(udid: string, s: InputSample): void {
    let r = this.rows.get(udid);
    if (!r) this.rows.set(udid, (r = []));
    r.push(s);
    if (r.length > KEEP) r.splice(0, r.length - KEEP);
    if (this.logLines && s.type !== 'touch-move') {
      const what = s.ok ? `via ${s.via ?? '?'}` : `FAILED${s.via ? ` (${s.via})` : ''}: ${s.error ?? ''}`;
      console.log(`[input ${udid.slice(-8)}] ${s.type} ${what}: wait ${round(s.wait_ms)} ms + inject ${round(s.inject_ms)} ms = ${round(s.total_ms)} ms (receive -> injected)`);
    }
  }

  recent(udid: string): InputSample[] {
    return [...(this.rows.get(udid) ?? [])];
  }

  stats(udid: string): InputStats {
    const r = this.rows.get(udid) ?? [];
    const taps = r.filter((s) => s.ok && (s.type === 'tap' || s.type === 'touch-down')).map((s) => s.total_ms).slice(-20);
    const sorted = [...taps].sort((a, b) => a - b);
    const last = r[r.length - 1] ?? null;
    return {
      via: last?.via ?? null,
      tap_avg_ms: taps.length ? round(taps.reduce((a, b) => a + b, 0) / taps.length) : null,
      tap_p90_ms: sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!) : null,
      last,
      samples: r.length,
    };
  }
}
