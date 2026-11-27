// 2026-11-27 (docs/root-cause.md 3, 5, 6): the live view degrades and never freezes. A far link (Tailscale across
// countries: ~185 ms round trip, ~127 ms jitter) must not read as congestion; a real queue is cut on and the bitrate
// comes back within seconds after; a capture that stalls is found by its heartbeat and started over; a still screen
// isn't a freeze; every freeze is labelled by cause; re-encoded old pictures keep their own time.
import assert from 'node:assert/strict';
import { DELAY_HOLD_MS, DELAY_MARKS, DelayTracker, FreezeProbe, FreezeTracker, JitterDelay, LINK_CLASSES, LinkControl, playoutFor, RateControl } from '../src/congestion.js';
import { CaptureState, H264Source, H264Viewer, KIND, Producer, ProducerHooks, Rec, scaleFor, Transport } from '../src/h264.js';
import { mockProducer } from '../src/h264mock.js';
import { acquireCapture, captureHolders, latestFrame, releaseCapture, resetCaptureRegistry, setCaptureBackend } from '../src/lanes.js';

// the capture's watchdogs are unref'd timers (they never keep the server alive): keep this test's process up
const keepAlive = setInterval(() => {}, 1000);
let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
};

/** A seeded PRNG (mulberry32): the same "random" path on every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Tailscale's far path: 185 ms base, plus a delay with a mean of 127 ms (RFC 3550 jitter ~127 ms) and rare spikes. */
function farPath(seed: number) {
  const r = rng(seed);
  return () => 185 + -Math.log(1 - r()) * 127 + (r() < 0.02 ? 400 * r() : 0);
}

// ---- the jitter-aware delay signal against the old one, on the far path ----
const START = 1_500_000;
const CEILING = 2_500_000;
{
  // the old control (to 2026-11-27): queue = the latest round trip minus the quickest of 30 s, cut over 150 ms
  let t = 0;
  const old = new DelayTracker(30_000, () => t);
  const oldRc = new RateControl(CEILING, START, 400_000, () => t);
  let oldMin = Infinity;
  // the new one: the same samples, the receiver's RTCP jitter too
  const link = new LinkControl({ ceiling: CEILING, start: START, remote: true, now: () => t });
  let newMin = Infinity;
  const path = farPath(7);
  for (let s = 0; s < 1800; s++) {
    t += 1000;
    const rtt = path();
    old.add(rtt);
    link.delay.add(rtt);
    link.delay.addJitter(127 + (rng(s)() - 0.5) * 20);
    const q = old.queueMs();
    const m = DELAY_MARKS.remote;
    if (q !== null && q > m.cut) oldRc.down(q > m.hard ? 0.6 : 0.85, null, DELAY_HOLD_MS);
    else if (q === null || q < m.clear) oldRc.up();
    if (s > 30) oldMin = Math.min(oldMin, oldRc.bps);
    const tk = link.tick({ sent: 300, nacked: 0, reportLoss: 0 });
    if (s > 30) newMin = Math.min(newMin, tk.bps);
  }
  assert.ok(oldMin <= 600_000, `the old control collapses on jitter alone (it reached ${Math.round(oldMin / 1000)} kbit/s): the iPhone-2 freezes`);
  // one report a second makes a noisy median: a rare single x0.85 (fast recovery) is allowed, a collapse never
  assert.ok(link.cuts.delay <= 3, `jitter is (almost) never read as a queue (${link.cuts.delay} delay cuts in 30 min)`);
  assert.ok(newMin >= 1_200_000, `never near the floor on a jittery but steady path (lowest ${Math.round(newMin / 1000)} kbit/s)`);
  assert.ok(link.rc.bps >= CEILING * 0.85, 'it climbs to the ceiling');
  const sig = link.delay.signal();
  assert.ok(sig.jitter >= 120 && sig.threshold >= 2 * 120, `jitter measured (${Math.round(sig.jitter)} ms), threshold >= 2x it (${Math.round(sig.threshold)} ms)`);
  assert.equal(link.linkClass().name, 'far', 'a 185 ms, jittery path is a far link');
  const po = link.playout()!;
  assert.ok(po.min >= 150 && po.max >= po.min * 2, `a bigger jitter buffer is asked for (${po.min}-${po.max} ms)`);
  ok(`far path (185 ms, 127 ms jitter, 30 min): the old control fell to ${Math.round(oldMin / 1000)} kbit/s; the new one cut ${link.cuts.delay}x on delay and held ${Math.round(newMin / 1000)}+ kbit/s, playout ${po.min}-${po.max} ms`);
}
{
  // the same with receiver reports 4x a second, and without any RTCP jitter (the round trips' own spread is measured)
  let t = 0;
  const link = new LinkControl({ ceiling: CEILING, start: START, remote: true, now: () => t });
  const path = farPath(11);
  let min = Infinity;
  for (let s = 0; s < 120; s++) {
    for (let k = 0; k < 4; k++) {
      t += 250;
      link.delay.add(path());
    }
    min = Math.min(min, link.tick({ sent: 300, nacked: 0, reportLoss: 0 }).bps);
  }
  assert.equal(link.cuts.delay, 0);
  assert.ok(min >= START);
  ok('far path, 4 reports a second and no RTCP jitter: the spread of the round trips alone keeps it from cutting');
}

