/**
 * Looks at a phone's screen (docs/root-cause.md 13.2 `phone/look.ts`, G5; 2026-11-27).
 *
 * The picture comes from the phone's USB screen capture when it runs (the live view's, kept running while a client
 * or an agent works on the phone) and the owner lets the agent see it (`agentSeesCapture`, on by default: iOS tells
 * apps while their screen is captured, UIScreen.isCaptured). Only when there's no capture does a look go to
 * WebDriverAgent (a still: on the phone's one main queue, slow on a video app), and then:
 *
 * - single-flight: one still per phone on its way at a time, everyone asking meanwhile shares it;
 * - coalesced: a still younger than the caller's `maxAgeMs` is given again;
 * - budgeted: at most one still per `gapMs` (LOOK_GAP_VIDEO_MS while a video app is in front);
 * - cancellable: a caller that gives up (its signal) stops waiting, and a still nobody waits for any more is never sent.
 */

import type { Image, ImageFormat } from '../types.js';

/** The apps whose feed never stops moving (WDA reads of them take seconds: root-cause section 7). */
export const VIDEO_APPS = new Set([
  'com.zhiliaoapp.musically', // TikTok
  'com.ss.iphone.ugc.Ame', // TikTok (other regions)
  'com.burbn.instagram',
  'com.google.ios.youtube',
  'com.facebook.Facebook',
  'com.atebits.Tweetie2', // X
  'com.toyopagroup.picaboo', // Snapchat
  'com.netflix.Netflix',
  'tv.twitch',
]);

/** At most one WDA still (and one UI tree) per this long while a video app is in front. */
export const LOOK_GAP_VIDEO_MS = 3000;
export const TREE_GAP_VIDEO_MS = 3000;

export function isVideoApp(bundleId: string | null | undefined): boolean {
  return !!bundleId && VIDEO_APPS.has(bundleId);
}

/**
 * What the capture says of the picture without decoding it: `gen` counts the frames that differed from the one before
 * (a still screen gives none), `movedAt` the last of them (Date.now()), `keyAt` the last picture at all.
 */
export interface PictureToken {
  gen: number;
  movedAt: number;
  keyAt: number;
  width: number | null;
  height: number | null;
}

/** A backend that can give the agent the capture's picture (src/real.ts). Feature-detected (`isCaptureLook`). */
export interface CaptureLook {
  /** The capture's token now, when it runs and has a picture and the owner lets the agent see it; else null. */
  pictureToken(udid: string): PictureToken | null;
  /**
   * Keep the phone's capture running for `reason` ("agent", "client") until the returned release. Null when the
   * capture can't run here, or the owner keeps the agent from it.
   */
  holdPicture(udid: string, reason: string): (() => void) | null;
  /** A still from the capture's own picture (when the capture layer can decode one); null when it can't. */
  capturePicture?(udid: string, format: ImageFormat, size?: { maxSide?: number; quality?: number }): Promise<Image | null>;
}

export function isCaptureLook(b: unknown): b is CaptureLook {
  return !!b && typeof (b as CaptureLook).pictureToken === 'function' && typeof (b as CaptureLook).holdPicture === 'function';
}

