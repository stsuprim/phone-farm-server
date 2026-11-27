import { ChildProcess, spawn } from 'node:child_process';
import { REMOTE_CEILING_BPS, REMOTE_KEY_SECONDS, REMOTE_LONG_SIDE, REMOTE_MAX_FPS, REMOTE_START_BPS } from './congestion.js';
import { AUDIO_KIND } from './audio.js';
import { bitrateFor, CAPTURING_LINE, CaptureState, CaptureStill, H264Settings, H264Source, helperArgs, KIND, Producer, ProducerHooks, RecordParser, StartProducer } from './h264.js';
import type { H264Want } from './types.js';

/**
 * Encoder lanes: one phonecap process per phone (one USB capture), several H.264 encoders fed by it, each with its own
 * size, frame rate and bitrate. A LAN viewer (Rinor) keeps full size at 60 fps on its lane while a far viewer (the
 * owner over Tailscale) gets a small 30 fps lane whose bitrate and frame rate follow its link, and a far viewer's
 * keyframe asks and congestion never touch the LAN lane. Each lane is an H264Source (src/h264.ts) whose producer is
 * PhonecapHost.start.
 */

export const MAX_LANES = 8;
/** `quality=thumb`: a small, cheap lane for grids (one phone full, the rest as thumbnails). */
export const THUMB_LONG_SIDE = 360;
export const THUMB_MIN_FPS = 4;
export const THUMB_MAX_FPS = 8;
export const THUMB_DEFAULT_FPS = 6;
export const THUMB_BPS = 250_000;
export const THUMB_KEY_SECONDS = 4;

/** What a viewer gets: its lane's key (viewers with the same key share it) and the lane's settings. */
export interface Profile {
  key: string;
  remote: boolean;
  /** A thumbnail lane (`quality=thumb`). */
  thumb?: boolean;
  settings: H264Settings;
}

/**
 * A viewer's lane from what it asked. LAN (and `full`): exactly what it asked. Far (Tailscale, the Internet): at most
 * 30 fps and about 1400 px on the long side, starting at 1.5 Mbps and climbing to its `bitrate` ask (2.5 Mbps without
 * one), frame rate lowered with the bitrate.
 */
export function profileFor(want: H264Want, dfltBps: number, longSidePx: number | null): Profile {
  if (want.tier === 'thumb') {
    // a grid tile: ~360 px on the long side, 4-8 fps, a few hundred kbit/s; viewers of any profile share it
    const long = longSidePx && longSidePx > 0 ? longSidePx : 2778;
    const scale = Math.max(10, Math.min(want.scale, Math.floor((100 * THUMB_LONG_SIDE) / long)));
    const fps = Math.min(THUMB_MAX_FPS, Math.max(THUMB_MIN_FPS, want.fps));
    const bitrate = Math.min(want.bitrate ?? THUMB_BPS, THUMB_BPS * 2);
    return { key: `thumb:${fps}:${scale}`, remote: !!want.remote, thumb: true, settings: { fps, scale, bitrate, keySeconds: THUMB_KEY_SECONDS } };
  }
  if (!want.remote || want.full) {
    const bitrate = want.bitrate ?? bitrateFor(want.quality, dfltBps);
    return {
      key: `lan:${want.fps}:${want.scale}:${Math.round(bitrate / 1000)}`,
      remote: false,
      settings: { fps: want.fps, scale: want.scale, bitrate, keySeconds: 2 },
    };
  }
  const long = longSidePx && longSidePx > 0 ? longSidePx : 2778;
  const scaleCap = Math.max(20, Math.min(100, Math.floor((100 * REMOTE_LONG_SIDE) / long)));
  const scale = Math.min(want.scale, scaleCap);
  const fps = Math.min(want.fps, REMOTE_MAX_FPS);
  const ceiling = want.bitrate ?? REMOTE_CEILING_BPS;
  return {
    key: `remote:${fps}:${scale}`,
    remote: true,
    // 2026-11-27: its picture also shrinks on a thin link (src/h264.ts scaleFor) rather than freezing
    settings: { fps, scale, bitrate: Math.min(ceiling, REMOTE_START_BPS), maxBitrate: ceiling, adaptFps: true, adaptScale: true, keySeconds: REMOTE_KEY_SECONDS },
  };
}

export type Spawn = (bin: string, args: string[]) => ChildProcess;

