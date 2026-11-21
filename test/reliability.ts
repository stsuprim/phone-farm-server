// What makes an agent's control of a phone dependable: a WDA session that expired is remade (named or not, on a
// 4xx), the screen is never read from before the phone's last input, an element is tapped where it comes to rest (a
// settle wait) and waited for while its screen arrives, an id from a screen that changed taps nothing wrong, a
// gesture still playing holds the next action back, and a HID input whose outcome isn't known is never repeated.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Agent } from '../src/agent.js';
import { Control, MIN_CONTACT_MS } from '../src/control.js';
import { HidHost, HidPartial, hidPlayMs, HidTimeout } from '../src/hid.js';
import { MockBackend } from '../src/mock.js';
import { hidFailure } from '../src/real.js';
import { createServer } from '../src/server.js';
import { Backend, HttpError, PathPoint } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

// ---- WDA: a session that expired is remade and the call asked again, however WDA says it ----
{
  const { WdaManager } = await import('../src/wda.js');
  const prevCwd = process.cwd();
  const fakeSpawn = (() => {
    const p = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    return p;
  }) as unknown as typeof import('node:child_process').spawn;

  /** A WDA that has one session at a time; a call on any other session is refused the way `stale` says. */
  const fakeWda = async (statusNamesSession = true) => {
    const w = {
      current: '', made: 0, orient: 'PORTRAIT',
      stale: 'named' as 'named' | 'bare' | 'odd',
      hits: [] as { path: string; status: number }[],
      port: 0,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const p = req.url ?? '';
        const json = (status: number, v: unknown) => {
          w.hits.push({ path: `${req.method} ${p}`, status });
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(v === undefined ? '' : JSON.stringify(v));
        };
        if (p === '/status') return json(200, statusNamesSession ? { value: { ready: true }, sessionId: w.current || null } : { value: { ready: true } });
        if (p === '/session') {
          w.current = `S${++w.made}`;
          return json(200, { sessionId: w.current, value: { sessionId: w.current } });
        }
        if (p === '/wda/screen') return json(200, { value: { scale: 3 } });
        const m = /^\/session\/([^/]+)(\/.*)$/.exec(p);
        if (!m) return json(404, { value: { error: 'unknown command', message: p } });
        if (m[1] !== w.current) {
          // not WDA's session any more
          if (w.stale === 'named') return json(404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
          if (w.stale === 'bare') return json(404, undefined);
          return json(400, { value: { error: 'invalid argument', message: 'The session identifier is not known' } });
        }
        const sub = m[2]!;
        if (sub === '/window/size') return json(200, { value: { width: 390, height: 844 } });
        if (sub === '/orientation') return json(200, { value: w.orient });
        if (sub === '/appium/settings' || sub === '/wda/keys') return json(200, { value: null });
        if (sub === '/wda/apps/launch') return json(400, { value: { error: 'invalid argument', message: 'no such app' } });
        json(404, { value: { error: 'unknown command', message: p } });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    w.port = (server.address() as AddressInfo).port;
    return w;
  };
  const manager = async (port: number) => {
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-rel-'))); // data/ports.json goes here
    const cfg = { wdaBasePort: port, mjpegBasePort: port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
    const m = new WdaManager(cfg, (u) => u, fakeSpawn);
    m.start('U1');
    for (let i = 0; i < 40 && m.state('U1') !== 'ready'; i++) await sleep(50);
    assert.equal(m.state('U1'), 'ready');
    return m;
  };
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const w = await fakeWda();
  const m = await manager(w.port);
  try {
    const keys = () => w.hits.filter((h) => h.path.endsWith('/wda/keys')).map((h) => `${h.path.split('/')[2]} ${h.status}`);
    assert.equal(w.current, 'S1');
    await m.call('U1', 'POST', '/wda/keys', { value: ['a'] });
    assert.deepEqual(keys(), ['S1 200']);

    // WDA says so by name (the standard 404 "invalid session id"): a new session, the call asked again
    w.current = 'gone-1';
    await m.call('U1', 'POST', '/wda/keys', { value: ['b'] });
    assert.deepEqual(keys().slice(1), ['S1 404', 'S2 200'], 'retried on a new session');
    assert.equal(m.state('U1'), 'ready');

    // a bare 404 (no body, no "invalid session id"): /status shows WDA's session isn't ours any more -> the same
    w.stale = 'bare';
    w.current = 'gone-2';
    await m.call('U1', 'POST', '/wda/keys', { value: ['c'] });
    assert.deepEqual(keys().slice(3), ['S2 404', 'S3 200'], 'a 4xx that does not name the session is checked against /status');

    // any other 4xx on a session that is no longer WDA's
    w.stale = 'odd';
    w.current = 'gone-3';
    await m.call('U1', 'POST', '/wda/keys', { value: ['d'] });
    assert.deepEqual(keys().slice(5), ['S3 400', 'S4 200']);
    assert.equal(m.state('U1'), 'ready');
    assert.ok(logs.filter((l) => /the session expired/.test(l)).length >= 2);

    // a real refusal on a session that IS ours: no new session, no second try, the phone's own word
    const sessions = w.made;
    await assert.rejects(m.call('U1', 'POST', '/wda/apps/launch', { bundleId: 'x.y' }), (e: Error) => /WDA refused the request on U1: no such app/.test(e.message));
    assert.equal(w.made, sessions, 'the session was still ours: not remade');
    assert.equal(w.hits.filter((h) => h.path.endsWith('/wda/apps/launch')).length, 1, 'a refusal is not asked twice');

    // a quiet session call (Lotus's own orientation read) told its session is gone: a new one is made right then,
    // not at the next action or health check (2026-11-22: and it reads nothing of the app in front: the next read of
    // Lotus's knows the phone's turn again)
    w.stale = 'named';
    w.current = 'gone-4';
    w.orient = 'LANDSCAPE';
    assert.equal(await m.refreshOrientation('U1', 0, true), 'portrait', 'what was known, for now');
    for (let i = 0; i < 40 && w.made === sessions; i++) await sleep(10);
    assert.equal(w.made, sessions + 1, 'a new session, in the background');
    const orients = w.hits.filter((h) => h.path.endsWith('/orientation')).length;
    await sleep(50);
    assert.equal(w.hits.filter((h) => h.path.endsWith('/orientation')).length, orients, 'the new session asked nothing of the app in front');
    assert.equal(await m.refreshOrientation('U1', 0, true), 'landscape-left', "Lotus's next read");
    assert.equal(m.state('U1'), 'ready');
  } finally {
    m.shutdown();
    w.close();
  }

  // a WDA whose /status never names its session: a plain 4xx can't be told from an expiry, so nothing is remade
  const w2 = await fakeWda(false);
  const m2 = await manager(w2.port);
  try {
    w2.stale = 'odd';
    const before = w2.made;
    await assert.rejects(m2.call('U1', 'POST', '/wda/apps/launch', { bundleId: 'x.y' }), /WDA refused/);
    assert.equal(w2.made, before);
    // ...but the named one still is
    w2.stale = 'named';
    w2.current = 'gone';
    await m2.call('U1', 'POST', '/wda/keys', { value: ['a'] });
    assert.equal(w2.made, before + 1);
  } finally {
    console.log = origLog;
    m2.shutdown();
    w2.close();
    process.chdir(prevCwd);
  }
  ok('WDA: an expired session is remade and the call retried once (invalid session id, a bare 404, any 4xx on a session that is no longer its own); a real refusal is not');
}

// ---- HID: inputs behind a playing gesture, answers that never come, text typed to its end, reconnect ----
type Fake = ChildProcess & EventEmitter & { lines: Record<string, unknown>[]; out: PassThrough; killed_: boolean };
function fakeSidecar(answer: (m: Record<string, unknown>, say: (o: unknown, afterMs?: number) => void) => void) {
  const procs: Fake[] = [];
  const spawnFn = () => {
    const proc = new EventEmitter() as Fake;
    const stdin = new PassThrough();
    const out = new PassThrough();
    Object.assign(proc, { stdin, stdout: out, stderr: new PassThrough(), lines: [], out, killed_: false });
    proc.kill = () => {
      proc.killed_ = true;
      setImmediate(() => proc.emit('exit', null));
      return true;
    };
    const say = (o: unknown, afterMs = 0) => {
      const write = () => !proc.killed_ && out.write(`${JSON.stringify(o)}\n`);
      if (afterMs > 0) setTimeout(write, afterMs);
      else write();
    };
    let buf = '';
    stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        proc.lines.push(m);
        answer(m, say);
      }
    });
    procs.push(proc);
    return proc;
  };
  return { procs, spawnFn };
}
{
  assert.equal(hidPlayMs('path', { points: [[0, 0, 0], [5, 5, 800]] }), 800);
  assert.equal(hidPlayMs('type', { text: 'hello' }), 350);
  assert.equal(hidPlayMs('tap', {}), 40);
  assert.equal(hidPlayMs('move', { x: 1, y: 1 }), 0);

  // The sidecar plays one thing at a time: a path is answered when it's queued and what's sent next is answered when
  // the path is through. That used to time out behind a long hold and kill the sidecar in the middle of the gesture.
  let busyUntil = 0;
  let slowTap = 0;
  let typeFails: 'no' | 'queue' | 'partway' = 'no';
  const { procs, spawnFn } = fakeSidecar((m, say) => {
    const wait = Math.max(0, busyUntil - Date.now());
    if (m.op === 'open') return say({ id: m.id, ok: true, ms: 1 });
    if (m.op === 'path') {
      const pts = m.points as number[][];
      const len = pts[pts.length - 1]![2]!;
      say({ id: m.id, ok: true, ms: 0.3 }, wait);
      busyUntil = Date.now() + wait + len;
      return say({ ev: 'done', op: 'path', id: m.id, ok: true, ms: len }, wait + len);
    }
    if (m.op === 'type') {
      if (typeFails === 'queue') return say({ id: m.id, ok: false, error: "unsupported character 'é'" }, wait);
      say({ id: m.id, ok: true, ms: 0.3 }, wait);
      const len = String(m.text).length * 50;
      busyUntil = Date.now() + wait + len;
      return say(typeFails === 'partway' ? { ev: 'done', op: 'type', id: m.id, ok: false, error: 'ConnectionResetError: the tunnel dropped' } : { ev: 'done', op: 'type', id: m.id, ok: true, ms: len }, wait + len);
    }
    say({ id: m.id, ok: true, ms: 0.4 }, wait + (m.op === 'tap' ? slowTap : 0));
  });
  const done: string[] = [];
  const h = new HidHost('00008110-0008185134F9401E', {
    python: 'py', script: 's.py', idleMs: 60_000, retryMs: 60_000, backoffMs: [20, 30], spawn: spawnFn, log: () => {}, inputTimeoutMs: 120,
    onDone: (op, r) => void done.push(`${op} ${r.ok}`),
  });
  const release = h.hold();
  await sleep(20);
  assert.equal(h.state, 'ready');

  // a 400 ms hold, then a tap sent right behind it: the tap waits its turn (over the 120 ms an input normally gets)
  let t0 = performance.now();
  await h.input('path', { points: [[10, 10, 0], [10, 10, 400]] });
  assert.ok(performance.now() - t0 < 100, 'a path is answered when it is queued');
  await h.input('tap', { x: 3, y: 4 });
  const behind = performance.now() - t0;
  assert.ok(behind >= 350, `the tap was answered after the hold (${Math.round(behind)} ms)`);
  assert.equal(h.state, 'ready', 'no timeout behind a playing gesture');
  assert.equal(procs.length, 1, 'the sidecar was not killed');
  assert.deepEqual(done, ['path true']);

  // text is answered when it's typed (with `done`), so what follows finds all of it there
  t0 = performance.now();
  const typed = await h.input('type', { text: 'hello' }, { done: true });
  assert.ok(performance.now() - t0 >= 220, `typing took its time (${Math.round(performance.now() - t0)} ms)`);
  assert.deepEqual([typed.ok, typed.done], [true, true]);
  // without `done`: when it's queued, as before
  t0 = performance.now();
  await h.input('type', { text: 'abc' });
  assert.ok(performance.now() - t0 < 100);
  await sleep(200);

  // not queued at all (nothing reached the phone): a plain failure, so WDA may take the text
  typeFails = 'queue';
  const refused = await h.input('type', { text: 'héllo' }, { done: true }).catch((e) => e);
  assert.ok(refused instanceof Error && !(refused instanceof HidPartial) && !(refused instanceof HidTimeout));
  assert.equal(hidFailure('type', refused), "HID type failed (unsupported character 'é')", 'a refusal is a reason: WDA does it instead');
  // it broke off while typing: part of the text is on the phone, so it must NOT be typed again through WDA
  typeFails = 'partway';
  const partial = await h.input('type', { text: 'hello' }, { done: true }).catch((e) => e);
  assert.ok(partial instanceof HidPartial, 'a text that broke off partway');
  const f1 = hidFailure('type', partial);
  assert.ok(f1 instanceof HttpError && f1.status === 502 && /broke off partway.*not repeated.*look at the screen/.test(f1.message));
  typeFails = 'no';

  // no answer in time with nothing playing: the outcome isn't known. An error (never a second tap through WDA), the
  // sidecar is started over, and with someone watching the session comes back by itself
  slowTap = 400;
  const lost = await h.input('tap', { x: 1, y: 1 }).catch((e) => e);
  assert.ok(lost instanceof HidTimeout, `no answer: a timeout (got ${String(lost)}, ${JSON.stringify(lost)})`);
  const f2 = hidFailure('tap', lost);
  assert.ok(f2 instanceof HttpError && f2.status === 504 && /may or may not have happened.*not repeated/.test(f2.message));
  assert.equal(h.state, 'failed');
  slowTap = 0;
  for (let i = 0; i < 50 && h.state !== 'ready'; i++) await sleep(10);
  assert.equal(h.state, 'ready', 'reconnected by itself');
  assert.equal(procs.length, 2, 'on a new sidecar');
  assert.ok(h.reconnects >= 1);
  assert.equal((await h.input('tap', { x: 2, y: 2 })).ok, true);
  release();
  h.close();
  ok('HID: an input behind a playing gesture waits its turn; text answers when typed; a lost or half-done input is an error, never repeated; reconnects');
}

