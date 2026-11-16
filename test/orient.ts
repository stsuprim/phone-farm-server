// Rotation: the orientation names, the touch mapping in all four orientations (upright normalized/pixels/points ->
// WDA points and the HID panel), the capture's shape against the phone's, picture sizes, and the server telling every
// view (list, hellos, an update on change, screenshots) how the phone is turned.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { Control } from '../src/control.js';
import { toHid } from '../src/hid.js';
import { imageSize } from '../src/imgsize.js';
import { MockBackend } from '../src/mock.js';
import {
  frameAgrees, guessUnit, isLandscape, Orientation, ORIENTATIONS, orientationFromWda, panelToUpright, parseUnit, pointsToHid, toPoints,
  uiOrientation, uprightSize, uprightToPanel,
} from '../src/orient.js';
import { encodePng } from '../src/png.js';
import { captureFix } from '../src/real.js';
import { createServer } from '../src/server.js';
import type { Backend, PathPoint } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (a: number[], b: number[], eps = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= eps);

// ---- names ----
{
  assert.equal(orientationFromWda('PORTRAIT'), 'portrait');
  assert.equal(orientationFromWda('LANDSCAPE'), 'landscape-left');
  assert.equal(orientationFromWda('UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT'), 'landscape-right');
  assert.equal(orientationFromWda('UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN'), 'portrait-upside-down');
  assert.equal(orientationFromWda('landscape'), 'landscape-left');
  assert.equal(orientationFromWda('UNKNOWN'), null);
  assert.equal(orientationFromWda(undefined), null);
  assert.deepEqual(ORIENTATIONS.map(uiOrientation), [1, 3, 4, 2]);
  assert.deepEqual(ORIENTATIONS.map(isLandscape), [false, true, true, false]);
  assert.deepEqual(uprightSize({ width: 390, height: 844 }, 'portrait'), { width: 390, height: 844 });
  assert.deepEqual(uprightSize({ width: 390, height: 844 }, 'landscape-left'), { width: 844, height: 390 });
  assert.deepEqual(uprightSize({ width: 844, height: 390 }, 'portrait-upside-down'), { width: 390, height: 844 }, 'any size of the screen will do');
  assert.deepEqual(uprightSize({ width: 844, height: 390 }, null), { width: 390, height: 844 });
  ok('orientation: WDA names, UIInterfaceOrientation numbers, upright sizes');
}

// ---- the mapping, all four orientations: where each corner of the upright picture is on the panel ----
{
  // [u, v] of the upright picture -> [px, py] of the glass as held in portrait
  const corners: Record<Orientation, [number[], number[]][]> = {
    // upright: nothing turns
    portrait: [[[0, 0], [0, 0]], [[1, 0], [1, 0]], [[0, 1], [0, 1]], [[1, 1], [1, 1]], [[0.25, 0.75], [0.25, 0.75]]],
    // turned 90° counter-clockwise (its top edge points left): the picture's top left is the panel's top right
    'landscape-left': [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[0, 1], [0, 0]], [[1, 1], [0, 1]], [[0.25, 0.75], [0.25, 0.25]]],
    // turned 90° clockwise (its top edge points right): the picture's top left is the panel's bottom left
    'landscape-right': [[[0, 0], [0, 1]], [[1, 0], [0, 0]], [[0, 1], [1, 1]], [[1, 1], [1, 0]], [[0.25, 0.75], [0.75, 0.75]]],
    // upside down: both axes flip
    'portrait-upside-down': [[[0, 0], [1, 1]], [[1, 0], [0, 1]], [[0, 1], [1, 0]], [[1, 1], [0, 0]], [[0.25, 0.75], [0.75, 0.25]]],
  };
  for (const o of ORIENTATIONS) {
    for (const [up, panel] of corners[o]) {
      assert.ok(near(uprightToPanel(up[0]!, up[1]!, o), panel), `${o}: upright ${up} -> panel ${panel}, got ${uprightToPanel(up[0]!, up[1]!, o)}`);
      assert.ok(near(panelToUpright(panel[0]!, panel[1]!, o), up), `${o}: panel ${panel} -> upright ${up}`);
    }
    // there and back, anywhere
    for (const [u, v] of [[0.1, 0.9], [0.5, 0.5], [0.83, 0.02]]) {
      const [px, py] = uprightToPanel(u!, v!, o);
      assert.ok(near(panelToUpright(px, py, o), [u!, v!]), `${o}: round trip`);
    }
  }
  assert.deepEqual(uprightToPanel(-1, 7, 'portrait'), [0, 1], 'kept on the glass');
  assert.deepEqual(uprightToPanel(0.3, 0.6, null), [0.3, 0.6], 'unknown orientation: as portrait');
  ok('mapping: upright -> panel and back in portrait, landscape-left, landscape-right and upside down');
}

