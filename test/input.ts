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
import { IdleLock } from '../src/idle.js';
import { ActorBusy, actorsFor, PhoneActor } from '../src/phone/actor.js';
import { Budgeted, isVideoApp } from '../src/phone/look.js';
import { HidHost, hidTypable, iosMajor, toHid } from '../src/hid.js';
import { InputMeter } from '../src/inputlog.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import { HttpError } from '../src/types.js';
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

// ---- the live down never reaches the phone: the gesture is buffered and replayed whole by the other route ----
{
  const { b, calls } = fakeBackend(true, (phase) => phase === 'down');
  const c = new Control(b);
  const d = await c.handle('P', { type: 'touch', phase: 'down', x: 10, y: 20, t: 0 });
  assert.equal(d?.via, 'buffered');
  assert.match(d?.reason ?? '', /live touch failed \(live down failed\)/);
  assert.equal((await c.handle('P', { type: 'touch', phase: 'move', x: 100, y: 200, t: 50 }))?.via, 'buffered');
  await c.handle('P', { type: 'touch', phase: 'move', x: 150, y: 300, t: 100 });
  const r = await c.handle('P', { type: 'touch', phase: 'up', x: 200, y: 400, t: 300 });
  assert.equal(r?.via, 'wda-fast');
  assert.match(r?.reason ?? '', /live touch failed/, 'the fallback says why');
  assert.deepEqual(calls, ['gesture 4']);
  assert.equal(c.meter.stats('P').touch.fallbacks, 1);
  ok('live touch whose down fails: the whole gesture replays through WDA, with the reason');
}

// ---- the live channel breaks mid-drag: the finger is lifted and the failure said; nothing is played twice ----
{
  const { b, calls } = fakeBackend(true, (phase) => phase === 'move');
  const c = new Control(b);
  const told: unknown[] = [];
  const owner = { touchReleased: (info: unknown) => told.push(info) };
  await c.handle('P', { type: 'touch', phase: 'down', x: 10, y: 20, t: 0, seq: 1, id: 7 }, owner);
  await assert.rejects(c.handle('P', { type: 'touch', phase: 'move', x: 100, y: 200, t: 50, seq: 2, id: 7 }, owner), /lost mid-drag \(live move failed\)/);
  assert.deepEqual(await c.handle('P', { type: 'touch', phase: 'move', x: 150, y: 300, t: 100, seq: 3, id: 7 }, owner), { via: 'buffered', stray: true });
  assert.deepEqual(await c.handle('P', { type: 'touch', phase: 'up', x: 200, y: 400, t: 300, seq: 4, id: 7 }, owner), { via: 'buffered', stray: true });
  await sleep(10);
  assert.deepEqual(calls, ['down 10,20', 'up 100,200'], 'lifted where it was, no replay');
  assert.deepEqual(told, [{ id: 7, reason: 'lost', error: 'live move failed' }]);
  ok('live touch lost mid-drag: lifted, its owner told, never played twice');
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
  const c = new Control(b, undefined, { ownerGraceMs: 0 }) // no grace for another link to carry it on (test/drag.ts has that);
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
  const size = { width: 390, height: 844 };
  let orient = 'PORTRAIT';
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
      if (p.endsWith('/orientation')) return json(200, { value: orient });
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

    // the phone turns: Lotus's own read asks WDA (2026-11-22: nobody else does), the screen is upright (wide), and the
    // old route takes the touch (it turns it itself)
    mode = 'patched';
    (m as any).entries.get('U1').fast = 'unknown';
    assert.deepEqual([m.orientation('U1'), m.screen('U1')], ['portrait', { width: 390, height: 844, scale: 3 }]);
    const turns: string[] = [];
    m.onOrientation = (u) => turns.push(`${u} ${m.orientation(u)}`);
    orient = 'LANDSCAPE';
    assert.equal(await m.refreshOrientation('U1', 0), 'portrait', "not asked: only Lotus's own explicit read asks the phone");
    assert.equal(count('/session/S1/orientation'), 0, 'the app in front was never asked how it is turned');
    assert.equal(await m.refreshOrientation('U1', 0, true), 'landscape-left');
    assert.equal(await m.refreshOrientation('U1', 60_000, true), 'landscape-left', 'asked a moment ago: not again yet');
    assert.equal(count('/session/S1/orientation'), 1);
    assert.deepEqual(m.screen('U1'), { width: 844, height: 390, scale: 3 });
    assert.deepEqual(turns, ['U1 landscape-left']);
    const before = count('/wda/lotus/touch');
    assert.equal(await m.tap('U1', 1, 1), 'wda');
    assert.equal(count('/wda/lotus/touch'), before);
    // WDA_FAST_LANDSCAPE=1: the fast route too, the touch turned onto the panel for XCTest's portrait record
    process.env.WDA_FAST_LANDSCAPE = '1';
    assert.equal(await m.tap('U1', 1, 1), 'wda-fast');
    assert.deepEqual(hits.filter((h) => h.path === '/wda/lotus/touch').pop()!.body, { points: [[389, 1, 0]], hold: 50, orientation: 1 });
    delete process.env.WDA_FAST_LANDSCAPE;
    orient = 'UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT';
    assert.equal(await m.refreshOrientation('U1', 0, true), 'landscape-right');
    orient = 'PORTRAIT';
    assert.equal(await m.refreshOrientation('U1', 0, true), 'portrait');
    assert.deepEqual(m.screen('U1'), { width: 390, height: 844, scale: 3 });
    assert.equal(turns.length, 3);
    assert.equal(hits.filter((h) => h.path.endsWith('/appium/settings')).pop()!.body.settings.mjpegFixOrientation, true, 'MJPEG frames are turned upright by WDA');
  } finally {
    console.log = origLog;
    m.shutdown();
    wda.closeAllConnections();
    wda.close();
    process.chdir(prevCwd);
  }
  ok('WDA: fast route when patched (answered when queued), old route when unpatched (asked once), refused x3, or landscape; orientation followed');
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