// ---- the phone's queue: a gesture still playing holds the next action; a queued touch stays down long enough ----
{
  const calls: { what: string; at: number }[] = [];
  const b = {
    mock: true,
    screen: () => ({ width: 400, height: 800, scale: 3 }),
    tap: async () => {
      calls.push({ what: 'tap', at: performance.now() });
      return { via: 'wda' as const };
    },
    gesture: async (_u: string, pts: PathPoint[]) => {
      calls.push({ what: 'gesture', at: performance.now() });
      return { via: 'hid' as const, play_ms: pts[pts.length - 1]![2] };
    },
    home: async () => {
      calls.push({ what: 'home', at: performance.now() });
      await sleep(80);
      return { via: 'wda' as const };
    },
    liveTouchReady: () => true,
    liveTouch: async (_u: string, phase: string) => {
      calls.push({ what: phase, at: performance.now() });
      return { via: 'hid' as const };
    },
  } as unknown as Backend;
  const c = new Control(b);
  assert.equal(c.lastAction('P'), -Infinity);
  const t0 = performance.now();
  const swipe = c.handle('P', { type: 'swipe', x1: 100, y1: 600, x2: 100, y2: 200, ms: 250, unit: 'pt' });
  const tap = c.handle('P', { type: 'tap', x: 50, y: 50, unit: 'pt' });
  const r = await swipe;
  assert.ok(performance.now() - t0 < 100, 'the swipe is answered when it is queued on the phone');
  assert.equal(r?.play_ms, 250);
  await tap;
  const at = (w: string) => calls.find((x) => x.what === w)!.at;
  assert.ok(at('tap') - at('gesture') >= 240, `the tap waited for the swipe to finish playing (${Math.round(at('tap') - at('gesture'))} ms)`);
  assert.ok(c.lastAction('P') >= at('tap'));

  // a quick tap whose down waited in the queue (here behind a slow Home): pressed and lifted in one instant otherwise
  calls.length = 0;
  const home = c.handle('P', { type: 'home' });
  const down = c.handle('P', { type: 'touch', phase: 'down', x: 10, y: 10, seq: 1, id: 'a', unit: 'pt' });
  const up = c.handle('P', { type: 'touch', phase: 'up', x: 10, y: 10, seq: 2, id: 'a', unit: 'pt' });
  await Promise.all([home, down, up]);
  assert.deepEqual(calls.map((x) => x.what), ['home', 'down', 'up']);
  assert.ok(at('up') - at('down') >= MIN_CONTACT_MS - 3, `the finger stayed down ${Math.round(at('up') - at('down'))} ms`);
  // a touch that was down long enough anyway isn't held any longer
  calls.length = 0;
  await c.handle('P', { type: 'touch', phase: 'down', x: 10, y: 10, seq: 3, id: 'b', unit: 'pt' });
  await sleep(60);
  const tUp = performance.now();
  await c.handle('P', { type: 'touch', phase: 'up', x: 10, y: 10, seq: 4, id: 'b', unit: 'pt' });
  assert.ok(performance.now() - tUp < MIN_CONTACT_MS, 'no added wait');
  ok('queue: a gesture still playing on the phone holds the next action back; a queued quick touch stays down at least 30 ms');
}

