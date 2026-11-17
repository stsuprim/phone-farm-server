// 2026-11-17: one way for every gesture. The owner's gestures on Lotus's Phones page go through the very routes Lotus's
// tools use (phones_tap: POST /phones/:udid/tap; phones_path: POST /phones/:udid/path, or the same message over the
// control socket), and Lotus's quick swipe (phones_swipe without a hold) is now the same kind of whole path as
// phones_path's: pressed, a move every 8 ms, lifted at speed. On our build each goes as ONE /lotus/gesture body
// `{ points: [[x, y, ms], …], orientation: 1 }` (gestureBody), the body phones_path proved on both phones.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Control } from '../src/control.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import type { Backend, PathPoint } from '../src/types.js';
import { gestureBody } from '../src/wda.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};

/** A 400 x 800 pt phone that records the gestures and taps reaching it. */
function phone() {
  const gestures: PathPoint[][] = [];
  const taps: { x: number; y: number; hold?: number }[] = [];
  const b = {
    mock: true,
    screen: () => ({ width: 400, height: 800, scale: 3 }),
    orientation: () => 'portrait',
    tap: async (_u: string, x: number, y: number, hold?: number) => (taps.push({ x, y, hold }), { via: 'wda-fast' as const }),
    gesture: async (_u: string, pts: PathPoint[]) => (gestures.push(pts.map((p) => [...p] as PathPoint)), { via: 'wda-fast' as const }),
  } as unknown as Backend;
  return { b, gestures, taps };
}

/** What the phone gets on our build: one record, its points in order from 0, a press and a lift around them. */
function wholeBody(pts: PathPoint[]) {
  const body = gestureBody(pts);
  assert.deepEqual(Object.keys(body).sort(), ['orientation', 'points'], 'the last-good body: points and orientation only');
  assert.equal(body.orientation, 1);
  assert.equal(body.points[0]![2], 0, 'it starts at 0');
  for (let i = 1; i < body.points.length; i++) assert.ok(body.points[i]![2] >= body.points[i - 1]![2], 'time never goes back');
  return body;
}

// ---- phones_swipe: a whole path like phones_path's ----
for (const natural of [true, false]) {
  const { b, gestures } = phone();
  const c = new Control(b, undefined, { natural: () => natural, seed: 3 });
  // Lotus's tool (0..1 in the picture, no time: the server's), and the page's wheel (300 ms, exact)
  await c.handle('P', { type: 'swipe', x1: 0.85, y1: 0.5, x2: 0.15, y2: 0.5, unit: 'norm' });
  await c.handle('P', { type: 'swipe', x1: 0.5, y1: 0.7, x2: 0.5, y2: 0.3, ms: 300, unit: 'norm', natural: false });
  // and phones_path's proven slow drag with a pause
  await c.handle('P', { type: 'path', points: [[0.5, 0.8, 0], [0.5, 0.8, 400], [0.5, 0.5, 900], [0.5, 0.5, 1200]], unit: 'norm' });
  assert.equal(gestures.length, 3, 'each one gesture on the phone');
  const [swipe, wheel, path] = gestures.map(wholeBody);
  for (const [name, g, from, to] of [['swipe', swipe!, [340, 400], [60, 400]], ['wheel', wheel!, [200, 560], [200, 240]]] as const) {
    const p = g.points;
    assert.deepEqual([p[0]![0], p[0]![1]], from, `${name}: pressed where asked`);
    assert.deepEqual([p.at(-1)![0], p.at(-1)![1]], to, `${name}: ends where asked`);
    const ms = p.at(-1)![2];
    assert.ok(ms >= 150 && ms <= 300 * 1.08 + 1, `${name}: a flick's time (${ms} ms)`);
    assert.ok(p.length >= ms / 17, `${name}: a move every 16 ms or so, never one jump (${p.length} points)`);
    // speed at the lift: the last 30 ms cover more ground than the first 30
    const near = (t: number) => p.reduce((best, q) => (Math.abs(q[2] - t) < Math.abs(best[2] - t) ? q : best));
    const d = (a: PathPoint, z: PathPoint) => Math.hypot(z[0] - a[0], z[1] - a[1]);
    assert.ok(d(near(ms - 30), p.at(-1)!) > d(p[0]!, near(30)) * 2, `${name}: fastest when it's lifted`);
  }
  assert.deepEqual(path!.points, [[200, 640, 0], [200, 640, 400], [200, 400, 900], [200, 400, 1200]], 'phones_path: every point as sent');
  ok(`phones_swipe is a whole path (${natural ? 'natural' : 'exact'}): pressed, a move every 16 ms, at speed when lifted; the same body as phones_path`);
}

