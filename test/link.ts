// The control link that kept failing and recovering (2026-11-16). WDA's side: one liveness check without an answer
// (WDA busy with one slow request) is not a dead WDA, any answer at all clears the count, several in a row are a real
// drop and it's recovered, a session is kept when it still answers, and a state that isn't "ready" is said only once
// it lasted. The socket's side: a jittery client is left alone, a link that died without a word is closed and
// counted, two sockets for one phone never close each other, and `stats.controlLink` says the drops and why.
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
import { MockBackend } from '../src/mock.js';
import { CONTROL_DEAD_MS, CONTROL_PING_MS, createServer } from '../src/server.js';
import { CONTROL_DEBOUNCE_MS, MISS_SPAN_MS, MISSES, WdaManager } from '../src/wda.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(15);
  return cond();
};

assert.deepEqual([MISSES, MISS_SPAN_MS, CONTROL_DEBOUNCE_MS, CONTROL_PING_MS, CONTROL_DEAD_MS], [3, 15000, 4000, 10000, 35000]);
assert.ok(CONTROL_DEAD_MS >= CONTROL_PING_MS * 3, 'a socket is dead only after three beats and more');

// ---- a fake WDA that can be slow (busy), hang for good, or lose its session ----
const fakeWda = async () => {
  const w = {
    current: '', made: 0, port: 0, hits: [] as string[],
    /** ms each kind of request waits before it answers (Infinity: never). */
    slow: { probe: 0, status: 0, shot: 0 },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const p = req.url ?? '';
      w.hits.push(`${req.method} ${p}`);
      const json = (status: number, v: unknown, wait = 0) => {
        if (!Number.isFinite(wait)) return; // never answers
        setTimeout(() => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(v));
        }, wait);
      };
      if (p === '/status') return json(200, { value: { ready: true }, sessionId: w.current || null }, w.slow.status);
      if (p === '/session') {
        w.current = `S${++w.made}`;
        return json(200, { sessionId: w.current, value: { sessionId: w.current } });
      }
      if (p === '/wda/screen') return json(200, { value: { scale: 3 } });
      if (p === '/screenshot') return json(200, { value: 'AAAA' }, w.slow.shot);
      const m = /^\/session\/([^/]+)(\/.*)?$/.exec(p);
      if (!m) return json(404, { value: { error: 'unknown command', message: p } });
      if (m[1] !== w.current) return json(404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
      const sub = m[2] ?? '';
      if (sub === '') return json(200, { value: { capabilities: {} } }, w.slow.probe);
      if (sub === '/window/size') return json(200, { value: { width: 390, height: 844 } });
      if (sub === '/orientation') return json(200, { value: 'PORTRAIT' });
      if (sub === '/appium/settings' || sub === '/wda/tap') return json(200, { value: null });
      json(404, { value: { error: 'unknown command', message: p } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.port = (server.address() as AddressInfo).port;
  return w;
};
const spawned: string[] = [];
/** Called as each process is started (a test reads what had happened by the moment a runner was restarted). */
let onSpawn: ((cmd: string) => void) | null = null;
const fakeSpawn = ((cmd: string) => {
  const p = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  onSpawn?.(cmd);
  spawned.push(cmd);
  return p;
}) as unknown as typeof import('node:child_process').spawn;
const xcodes = () => spawned.filter((c) => c === 'xcodebuild').length;

{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-link-'))); // data/ports.json goes here
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const w = await fakeWda();
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  // quick clocks: a probe waits 80 ms, WDA is down after 3 misses over 200 ms, a state is said once it lasted 250 ms
  const m = new WdaManager(cfg, (u) => u, fakeSpawn, { input: 400, launch: 1000, probe: 80, restart: 4000, status: 80, misses: 3, missSpan: 200, debounce: 250 });
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'));
    const runners = xcodes();
    const sessions = w.made;
    const seen = new Set<string>();
    const watch = setInterval(() => seen.add(m.state('U1')), 5);

    // 1. jitter: WDA is busy and answers its liveness check too late, twice in a row. Not a dead WDA: nothing is
    //    recovered, the session is kept, the runner is left alone, and the state never leaves "ready"
    w.slow.probe = 200;
    assert.equal(await m.probe('U1', 'health check'), true);
    assert.equal(await m.probe('U1', 'health check'), true);
    let h = m.linkHealth('U1')!;
    assert.deepEqual([h.misses, h.recoveries, h.runnerRestarts, h.state], [2, 0, 0, 'ready']);
    assert.deepEqual([w.made, xcodes(), m.healStats('U1').heals], [sessions, runners, 0], 'no new session, no restart, no heal');
    assert.ok(logs.some((l) => /a liveness check got no answer in time/.test(l)), 'said once in the log');

    // 2. any answer at all clears the count: WDA is there after all
    w.slow.probe = 0;
    await m.tap('U1', 10, 10);
    assert.equal(m.linkHealth('U1')!.misses, 0);
    w.slow.probe = 200;
    assert.equal(await m.probe('U1', 'health check'), true);
    assert.equal(await m.probe('U1', 'health check'), true);
    assert.equal(m.linkHealth('U1')!.recoveries, 0, 'two misses, an answer, two misses: still not down');

    // 3. a check that would land behind a request already on its way isn't even asked
    w.slow.probe = 0;
    w.slow.shot = 250;
    const shot = m.callSoft('U1', 'GET', '/screenshot', undefined, 1000);
    const before = w.hits.filter((x) => /^GET \/session\/S\d+$/.test(x)).length;
    assert.equal(await m.probe('U1', 'health check'), true);
    assert.equal(w.hits.filter((x) => /^GET \/session\/S\d+$/.test(x)).length, before, 'WDA is busy with a screenshot: no probe behind it');
    await shot;
    w.slow.shot = 0;
    assert.equal(m.linkHealth('U1')!.recoveries, 0);
    assert.deepEqual([...seen], ['ready'], 'the state never left "ready" through all of that');

    // 4. a real hiccup that heals at once (the session expired): remade, and never shown
    w.current = 'someone-else';
    assert.equal(await m.probe('U1', 'watch'), true);
    assert.equal(w.made, sessions + 1, 'a new session');
    assert.deepEqual([...seen], ['ready'], 'a session remade in a moment is never shown as the link going down');

    // 5. a real drop: WDA stops answering for good. Three misses over the span, then /status asked three times,
    //    then (and only then) the runner is restarted; meanwhile the state says "recovering"
    w.slow.probe = Infinity;
    w.slow.status = Infinity;
    const statusBefore = w.hits.filter((x) => x === 'GET /status').length;
    assert.equal(await m.probe('U1', 'health check'), true, 'first miss: WDA may only be busy');
    assert.equal(xcodes(), runners);
    await sleep(120);
    assert.equal(await m.probe('U1', 'health check'), true, 'second miss');
    await sleep(120);
    // (counted at the restart itself: the new runner asks /status too, right away)
    let asksAtRestart = -1;
    onSpawn = (cmd) => {
      if (cmd === 'xcodebuild' && asksAtRestart < 0) asksAtRestart = w.hits.filter((x) => x === 'GET /status').length - statusBefore;
    };
    const healing = m.probe('U1', 'health check'); // the third, over the span: down
    assert.ok(await until(() => xcodes() === runners + 1), 'the runner is restarted');
    onSpawn = null;
    assert.equal(asksAtRestart, 3, '/status was asked three times before anything was restarted');
    assert.ok(await until(() => seen.has('recovering')), 'a real outage is said');
    w.slow.probe = 0;
    w.slow.status = 0; // the new runner's WDA answers
    assert.equal(await healing, true);
    assert.ok(await until(() => m.state('U1') === 'ready'));
    h = m.linkHealth('U1')!;
    assert.deepEqual([h.recoveries, h.runnerRestarts, h.misses], [1, 1, 0]);
    assert.match(m.healStats('U1').lastHeal!.reason, /^recovering: health check: no answer within/);
    clearInterval(watch);

    // 6. a slow answer under an action: the session that still answers is kept (it was only slow)
    const kept = w.made;
    w.slow.status = 60; // late, but there
    await m.recoverNow('U1');
    assert.equal(w.made, kept, 'recovery keeps a session that still answers');
    w.slow.status = 0;
  } finally {
    console.log = origLog;
    m.shutdown();
    w.close();
    process.chdir(prevCwd);
  }
  ok('WDA: late answers (jitter) recover nothing and never leave "ready"; a real drop is recovered after 3 misses and 3 asks of /status; a session that answers is kept');
}

// ---- the control socket: jitter left alone, a dead link closed and counted, no duplicate closing, stats.controlLink ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(2);
  const server = createServer(backend, token, undefined, { watchMs: 0, controlPingMs: 40, controlDeadMs: 240 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}` };
  const phones = async () => (await (await fetch(`http://${host}/phones`, { headers: auth })).json()) as any[];
  const [a, b] = (await phones()).map((p) => p.udid as string);
  const linkOf = async (udid: string) => (await phones()).find((p) => p.udid === udid).stats.controlLink;
  const open = async (udid: string, opts: object = {}) => {
    const ws = new WebSocket(`ws://${host}/phones/${udid}/control?token=${token}`, opts);
    const state = { closed: false, code: 0 };
    ws.on('close', (code) => Object.assign(state, { closed: true, code }));
    ws.on('error', () => {});
    await new Promise((r) => ws.once('open', r));
    return { ws, state };
  };
  try {
    assert.deepEqual(await linkOf(a!), { open: 0, opens: 0, closes: 0, drops: 0, lastOpen: null, lastClose: null, wda: null });

    // a healthy client on a jittery link: it answers the server's pings, sometimes late (it's silent for most of the
    // dead time, again and again). Never closed
    const good = await open(a!, { autoPong: false });
    let beats = 0;
    good.ws.on('ping', (d) => {
      beats++;
      setTimeout(() => good.ws.readyState === WebSocket.OPEN && good.ws.pong(d), beats % 3 === 0 ? 150 : 5); // every third pong 150 ms late
    });
    // ...and a second socket for the same phone (another window, the other Lotus): neither closes the other
    const twin = await open(a!);
    await sleep(900);
    assert.deepEqual([good.state.closed, twin.state.closed], [false, false], 'a jittery link and a second link: both stay');
    let l = await linkOf(a!);
    assert.deepEqual([l.open, l.opens, l.closes, l.drops], [2, 2, 0, 0]);
    assert.equal(typeof l.lastOpen, 'number');

    // a link that died without a word (no pongs, no messages): closed after the dead time, counted as a drop
    const dead = await open(b!, { autoPong: false });
    assert.ok(await until(() => dead.state.closed, 2000), 'the dead link is closed by the server');
    l = await linkOf(b!);
    assert.deepEqual([l.open, l.opens, l.closes, l.drops, l.lastClose.why], [0, 1, 1, 1, 'dead']);
    assert.ok(l.lastClose.livedMs >= 200 && l.lastClose.livedMs < 1500, `it lived ${l.lastClose.livedMs} ms`);

    // a clean close by the client isn't a drop; one cut without a close frame is
    twin.ws.close(1000);
    assert.ok(await until(() => twin.state.closed));
    await sleep(30);
    l = await linkOf(a!);
    assert.deepEqual([l.open, l.closes, l.drops, l.lastClose.why, l.lastClose.code], [1, 1, 0, 'client', 1000]);
    good.ws.terminate();
    await sleep(80);
    l = await linkOf(a!);
    assert.deepEqual([l.open, l.closes, l.drops, l.lastClose.why], [0, 2, 1, 'dropped']);

    // pings are answered at once, whatever the phone is doing (a slow action in its queue)
    const busy = await open(a!);
    const pongs: any[] = [];
    busy.ws.on('message', (d) => {
      const msg = JSON.parse(String(d));
      if (msg.type === 'pong') pongs.push({ ...msg, at: performance.now() });
    });
    busy.ws.send(JSON.stringify({ id: 1, type: 'hold', x: 0.5, y: 0.5, ms: 400 })); // the phone is busy for a while
    const t0 = performance.now();
    busy.ws.send(JSON.stringify({ type: 'ping', t: 7 }));
    assert.ok(await until(() => pongs.length === 1, 1000));
    assert.ok(pongs[0].at - t0 < 100, `the pong came in ${Math.round(pongs[0].at - t0)} ms, beside the action`);
    assert.equal(pongs[0].t, 7);
    busy.ws.close();
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('control socket: late pongs keep it, a dead one is closed after several beats, two for one phone coexist, pings answered beside a busy phone; stats.controlLink counts opens, closes, drops and the last reason');
}

console.log(`\nall ${passed} link checks passed`);
