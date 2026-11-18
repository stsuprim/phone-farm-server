import fs from 'node:fs';
import path from 'node:path';

/**
 * The phone's sound in the live view (2026-11-16, the owner: "make it so the AUDIO is output to me only and not from
 * the phone at all"; the phones sit at Rinor's house and must stay quiet).
 *
 * Where it comes from: native/phonecap adds an AVCaptureAudioDataOutput to the SAME capture session as the picture
 * (the iPhone's USB screen device is muxed: video and sound), with --audio. While that capture runs, iOS sends the
 * phone's sound to the Mac instead of its own speaker, as with QuickTime's "iPhone" audio input, so the phone goes
 * quiet while it's watched. (To be confirmed on the phones themselves: iOS 18.5 and 18.7.8.) The helper encodes it to
 * Opus (48 kHz stereo, 20 ms frames, ~80 kbit/s; G.711 u-law on a Mac without an Opus encoder) and writes:
 *   kind 5  one encoded frame, its time the capture time (ms since the epoch) of its first sample;
 *   kind 6  JSON: {codec, rate, channels, frame_ms, reason?} once, then {level_db, peak_db} every 2 s while it runs.
 * Frames are sent only while someone listens ("audio on" / "audio off" on the helper's stdin); the helper runs only
 * while a live view of the phone is open (src/real.ts CAPTURE_GRACE_MS), so the sound starts and stops with it.
 *
 * In the WebRTC session (src/rtc.ts) the sound is its own sendonly track on the offer's audio m-section: its own SSRC
 * and RTP clock (48 kHz, or 8 kHz for G.711), timestamps from the same capture clock as the picture's (AudioRtpClock),
 * and RTCP sender reports from the same wall clock, so the browser keeps them in step (same stream id). A sound that
 * fails never touches the picture.
 *
 * The phone's volume (VolumeGuard): the owner keeps each phone's media volume at 0 %. Whether that level scales what
 * the USB capture carries isn't documented by Apple; reports on QuickTime recordings say it does (and iOS keeps a
 * volume per output route, so the capture route may have its own). So, only while the sound is routed to the Mac (a
 * frame has come from the capture) and someone listens, the server raises the phone's volume with WDA's volume
 * buttons, and puts it back to 0 when the last listener leaves, before the capture stops (the capture is held open
 * until it's done), and at once if the capture dies. A small state file (data/audio-volume.json) says which phones
 * were raised, so a crash or a restart puts them back to 0 when the server starts. AUDIO_PHONE_VOLUME=0 turns the
 * raise off; AUDIO=false turns the sound off.
 *
 * 2026-11-18 (the owner: the phones must never make a sound or vibrate; Rinor lives with them): the phones are kept
 * SILENT (PHONE_SILENT, on by default). Whether iOS really takes the sound off the speaker while it's captured wasn't
 * sure, and raising the volume made the phone audible, so nothing raises it any more: the raise above is off while
 * silent, the volume-up key is refused (src/real.ts), and `silence` drives each phone's volume all the way down with
 * WDA's volume-down button every time its WebDriverAgent comes up (a start, a restart, a rebuild) and after a wake
 * (at most every SILENCE_EVERY_MS). The sound still goes to the live view as the capture gives it.
 */

export const AUDIO_KIND = { FRAME: 5, INFO: 6 } as const;

export type AudioCodec = 'opus' | 'pcmu';
export interface AudioFrame {
  time: number; // capture time of its first sample, ms since the epoch (server clock)
  payload: Buffer;
}
export interface AudioInfo {
  codec: AudioCodec | 'none' | null;
  reason: string | null;
  level_db: number | null;
  peak_db: number | null;
  frames: number;
}

/** What a WebRTC session reads the phone's sound from. */
export interface AudioFeed {
  /** The codec the frames come in (the last one this Mac's helper said; Opus until it says). */
  codec(): AudioCodec;
  /** Why there's no sound now, or null. */
  reason(): string | null;
  info(): AudioInfo;
  /** Hear the frames (and why the sound stopped, if it does). The capture sends them while anyone listens. */
  listen(onFrame: (f: AudioFrame) => void, onState?: (reason: string | null) => void): () => void;
}