// ---- the phone's actor (2026-11-27, docs/root-cause.md 13.3c): one typed queue, the lease, deadlines ----
{
  const log: string[] = [];
  const a = new PhoneActor('A1', { ownerQuietMs: 120, ownerWaitMs: 400, reserveMs: 0, log: () => {} });
  const job = (kind: 'input' | 'look' | 'power' | 'system', label: string, ms: number, extra: Record<string, unknown> = {}) =>
    a.submit({
      kind, label, ...extra,
      run: async () => {
        log.push(`${label} start`);
        await sleep(ms);
        log.push(`${label} end`);
        return label;
      },
    });
  // a look already on the phone never holds an input back (input never waits behind a look)
  const look = job('look', 'look1', 150);
  await sleep(10);
  const tap = job('input', 'tap1', 10);
  await tap;
  assert.ok(log.includes('tap1 end') && !log.includes('look1 end'), `the input went beside the look: ${log.join(', ')}`);
  await look;
  // looks (and power) wait for every queued input; power goes before looks
  log.length = 0;
  const i1 = job('input', 'tap2', 60);
  const l2 = job('look', 'look2', 5);
  const p2 = job('power', 'lock', 5);
  const i3 = job('input', 'tap3', 30);
  await Promise.all([i1, l2, p2, i3]);
  assert.deepEqual(log, ['tap2 start', 'tap2 end', 'tap3 start', 'tap3 end', 'lock start', 'lock end', 'look2 start', 'look2 end']);
  ok('actor: input never waits behind a look; looks and power wait for queued input; power before looks');

  // deadlines: one that can't start in time is refused at once, busy; one that runs past its deadline is a 504
  const long = job('input', 'long', 200);
  await assert.rejects(job('input', 'late', 5, { startWithinMs: 50 }), (e: HttpError) => e instanceof ActorBusy && e.status === 503 && e.extra?.state === 'busy');
  await assert.rejects(job('input', 'past', 5, { deadlineEpoch: Date.now() - 1 }), (e: HttpError) => e.status === 503 && /deadline had passed/.test(e.message));
  await long;
  await assert.rejects(job('input', 'hung', 500, { timeoutMs: 50 }), (e: HttpError) => e.status === 504 && /got no answer/.test(e.message));
  // a job inside a job of the same phone is part of its turn (it would wait on itself if queued)
  const nested = await a.submit({ kind: 'input', label: 'outer', run: () => a.submit({ kind: 'power', label: 'inner', run: async () => 'inner ran' }) });
  assert.equal(nested, 'inner ran');
  ok('actor: refused at once when it cannot start in time (503 busy) or its deadline passed; 504 past its deadline; nested jobs run in their turn');
}

