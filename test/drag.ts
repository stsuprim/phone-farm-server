// The owner's live drag (2026-11-16): one contact on the phone from the press to the release, the moves in order, a
// finger held still that stays down for as long as its sender's link is alive, a touch carried on over another link
// when its first one closed, nothing of natural touch in the owner's own input (and all of it in Lotus's), and a live
// press that never waits for WDA's health checks.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { Control, HOLD_REPEAT_MS, OWNER_GRACE_MS, TOUCH_QUIET_MS, TOUCH_RELEASE_MS } from '../src/control.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import type { Backend, PathPoint } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A phone that records what reaches it, each with when (ms since the phone was made). `live`: it has HID. */
function phone(live = true, delay = 0) {
  const t0 = performance.now();
  const calls: string[] = [];
  const at: number[] = [];
  const gestures: PathPoint[][] = [];
  const say = (s: string) => {
    calls.push(s);
    at.push(performance.now() - t0);
  };
  const b = {
    mock: true,
    screen: () => ({ width: 400, height: 800, scale: 3 }),
    tap: async (_u: string, x: number, y: number, hold?: number) => {
      say(`tap ${x},${y}${hold ? ` hold ${hold}` : ''}`);
      return { via: 'wda-fast' as const };
    },
    gesture: async (_u: string, pts: PathPoint[]) => {
      gestures.push(pts.map((p) => [...p] as PathPoint));
      say(`gesture ${pts.length}`);
      return { via: 'wda-fast' as const };
    },
    liveTouchReady: () => live,
    liveTouch: async (_u: string, phase: string, x: number, y: number) => {
      if (delay) await sleep(delay);
      say(`${phase} ${x},${y}`);
      return { via: 'hid' as const };
    },
  } as unknown as Backend;
  return { b, calls, at, gestures };
}
const touch = (phase: string, x: number, y: number, seq: number, id = 1, t = seq * 10) => ({ type: 'touch', phase, x, y, t, seq, id, unit: 'pt' });
const count = (calls: string[], word: string) => calls.filter((c) => c.startsWith(word)).length;

assert.deepEqual([TOUCH_RELEASE_MS, TOUCH_QUIET_MS, HOLD_REPEAT_MS, OWNER_GRACE_MS], [6000, 5000, 800, 2500]);

// ---- a live drag: one contact from down to up, every move in the order it was made ----
{
  const { b, calls } = phone();
  const c = new Control(b, undefined, { natural: () => true, seed: 7 });
  const owner = {};
  await c.handle('P', touch('down', 100, 700, 1), owner);
  // a curved drag up the screen, paced like a pointer (a point every few ms), with a pause in the middle
  const path: [number, number][] = [];
  for (let i = 1; i <= 24; i++) path.push([100 + Math.round(60 * Math.sin(i / 4)), 700 - i * 20]);
  let seq = 2;
  for (const [i, [x, y]] of path.entries()) {
    await c.handle('P', touch('move', x, y, seq++), owner);
    if (i === 11) await sleep(120); // the finger rests mid-drag: still one touch
  }
  await c.handle('P', touch('up', 40, 200, seq), owner);
  assert.equal(count(calls, 'down'), 1, 'one press');
  assert.equal(count(calls, 'up'), 1, 'one lift');
  assert.equal(calls[0], 'down 100,700');
  assert.equal(calls[calls.length - 1], 'up 40,200');
  const moves = calls.slice(1, -1);
  assert.ok(moves.every((m) => m.startsWith('move')), 'nothing but moves between the press and the lift');
  assert.deepEqual(moves, path.map(([x, y]) => `move ${x},${y}`), 'every move reached the phone, in order, exactly where it was made');
  assert.equal(c.touching('P'), false);
  ok(`live drag: one contact from down to up, ${moves.length} moves in order, untouched by natural touch`);
}

