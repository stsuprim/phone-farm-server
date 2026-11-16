// Live capture only while a live view is open (2026-11-16): the phone's USB screen capture starts with its first
// viewer and stops a moment after its last one left; the focus, POST /warm and a control socket alone start nothing;
// the agent's reads and actions never start it; and every still is WDA's own screenshot (src/stills.ts), never a
// frame of the capture.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MockBackend } from '../src/mock.js';
import { CAPTURE_GRACE_MS } from '../src/real.js';
import { createServer } from '../src/server.js';
import { still, stillHash, StillSource } from '../src/stills.js';

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

assert.ok(CAPTURE_GRACE_MS >= 2000 && CAPTURE_GRACE_MS <= 3000, 'a grace of 2 to 3 s after the last viewer, no warm time');

// ---- the server: the capture follows the viewers ----
{
  const GRACE = 300;
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(3, { h264IdleMs: GRACE });
  const server = createServer(backend, token, undefined, { watchMs: 40, focusLockMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const phones = async () => (await (await fetch(`http://${host}/phones`, { headers: auth })).json()) as any[];
  const capturing = async (udid: string) => (await phones()).find((p) => p.udid === udid).capturing as boolean;
  const get = (p: string) => fetch(`http://${host}${p}`, { headers: auth });
  const post = async (p: string, body: unknown = {}) => {
    const r = await fetch(`http://${host}${p}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  /** A live view: the H.264 stream, resolved at its first frame. */
  const view = (udid: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}/phones/${udid}/stream?token=${token}&codec=h264`);
      const t = setTimeout(() => reject(new Error('no picture')), 5000);
      ws.on('message', (_d, isBinary) => {
        if (!isBinary) return;
        clearTimeout(t);
        resolve(ws);
      });
      ws.on('error', reject);
    });
  const [a, b] = (await phones()).map((p) => p.udid as string);
  try {
    assert.deepEqual((await phones()).map((p) => p.capturing), [false, false, false], 'GET /phones says whether each capture runs: none at the start');

    // what used to start it ahead of a viewer starts nothing now: the focus, a warm-up, a control socket, the watch
    const f = await post(`/phones/${a}/focus`);
    assert.deepEqual([f.status, f.body.capture], [200, 'off']);
    assert.equal((await post(`/phones/${a}/warm`)).body.capture, 'off');
    const ctl = new WebSocket(`ws://${host}/phones/${a}/control?token=${token}`);
    await new Promise((r) => ctl.once('open', r));
    await sleep(200); // several watch ticks with the focused phone attached and unviewed
    assert.equal(await capturing(a!), false, 'the focus, POST /warm, a control socket and the watch start no capture');
    assert.equal(backend.capturing(a!), false);

    // the first viewer starts it
    const v1 = await view(a!);
    assert.equal(await capturing(a!), true, 'running under its first viewer');
    assert.equal(await capturing(b!), false, 'only that phone');
    // a second viewer shares it; the first leaving changes nothing
    const v2 = await view(a!);
    v1.close();
    await sleep(GRACE + 150);
    assert.equal(await capturing(a!), true, 'still running: a viewer is left');
    // the last one leaves: kept for the grace (a page redrawing), then stopped completely
    v2.close();
    await sleep(GRACE / 3);
    assert.equal(await capturing(a!), true, 'within the grace time');
    assert.ok(await until(async () => !(await capturing(a!)), GRACE + 1000), 'stopped after the grace time');
    await sleep(200);
    assert.equal(backend.capturing(a!), false, 'and it stays stopped: nothing keeps it warm (the control socket is still open)');

    // a view reopened within the grace finds it up; switching the focus never stops a watched phone's capture
    const v3 = await view(a!);
    v3.close();
    await sleep(GRACE / 3);
    const v4 = await view(a!);
    assert.equal((await post(`/phones/${b}/focus`)).status, 200);
    await sleep(120);
    assert.equal(await capturing(a!), true, 'another phone in focus: this one keeps its picture for its viewer');
    assert.equal(await capturing(b!), false, 'and the focused one has none until someone views it');
    v4.close();
    ctl.close();
    assert.ok(await until(async () => !(await capturing(a!)), GRACE + 1000));
    ok('capture: starts with the first viewer, shared, stops after the grace when the last one leaves; the focus, /warm, a control socket and the watch start none');

    // ---- the agent works from stills: none of its reads or actions starts (or needs) a capture ----
    const started: string[] = [];
    const h264 = backend.h264.bind(backend);
    backend.h264 = (u, w) => {
      started.push(u);
      return h264(u, w);
    };
    assert.equal((await get(`/phones/${b}/screenshot`)).status, 200);
    assert.equal((await get(`/phones/${b}/screenshot?format=jpeg`)).status, 200);
    assert.equal((await get(`/phones/${b}/ui`)).status, 200);
    assert.equal((await get(`/phones/${b}/info`)).status, 200);
    assert.equal((await get(`/phones/${b}/apps`)).status, 200);
    const tap = await post(`/phones/${b}/tap`, { x: 0.5, y: 0.5 }); // with the look before and after
    assert.deepEqual([tap.status, tap.body.ok, typeof tap.body.changed], [200, true, 'boolean']);
    const act = await post(`/phones/${b}/act`, { steps: [{ type: 'home' }, { type: 'swipe', x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2 }, { type: 'wait', ms: 20 }] });
    assert.deepEqual([act.status, act.body.ok], [200, true]);
    assert.equal((await post(`/phones/${b}/wake`)).status, 200);
    assert.equal((await post(`/phones/${b}/type`, { text: 'hi' })).status, 200);
    assert.deepEqual(started, [], 'no capture was asked for by any read or action');
    assert.equal(backend.capturing(b!), false);
    assert.equal(await capturing(b!), false);
    ok('agent: screenshots, the UI tree, info, apps, a tap with its look, a batch, wake and typing never start a capture');
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
}

// ---- stills are WDA's own screenshots ----
{
  // a JPEG header that says 390 x 844, and a PNG one
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]), Buffer.from([0x03, 0x4c, 0x01, 0x86]), Buffer.alloc(16)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8), Buffer.from([0, 0, 1, 0x86, 0, 0, 3, 0x4c]), Buffer.alloc(8)]);
  const asked: string[] = [];
  const stock: StillSource = {
    mjpeg: async (age, wait) => (asked.push(`mjpeg ${age} ${wait}`), jpeg),
    png: async () => (asked.push('png'), png),
    orientation: () => 'portrait',
  };
  // a stock WDA: a JPEG still is a frame of WDA's own MJPEG server; a PNG its screenshot
  assert.deepEqual(await still(stock, 'jpeg'), { data: jpeg, contentType: 'image/jpeg' });
  assert.deepEqual(await still(stock, 'png'), { data: png, contentType: 'image/png' });
  assert.deepEqual(asked, ['mjpeg 0 5000', 'png']);
  // a frame that's sideways for how the phone is turned (an older WDA): the PNG, which WDA turns itself
  assert.equal((await still({ ...stock, orientation: () => 'landscape-left' }, 'jpeg')).contentType, 'image/png');
  // no frame in time: the PNG, never an error
  assert.equal((await still({ ...stock, mjpeg: async () => null }, 'jpeg')).contentType, 'image/png');
  // a WDA without the MJPEG server (our fork): everything is its PNG screenshot
  asked.length = 0;
  const fork: StillSource = { ...stock, mjpeg: null };
  assert.equal((await still(fork, 'jpeg')).contentType, 'image/png');
  const h1 = await stillHash(fork);
  assert.deepEqual(asked, ['png', 'png']);
  assert.match(h1!, /^[0-9a-f]{16}$/);
  assert.equal(await stillHash(fork), h1, 'the same screen, the same hash');
  assert.notEqual(await stillHash(stock), h1, 'another picture, another hash');
  assert.equal(await stillHash({ ...fork, png: async () => Promise.reject(new Error('WDA is down')) }), null, 'no still: null, never a throw');
  // and nothing in the stills path or the agent knows the capture: by construction (their sources never name it)
  const src = (f: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', f), 'utf8');
  for (const f of ['stills.ts', 'agent.ts', 'ui.ts', 'dark.ts']) {
    assert.ok(!/h264|phonecap|H264Source|\.capturing\(/i.test(src(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${f} never touches the capture`);
  }
  ok('stills: a JPEG is WDA\'s MJPEG frame (stock) or its PNG, a hash comes from the same, a WDA without MJPEG gives PNG only; the agent\'s code never names the capture');
}

console.log(`\nall ${passed} capture checks passed`);