// ---- a real queue is cut on, and the bitrate comes back within seconds after ----
{
  let t = 0;
  const link = new LinkControl({ ceiling: CEILING, start: START, remote: true, now: () => t });
  const path = farPath(3);
  const tick = (extra: number) => {
    t += 1000;
    link.delay.add(path() + extra);
    link.delay.addJitter(127);
    return link.tick({ sent: 300, nacked: 0, reportLoss: 0 });
  };
  for (let s = 0; s < 60; s++) tick(0);
  assert.equal(link.rc.bps, CEILING);
  // a router's buffer fills: +200 ms a second for 8 s, held 4 s, then it drains
  let queue = 0;
  let cutAt = -1;
  for (let s = 0; s < 12; s++) {
    if (s < 8) queue += 200;
    const r = tick(queue);
    if (r.why === 'delay' && cutAt < 0) cutAt = s;
  }
  assert.ok(cutAt >= 0 && cutAt <= 7, `a queue building is cut on within seconds (after ${cutAt + 1} s)`);
  const low = link.rc.bps;
  assert.ok(low < CEILING * 0.8, `cut to ${Math.round(low / 1000)} kbit/s`);
  assert.ok(low >= LINK_CLASSES.far.floorBps);
  let back = -1;
  for (let s = 0; s < 30; s++) {
    tick(0);
    if (back < 0 && link.rc.bps >= CEILING * 0.9) back = s + 1;
  }
  assert.ok(back > 0 && back <= 20, `back to 90 % of what it carried within ${back} s (fast recovery)`);
  ok(`a real queue (+200 ms/s) is cut on after ${cutAt + 1} s, down to ${Math.round(low / 1000)} kbit/s; back to 90 % ${back} s after it drained`);
}

// ---- heavy loss: cut at once and a keyframe now; the floor holds ----
{
  let t = 0;
  const link = new LinkControl({ ceiling: CEILING, start: START, remote: true, now: () => t });
  let keys = 0;
  for (let s = 0; s < 40; s++) {
    t += 1000;
    link.delay.add(190);
    const r = link.tick({ sent: 300, nacked: 90, reportLoss: 0.3 });
    if (r.keyNow) keys++;
  }
  assert.equal(link.rc.bps, LINK_CLASSES.far.floorBps, 'down to the far floor, never below');
  assert.ok(keys >= 10 && keys <= 14, `a keyframe now at most every 3 s on heavy loss (${keys} in 40 s)`);
  assert.deepEqual(playoutFor(10), { min: 60, max: 400 });
  assert.equal(scaleFor(2_000_000, 50), 50);
  assert.equal(scaleFor(600_000, 50), 38);
  assert.equal(scaleFor(300_000, 50), 25);
  assert.equal(scaleFor(300_000, 30), 20, 'never under 20 %');
  ok('heavy loss: cut, a keyframe at most every 3 s, the far floor (300 kbit/s); a thin link shrinks the picture (scaleFor)');
}