// ---- the agent against a scripted phone: stale trees, transitions, ids from a changed screen ----
/** A node as WDA's /source?format=json gives it. */
const node = (type: string, label: string | null, x: number, y: number, w: number, h: number, children: unknown[] = []) => ({
  type, label, name: label, value: null, rect: { x, y, width: w, height: h }, isEnabled: '1', isVisible: '1', children,
});
const screenOf = (...kids: unknown[]) => node('Application', 'App', 0, 0, 400, 800, [node('Window', null, 0, 0, 400, 800, kids)]);
function scripted() {
  const st = {
    /** The screen now, and the one it's turning into until `movingUntil` (performance.now()). */
    tree: screenOf() as unknown,
    during: null as unknown,
    movingUntil: 0,
    /** A picture that keeps changing while the screen moves (a transition), still otherwise. */
    frames: 0,
    taps: [] as string[],
    sourceMs: 0,
    sourceCalls: 0,
    onTap: null as null | ((x: number, y: number) => void),
    playFail: null as string | null,
    playMs: 0,
  };
  const moving = () => performance.now() < st.movingUntil;
  const b = {
    mock: true,
    list: async () => [],
    screen: () => ({ width: 400, height: 800, scale: 3 }),
    orientation: () => 'portrait' as const,
    refreshOrientation: async () => 'portrait' as const,
    tap: async (_u: string, x: number, y: number) => {
      st.taps.push(`${Math.round(x)},${Math.round(y)}`);
      st.onTap?.(x, y);
      return { via: 'mock' as const };
    },
    gesture: async () => ({ via: 'hid' as const, ...(st.playMs ? { play_ms: st.playMs } : {}) }),
    home: async () => ({ via: 'mock' as const }),
    uiSource: async () => {
      st.sourceCalls++;
      const t = moving() && st.during ? st.during : st.tree; // what's on screen when the read starts
      if (st.sourceMs) await sleep(st.sourceMs);
      return t;
    },
    activeApp: async () => 'com.test.app',
    frameHash: async () => (moving() ? `moving-${st.frames++}` : crypto.createHash('sha1').update(JSON.stringify(st.tree)).digest('hex')),
    playFailure: (_u: string, _since: number) => st.playFail,
  } as unknown as Backend;
  const control = new Control(b);
  return { st, b, control, agent: new Agent(b, control) };
}
{
  const { st, control, agent } = scripted();
  const A = screenOf(node('Button', 'Go', 100, 100, 80, 40));
  const B = screenOf(node('Button', 'Delete', 100, 100, 80, 40), node('Button', 'Done', 200, 600, 80, 40));
  st.tree = A;
  st.onTap = () => {
    if (st.tree === A) st.tree = B;
  };
  // a tree read a moment ago is given again...
  const first = await agent.ui('P');
  assert.deepEqual(first.elements.map((e) => e.label), ['Go']);
  assert.equal((await agent.ui('P')).cached, true);
  // ...but never one from before the phone's last input: that's the screen the input replaced
  await control.handle('P', { type: 'tap', x: 140, y: 120, unit: 'pt' });
  const after = await agent.ui('P');
  assert.equal(after.cached, false, 'read again after an action, however recent the last read');
  assert.deepEqual(after.elements.map((e) => e.label), ['Delete', 'Done']);
  assert.equal((await agent.ui('P')).cached, true, 'and that one is kept again');

  // the phone had input while a (slow) tree was being read: read once more, so the answer is the screen after it
  await sleep(1020); // past the kept tree (UI_FRESH_MS, 1 s since 2026-11-17)
  st.tree = A;
  st.sourceMs = 120;
  const calls = st.sourceCalls;
  const reading = agent.ui('P');
  await sleep(30);
  await control.handle('P', { type: 'tap', x: 140, y: 120, unit: 'pt' }); // A -> B while the read is on its way
  const snap = await reading;
  assert.equal(st.sourceCalls, calls + 2, 'read twice');
  assert.deepEqual(snap.elements.map((e) => e.label), ['Delete', 'Done'], 'the screen after the input');
  st.sourceMs = 0;
  ok('stale tree: never the screen from before the last input (the cache, a read that an action overtook)');
}
{
  // An element that's still moving (a screen sliding in) is tapped where it comes to rest.
  const { st, control, agent } = scripted();
  const rest = screenOf(node('Button', 'Next', 150, 300, 100, 40));
  const sliding = screenOf(node('Button', 'Next', 150, 700, 100, 40)); // where it is while the screen slides in
  st.tree = rest;
  st.during = sliding;
  const go = async () => {
    await control.handle('P', { type: 'home' }); // some input starts the transition
    st.movingUntil = performance.now() + 300;
  };
  await go();
  const r = await agent.tapElement('P', { label: 'Next', settleMs: 0 });
  assert.deepEqual(st.taps, ['200,320'], 'tapped where it came to rest, not where it was mid-way');
  assert.equal(r.ok, true);
  assert.deepEqual([r.element.label, r.matches], ['Next', 1]);
  // `settle: false` skips the wait (a screen that never stops moving, a caller in a hurry): where it is right now
  st.taps.length = 0;
  await go();
  await agent.tapElement('P', { label: 'Next', settle: false, settleMs: 0 });
  assert.deepEqual(st.taps, ['200,720']);
  // a picture that never stops (a video): the wait gives up after under a second and the tap still goes
  st.taps.length = 0;
  st.during = null;
  await control.handle('P', { type: 'home' });
  st.movingUntil = performance.now() + 60_000;
  const t0 = performance.now();
  await agent.tapElement('P', { label: 'Next', settleMs: 0 });
  assert.ok(performance.now() - t0 < 2500, `gave up waiting for stillness (${Math.round(performance.now() - t0)} ms)`);
  assert.deepEqual(st.taps, ['200,320']);
  st.movingUntil = 0;
  assert.equal(await agent.still('P'), true, 'a still picture is still');
  ok('settle: after recent input an element is tapped once the picture has stopped moving; `settle: false` skips it; a video never blocks');
}
{
  // The screen an action leads to takes a moment to arrive: the element is waited for, without being asked to.
  const { st, control, agent } = scripted();
  const loading = screenOf(node('StaticText', 'Loading', 150, 380, 100, 40));
  const loaded = screenOf(node('Button', 'Back', 10, 50, 80, 40), node('StaticText', 'Wi-Fi', 100, 200, 100, 30));
  const open = async () => {
    st.tree = loading;
    await control.handle('P', { type: 'home' });
    setTimeout(() => (st.tree = loaded), 400);
  };
  await open();
  const r = await agent.tapElement('P', { label: 'Back', settleMs: 0 });
  assert.equal(r.element.label, 'Back');
  assert.deepEqual(st.taps, ['50,70'], 'found once its screen arrived');
  // `timeoutMs: 0` says not to wait: what the screen says now
  await sleep(50);
  await open();
  await assert.rejects(agent.tapElement('P', { label: 'Back', timeoutMs: 0 }), (e: HttpError) => e.status === 404 && /no element matches label "Back"; the screen says: Loading/.test(e.message));
  // with no recent input there's nothing to wait for: a missing element fails at once
  await sleep(1600);
  st.tree = loading;
  const t0 = performance.now();
  await assert.rejects(agent.tapElement('P', { label: 'Back' }), /no element matches/);
  assert.ok(performance.now() - t0 < 300, 'no wait when nothing was happening');
  ok('transition: an element whose screen is still arriving is waited for (about a second) after recent input');
}
{
  // An id is a place in the tree. After the screen changed something else sits there.
  const { st, agent } = scripted();
  const A = screenOf(node('Button', 'Go', 100, 100, 80, 40), node('Button', 'Help', 100, 200, 80, 40));
  const gone = screenOf(node('Button', 'Delete', 100, 100, 80, 40), node('Button', 'Done', 200, 600, 80, 40));
  const movedTo = screenOf(node('Button', 'Delete', 100, 100, 80, 40), node('Button', 'Go', 260, 500, 80, 40));
  st.tree = A;
  const id = (await agent.ui('P')).elements.find((e) => e.label === 'Go')!.id;
  assert.equal(id, '0.0.0');
  // the same screen: the id taps it
  let r = await agent.tapElement('P', { id, label: 'Go', settleMs: 0 });
  assert.deepEqual([st.taps.pop(), r.moved], ['140,120', undefined]);
  // the screen changed and what the caller read at that id isn't on it: nothing is tapped
  st.tree = gone;
  await assert.rejects(agent.tapElement('P', { id, label: 'Go', settleMs: 0 }), (e: HttpError) => e.status === 409 && /the screen changed since it was read: 0\.0\.0 is now Button "Delete", not label "Go"; read the screen again/.test(e.message));
  assert.equal(st.taps.length, 0, 'Delete was not pressed');
  // it's still there, somewhere else: that one is tapped
  await sleep(1020); // (the screen changed by itself here: past the 1 s a read is kept, UI_FRESH_MS)
  st.tree = movedTo;
  r = await agent.tapElement('P', { id, label: 'Go', settleMs: 0 });
  assert.deepEqual([st.taps.pop(), r.moved, r.element.label, r.element.id], ['300,520', true, 'Go', '0.0.1']);
  // `text` checks it the same way; an `elementType` the element at that id isn't matches nothing
  await assert.rejects(agent.tapElement('P', { id, text: 'help', settleMs: 0 }), /the screen changed since it was read/);
  await assert.rejects(agent.tapElement('P', { id, label: 'Delete', elementType: 'Switch', settleMs: 0 }), (e: HttpError) => e.status === 404 && /no element matches id "0\.0\.0" of type Switch/.test(e.message));
  assert.equal(st.taps.length, 0);
  r = await agent.tapElement('P', { id, label: 'delete', elementType: 'Button', settleMs: 0 });
  assert.deepEqual([st.taps.pop(), r.moved], ['140,120', undefined]);

  // an element whose middle is off the screen is not tapped at the screen's edge
  st.tree = screenOf(node('Button', 'Far', 100, 900, 80, 40), node('Button', 'Tab', 150, 780, 100, 20));
  await assert.rejects(agent.tapElement('P', { label: 'Far', settleMs: 0 }), (e: HttpError) => e.status === 409 && /Button "Far" is off the screen \(its middle is at 0\.35, 1\.15\): scroll it into view first/.test(e.message));
  assert.equal(st.taps.length, 0, 'nothing at the edge was pressed');
  ok('ids: an id whose element changed taps nothing (409) or follows the element; an element off the screen is not tapped at its edge');
}
{
  // A gesture answered when it was queued: the report looks after it has played, and says when it broke off.
  const { st, agent } = scripted();
  st.tree = screenOf(node('Button', 'Go', 100, 100, 80, 40));
  st.playMs = 200;
  const t0 = performance.now();
  const r = await agent.action('P', { type: 'swipe', x1: 100, y1: 600, x2: 100, y2: 200, ms: 200, unit: 'pt' }, { settleMs: 0 });
  assert.equal(r.ok, true);
  assert.ok(r.ms < 100, 'ms is still receive -> injected');
  assert.ok(performance.now() - t0 >= 190 && r.total_ms! >= 190, `the look after waited for the gesture (${r.total_ms} ms)`);
  st.playFail = 'the gesture broke off on the phone (HID: ConnectionResetError)';
  await assert.rejects(agent.action('P', { type: 'swipe', x1: 100, y1: 600, x2: 100, y2: 200, ms: 200, unit: 'pt' }, { settleMs: 0 }), (e: HttpError) => e.status === 502 && /broke off on the phone.*look at the screen/.test(e.message));
  ok('report: the look after waits for a queued gesture to finish, and a gesture that broke off on the phone is a failure');
}

