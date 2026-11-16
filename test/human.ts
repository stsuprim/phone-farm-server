// Natural touch (src/human.ts): curves and easing, tap offsets and holds, drags, the owner's paths replayed as they
// were, always on at the server (2026-11-16: no setting) and exact input with `natural: false`. Seeded: the same every run.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Control, swipePlan } from '../src/control.js';
import { curvePath, dragPath, ease, seeded, swipeMs, tapPlan, TAP_HOLD_MAX, TAP_HOLD_MIN, TAP_OFFSET_MAX } from '../src/human.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import { SettingsStore } from '../src/settings.js';
import type { Backend, PathPoint } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};

/** A phone that records what reached it. */
function phone(live = false) {
  const taps: { x: number; y: number; hold?: number }[] = [];
  const gestures: PathPoint[][] = [];
  const b = {
    mock: true,
    screen: () => ({ width: 400, height: 800, scale: 3 }),
    tap: async (_u: string, x: number, y: number, hold?: number) => {
      taps.push({ x, y, hold });
      return { via: 'wda-fast' as const };
    },
    gesture: async (_u: string, pts: PathPoint[]) => {
      gestures.push(pts);
      return { via: 'wda-fast' as const };
    },
    liveTouchReady: () => live,
  } as unknown as Backend;
  return { b, taps, gestures };
}
const quick = { minGapMs: 0, idleProbeMs: Infinity };

// ---- easing and the seeded generator ----
{
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.equal(ease(0.5), 0.5);
  let prev = -1;
  for (let i = 0; i <= 1000; i++) {
    const v = ease(i / 1000);
    assert.ok(v >= prev, 'easing never goes back');
    prev = v;
  }
  assert.ok(ease(0.1) < 0.1 && ease(0.9) > 0.9, 'slow off the mark and slow into the end');
  const a = seeded(42);
  const b = seeded(42);
  const xs = Array.from({ length: 20 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 20 }, () => b()), 'the same seed, the same draws');
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs, Array.from({ length: 20 }, seeded(43)));
  ok('ease: exact ends, monotone, slow at both ends; seeded draws repeat');
}

// ---- the swipe's curve ----
{
  const rng = seeded(7);
  for (let n = 0; n < 50; n++) {
    const a: [number, number] = [20 + rng() * 360, 20 + rng() * 760];
    const b: [number, number] = [20 + rng() * 360, 20 + rng() * 760];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ms = swipeMs(len, rng);
    const pts = curvePath(a, b, ms, rng);
    assert.deepEqual(pts[0], [a[0], a[1], 0], 'starts exactly where asked');
    assert.deepEqual(pts[pts.length - 1], [b[0], b[1], ms], 'ends exactly where asked, at its time');
    // progress along the way (projected on a->b) never goes back; time always goes forward
    let prevP = -Infinity;
    let prevT = -1;
    let most = 0;
    for (const [x, y, t] of pts) {
      assert.ok(t > prevT, 'time moves on');
      prevT = t;
      const p = len > 0 ? ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / len : 0;
      assert.ok(p >= prevP - 0.25, `progress is monotone (${p} after ${prevP})`);
      prevP = Math.max(prevP, p);
      // how far it strays from the straight line: a slight bow, never a loop
      const off = len > 0 ? Math.abs((x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])) / len : 0;
      most = Math.max(most, off);
    }
    assert.ok(most <= Math.min(24, len * 0.08) + 0.2, `a slight bow (${most.toFixed(1)} pt off a ${len.toFixed(0)} pt line)`);
    if (len > 100) assert.ok(most > 0.5, 'not a straight line');
    // eased: the first and last tenth of the time cover far less than a tenth of the way each
    const at = (f: number) => pts.reduce((best, q) => (Math.abs(q[2] - f * ms) < Math.abs(best[2] - f * ms) ? q : best));
    if (len > 100) {
      const d = (q: PathPoint) => Math.hypot(q[0] - a[0], q[1] - a[1]);
      assert.ok(d(at(0.1)) < len * 0.06, 'eases in');
      assert.ok(len - Math.hypot(b[0] - at(0.9)[0], b[1] - at(0.9)[1]) > len * 0.94, 'eases out');
    }
  }
  // the time fits the length
  assert.ok(swipeMs(40) < swipeMs(300) && swipeMs(300) < swipeMs(800));
  assert.ok(swipeMs(300) > 250 && swipeMs(300) < 400, `${swipeMs(300)} ms for 300 pt`);
  assert.ok(swipeMs(0) >= 120 && swipeMs(1e6) <= 1200, 'within a finger\'s range');
  // clamped to the screen on the way, the ends kept
  const c = curvePath([0, 10], [0, 600], 300, seeded(1), { clamp: (x, y) => [Math.max(0, x), y] });
  assert.ok(c.every(([x]) => x >= 0));
  ok('curvePath: exact ends, monotone progress, a slight bow, eased; swipeMs fits the length');
}