// ---- freeze labels (pure) ----
{
  let t = 1000;
  const p: FreezeProbe = { state: 'Live', srcFrames: 0, devFrames: 0, dropped: 0, loss: 0 };
  const ft = new FreezeTracker(() => ({ ...p }), () => t);
  const frame = () => {
    p.srcFrames++;
    p.devFrames! += 1;
    ft.sent();
    t += 33;
  };
  for (let i = 0; i < 30; i++) frame();
  // a still screen: the capture runs, nothing new
  p.state = 'Still';
  t += 3000;
  ft.tick();
  assert.equal(ft.ongoing()?.cause, 'still');
  p.state = 'Live';
  frame();
  // the device hands frames over, nothing comes out of the encoder
  t += 1500;
  p.devFrames! += 40;
  assert.equal(ft.ongoing()?.cause, 'encoder');
  frame();
  // frames made, dropped for the link
  p.srcFrames += 20;
  p.dropped += 20;
  t += 1200;
  frame();
  // the capture restarting
  p.state = 'Restarting';
  t += 400;
  ft.tick();
  p.state = 'Finding';
  t += 900;
  ft.tick();
  p.state = 'Live';
  frame();
  // the client froze while frames reached it: on a clean link (decoder), then on a lossy one
  ft.client(800);
  p.loss = 0.12;
  ft.client(500);
  const st = ft.stats();
  assert.deepEqual(st.by_cause, { src: 1, encoder: 1, network: 2, client: 1 });
  assert.equal(st.still_gaps, 1, 'a still screen is not a freeze');
  assert.equal(st.count, 5);
  assert.match(st.last.find((e) => e.cause === 'src')!.detail, /Restarting, Finding/);
  ok('freezes labelled by cause: src (restarting/finding), encoder (frames in, none out), network (dropped; client on a lossy link), client (decoder); still screens apart');
}

