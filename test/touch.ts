// Reliable realtime touch: touches applied in the order they came, moves folded into the newest while the phone is
// behind (never a down or an up), an ack per touch, a missing "up" lifted by the server, taps queued in order behind a
// wake, and the HID session reconnecting by itself.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { Control, touchAck, TOUCH_RELEASE_MS } from '../src/control.js';
import { HidHost } from '../src/hid.js';
import { IdleLock } from '../src/idle.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import type { Backend, PathPoint } from '../src/types.js';
import { SettingsStore } from '../src/settings.js';
/** Natural touch off: these checks need exact places and timing. */
const exactTouch = () => { const s = new SettingsStore(); s.put({ naturalTouch: false }); return s; };

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A phone whose live channel takes `delay` ms per event (a phone that is behind), recording what reached it. */
function slowPhone(delay = 0, live = true) {
  const calls: string[] = [];
  const b = {
    mock: true,
    screen: () => ({ width: 400, height: 800, scale: 3 }),
    tap: async (_u: string, x: number, y: number) => {
      await sleep(delay);
      calls.push(`tap ${Math.round(x)},${Math.round(y)}`);
      return { via: 'wda-fast' as const };
    },
    gesture: async (_u: string, pts: PathPoint[]) => {
      calls.push(`gesture ${pts.length}`);
      return { via: 'wda-fast' as const };
    },
    liveTouchReady: () => live,
    liveTouch: async (_u: string, phase: string, x: number, y: number) => {
      await sleep(delay);
      calls.push(`${phase} ${Math.round(x)},${Math.round(y)}`);
      return { via: 'hid' as const };
    },
  } as unknown as Backend;
  return { b, calls };
}
const touch = (phase: string, x: number, y: number, seq: number, id = 1, t = seq * 10) => ({ type: 'touch', phase, x, y, t, seq, id, unit: 'pt' });

// ---- the ack's shape ----
{
  const t0 = performance.now();
  assert.equal(touchAck({ type: 'touch', phase: 'down', x: 1, y: 1 }, t0, { via: 'hid' }), null, 'no seq (an older client): no touch ack');
  assert.equal(touchAck({ type: 'tap', seq: 3 }, t0, { via: 'hid' }), null);
  const a = touchAck(touch('move', 1, 1, 7, 42), t0, { via: 'hid', coalesced: true })!;
  assert.deepEqual([a.ack, a.id, a.phase, a.ok, a.via, a.coalesced], [7, 42, 'move', true, 'hid', true]);
  assert.equal(typeof a.ms, 'number');
  assert.equal(a.type, undefined, 'a touch ack is {ack: seq, ok, ms, ...}: no "type"');
  const f = touchAck(touch('up', 1, 1, 8), t0, undefined, 'the finger slipped')!;
  assert.deepEqual([f.ack, f.ok, f.error], [8, false, 'the finger slipped']);
  const w = touchAck(touch('down', 1, 1, 9), t0, { via: 'buffered', reason: 'HID is starting' })!;
  assert.deepEqual([w.via, w.reason], ['buffered', 'HID is starting']);
  ok('touch ack: {ack: seq, ok, ms, id, phase, via, reason?, coalesced?, error?}');
}

// ---- in order; moves fold into the newest while the phone is behind; a down and an up always go ----
{
  const { b, calls } = slowPhone(15);
  const c = new Control(b);
  const owner = {};
  const acks: Promise<any>[] = [c.handle('P', touch('down', 10, 10, 1), owner)];
  for (let i = 2; i <= 9; i++) acks.push(c.handle('P', touch('move', i * 10, i * 10, i), owner)); // 8 moves at once: the phone takes 15 ms each
  acks.push(c.handle('P', touch('up', 95, 95, 10), owner));
  const got = await Promise.all(acks);
  assert.equal(calls[0], 'down 10,10');
  assert.equal(calls[calls.length - 1], 'up 95,95');
  const mv = calls.filter((x) => x.startsWith('move'));
  assert.ok(mv.length >= 1 && mv.length <= 2, `the phone was behind: ${mv.length} move(s) injected for 8 sent`);
  assert.equal(mv[mv.length - 1], 'move 90,90', 'the newest point is the one injected');
  assert.deepEqual(calls.map((x) => x.split(' ')[0]), ['down', ...mv.map(() => 'move'), 'up'], 'applied in order');
  assert.ok(got.every((r) => r && r.via === 'hid'), 'every touch is answered');
  assert.equal(got[0].coalesced, undefined);
  assert.equal(got[9].coalesced, undefined, 'the up was not folded');
  assert.ok(got.slice(1, 9).filter((r) => r.coalesced).length >= 6, 'the folded moves say so');
  const st = c.meter.stats('P');
  assert.ok(st.touch.coalesced >= 6 && st.touch.move_avg_ms !== null);
  assert.equal(c.touching('P'), false);
  ok(`ordering: down, ${mv.length} of 8 moves (the newest point), up; ${st.touch.coalesced} folded, every one acked`);
}