/** The codec the helper said last on this Mac (a Mac without an Opus encoder says pcmu every time). */
let lastCodec: AudioCodec = 'opus';
export const knownCodec = (): AudioCodec => lastCodec;
export function setKnownCodec(c: AudioCodec): void {
  lastCodec = c;
}

export interface HubHooks {
  /** Someone listens (true) or nobody does (false): the helper's "audio on" / "audio off". */
  enable(on: boolean): void;
  /** The first frame came while someone listens: the sound is routed to the Mac now. */
  flowing?(): void;
  /** Nobody listens any more, or the capture ended (`ended`): the phone's volume back to 0. */
  quiet?(ended: boolean): void;
  log?(m: string): void;
}

/** One phone's sound: listeners, the helper's word on it, and its frames handed to every listener. */
export class AudioHub implements AudioFeed {
  private subs = new Set<{ frame: (f: AudioFrame) => void; state?: (r: string | null) => void }>();
  private state: AudioInfo = { codec: null, reason: null, level_db: null, peak_db: null, frames: 0 };
  private flowed = false;
  private log: (m: string) => void;

  constructor(private label: string, private hooks: HubHooks) {
    this.log = hooks.log ?? ((m) => console.log(`[audio ${label}] ${m}`));
  }

  get listeners(): number {
    return this.subs.size;
  }
  codec(): AudioCodec {
    return this.state.codec === 'pcmu' || this.state.codec === 'opus' ? this.state.codec : lastCodec;
  }
  reason(): string | null {
    return this.state.reason;
  }
  info(): AudioInfo {
    return { ...this.state };
  }

  listen(onFrame: (f: AudioFrame) => void, onState?: (reason: string | null) => void): () => void {
    const s = { frame: onFrame, state: onState };
    this.subs.add(s);
    if (this.subs.size === 1) {
      this.flowed = false;
      this.hooks.enable(true);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subs.delete(s);
      if (this.subs.size === 0) {
        this.hooks.enable(false);
        if (this.flowed) this.hooks.quiet?.(false);
        this.flowed = false;
      }
    };
  }

  /** A frame from the capture. */
  frame(f: AudioFrame): void {
    this.state.frames++;
    if (!this.subs.size) return;
    if (!this.flowed) {
      this.flowed = true;
      this.hooks.flowing?.();
    }
    for (const s of [...this.subs]) {
      try {
        s.frame(f);
      } catch (err) {
        this.log(`a listener failed: ${(err as Error).message}`);
      }
    }
  }

  /** The helper's kind 6 record. */
  infoRecord(payload: Buffer): void {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (typeof j.level_db === 'number') this.state.level_db = j.level_db;
    if (typeof j.peak_db === 'number') this.state.peak_db = j.peak_db;
    if (typeof j.codec !== 'string') return;
    const codec = j.codec === 'opus' || j.codec === 'pcmu' ? j.codec : 'none';
    const reason = codec === 'none' ? (typeof j.reason === 'string' && j.reason ? j.reason : 'the capture gave no sound') : null;
    if (codec !== 'none') setKnownCodec(codec);
    const changed = codec !== this.state.codec || reason !== this.state.reason;
    this.state.codec = codec;
    this.state.reason = reason;
    if (changed) {
      this.log(codec === 'none' ? `no sound: ${reason}` : `sound: ${codec}${typeof j.note === 'string' ? ` (${j.note})` : ''}`);
      for (const s of [...this.subs]) s.state?.(reason);
    }
  }

  /** Why there's no sound before the capture says anything (the helper can't, the server says no). */
  unavailable(reason: string | null): void {
    if (reason === this.state.reason && (reason === null || this.state.codec === 'none')) return;
    this.state.reason = reason;
    if (reason) this.state.codec = 'none';
    for (const s of [...this.subs]) s.state?.(reason);
  }

  /** The capture ended (its helper stopped or died): the sound goes back to the phone, so its volume goes to 0 now. */
  ended(): void {
    this.state.level_db = this.state.peak_db = null;
    if (this.flowed) this.hooks.quiet?.(true);
    this.flowed = false;
    // a listener stays: the capture's next start sends the sound again ("audio on" with it)
  }
}