// ---- 2026-11-17, later: Lotus's swipes step every 16 ms (phones_path's spacing); the owner's wheel keeps its 8 ms ----
{
  const { b, gestures } = phone();
  const c = new Control(b, undefined, { natural: () => true, seed: 5 });
  await c.handle('P', { type: 'swipe', x1: 0.8, y1: 0.5, x2: 0.2, y2: 0.5, ms: 800, unit: 'norm' });
  await c.handle('P', { type: 'swipe', x1: 0.2, y1: 0.5, x2: 0.8, y2: 0.5, ms: 800, hold: 600, unit: 'norm' });
  await c.handle('P', { type: 'swipe', x1: 0.5, y1: 0.7, x2: 0.5, y2: 0.3, ms: 300, unit: 'norm', natural: false, owner: true });
  const [swipe, drag, wheel] = gestures.map((g) => wholeBody(g).points);
  const gaps = (p: PathPoint[]) => p.slice(1).map((q, i) => q[2] - p[i]![2]);
  assert.ok(Math.max(...gaps(swipe!)) <= 17 && Math.min(...gaps(swipe!)) >= 15, `Lotus's swipe: a move every 16 ms (${gaps(swipe!).join(',')})`);
  const moving = drag!.slice(2, -1); // after the press and its hold, before the rest
  assert.ok(Math.max(...gaps(moving)) <= 17, "Lotus's drag: its move every 16 ms");
  assert.deepEqual([drag![1]![0], drag![1]![1]], [drag![0]![0], drag![0]![1]], "the drag's hold stays where it pressed");
  assert.ok(Math.max(...gaps(wheel!)) <= 9, "the owner's wheel: its 8 ms as before");
  ok("Lotus's swipes and drags step every 16 ms like phones_path; the owner's wheel keeps 8 ms");
}

