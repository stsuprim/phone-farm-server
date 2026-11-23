import { ChildProcess, spawn } from 'node:child_process';
import { REMOTE_CEILING_BPS, REMOTE_KEY_SECONDS, REMOTE_LONG_SIDE, REMOTE_MAX_FPS, REMOTE_START_BPS } from './congestion.js';
import { AUDIO_KIND } from './audio.js';
import { bitrateFor, CAPTURING_LINE, H264Settings, helperArgs, KIND, Producer, ProducerHooks, RecordParser, StartProducer } from './h264.js';
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
    settings: { fps, scale, bitrate: Math.min(ceiling, REMOTE_START_BPS), maxBitrate: ceiling, adaptFps: true, keySeconds: REMOTE_KEY_SECONDS },
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

  constructor(
    private bin: string,
    private args: string[],
    private label: string,
    private spawnFn: Spawn = realSpawn,
    private sink?: AudioSink,
  ) {}

  get running(): boolean {
    return !!this.proc;
  }
  get laneCount(): number {
    return this.lanes.size;
  }

  /** The StartProducer for one lane's H264Source. */
  readonly start: StartProducer = (want, hooks) => this.open(want, hooks);

  private open(want: H264Settings, hooks: ProducerHooks): Producer {
    let id = 0;
    // a capture held open after its last lane is taken up again (its lane 0 still runs)
    if (this.closing) (clearTimeout(this.closing), (this.closing = undefined));
    if (!this.proc) {
      this.spawn(want);
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
    }
    this.lanes.set(id, hooks);
    const proc = this.proc;
    let stopped = false;
    const mine = () => !stopped && this.proc === proc && this.lanes.get(id) === hooks;
    if (this.live) hooks.capturing?.(); // a lane added to a running capture: its first keyframe is due from now
    return {
      reportsCapturing: true,
      key: () => {
        if (mine()) this.write(`key ${id}`);
      },
      bitrate: (bps) => {
        if (mine()) this.write(`bitrate ${id} ${Math.round(bps)}`);
      },
      fps: (f) => {
        if (mine()) this.write(`fps ${id} ${Math.round(f)}`);
      },
      stop: () => {
        if (!mine()) return;
        stopped = true;
        this.lanes.delete(id);
        if (this.lanes.size) this.write(`unlane ${id}`);
        else this.kill();
      },
      // 2026-11-23: this lane got no picture in time (src/h264.ts H264Source's watchdog). A process that never gave
      // any lane a picture runs a capture session that hands over no frames (iPhone-2 after a replug): it's ended
      // (every lane hears it and starts it again, a new session); one that gives pictures only loses this lane.
      restart: (why) => {
        if (!mine()) return;
        if (this.gotPicture) {
          stopped = true;
          this.lanes.delete(id);
          if (this.lanes.size) this.write(`unlane ${id}`);
          else this.kill();
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
    const stdin = this.proc?.stdin;
    if (stdin?.writable) stdin.write(`${line}\n`);
  }

  /**
   * Start the capture over (a new capture session takes the screen's size as it is now): every lane hears the
   * helper stop and its source starts it again. For a picture that kept its old shape after the phone turned.
   */
  restart(why: string): void {
    const p = this.proc;
    if (!p) return;
    this.died(p, why);
    if (p.stdin?.writable) p.stdin.write('quit\n');
    p.kill('SIGTERM');
    setTimeout(() => p.kill('SIGKILL'), 1500).unref();
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

  private kill(): void {
    this.lanes.clear();
    // held open (the phone's volume going back down while its sound is still on the Mac): closed on the release
    if (this.holds > 0 && this.proc && !this.closing) {
      this.closing = setTimeout(() => {
        this.closing = undefined;
        if (!this.lanes.size) this.kill();
      }, HOLD_MOST_MS);
      this.closing.unref?.();
      return;
    }
    if (this.closing) return;
    const p = this.proc;
    this.proc = undefined;
    if (!p) return;
    this.stoppedAt = Date.now();
    this.sink?.ended();
    if (p.stdin?.writable) p.stdin.write('quit\n');
    p.kill('SIGTERM');
    setTimeout(() => p.kill('SIGKILL'), 1500).unref();
  }

  /** Stops the process now (the phone was unplugged, the server stops); its sources are closed by the caller. */
  close(): void {
    this.holds = 0;
    if (this.closing) (clearTimeout(this.closing), (this.closing = undefined));
    this.kill();
  }
}
