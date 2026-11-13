// Input (docs/BEST_METHOD.md): live touch straight to the phone (CoreDevice HID) with buffered fallback, the HID
// sidecar's protocol and failure handling, the WDA fast-route patch, latency metering and the acks' extra fields.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import { ChildProcess, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Control } from '../src/control.js';
import { HidHost, hidTypable, iosMajor, toHid } from '../src/hid.js';
import { InputMeter } from '../src/inputlog.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import type { Backend, PathPoint } from '../src/types.js';
// @ts-expect-error a plain .mjs script (no types)
import { isPatched, patchSource, unpatch } from '../scripts/patch-wda.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a backend that records what reached the "phone" ----
function fakeBackend(live: boolean, failLive: (phase: string) => boolean = () => false) {
  const calls: string[] = [];
  const b = {
    mock: true,
    screen: () => ({ width: 390, height: 844, scale: 3 }),
    tap: async (_u: string, x: number, y: number) => {
      calls.push(`tap ${x},${y}`);
      return { via: 'wda-fast' as const };
    },
    gesture: async (_u: string, pts: PathPoint[]) => {
      calls.push(`gesture ${pts.length}`);
      return { via: 'wda-fast' as const };
    },
    type: async () => ({ via: 'wda' as const }),
    home: async () => ({ via: 'wda' as const }),
    launch: async () => ({ via: 'wda' as const }),
    recover: async () => 'ready' as const,
    liveTouchReady: () => live,
    liveTouch: async (_u: string, phase: string, x: number, y: number) => {
      if (failLive(phase)) throw new Error(`live ${phase} failed`);
      calls.push(`${phase} ${Math.round(x)},${Math.round(y)}`);
      await sleep(phase === 'move' ? 5 : 0);
      return { via: 'hid' as const };
    },
  } as unknown as Backend;
  return { b, calls };
}

// ---- live touch: down/move/up reach the phone as they come; moves never pile up ----
{
  const { b, calls } = fakeBackend(true);
  const c = new Control(b);
  const owner = {};
  const r1 = await c.handle('P', { type: 'touch', phase: 'down', x: 10, y: 20, t: 0 }, owner);
  assert.deepEqual(r1, { via: 'hid' });
  const moves = [];
  for (let i = 1; i <= 6; i++) moves.push(c.handle('P', { type: 'touch', phase: 'move', x: 10 + i, y: 20 + i, t: i * 16 }, owner));
  await Promise.all(moves);
  const r2 = await c.handle('P', { type: 'touch', phase: 'up', x: 40, y: 50, t: 200 }, owner);
  assert.deepEqual(r2, { via: 'hid' });
  assert.equal(calls[0], 'down 10,20');
  assert.equal(calls[calls.length - 1], 'up 40,50');
  const mv = calls.filter((x) => x.startsWith('move'));
  assert.ok(mv.length >= 1 && mv.length < 6, `moves folded while one waits (${mv.length} of 6)`);
  assert.equal(mv[mv.length - 1], 'move 16,26', 'the latest move point wins');
  assert.ok(!calls.some((x) => x.startsWith('gesture') || x.startsWith('tap')), 'nothing replayed');
  const st = c.meter.stats('P');
  assert.equal(st.via, 'hid');
  assert.ok(st.tap_avg_ms !== null && st.tap_avg_ms < 50, 'touch-down counted as a tap');
  ok(`live touch: down, ${mv.length} folded move(s), up straight to the phone (via hid, ${st.tap_avg_ms} ms)`);
}

// ---- a live event fails: the rest is buffered and the gesture replayed whole by the other route ----
{
  const { b, calls } = fakeBackend(true, (phase) => phase === 'move');
  const c = new Control(b);
  await c.handle('P', { type: 'touch', phase: 'down', x: 10, y: 20, t: 0 });
  assert.deepEqual(await c.handle('P', { type: 'touch', phase: 'move', x: 100, y: 200, t: 50 }), { via: 'buffered' });
  await c.handle('P', { type: 'touch', phase: 'move', x: 150, y: 300, t: 100 });
  const r = await c.handle('P', { type: 'touch', phase: 'up', x: 200, y: 400, t: 300 });
  assert.deepEqual(r, { via: 'wda-fast' });
  assert.deepEqual(calls, ['down 10,20', 'gesture 4']);
  ok('live touch failing mid-drag: the whole gesture replays through WDA');
}