/** A token as a hash for `changed` (the same picture gives the same string). */
export function tokenHash(t: PictureToken): string {
  return `cap:${t.width ?? 0}x${t.height ?? 0}:${t.gen}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Wait until the capture shows no new frame for `quietMs` (a transition ended), at most `maxMs`. True when it went
 * still; false when it kept moving (a video never stops) or the capture stopped.
 */
export async function captureQuiet(token: () => PictureToken | null, quietMs: number, maxMs: number, signal?: AbortSignal): Promise<boolean> {
  const until = Date.now() + maxMs;
  for (;;) {
    const t = token();
    if (!t) return false;
    const since = Date.now() - Math.max(t.movedAt, 0);
    if (!t.movedAt || since >= quietMs) return true;
    if (Date.now() >= until || signal?.aborted) return false;
    await sleep(Math.min(quietMs - since + 5, until - Date.now()), signal);
  }
}

interface Kept<T> {
  at: number; // Date.now() it came
  value: T;
}

interface Flight<T> {
  p: Promise<T>;
  ac: AbortController;
  waiters: number;
}

export interface BudgetOptions {
  /** The least time between two reads of a phone (ms), by the phone (its app in front): 0 = no budget. */
  gapMs: (udid: string) => number;
  now?: () => number;
}

/**
 * Single-flight, coalesced and budgeted reads of one kind (a still's hash, a UI tree) per phone. `take` does the read
 * (through the phone's actor: never while an input is queued).
 */
export class Budgeted<T> {
  private kept = new Map<string, Kept<T>>();
  private flights = new Map<string, Flight<T>>();
  private lastStart = new Map<string, number>();
  private now: () => number;

  constructor(private take: (udid: string, signal: AbortSignal) => Promise<T>, private opts: BudgetOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The last read and when it came, if any. */
  last(udid: string): Kept<T> | null {
    return this.kept.get(udid) ?? null;
  }

  /** Forget the last read (the phone had input: what it showed may be gone). */
  invalidate(udid: string): void {
    this.kept.delete(udid);
  }

  /**
   * A read at most `maxAgeMs` old. Within the budget it's read now (or the one on its way is shared); over it, it waits
   * for the budget at most `waitMs`, else gives the last read (`stale`) or null.
   */
  async get(udid: string, o: { maxAgeMs?: number; waitMs?: number; signal?: AbortSignal } = {}): Promise<{ value: T; at: number; stale: boolean } | null> {
    const maxAge = o.maxAgeMs ?? 0;
    const k = this.kept.get(udid);
    if (k && maxAge > 0 && this.now() - k.at <= maxAge) return { value: k.value, at: k.at, stale: false };
    const f = this.flights.get(udid);
    if (f) return this.join(udid, f, o.signal);
    const gap = this.opts.gapMs(udid);
    const left = gap - (this.now() - (this.lastStart.get(udid) ?? -Infinity));
    if (left > 0) {
      const wait = o.waitMs ?? 0;
      if (left > wait || o.signal?.aborted) return k ? { value: k.value, at: k.at, stale: true } : null;
      await sleep(left, o.signal);
      if (o.signal?.aborted) return k ? { value: k.value, at: k.at, stale: true } : null;
      return this.get(udid, { ...o, waitMs: 0 });
    }
    const ac = new AbortController();
    this.lastStart.set(udid, this.now());
    const flight: Flight<T> = { ac, waiters: 0, p: this.take(udid, ac.signal) };
    this.flights.set(udid, flight);
    flight.p.then(
      (value) => {
        if (this.flights.get(udid) === flight) this.flights.delete(udid);
        this.kept.set(udid, { at: this.now(), value });
      },
      () => {
        if (this.flights.get(udid) === flight) this.flights.delete(udid);
      },
    );
    return this.join(udid, flight, o.signal);
  }

  private async join(udid: string, f: Flight<T>, signal?: AbortSignal): Promise<{ value: T; at: number; stale: boolean } | null> {
    f.waiters++;
    try {
      const value = await (signal
        ? Promise.race([
            f.p,
            new Promise<never>((_, reject) => {
              if (signal.aborted) reject(new Error('cancelled'));
              signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
            }),
          ])
        : f.p);
      return { value, at: this.now(), stale: false };
    } catch (err) {
      if (signal?.aborted) return null;
      throw err;
    } finally {
      // nobody waits for it any more: a read that hasn't reached the phone yet is never sent
      if (--f.waiters <= 0 && signal?.aborted) {
        f.ac.abort();
        if (this.flights.get(udid) === f) this.flights.delete(udid);
      }
    }
  }
}
