// Opening a live view fast: a capture kept warm after its last viewer (and stopped when nobody comes), started ahead
// by POST /warm and by the control socket, a keyframe at once for whoever joins, and `connectMs` (the request -> the
// first frame) in the stream hello and a "first-frame" message.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { H264Source, H264Viewer, KIND, Producer, ProducerHooks, Rec, Transport } from '../src/h264.js';
import { mockSpsPps } from '../src/h264mock.js';
import { MjpegSource } from '../src/mjpeg.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A capture helper driven by hand: emits records when told, counts its starts, stops and keyframe asks. */
function manual() {
  let hooks: ProducerHooks | undefined;
  const ctl = {
    starts: 0, stops: 0, keys: 0,
    emit: (kind: number, payload: Buffer = Buffer.from([0, 0, 0, 1, kind === KIND.KEY ? 0x65 : 0x41, 0])) => hooks?.record({ kind, time: Date.now(), arrived: Date.now(), payload }),
    up: () => {
      ctl.emit(KIND.INFO, Buffer.from(JSON.stringify({ width: 208, height: 448, fps: 60, scale: 100 })));
      ctl.emit(KIND.CONFIG, mockSpsPps());
      ctl.emit(KIND.KEY);
    },
  };
  const start = (_w: unknown, h: ProducerHooks): Producer => {
    ctl.starts++;
    hooks = h;
    return { key: () => void ctl.keys++, stop: () => void ctl.stops++ };
  };
  return { ctl, start };
}
function viewerOf(src: H264Source) {
  const sent: number[] = [];
  const t: Transport = { kind: 'ws', buffered: () => 0, open: () => true, send: (r: Rec) => void sent.push(r.kind), fail: () => {} };
  return { v: new H264Viewer(t, src), sent };
}
const want = { fps: 60, scale: 100, bitrate: 8_000_000 };

// ---- the capture: started by its first viewer, kept a moment after its last one, stopped when nobody comes ----
{
  const { ctl, start } = manual();
  const src = new H264Source('t', start, want, { log: () => {}, idleMs: 80, openTimeoutMs: 2000 });
  assert.equal(src.ready, false);
  assert.equal(ctl.starts, 0, 'nothing runs before a viewer asks');
  const first = src.open(); // the first viewer asks for the picture
  assert.equal(ctl.starts, 1, 'the capture starts with the first viewer');
  ctl.up();
  await first;
  assert.equal(src.ready, true, 'a picture is at hand');
  // a viewer joining now gets the keyframe at once, without waiting for the capture
  const t0 = performance.now();
  const info = await src.open();
  assert.ok(performance.now() - t0 < 60, 'open() on a running capture answers at once');
  assert.equal(info.width, 208);
  const a = viewerOf(src);
  src.add(a.v);
  assert.deepEqual(a.sent, [KIND.CONFIG, KIND.KEY], 'config + keyframe at once on join');
  assert.equal(ctl.starts, 1);
  // deltas ran since that keyframe: the next viewer still gets the cached picture at once, and a fresh keyframe is asked
  ctl.emit(KIND.DELTA);
  const keysBefore = ctl.keys;
  const b = viewerOf(src);
  src.add(b.v);
  assert.deepEqual(b.sent, [KIND.CONFIG, KIND.KEY]);
  assert.equal(ctl.keys, keysBefore + 1, 'a fresh keyframe is asked for the newcomer');
  ctl.emit(KIND.DELTA);
  assert.deepEqual(b.sent, [KIND.CONFIG, KIND.KEY], 'no delta of the old picture after a stale keyframe');
  ctl.emit(KIND.KEY);
  ctl.emit(KIND.DELTA);
  assert.deepEqual(b.sent, [KIND.CONFIG, KIND.KEY, KIND.KEY, KIND.DELTA]);
  // the last viewer leaves: the capture stays up for the grace time (a page redrawing, a session made anew)
  src.remove(a.v);
  src.remove(b.v);
  await sleep(40);
  assert.equal(src.ready, true, 'still up within the grace time');
  const c = viewerOf(src);
  await src.open();
  src.add(c.v);
  assert.equal(c.sent[c.sent.length - 1], KIND.KEY);
  assert.equal(ctl.starts, 1, 'the same capture: no restart');
  await sleep(120);
  assert.equal(ctl.stops, 0, 'never stopped under a viewer');
  src.remove(c.v);
  await sleep(140);
  assert.deepEqual([ctl.stops, src.running, src.ready], [1, false, false], 'stopped after the grace time with nobody watching');

  // a viewer that asked for the capture and left while it started doesn't leave it running for good
  const p = src.open();
  assert.equal(ctl.starts, 2);
  ctl.up();
  await p; // ...and never adds a viewer
  await sleep(140);
  assert.deepEqual([ctl.stops, src.running], [2, false]);
  src.close();
  ok('capture: started by the first viewer, a keyframe at once on join, kept for the grace time after the last viewer, stopped when nobody comes');
}