// ---- a phone that keeps up gets every move ----
{
  const { b, calls } = slowPhone(0);
  const c = new Control(b);
  await c.handle('P', touch('down', 10, 10, 1));
  for (let i = 2; i <= 6; i++) assert.deepEqual(await c.handle('P', touch('move', i * 10, i * 10, i)), { via: 'hid' });
  await c.handle('P', touch('up', 60, 60, 7));
  assert.deepEqual(calls, ['down 10,10', 'move 20,20', 'move 30,30', 'move 40,40', 'move 50,50', 'move 60,60', 'up 60,60']);
  ok('a phone that keeps up: every move injected, none folded');
}

// ---- late, out-of-order and stray events (the unordered data channel) ----
{
  const { b, calls } = slowPhone(0);
  const c = new Control(b);
  await c.handle('P', touch('down', 10, 10, 1, 5));
  await c.handle('P', touch('move', 30, 30, 3, 5));
  assert.deepEqual(await c.handle('P', touch('move', 20, 20, 2, 5)), { via: 'hid', coalesced: true }, 'older than one already applied: skipped');
  assert.deepEqual(await c.handle('P', touch('move', 99, 99, 4, 4)), { via: 'buffered', stray: true }, "another touch's move: nothing");
  await c.handle('P', touch('up', 40, 40, 5, 5));
  assert.deepEqual(await c.handle('P', touch('move', 50, 50, 6, 5)), { via: 'buffered', stray: true }, 'a move after its up: nothing');
  assert.deepEqual(await c.handle('P', touch('up', 50, 50, 7, 5)), { via: 'buffered', stray: true });
  assert.deepEqual(calls, ['down 10,10', 'move 30,30', 'up 40,40']);
  // a new down while one is still down lifts the old one first
  await c.handle('P', touch('down', 1, 1, 8, 6));
  await c.handle('P', touch('down', 2, 2, 9, 7));
  await c.handle('P', touch('up', 3, 3, 10, 7));
  assert.deepEqual(calls.slice(3), ['down 1,1', 'up 1,1', 'down 2,2', 'up 3,3']);
  ok('late moves skipped by seq, strays ignored, a new down lifts an unfinished touch');
}

// ---- no stuck fingers: a live touch with no event for the release time is lifted, and its owner told ----
{
  assert.equal(TOUCH_RELEASE_MS, 1500);
  const { b, calls } = slowPhone(0);
  const c = new Control(b, undefined, { releaseMs: 80 });
  const told: unknown[] = [];
  const owner = { touchReleased: (i: unknown) => told.push(i) };
  await c.handle('P', touch('down', 10, 10, 1, 9), owner);
  await sleep(50);
  await c.handle('P', touch('move', 20, 20, 2, 9), owner); // a move within the time keeps the finger down
  await sleep(50);
  assert.equal(c.touching('P'), true, 'events keep it alive');
  await sleep(90);
  assert.equal(c.touching('P'), false);
  assert.deepEqual(calls, ['down 10,10', 'move 20,20', 'up 20,20'], 'lifted where it was');
  assert.deepEqual(told, [{ id: 9, reason: 'timeout' }]);
  assert.deepEqual(await c.handle('P', touch('up', 30, 30, 3, 9), owner), { via: 'buffered', stray: true }, 'its late up finds nothing to lift');
  assert.equal(c.meter.stats('P').touch.auto_released, 1);
  assert.equal(calls.length, 3);
  ok('auto-release: no event for the release time (1.5 s) lifts the finger, tells the owner, counts it');
}

// ---- a down and an up are never refused, even with the phone's queue full ----
{
  const { b, calls } = slowPhone(2);
  const c = new Control(b);
  const taps: Promise<unknown>[] = [];
  for (let i = 0; i < 50; i++) taps.push(c.handle('P', { type: 'tap', x: i, y: i, unit: 'pt' }));
  await assert.rejects(c.handle('P', { type: 'tap', x: 99, y: 99, unit: 'pt' }), /too many actions waiting/);
  const d = c.handle('P', touch('down', 5, 5, 1));
  const u = c.handle('P', touch('up', 6, 6, 2));
  await Promise.all([...taps, d, u]);
  assert.deepEqual(calls.slice(0, 50), Array.from({ length: 50 }, (_, i) => `tap ${i},${i}`), 'taps in the order they came');
  assert.deepEqual(calls.slice(50), ['down 5,5', 'up 6,6']);
  ok('queue: 50 taps in order, the 51st refused (503), a touch down and up still taken');
}

