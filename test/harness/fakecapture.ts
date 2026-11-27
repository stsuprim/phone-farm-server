// A fake capture (phonecap): a producer of the server's record stream (INFO, CONFIG, KEY, DELTA, STATS) with the
// failure modes docs/root-cause.md §3 and §6 describe. It is shaped like src/h264.ts's StartProducer
// (`(want, hooks) => producer`), so it plugs into the capture source whatever file that source lives in after the
// rebuild (test/harness/src.ts finds it). It never runs a process; `alive` counts the "processes" a test would see.
export const KIND = { INFO: 0, CONFIG: 1, KEY: 2, DELTA: 3, STATS: 4, BEAT: 7 } as const;

export interface Rec {
  kind: number;
  time: number;
  payload: Buffer;
  arrived: number;
  lane?: number;
  /** Fake only: this record re-sends an older picture (phonecap's requestKey on a silent capture). */
  repeat?: boolean;
}
export interface Hooks {
  record(r: Rec): void;
  exit(reason: string): void;
  capturing?(): void;
}

export interface FakeCaptureOptions {
  /** ms from start to the "capturing" line (the screen device found). Default 50. */
  findMs?: number;
  /** ms from "capturing" to the first keyframe; 'never' = a session that runs and gives nothing. Default 50. */
  firstFrameMs?: number | 'never';
  /** Frames per second while the screen moves (deltas). Default 10. */
  fps?: number;
  /** Keyframe every this many ms. Default 2000. */
  keyEveryMs?: number;
  /** After this many ms of frames, the session goes silent: no frames and no heartbeat (a dead CoreMediaIO session). */
  dieAfterMs?: number;
  /** After this many ms the screen goes still: no deltas, but the heartbeat (STATS) keeps coming. */
  stillAfterMs?: number;
  /** A heartbeat record every this many ms while the session runs (0 = none, like phonecap before 2026-11-27). Default 0. */
  heartbeatMs?: number;
  /** The heartbeat's record kind: KIND.BEAT (7) where the server has it, else STATS (4). */
  beatKind?: number;
  /** ms a stop takes before the process has really exited (SIGTERM, then SIGKILL 1.5 s later). Default 0. */
  stopMs?: number;
  /** On a key request with nothing new: re-send the last picture stamped now (phonecap's behaviour) or with its own time. */
  rekey?: 'stamp-now' | 'true-time';
  width?: number;
  height?: number;
}

export interface FakeCapture {
  /** The options, read again at every start (a test changes them between starts). */
  opts: FakeCaptureOptions;
  start: (want: unknown, hooks: Hooks) => {
    key(): void;
    stop(): void;
    reportsCapturing: boolean;
    restart?(why: string): void;
    bitrate?(bps: number): void;
    fps?(fps: number): void;
  };
  /** Producers started so far. */
  starts: number;
  /** Producers whose process hasn't exited yet (more than 1 = two phonecaps on one screen device). */
  alive: number;
  maxAlive: number;
  /** Every record handed to the source, in order. */
  sent: Rec[];
  /** The capture time of the last real (non-repeat) frame. */
  lastFrameAt: number;
}

const info = (w: number, h: number) => Buffer.from(JSON.stringify({ width: w, height: h, fps: 30, scale: 50 }));

export function fakeCapture(o: FakeCaptureOptions = {}): FakeCapture {
  const fc: FakeCapture = {
    opts: o, starts: 0, alive: 0, maxAlive: 0, sent: [], lastFrameAt: 0,
    start: (_want, hooks) => {
      fc.starts++;
      fc.alive++;
      fc.maxAlive = Math.max(fc.maxAlive, fc.alive);
      const timers = new Set<NodeJS.Timeout>();
      const later = (ms: number, fn: () => void) => {
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        timers.add(t);
      };
      const every = (ms: number, fn: () => void) => {
        const t = setInterval(fn, ms);
        timers.add(t);
      };
      let stopped = false;
      let exited = false;
      let lastKey: Rec | null = null;
      let startedAt = 0;
      let dead = false;
      const w = o.width ?? 642;
      const h = o.height ?? 1388;
      const emit = (kind: number, payload: Buffer, time = Date.now(), repeat = false) => {
        if (stopped || dead) return;
        const r: Rec = { kind, time, payload, arrived: Date.now(), lane: 0, ...(repeat ? { repeat } : {}) };
        fc.sent.push(r);
        if (kind === KIND.KEY && !repeat) lastKey = r;
        if ((kind === KIND.KEY || kind === KIND.DELTA) && !repeat) fc.lastFrameAt = time;
        hooks.record(r);
      };
      // an Annex-B-ish keyframe: SPS, PPS, IDR start codes (enough for anything that looks for parameter sets)
      const keyPayload = () => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x1f]), Buffer.from([0, 0, 0, 1, 0x68, 0xce]), Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(800, 7)]);
      const deltaPayload = () => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x41]), Buffer.alloc(120, 3)]);
      let gone: () => void = () => {};
      const exitedP = new Promise<void>((r) => (gone = r));
      const exit = (why: string) => {
        if (exited) return;
        exited = true;
        fc.alive--;
        gone();
        hooks.exit(why);
      };
      const begin = () => {
        if (stopped) return;
        hooks.capturing?.();
        if (o.heartbeatMs) every(o.heartbeatMs, () => !dead && emit(o.beatKind ?? KIND.STATS, Buffer.from(JSON.stringify({ running: true, handed: fc.sent.length, encoded: fc.sent.length, fps: 0 }))));
        if (o.firstFrameMs === 'never') return;
        later(o.firstFrameMs ?? 50, () => {
          startedAt = Date.now();
          emit(KIND.INFO, info(w, h));
          emit(KIND.CONFIG, Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x1f, 0, 0, 0, 1, 0x68, 0xce]));
          emit(KIND.KEY, keyPayload());
          let lastKeyAt = Date.now();
          every(Math.round(1000 / (o.fps ?? 10)), () => {
            const t = Date.now() - startedAt;
            if (o.dieAfterMs !== undefined && t >= o.dieAfterMs) {
              dead = true; // no frames, no heartbeat, and the process lives on
              return;
            }
            if (o.stillAfterMs !== undefined && t >= o.stillAfterMs) return; // a still screen: nothing new
            if (Date.now() - lastKeyAt >= (o.keyEveryMs ?? 2000)) {
              lastKeyAt = Date.now();
              emit(KIND.KEY, keyPayload());
            } else emit(KIND.DELTA, deltaPayload());
          });
        });
      };
      later(o.findMs ?? 50, begin);
      const end = (why: string) => {
        if (stopped) return;
        stopped = true;
        for (const t of timers) {
          clearTimeout(t);
          clearInterval(t);
        }
        if (o.stopMs) setTimeout(() => exit(why), o.stopMs).unref();
        else exit(why);
      };
      return {
        reportsCapturing: true,
        key: () => {
          if (stopped || dead) {
            // phonecap answers a key request with the last picture encoded again (main.swift:1495-1501)
            if (dead && lastKey && !stopped) {
              const r: Rec = { ...lastKey, time: o.rekey === 'true-time' ? lastKey.time : Date.now(), arrived: Date.now(), repeat: true };
              fc.sent.push(r);
              hooks.record(r);
            }
            return;
          }
          emit(KIND.KEY, keyPayload());
        },
        // like the real producers (src/h264.ts helperProducer, src/lanes.ts PhonecapHost): settles once the process exited
        stop: () => {
          end('stopped');
          return exitedP;
        },
        restart: (why: string) => end(`restart: ${why}`),
        bitrate: () => {},
        fps: () => {},
      };
    },
  };
  return fc;
}