/**
 * One audio track's RTP clock: frames one after another advance by exactly their length in samples (no jitter from
 * the capture times), anchored to the capture clock; a gap or a jump of more than three frames (the sound stopped and
 * came back, the capture restarted) anchors it to the capture clock again. Never backwards.
 */
export class AudioRtpClock {
  private t0 = 0;
  private next = -1;
  private last = -1;
  constructor(readonly rate: number, readonly frameSamples: number) {}

  /** The timestamp (ticks since the first frame) of a frame captured at `captured` (ms). */
  stamp(captured: number): number {
    if (!this.t0) this.t0 = captured;
    const byTime = Math.round(((captured - this.t0) * this.rate) / 1000);
    let ts = this.next < 0 || Math.abs(byTime - this.next) > this.frameSamples * 3 ? byTime : this.next;
    if (ts <= this.last) ts = this.last + 1;
    this.last = ts;
    this.next = ts + this.frameSamples;
    return ts;
  }
}

export interface OfferAudio {
  mid: string;
  opus: number | null; // payload type of opus/48000/2
  opusFmtp: string;
  pcmu: number | null; // PCMU/8000 (static 0 when offered)
}

/** The offer's first audio m-section (a client asking for the sound), or null. */
export function parseOfferAudio(sdp: string): OfferAudio | null {
  const sections = sdp.split(/\r?\n(?=m=)/);
  const audio = sections.find((s) => s.startsWith('m=audio'));
  if (!audio) return null;
  const lines = audio.split(/\r?\n/);
  const port = /^m=audio (\d+)/.exec(lines[0] ?? '');
  if (port && port[1] === '0') return null; // rejected by the client
  if (lines.some((l) => /^a=(sendonly|inactive)\b/.test(l))) return null; // the client won't receive
  const mid = lines.find((l) => l.startsWith('a=mid:'))?.slice(6).trim() ?? '1';
  let opus: number | null = null;
  let pcmu: number | null = null;
  const fmtp = new Map<number, string>();
  for (const l of lines) {
    let m = /^a=rtpmap:(\d+) opus\/48000(?:\/2)?/i.exec(l);
    if (m && opus === null) opus = Number(m[1]);
    m = /^a=rtpmap:(\d+) PCMU\/8000/i.exec(l);
    if (m && pcmu === null) pcmu = Number(m[1]);
    m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (m) fmtp.set(Number(m[1]), m[2]!.trim());
  }
  // PCMU's static payload type may be listed without an rtpmap
  if (pcmu === null && /^m=audio \d+ \S+ (?:\d+ )*0(?: |$)/m.test(lines[0] ?? '')) pcmu = 0;
  if (opus === null && pcmu === null) return null;
  return { mid, opus, opusFmtp: opus !== null ? fmtp.get(opus) ?? '' : '', pcmu };
}

/** What a session sends for an offer's audio: the codec, its payload type and RTP clock; or why not. */
export function audioPlan(offer: OfferAudio, codec: AudioCodec): { codec: AudioCodec; pt: number; rate: number; frameSamples: number } | string {
  if (codec === 'opus') {
    if (offer.opus === null) return 'the viewer offered no Opus';
    return { codec, pt: offer.opus, rate: 48000, frameSamples: 960 };
  }
  if (offer.pcmu === null) return 'the viewer offered no G.711 (PCMU), the codec this Mac sends';
  return { codec, pt: offer.pcmu, rate: 8000, frameSamples: 160 };
}

// ---- the phone's volume ----

export interface VolumeOptions {
  /** The level the phone's media volume is raised to while its sound is routed to the Mac, percent (0 = never raised). */
  percent: number;
  /** One press of a volume button (WDA's). */
  press(udid: string, dir: 'up' | 'down'): Promise<void>;
  /** The state file (which phones are raised). */
  file: string;
  /** Between two presses (ms). */
  gapMs?: number;
  /** A press that failed (WDA busy or down) is tried again after this long (ms). */
  retryMs?: number;
  /** 2026-11-18: the phones stay silent: the volume is never raised (`raise` does nothing), only driven down. */
  silent?: boolean;
  /** `silence` without `force` presses at most this often per phone (ms; default SILENCE_EVERY_MS). */
  silenceEveryMs?: number;
  log?: (m: string) => void;
}