// ---- without a live channel: buffered, played on "up"; no 1.5 s lift (nothing is down on the phone) ----
{
  const { b, calls } = slowPhone(0, false);
  const c = new Control(b, undefined, { releaseMs: 40 });
  const d = await c.handle('P', touch('down', 10, 10, 1));
  assert.equal(d?.via, 'buffered');
  await sleep(80);
  assert.equal(c.touching('P'), true);
  await c.handle('P', touch('move', 200, 300, 2, 1, 100));
  const r = await c.handle('P', touch('up', 200, 300, 3, 1, 200));
  assert.equal(r?.via, 'wda-fast');
  assert.deepEqual(calls, ['gesture 3']);
  ok('no live channel: the gesture is kept whole and played on "up"');
}

// ---- taps behind a wake: a dark phone is woken first, then the taps, in order ----
{
  const calls: string[] = [];
  let locked = true;
  const b = {
    mock: true,
    screen: () => ({ width: 400, height: 800, scale: 3 }),
    tap: async (_u: string, x: number) => {
      calls.push(`tap ${x} locked=${locked}`);
      return { via: 'hid' as const };
    },
    lock: async () => {
      locked = true;
    },
    unlock: async () => {
      await sleep(30);
      calls.push('unlock');
      locked = false;
    },
    isLocked: async () => locked,
  } as unknown as Backend;
  let now = 1_000_000;
  const idle = new IdleLock(b, () => 10, { tickMs: 0, log: () => {}, now: () => now });
  const c = new Control(b);
  c.onInput = (u, discrete) => idle.activity(u, discrete);
  // the server doesn't know the phone went dark by itself: the first tap after a quiet spell asks it
  await Promise.all([1, 2, 3].map((i) => c.handle('P', { type: 'tap', x: i, y: 1, unit: 'pt' })));
  assert.deepEqual(calls, ['unlock', 'tap 1 locked=false', 'tap 2 locked=false', 'tap 3 locked=false']);
  assert.equal(idle.state('P').locked, false);
  // right after, nothing is asked again; after a quiet spell it is
  locked = true;
  calls.length = 0;
  await c.handle('P', { type: 'tap', x: 4, y: 1, unit: 'pt' });
  assert.deepEqual(calls, ['tap 4 locked=true'], 'just used: no check (it cannot have gone dark yet)');
  now += 60_000;
  await c.handle('P', { type: 'tap', x: 5, y: 1, unit: 'pt' });
  assert.deepEqual(calls.slice(1), ['unlock', 'tap 5 locked=false']);
  idle.close();
  ok('wake: a tap on a dark phone wakes it first, then the taps land in order');
}

// ---- HID reconnects by itself: a failed open is retried while someone watches, a broken session reopens at once ----
type Fake = ChildProcess & EventEmitter & { lines: Record<string, unknown>[]; out: PassThrough };
{
  const procs: Fake[] = [];
  let opens = 0;
  let failInput = false;
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
        if (m.op === 'open') {
          opens++;
          // the first two opens fail (the phone's camera is in use), the third works
          out.write(`${JSON.stringify(opens <= 2 ? { id: m.id, ok: false, error: 'the camera is in use' } : { id: m.id, ok: true, ms: 1 })}\n`);
        } else if (failInput) {
          failInput = false;
          out.write(`${JSON.stringify({ id: m.id, ok: false, error: 'ConnectionResetError: the tunnel dropped' })}\n`);
          out.write(`${JSON.stringify({ ev: 'closed', why: 'error: ConnectionResetError' })}\n`);
        } else out.write(`${JSON.stringify({ id: m.id, ok: true, ms: 0.4 })}\n`);
      }
    });
    procs.push(proc);
    return proc;
  };
  const logs: string[] = [];
  const h = new HidHost('00008110-0008185134F9401E', { python: 'py', script: 's.py', idleMs: 5000, retryMs: 60000, backoffMs: [20, 30], spawn: spawnFn, log: (l) => logs.push(l) });
  const release = h.hold(); // someone opens the phone's live view
  await sleep(10);
  assert.equal(h.state, 'failed');
  assert.match(h.reason ?? '', /camera is in use/);
  await sleep(100); // 20 ms, then 30 ms: the third open works, with nobody asking
  assert.equal(h.state, 'ready');
  assert.equal(opens, 3);
  assert.equal(h.reconnects, 1);
  // a report fails under a touch: that gesture goes to WDA (the caller's job), and the session reopens at once
  failInput = true;
  await assert.rejects(h.input('down', { x: 1, y: 2 }), /tunnel dropped/);
  await sleep(30);
  assert.equal(h.state, 'ready', 'reopened by itself');
  assert.equal(opens, 4);
  assert.equal((await h.input('tap', { x: 3, y: 4 })).ok, true);
  assert.ok(logs.some((l) => /reconnecting/.test(l)));
  release();
  h.close();
  ok('HID: a failed open is retried with back-off while someone watches; a session that breaks under a touch reopens at once');
}