// ---- the lease: the owner pre-empts a hand; system work waits for Free ----
{
  const a = new PhoneActor('A2', { ownerQuietMs: 150, ownerWaitMs: 400, reserveMs: 0, handIdleMs: 100, log: () => {} });
  assert.deepEqual(a.lease(), { kind: 'free' });
  a.ownerInput();
  assert.equal(a.lease().kind, 'owner');
  // a hand's input waits until the owner has been quiet ownerQuietMs
  const t0 = performance.now();
  await a.submit({ kind: 'input', label: 'hand tap', who: { hand: 'poster' }, run: async () => {} });
  assert.ok(performance.now() - t0 >= 120, `the hand paused for the owner (${Math.round(performance.now() - t0)} ms)`);
  assert.deepEqual([a.lease().kind, (a.lease() as { id?: string }).id], ['hand', 'poster']);
  // the owner keeps touching: the hand gives up after ownerWaitMs (409, nothing done)
  const keep = setInterval(() => a.ownerInput(), 30);
  a.ownerInput();
  let ran = false;
  await assert.rejects(a.submit({ kind: 'input', label: 'hand tap', who: { hand: 'poster' }, run: async () => void (ran = true) }), (e: HttpError) => e.status === 409);
  clearInterval(keep);
  assert.equal(ran, false);
  // the owner's own input never waits for anyone
  const t1 = performance.now();
  await a.submit({ kind: 'input', label: 'owner tap', who: { owner: true }, run: async () => {} });
  assert.ok(performance.now() - t1 < 50);
  // system work: not while anyone drives the phone; once Free, it holds the lease
  assert.equal(a.trySystem('resign'), null, 'the owner was just here');
  const sys = a.acquireSystem('resign', 2000);
  await sleep(50);
  assert.notEqual(a.lease().kind, 'system');
  const release = await sys;
  assert.deepEqual([a.lease().kind, (a.lease() as { op?: string }).op], ['system', 'resign']);
  assert.equal(a.trySystem('fork'), null, 'one system op at a time');
  release();
  assert.deepEqual(a.lease(), { kind: 'free' });
  // a hand holding the phone (a batch) keeps it Hand, and system work waits
  const hold = a.holdHand('poster');
  assert.equal(a.lease().kind, 'hand');
  await assert.rejects(a.acquireSystem('selftest', 100), (e: HttpError) => e instanceof ActorBusy);
  hold();
  await sleep(120);
  assert.ok(a.trySystem('selftest'));
  ok('lease: Free, Owner, Hand(id), System(op); the owner pre-empts a hand (409 when he keeps on); system waits for Free');
}

// ---- the idle lock takes the system lease: a phone someone drives is never locked under them ----
{
  const calls: string[] = [];
  const b = {
    mock: true,
    list: async () => [],
    lock: async () => void calls.push('lock'),
    unlock: async (_u: string, o?: { explicit?: boolean }) => void calls.push(`unlock explicit=${!!o?.explicit}`),
    isLocked: async () => null,
  } as unknown as Backend;
  let now = 1_000_000;
  const idle = new IdleLock(b, () => 1, { tickMs: 0, log: () => {}, now: () => now, devices: async () => ['P'] });
  await idle.tick();
  now += 2 * 60_000;
  const actor = actorsFor(b).of('P');
  const release = actor.holdHand('poster');
  assert.deepEqual(await idle.tick(), [], 'an agent drives it: not locked');
  release();
  actor.tune({ handIdleMs: 0 });
  assert.deepEqual(await idle.tick(), ['P'], 'Free: locked');
  assert.deepEqual(calls, ['lock']);
  assert.equal(idle.state('P').power?.state, 'locked');
  // a picture's wake (automatic) on a phone that can't say: never the explicit unlock, never a guess
  calls.length = 0;
  idle.power.forget('P');
  await idle.wakeForPicture('P', true);
  assert.deepEqual(calls, ['unlock explicit=false']);
  // the owner's own wake (POST /wake): explicit
  calls.length = 0;
  await idle.wake('P');
  assert.deepEqual(calls, ['unlock explicit=true']);
  idle.close();
  ok('idle lock: takes the system lease (skipped while a hand drives the phone); automatic wakes are never explicit');
}

