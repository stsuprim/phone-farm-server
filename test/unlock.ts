// Nothing wakes a phone but a wake (2026-11-17, the owner: "when I open PHONE tab do not auto open or do anything …
// a button on the phone middle called unlock"): Lotus's page now only selects a phone, and its Unlock button wakes it
// (POST /wake) before its view starts. Here: the focus, a control socket, the watch and the read-only details leave a
// locked (or dark) phone as it is; POST /wake wakes it; a stream (a picture asked for) still wakes as before.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { IdleLock } from '../src/idle.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import type { Backend } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await sleep(15);
  return cond();
};

// ---- the idle lock: a control link's viewer is activity only; a picture's viewer wakes ----
{
  const calls: string[] = [];
  const b = {
    isLocked: async () => (calls.push('look'), true),
    lock: async () => void calls.push('lock'),
    unlock: async () => void calls.push('unlock'),
  } as unknown as Backend;
  const idle = new IdleLock(b, () => 10, { tickMs: 0, log: () => {} });
  const release = idle.viewer('P', false);
  await sleep(20);
  assert.deepEqual(calls, [], 'a viewer without wake asks and presses nothing');
  assert.equal(idle.state('P').viewers, 1, 'it still counts (no idle lock while the link is open)');
  release();
  assert.equal(idle.state('P').viewers, 0);
  idle.viewer('P')();
  await sleep(20);
  assert.deepEqual(calls, ['look', 'unlock', 'look'], 'a picture viewer still looks and wakes');
  ok('idle: viewer(udid, false) is activity only; viewer(udid) still wakes');
}

// ---- the server: selection-time requests never wake ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(2);
  const server = createServer(backend, token, undefined, { watchMs: 40, focusLockMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const get = (p: string) => fetch(`http://${host}${p}`, { headers: auth });
  const post = async (p: string) => (await fetch(`http://${host}${p}`, { method: 'POST', headers: auth, body: '{}' })).status;
  const [a, b] = ((await (await get('/phones')).json()) as any[]).map((p) => p.udid as string);
  const unlocks = (u: string) => backend.inputLog(u).filter((x) => x === 'unlock').length;
  const sockets: WebSocket[] = [];
  try {
    await backend.lock(a!);
    await backend.lock(b!);

    // the page's list and a phone's details: read-only
    assert.equal((await get('/phones')).status, 200);
    assert.equal((await get(`/phones/${a}/info`)).status, 200);
    // the focus (one live phone): nothing woken, also under the watch's ticks
    assert.equal(await post(`/phones/${a}/focus`), 200);
    await sleep(250);
    assert.equal(unlocks(a!), 0, 'the focus and the watch wake nothing');
    assert.equal(await backend.isLocked(a!), true);

    // a control socket alone (as an older page opened on selection): no wake on connect
    const server2 = createServer(backend, token, undefined, { watchMs: 0, focusLockMs: 0 });
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const host2 = `127.0.0.1:${(server2.address() as AddressInfo).port}`;
    try {
      const ctl = new WebSocket(`ws://${host2}/phones/${b}/control?token=${token}`);
      sockets.push(ctl);
      await new Promise((r) => ctl.once('open', r));
      await sleep(250);
      assert.equal(unlocks(b!), 0, 'opening the control link wakes nothing');
      assert.equal(await backend.isLocked(b!), true);
      ctl.close();
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
    }
    ok('server: the list, details, focus, the watch and a control socket leave a locked phone locked');

    // Unlock: POST /wake wakes it
    assert.equal(await post(`/phones/${b}/wake`), 200);
    assert.equal(unlocks(b!), 1, 'POST /wake wakes');
    assert.equal(await backend.isLocked(b!), false);
    ok('server: POST /wake (Unlock) wakes the phone');

    // a picture asked for (a stream) still wakes, as before
    const view = new WebSocket(`ws://${host}/phones/${a}/stream?token=${token}&codec=mjpeg`);
    sockets.push(view);
    await new Promise((r) => view.once('open', r));
    assert.ok(await until(() => unlocks(a!) > 0), 'a stream wakes its phone');
    ok('server: a picture asked for still wakes its phone');
  } finally {
    for (const s of sockets) s.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

console.log(`\nall ${passed} unlock checks passed`);
process.exit(0);
