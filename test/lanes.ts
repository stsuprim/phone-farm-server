// Encoder lanes (one phonecap, several encoders) and the far-viewer profile: record demux by lane, the host's lane
// commands, profiles, frame rate following the bitrate, MJPEG send window, per-lane stats.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { REMOTE_CEILING_BPS, REMOTE_START_BPS, WsFlow } from '../src/congestion.js';
import { encodeRecord, fpsFor, H264Source, H264Viewer, KIND, phoneStats, ProducerHooks, Rec, RecordParser, Transport } from '../src/h264.js';
import { PhonecapHost, profileFor } from '../src/lanes.js';
import { paceFor } from '../src/rtc.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const tick = () => new Promise((r) => setImmediate(r));

// ---- records carry their lane in the kind byte's high nibble ----
{
  const got: Rec[] = [];
  const p = new RecordParser((r) => got.push(r));
  p.push(Buffer.concat([
    encodeRecord(KIND.KEY, 1, Buffer.from([1])),
    encodeRecord((2 << 4) | KIND.DELTA, 2, Buffer.from([2])),
    encodeRecord((7 << 4) | KIND.INFO, 3, Buffer.from('{}')),
  ]));
  assert.deepEqual(got.map((r) => [r.lane, r.kind]), [[0, KIND.KEY], [2, KIND.DELTA], [7, KIND.INFO]]);
  assert.throws(() => new RecordParser(() => {}).push(encodeRecord((1 << 4) | 9, 0, Buffer.alloc(0))));
  ok('records: lane in the high nibble (0 = an older helper), kind in the low one');
}

// ---- the host: one process, lanes added and removed by stdin commands ----
{
  const spawned: { args: string[]; lines: string[]; proc: ChildProcess & EventEmitter; out: PassThrough; kills: string[] }[] = [];
  const spawnFn = (_bin: string, args: string[]) => {
    const proc = new EventEmitter() as ChildProcess & EventEmitter;
    const stdin = new PassThrough();
    const out = new PassThrough();
    const rec = { args, lines: [] as string[], proc, out, kills: [] as string[] };
    stdin.on('data', (d: Buffer) => rec.lines.push(...d.toString().split('\n').filter(Boolean)));
    Object.assign(proc, { stdin, stdout: out, stderr: new PassThrough(), kill: (s: string) => (rec.kills.push(s), true) });
    spawned.push(rec);
    return proc;
  };
  const host = new PhonecapHost('phonecap', ['--udid', 'U'], 'test', spawnFn);
  const seen: [string, number, number][] = [];
  const exits: string[] = [];
  const hooks = (name: string): ProducerHooks => ({ record: (r) => seen.push([name, r.lane ?? 0, r.kind]), exit: (why) => exits.push(`${name}: ${why}`) });

  const lan = host.start({ fps: 60, scale: 100, bitrate: 8_000_000 }, hooks('lan'));
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]!.args, ['--udid', 'U', '--fps', '60', '--scale', '100', '--bitrate', '8000000', '--key-seconds', '2']);
  const far = host.start({ fps: 30, scale: 50, bitrate: 1_500_000, keySeconds: 2 }, hooks('far'));
  assert.equal(spawned.length, 1, 'the second lane shares the process');
  far.key();
  far.bitrate!(900_000);
  far.fps!(20);
  lan.key();
  await tick();
  assert.deepEqual(spawned[0]!.lines, ['lane 1 30 50 1500000 2', 'key 1', 'bitrate 1 900000', 'fps 1 20', 'key 0']);

  spawned[0]!.out.write(Buffer.concat([encodeRecord(KIND.KEY, 1, Buffer.from([1])), encodeRecord((1 << 4) | KIND.KEY, 1, Buffer.from([1])), encodeRecord((3 << 4) | KIND.KEY, 1, Buffer.from([1]))]));
  await tick();
  assert.deepEqual(seen, [['lan', 0, KIND.KEY], ['far', 1, KIND.KEY]], 'each lane gets its own records; an unknown lane is ignored');

  lan.stop();
  await tick();
  assert.equal(spawned[0]!.lines.at(-1), 'unlane 0');
  assert.equal(host.running, true, 'still running for the far lane');
  const again = host.start({ fps: 60, scale: 100, bitrate: 8_000_000 }, hooks('lan2'));
  await tick();
  assert.equal(spawned[0]!.lines.at(-1), 'lane 0 60 100 8000000 2', 'a freed lane is reused');
  again.stop();
  far.stop();
  await tick();
  assert.equal(host.running, false);
  assert.ok(spawned[0]!.lines.includes('quit') && spawned[0]!.kills.includes('SIGTERM'), 'the last lane stops the process');

  // a crash: every lane hears it, and the next start runs a new process
  host.start({ fps: 60, scale: 100, bitrate: 8_000_000 }, hooks('a'));
  host.start({ fps: 30, scale: 50, bitrate: 1_500_000 }, hooks('b'));
  spawned[1]!.proc.emit('exit', 6, null);
  assert.deepEqual(exits, ['a: capture helper exited (6)', 'b: capture helper exited (6)']);
  host.start({ fps: 30, scale: 50, bitrate: 1_500_000 }, hooks('c'));
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2]!.args[3], '30', 'the restart takes the first lane\'s settings');
  host.close();
  ok('host: first lane starts phonecap, others via "lane", key/bitrate/fps per lane, unlane, quit with the last, crash -> all');
}

