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
  for (const k of ['udid', 'name', 'model', 'ios', 'battery', 'online']) assert.ok(k in phones[0], `phone has ${k}`);
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
