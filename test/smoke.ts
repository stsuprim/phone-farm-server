// Smoke test. Default: starts an in-process mock server on a free port.
// Against a running server:  URL=http://mac:8787 API_TOKEN=... npm test
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
  console.log(`\nall ${passed} checks passed`);
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  await stop();
}