// ---- without a live channel: buffered as before (a quick still press is a tap) ----
{
  const { b, calls } = fakeBackend(false);
  const c = new Control(b);
  await c.handle('P', { type: 'touch', phase: 'down', x: 5, y: 6, t: 0 });
  await c.handle('P', { type: 'touch', phase: 'move', x: 6, y: 6, t: 40 });
  assert.deepEqual(await c.handle('P', { type: 'touch', phase: 'up', x: 6, y: 7, t: 80 }), { via: 'wda-fast' });
  assert.deepEqual(calls, ['tap 5,6']);
  assert.deepEqual(await c.handle('P', { type: 'tap', x: 1, y: 2 }), { via: 'wda-fast' });
  ok('no live channel: touches buffered, a quick press goes as one tap');
}

// ---- a viewer leaving mid-press lifts the finger on the phone ----
{
  const { b, calls } = fakeBackend(true);
  const c = new Control(b);
  const owner = {};
  await c.handle('P', { type: 'touch', phase: 'down', x: 10, y: 20 }, owner);
  c.release(owner);
  await sleep(20);
  assert.deepEqual(calls, ['down 10,20', 'up 10,20']);
  ok('release: a live finger still down is lifted');
}

// ---- the meter ----
{
  const m = new InputMeter(false);
  for (const ms of [10, 20, 30, 40, 200]) m.add('P', { at: 0, type: 'tap', via: 'hid', ok: true, wait_ms: 0, inject_ms: ms, total_ms: ms });
  m.add('P', { at: 0, type: 'swipe', via: 'wda', ok: false, wait_ms: 1, inject_ms: 2, total_ms: 3, error: 'x' });
  const s = m.stats('P');
  assert.equal(s.tap_avg_ms, 60);
  assert.equal(s.tap_p90_ms, 200);
  assert.equal(s.via, 'wda');
  assert.equal(s.samples, 6);
  ok('meter: tap average / p90 from the taps, last action, samples');
}

// ---- HID helpers ----
{
  const s = { width: 390, height: 844, scale: 3 };
  assert.deepEqual(toHid(0, 0, s), [0, 0]);
  assert.deepEqual(toHid(195, 422, s), [32768, 32768]);
  assert.deepEqual(toHid(390, 844, s), [65535, 65535]);
  assert.deepEqual(toHid(-5, 9999, s), [0, 65535]);
  assert.equal(iosMajor('27.0.1'), 27);
  assert.equal(iosMajor('18.5'), 18);
  assert.equal(iosMajor(''), 0);
  assert.ok(hidTypable('Hello, world!\n\t~'));
  assert.ok(!hidTypable('héllo'));
  ok('HID: points -> 0..65535, iOS major, typable text');
}