// ---- moves that arrive late or twice (the unordered channel) never go backwards ----
{
  const { b, calls } = phone();
  const c = new Control(b);
  await c.handle('P', touch('down', 10, 10, 1, 4));
  await c.handle('P', touch('move', 30, 30, 3, 4));
  const late = await c.handle('P', touch('move', 20, 20, 2, 4)); // seq 2 after seq 3: older than what's applied
  assert.equal(late?.coalesced, true);
  await c.handle('P', touch('move', 30, 30, 3, 4)); // the same one again
  await c.handle('P', touch('move', 40, 40, 4, 4));
  await c.handle('P', touch('up', 50, 50, 5, 4));
  assert.deepEqual(calls, ['down 10,10', 'move 30,30', 'move 40,40', 'up 50,50']);
  ok('order: a move older than one already applied (or said twice) is skipped, a lost one is filled by the next');
}

// ---- a long press: held still, the finger stays down while its sender's link is alive, then it drags ----
{
  const { b, calls } = phone();
  const c = new Control(b, undefined, { releaseMs: 120, holdRepeatMs: 60 });
  const told: unknown[] = [];
  const owner = { touchReleased: (i: unknown) => told.push(i) };
  await c.handle('P', touch('down', 200, 400, 1, 9), owner);
  // no touch event at all for five release times: only the link's own pings
  const beat = setInterval(() => c.alive(owner), 20);
  await sleep(600);
  assert.equal(c.touching('P'), true, 'held still for 5 release times: still down');
  assert.equal(count(calls, 'up'), 0, 'never lifted');
  assert.deepEqual(told, []);
  const repeats = calls.slice(1);
  assert.ok(repeats.length >= 5 && repeats.every((r) => r === 'move 200,400'), `the contact is said again where it is (${repeats.length} times)`);
  // ...and then it drags, the same touch
  await c.handle('P', touch('move', 200, 300, 2, 9), owner);
  await c.handle('P', touch('move', 200, 200, 3, 9), owner);
  await c.handle('P', touch('up', 200, 200, 4, 9), owner);
  clearInterval(beat);
  assert.equal(count(calls, 'down'), 1);
  assert.equal(count(calls, 'up'), 1);
  assert.deepEqual(calls.slice(-3), ['move 200,300', 'move 200,200', 'up 200,200']);
  assert.equal(c.meter.stats('P').touch.auto_released, 0);
  ok('long press: a still finger stays down while the link is alive (no keep-alive moves needed), then drags as the same touch');
}

// ---- the link died with the finger down: lifted, and its owner told; a frozen sender too ----
{
  const { b, calls } = phone();
  const c = new Control(b, undefined, { releaseMs: 100, holdRepeatMs: 0 });
  const told: any[] = [];
  const owner = { touchReleased: (i: unknown) => told.push(i) };
  await c.handle('P', touch('down', 10, 10, 1, 3), owner);
  const beat = setInterval(() => c.alive(owner), 20);
  await sleep(250);
  assert.equal(c.touching('P'), true);
  clearInterval(beat); // the link goes quiet
  await sleep(220);
  assert.equal(c.touching('P'), false, 'nothing from the sender for the release time: lifted');
  assert.deepEqual(calls, ['down 10,10', 'up 10,10']);
  assert.deepEqual(told, [{ id: 3, reason: 'timeout' }]);

  const p2 = phone();
  const c2 = new Control(p2.b, undefined, { releaseMs: 5000, quietMs: 150, holdRepeatMs: 0 });
  const o2 = {};
  await c2.handle('P', touch('down', 10, 10, 1, 5), o2);
  const beat2 = setInterval(() => c2.alive(o2), 20);
  await sleep(320);
  clearInterval(beat2);
  assert.deepEqual(p2.calls, ['down 10,10', 'up 10,10'], 'a sender that is alive but says nothing of its touch (a frozen page) is lifted after the quiet time');
  ok('no stuck fingers: lifted when the link dies (owner told), or when a live sender forgets its touch');
}