// ---- looks: single-flight, coalesced, budgeted on a video app, cancellable ----
{
  let reads = 0;
  let video = false;
  const looks = new Budgeted<number>(async () => (await sleep(40), ++reads), { gapMs: () => (video ? 300 : 0) });
  const [a1, a2, a3] = await Promise.all([looks.get('P'), looks.get('P'), looks.get('P')]);
  assert.equal(reads, 1, 'single-flight: three askers, one read');
  assert.deepEqual([a1!.value, a2!.value, a3!.value], [1, 1, 1]);
  assert.equal((await looks.get('P', { maxAgeMs: 1000 }))!.value, 1, 'coalesced: a fresh enough read is given again');
  assert.equal(reads, 1);
  video = true;
  assert.equal((await looks.get('P'))!.value, 1, 'a video app: the read 40 ms ago is within the gap, so it is given (stale)');
  await sleep(320);
  assert.equal((await looks.get('P'))!.value, 2);
  const stale = await looks.get('P', { waitMs: 0 });
  assert.deepEqual([stale!.value, stale!.stale, reads], [2, true, 2], 'over the budget: the last read, marked stale');
  const t0 = performance.now();
  assert.equal((await looks.get('P', { waitMs: 1000 }))!.value, 3, 'or it waits for the budget');
  assert.ok(performance.now() - t0 >= 200);
  // a caller that gives up stops waiting, and a read nobody waits for is never sent
  video = false;
  const ac = new AbortController();
  let started = 0;
  const slow = new Budgeted<number>(async (_u, signal) => {
    await sleep(30);
    if (signal.aborted) return -1;
    started++;
    return 1;
  }, { gapMs: () => 0 });
  const gone = slow.get('P', { signal: ac.signal });
  ac.abort();
  assert.equal(await gone, null);
  await sleep(50);
  assert.equal(started, 0, 'cancelled before it reached the phone');
  assert.ok(isVideoApp('com.zhiliaoapp.musically') && isVideoApp('com.burbn.instagram') && !isVideoApp('com.apple.mobilenotes'));
  ok('looks: single-flight, coalesced, at most one per gap on a video app (else the last, stale), cancellable');
}

// ---- Control: nothing in an input's turn but the input (no probe, no heal), and the client's deadline ----
{
  const calls: string[] = [];
  const b = {
    mock: true,
    screen: () => ({ width: 390, height: 844, scale: 3 }),
    tap: async (_u: string, x: number) => {
      calls.push(`tap ${x}`);
      if (x === 99) await sleep(300);
      return { via: 'wda' as const };
    },
  } as unknown as Backend;
  const c = new Control(b, undefined, { actionTimeoutMs: 100, minGapMs: 0, idleProbeMs: 0 });
  const heals: string[] = [];
  c.onHeal = async (_u, why) => void heals.push(why);
  await c.handle('P', { type: 'tap', x: 1, y: 1, unit: 'pt' });
  await assert.rejects(c.handle('P', { type: 'tap', x: 99, y: 1, unit: 'pt' }), (e: HttpError) => e.status === 504 && /nothing was restarted/.test(e.message));
  assert.deepEqual(heals, [], 'no probe before a quiet phone\'s first action, no heal after a hung one');
  // a client's deadline it can't meet: refused at once (the hung tap still holds the line a moment)
  await assert.rejects(c.handle('P', { type: 'tap', x: 2, y: 1, unit: 'pt', deadlineAt: Date.now() + 30 }), (e: HttpError) => e.status === 503 && e.extra?.state === 'busy');
  await sleep(300);
  assert.equal(calls.filter((x) => x === 'tap 2').length, 0, 'never sent late');
  // the lease follows who sent it
  await c.handle('P', { type: 'tap', x: 3, y: 1, unit: 'pt', owner: true });
  assert.equal(c.actor('P').lease().kind, 'owner');
  ok('control: no probe or heal in an input\'s turn; a 504 says nothing was restarted; deadlineAt refused at once when it cannot be met; owner input takes the lease');
}

console.log(`\nall ${passed} input checks passed`);