/** A wake silences a phone again at most this often (its WDA coming up always does). */
export const SILENCE_EVERY_MS = 10 * 60_000;

/** iOS's volume has 16 steps; one button press is one step. */
export const VOLUME_STEPS = 16;

/** How many presses up from 0 make `percent`. */
export const pressesFor = (percent: number) => Math.max(0, Math.min(VOLUME_STEPS, Math.round((Math.max(0, Math.min(100, percent)) / 100) * VOLUME_STEPS)));

/**
 * Raises a phone's media volume while its sound is routed to the Mac and puts it back to 0 afterwards, by WDA's volume
 * buttons. The phone is never raised outside that time: `raise` is called only once the capture's sound flows, and
 * the file names each raised phone BEFORE its first press up, so whatever stops the server mid-way, its next start
 * presses it back down (`recover`). Down is always all the way (VOLUME_STEPS + 1 presses): 0 for sure, whatever the
 * level was, and never cut short. One phone's presses never overlap: a raise and a lower asked in turn end at the
 * last one asked.
 */
export class VolumeGuard {
  private raised: Record<string, { presses: number; at: number }> = {};
  /** When each phone was last silenced (src: silence), and the silences under way (not written to the file). */
  private silencedAt = new Map<string, number>();
  private silencing = new Set<string>();
  private silenceFails = new Map<string, number>();
  private want = new Map<string, boolean>();
  private busy = new Map<string, Promise<void>>();
  private retry = new Map<string, NodeJS.Timeout>();
  private log: (m: string) => void;
  /** Every press made, in order (tests). */
  readonly pressed: string[] = [];