/** Where a host's sound goes (src/audio.ts AudioHub). */
export interface AudioSink {
  frame(f: { time: number; payload: Buffer }): void;
  infoRecord(payload: Buffer): void;
  /** The capture ended: the sound is back on the phone. */
  ended(): void;
  /** Why the capture runs without sound now (null: it has it again). */
  unavailable(reason: string | null): void;
}
/** A capture that died before its first picture twice in a row with sound on runs without sound this long. */
export const AUDIO_BACKOFF_MS = 10 * 60_000;
/** The longest a hold keeps a capture nobody watches open (the phone's volume going back down). */
export const HOLD_MOST_MS = 30_000;
const realSpawn: Spawn = (bin, args) => spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
/** 2026-11-27: the longest a new phonecap waits for the previous one to exit (it's SIGKILLed after 1.5 s). */
export const HOST_EXIT_WAIT_MS = 3_000;

/**
 * One phonecap process for one phone, shared by its lanes. The first lane starts the process (its settings on the
 * command line, lane 0); later ones are added with "lane <id> ..." on stdin and removed with "unlane <id>"; the process
 * stops with the last lane. If it exits, every lane hears it (each H264Source restarts on its own, the first one
 * starting the process again).
 */
export class PhonecapHost {
  private proc?: ChildProcess;
  private lanes = new Map<number, ProducerHooks>();
  /** Turn the picture this many degrees clockwise before encoding (a helper with the "rotate" cap; 0 = as captured). */
  private rotation = 0;
  // the phone's sound (src/audio.ts): asked for with --audio when there's a sink; "audio on|off" as listeners come
  private audioWanted = false;
  private withAudio = false; // the running process was started with --audio
  private gotPicture = false; // the running process gave a picture
  private live = false; // the running process said its capture session runs (its "capturing ..." line)
  private audioStrikes = 0;
  private noAudioUntil = 0;
  // a capture held open after its last lane (the phone's volume going back down while the sound is still on the Mac)
  private holds = 0;
  private closing?: NodeJS.Timeout;
  /** 2026-11-22: when the capture last started and ended (ms since the epoch; null: never), for the record of how a WDA runner ended. */
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  // 2026-11-27, Stopping before Starting (docs/root-cause.md 3): kill() dropped the process at once but SIGKILL came
  // 1.5 s later, so a new open could spawn a second phonecap on a screen device the first still held. Now a process
  // told to stop is `dying` until it has exited, and a start meanwhile waits for it (its lines queued).
  private dying?: { p: ChildProcess; done: Promise<void> };
  private pendingSpawn?: H264Settings;
  private pendingLines: string[] = [];
  private exits = new WeakMap<ChildProcess, Promise<void>>();
  private laneWant = new Map<number, { fps: number; scale: number; bps: number; key: number }>();

  constructor(
    private bin: string,
    private args: string[],
    private label: string,
    private spawnFn: Spawn = realSpawn,
    private sink?: AudioSink,
  ) {}

  get running(): boolean {
    return !!this.proc || !!this.pendingSpawn;
  }
  /** 2026-11-27: a stopped phonecap hasn't exited yet (a new one waits for it). */
  get stopping(): boolean {
    return !!this.dying;
  }
  get laneCount(): number {
    return this.lanes.size;
  }

  /** The StartProducer for one lane's H264Source. */
  readonly start: StartProducer = (want, hooks) => this.open(want, hooks);