// ---- MJPEG: someone joining a running stream gets its newest frame at once ----
{
  const frame = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(40, n), Buffer.from([0xff, 0xd9])]);
  let out: http.ServerResponse | undefined;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=b' });
    out = res;
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as AddressInfo).port;
  const part = (f: Buffer) => out!.write(Buffer.concat([Buffer.from(`--b\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`), f, Buffer.from('\r\n')]));
  const src = new MjpegSource(() => port);
  const a: number[] = [];
  const offA = src.add((f) => void a.push(f[2]!), true);
  for (let i = 0; i < 100 && !out; i++) await sleep(5);
  part(frame(1));
  for (let i = 0; i < 100 && !a.length; i++) await sleep(5);
  assert.deepEqual(a, [1]);
  // no new frame from the phone yet: the newcomer still has a picture right away (after its caller's own turn)
  const b: number[] = [];
  const offB = src.add((f) => void b.push(f[2]!), true);
  assert.deepEqual(b, [], 'not inside add(): the caller says its hello first');
  await sleep(10);
  assert.deepEqual(b, [1], 'the newest frame at once');
  // a look that must be new (a screenshot after an action) doesn't get the old one
  const c: number[] = [];
  const offC = src.add((f) => void c.push(f[2]!));
  await sleep(10);
  assert.deepEqual(c, []);
  part(frame(2));
  for (let i = 0; i < 100 && !c.length; i++) await sleep(5);
  assert.deepEqual([a, b, c], [[1, 2], [1, 2], [2]]);
  offA();
  offB();
  offC();
  upstream.closeAllConnections();
  upstream.close();
  ok('MJPEG: a viewer joining a running stream gets its newest frame at once');
}

