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
    assert.ok(p.length >= ms / 10, `${name}: a move every 8 ms or so, never one jump (${p.length} points)`);
    // speed at the lift: the last 30 ms cover more ground than the first 30
    const near = (t: number) => p.reduce((best, q) => (Math.abs(q[2] - t) < Math.abs(best[2] - t) ? q : best));
    const d = (a: PathPoint, z: PathPoint) => Math.hypot(z[0] - a[0], z[1] - a[1]);
    assert.ok(d(near(ms - 30), p.at(-1)!) > d(p[0]!, near(30)) * 2, `${name}: fastest when it's lifted`);
  }
  assert.deepEqual(path!.points, [[200, 640, 0], [200, 640, 400], [200, 400, 900], [200, 400, 1200]], 'phones_path: every point as sent');
  ok(`phones_swipe is a whole path (${natural ? 'natural' : 'exact'}): pressed, a move every 8 ms, at speed when lifted; the same body as phones_path`);
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