  private open(want: H264Settings, hooks: ProducerHooks): Producer {
    let id = 0;
    // a capture held open after its last lane is taken up again (its lane 0 still runs, with its encoder: 2026-11-27,
    // a keyframe is asked at once, else the re-added lane had no picture until the next interval)
    if (this.closing) (clearTimeout(this.closing), (this.closing = undefined));
    const held = !!this.proc && !this.lanes.size;
    if (!this.proc && !this.pendingSpawn) {
      if (this.dying) {
        // the previous phonecap hasn't exited yet: this one starts once it has (never two on one screen device)
        this.pendingSpawn = want;
        const wait = this.dying.done;
        void wait.then(() => this.spawnPending());
      } else this.spawn(want);
    } else {
      id = -1;
      for (let i = 0; i < MAX_LANES; i++) {
        if (!this.lanes.has(i)) {
          id = i;
          break;
        }
      }
      if (id < 0) throw new Error(`all ${MAX_LANES} encoder lanes are in use`);
      this.write(`lane ${id} ${want.fps} ${want.scale} ${Math.round(want.bitrate)} ${want.keySeconds ?? 2}`);
      if (held) this.write(`key ${id}`);
    }
    this.lanes.set(id, hooks);
    this.laneWant.set(id, { fps: want.fps, scale: want.scale, bps: Math.round(want.bitrate), key: want.keySeconds ?? 2 });
    let stopped = false;
    // a lane is this producer's while its hooks are the lane's (an exit, a kill or a restart clears them)
    const mine = () => !stopped && this.lanes.get(id) === hooks;
    if (this.live) hooks.capturing?.(); // a lane added to a running capture: its first keyframe is due from now
    const lw = () => this.laneWant.get(id)!;
    return {
      reportsCapturing: true,
      key: () => {
        if (mine()) this.write(`key ${id}`);
      },
      bitrate: (bps) => {
        if (!mine()) return;
        lw().bps = Math.round(bps);
        this.write(`bitrate ${id} ${Math.round(bps)}`);
      },
      fps: (f) => {
        if (!mine()) return;
        lw().fps = Math.round(f);
        this.write(`fps ${id} ${Math.round(f)}`);
      },
      // 2026-11-27: a far lane's picture follows its link ("lane" again with the new scale: a new encoder and a key)
      scale: (pct) => {
        if (!mine()) return;
        const w = lw();
        w.scale = Math.max(10, Math.min(100, Math.round(pct)));
        this.write(`lane ${id} ${w.fps} ${w.scale} ${w.bps} ${w.key}`);
      },
      still: (longSide) => {
        if (mine()) this.write(longSide ? `still ${Math.round(longSide)}` : 'still');
      },
      stop: () => {
        if (!mine()) return;
        stopped = true;
        this.lanes.delete(id);
        if (this.lanes.size) {
          this.write(`unlane ${id}`);
          return;
        }
        // the last lane: settles once the process has exited (the source is Stopping until then)
        return this.kill();
      },
      // 2026-11-23: this lane got no picture in time (src/h264.ts H264Source's watchdog). A process that never gave
      // any lane a picture runs a capture session that hands over no frames (iPhone-2 after a replug): it's ended
      // (every lane hears it and starts it again, a new session); one that gives pictures only loses this lane.
      // 2026-11-27: `whole` (its heartbeat stopped: the process hung) always ends the process.
      restart: (why, whole) => {
        if (!mine()) return;
        if (this.gotPicture && !whole) {
          stopped = true;
          this.lanes.delete(id);
          if (this.lanes.size) this.write(`unlane ${id}`);
          else void this.kill();
          return;
        }
        console.log(`[phonecap ${this.label}] ${why}`);
        this.restart(why);
      },
    };
  }

  /** Send the phone's sound (someone listens) or not; kept for the helper's next start too. */
  setAudio(on: boolean): void {
    if (this.audioWanted === on) return;
    this.audioWanted = on;
    if (this.withAudio) this.write(`audio ${on ? 'on' : 'off'}`);
  }