// ---- profiles: LAN as asked, a far viewer smaller, 30 fps, starting low ----
{
  const lan = profileFor({ fps: 60, scale: 100, quality: null, bitrate: 10_000_000, remote: false }, 8_000_000, 2778);
  assert.equal(lan.remote, false);
  assert.deepEqual(lan.settings, { fps: 60, scale: 100, bitrate: 10_000_000, keySeconds: 2 });
  const far = profileFor({ fps: 60, scale: 50, quality: null, bitrate: 4_000_000, remote: true }, 8_000_000, 2778);
  assert.equal(far.remote, true);
  assert.equal(far.settings.fps, 30);
  assert.equal(far.settings.scale, 50, 'Lotus Smooth (50 %) fits a far lane: 1389 px long side');
  assert.equal(far.settings.bitrate, REMOTE_START_BPS);
  assert.equal(far.settings.maxBitrate, 4_000_000, 'the ask is the ceiling');
  assert.equal(far.settings.adaptFps, true);
  const sharp = profileFor({ fps: 60, scale: 100, quality: null, bitrate: null, remote: true }, 8_000_000, 2532);
  assert.equal(sharp.settings.scale, 55, 'full size is capped to ~1400 px on the long side');
  assert.equal(sharp.settings.maxBitrate, REMOTE_CEILING_BPS);
  const full = profileFor({ fps: 60, scale: 100, quality: null, bitrate: null, remote: true, full: true }, 8_000_000, 2778);
  assert.equal(full.remote, false, 'full=1: exactly as asked');
  assert.notEqual(lan.key, far.key);
  assert.equal(paceFor(4_000_000), 6_000_000);
  assert.equal(paceFor(1_000_000), 3_000_000);
  ok('profiles: LAN as asked; far = 30 fps, <= ~1400 px, 1.5 Mbps start, ask as ceiling; full=1 opts out; pacing 1.5x');
}

// ---- a far lane's frame rate follows its bitrate ----
{
  assert.equal(fpsFor(2_000_000, 30), 30);
  assert.equal(fpsFor(800_000, 30), 20);
  assert.equal(fpsFor(400_000, 30), 12);
  assert.equal(fpsFor(400_000, 10), 10);
  let hooks!: ProducerHooks;
  const fps: number[] = [];
  const rates: number[] = [];
  const src = new H264Source('t', (_w, h) => {
    hooks = h;
    return { key: () => {}, stop: () => {}, bitrate: (b) => void rates.push(b), fps: (f) => void fps.push(f) };
  }, { fps: 30, scale: 50, bitrate: 1_500_000, maxBitrate: 4_000_000, adaptFps: true }, { log: () => {}, kind: 'remote' });
  const opened = src.open();
  hooks.record({ kind: KIND.INFO, time: 0, payload: Buffer.from('{"width":642,"height":1388,"fps":30,"scale":50}'), arrived: 0 });
  hooks.record({ kind: KIND.KEY, time: 1, payload: Buffer.from([0, 0, 0, 1, 0x65]), arrived: 0 });
  await opened;
  const t: Transport = { kind: 'ws', buffered: () => 0, open: () => true, send: () => {}, fail: () => {} };
  const v = new H264Viewer(t, src);
  src.add(v);
  src.setTarget(v, 3_000_000);
  assert.equal(rates.at(-1), 3_000_000, 'climbs above the start, up to the ceiling');
  src.setTarget(v, 9_000_000);
  assert.equal(rates.at(-1), 4_000_000, 'never above the ceiling');
  assert.deepEqual(fps, []);
  src.setTarget(v, 700_000);
  assert.deepEqual(fps, [20]);
  src.setTarget(v, 450_000);
  assert.deepEqual(fps, [20, 12]);
  src.setTarget(v, 2_000_000);
  assert.deepEqual(fps, [20, 12, 30]);
  const st = phoneStats([src], { fps: 0, viewers: 0 }, null);
  assert.equal(st.codec, 'h264');
  assert.equal(st.lanes?.length, 1);
  assert.equal(st.lanes?.[0]?.kind, 'remote');
  assert.equal(st.lanes?.[0]?.fps_target, 30);
  assert.equal(st.bitrate_kbps, 2000);
  src.close();
  ok('far lane: bitrate climbs to the ceiling; fps 30 -> 20 -> 12 as the link thins, back up when it clears; lane stats');
}

// ---- MJPEG: one frame may follow one on its way, never more while the link is behind ----
{
  let t = 0;
  const pings: Buffer[] = [];
  let pong!: (d: Buffer) => void;
  const flow = new WsFlow({ ping: () => {}, on: (_e, l) => void (pong = l) }, (b) => void pings.push(b), { now: () => t, targetMs: 250 });
  assert.equal(flow.canSend(100_000), true, 'nothing on the way');
  flow.sent(100_000);
  t += 20;
  assert.equal(flow.canSend(100_000), true, 'a second frame right behind the first');
  flow.sent(100_000);
  t += 400; // both still unanswered: the link is behind
  assert.equal(flow.canSend(100_000), false, 'not a third');
  pong(pings[0]!); // the first arrived
  assert.equal(flow.inflight(), 100_000);
  t += 10;
  pong(pings[1]!);
  assert.equal(flow.inflight(), 0);
  assert.equal(flow.canSend(100_000), true);
  ok('MJPEG window: a frame may follow one on its way (no idle round trip), never a third while behind');
}

console.log(`\nall ${passed} lane checks passed`);
setTimeout(() => process.exit(0), 50).unref();