// ---- the sender closed mid-drag: the touch carries on over another link; with nobody, it's lifted ----
{
  const { b, calls } = phone();
  const c = new Control(b, undefined, { ownerGraceMs: 150, holdRepeatMs: 0 });
  const channel = {};
  const socket = {};
  await c.handle('P', touch('down', 10, 10, 1, 7), channel);
  await c.handle('P', touch('move', 20, 20, 2, 7), channel);
  c.release(channel); // the data channel is made anew mid-drag
  await sleep(60);
  assert.equal(c.touching('P'), true, 'kept for the grace time');
  await c.handle('P', touch('move', 30, 30, 3, 7), socket); // the same touch, over the socket now
  await sleep(200);
  assert.equal(c.touching('P'), true, 'carried on: no lift after the grace time');
  await c.handle('P', touch('up', 40, 40, 4, 7), socket);
  assert.deepEqual(calls, ['down 10,10', 'move 20,20', 'move 30,30', 'up 40,40']);

  calls.length = 0;
  await c.handle('P', touch('down', 10, 10, 5, 8), channel);
  c.release(channel);
  await sleep(260);
  assert.equal(c.touching('P'), false);
  assert.deepEqual(calls, ['down 10,10', 'up 10,10'], 'nobody carried it on: lifted after the grace time');
  ok('a closed sender: the same touch goes on over another link; lifted after the grace time otherwise');
}

// ---- natural touch: never on the owner's own input, always on Lotus's ----
{
  // live (HID): tested above (exact places). Buffered (no live channel): replayed exactly as made, on "up".
  const { b, calls, gestures } = phone(false);
  const c = new Control(b, undefined, { natural: () => true, seed: 11 });
  const mine: PathPoint[] = [[50, 600, 0], [60, 500, 40], [90, 380, 90], [140, 300, 400], [140, 300, 900]];
  await c.handle('P', touch('down', mine[0]![0], mine[0]![1], 1, 2, 0));
  for (let i = 1; i < mine.length; i++) await c.handle('P', touch('move', mine[i]![0], mine[i]![1], i + 1, 2, mine[i]![2]));
  await c.handle('P', touch('up', 140, 300, 9, 2, 950));
  assert.deepEqual(gestures[0], [...mine, [140, 300, 950]], "the owner's drag: every point and its time as he made it (the hold at its end too)");
  // the owner's whole swipe (points and timing in one command) keeps its shape as well
  gestures.length = 0;
  await c.handle('P', { type: 'swipe', points: [[100, 700, 0], [100, 400, 150], [100, 100, 300]], duration: 300, unit: 'pt' });
  const whole = gestures[0]!;
  assert.ok(whole.every(([x]) => x === 100), 'a straight line stays straight');
  assert.deepEqual([whole[0]![1], whole[whole.length - 1]![1], whole[whole.length - 1]![2]], [700, 100, 300]);

  // Lotus's own two-point swipe: a bowed flick (2026-11-17: at speed when lifted, 150-300 ms); its tap: a few points
  // off and held a natural moment
  gestures.length = 0;
  calls.length = 0;
  await c.handle('P', { type: 'swipe', x1: 200, y1: 700, x2: 200, y2: 200, unit: 'pt' });
  const tool = gestures[0]!;
  assert.ok(tool.length > 10, 'a made path, not two points');
  assert.ok(tool.some(([x]) => Math.abs(x - 200) > 1), 'bowed to one side');
  const firstStep = Math.abs(tool[1]![1] - tool[0]![1]);
  const lastStep = Math.abs(tool[tool.length - 1]![1] - tool[tool.length - 2]![1]);
  assert.ok(lastStep > firstStep * 3, 'a flick: slow off the mark, fastest at the lift');
  assert.ok(tool[tool.length - 1]![2] >= 150 && tool[tool.length - 1]![2] <= 300, 'quick');
  assert.deepEqual([tool[0]![0], tool[0]![1], tool[tool.length - 1]![0], tool[tool.length - 1]![1]], [200, 700, 200, 200], 'the ends are exact');
  await c.handle('P', { type: 'tap', x: 200, y: 400, unit: 'pt' });
  const m = /^tap ([\d.]+),([\d.]+) hold (\d+)$/.exec(calls[calls.length - 1]!)!;
  assert.ok(m, `a natural tap says its hold: ${calls[calls.length - 1]}`);
  assert.ok(Math.hypot(Number(m[1]) - 200, Number(m[2]) - 400) <= 4.3 && Number(m[3]) >= 50 && Number(m[3]) <= 120);
  ok("natural touch: the owner's live and buffered drags and whole swipes go as made; Lotus's swipe is a bowed flick, its tap offset and held");
}