// ---- HidHost against a scripted fake sidecar: open, input, idle close, exit, fatal ----
type Fake = ChildProcess & EventEmitter & { lines: Record<string, unknown>[]; out: PassThrough };
function fakeSidecar(answer: (m: Record<string, unknown>, out: PassThrough) => void) {
  const procs: Fake[] = [];
  const spawnFn = () => {
    const proc = new EventEmitter() as Fake;
    const stdin = new PassThrough();
    const out = new PassThrough();
    Object.assign(proc, { stdin, stdout: out, stderr: new PassThrough(), lines: [], out });
    proc.kill = () => {
      setImmediate(() => proc.emit('exit', null));
      return true;
    };
    let buf = '';
    stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        proc.lines.push(m);
        answer(m, out);
      }
    });
    procs.push(proc);
    return proc;
  };
  return { procs, spawnFn };
}
{
  const { procs, spawnFn } = fakeSidecar((m, out) => out.write(`${JSON.stringify({ id: m.id, ok: true, ms: 0.5 })}\n`));
  const logs: string[] = [];
  const h = new HidHost('00008110-0008185134F9401E', { python: 'py', script: 's.py', idleMs: 60, retryMs: 50, spawn: spawnFn, log: (l) => logs.push(l) });
  assert.equal(h.ready(), false);
  await assert.rejects(h.input('tap', { x: 1, y: 2 }), /HID is off/);
  const release = h.hold();
  await sleep(10);
  assert.equal(h.state, 'ready');
  const r = await h.input('tap', { x: 100, y: 200 });
  assert.equal(r.ok, true);
  assert.deepEqual(procs[0]!.lines.map((l) => l.op), ['open', 'tap']);
  assert.equal(procs[0]!.lines[1]!.x, 100);
  await sleep(100);
  assert.equal(h.state, 'ready', 'held: no idle close');
  release();
  await sleep(100);
  assert.equal(h.state, 'off', 'released: idle close');
  assert.equal(procs[0]!.lines[procs[0]!.lines.length - 1]!.op, 'close');
  // the helper dies: failed, then retried after the back-off
  procs[0]!.emit('exit', 1);
  assert.equal(h.state, 'failed');
  assert.equal(h.usable(), false);
  await sleep(60);
  assert.equal(h.usable(), true);
  await h.open();
  assert.equal(procs.length, 2, 'a new helper process');
  assert.equal(h.state, 'ready');
  h.close();
  assert.ok(logs.some((l) => l.includes('[hid 34F9401E]')));
  ok('HidHost: opens on hold, inputs on the open session, idle close, helper exit -> back-off -> reopen');
}
{
  const { spawnFn } = fakeSidecar((_m, out) => out.write(`${JSON.stringify({ ev: 'fatal', error: 'pymobiledevice3 with core-device HID is not installed' })}\n`));
  const h = new HidHost('X', { python: 'py', script: 's.py', idleMs: 1000, retryMs: 60000, spawn: spawnFn, log: () => {} });
  h.kick();
  await sleep(10);
  assert.equal(h.state, 'failed');
  assert.match(h.reason ?? '', /not installed/);
  h.close();
  ok('HidHost: a helper without pymobiledevice3 -> failed with the reason (WDA takes the input)');
}

// ---- the real sidecar (--mock: no phone, no pymobiledevice3), when this machine has Python ----
{
  const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version'], { stdio: 'ignore' }).status === 0);
  if (!py) console.log('skip - real HID sidecar (no Python here)');
  else {
    const h = new HidHost('MOCK', {
      python: py, script: path.join(ROOT, 'native', 'hid', 'hid_input.py'), extraArgs: ['--mock'], idleMs: 5000, retryMs: 1000, log: () => {},
    });
    await h.open();
    for (const op of ['down', 'move', 'up', 'tap'] as const) {
      const r = await h.input(op, { x: 32768, y: 30000 });
      assert.equal(r.ok, true);
      assert.ok(typeof r.ms === 'number' && r.ms < 50, `${op} answered in ${r.ms} ms`);
    }
    assert.equal((await h.input('path', { points: [[0, 0, 0], [100, 100, 20]] })).ok, true);
    assert.equal((await h.input('type', { text: 'Hi' })).ok, true);
    await assert.rejects(h.input('type', { text: 'é' }), /unsupported character/);
    h.close();
    ok(`real HID sidecar (${py} --mock): down/move/up/tap/path/type answered, non-ASCII refused`);
  }
}

