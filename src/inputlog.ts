/**
 * Server-side input latency, per phone: receive -> start (waiting in the phone's queue) -> injected (handed to the
 * phone's input channel: the HID report written, or WDA's fast route queued it, or the old WDA route finished).
 * Logged one line per action (INPUT_LOG=0 turns the lines off) and kept for GET /phones/:udid/input and the
 * `input` part of GET /phones' stats.
 */

/**
 * How an action reached the phone: hid (CoreDevice HID), wda-live (our own WDA build's live touch: a finger held down
 * between requests), wda-fast (a whole gesture in one command), wda (the old XCTest route).
 */
export type InputVia = 'hid' | 'wda-live' | 'wda-fast' | 'wda' | 'mock' | 'buffered';

export interface InputResult {
  via: InputVia;
  /** Why it didn't go the fastest way (HID not open, failed, landscape turned off...): a per-gesture fallback's reason. */
  reason?: string;
  /** A live move folded into a newer one (the phone was behind): only the newest point was injected. */
  coalesced?: boolean;
  /** A move or up with no touch to belong to (its touch already ended): nothing was injected. */
  stray?: boolean;
  /**
   * It was answered when it was queued on the phone, which plays it for about this long yet (ms): the phone's next
   * action waits for it, and a report looks at the screen after it.
   */
  play_ms?: number;
  /** 2026-11-18, `type`: the field read back after typing (src/field.ts; never a secure field's text). */
  check?: import('./field.js').TypeCheck;
  /** `type` on a field that isn't secure: its text after typing, at most 200 characters. */
  value?: string;
  /** `type` with `clear` (or `clear`): whether the field was emptied, and how. */
  cleared?: boolean;
  clear_method?: string;
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
  /** Why a slower route took it (a per-gesture fallback). */
  reason?: string;
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
  /**
   * Live touch: receive -> injected of the last moves (ms), how many moves were folded into a newer one, how many
   * touches the server lifted itself (no `up` in time), and fallbacks to a slower route with the last reason.
   */
  touch: {
    move_avg_ms: number | null;
    move_p90_ms: number | null;
    coalesced: number;
    auto_released: number;
    fallbacks: number;
    fallback_reason: string | null;
  };
}

const KEEP = 100;
const round = (v: number) => Math.round(v * 10) / 10;

interface Counts {
  coalesced: number;
  released: number;
  fallbacks: number;
  reason: string | null;
}

export class InputMeter {
  private rows = new Map<string, InputSample[]>();
  private counts = new Map<string, Counts>();

  constructor(private logLines = process.env.INPUT_LOG !== '0') {}

  private count(udid: string): Counts {
    let c = this.counts.get(udid);
    if (!c) this.counts.set(udid, (c = { coalesced: 0, released: 0, fallbacks: 0, reason: null }));
    return c;
  }

  /** A live move was folded into a newer one. */
  coalesced(udid: string): void {
    this.count(udid).coalesced++;
  }

  /** The server lifted a touch whose `up` never came. */
  released(udid: string): void {
    this.count(udid).released++;
  }

  add(udid: string, s: InputSample): void {
    let r = this.rows.get(udid);
    if (!r) this.rows.set(udid, (r = []));
    r.push(s);
    if (r.length > KEEP) r.splice(0, r.length - KEEP);
    if (s.reason) {
      const c = this.count(udid);
      c.fallbacks++;
      c.reason = s.reason;
    }
    if (this.logLines && s.type !== 'touch-move') {
      const what = s.ok ? `via ${s.via ?? '?'}${s.reason ? ` (${s.reason})` : ''}` : `FAILED${s.via ? ` (${s.via})` : ''}: ${s.error ?? ''}`;
      console.log(`[input ${udid.slice(-8)}] ${s.type} ${what}: wait ${round(s.wait_ms)} ms + inject ${round(s.inject_ms)} ms = ${round(s.total_ms)} ms (receive -> injected)`);
    }
  }

  recent(udid: string): InputSample[] {
    return [...(this.rows.get(udid) ?? [])];
  }

  stats(udid: string): InputStats {
    const r = this.rows.get(udid) ?? [];
    const taps = r.filter((s) => s.ok && (s.type === 'tap' || s.type === 'touch-down')).map((s) => s.total_ms).slice(-20);
    const moves = r.filter((s) => s.ok && s.type === 'touch-move').map((s) => s.total_ms).slice(-40);
    const avg = (list: number[]) => (list.length ? round(list.reduce((a, b) => a + b, 0) / list.length) : null);
    const p90 = (list: number[]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!) : null;
    };
    const last = r[r.length - 1] ?? null;
    const c = this.counts.get(udid);
    return {
      via: last?.via ?? null,
      tap_avg_ms: avg(taps),
      tap_p90_ms: p90(taps),
      last,
      samples: r.length,
      touch: {
        move_avg_ms: avg(moves),
        move_p90_ms: p90(moves),
        coalesced: c?.coalesced ?? 0,
        auto_released: c?.released ?? 0,
        fallbacks: c?.fallbacks ?? 0,
        fallback_reason: c?.reason ?? null,
      },
    };
  }
}
