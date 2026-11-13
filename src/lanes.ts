import { ChildProcess, spawn } from 'node:child_process';
import { REMOTE_CEILING_BPS, REMOTE_LONG_SIDE, REMOTE_MAX_FPS, REMOTE_START_BPS } from './congestion.js';
import { bitrateFor, H264Settings, helperArgs, Producer, ProducerHooks, RecordParser, StartProducer } from './h264.js';
import type { H264Want } from './types.js';

/**
 * Encoder lanes: one phonecap process per phone (one USB capture), several H.264 encoders fed by it, each with its own
 * size, frame rate and bitrate. A LAN viewer (Rinor) keeps full size at 60 fps on its lane while a far viewer (the
 * owner over Tailscale) gets a small 30 fps lane whose bitrate and frame rate follow its link, and a far viewer's
 * keyframe asks and congestion never touch the LAN lane. Each lane is an H264Source (src/h264.ts) whose producer is
 * PhonecapHost.start.
 */

export const MAX_LANES = 8;

/** What a viewer gets: its lane's key (viewers with the same key share it) and the lane's settings. */
export interface Profile {
  key: string;
  remote: boolean;
  settings: H264Settings;
}

/**
 * A viewer's lane from what it asked. LAN (and `full`): exactly what it asked. Far (Tailscale, the Internet): at most
 * 30 fps and about 1400 px on the long side, starting at 1.5 Mbps and climbing to its `bitrate` ask (2.5 Mbps without
 * one), frame rate lowered with the bitrate.
 */
export function profileFor(want: H264Want, dfltBps: number, longSidePx: number | null): Profile {
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
    settings: { fps, scale, bitrate: Math.min(ceiling, REMOTE_START_BPS), maxBitrate: ceiling, adaptFps: true, keySeconds: 2 },
  };
}

export type Spawn = (bin: string, args: string[]) => ChildProcess;
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

  constructor(private bin: string, private args: string[], private label: string, private spawnFn: Spawn = realSpawn) {}

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
    return {
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
    };
  }

  private write(line: string): void {
    const stdin = this.proc?.stdin;
    if (stdin?.writable) stdin.write(`${line}\n`);
  }

  private spawn(want: H264Settings): void {
    const p = this.spawnFn(this.bin, [...this.args, ...helperArgs(want)]);
    this.proc = p;
    const tail: string[] = [];
    const parser = new RecordParser((r) => this.lanes.get(r.lane ?? 0)?.record(r));
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
    const hooks = [...this.lanes.values()];
    this.lanes.clear();
    for (const h of hooks) h.exit(why);
  }

  private kill(): void {
    const p = this.proc;
    this.proc = undefined;
    this.lanes.clear();
    if (!p) return;
    if (p.stdin?.writable) p.stdin.write('quit\n');
    p.kill('SIGTERM');
    setTimeout(() => p.kill('SIGKILL'), 1500).unref();
  }

  /** Stops the process now (the phone was unplugged, the server stops); its sources are closed by the caller. */
  close(): void {
    this.kill();
  }
}