  /**
   * Keep the capture open after its last lane until the returned release is called (at most HOLD_MOST_MS): the
   * phone's sound stays on the Mac while its volume goes back down.
   */
  hold(): () => void {
    this.holds++;
    let done = false;
    const t = setTimeout(() => release(), HOLD_MOST_MS);
    t.unref?.();
    const release = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      this.holds--;
      if (!this.holds && this.closing) {
        clearTimeout(this.closing);
        this.closing = undefined;
        if (!this.lanes.size) this.kill();
      }
    };
    return release;
  }

  private write(line: string): void {
    if (!this.proc && this.pendingSpawn) {
      this.pendingLines.push(line); // said once the waiting process starts
      return;
    }
    const stdin = this.proc?.stdin;
    if (stdin?.writable) stdin.write(`${line}\n`);
  }

  /** The previous process has exited: the start that waited for it runs now (unless every lane left meanwhile). */
  private spawnPending(): void {
    const w = this.pendingSpawn;
    if (!w || this.proc || (this.dying && !this.settled(this.dying.p))) return;
    this.pendingSpawn = undefined;
    const lines = this.pendingLines;
    this.pendingLines = [];
    if (!this.lanes.size) return;
    this.spawn(w);
    for (const l of lines) this.write(l);
  }

  private settled(p: ChildProcess): boolean {
    return p.exitCode !== null && p.exitCode !== undefined ? true : !!p.signalCode;
  }

  /** Tell a process to end; it's `dying` until it has exited (at most HOST_EXIT_WAIT_MS). */
  private end(p: ChildProcess): Promise<void> {
    if (p.stdin?.writable) p.stdin.write('quit\n');
    p.kill('SIGTERM');
    const exited = this.exits.get(p) ?? Promise.resolve();
    let done = false;
    void exited.then(() => (done = true));
    setTimeout(() => !done && p.kill('SIGKILL'), 1500).unref();
    let t: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((r) => {
      t = setTimeout(r, HOST_EXIT_WAIT_MS);
      t.unref?.();
    });
    const all: Promise<void> = Promise.race([exited, cap]).then(() => {
      if (t) clearTimeout(t);
      if (this.dying?.done === all) this.dying = undefined;
    });
    this.dying = { p, done: all };
    return all;
  }

  /**
   * Start the capture over (a new capture session takes the screen's size as it is now): every lane hears the
   * helper stop and its source starts it again. For a picture that kept its old shape after the phone turned.
   */
  restart(why: string): void {
    const p = this.proc;
    if (!p) return;
    this.died(p, why);
    void this.end(p);
  }

  /** Turn the picture `deg` (0, 90, 180, 270) clockwise before encoding; kept for the helper's next start too. */
  rotate(deg: number): void {
    const d = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
    if (d === this.rotation) return;
    this.rotation = d;
    this.write(`rotate ${d}`);
  }
  get rotated(): number {
    return this.rotation;
  }

  private spawn(want: H264Settings): void {
    const sound = !!this.sink && Date.now() >= this.noAudioUntil;
    const p = this.spawnFn(this.bin, [...this.args, ...helperArgs(want), ...(sound ? ['--audio'] : [])]);
    this.proc = p;
    this.exits.set(
      p,
      new Promise<void>((resolve) => {
        p.once('exit', () => resolve());
        p.once('error', () => resolve());
      }),
    );
    this.startedAt = Date.now();
    this.withAudio = sound;
    this.gotPicture = false;
    this.live = false;
    if (this.rotation) this.write(`rotate ${this.rotation}`);
    if (sound && this.audioWanted) this.write('audio on');
    if (this.sink && !sound) this.sink.unavailable(`the capture failed with sound on, so it runs without sound until ${new Date(this.noAudioUntil).toLocaleTimeString()}`);
    else if (this.sink) this.sink.unavailable(null);
    const tail: string[] = [];
    const parser = new RecordParser((r) => {
      // the sound never reaches the lanes, and a sound that fails never touches the picture
      if (r.kind === AUDIO_KIND.FRAME || r.kind === AUDIO_KIND.INFO) {
        if (this.proc !== p) return;
        try {
          if (r.kind === AUDIO_KIND.FRAME) this.sink?.frame({ time: r.time, payload: r.payload });
          else this.sink?.infoRecord(r.payload);
        } catch (err) {
          console.log(`[phonecap ${this.label}] sound: ${(err as Error).message}`);
        }
        return;
      }
      if (r.kind === KIND.KEY || r.kind === KIND.DELTA) this.gotPicture = true;
      // 2026-11-27: the heartbeat and stills are the whole capture's: every lane hears them
      if (r.kind === KIND.BEAT || r.kind === KIND.STILL) {
        for (const h of [...this.lanes.values()]) h.record(r);
        return;
      }
      this.lanes.get(r.lane ?? 0)?.record(r);
    });
    p.stdout?.on('data', (c: Buffer) => {
      try {
        parser.push(c);
      } catch (err) {
        this.died(p, (err as Error).message);
        p.kill('SIGKILL');
      }
    });
    p.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/).filter(Boolean)) {
        console.log(`[phonecap ${this.label}] ${line}`);
        if (this.proc === p && !this.live && CAPTURING_LINE.test(line)) {
          this.live = true;
          for (const h of [...this.lanes.values()]) h.capturing?.();
        }
        tail.push(line.replace(/^phonecap:\s*/, ''));
        if (tail.length > 3) tail.shift();
      }
    });
    p.stdin?.on('error', () => {});
    p.on('error', (err) => this.died(p, `could not start the capture helper: ${err.message}`));
    p.on('exit', (code, sig) => this.died(p, tail.length ? tail[tail.length - 1]! : `capture helper exited (${code ?? sig})`));
  }

  /** The process ended: every lane hears why. */
  private died(p: ChildProcess, why: string): void {
    if (this.proc !== p) return;
    this.proc = undefined;
    this.stoppedAt = Date.now();
    if (this.closing) (clearTimeout(this.closing), (this.closing = undefined));
    // a capture that dies before any picture with sound on, twice in a row: the next ones go without sound for a while
    if (this.withAudio && !this.gotPicture) {
      if (++this.audioStrikes >= 2) {
        this.audioStrikes = 0;
        this.noAudioUntil = Date.now() + AUDIO_BACKOFF_MS;
        console.log(`[phonecap ${this.label}] the capture died twice before a picture with sound on; without sound for ${AUDIO_BACKOFF_MS / 60000} min`);
      }
    } else if (this.gotPicture) this.audioStrikes = 0;
    this.sink?.ended();
    const hooks = [...this.lanes.values()];
    this.lanes.clear();
    for (const h of hooks) h.exit(why);
  }

  /** Ends the process (or keeps it for a hold); settles once it has exited (undefined: nothing to wait for). */
  private kill(): Promise<void> | undefined {
    this.lanes.clear();
    // a start still waiting for the previous process: nothing of it ran
    if (this.pendingSpawn) {
      this.pendingSpawn = undefined;
      this.pendingLines = [];
    }
    // held open (the phone's volume going back down while its sound is still on the Mac): closed on the release
    if (this.holds > 0 && this.proc && !this.closing) {
      this.closing = setTimeout(() => {
        this.closing = undefined;
        if (!this.lanes.size) void this.kill();
      }, HOLD_MOST_MS);
      this.closing.unref?.();
      return;
    }
    if (this.closing) return;
    const p = this.proc;
    this.proc = undefined;
    if (!p) return this.dying?.done;
    this.stoppedAt = Date.now();
    this.sink?.ended();
    return this.end(p);
  }

  /** Stops the process now (the phone was unplugged, the server stops); its sources are closed by the caller. */
  close(): void {
    this.holds = 0;
    if (this.closing) (clearTimeout(this.closing), (this.closing = undefined));
    void this.kill();
  }
}

