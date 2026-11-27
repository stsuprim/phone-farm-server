/**
 * 2026-11-27 (docs/root-cause.md 13.1 P8, 13.2): the trace journal. A ring buffer, in memory only, of what the server
 * did with the phones: every WDA request (`wda.queued`, `sent`, `answered`, `failed`, `abandoned`, `cancelled`,
 * `refused`, `skipped`, `joined`, `dropped`), the control link (`link.state`, `link.beat`), the runners
 * (`runner.spawn`, `adopt`, `exit`, `restart`), the capture (`capture.state`, `capture.beat`) and freezes (`freeze`).
 * `GET /trace` reads it (filtered by phone, kind and time). Never pass a secret (a token, typed text, a body) in
 * `data`: only labels ("POST /wda/lotus/touch"), times, numbers and states. Fields named like secrets are dropped.
 */

export interface TraceEvent {
  /** Increasing per process: a client reads on `after` the last one it saw. */
  seq: number;
  /** ms since the epoch. */
  at: number;
  kind: string;
  udid: string | null;
  data: Record<string, unknown>;
}

/** Events kept (the oldest drop first). About a day of normal use for two phones, a few MB. */
export const TRACE_MAX = 20_000;
/** One event's data as at most this many characters of JSON (a longer one is cut to its first fields). */
const DATA_MAX = 600;
/** Keys never kept, whatever a caller passes. */
const SECRET_KEY = /token|secret|password|passcode|auth|cookie|text|body|value|clip/i;

let ring: TraceEvent[] = [];
let head = 0;
let seq = 0;
let max = TRACE_MAX;
const counts = new Map<string, number>();

function clean(data: Record<string, unknown> | undefined): { udid: string | null; data: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  let udid: string | null = null;
  let size = 0;
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k === 'udid') {
      udid = typeof v === 'string' ? v : null;
      continue;
    }
    if (SECRET_KEY.test(k)) continue;
    let x: unknown = v;
    if (typeof v === 'string') x = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    else if (v !== null && typeof v === 'object') {
      try {
        const j = JSON.stringify(v);
        x = j.length > 200 ? `${j.slice(0, 200)}…` : JSON.parse(j);
      } catch {
        continue;
      }
    } else if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') continue;
    size += k.length + (typeof x === 'string' ? x.length : 16);
    if (size > DATA_MAX) break;
    out[k] = x;
  }
  return { udid, data: out };
}

/** Journals one event (never throws: the trace never breaks what it watches). */
export function trace(kind: string, data?: Record<string, unknown>): void {
  try {
    const c = clean(data);
    const ev: TraceEvent = { seq: ++seq, at: Date.now(), kind, udid: c.udid, data: c.data };
    if (ring.length < max) ring.push(ev);
    else {
      ring[head] = ev;
      head = (head + 1) % max;
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  } catch {
    /* never */
  }
}

export interface TraceQuery {
  /** Only this phone's (and the farm's own, without a phone). */
  udid?: string;
  /** Kinds, or prefixes ending in "." ("wda." for every request event). */
  kinds?: string[];
  /** Only events after this seq. */
  after?: number;
  /** Only events at or after this time (ms since the epoch). */
  since?: number;
  /** The newest this many (default 500, at most 5000). */
  limit?: number;
}

/** The journal, oldest first, filtered. */
export function traceRead(q: TraceQuery = {}): { events: TraceEvent[]; seq: number; kept: number; max: number; counts: Record<string, number> } {
  const all = ring.length < max ? ring : [...ring.slice(head), ...ring.slice(0, head)];
  const kinds = q.kinds?.filter(Boolean) ?? [];
  const match = (k: string) => !kinds.length || kinds.some((x) => (x.endsWith('.') ? k.startsWith(x) : k === x));
  const picked = all.filter(
    (e) => (q.udid === undefined || e.udid === null || e.udid === q.udid) && match(e.kind) && (q.after === undefined || e.seq > q.after) && (q.since === undefined || e.at >= q.since),
  );
  const limit = Math.max(1, Math.min(5000, Math.floor(q.limit ?? 500)));
  return { events: picked.slice(-limit), seq, kept: ring.length, max, counts: Object.fromEntries(counts) };
}

/** Tests: an empty journal of `size` events. */
export function traceReset(size = TRACE_MAX): void {
  ring = [];
  head = 0;
  max = Math.max(1, size);
  counts.clear();
}