// ---- over HTTP: the same on the mock server ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(1);
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const get = async (p: string) => (await (await fetch(base + p, { headers: auth })).json()) as any;
  const post = async (p: string, body: unknown) => {
    const r = await fetch(base + p, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const udid = (await get('/phones'))[0].udid as string;
  try {
    const home = await get(`/phones/${udid}/ui`);
    assert.equal(home.app, 'com.apple.springboard');
    const settings = home.elements.find((e: any) => e.label === 'Settings');
    // a fast tap (no report), then the screen asked again at once: the new screen, not the one from 10 ms ago
    await quiet(() => post(`/phones/${udid}/tap`, { x: settings.x + settings.w / 2, y: settings.y + settings.h / 2, unit: 'norm', fast: true }));
    const now = await get(`/phones/${udid}/ui`);
    assert.deepEqual([now.cached, now.app], [false, 'com.apple.Preferences']);
    assert.ok(now.elements.some((e: any) => e.label === 'Back'));
    // the Settings icon's id from the home screen is something else in the app: what was read there is checked
    const stale = await quiet(() => post(`/phones/${udid}/tap-element`, { id: settings.id, label: 'Camera' }));
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /the screen changed since it was read/);
    assert.equal((await get(`/phones/${udid}/ui`)).app, 'com.apple.Preferences', 'nothing was pressed');
    // ?settle=1 waits for the picture to stop changing, then reads
    const settled = await get(`/phones/${udid}/ui?settle=1`);
    assert.deepEqual([settled.ok, settled.cached], [true, false]);
    // a batch right behind a launch still finds each element (each step reads the screen after the one before)
    const act = await quiet(() => post(`/phones/${udid}/act`, {
      steps: [{ type: 'home' }, { type: 'tap-element', label: 'Settings' }, { type: 'tap-element', label: 'Back' }, { type: 'tap-element', label: 'Camera' }],
      verify: { app: 'com.apple.camera' },
    }));
    assert.deepEqual([act.body.ok, act.body.done, act.body.verified], [true, 4, true], JSON.stringify(act.body));
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('http: /ui after a fast tap is the new screen; a stale id answers 409; ?settle=1; a batch reads the screen after every step');
}

console.log(`\nall ${passed} reliability checks passed`);