// ---- upright points -> HID reports (0..65535 across the panel), per orientation ----
{
  const tall = { width: 390, height: 844, scale: 3 };
  const wide = { width: 844, height: 390, scale: 3 };
  assert.deepEqual(toHid(0, 0, tall), [0, 0]);
  assert.deepEqual(toHid(390, 844, tall, 'portrait'), [65535, 65535]);
  assert.deepEqual(toHid(390, 844, tall, 'portrait-upside-down'), [0, 0]);
  // landscape: `screen` is the upright (wide) one, as the backends give it
  assert.deepEqual(toHid(0, 0, wide, 'landscape-left'), [65535, 0]);
  assert.deepEqual(toHid(844, 0, wide, 'landscape-left'), [65535, 65535]);
  assert.deepEqual(toHid(0, 390, wide, 'landscape-left'), [0, 0]);
  assert.deepEqual(toHid(0, 0, wide, 'landscape-right'), [0, 65535]);
  assert.deepEqual(toHid(844, 390, wide, 'landscape-right'), [65535, 0]);
  assert.deepEqual(pointsToHid(422, 195, wide, 'landscape-left'), [32768, 32768]);
  // a drag to the right across a landscape-left phone runs down the panel's long side
  const a = toHid(100, 200, wide, 'landscape-left');
  const b = toHid(700, 200, wide, 'landscape-left');
  assert.equal(a[0], b[0]);
  assert.ok(b[1] > a[1]);
  ok('HID: upright points -> panel reports in all four orientations');
}

// ---- units: normalized (preferred), the upright picture's pixels, points ----
{
  assert.equal(parseUnit('norm'), 'norm');
  assert.equal(parseUnit('PX'), 'px');
  assert.equal(parseUnit('pt'), 'pt');
  assert.equal(parseUnit('furlong'), null);
  assert.equal(parseUnit(undefined), null);
  assert.equal(guessUnit([0.5, 0.25]), 'norm');
  assert.equal(guessUnit([0, 0.999]), 'norm');
  assert.equal(guessUnit([195, 422]), 'pt');
  assert.equal(guessUnit([1, 1]), 'pt', 'whole numbers are points (a corner)');
  assert.equal(guessUnit([0.5, 400]), 'pt');
  const tall = { width: 390, height: 844, scale: 3 };
  const wide = { width: 844, height: 390, scale: 3 };
  assert.deepEqual(toPoints(0.5, 0.5, 'norm', tall), [195, 422]);
  assert.deepEqual(toPoints(0.5, 0.5, 'norm', wide), [422, 195], 'normalized is of the upright picture: wide in landscape');
  assert.deepEqual(toPoints(585, 1266, 'px', tall), [195, 422], "the screen's own pixels: points x scale");
  assert.deepEqual(toPoints(135, 292.5, 'px', tall, { width: 270, height: 585 }), [195, 422], "a picture's pixels, with the picture's size");
  assert.deepEqual(toPoints(292.5, 135, 'px', wide, { width: 585, height: 270 }), [422, 195]);
  assert.deepEqual(toPoints(10, 20, 'pt', null), [10, 20], 'points need no screen');
  assert.equal(toPoints(0.5, 0.5, 'norm', null), null, 'normalized needs the screen size');
  assert.equal(toPoints(5, 5, 'px', { width: 390, height: 844, scale: null }), null, "pixels need the scale (or the picture's size)");
  ok('units: normalized, pixels (screen or picture) and points -> upright points');
}