// ---- the tap's offset and hold ----
{
  const rng = seeded(99);
  const box: [number, number, number, number] = [100, 200, 40, 20];
  for (let n = 0; n < 2000; n++) {
    const free = tapPlan(200, 400, rng);
    assert.ok(Math.abs(free.x - 200) <= TAP_OFFSET_MAX + 0.05 && Math.abs(free.y - 400) <= TAP_OFFSET_MAX + 0.05, 'a few points off at most');
    assert.ok(free.hold >= TAP_HOLD_MIN && free.hold <= TAP_HOLD_MAX, 'held 50-120 ms');
    const inBox = tapPlan(120, 210, rng, box);
    assert.ok(inBox.x >= 100 && inBox.x <= 140 && inBox.y >= 200 && inBox.y <= 220, 'inside its element');
    const tiny = tapPlan(101, 201, rng, [100, 200, 3, 3]);
    assert.ok(tiny.x >= 100 && tiny.x <= 103 && tiny.y >= 200 && tiny.y <= 203, 'inside even a tiny element');
    const edge = tapPlan(0, 0, rng, null, { width: 400, height: 800 });
    assert.ok(edge.x >= 0 && edge.y >= 0, 'never off the screen');
  }
  const holds = new Set(Array.from({ length: 50 }, () => tapPlan(10, 10, rng).hold));
  assert.ok(holds.size > 10, 'the hold varies');
  ok('tapPlan: a few points off, inside the element and the screen, held 50-120 ms');
}

// ---- drags ----
{
  const exact = dragPath([10, 10], [210, 10], 600, 800, null);
  assert.deepEqual(exact[0], [10, 10, 0]);
  assert.deepEqual(exact[1], [10, 10, 600], 'pressed first');
  assert.deepEqual(exact[exact.length - 1], [210, 10, 1550], 'rested 150 ms before the lift');
  assert.ok(exact.every(([, y]) => y === 10), 'exact: a straight line');
  const nat = dragPath([10, 10], [210, 10], 600, 800, seeded(3));
  assert.deepEqual(nat[0], [10, 10, 0]);
  assert.equal(nat[1]![0], 10);
  assert.ok(nat[1]![2] >= 550 && nat[1]![2] <= 650, 'held about as long as asked');
  const last = nat[nat.length - 1]!;
  const before = nat[nat.length - 2]!;
  assert.deepEqual([last[0], last[1]], [210, 10]);
  assert.deepEqual([before[0], before[1]], [210, 10], 'rests at the end');
  assert.ok(last[2] - before[2] >= 120, 'a rest before the lift');
  ok('dragPath: pressed, moved, rested; straight when exact');
}

