// A phone that keeps answering: a WDA session that expired, a WDA that hangs or dies, a port forward (iproxy) that
// exits, an action that never ends, a burst of actions, the first action after a quiet spell, a phone gone dark;
// one live phone at a time (POST /focus), `percent`, the heal fields and `info` pushed over the control socket.
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
import WebSocket from 'ws';
import { Control } from '../src/control.js';
import { IdleLock } from '../src/idle.js';
import { batteryPercent, ioregCelsius, parseDeviceInfo } from '../src/info.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import { Backend, HttpError } from '../src/types.js';
import { WdaManager } from '../src/wda.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
};

// ---- WDA: a fake one that can expire its session, hang, or die (and come back when the runner is restarted) ----
type Fake = { current: string; made: number; hang: boolean; port: number; hits: string[]; up: boolean; open(): Promise<void>; close(): void };
const fakeWda = async (): Promise<Fake> => {
  let server: http.Server | null = null;
  const w: Fake = {
    current: '', made: 0, hang: false, port: 0, hits: [], up: false,
    open: async () => {
      server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          const p = req.url ?? '';
          w.hits.push(`${req.method} ${p}`);
          const json = (status: number, v: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(v));
          };
          if (p === '/status') return json(200, { value: { ready: true }, sessionId: w.current || null });
          if (p === '/session') {
            w.current = `S${++w.made}`;
            return json(200, { sessionId: w.current, value: { sessionId: w.current } });
          }
          if (p === '/wda/screen') return json(200, { value: { scale: 3 } });
          const m = /^\/session\/([^/]+)(\/.*)?$/.exec(p);
          if (!m) return json(404, { value: { error: 'unknown command', message: p } });
          if (m[1] !== w.current) return json(404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
          const sub = m[2] ?? '';
          if (w.hang && sub.startsWith('/wda/tap')) return; // XCTest stuck: never answers
          if (sub === '') return json(200, { value: { capabilities: {} } });
          if (sub === '/window/size') return json(200, { value: { width: 390, height: 844 } });
          if (sub === '/orientation') return json(200, { value: 'PORTRAIT' });
          if (sub === '/appium/settings' || sub === '/wda/tap') return json(200, { value: null });
          json(404, { value: { error: 'unknown command', message: p } });
        });
      });
      await new Promise<void>((r) => server!.listen(w.port, '127.0.0.1', r));
      w.port = (server!.address() as AddressInfo).port;
      w.up = true;
    },
    close: () => {
      w.up = false;
      server?.closeAllConnections();
      server?.close();
    },
  };
  await w.open();
  return w;
};

/** Every process the manager starts, with its command and arguments; a new xcodebuild brings a dead fake WDA back. */
const spawned: { cmd: string; args: string[]; p: ChildProcess & EventEmitter }[] = [];
let onXcode: (() => void) | null = null;
const fakeSpawn = ((cmd: string, args: string[]) => {
  const p = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  spawned.push({ cmd, args, p });
  if (cmd === 'xcodebuild') onXcode?.();
  return p;
}) as unknown as typeof import('node:child_process').spawn;