// ---- Control: one tap message, any unit, every orientation -> upright points on the backend ----
{
  let o: Orientation = 'portrait';
  const calls: string[] = [];
  const b = {
    mock: true,
    screen: () => ({ ...uprightSize({ width: 390, height: 844 }, o), scale: 3 }),
    orientation: () => o,
    tap: async (_u: string, x: number, y: number) => {
      calls.push(`tap ${Math.round(x)},${Math.round(y)}`);
      return { via: 'wda' as const };
    },
    gesture: async (_u: string, pts: PathPoint[]) => {
      calls.push(`gesture ${pts.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' ')}`);
      return { via: 'wda' as const };
    },
  } as unknown as Backend;
  const c = new Control(b);
  const want: Record<Orientation, string> = { portrait: 'tap 98,633', 'landscape-left': 'tap 211,293', 'landscape-right': 'tap 211,293', 'portrait-upside-down': 'tap 98,633' };
  for (const turn of ORIENTATIONS) {
    o = turn;
    calls.length = 0;
    await c.handle('P', { type: 'tap', x: 0.25, y: 0.75 }); // no unit: within 0..1 = normalized
    await c.handle('P', { type: 'tap', x: 0.25, y: 0.75, unit: 'norm' });
    const s = b.screen('P')!;
    await c.handle('P', { type: 'tap', x: 0.25 * s.width * 3, y: 0.75 * s.height * 3, unit: 'px' });
    await c.handle('P', { type: 'tap', x: 0.25 * 600, y: 0.75 * 300, unit: 'px', w: 600, h: 300 });
    await c.handle('P', { type: 'tap', x: 0.25 * s.width, y: 0.75 * s.height, unit: 'pt' });
    assert.deepEqual(calls, Array(5).fill(want[turn]), `${turn}: every unit lands on the same point`);
  }
  o = 'landscape-left';
  calls.length = 0;
  await c.handle('P', { type: 'tap', x: 2, y: -1, unit: 'norm' });
  await c.handle('P', { type: 'swipe', x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, ms: 100 });
  await c.handle('P', { type: 'path', points: [[0, 0, 0], [1, 1, 50]], unit: 'norm' });
  await c.handle('P', { type: 'tap', x: 100, y: 200 }); // no unit, outside 0..1: points, as before units
  assert.deepEqual(calls, ['tap 843,0', 'gesture 84,195 760,195', 'gesture 0,0 843,389', 'tap 100,200']);
  ok('Control: normalized, pixel and point coordinates map to upright points in all four orientations, clamped');
}
{
  const c = new Control({ mock: true, screen: () => null } as unknown as Backend);
  await assert.rejects(c.handle('P', { type: 'tap', x: 0.5, y: 0.5 }), /screen size isn't known yet/);
  ok('Control: normalized coordinates before the screen is known are refused (503), not guessed');
}

// ---- the capture's picture against the phone's shape ----
{
  const tall = { width: 1170, height: 2532 };
  const wide = { width: 2532, height: 1170 };
  assert.ok(frameAgrees(tall, 'portrait') && frameAgrees(wide, 'landscape-left') && frameAgrees(tall, 'portrait-upside-down'));
  assert.ok(!frameAgrees(wide, 'portrait') && !frameAgrees(tall, 'landscape-right'));
  assert.ok(frameAgrees(wide, null) && frameAgrees(null, 'portrait'), "nothing to compare: nothing's wrong");
  const s = (rotated: number, tries: number, rotate: 'off' | 'cw' | 'ccw' = 'off') => ({ rotated, tries, rotate });
  assert.equal(captureFix(tall, 'portrait', s(0, 0)), 'ok');
  assert.equal(captureFix(wide, 'portrait', s(0, 0)), 'restart', 'a picture that kept its old shape: a new capture session');
  assert.equal(captureFix(wide, 'portrait', s(0, 1)), 'restart');
  assert.equal(captureFix(wide, 'portrait', s(0, 2)), 'give-up', 'twice is enough: say so in the stats');
  assert.equal(captureFix(wide, 'portrait', s(0, 2, 'cw')), 'rotate', 'CAPTURE_ROTATE: turn it');
  assert.equal(captureFix(tall, 'landscape-left', s(90, 0, 'cw')), 'unrotate', 'our own quarter turn is what disagrees now');
  assert.equal(captureFix(wide, 'landscape-left', s(0, 2, 'cw')), 'ok');
  ok('capture: a picture without the phone\'s shape restarts the capture (twice), then turns it or says so');
}

// ---- picture sizes from the header ----
{
  const png = encodePng(7, 3, new Uint8Array(7 * 3 * 3));
  assert.deepEqual(imageSize(png), { width: 7, height: 3 });
  // a JPEG: SOI, an APP0 segment, then SOF0 with height 844 and width 390
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x4c, 0x01, 0x86, 0x03, 0x01, 0x22, 0x00]);
  assert.deepEqual(imageSize(jpeg), { width: 390, height: 844 });
  assert.equal(imageSize(Buffer.from('not a picture at all')), null);
  ok('imageSize: PNG and JPEG sizes from the header');
}