// ---- 2026-11-27: the capture kept on while anyone works on a phone, and its stills (docs/root-cause.md 13.3b) ----

/** What acquireCapture needs of the server's backend (src/types.ts Backend has it). */
export interface CaptureBackend {
  h264(udid: string, want: H264Want): H264Source | string;
}
/** An acquired capture stays on this long after its last handle is released (an agent's look, act, look again). */
export const ACQUIRE_GRACE_MS = 15_000;
/** The lane an acquired capture runs: a cheap thumbnail lane (stills come from the full captured picture anyway). */
export const ACQUIRE_WANT: H264Want = { fps: THUMB_MIN_FPS, scale: 100, quality: null, tier: 'thumb' };
/** A failed acquire (no backend yet, the capture gave up) is tried again this often while handles want it. */
export const ACQUIRE_RETRY_MS = 30_000;

/** One holder's claim on a phone's capture (acquireCapture). */
export interface CaptureHandle {
  readonly udid: string;
  readonly reason: string;
  readonly since: number;
  readonly released: boolean;
  /** The capture's state now ("Unavailable": no source could be had: see why()). */
  state(): CaptureState | 'Unavailable';
  /** Why it's Unavailable or in a bad state, else null. */
  why(): string | null;
}

interface Acquired {
  handles: Set<Handle>;
  src?: H264Source;
  release?: () => void;
  grace?: NodeJS.Timeout;
  retry?: NodeJS.Timeout;
  error: string | null;
}

let captureBackend: CaptureBackend | null = null;
const acquired = new Map<string, Acquired>();
const seen = new Map<string, Set<H264Source>>();

class Handle implements CaptureHandle {
  released = false;
  readonly since = Date.now();
  constructor(readonly udid: string, readonly reason: string) {}
  state(): CaptureState | 'Unavailable' {
    const e = acquired.get(this.udid);
    return e?.src ? e.src.captureState() : 'Unavailable';
  }
  why(): string | null {
    const e = acquired.get(this.udid);
    return e?.src ? e.src.stateWhy() : (e?.error ?? 'released');
  }
}

/**
 * Where acquireCapture gets a phone's capture from: the server's backend (call once at start, src/index.ts or
 * src/server.ts). Handles taken before it's set start their capture now.
 */
export function setCaptureBackend(b: CaptureBackend | null): void {
  captureBackend = b;
  for (const [udid, e] of acquired) if (e.handles.size && !e.src) bind(udid, e);
}