// ---- 2026-11-17, later: what Lotus now sends for phones_swipe and phones_run's swipe step: phones_path's own body ----
// (built on the Rust side, source/modules/phones/src/lib.rs `swipe_plan`; mirrored here so a change on either side
// that breaks the shape shows)
function lotusSwipe(from: [number, number], to: [number, number], ms: number, hold = 0): [number, number, number][] {
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  if (hold > 0) {
    const steps = Math.min(120, Math.max(8, Math.round(ms / 16)));
    const out: [number, number, number][] = [[from[0], from[1], 0], [from[0], from[1], hold]];
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      out.push([r(from[0] + (to[0] - from[0]) * k), r(from[1] + (to[1] - from[1]) * k), Math.round(hold + ms * k)]); // Rust rounds every fraction to 5 places (tidy_gesture)
    }
    out.push([to[0], to[1], hold + ms + 150]);
    return out;
  }
  const n = Math.max(2, Math.ceil(ms / 16));
  const out: [number, number, number][] = [[from[0], from[1], 0]];
  for (let i = 1; i < n; i++) {
    const u = i / n;
    const s = 0.35 * u + 0.65 * u * u;
    out.push([r(from[0] + (to[0] - from[0]) * s), r(from[1] + (to[1] - from[1]) * s), Math.round(ms * u)]);
  }
  out.push([to[0], to[1], ms]);
  return out;
}
{
  const { b, gestures } = phone();
  const c = new Control(b, undefined, { natural: () => true, seed: 11 });
  const ways: [string, [number, number], [number, number]][] = [
    ['left', [0.8, 0.5], [0.2, 0.5]], ['right', [0.2, 0.5], [0.8, 0.5]], ['up', [0.5, 0.75], [0.5, 0.25]], ['down', [0.5, 0.25], [0.5, 0.75]],
  ];
  const sent: [number, number, number][][] = [];
  for (const [, from, to] of ways) {
    for (const ms of [300, 800]) sent.push(lotusSwipe(from, to, ms));
    sent.push(lotusSwipe(from, to, 800, 600));
  }
  for (const pts of sent) await c.handle('P', { type: 'path', points: pts, unit: 'norm' });
  assert.equal(gestures.length, sent.length, 'each one gesture on the phone');
  for (const [i, g] of gestures.entries()) {
    const body = wholeBody(g);
    assert.equal(body.points.length, sent[i]!.length, 'every point sent is played');
    body.points.forEach((q, k) => {
      const [x, y, t] = sent[i]![k]!;
      assert.ok(Math.abs(q[0] - Math.min(399, x * 400)) < 1e-6 && Math.abs(q[1] - Math.min(799, y * 800)) < 1e-6 && q[2] === t, 'played as sent, never reshaped');
    });
    const p = body.points;
    assert.ok(Math.hypot(p.at(-1)![0] - p[0]![0], p.at(-1)![1] - p[0]![1]) >= 0.5 * 400 - 1, 'it really moves');
  }
  // a quick one is fastest at the lift; a held one presses still first and rests before the lift
  const q = gestures[0]!;
  const d = (a: PathPoint, z: PathPoint) => Math.hypot(z[0] - a[0], z[1] - a[1]);
  assert.ok(d(q.at(-2)!, q.at(-1)!) > 2 * d(q[0]!, q[1]!), 'a quick swipe: at speed when lifted');
  const h = gestures[2]!;
  assert.deepEqual([h[1]![0], h[1]![1], h[1]![2]], [h[0]![0], h[0]![1], 600]);
  assert.deepEqual([h.at(-1)![0], h.at(-1)![1]], [h.at(-2)![0], h.at(-2)![1]]);
  ok("phones_swipe's new body (left, right, up, down at 300 and 800 ms, and with hold_ms) is phones_path's, played as sent");
}