// ---- the WDA patch: adds the route and its handler, idempotent, reversible, replaces an older version ----
{
  const src = [
    '#import "FBCustomCommands.h"',
    '',
    '#import "FBRoute.h"',
    '#if !TARGET_OS_TV',
    '#import "Something.h"',
    '#endif',
    '',
    '@implementation FBCustomCommands',
    '',
    '+ (NSArray *)routes',
    '{',
    '  return',
    '  @[',
    '    [[FBRoute POST:@"/timeouts"] respondWithTarget:self action:@selector(handleTimeouts:)],',
    '  ];',
    '}',
    '',
    '@end',
    '',
  ].join('\n');
  const p = patchSource(src);
  assert.ok(isPatched(p));
  assert.match(p, /\[\[FBRoute POST:@"\/wda\/lotus\/touch"\]\.withoutSession respondWithTarget:self action:@selector\(handleLotusTouch:\)\]/);
  assert.match(p, /\+ \(id<FBResponsePayload>\)handleLotusTouch:\(FBRouteRequest \*\)request/);
  assert.ok(p.indexOf('static NSMutableArray *LotusTouchQueue') < p.indexOf('@implementation'), 'statics before the class');
  assert.ok(p.indexOf('#endif\n\n// >>> LOTUS') > 0 || p.indexOf('// >>> LOTUS') > p.indexOf('#import "Something.h"\n#endif'), 'imports outside the #if');
  assert.ok(p.indexOf('handleLotusTouch:(FBRouteRequest') < p.lastIndexOf('@end'), 'handler inside the class');
  assert.equal(patchSource(p), p, 'idempotent');
  assert.equal(unpatch(p), src, 'reversible');
  const crlf = src.replace(/\n/g, '\r\n');
  assert.equal(unpatch(patchSource(crlf).replace(/\r\n/g, '\n')), src);
  assert.ok(!/[^\r]\n/.test(patchSource(crlf)), 'keeps CRLF');
  const older = p.replace(/LOTUS_FAST_TOUCH v1/g, 'LOTUS_FAST_TOUCH v0');
  assert.ok(!isPatched(older));
  assert.equal(patchSource(older), p, 'an older version is replaced');
  ok('WDA patch: /wda/lotus/touch route + handler, idempotent, reversible, upgrades an older one');
}