// ---- Control: natural on (commands), exact with the setting off or natural: false ----
{
  let on = true;
  const { b, taps, gestures } = phone();
  const c = new Control(b, undefined, { ...quick, natural: () => on, seed: 5 });
  await c.handle('p', { type: 'tap', x: 200, y: 400, unit: 'pt' });
  assert.ok(Math.abs(taps[0]!.x - 200) <= 3 && Math.abs(taps[0]!.y - 400) <= 3);
  assert.ok(taps[0]!.hold! >= 50 && taps[0]!.hold! <= 120, 'a natural tap is held 50-120 ms');
  await c.handle('p', { type: 'tap', x: 0.5, y: 0.25, unit: 'norm', bounds: [0.45, 0.24, 0.1, 0.02] });
  assert.ok(taps[1]!.x >= 180 && taps[1]!.x <= 220 && taps[1]!.y >= 192 && taps[1]!.y <= 208, 'inside the element it aimed at');
  await c.handle('p', { type: 'swipe', x1: 200, y1: 700, x2: 200, y2: 200, unit: 'pt' });
  const sw = gestures[0]!;
  assert.ok(sw.length > 20, 'a sampled curve');
  assert.deepEqual(sw[0], [200, 700, 0]);
  assert.deepEqual([sw[sw.length - 1]![0], sw[sw.length - 1]![1]], [200, 200]);
  const len = sw[sw.length - 1]![2];
  assert.ok(len >= 300 && len <= 480, `a time that fits 500 pt (${len} ms)`);
  assert.ok(sw.some(([x]) => Math.abs(x - 200) > 1), 'bowed, not straight');
  await c.handle('p', { type: 'swipe', x1: 200, y1: 700, x2: 200, y2: 200, ms: 500, unit: 'pt' });
  const given = gestures[1]![gestures[1]!.length - 1]![2];
  assert.ok(given >= 460 && given <= 540, 'a given time is kept, give or take a little');
  await c.handle('p', { type: 'swipe', x1: 50, y1: 400, x2: 350, y2: 400, ms: 600, hold: 500, unit: 'pt' });
  const drag = gestures[2]!;
  assert.deepEqual([drag[1]![0], drag[1]![1]], [50, 400], 'a drag is pressed in place first');

  // natural: false, and the setting off: exact and straight
  await c.handle('p', { type: 'tap', x: 200, y: 400, unit: 'pt', natural: false });
  assert.deepEqual(taps[2], { x: 200, y: 400, hold: undefined });
  await c.handle('p', { type: 'tap', x: 200, y: 400, unit: 'pt', natural: false, hold: 90 });
  assert.deepEqual(taps[3], { x: 200, y: 400, hold: 90 }, 'the owner\'s own hold is kept');
  on = false;
  await c.handle('p', { type: 'tap', x: 200, y: 400, unit: 'pt' });
  assert.deepEqual(taps[4], { x: 200, y: 400, hold: undefined }, 'off: exactly there, the route\'s own hold');
  await c.handle('p', { type: 'swipe', x1: 200, y1: 700, x2: 200, y2: 200, unit: 'pt' });
  assert.deepEqual(gestures[3], [[200, 700, 0], [200, 200, 300]], 'off: one straight line, as before');
  await c.handle('p', { type: 'hold', x: 200, y: 400, ms: 800, unit: 'pt' });
  assert.deepEqual(gestures[4], [[200, 400, 0], [200, 400, 800]]);
  await c.handle('p', { type: 'swipe', x1: 50, y1: 400, x2: 350, y2: 400, ms: 600, hold: 500, unit: 'pt' });
  assert.ok(gestures[5]!.every(([, y]) => y === 400), 'off: a drag goes straight');
  assert.equal(gestures[5]![gestures[5]!.length - 1]![2], 1250);

  // seeded: a second Control with the same seed makes the very same touches
  const two = phone();
  const c2 = new Control(two.b, undefined, { ...quick, natural: () => true, seed: 5 });
  await c2.handle('p', { type: 'tap', x: 200, y: 400, unit: 'pt' });
  assert.deepEqual(two.taps[0], taps[0], 'deterministic for a seed');
  ok('Control: natural taps, swipes and drags; natural: false and the setting off are exact');
}