// ---- the server: a live drag over the control socket, an ack per touch, a lift when the "up" never comes ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(1, { live: true });
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const udid = (await (await fetch(`${base}/phones`, { headers: auth })).json())[0].udid as string;
  try {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/devices/${udid}/control?token=${token}`);
    const msgs: any[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on('open', r));
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    // normalized, as clients send them: a drag down the middle of the screen
    send({ type: 'touch', phase: 'down', x: 0.5, y: 0.2, t: 0, seq: 1, id: 3 });
    for (let i = 2; i <= 6; i++) send({ type: 'touch', phase: 'move', x: 0.5, y: 0.2 + i * 0.1, t: i * 16, seq: i, id: 3 });
    send({ type: 'touch', phase: 'up', x: 0.5, y: 0.8, t: 120, seq: 7, id: 3 });
    for (let i = 0; i < 100 && msgs.filter((m) => m.ack !== undefined).length < 7; i++) await sleep(10);
    const acks = msgs.filter((m) => m.ack !== undefined);
    assert.deepEqual(acks.map((a) => a.ack).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7], 'an ack for every touch');
    assert.ok(acks.every((a) => a.ok === true && typeof a.ms === 'number' && a.id === 3 && a.via === 'hid'));
    assert.ok(!acks.some((a) => a.type), 'touch acks carry no "type"');
    const log = backend.inputLog(udid);
    assert.equal(log[0], 'down 195,169');
    assert.equal(log[log.length - 1], 'up 195,675');
    assert.ok(log.slice(1, -1).every((l) => l.startsWith('move')));
    assert.equal(log[log.length - 2], 'move 195,675', 'the newest move point reached the phone');

    // a press whose "up" never comes (the client froze): lifted after 1.5 s, and the socket hears it
    log.length = 0;
    const t0 = Date.now();
    send({ type: 'touch', phase: 'down', x: 0.25, y: 0.25, seq: 8, id: 4 });
    for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'touch-released'); i++) await sleep(10);
    const rel = msgs.find((m) => m.type === 'touch-released');
    assert.deepEqual([rel.id, rel.reason], [4, 'timeout']);
    const took = Date.now() - t0;
    assert.ok(took >= 1400 && took < 2600, `lifted after ${took} ms`);
    assert.deepEqual(log, ['down 98,211', 'up 98,211']);

    // the HTTP fallback answers with the same ack fields
    const r = await (await fetch(`${base}/phones/${udid}/touch`, { method: 'POST', headers: auth, body: JSON.stringify({ phase: 'down', x: 0.1, y: 0.1, seq: 20, id: 9 }) })).json();
    assert.deepEqual([r.ok, r.ack, r.id, r.via], [true, 20, 9, 'hid']);
    const r2 = await (await fetch(`${base}/phones/${udid}/touch`, { method: 'POST', headers: auth, body: JSON.stringify({ phase: 'up', x: 0.1, y: 0.1, seq: 21, id: 9 }) })).json();
    assert.deepEqual([r2.ok, r2.ack], [true, 21]);

    // the numbers: receive -> injected for taps and moves, folded moves, lifts
    const input = await (await fetch(`${base}/api/devices/${udid}/input`, { headers: auth })).json();
    assert.ok(input.tap_avg_ms !== null && input.touch.move_avg_ms !== null);
    assert.equal(input.touch.auto_released, 1);
    assert.ok(input.recent.some((s: any) => s.type === 'touch-release'));
    ws.close();
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('server: a live drag over the control socket (normalized), {ack: seq, ok, ms} per touch, a lift after 1.5 s without an "up", latency in /input');
}

// ---- the server: a tap on a phone that went dark wakes it first ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(1);
  const server = createServer(backend, token, undefined, { settings: exactTouch() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const udid = (await (await fetch(`${base}/phones`, { headers: auth })).json())[0].udid as string;
  try {
    await backend.lock(udid); // the phone locked itself: the server was never told
    backend.inputLog(udid).length = 0;
    const r = await (await fetch(`${base}/phones/${udid}/tap`, { method: 'POST', headers: auth, body: JSON.stringify({ x: 0.5, y: 0.5, fast: true }) })).json();
    assert.equal(r.ok, true);
    assert.deepEqual(backend.inputLog(udid), ['unlock', 'tap 195,422']);
    assert.equal(await backend.isLocked(udid), false);
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('server: a tap on a dark phone unlocks it first, then taps');
}

console.log(`\nall ${passed} touch checks passed`);