{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-heal-'))); // data/ports.json goes here
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const w = await fakeWda();
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  const m = new WdaManager(cfg, (u) => u, fakeSpawn, { input: 300, launch: 1000, probe: 300, restart: 5000 });
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');
    assert.deepEqual(m.healStats('U1'), { heals: 0, lastHeal: null });

    // 1. the session expired while nobody was looking (/status alone would never say): the probe remakes it
    w.current = 'someone-else';
    assert.equal(await m.probe('U1', 'watch'), true);
    let h = m.healStats('U1');
    assert.equal(h.heals, 1);
    assert.match(h.lastHeal!.reason, /^watch: the session expired/);
    assert.ok(logs.some((l) => /^\[wda-heal\] U1 watch: the session expired/.test(l)), 'logged as [wda-heal] with the reason');
    assert.equal(w.current, `S${w.made}`, 'a new session was made');
    await m.tap('U1', 10, 10);

    // 2. XCTest hangs under a tap: no answer within the input timeout -> recovered (new session), retried, and the
    //    caller hears so quickly instead of waiting 30 s; once WDA answers again the next tap goes through
    w.hang = true;
    const t0 = Date.now();
    await assert.rejects(m.tap('U1', 10, 10), (err: HttpError) => err.status === 502 && /no answer within/.test(err.message));
    assert.ok(Date.now() - t0 < 3000, `a hung tap is given up on quickly (${Date.now() - t0} ms)`);
    assert.ok(m.healStats('U1').heals >= 2);
    assert.match(m.healStats('U1').lastHeal!.reason, /recovering: no answer within/);
    w.hang = false;
    await until(() => m.state('U1') === 'ready');
    await m.tap('U1', 10, 10);

    // 3. WDA dies (its port goes away): the probe recovers, /status fails too, so the runner is restarted through
    //    the usual path; the fake comes back with the new xcodebuild
    const xcodes = spawned.filter((s) => s.cmd === 'xcodebuild').length;
    w.close();
    onXcode = () => void setTimeout(() => void w.open(), 50);
    assert.equal(await m.probe('U1', 'first action after 31 s idle'), true, 'healed: WDA can take input again');
    onXcode = null;
    assert.equal(spawned.filter((s) => s.cmd === 'xcodebuild').length, xcodes + 1, 'the runner was restarted');
    assert.equal(m.state('U1'), 'ready');
    assert.match(m.healStats('U1').lastHeal!.reason, /^recovering: first action after 31 s idle/);
    await m.tap('U1', 10, 10);

    // 4. the WDA port forward (iproxy) exits by itself: it's started again, WDA itself is left alone
    const fwd = spawned.filter((s) => s.cmd === 'iproxy' && s.args.includes(`${w.port}:8100`)).at(-1)!;
    const before = m.healStats('U1').heals;
    const xcodes2 = spawned.filter((s) => s.cmd === 'xcodebuild').length;
    fwd.p.emit('exit', 1);
    assert.ok(await until(() => spawned.filter((s) => s.cmd === 'iproxy' && s.args.includes(`${w.port}:8100`)).length >= 2 && spawned.at(-1)!.p !== fwd.p));
    assert.equal(m.healStats('U1').heals, before + 1);
    assert.match(m.healStats('U1').lastHeal!.reason, /port forward \(iproxy :\d+\) exited \(1\)/);
    assert.equal(spawned.filter((s) => s.cmd === 'xcodebuild').length, xcodes2, 'WDA not restarted for a forward');
    await m.tap('U1', 10, 10);
  } finally {
    console.log = origLog;
    m.shutdown();
    w.close();
    process.chdir(prevCwd);
  }
  ok('WDA heals: an expired session, a hung tap (quick error), a dead WDA (restarted), an exited iproxy; counted and logged as [wda-heal]');
}

// ---- Control: a hung action, bursts spaced, the probe before the first action after a quiet spell ----
{
  const calls: string[] = [];
  let hang: (() => void) | null = null;
  let running = 0;
  let overlap = false;
  const starts: number[] = [];
  const b = {
    mock: true,
    screen: () => ({ width: 390, height: 844, scale: 3 }),
    tap: async (_u: string, x: number) => {
      running++;
      if (running > 1) overlap = true;
      starts.push(performance.now());
      calls.push(`tap ${x}`);
      try {
        if (x === 99) await new Promise<void>((r) => (hang = r)); // stuck until released
        return { via: 'wda' as const };
      } finally {
        running--;
      }
    },
  } as unknown as Backend;
  const c = new Control(b, undefined, { actionTimeoutMs: 150, minGapMs: 30, idleProbeMs: 200 });
  const heals: string[] = [];
  c.onHeal = async (_u, reason) => void heals.push(reason);

  // the first action ever probes; one right after doesn't
  await c.handle('P', { type: 'tap', x: 1, y: 1, unit: 'pt' });
  assert.deepEqual(heals, ['first action since the server started']);
  await c.handle('P', { type: 'tap', x: 2, y: 2, unit: 'pt' });
  assert.equal(heals.length, 1, 'not quiet: no probe');

  // a burst: in order, never two at once, each a breath (minGapMs) after the last
  starts.length = 0;
  await Promise.all([3, 4, 5, 6, 7].map((x) => c.handle('P', { type: 'tap', x, y: 1, unit: 'pt' })));
  assert.deepEqual(calls.slice(-5), ['tap 3', 'tap 4', 'tap 5', 'tap 6', 'tap 7']);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 28, `spaced ${(starts[i]! - starts[i - 1]!).toFixed(1)} ms`);
  assert.equal(overlap, false);

  // a hung action: answered with 504 at the timeout, the phone healed; the next waits for it to settle, then runs
  const t0 = performance.now();
  const stuck = c.handle('P', { type: 'tap', x: 99, y: 1, unit: 'pt' });
  const next = c.handle('P', { type: 'tap', x: 8, y: 1, unit: 'pt' });
  await assert.rejects(stuck, (err: HttpError) => err.status === 504 && /no answer within/.test(err.message));
  assert.ok(performance.now() - t0 < 1000);
  assert.ok(heals.some((r) => /^tap on the phone got no answer within/.test(r)), 'healed');
  await sleep(100);
  assert.equal(calls.at(-1), 'tap 99', 'the next one waits while the hung one may still be on its way');
  hang!();
  await next;
  assert.equal(calls.at(-1), 'tap 8');
  assert.equal(overlap, false, 'never two at once');

  // a quiet spell: the first action after it probes first
  await sleep(250);
  const n = heals.length;
  await c.handle('P', { type: 'tap', x: 9, y: 1, unit: 'pt' });
  assert.match(heals[n]!, /^first action after 0 s idle$/);
  ok('control: a hung action errors at its timeout and heals; bursts spaced and never parallel; a probe before the first action after idle');
}

