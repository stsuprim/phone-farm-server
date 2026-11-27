/**
 * A phone's power state from observations only (docs/root-cause.md 13.3d; 2026-11-27):
 *
 * ```
 * Unknown ──observed frame (capture or still) not black──▶ Awake(observedAt)
 * Unknown ──/wda/locked=true──▶ Locked ; ──observed black──▶ Dark
 * Awake ──observedAt older than AWAKE_FOR_MS──▶ Unknown   (Unknown means no Home press)
 * Dark|Locked ──explicit wake──▶ Waking ──observed──▶ Awake | stays Locked (passcode)
 * ```
 *
 * Nothing here presses anything: it only says what was seen, and when. A Home press or an unlock goes out only as an
 * explicit action, or on an observed Dark or Locked (never on Unknown, never on a screen that couldn't be looked at).
 */

export type PowerKind = 'unknown' | 'awake' | 'dark' | 'locked' | 'waking';

/** What was seen of the phone's screen, and how. */
export interface PowerObservation {
  /** on: the screen shows something (a moving capture, a still that isn't black, WDA's "not locked" with a lit screen). */
  screen: 'on' | 'dark' | 'locked';
  /** Date.now() of the observation. */
  at?: number;
  /** Where it came from (for the log and the stats): "capture", "still", "wda-locked", "lock", "wake". */
  from: string;
}

export interface PowerView {
  state: PowerKind;
  /** When it was last observed (Date.now()); null for Unknown with nothing seen yet. */
  observedAt: number | null;
  from: string | null;
}

/** An Awake observation counts this long (iOS's shortest Auto-Lock is 30 s): then it's Unknown again. */
export const AWAKE_FOR_MS = 25_000;
/** Dark and Locked are kept until something else is seen (a dark phone doesn't light up by itself). */

export class PowerTracker {
  private st = new Map<string, { kind: Exclude<PowerKind, 'unknown'>; at: number; from: string }>();
  constructor(private now: () => number = Date.now) {}

  observe(udid: string, o: PowerObservation): void {
    const at = o.at ?? this.now();
    const cur = this.st.get(udid);
    // an older observation never overrides a newer one
    if (cur && cur.at > at) return;
    this.st.set(udid, { kind: o.screen === 'on' ? 'awake' : o.screen, at, from: o.from });
  }

  /** An explicit wake started (Waking until something is observed). */
  waking(udid: string): void {
    this.st.set(udid, { kind: 'waking', at: this.now(), from: 'wake' });
  }

  /** What's known now: Awake goes back to Unknown once it's older than AWAKE_FOR_MS. */
  view(udid: string): PowerView {
    const s = this.st.get(udid);
    if (!s) return { state: 'unknown', observedAt: null, from: null };
    if (s.kind === 'awake' && this.now() - s.at >= AWAKE_FOR_MS) return { state: 'unknown', observedAt: s.at, from: s.from };
    return { state: s.kind, observedAt: s.at, from: s.from };
  }

  /** Observed dark or locked: the only states a wake may act on without being asked. */
  observedOff(udid: string): boolean {
    const v = this.view(udid).state;
    return v === 'dark' || v === 'locked';
  }

  forget(udid: string): void {
    this.st.delete(udid);
  }
}

/** A backend that tells what it saw of a phone's screen as it reads it (src/real.ts). */
export interface PowerFeed {
  watchPower(cb: (udid: string, o: PowerObservation) => void): () => void;
}

export function isPowerFeed(b: unknown): b is PowerFeed {
  return !!b && typeof (b as PowerFeed).watchPower === 'function';
}