// ---- the capture: heartbeat, Live <-> Still, Stale and back, repeats, freezes through a real source ----
/** A hand-driven helper with heartbeats; every start is kept (a restarted one's late records must not count). */
function helper() {
  const runs: { hooks: ProducerHooks; stops: number; restarts: string[]; keys: number; whole: boolean[] }[] = [];
  const start = (_w: unknown, hooks: ProducerHooks): Producer => {
    const run = { hooks, stops: 0, restarts: [] as string[], keys: 0, whole: [] as boolean[] };
    runs.push(run);
    return {
      key: () => void run.keys++,
      stop: () => void run.stops++,
      restart: (why: string, whole?: boolean) => {
        run.restarts.push(why);
        run.whole.push(!!whole);
      },
    };
  };
  const rec = (i: number, kind: number, payload: Buffer, time = Date.now(), repeat = false) =>
    runs[i]!.hooks.record({ kind, time, payload, arrived: Date.now(), ...(repeat ? { repeat: true } : {}) });
  const beat = (i: number, framesIn: number, running = true, lastFrame = Date.now()) =>
    rec(i, KIND.BEAT, Buffer.from(JSON.stringify({ running, finding: false, frames_in: framesIn, frames_out: framesIn, last_frame: lastFrame, lanes: 1 })));
  const up = (i: number) => {
    rec(i, KIND.INFO, Buffer.from('{"width":100,"height":200,"fps":30,"scale":100}'));
    rec(i, KIND.CONFIG, Buffer.from([0, 0, 0, 1, 0x67, 0, 0, 0, 1, 0x68]));
    rec(i, KIND.KEY, Buffer.from([0, 0, 0, 1, 0x65]));
  };
  const delta = (i: number) => rec(i, KIND.DELTA, Buffer.from([0, 0, 0, 1, 0x41]));
  return { runs, start, rec, beat, up, delta };
}
function viewer(src: H264Source, buffered = () => 0) {
  const sent: Rec[] = [];
  const t: Transport = { kind: 'ws', buffered, open: () => true, send: (r) => void sent.push(r), fail: () => {} };
  return { v: new H264Viewer(t, src), sent };
}
{
  const h = helper();
  const states: CaptureState[] = [];
  const src = new H264Source('t', h.start, { fps: 30, scale: 100, bitrate: 2e6 }, { log: () => {}, idleMs: 50, staleMs: 300, stillMs: 150 });
  src.onState((s) => states.push(s));
  const opened = src.openState();
  assert.equal(src.captureState(), 'Starting');
  h.beat(0, 0);
  h.up(0);
  assert.equal((await opened).state, 'Live', 'openState resolves on the picture');
  const a = viewer(src);
  src.add(a.v);
  const ft = new FreezeTracker(() => {
    const c = src.counters();
    return { state: c.state, srcFrames: c.srcFrames, devFrames: c.devFrames, dropped: a.v.dropped, loss: 0 };
  }, Date.now, 200);
  const flow = async (ms: number) => {
    const end = Date.now() + ms;
    let n = 0;
    while (Date.now() < end) {
      h.delta(h.runs.length - 1);
      if (++n % 3 === 0) h.beat(h.runs.length - 1, 3);
      ft.sent();
      await sleep(30);
    }
  };
  await flow(300);
  assert.equal(src.captureState(), 'Live');

  // a still screen: heartbeats go on with no frames: Still, never restarted
  const stillFrom = Date.now();
  while (Date.now() - stillFrom < 700) {
    h.beat(0, 0, true, stillFrom - 30);
    ft.tick();
    await sleep(60);
  }
  assert.equal(src.captureState(), 'Still');
  assert.equal(h.runs.length, 1, 'a still screen is never started over');
  assert.equal(ft.ongoing()?.cause, 'still');
  // a keyframe asked on the still screen comes as a repeat with the picture's own (old) time
  const age0 = src.sourceAgeMs()!;
  h.rec(0, KIND.KEY, Buffer.from([0, 0, 0, 1, 0x65]), stillFrom - 30, true);
  assert.ok(src.sourceAgeMs()! >= age0, 'a re-encoded old picture does not make the source look fresh');
  assert.equal(a.sent.at(-1)!.repeat, true, 'the viewer gets it marked as a repeat');
  assert.equal(a.sent.at(-1)!.time, stillFrom - 30, 'stamped with its own capture time, not now');
  assert.equal(src.captureState(), 'Still');
  await flow(200);
  assert.equal(src.captureState(), 'Live');
  assert.equal(ft.stats().still_gaps, 1);
  assert.equal(ft.stats().count, 0, 'no freeze so far');

  // the helper hangs: no heartbeat, no frame -> Stale -> started over -> Live again within seconds
  const hungAt = Date.now();
  await until('stale', () => h.runs[0]!.restarts.length > 0, 2000);
  assert.ok(Date.now() - hungAt < 800, `found stale ${Date.now() - hungAt} ms after its last heartbeat`);
  assert.match(h.runs[0]!.restarts[0]!, /heartbeat stopped/);
  assert.deepEqual(h.runs[0]!.whole, [true], 'the whole helper is ended (it hung), not just the lane');
  assert.ok(states.includes('Stale'));
  ft.tick();
  await until('a new start', () => h.runs.length === 2, 2000);
  h.beat(1, 0);
  h.up(1);
  await flow(150);
  assert.equal(src.captureState(), 'Live');
  const back = Date.now() - hungAt;
  assert.ok(back < 2000, `a picture again ${back} ms after the hang`);
  const fs = ft.stats();
  assert.equal(fs.by_cause.src, 1, 'that freeze is put down to the source');
  assert.equal(fs.count, 1);
  // the late records of the hung helper are ignored
  h.delta(0);
  h.beat(0, 0, false);

  // the session stops running (the heartbeat says so twice): Stale too
  h.beat(1, 0, false);
  h.beat(1, 0, false);
  await until('stale (not running)', () => h.runs[1]!.restarts.length > 0, 1000);
  assert.match(h.runs[1]!.restarts[0]!, /stopped running/);
  await until('a third start', () => h.runs.length === 3, 2000);
  h.up(2);
  // the device hands frames over but nothing comes out of the encoder (3 heartbeats): Stale (encoder)
  h.delta(2);
  h.beat(2, 30); // this one still saw the delta
  h.beat(2, 30);
  h.beat(2, 30);
  assert.equal(h.runs[2]!.restarts.length, 0, 'two empty heartbeats are not yet a stall');
  h.beat(2, 30);
  await until('stale (encoder)', () => h.runs[2]!.restarts.length > 0, 1000);
  assert.match(h.runs[2]!.restarts[0]!, /no picture comes out of its encoder/);
  assert.equal(src.unavailable(), null, 'stalls after a picture never count as failed starts');
  src.remove(a.v);
  src.close();
  assert.deepEqual([...new Set(states)].filter((s) => ['Starting', 'Live', 'Still', 'Stale', 'Finding'].includes(s)).sort(), ['Finding', 'Live', 'Starting', 'Stale', 'Still'].filter((s) => states.includes(s as CaptureState)).sort());
  ok(`capture: Live <-> Still on a still screen (never restarted), repeats keep their time, a hung helper is Stale and Live again in ${back} ms, a dead session and an encoder stall are Stale too`);
}
{
  // a far viewer's link backed up: frames dropped -> the freeze is the network's
  const h = helper();
  const src = new H264Source('t', h.start, { fps: 30, scale: 100, bitrate: 2e6 }, { log: () => {}, idleMs: 50, staleMs: 600 });
  const p = src.open();
  h.up(0);
  await p;
  let backed = 0;
  const a = viewer(src, () => backed);
  src.add(a.v);
  const ft = new FreezeTracker(() => {
    const c = src.counters();
    return { state: c.state, srcFrames: c.srcFrames, devFrames: c.devFrames, dropped: a.v.dropped, loss: 0 };
  }, Date.now, 150);
  const sendCount = () => a.sent.length;
  let last = sendCount();
  const step = async () => {
    h.delta(0);
    if (sendCount() > last) ft.sent();
    last = sendCount();
    await sleep(25);
  };
  for (let i = 0; i < 6; i++) await step();
  backed = 10_000_000;
  for (let i = 0; i < 10; i++) await step();
  backed = 0;
  h.rec(0, KIND.KEY, Buffer.from([0, 0, 0, 1, 0x65]));
  ft.sent();
  assert.equal(ft.stats().by_cause.network, 1);
  src.remove(a.v);
  src.close();
  ok('a backed-up link: frames dropped for it, the freeze labelled network');
}