// ---- a swipe never answers ok without reaching the phone, and the reported action waits for it to play ----
{
  const backend = new MockBackend(1, { playMs: 400 });
  const token = 'h'.repeat(32);
  const server = createServer(backend, token, undefined, { watchMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (p: string, body: unknown) =>
    fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const udid = ((await (await fetch(`${base}/phones`, { headers: { authorization: `Bearer ${token}` } })).json()) as { udid: string }[])[0]!.udid;
    const played: number[] = [];
    const real = backend.gesture.bind(backend);
    backend.gesture = async (u: string, pts: PathPoint[]) => (played.push(pts.length), real(u, pts));
    // phones_swipe as Lotus now sends it: POST /path with phones_path's body (the reported route, not `fast`)
    const t0 = performance.now();
    const pts = lotusSwipe([0.8, 0.5], [0.2, 0.5], 300);
    const r = await call(`/phones/${udid}/path`, { points: pts, unit: 'norm' });
    const took = performance.now() - t0;
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(((await r.json()) as { ok: boolean }).ok, true);
    assert.deepEqual(played, [pts.length], 'the whole gesture reached the phone');
    assert.ok(took >= 400, `the answer came once it had played (${Math.round(took)} ms)`);
    // phones_run's swipe step, as Lotus now sends it: a path step
    const b = await call(`/phones/${udid}/act`, { steps: [{ type: 'path', points: lotusSwipe([0.5, 0.75], [0.5, 0.25], 300), unit: 'norm' }] });
    const bj = (await b.json()) as { ok: boolean; steps: { ok: boolean; type: string }[] };
    assert.equal(bj.ok, true, JSON.stringify(bj));
    assert.equal(bj.steps[0]!.type, 'path');
    assert.equal(played.length, 2, "the batch's swipe step reached the phone");
    // what can't be a swipe is refused, never an ok
    for (const [what, bad] of [
      ['swipe', { x1: 0.5, y1: 0.5, unit: 'norm' }],
      ['swipe', { x1: 'a', y1: 0.5, x2: 0.5, y2: 0.2, unit: 'norm' }],
      ['path', { points: [], unit: 'norm' }],
    ] as const) {
      const e = await call(`/phones/${udid}/${what}`, bad);
      assert.equal(e.status, 400, `${what} ${JSON.stringify(bad)}`);
      assert.equal(((await e.json()) as { ok: boolean }).ok, false);
    }
    assert.equal(played.length, 2, 'nothing refused reached the phone');
    ok('http: a swipe as a path reaches the phone and answers once it played; a bad one is a 400 with ok: false, never a silent ok');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await backend.close();
  }
}

// ---- the page's gestures: phones_tap's and phones_path's routes, nothing else ----
{
  const { b, gestures, taps } = phone();
  const c = new Control(b, undefined, { natural: () => true, seed: 9 });
  // a tap (the owner's hold kept, never reshaped)
  await c.handle('P', { type: 'tap', x: 0.25, y: 0.5, unit: 'norm', natural: false, hold: 90 });
  assert.deepEqual(taps, [{ x: 100, y: 400, hold: 90 }]);
  // a long press: phones_path with one point held
  await c.handle('P', { type: 'path', points: [[0.25, 0.5, 0], [0.25, 0.5, 900]], unit: 'norm' });
  assert.deepEqual(wholeBody(gestures[0]!).points, [[100, 400, 0], [100, 400, 900]]);
  // a flick, a long press then a drag, an edge swipe: as thinned by the page, played as they are
  const flick: [number, number, number][] = [[0.9, 0.5, 0], [0.8, 0.5, 16], [0.62, 0.5, 48], [0.35, 0.5, 96], [0.1, 0.5, 130]];
  const holdDrag: [number, number, number][] = [[0.3, 0.3, 0], [0.3, 0.3, 700], [0.5, 0.3, 900], [0.7, 0.3, 1100]];
  const edge: [number, number, number][] = [[0.5, 1, 0], [0.5, 0.9, 40], [0.5, 0.6, 120], [0.5, 0.3, 200]];
  for (const pts of [flick, holdDrag, edge]) await c.handle('P', { type: 'path', points: pts, unit: 'norm' });
  const sent = gestures.slice(1).map((g) => wholeBody(g).points);
  assert.deepEqual(sent[0], flick.map(([x, y, t]) => [x * 400, y * 800, t]));
  assert.deepEqual(sent[1], holdDrag.map(([x, y, t]) => [x * 400, y * 800, t]));
  assert.deepEqual(sent[2]![0], [200, 799, 0], 'the edge, clamped onto the screen');
  ok("the page's gestures: a tap through phones_tap's route (its hold kept), a long press and every moving gesture through phones_path's (as sent)");
}

// ---- over HTTP, the routes Lotus's tools call ----
{
  const backend = new MockBackend(1);
  const token = 'g'.repeat(32);
  const server = createServer(backend, token, undefined, { watchMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (p: string, body: unknown) =>
    fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const udid = ((await (await fetch(`${base}/phones`, { headers: { authorization: `Bearer ${token}` } })).json()) as { udid: string }[])[0]!.udid;
    for (const [what, body] of [
      ['tap', { x: 0.5, y: 0.5, unit: 'norm', natural: false, hold: 80 }],
      ['path', { points: [[0.5, 0.5, 0], [0.5, 0.5, 700]], unit: 'norm' }],
      ['path', { points: [[0.8, 0.5, 0], [0.5, 0.5, 60], [0.2, 0.5, 120]], unit: 'norm' }],
      ['swipe', { x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, unit: 'norm' }],
    ] as const) {
      const r = await call(`/phones/${udid}/${what}`, { ...body, fast: true });
      assert.equal(r.status, 200, `${what}: ${await r.clone().text()}`);
      assert.equal(((await r.json()) as { ok: boolean }).ok, true);
    }
    ok('http: POST /phones/:udid/tap, /path (held and moving) and /swipe take what the page and the tools send');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await backend.close();
  }
}

console.log(`\nall ${passed} gesture checks passed`);