// ---- WDA: the fast route when the build has it, the old route when it doesn't (or refuses), landscape -> old ----
{
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { WdaManager } = await import('../src/wda.js');
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wda-'))); // data/ports.json goes here
  let mode: 'patched' | 'unpatched' | 'refuse' = 'unpatched';
  let size = { width: 390, height: 844 };
  const hits: { path: string; body: any }[] = [];
  const wda = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = req.url ?? '';
      hits.push({ path: p, body: body ? JSON.parse(body) : null });
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (p === '/status') return json(200, { value: { ready: true }, sessionId: 'S1' });
      if (p === '/session') return json(200, { sessionId: 'S1', value: { sessionId: 'S1' } });
      if (p.endsWith('/window/size')) return json(200, { value: size });
      if (p === '/wda/screen') return json(200, { value: { scale: 3 } });
      if (p.endsWith('/appium/settings')) return json(200, { value: {} });
      if (p === '/wda/lotus/touch') {
        if (mode === 'unpatched') return json(404, { value: { error: 'unknown command', message: 'Unhandled endpoint: /wda/lotus/touch' } });
        if (mode === 'refuse') return json(400, { value: { error: 'invalid argument', message: 'nope' } });
        return json(200, { value: { queued: 1, lotus: 1 } });
      }
      if (p.endsWith('/wda/tap') || p.endsWith('/actions')) return json(200, { value: null });
      json(404, { value: { error: 'unknown command', message: p } });
    });
  });
  await new Promise<void>((r) => wda.listen(0, '127.0.0.1', r));
  const port = (wda.address() as AddressInfo).port;
  const fakeSpawn = (() => {
    const p = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    return p;
  }) as unknown as typeof import('node:child_process').spawn;
  const cfg = { wdaBasePort: port, mjpegBasePort: port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  const origLog = console.log;
  console.log = () => {};
  const m = new WdaManager(cfg, (u) => u, fakeSpawn);
  try {
    m.start('U1');
    for (let i = 0; i < 40 && m.state('U1') !== 'ready'; i++) await sleep(50);
    assert.equal(m.state('U1'), 'ready');
    const count = (p: string) => hits.filter((h) => h.path === p).length;

    assert.equal(await m.tap('U1', 10, 20), 'wda', 'unpatched: the old route');
    assert.equal(m.fastStatus('U1'), 'no');
    assert.equal(await m.tap('U1', 10, 20), 'wda');
    assert.equal(count('/wda/lotus/touch'), 1, 'an unpatched build is asked once');
    assert.equal(count('/session/S1/wda/tap'), 2);

    // a rebuilt (patched) runner: WDA restarts -> asked again
    mode = 'patched';
    (m as any).entries.get('U1').fast = 'unknown';
    assert.equal(await m.tap('U1', 10.04, 20), 'wda-fast');
    const sent = hits.filter((h) => h.path === '/wda/lotus/touch').pop()!.body;
    assert.deepEqual(sent, { points: [[10, 20, 0]], hold: 50, orientation: 1 });
    assert.equal(await m.actions('U1', [[1, 2, 0], [3, 4, 120]]), 'wda-fast');
    assert.deepEqual(hits.filter((h) => h.path === '/wda/lotus/touch').pop()!.body.points, [[1, 2, 0], [3, 4, 120]]);
    assert.equal(m.fastStatus('U1'), 'yes');
    assert.equal(count('/session/S1/wda/tap'), 2, 'no old-route taps');

    // the route refuses: each falls back; after 3 in a row it's left alone
    mode = 'refuse';
    for (let i = 0; i < 3; i++) assert.equal(await m.tap('U1', 1, 1), 'wda');
    assert.equal(m.fastStatus('U1'), 'no');
    assert.equal(count('/session/S1/wda/tap'), 5);

    // landscape: the old route (it knows the orientation)
    mode = 'patched';
    (m as any).entries.get('U1').fast = 'unknown';
    (m as any).entries.get('U1').screen = { width: 844, height: 390, scale: 3 };
    const before = count('/wda/lotus/touch');
    assert.equal(await m.tap('U1', 1, 1), 'wda');
    assert.equal(count('/wda/lotus/touch'), before);
  } finally {
    console.log = origLog;
    m.shutdown();
    wda.closeAllConnections();
    wda.close();
    process.chdir(prevCwd);
  }
  ok('WDA: fast route when patched (answered when queued), old route when unpatched (asked once), refused x3, or landscape');
}

// ---- the server: acks and HTTP answers say how it went; GET /phones/:udid/input ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(1);
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}` };
  const udid = (await (await fetch(`${base}/phones`, { headers: auth })).json())[0].udid as string;
  const tap = await (await fetch(`${base}/phones/${udid}/tap`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"x":10,"y":20}' })).json();
  assert.equal(tap.ok, true);
  assert.equal(tap.via, 'mock');
  assert.equal(typeof tap.ms, 'number');
  const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/phones/${udid}/control?token=${token}`);
    const t = setTimeout(() => reject(new Error('no ack')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, type: 'tap', x: 5, y: 5 })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type !== 'ack') return;
      clearTimeout(t);
      ws.close();
      resolve(m);
    });
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.via, 'mock');
  assert.equal(typeof ack.ms, 'number');
  const inp = await (await fetch(`${base}/phones/${udid}/input`, { headers: auth })).json();
  assert.equal(inp.samples, 2);
  assert.equal(inp.recent.length, 2);
  assert.equal(inp.methods.hid, 'unsupported');
  const phones = await (await fetch(`${base}/phones`, { headers: auth })).json();
  assert.equal(phones[0].stats.input.samples, 2);
  assert.ok(phones[0].stats.input.methods);
  server.closeAllConnections();
  server.close();
  await backend.close();
  ok('server: acks/answers carry via + ms; GET /phones/:udid/input; stats.input in GET /phones');
}

console.log(`\nall ${passed} input checks passed`);