// ---- a live press never waits for what only WDA needs: a health check, the idle probe, the breath between actions ----
{
  const { b, calls, at } = phone();
  const c = new Control(b, undefined, { minGapMs: 150, idleProbeMs: 0 });
  let probes = 0;
  c.onHeal = async () => {
    probes++;
    await sleep(300); // a slow WDA probe
    return true;
  };
  let checking = true;
  const check = c.check('P', async () => {
    await sleep(300); // a health check on WDA (a screenshot, the lock state)
    checking = false;
  });
  const t0 = performance.now();
  await c.handle('P', touch('down', 10, 10, 1));
  const downMs = performance.now() - t0;
  assert.ok(checking, 'the check is still running');
  assert.ok(downMs < 120, `the press went at once (${Math.round(downMs)} ms), beside the check and the probe`);
  assert.equal(probes, 1, 'the probe was started (beside the press)');
  await c.handle('P', touch('move', 20, 20, 2));
  await c.handle('P', touch('up', 20, 20, 3));
  const upAt = at[at.length - 1]!;
  // right after the lift: a second press isn't held back by the gap between two actions
  await c.handle('P', touch('down', 30, 30, 4, 2));
  assert.ok(at[at.length - 1]! - upAt < 100, 'a quick second press goes at once');
  await c.handle('P', touch('up', 30, 30, 5, 2));
  // what goes through WDA still waits for the check
  const t1 = performance.now();
  await c.handle('P', { type: 'tap', x: 5, y: 5, unit: 'pt', natural: false });
  assert.equal(checking, false, 'a tap (WDA) waited for the check');
  assert.ok(performance.now() - t1 >= 100);
  await check;
  assert.deepEqual(calls.map((x) => x.split(' ')[0]), ['down', 'move', 'up', 'down', 'up', 'tap']);
  // and a check is skipped while the phone is in use
  const busy = c.handle('P', { type: 'tap', x: 6, y: 6, unit: 'pt', natural: false });
  assert.equal(await c.check('P', async () => {}), false);
  await busy;
  ok(`a live press goes at once (${Math.round(downMs)} ms) beside a health check and the idle probe; WDA's actions still wait for the check`);
}

// ---- the server: a held finger stays down while the socket pings, and is lifted when the socket goes quiet ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(1, { live: true });
  const server = createServer(backend, token, undefined, { touch: { releaseMs: 300, holdRepeatMs: 0 } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const udid = (await (await fetch(`${base}/phones`, { headers: auth })).json())[0].udid as string;
  try {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/devices/${udid}/control?token=${token}`);
    const msgs: any[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on('open', r));
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    const log = backend.inputLog(udid);
    log.length = 0;
    send({ type: 'touch', phase: 'down', x: 0.5, y: 0.5, t: 0, seq: 1, id: 6 });
    const beat = setInterval(() => send({ type: 'ping', t: Date.now() }), 60); // the link's heartbeat, no touch events
    await sleep(1000);
    assert.ok(!msgs.some((m) => m.type === 'touch-released'), 'held over three release times: not lifted');
    assert.deepEqual(log, ['down 195,422']);
    send({ type: 'touch', phase: 'move', x: 0.5, y: 0.3, t: 1000, seq: 2, id: 6 });
    send({ type: 'touch', phase: 'up', x: 0.5, y: 0.3, t: 1020, seq: 3, id: 6 });
    for (let i = 0; i < 100 && msgs.filter((m) => m.ack !== undefined).length < 3; i++) await sleep(10);
    assert.deepEqual(log, ['down 195,422', 'move 195,253', 'up 195,253'], 'a long press, then a drag: one touch');
    // again, and this time the socket goes quiet (the page froze, the link stalled)
    log.length = 0;
    send({ type: 'touch', phase: 'down', x: 0.25, y: 0.25, seq: 4, id: 7 });
    await sleep(100);
    clearInterval(beat);
    for (let i = 0; i < 200 && !msgs.some((m) => m.type === 'touch-released'); i++) await sleep(10);
    const rel = msgs.find((m) => m.type === 'touch-released');
    assert.deepEqual([rel?.id, rel?.reason], [7, 'timeout']);
    assert.deepEqual(log, ['down 98,211', 'up 98,211']);
    ws.close();
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('server: a finger held still stays down while its socket pings, drags afterwards, and is lifted once the socket goes quiet');
}

console.log(`\nall ${passed} drag checks passed`);
