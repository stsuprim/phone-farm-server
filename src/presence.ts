/**
 * 2026-11-21 (iPhone-2: "control down", a live view that failed with "phone unplugged" after 9 rebuilds and no frame,
 * while GET /phones said it was online a few seconds before and after): which phones are plugged in, from each poll's
 * `idevice_id -l`, without trusting one poll that misses a phone.
 *
 * A phone drops out of usbmuxd's list for a moment without being unplugged: starting its USB screen capture makes it
 * add a USB configuration and re-enumerate (README, "The iPhone"), a usbmux hiccup, or an `idevice_id` that came back
 * short while xcodebuild/CoreDevice was busy. The server used to take a single miss as an unplug: WDA stopped, the live
 * view closed with "phone unplugged", HID and the app cache dropped; the next poll found it again with control down
 * and a new WDA start. The live view's own capture start set off the next miss, so it looped.
 *
 * Now a phone is "missing" from its first miss (nothing is torn down; WDA waits for it rather than restarting), and
 * "gone" (unplugged: torn down) only after it was missed in `misses` polls in a row spanning at least `afterMs`.
 * Seen again in any poll before that, it's simply back.
 */

/** A phone is unplugged only after this many polls in a row without it... */
export const OFFLINE_MISSES = 3;
/** ...spanning at least this long (POLL_MS 5 s: the third miss, 10 s after the first). */
export const OFFLINE_AFTER_MS = 10_000;

export interface PresenceChange {
  /** Listed now and not known as plugged in before (new, or back after it was gone): set up. */
  arrived: string[];
  /** Listed again after it went missing for a moment (it never counted as unplugged): nothing to set up again. */
  back: string[];
  /** Not listed this time, for the first time (a blip until it lasts): nothing is torn down. */
  missing: string[];
  /** Missed long enough to count as unplugged: torn down now. */
  gone: string[];
}

export class Presence {
  private known = new Set<string>(); // plugged in, as far as the server goes (missing ones included)
  private misses = new Map<string, { n: number; since: number }>();

  constructor(private opts: { misses?: number; afterMs?: number } = {}) {}

  /** One poll's list (`idevice_id -l`) at `now`. A poll that failed altogether is never given here. */
  update(listed: Iterable<string>, now = Date.now()): PresenceChange {
    const ids = new Set(listed);
    const out: PresenceChange = { arrived: [], back: [], missing: [], gone: [] };
    for (const udid of ids) {
      if (!this.known.has(udid)) {
        this.known.add(udid);
        out.arrived.push(udid);
      } else if (this.misses.delete(udid)) {
        out.back.push(udid);
      }
    }
    const need = Math.max(1, this.opts.misses ?? OFFLINE_MISSES);
    const span = Math.max(0, this.opts.afterMs ?? OFFLINE_AFTER_MS);
    for (const udid of [...this.known]) {
      if (ids.has(udid)) continue;
      let m = this.misses.get(udid);
      if (!m) {
        this.misses.set(udid, (m = { n: 0, since: now }));
        out.missing.push(udid);
      }
      m.n++;
      if (m.n >= need && now - m.since >= span) {
        this.known.delete(udid);
        this.misses.delete(udid);
        out.gone.push(udid);
      }
    }
    return out;
  }

  /** Plugged in (missing for a moment counts). */
  has(udid: string): boolean {
    return this.known.has(udid);
  }

  /** Not in the last poll's list, but not counted as unplugged yet: since when (Date.now()), else null. */
  missingSince(udid: string): number | null {
    return this.misses.get(udid)?.since ?? null;
  }
}