// ---- the server: connectMs in the hello, "first-frame", a second view within the grace time, POST /warm starts nothing ----
{
  const START_MS = 400; // the mock capture's first picture takes this long, as a real one takes a second or two
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(3, { h264StartMs: START_MS, h264IdleMs: 600 });
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const list = async () => (await (await fetch(`http://${host}/phones`, { headers: auth })).json()) as any[];
  const [u1, u2, u3] = (await list()).map((p) => p.udid as string);

  /** Opens a stream and resolves once its hello, a frame and "first-frame" came: what came, in order. */
  const view = (udid: string, q: string) =>
    new Promise<{ hello: any; first: any; order: string[]; ms: number; close: () => void }>((resolve, reject) => {
      const t0 = performance.now();
      const ws = new WebSocket(`ws://${host}/phones/${udid}/stream?token=${token}${q}`);
      const order: string[] = [];
      let hello: any = null;
      let first: any = null;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`no picture (${order.join(', ')})`));
      }, 8000);
      ws.on('message', (d, isBinary) => {
        if (isBinary) order.push('frame');
        else {
          const m = JSON.parse(d.toString());
          order.push(m.type);
          if (m.type === 'hello') hello = m;
          if (m.type === 'first-frame') first = m;
        }
        if (hello && first && order.includes('frame')) {
          clearTimeout(timer);
          resolve({ hello, first, order, ms: performance.now() - t0, close: () => ws.close() });
        }
      });
      ws.on('error', reject);
    });
  const sessions = async (udid: string) => (await list()).find((p) => p.udid === udid).stats.sessions as any[];

  try {
    // cold: the capture has to start; the hello says how long the picture took and that it wasn't warm
    const cold = await view(u1!, '&codec=h264');
    assert.equal(cold.hello.codec, 'h264');
    assert.equal(cold.hello.warm, false);
    assert.ok(Number.isInteger(cold.hello.connectMs), 'connectMs is whole ms');
    assert.ok(cold.hello.connectMs >= START_MS - 30 && cold.hello.connectMs <= cold.ms + 5, `cold connectMs ${cold.hello.connectMs} (the capture took ${START_MS} ms, the client waited ${Math.round(cold.ms)})`);
    assert.equal(cold.order[0], 'hello', 'the hello comes first');
    assert.ok(cold.order.indexOf('frame') < cold.order.indexOf('first-frame'), '"first-frame" follows the first frame');
    assert.deepEqual([cold.first.transport, cold.first.udid, cold.first.warm], ['h264-ws', u1, false]);
    assert.ok(cold.first.connectMs >= cold.hello.connectMs && cold.first.connectMs - cold.hello.connectMs < 50, 'the keyframe leaves with the hello');
    const s1 = await sessions(u1!);
    assert.equal(s1.length, 1);
    assert.equal(s1[0].connectMs, cold.first.connectMs, 'stats.sessions says it too');
    cold.close();
    await sleep(60);

    // back within the warm time: the capture is still up, the picture is there at once
    const warm = await view(u1!, '&codec=h264');
    assert.equal(warm.hello.warm, true);
    assert.ok(warm.hello.connectMs < 200, `warm connectMs ${warm.hello.connectMs}`);
    assert.ok(warm.hello.connectMs < cold.hello.connectMs / 2, 'a warm view opens much faster than a cold one');
    warm.close();

    // POST /warm no longer starts a phone's capture (2026-11-16: it runs only while a live view is open): it wakes
    // the phone and says whether the capture runs
    const post = async (p: string) => {
      const r = await fetch(`http://${host}${p}`, { method: 'POST', headers: auth, body: '{}' });
      return { status: r.status, body: (await r.json()) as any };
    };
    const w1 = await post(`/phones/${u2}/warm`);
    assert.deepEqual([w1.status, w1.body.ok, w1.body.udid, w1.body.capture], [200, true, u2, 'off']);
    assert.ok(w1.body.input && typeof w1.body.input.hid === 'string', 'and says the input methods');
    await sleep(START_MS + 80);
    assert.equal((await post(`/api/devices/${u2}/warm`)).body.capture, 'off', 'the same under /api/devices: nothing was started');
    assert.equal(backend.capturing(u2!), false);
    const cold2 = await view(u2!, '&codec=h264');
    assert.equal(cold2.hello.warm, false, 'the view starts the capture itself');
    assert.equal((await post(`/phones/${u2}/warm`)).body.capture, 'warm', 'running under its viewer');
    cold2.close();
    assert.equal((await post('/phones/NOPE/warm')).status, 404);
    assert.equal((await fetch(`http://${host}/phones/${u2}/warm`, { headers: auth })).status, 405);

    // a control socket opening (the live view's first step) starts no capture either: the offer or the stream does
    const ctl = new WebSocket(`ws://${host}/phones/${u3}/control?token=${token}`);
    await new Promise((r) => ctl.once('open', r));
    await sleep(START_MS + 80);
    assert.equal(backend.capturing(u3!), false, 'no capture behind a control socket alone');
    const viaCtl = await view(u3!, '&codec=h264');
    assert.equal(viaCtl.hello.warm, false);
    viaCtl.close();
    ctl.close();

    // the last viewer gone: the capture stops after the grace time
    await sleep(800);
    assert.deepEqual([backend.capturing(u1!), backend.capturing(u2!), backend.capturing(u3!)], [false, false, false]);

    // MJPEG: the hello goes with the first frame and says connectMs too
    const mj = await view(u1!, '&codec=mjpeg&fps=20');
    assert.equal(mj.hello.codec, 'mjpeg');
    assert.ok(Number.isInteger(mj.hello.connectMs) && mj.hello.connectMs >= 0 && mj.hello.connectMs <= mj.ms + 5, `mjpeg connectMs ${mj.hello.connectMs}`);
    assert.equal(mj.order[0], 'hello');
    assert.ok(mj.order.indexOf('hello') < mj.order.indexOf('frame') && mj.order.indexOf('frame') < mj.order.indexOf('first-frame'));
    assert.deepEqual([mj.first.transport, mj.first.connectMs], ['mjpeg-ws', mj.hello.connectMs]);
    assert.equal((await sessions(u1!)).find((s) => s.transport === 'mjpeg-ws').connectMs, mj.hello.connectMs);
    mj.close();
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('server: connectMs + warm in the hello, "first-frame", a second view within the grace time, POST /warm and the control socket start no capture');
}

// ---- a backend with no H.264: POST /warm starts nothing, the MJPEG fallback's connectMs counts from the request ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(1, { h264: false });
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}` };
  const udid = ((await (await fetch(`http://${host}/phones`, { headers: auth })).json()) as any[])[0].udid as string;
  try {
    const w = (await (await fetch(`http://${host}/phones/${udid}/warm`, { method: 'POST', headers: auth })).json()) as any;
    assert.deepEqual([w.ok, w.capture], [true, 'off']);
    assert.match(w.reason, /only while a live view is open/);
    const hello = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}/phones/${udid}/stream?token=${token}&codec=h264`);
      const t = setTimeout(() => reject(new Error('no hello')), 5000);
      ws.on('message', (d, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(d.toString());
        if (m.type !== 'hello') return;
        clearTimeout(t);
        ws.close();
        resolve(m);
      });
    });
    assert.equal(hello.codec, 'mjpeg');
    assert.ok(typeof hello.reason === 'string' && Number.isInteger(hello.connectMs));
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('no H.264: POST /warm says why; the MJPEG fallback hello still says connectMs');
}

console.log(`\nall ${passed} connect checks passed`);