// ---- wake-on-touch: a dark phone is probed, woken, then tapped, in one request; an unsure ask asks again ----
{
  const calls: string[] = [];
  let locked: boolean | null = true;
  const b = {
    mock: true,
    list: async () => [],
    screen: () => ({ width: 390, height: 844, scale: 3 }),
    tap: async (_u: string, x: number) => void calls.push(`tap ${x}`),
    lock: async () => void (locked = true),
    unlock: async () => {
      calls.push('unlock');
      locked = false;
    },
    isLocked: async () => {
      calls.push('locked?');
      return locked;
    },
  } as unknown as Backend;
  const idle = new IdleLock(b, () => 10, { tickMs: 0, log: () => {} });
  const c = new Control(b, undefined, { minGapMs: 0 });
  c.onInput = (u, d) => idle.activity(u, d);
  c.onHeal = async () => void calls.push('probe');
  await c.handle('P', { type: 'tap', x: 1, y: 1, unit: 'pt' });
  assert.deepEqual(calls, ['probe', 'locked?', 'unlock', 'locked?', 'tap 1'], 'probe, ask, wake, then the tap');

  // the phone can't say (WDA slow after a long sleep): the tap goes, and the NEXT tap asks again (it used to be 25 s
  // of taps landing on a phone that may be dark)
  const idle2 = new IdleLock(b, () => 10, { tickMs: 0, log: () => {} });
  c.onInput = (u, d) => idle2.activity(u, d);
  calls.length = 0;
  locked = null;
  await c.handle('Q', { type: 'tap', x: 2, y: 1, unit: 'pt' });
  locked = true;
  await c.handle('Q', { type: 'tap', x: 3, y: 1, unit: 'pt' });
  assert.deepEqual(calls.filter((x) => x !== 'probe'), ['locked?', 'tap 2', 'locked?', 'unlock', 'locked?', 'tap 3']);

  // a health check found it locked: the next input wakes it without asking first
  calls.length = 0;
  locked = true;
  idle2.note('Q', true);
  await c.handle('Q', { type: 'tap', x: 4, y: 1, unit: 'pt' });
  assert.deepEqual(calls, ['unlock', 'locked?', 'tap 4']);
  ok('wake-on-touch: probe, wake, act in one request; an unanswered lock ask is asked again by the next input; a noted lock wakes first');
}