/** A source this phone's capture runs on (a live view's lane): latestFrame may read it. */
export function noteSource(udid: string, src: H264Source): void {
  let set = seen.get(udid);
  if (!set) seen.set(udid, (set = new Set()));
  set.add(src);
}

function bind(udid: string, e: Acquired): void {
  if (e.retry) clearTimeout(e.retry);
  e.retry = undefined;
  if (!captureBackend) {
    e.error = 'no capture backend yet (setCaptureBackend is called at the server start)';
    return;
  }
  let s: H264Source | string;
  try {
    s = captureBackend.h264(udid, ACQUIRE_WANT);
  } catch (err) {
    s = (err as Error).message;
  }
  if (typeof s === 'string') {
    e.error = s;
    e.retry = setTimeout(() => e.handles.size && !e.src && bind(udid, e), ACQUIRE_RETRY_MS);
    e.retry.unref?.();
    return;
  }
  e.error = null;
  e.src = s;
  noteSource(udid, s);
  e.release = s.hold('acquired');
}

/**
 * 2026-11-27: keep the phone's capture on while `reason` (an agent's hand, a client) works on the phone, viewers or
 * not. Ref-counted: the capture stays on until every handle is released, then ACQUIRE_GRACE_MS more, then it stops
 * like any (Stopping, then Off). Never wakes or unlocks the phone and never calls WebDriverAgent; a locked phone's
 * capture waits in WaitingUnlock.
 */
export function acquireCapture(udid: string, reason: string): CaptureHandle {
  let e = acquired.get(udid);
  if (!e) acquired.set(udid, (e = { handles: new Set(), error: null }));
  if (e.grace) clearTimeout(e.grace);
  e.grace = undefined;
  const h = new Handle(udid, reason);
  e.handles.add(h);
  if (!e.src) bind(udid, e);
  return h;
}

/** Ends a handle's claim (twice is harmless). The last one leaves the capture on for `graceMs` (ACQUIRE_GRACE_MS). */
export function releaseCapture(handle: CaptureHandle, graceMs = ACQUIRE_GRACE_MS): void {
  if (!(handle instanceof Handle) || handle.released) return;
  handle.released = true;
  const e = acquired.get(handle.udid);
  if (!e || !e.handles.delete(handle) || e.handles.size) return;
  if (e.grace) clearTimeout(e.grace);
  e.grace = setTimeout(() => {
    if (e.handles.size || acquired.get(handle.udid) !== e) return;
    if (e.retry) clearTimeout(e.retry);
    e.release?.();
    acquired.delete(handle.udid);
  }, graceMs);
  e.grace.unref?.();
}

/** Who holds the phone's capture on now (their reasons and since when). */
export function captureHolders(udid: string): { reason: string; since: number }[] {
  return [...(acquired.get(udid)?.handles ?? [])].map((h) => ({ reason: h.reason, since: h.since }));
}

/** The phone was unlocked: its captures waiting for that (WaitingUnlock) try again now. */
export function noteUnlocked(udid: string): void {
  for (const s of sourcesOf(udid)) s.unlocked();
}

function sourcesOf(udid: string): H264Source[] {
  const a = acquired.get(udid)?.src;
  const rest = [...(seen.get(udid) ?? [])].filter((s) => s !== a);
  return a ? [a, ...rest] : rest;
}

/**
 * 2026-11-27: a decoded still (JPEG; PNG from the mock) of the phone's newest captured picture, no older than
 * maxAgeMs (on a still screen: as confirmed by the helper's heartbeat), or null (no capture Live or Still, or none
 * in time). For reads that must never use WebDriverAgent's screenshots. It starts nothing: acquireCapture first.
 */
export async function latestFrame(udid: string, maxAgeMs: number, timeoutMs = 1500): Promise<CaptureStill | null> {
  for (const s of sourcesOf(udid)) {
    const st = s.captureState();
    if (st !== 'Live' && st !== 'Still') continue;
    const got = await s.still(maxAgeMs, timeoutMs);
    if (got) return got;
  }
  return null;
}

/** Tests: forget every handle, source and backend. */
export function resetCaptureRegistry(): void {
  for (const e of acquired.values()) {
    if (e.grace) clearTimeout(e.grace);
    if (e.retry) clearTimeout(e.retry);
    e.release?.();
  }
  acquired.clear();
  seen.clear();
  captureBackend = null;
}