// ---- WaitingUnlock: a locked phone burns no tries; the unlock brings the picture ----
{
  const h = helper();
  let locked = true;
  const src = new H264Source('t', h.start, { fps: 30, scale: 100, bitrate: 2e6 }, { log: () => {}, idleMs: 50, firstKeyMs: 60, unlockRetryMs: 80, locked: () => locked });
  const p = src.openState();
  const legacy = src.open();
  let legacyDone = false;
  legacy.then(() => (legacyDone = true), () => (legacyDone = true));
  const r = await p;
  assert.deepEqual(r, { state: 'WaitingUnlock', info: null }, 'openState tells the viewer the phone is locked');
  await sleep(500); // several quiet tries
  assert.ok(h.runs.length >= 3, `quiet tries go on (${h.runs.length})`);
  assert.equal(src.unavailable(), null, 'never given up while waiting for the unlock');
  assert.equal(src.captureState(), 'WaitingUnlock');
  assert.match(src.state(), /waiting for the phone to be unlocked/);
  assert.equal(legacyDone, false, 'open() waits on (no timer fails it)');
  locked = false;
  src.unlocked();
  const i = h.runs.length - 1;
  h.up(i);
  await legacy;
  assert.equal(src.captureState(), 'Live');
  src.close();
  ok(`WaitingUnlock: openState says so at once, ${h.runs.length - 1} quiet tries without a give-up, the unlock brings the picture`);
}