// ---- the server: the list, hellos, an update on change, screenshots and taps follow the phone as it turns ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(2);
  const server = createServer(backend, token, undefined, { exactTouch: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}` };
  const get = async (p: string) => (await fetch(base + p, { headers: auth })).json() as Promise<any>;
  const post = async (p: string, body: unknown) =>
    (await fetch(base + p, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
  const udid = (await get('/phones'))[0].udid as string;
  try {
    let p = (await get('/api/devices'))[0];
    assert.deepEqual([p.orientation, p.width, p.height, p.point_width, p.point_height], ['portrait', 1170, 2532, 390, 844]);

    // a control socket and a stream are open while the phone turns
    const ctl = new WebSocket(`${base.replace('http', 'ws')}/phones/${udid}/control?token=${token}`);
    const ctlMsgs: any[] = [];
    ctl.on('message', (d) => ctlMsgs.push(JSON.parse(String(d))));
    const stream = new WebSocket(`${base.replace('http', 'ws')}/api/devices/${udid}/stream?token=${token}&fps=10`);
    const streamMsgs: any[] = [];
    const frames: Buffer[] = [];
    stream.on('message', (d, isBinary) => (isBinary ? frames.push(d as Buffer) : streamMsgs.push(JSON.parse(String(d)))));
    for (let i = 0; i < 100 && (frames.length < 1 || !ctlMsgs.length); i++) await sleep(20);
    assert.deepEqual([ctlMsgs[0].type, ctlMsgs[0].orientation, ctlMsgs[0].width, ctlMsgs[0].height], ['hello', 'portrait', 1170, 2532]);
    const hello = streamMsgs.find((m) => m.type === 'hello');
    assert.deepEqual([hello.orientation, hello.point_width, hello.point_height, hello.screen_width, hello.screen_height], ['portrait', 390, 844, 1170, 2532]);
    assert.ok(hello.width < hello.height, 'the hello has an upright (tall) picture size');
    const first = streamMsgs.find((m) => m.type === 'orientation');
    assert.deepEqual([first.orientation, first.width, first.height], ['portrait', 270, 585], "the frames' real size comes with the first frame");
    assert.deepEqual(imageSize(frames[0]!), { width: 270, height: 585 });

    backend.setOrientation(udid, 'landscape-left');
    const n = frames.length;
    for (let i = 0; i < 100 && (frames.length < n + 2 || !ctlMsgs.some((m) => m.type === 'orientation')); i++) await sleep(20);
    const turnedCtl = ctlMsgs.find((m) => m.type === 'orientation');
    assert.deepEqual(
      [turnedCtl.udid, turnedCtl.orientation, turnedCtl.width, turnedCtl.height, turnedCtl.point_width, turnedCtl.point_height],
      [udid, 'landscape-left', 2532, 1170, 844, 390],
      'the control socket hears the turn, with the upright (wide) size',
    );
    const turnedStream = streamMsgs.filter((m) => m.type === 'orientation').pop();
    assert.deepEqual([turnedStream.orientation, turnedStream.width, turnedStream.height], ['landscape-left', 585, 270], 'the stream hears it, with its frames\' new size');
    assert.equal(turnedStream.turn, undefined, 'the frames are upright already: nothing to turn');
    assert.deepEqual(imageSize(frames[frames.length - 1]!), { width: 585, height: 270 }, 'frames go out upright, at the true shape');

    p = (await get('/phones'))[0];
    assert.deepEqual([p.orientation, p.width, p.height, p.point_width, p.point_height], ['landscape-left', 2532, 1170, 844, 390]);
    assert.equal((await get('/phones'))[1].orientation, 'portrait', 'the other phone did not turn');
    const o = await get(`/api/devices/${udid}/orientation`);
    assert.deepEqual([o.ok, o.orientation, o.width, o.height], [true, 'landscape-left', 2532, 1170]);

    const shot = await fetch(`${base}/phones/${udid}/screenshot`, { headers: auth });
    assert.deepEqual([shot.headers.get('x-orientation'), shot.headers.get('x-width'), shot.headers.get('x-height')], ['landscape-left', '585', '270']);
    assert.deepEqual(imageSize(Buffer.from(await shot.arrayBuffer())), { width: 585, height: 270 }, 'screenshots are upright too');

    // touches follow: normalized (0..1 of the upright, now wide, picture) and pixels of the picture
    backend.inputLog(udid).length = 0;
    await post(`/phones/${udid}/tap`, { x: 0.5, y: 0.5, fast: true });
    await post(`/phones/${udid}/tap`, { x: 0.9, y: 0.1, unit: 'norm', fast: true });
    await post(`/phones/${udid}/tap`, { x: 585, y: 270, unit: 'px', w: 585, h: 270, fast: true });
    assert.deepEqual(backend.inputLog(udid), ['tap 422,195', 'tap 760,39', 'tap 843,389']);

    backend.setOrientation(udid, 'portrait');
    for (let i = 0; i < 50 && ctlMsgs.filter((m) => m.type === 'orientation').length < 2; i++) await sleep(20);
    assert.equal(ctlMsgs.filter((m) => m.type === 'orientation').pop().orientation, 'portrait');
    ctl.close();
    stream.close();
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('server: list, hellos, an "orientation" update on change, screenshots and taps all follow the phone as it turns');
}

console.log(`\nall ${passed} rotation checks passed`);
