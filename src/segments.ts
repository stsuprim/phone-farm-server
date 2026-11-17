/**
 * Segmented live touch (2026-11-17, live mode 4). XCTest plays whole event records (XCSynthesizedEventRecord) and
 * lifts every finger of a record when the record ends, so on iOS 18 no finger can stay down on the phone between two
 * requests: the fork's self-test found none of its three "hold" modes working on either phone. What can be live is
 * the picture following the finger: the drag goes to the phone in short whole gestures (`POST /lotus/gesture`) while
 * it happens, each one starting where the last one ended, instead of all of it on release.
 *
 *   - a segment is sent once it has lasted SEG_MIN_MS and moved SEG_MIN_PT from where it started, and only when the
 *     phone isn't still busy playing earlier ones (an estimate: each segment takes its own length, its settle and
 *     XCTest's overhead), so a slow phone gets longer segments rather than a growing queue;
 *   - a segment that isn't the last stays still SEG_SETTLE_MS before its lift, so iOS sees no flick (a list doesn't
 *     fling between two segments); the last one lifts as the finger did (a real flick still flings);
 *   - a finger that doesn't move is never cut: a tap, a long press, a hold then a drag go as one gesture until it
 *     moves, so a long press stays a long press.
 * What it can't do: keep one contact through a whole drag (a long press that becomes a drag lifts after the first
 * segment, so dragging an app icon lands in iOS's edit mode without carrying the icon).
 */
import type { PathPoint } from './types.js';

/** A segment is sent once it's at least this long (ms)... */
export const SEG_MIN_MS = 70;
/** ...and the finger moved at least this far from where the segment started (points). */
export const SEG_MIN_PT = 10;
/** A segment that isn't the last holds still this long before its lift (ms): no fling between segments. */
export const SEG_SETTLE_MS = 30;
/** What XCTest adds to each record on the phone, about (ms). */
export const SEG_OVERHEAD_MS = 60;
/** A segment is sent only while the phone is at most this far behind (ms of estimated work queued). */
export const SEG_MAX_BEHIND_MS = 120;
/**
 * 2026-11-17: no segment is cut before the touch has lasted this long (ms), so a quick swipe or flick always goes as
 * one whole gesture with its real speed (cutting it stopped it 30 ms before a lift: no flick, on both phones). Since
 * the same day segmented drags are opt-in only (src/fork.ts usableLiveMode).
 */
export const SEG_FIRST_MS = 350;
/** At most this many points in one segment (a finger held still for long adds only time). */
const SEG_MOST_POINTS = 2000;

/** `gap` (ms): the pause the phone keeps after this segment before the next record (mode 5); 0 for mode 4. */
export type PlaySegment = (points: PathPoint[], hold: number, gap: number) => Promise<unknown>;

/**
 * Mode 5 (fork v3, 2026-11-17): on iPhone-1 (iOS 18.5) two segments played back to back reached the phone as one
 * touch of one segment's length: the second's press right after the first's lift was lost. There the phone waits
 * `gapMs` (what its self-test found) after each segment before playing the next record: the fork's queue
 * plays one record at a time, each after XCTest's completion of the one before, then the gap. The pacing here counts
 * the gap as part of each segment's time on the phone.
 */
export class Segmenter {
  /** The pause between two segments on the phone (ms); 0 (mode 4) sends none. Set by the caller before a touch. */
  gapMs = 0;
  /** No segment before the touch is this old (ms): SEG_FIRST_MS; 0 cuts from the start (tests of the pacing). */
  firstMs = SEG_FIRST_MS;
  private down_ = false;
  private start = 0; // when the segment began (now() ms)
  private touchStart = 0; // when the finger landed (now() ms)
  private pts: PathPoint[] = [];
  private busyUntil = 0; // when the phone should be done with what was sent (estimate)
  private chain: Promise<unknown> = Promise.resolve();
  /** Segments sent for the touch now (tests, stats). */
  segments = 0;

  constructor(private play: PlaySegment, private now: () => number = () => performance.now()) {}

  get isDown(): boolean {
    return this.down_;
  }

  /** The finger lands: nothing is sent yet (a tap or a long press goes whole). */
  down(x: number, y: number): Promise<void> {
    this.down_ = true;
    this.start = this.touchStart = this.now();
    this.pts = [[x, y, 0]];
    this.segments = 0;
    return Promise.resolve();
  }

  /** The finger moved (or is said again where it is): a segment goes when it's due. */
  move(x: number, y: number): Promise<void> {
    if (!this.down_) return Promise.resolve();
    const now = this.now();
    this.add(x, y, now);
    const first = this.pts[0]!;
    const due = now - this.touchStart >= this.firstMs && now - this.start >= SEG_MIN_MS && Math.hypot(x - first[0], y - first[1]) >= SEG_MIN_PT && this.busyUntil - now <= SEG_MAX_BEHIND_MS;
    if (!due) return Promise.resolve();
    return this.send(SEG_SETTLE_MS, now, [x, y]);
  }

  /** The finger lifts: the rest goes, lifting as the finger did. */
  up(x: number, y: number): Promise<void> {
    if (!this.down_) return Promise.resolve();
    const now = this.now();
    this.add(x, y, now);
    this.down_ = false;
    return this.send(0, now, null);
  }

  private add(x: number, y: number, now: number): void {
    const t = Math.max(0, Math.round(now - this.start));
    const last = this.pts[this.pts.length - 1]!;
    if (this.pts.length >= SEG_MOST_POINTS) this.pts[this.pts.length - 1] = [x, y, Math.max(last[2], t)];
    else this.pts.push([x, y, Math.max(last[2], t)]);
  }

  /** Sends the segment so far (in order after the ones before); `next`: where the next one starts (null: the last). */
  private send(hold: number, now: number, next: [number, number] | null): Promise<void> {
    const pts = this.pts;
    const length = pts[pts.length - 1]![2];
    // the last one too: the next touch's press could come straight after its lift as well
    const gap = Math.max(0, Math.round(this.gapMs));
    this.busyUntil = Math.max(this.busyUntil, now) + length + hold + gap + SEG_OVERHEAD_MS;
    this.segments++;
    if (next) {
      this.start = now;
      this.pts = [[next[0], next[1], 0]];
    } else this.pts = [];
    // one after the other: a segment's request goes only once the one before it was answered
    const p = this.chain.then(() => this.play(pts, hold, gap));
    this.chain = p.catch(() => {});
    return p.then(() => {});
  }
}
