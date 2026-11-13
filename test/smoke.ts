// Smoke test. Default: starts an in-process mock server on a free port.
// Against a running server:  URL=http://mac:8787 API_TOKEN=... npm test
process.env.INPUT_LOG = '0'; // quiet the per-action latency lines
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';

let base = process.env.URL ?? '';
let token = process.env.API_TOKEN ?? '';
let stop = async () => {};
if (!base) {
  token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(4);
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = async () => {
    server.closeAllConnections();
    server.close();
    await backend.close();
  };
}
const auth = { authorization: `Bearer ${token}` };
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

let passed = 0;
const ok = (name: string) => { passed++; console.log(`ok - ${name}`); };

try {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  ok('health is open');
  assert.equal((await fetch(`${base}/phones`)).status, 401);
  assert.equal((await fetch(`${base}/phones`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  ok('auth required');

  const phones: any[] = await (await fetch(`${base}/phones`, { headers: auth })).json();
  assert.ok(phones.length > 0);
  for (const k of ['udid', 'name', 'model', 'ios', 'battery', 'online', 'control', 'scale', 'point_width', 'point_height']) {
    assert.ok(k in phones[0], `phone has ${k}`);
  }
  assert.ok(['ready', 'recovering', 'down'].includes(phones[0].control));
  ok(`GET /phones (${phones.length})`);

  const udid = phones.find((p) => p.online).udid;
  const shot = await fetch(`${base}/phones/${udid}/screenshot`, { headers: auth });
  assert.equal(shot.status, 200);
  const bytes = Buffer.from(await shot.arrayBuffer());
  assert.ok(shot.headers.get('content-type')!.startsWith('image/'));
  assert.ok(bytes.length > 100);
  ok('screenshot');

  assert.equal((await post(`/phones/${udid}/tap`, { x: 100, y: 200 })).status, 200);
  assert.equal((await post(`/phones/${udid}/tap`, { x: 'a' })).status, 400);
  assert.equal((await post(`/phones/${udid}/swipe`, { x1: 10, y1: 400, x2: 10, y2: 100, ms: 250 })).status, 200);
  assert.equal((await post(`/phones/${udid}/type`, { text: 'hello' })).status, 200);
  assert.equal((await post(`/phones/${udid}/home`, {})).status, 200);
  assert.equal((await post(`/phones/${udid}/launch`, { bundleId: 'com.apple.mobilesafari' })).status, 200);
  assert.equal((await post(`/phones/nope/home`, {})).status, 404);
  ok('tap/swipe/type/home/launch');

  assert.equal((await post(`/phones/${udid}/path`, { points: [[50, 600, 0], [80, 500, 40], [120, 300, 120]], unit: 'pt' })).status, 200);
  assert.equal((await post(`/phones/${udid}/path`, { points: [] })).status, 400);
  assert.equal((await post(`/phones/${udid}/path`, { points: [[1, 'b', 0]] })).status, 400);
  assert.equal((await post(`/phones/${udid}/hold`, { x: 200, y: 400, ms: 600 })).status, 200);
  assert.equal((await post(`/phones/${udid}/hold`, { x: 200 })).status, 400);
  assert.equal((await post(`/phones/${udid}/tap`, { x: -50, y: 99999 })).status, 200); // clamped, not refused
  assert.equal((await post(`/phones/${udid}/touch`, { phase: 'down', x: 10, y: 10, t: 0 })).status, 200);
  assert.equal((await post(`/phones/${udid}/touch`, { phase: 'up', x: 100, y: 100, t: 200 })).status, 200);
  assert.equal((await post(`/phones/${udid}/touch`, { phase: 'sideways', x: 1, y: 1 })).status, 400);
  ok('path/hold/touch (HTTP)');

  const rec = await post(`/phones/${udid}/recover`, {});
  assert.equal(rec.status, 200);
  const recBody: any = await rec.json();
  assert.equal(recBody.ok, true);
  assert.ok(['ready', 'recovering', 'down'].includes(recBody.control));
  assert.equal((await post(`/phones/nope/recover`, {})).status, 404);
  assert.equal((await fetch(`${base}/phones/${udid}/recover`, { method: 'POST' })).status, 401);
  ok('recover');

  // control socket: acks per id, in order
  const acks = await new Promise<any[]>((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/phones/${udid}/control?token=${token}`);
    const got: any[] = [];
    const t = setTimeout(() => reject(new Error(`control acks missing (${JSON.stringify(got)})`)), 5000);
    ws.on('open', () => {
      const msgs = [
        { id: 1, type: 'tap', x: 100, y: 200 },
        { id: 2, type: 'swipe', x1: 10, y1: 400, x2: 10, y2: 100, ms: 200 },
        { id: 3, type: 'path', points: [[10, 10, 0], [20, 30, 50]] },
        { id: 4, type: 'hold', x: 50, y: 50, ms: 300 },
        { id: 5, type: 'home' },
        { id: 6, type: 'type', text: 'hi' },
        { type: 'touch', phase: 'down', x: 30, y: 600, t: 0 },
        { type: 'touch', phase: 'move', x: 40, y: 500, t: 30 },
        { id: 7, type: 'touch', phase: 'up', x: 50, y: 300, t: 90 },
        { id: 8, type: 'tap', x: 'no' },
        { id: 9, type: 'fly' },
      ];
      for (const m of msgs) ws.send(JSON.stringify(m));
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type !== 'ack') return;
      got.push(m);
      if (got.length === 9) {
        clearTimeout(t);
        ws.close();
        resolve(got);
      }
    });
    ws.on('error', reject);
  });
  assert.deepEqual(acks.filter((a) => a.ok).map((a) => a.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(acks.filter((a) => !a.ok).map((a) => a.id).sort(), [8, 9]);
  assert.ok(acks.filter((a) => !a.ok).every((a) => typeof a.error === 'string' && a.error));
  ok('control socket acks');

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/phones/${udid}/control?token=bad`);
    ws.on('unexpected-response', () => resolve());
    ws.on('open', () => reject(new Error('bad token accepted on control')));
    ws.on('error', () => resolve());
  });
  ok('control rejects bad token');

  const wsUrl = base.replace(/^http/, 'ws') + `/phones/${udid}/stream?token=${token}`;
  const frames = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let n = 0;
    const t = setTimeout(() => reject(new Error('no frames')), 5000);
    ws.on('message', (d, isBinary) => {
      if (isBinary && ++n >= 3) { clearTimeout(t); ws.close(); resolve(n); }
    });
    ws.on('error', reject);
  });
  assert.ok(frames >= 3);
  ok('stream delivers frames');

  const hello = await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/phones/${udid}/stream?token=${token}&fps=10&quality=40&scale=999`);
    const t = setTimeout(() => reject(new Error('no hello')), 5000);
    ws.on('message', (d, isBinary) => {
      if (!isBinary) { clearTimeout(t); ws.close(); resolve(JSON.parse(d.toString())); }
    });
    ws.on('error', reject);
  });
  assert.equal(hello.type, 'hello');
  assert.ok(typeof hello.fps === 'number' && hello.fps >= 1 && hello.fps <= 10);
  assert.ok(typeof hello.scale === 'number' && hello.scale <= 100);
  ok(`stream hello reports fps ${hello.fps}, scale ${hello.scale}`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/phones/${udid}/stream?token=bad`);
    ws.on('unexpected-response', () => resolve());
    ws.on('open', () => reject(new Error('bad token accepted')));
    ws.on('error', () => resolve());
  });
  ok('stream rejects bad token');

  // ---- clock sync, stats, H.264 stream ----
  const pong = await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/phones/${udid}/control?token=${token}`);
    const t = setTimeout(() => reject(new Error('no pong')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'ping', t: 12345.5 })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'pong') { clearTimeout(t); ws.close(); resolve(m); }
    });
    ws.on('error', reject);
  });
  assert.equal(pong.t, 12345.5);
  assert.ok(Math.abs(pong.server_time - Date.now()) < 5000);
  ok('control ping -> pong with server_time');

  const phones2: any[] = await (await fetch(`${base}/phones`, { headers: auth })).json();
  const st = phones2.find((p) => p.udid === udid).stats;
  for (const k of ['codec', 'fps', 'encode_ms', 'capture_to_encoded_ms', 'encoded_to_sent_ms', 'viewers', 'path', 'h264_available', 'h264_reason']) {
    assert.ok(k in st, `stats has ${k}`);
  }
  assert.ok(Array.isArray(phones2[0].lan));
  ok(`GET /phones has stats and lan (${phones2[0].lan.length} address(es))`);

  /** Opens a stream socket and collects the hello and the first binary messages. */
  const streamOpen = (q: string, until: (bins: Buffer[]) => boolean, onBin?: (ws: WebSocket, bins: Buffer[]) => void) =>
    new Promise<{ hello: any; bins: Buffer[] }>((resolve, reject) => {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + `/phones/${udid}/stream?token=${token}${q}`);
      let hello: any = null;
      const bins: Buffer[] = [];
      const t = setTimeout(() => { ws.close(); reject(new Error(`stream timed out (hello ${JSON.stringify(hello)}, ${bins.length} frames)`)); }, 10000);
      ws.on('message', (d, isBinary) => {
        if (!isBinary) {
          hello ??= JSON.parse(d.toString());
          return;
        }
        assert.ok(hello, 'hello comes before any frame');
        bins.push(d as Buffer);
        onBin?.(ws, bins);
        if (until(bins)) { clearTimeout(t); ws.close(); resolve({ hello, bins }); }
      });
      ws.on('error', reject);
    });

  if (!process.env.URL) {
    const h = await streamOpen('&codec=h264&fps=30&scale=100', (b) => b.filter((x) => x[0] === 3).length >= 3);
    assert.equal(h.hello.type, 'hello');
    assert.equal(h.hello.codec, 'h264');
    for (const k of ['width', 'height', 'fps', 'scale', 'server_time']) assert.equal(typeof h.hello[k], 'number', `hello.${k}`);
    assert.equal(h.bins[0]![0], 1, 'config first');
    assert.equal(h.bins[1]![0], 2, 'then a keyframe');
    for (const b of h.bins) {
      assert.ok([1, 2, 3].includes(b[0]!));
      assert.ok(Math.abs(b.readDoubleBE(1) - Date.now()) < 10000, 'capture time is ms since the epoch');
      assert.deepEqual([...b.subarray(9, 13)], [0, 0, 0, 1], 'Annex B payload');
    }
    assert.equal(h.bins[0]![13]! & 0x1f, 7, 'config starts with the SPS');
    ok(`h264 stream: hello ${h.hello.width}x${h.hello.height}, config then keyframe then deltas`);

    // {type:"key"} forces a keyframe well before the 2 s interval
    let askedAt = 0;
    let keyAfter = 0;
    await streamOpen('&codec=h264', (b) => keyAfter > 0 && b.length > 0, (ws, bins) => {
      const last = bins[bins.length - 1]!;
      if (!askedAt && last[0] === 3) {
        askedAt = Date.now();
        ws.send(JSON.stringify({ type: 'key' }));
      } else if (askedAt && last[0] === 2 && !keyAfter) keyAfter = Date.now() - askedAt;
    });
    assert.ok(keyAfter < 1000, `keyframe ${keyAfter} ms after asking`);
    ok(`h264 {type:"key"} -> keyframe in ${keyAfter} ms`);

    // fallback: a server without H.264 answers codec=h264 with an MJPEG hello and a reason
    const token2 = crypto.randomBytes(16).toString('hex');
    const backend2 = new MockBackend(2, { h264: false });
    const server2 = createServer(backend2, token2);
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const port2 = (server2.address() as AddressInfo).port;
    const fb = await new Promise<{ hello: any; frames: number }>((resolve, reject) => {
      fetch(`http://127.0.0.1:${port2}/phones`, { headers: { authorization: `Bearer ${token2}` } })
        .then((r) => r.json())
        .then((list: any[]) => {
          assert.equal(list[0].stats.h264_available, false);
          assert.ok(list[0].stats.h264_reason);
          const ws = new WebSocket(`ws://127.0.0.1:${port2}/phones/${list[0].udid}/stream?token=${token2}&codec=h264`);
          let hello: any = null;
          let frames = 0;
          const t = setTimeout(() => reject(new Error('no fallback frames')), 5000);
          ws.on('message', (d, isBinary) => {
            if (!isBinary) hello = JSON.parse(d.toString());
            else if (++frames >= 2) { clearTimeout(t); ws.close(); resolve({ hello, frames }); }
          });
          ws.on('error', reject);
        }, reject);
    });
    server2.closeAllConnections();
    server2.close();
    await backend2.close();
    assert.equal(fb.hello.codec, 'mjpeg');
    assert.ok(typeof fb.hello.reason === 'string' && fb.hello.reason);
    assert.ok(fb.hello.contentType.startsWith('image/'));
    ok(`h264 fallback: hello codec mjpeg ("${fb.hello.reason}") then image frames`);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + `/phones/${udid}/stream?token=${token}&codec=vp9`);
      ws.on('unexpected-response', (_q, res) => (res.statusCode === 400 ? resolve() : reject(new Error(`status ${res.statusCode}`))));
      ws.on('open', () => reject(new Error('unknown codec accepted')));
      ws.on('error', () => {});
    });
    ok('unknown codec refused');

    const mj = await streamOpen('&codec=mjpeg', (b) => b.length >= 2);
    assert.equal(mj.hello.codec, 'mjpeg');
    ok('codec=mjpeg streams images');
  }
  console.log(`\nall ${passed} checks passed`);
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  await stop();
}