  constructor(private o: VolumeOptions) {
    this.log = o.log ?? ((m) => console.log(`[volume] ${m}`));
    try {
      const j = JSON.parse(fs.readFileSync(o.file, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        for (const [u, v] of Object.entries(j as Record<string, unknown>)) {
          const presses = Number((v as { presses?: unknown })?.presses);
          if (Number.isFinite(presses) && presses > 0) this.raised[u] = { presses, at: Number((v as { at?: unknown }).at) || 0 };
        }
      }
    } catch {
      /* none yet */
    }
  }

  get enabled(): boolean {
    return !this.o.silent && pressesFor(this.o.percent) > 0;
  }

  /** The phones the file holds as raised (a silence under way isn't written there). */
  private fileRaised(): Record<string, { presses: number; at: number }> {
    const out: Record<string, { presses: number; at: number }> = {};
    for (const [u, v] of Object.entries(this.raised)) if (v.presses > 0) out[u] = v;
    return out;
  }
  /** The phones the file says are raised now. */
  pending(): string[] {
    return Object.keys(this.fileRaised());
  }
  isRaised(udid: string): boolean {
    return (this.raised[udid]?.presses ?? 0) > 0;
  }

  /** At start: every phone left raised (a crash, a restart) goes back to 0. */
  recover(): void {
    for (const u of this.pending()) {
      this.log(`${u.slice(-8)} was left raised; putting its volume back to 0`);
      this.lower(u);
    }
  }

  /** The sound is routed to the Mac and someone listens: up to the level. */
  raise(udid: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.want.set(udid, true);
    return this.kick(udid);
  }

  /**
   * 2026-11-18: the phone's volume all the way down now (VOLUME_STEPS + 1 presses of volume-down: 0 whatever it
   * was), whatever this guard thinks it is (someone may have pressed the phone's own buttons). `force` (its WDA just
   * came up) presses even if it was done lately; otherwise not more often than SILENCE_EVERY_MS. A raise asked
   * meanwhile is dropped. Resolves when done; a press that fails is tried again later, like a lower.
   */
  silence(udid: string, force = false, why = ''): Promise<void> {
    const now = Date.now();
    const last = this.silencedAt.get(udid) ?? -Infinity;
    if (!force && now - last < (this.o.silenceEveryMs ?? SILENCE_EVERY_MS)) return Promise.resolve();
    this.silencedAt.set(udid, now);
    this.want.set(udid, false);
    // what the work loop reads: the file says raised, so it presses all the way down (and forgets it after)
    if (!this.raised[udid]) this.raised[udid] = { presses: 0, at: now };
    this.silencing.add(udid);
    if (why) this.log(`${udid.slice(-8)}: keeping it silent (${why})`);
    return this.kick(udid);
  }

  /** Back to 0 (nobody listens, or the capture ended). */
  lower(udid: string): Promise<void> {
    this.want.set(udid, false);
    if (!this.raised[udid] && !this.busy.has(udid)) {
      this.want.delete(udid);
      return Promise.resolve();
    }
    return this.kick(udid);
  }

  private kick(udid: string): Promise<void> {
    const t = this.retry.get(udid);
    if (t) clearTimeout(t);
    this.retry.delete(udid);
    const running = this.busy.get(udid);
    if (running) return running;
    const p = this.work(udid).finally(() => this.busy.delete(udid));
    this.busy.set(udid, p);
    return p;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      const tmp = `${this.o.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.raised)}\n`);
      fs.renameSync(tmp, this.o.file);
    } catch (err) {
      this.log(`could not write ${this.o.file}: ${(err as Error).message}`);
    }
  }

  private async press(udid: string, dir: 'up' | 'down', n: number): Promise<boolean> {
    for (let i = 0; i < n; i++) {
      // a raise that's no longer wanted stops here (the loop lowers next); a lower always goes all the way
      if (dir === 'up' && this.want.get(udid) !== true) return false;
      await this.o.press(udid, dir);
      this.pressed.push(`${udid}:${dir}`);
      if (this.o.gapMs) await new Promise((r) => setTimeout(r, this.o.gapMs));
    }
    return true;
  }

  private async work(udid: string): Promise<void> {
    for (let round = 0; round < 6; round++) {
      const up = this.want.get(udid);
      if (up === undefined) return;
      try {
        if (up) {
          if (this.raised[udid]) return; // already up
          const n = pressesFor(this.o.percent);
          // named in the file before the first press: a crash from here on is put right at the next start
          this.raised[udid] = { presses: n, at: Date.now() };
          this.save();
          this.log(`${udid.slice(-8)}: the sound is on the Mac; volume up to ~${this.o.percent} % (${n} presses)`);
          if (!(await this.press(udid, 'up', n))) continue;
          return;
        }
        if (!this.raised[udid]) {
          this.want.delete(udid);
          return;
        }
        const quiet = this.silencing.has(udid);
        if (!quiet) this.log(`${udid.slice(-8)}: volume back to 0`);
        await this.press(udid, 'down', VOLUME_STEPS + 1);
        this.silencing.delete(udid);
        this.silenceFails.delete(udid);
        delete this.raised[udid];
        this.save();
        if (this.want.get(udid) === true) continue; // wanted up again meanwhile (a new listener)
        this.want.delete(udid);
        return;
      } catch (err) {
        if (this.silencing.has(udid) && !this.raised[udid]?.presses) {
          // a silence (nothing this server raised): tried again a few times; its WDA's next start silences it anyway
          const n = (this.silenceFails.get(udid) ?? 0) + 1;
          this.silenceFails.set(udid, n);
          if (n > 4) {
            this.log(`${udid.slice(-8)}: the volume couldn't be pressed down (${(err as Error).message}); its WDA's next start tries again`);
            this.silenceFails.delete(udid);
            this.silencing.delete(udid);
            this.silencedAt.delete(udid);
            delete this.raised[udid];
            this.want.delete(udid);
            return;
          }
        }
        // WDA busy or down: tried again a little later, the file still says raised
        this.log(`${udid.slice(-8)}: a volume press failed (${(err as Error).message}); trying again`);
        const t = setTimeout(() => {
          this.retry.delete(udid);
          void this.kick(udid);
        }, this.o.retryMs ?? 15_000);
        t.unref?.();
        this.retry.set(udid, t);
        return;
      }
    }
  }

  close(): void {
    for (const t of this.retry.values()) clearTimeout(t);
    this.retry.clear();
  }
}