// ---- units ----
{
  assert.equal(batteryPercent(0.87), 87);
  assert.equal(batteryPercent(0.005), 1);
  assert.equal(batteryPercent(1), 100);
  assert.equal(batteryPercent(null), null);
  assert.equal(ioregCelsius(3015), 30.2, 'hundredths of a degree');
  assert.equal(ioregCelsius(31), 31, 'a battery that says whole degrees is not 0.3 C');
  assert.equal(ioregCelsius(0), null);
  assert.equal(ioregCelsius(30150), null, 'nothing a phone survives');
  const now = 1_800_000_000_000;
  assert.equal(parseDeviceInfo({ uptime: 7200 }, now).uptimeSec, 7200, 'seconds');
  assert.equal(parseDeviceInfo({ uptime: 7_200_000_000 }, now).uptimeSec, 7_200_000, 'milliseconds read as seconds');
  ok('units: battery percent 0..100, temperature in Celsius from either unit, uptime in seconds');
}

// ---- the server: one live phone at a time, `focused`, `percent`, the heal fields, `info` pushed ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(3);
  const stopped: string[] = [];
  (backend as unknown as Backend).stopCapture = (u: string, why: string) => void stopped.push(`${u} ${why}`);
  const server = createServer(backend, token, undefined, { watchMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `http://${host}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const get = async (p: string) => (await (await fetch(base + p, { headers: auth })).json()) as any;
  const post = async (p: string, body: unknown = {}) => {
    const r = await fetch(base + p, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  let ws: WebSocket | undefined;
  try {
    const list = (await get('/phones')) as any[];
    const [a, b2] = list.map((p) => p.udid as string);
    assert.ok(list.every((p) => p.focused === false), 'nobody in focus yet');
    assert.ok(list.every((p) => p.stats.heals === 0 && p.stats.lastHeal === null), 'the heal fields on every phone');

    const f1 = await post(`/phones/${a}/focus`);
    assert.equal(f1.status, 200);
    assert.deepEqual([f1.body.ok, f1.body.focused, f1.body.previous], [true, a, null]);
    assert.ok('capture' in f1.body);
    assert.deepEqual((await get('/api/devices')).map((p: any) => p.focused), [true, false, false]);

    // the alias; the one before sleeps (locks) and its capture stops
    const f2 = await post(`/api/devices/${b2}/focus`);
    assert.equal(f2.status, 200);
    assert.deepEqual([f2.body.focused, f2.body.previous], [b2, { udid: a, slept: true }]);
    assert.equal(await backend.isLocked(a!), true, 'the previous phone is asleep');
    assert.deepEqual(stopped, [`${a} another phone is in focus`]);
    assert.deepEqual((await get('/phones')).map((p: any) => p.focused), [false, true, false]);
    assert.equal((await post('/phones/NOPE/focus')).status, 404);

    // percent next to level, in /info and the list's info
    const inf = await get(`/phones/${b2}/info`);
    assert.equal(inf.battery.percent, Math.round(inf.battery.level * 100));
    assert.ok(Number.isInteger(inf.battery.percent));
    await sleep(20);
    const li = (await get('/phones')).find((p: any) => p.udid === b2).info;
    assert.equal(li.battery.percent, Math.round(li.battery.level * 100));

    // info pushed over the control socket when an action changes the app in front
    ws = new WebSocket(`ws://${host}/phones/${b2}/control?token=${token}`);
    const infos: any[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'info') infos.push(m);
    });
    await new Promise((r) => ws!.once('open', r));
    // a reported action reads the app: pushed at once
    ws.send(JSON.stringify({ type: 'launch', name: 'Settings', id: 1, report: true, settleMs: 0 }));
    assert.ok(await until(() => infos.some((m) => m.info.app.bundleId === 'com.apple.Preferences')), 'pushed after a reported action');
    const msg = infos.find((m) => m.info.app.bundleId === 'com.apple.Preferences');
    assert.deepEqual([msg.udid, msg.info.app.name, typeof msg.info.battery.percent, 'orientation' in msg.info], [b2, 'Settings', 'number', true]);
    // a plain action: the card is gathered again shortly, and the change pushed
    infos.length = 0;
    ws.send(JSON.stringify({ type: 'home', id: 2 }));
    assert.ok(await until(() => infos.some((m) => m.info.app.bundleId === 'com.apple.springboard'), 4000), 'pushed after a plain action');
  } finally {
    ws?.close();
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('server: POST /focus (and /api/devices) keeps one live phone, the previous one sleeps; focused, percent, heals; info pushed');
}

console.log(`\nall ${passed} heal checks passed`);