// ---- Stopping completes before Starting ----
{
  let release!: () => void;
  let starts = 0;
  const start = (_w: unknown, hooks: ProducerHooks): Producer => {
    starts++;
    setImmediate(() => {
      hooks.record({ kind: KIND.INFO, time: Date.now(), payload: Buffer.from('{"width":10,"height":20}'), arrived: Date.now() });
      hooks.record({ kind: KIND.KEY, time: Date.now(), payload: Buffer.from([0, 0, 0, 1, 0x65]), arrived: Date.now() });
    });
    return { key: () => {}, stop: () => new Promise<void>((r) => (release = r)) };
  };
  const src = new H264Source('t', start, { fps: 30, scale: 100, bitrate: 2e6 }, { log: () => {}, idleMs: 20 });
  await src.open();
  await sleep(60); // nobody added: idle-stopped, the helper still exiting
  assert.equal(src.captureState(), 'Stopping');
  const p = src.open();
  await sleep(30);
  assert.equal(starts, 1, 'no second helper while the first one still exits');
  release();
  await p;
  assert.equal(starts, 2, 'started once the first had exited');
  src.close();
  release();
  ok('Stopping completes before Starting: an open while the helper exits waits for it, then starts');
}

// ---- acquireCapture keeps the capture on; latestFrame gives a decoded still of the newest picture ----
{
  resetCaptureRegistry();
  const scene = { hue: 120, frame: 0, marks: [], app: 'com.apple.springboard' };
  const sources = new Map<string, H264Source>();
  setCaptureBackend({
    h264: (udid) => {
      let s = sources.get(udid);
      if (!s) sources.set(udid, (s = new H264Source(udid, mockProducer(() => scene, { beatMs: 100 }), { fps: 10, scale: 100, bitrate: 1e6 }, { log: () => {}, idleMs: 30 })));
      return s;
    },
  });
  assert.equal(await latestFrame('P1', 5000), null, 'nothing running: no still (latestFrame starts nothing)');
  const a = acquireCapture('P1', 'hand:post-video');
  const b = acquireCapture('P1', 'owner live view');
  assert.deepEqual(captureHolders('P1').map((x) => x.reason), ['hand:post-video', 'owner live view']);
  const src = sources.get('P1')!;
  await until('live', () => src.captureState() === 'Live', 3000);
  assert.equal(a.state(), 'Live');
  const still = await latestFrame('P1', 2000);
  assert.ok(still, 'a still');
  assert.equal(still!.mime, 'image/png');
  assert.equal(still!.data.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(still!.capturedAt <= Date.now() && Date.now() - still!.capturedAt < 1000, 'stamped with its own capture time');
  assert.equal(await latestFrame('P1', -1), null, 'never older than asked');
  releaseCapture(a, 50);
  await sleep(150);
  assert.ok(src.running, 'one holder left: still on');
  releaseCapture(b, 50);
  releaseCapture(b, 50); // twice is harmless
  await sleep(30);
  assert.ok(src.running, 'within the grace');
  await until('stopped', () => !src.running, 2000);
  assert.equal(b.state(), 'Unavailable');
  resetCaptureRegistry();
  src.close();
  ok('acquireCapture: ref-counted, on while anyone works on the phone, off after the grace; latestFrame: a decoded still with its own time');
}

clearInterval(keepAlive);
console.log(`\nall ${passed} freeze checks passed`);
setTimeout(() => process.exit(0), 50).unref();