// ---- the owner's own paths: replayed with every point and its timing ----
{
  const { b, taps, gestures } = phone(false); // no live channel: the touch is buffered and played on "up"
  const c = new Control(b, undefined, { ...quick, natural: () => true, seed: 1 });
  const path: PathPoint[] = [[100, 600, 0], [104, 590, 16], [112, 560, 33], [130, 500, 49], [160, 420, 70], [175, 380, 95], [180, 370, 140]];
  for (const [i, [x, y, t]] of path.entries()) {
    const phase = i === 0 ? 'down' : i === path.length - 1 ? 'up' : 'move';
    await c.handle('p', { type: 'touch', phase, x, y, t, seq: i + 1, id: 9, unit: 'pt' });
  }
  assert.deepEqual(gestures[0], path, 'every point, at its own time, nothing curved or eased');
  // a whole swipe in one command (the far link): its points and timing kept, only filled in between
  const plan = swipePlan(path, undefined);
  for (const [x, y, t] of path) {
    const q = plan.find((p) => p[2] === t);
    if (q) assert.deepEqual(q, [x, y, t], 'its own points stay where and when they were');
  }
  assert.deepEqual(plan[plan.length - 1], path[path.length - 1]);
  await c.handle('p', { type: 'swipe', points: path, unit: 'pt' });
  assert.deepEqual(gestures[1], swipePlan(path, undefined), 'a whole swipe is never curved by natural touch');
  // the owner's quick tap keeps its real hold
  await c.handle('p', { type: 'touch', phase: 'down', x: 50, y: 50, t: 0, seq: 20, id: 10, unit: 'pt' });
  await c.handle('p', { type: 'touch', phase: 'up', x: 50, y: 50, t: 85, seq: 21, id: 10, unit: 'pt' });
  assert.deepEqual(taps[0], { x: 50, y: 50, hold: 85 }, 'exactly where it landed, held as long as it was');
  ok('the owner\'s path: every point and its timing replayed; a whole swipe kept; a tap\'s real hold');
}

// ---- always on (2026-11-16): no setting; the server's input is natural whatever a client puts ----
{
  const s = new SettingsStore();
  assert.equal('naturalTouch' in s.get(), false, 'not a setting any more');
  assert.deepEqual(s.put({ naturalTouch: false }), { idleLockMinutes: 10 }, 'an older client\'s PUT of it is left out, not refused');
  assert.deepEqual(SettingsStore.validate({ naturalTouch: false, idleLockMinutes: 5 }, true), { idleLockMinutes: 5 }, 'one kept in the file is skipped');

  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(1);
  const server = createServer(backend, token, undefined, { touchSeed: 11 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const got = (await (await fetch(`${base}/api/settings`, { headers })).json()) as Record<string, unknown>;
    assert.equal(got.naturalTouch, true);
    const udid = ((await (await fetch(`${base}/phones`, { headers })).json()) as any[])[0].udid as string;
    const p = (backend as any).live(udid);
    await fetch(`${base}/phones/${udid}/tap`, { method: 'POST', headers, body: JSON.stringify({ x: 100, y: 100, unit: 'pt', fast: true }) });
    assert.match(p.log[p.log.length - 1], /^tap \d+,\d+ hold \d+$/, 'held a natural moment');
    // an older Lotus's switch: taken without a word, and nothing changes
    const put = (await (await fetch(`${base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ naturalTouch: false }) })).json()) as Record<string, unknown>;
    assert.equal(put.naturalTouch, true, 'it only says the server has it');
    await fetch(`${base}/phones/${udid}/tap`, { method: 'POST', headers, body: JSON.stringify({ x: 100, y: 100, unit: 'pt', fast: true }) });
    assert.match(p.log[p.log.length - 1], /^tap \d+,\d+ hold \d+$/, 'still natural');
    // the owner's own whole tap says natural: false: exact
    await fetch(`${base}/phones/${udid}/tap`, { method: 'POST', headers, body: JSON.stringify({ x: 100, y: 100, unit: 'pt', fast: true, natural: false }) });
    assert.equal(p.log[p.log.length - 1], 'tap 100,100', 'natural: false on a message stays exact');
    const bad = await fetch(`${base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ nope: 1 }) });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
    await backend.close();
  }
  ok('always on: no setting to turn it off, an older client\'s PUT changes nothing, natural: false stays exact');
}

console.log(`\nall ${passed} natural touch checks passed`);
process.exit(0);
