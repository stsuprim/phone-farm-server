// 2026-11-21, the root cause (src/lane.ts): every part of the server asked a phone's WebDriverAgent at once, the
// phone does one thing at a time, so one slow still held everything behind it, every request behind it timed out on
// the Mac (yet still ran on the phone later), and those timeouts (and the still's own 500) were taken for a dead WDA
// and the runner restarted, again and again. Checked here: one request on its way per phone, a touch before waiting
// reads, a read that waited too long dropped unsent, a background read skipped while anything else is on its way, a
// late answer holding the lane until it comes (and clearing the miss count), and nothing slow (or a 5xx) ever
// recovering or restarting anything; only a request never answered at all has WDA checked, and only /status going
// unanswered (or no session at all, with nothing else answered) restarts it.
process.env.INPUT_LOG = '0';
process.env.WDA_FAST = '0'; // the XCTest tap route: one request per tap
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { LaneBusy, LaneRun, routeLabel, routePriority, WdaLane } from '../src/lane.js';
import { HttpError } from '../src/types.js';
import { exchange, HOLD_MS, LANE_WAIT_MS, QUIET_WAIT_MS, WdaError, WdaManager } from '../src/wda.js';

let passed = 0;
const say = console.log; // (the WDA checks below keep the server's own lines to themselves)
const ok = (name: string) => {
  passed++;
  say(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
};

assert.deepEqual([HOLD_MS, LANE_WAIT_MS, QUIET_WAIT_MS], [60_000, 8000, 2000]);

// ---- the lane by itself ----
{
  /** A request the test answers by hand: `answer()` gives the caller its answer and frees the lane at once. */
  const manual = (log: string[], name: string) => {
    let answer!: (v: string) => void;
    let fail!: (e: Error) => void;
    let end!: () => void;
    const started = { yes: false };
    const make = (): LaneRun<string> => {
      started.yes = true;
      log.push(`start ${name}`);
      const result = new Promise<string>((a, b) => {
        answer = a;
        fail = b;
      });
      const ended = new Promise<void>((a) => (end = a));
      return { result, ended };
    };
    return {
      make, started,
      answer: (v = name) => {
        answer(v);
        end();
      },
      /** The caller stops waiting (a timeout on the Mac); the request stays on the wire until `end`. */
      abandon: () => fail(new Error('timeout')),
      end: () => end(),
    };
  };
  const log: string[] = [];
  const lane = new WdaLane(() => 'iPhone-1');

  // 1. one at a time, in order; a touch goes before reads that wait (never before the one on its way)
  const r1 = manual(log, 'read1');
  const r2 = manual(log, 'read2');
  const r3 = manual(log, 'read3');
  const t1 = manual(log, 'tap');
  const p1 = lane.run('read', 'GET /source', 5000, r1.make);
  const p2 = lane.run('read', 'GET /lotus/shot', 5000, r2.make);
  const p3 = lane.run('read', 'GET /wda/locked', 5000, r3.make);
  const pt = lane.run('input', 'POST /lotus/gesture', 5000, t1.make);
  assert.deepEqual(log, ['start read1'], 'only one on its way');
  assert.deepEqual(lane.state(), { inFlight: 'GET /source', since: lane.state().since, abandoned: false, waiting: 3 });
  r1.answer();
  assert.equal(await p1, 'read1');
  await sleep(0);
  assert.deepEqual(log, ['start read1', 'start tap'], 'the touch jumped the waiting reads');
  t1.answer();
  await pt;
  await sleep(0);
  r2.answer();
  await p2;
  await sleep(0);
  r3.answer();
  await p3;
  assert.deepEqual(log, ['start read1', 'start tap', 'start read2', 'start read3']);
  assert.equal(lane.idle, true);
  ok('lane: one request on its way at a time, first come first served, a touch before the reads that wait');

  // 2. a caller that stopped waiting (no answer in its time) still holds the lane until the request is over
  log.length = 0;
  const slow = manual(log, 'shot');
  const after = manual(log, 'tap');
  const ps = lane.run('read', 'GET /lotus/shot', 5000, slow.make);
  const pa = lane.run('input', 'POST /lotus/gesture', 5000, after.make);
  slow.abandon();
  await assert.rejects(ps, /timeout/);
  assert.deepEqual(lane.state().abandoned, true, 'the shot still holds the lane');
  await sleep(20);
  assert.deepEqual(log, ['start shot'], 'nothing goes to the phone on top of it');
  slow.end(); // the phone's late answer
  await sleep(0);
  assert.deepEqual(log, ['start shot', 'start tap']);
  after.answer();
  await pa;
  ok('lane: a request the Mac stopped waiting for keeps the lane until the phone is done with it');

  // 3. a read that waited too long is dropped, never sent late, with the phone's name and what it was busy with
  log.length = 0;
  const long = manual(log, 'source');
  const pl = lane.run('read', 'GET /source', 5000, long.make);
  const stale = manual(log, 'stale');
  const t0 = Date.now();
  await assert.rejects(lane.run('read', 'GET /lotus/shot', 60, stale.make), (err: HttpError) => {
    assert.ok(err instanceof LaneBusy);
    assert.equal(err.status, 503);
    assert.equal(err.extra?.state, 'busy');
    assert.match(err.message, /^iPhone-1 is busy: its WebDriverAgent is still working on an earlier request \(GET \/source, [\d.]+ s so far\), so GET \/lotus\/shot was not sent; try again in a moment$/);
    return true;
  });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(stale.started.yes, false, 'never sent');

  // 4. a quiet read is skipped at once while anything else is on its way; quiet ones wait behind each other only,
  //    and the same one asked twice is asked once
  const q0 = manual(log, 'quiet0');
  await assert.rejects(lane.run('quiet', 'GET /session/:id/orientation', 2000, q0.make, 'o'), (err: LaneBusy) => err.extra?.skipped === true && /skipped$/.test(err.message));
  assert.equal(q0.started.yes, false);
  long.answer();
  await pl;
  await sleep(0);
  const qa = manual(log, 'qa');
  const qb = manual(log, 'qb');
  const qc = manual(log, 'qc');
  const pqa = lane.run('quiet', 'GET /wda/activeAppInfo', 2000, qa.make, 'app');
  const pqb = lane.run('quiet', 'GET /wda/device/info', 2000, qb.make, 'dev');
  const pqc = lane.run('quiet', 'GET /wda/device/info', 2000, qc.make, 'dev'); // the same: joins
  qa.answer('A');
  assert.equal(await pqa, 'A');
  await sleep(0);
  qb.answer('B');
  assert.deepEqual(await Promise.all([pqb, pqc]), ['B', 'B']);
  assert.equal(qc.started.yes, false, 'asked once');

  // 5. a restart: whatever waits is answered at once with why
  const busy = manual(log, 'busy');
  const pb = lane.run('read', 'GET /source', 5000, busy.make);
  const waiting = lane.run('input', 'POST /lotus/gesture', 5000, manual(log, 'never').make);
  lane.flush(new HttpError(503, "The phone's control link is restarting"));
  await assert.rejects(waiting, /restarting/);
  assert.equal(await lane.drained(20), false);
  const d = lane.drained(1000);
  busy.answer();
  await pb;
  assert.equal(await d, true);
  ok('lane: a read that waited too long is dropped unsent; a quiet read never piles on; a restart answers what waits');

  // 6. whose turn: touches, keys, typing, launches, locks and lifts are input; looks and the session's housekeeping are reads
  assert.deepEqual(
    [
      ['POST', '/lotus/gesture'], ['POST', '/session/S1/wda/tap'], ['POST', '/wda/keys'], ['POST', '/wda/lock'], ['DELETE', '/session/S1/actions'],
      ['GET', '/lotus/shot?scale=50'], ['GET', '/source?format=json'], ['POST', '/session'], ['POST', '/session/S1/appium/settings'], ['DELETE', '/session/S1'],
    ].map(([m, p]) => routePriority(m!, p!)),
    ['input', 'input', 'input', 'input', 'input', 'read', 'read', 'read', 'read', 'read'],
  );
  assert.equal(routeLabel('GET', '/session/abc-123/orientation?x=1'), 'GET /session/:id/orientation');
  ok('lane: input or read by the route; a request named without its session id or query');
}

// ---- one exchange: a late answer is waited for (held), one never answered is given up at its hold ----
{
  let wait = 300;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (!Number.isFinite(wait)) return;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"value":1}');
      }, wait);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true });
  try {
    let answers = 0;
    let stuck = 0;
    const t0 = Date.now();
    const x = exchange({ port, method: 'GET', path: '/x', headers: {}, agent, timeout: 80, holdMs: 2000, resend: true, onAnswer: () => answers++, onStuck: () => stuck++ });
    await assert.rejects(x.result, (err: Error & { code?: string }) => err.code === 'TIMEOUT');
    assert.ok(Date.now() - t0 < 250, 'the caller hears at its timeout');
    await x.ended;
    assert.ok(Date.now() - t0 >= 280, 'the exchange lasted until the late answer');
    assert.deepEqual([answers, stuck], [1, 0], 'the late answer counts as an answer');

    wait = Infinity; // never answered
    const t1 = Date.now();
    const y = exchange({ port, method: 'GET', path: '/y', headers: {}, agent, timeout: 50, holdMs: 100, resend: true, onAnswer: () => answers++, onStuck: () => stuck++ });
    await assert.rejects(y.result, (err: Error & { code?: string }) => err.code === 'TIMEOUT');
    await y.ended;
    assert.ok(Date.now() - t1 >= 140 && Date.now() - t1 < 1000, `given up at its hold (${Date.now() - t1} ms)`);
    assert.deepEqual([answers, stuck], [1, 1]);

    wait = 0;
    const z = exchange({ port, method: 'GET', path: '/z', headers: {}, agent, timeout: 50, holdMs: 0, resend: true, onAnswer: () => answers++ });
    assert.deepEqual(await z.result, { status: 200, text: '{"value":1}' });
    await z.ended;
  } finally {
    agent.destroy();
    server.closeAllConnections();
    server.close();
  }
  ok('exchange: the caller hears at its timeout, the request is held for the late answer (an answer), given up at its hold');
}

// ---- a phone's WDA through the lane: the evidence of 2026-11-21, played on a fake WDA ----
type Fake = {
  current: string; made: number; port: number; hits: string[]; open: number; most: number; statusDuring: number;
  shotMs: number; shotFail: boolean; sourceMs: number; tapMs: number; hangShot: boolean; close(): void;
};
const fakeWda = async (): Promise<Fake> => {
  const w: Fake = {
    current: '', made: 0, port: 0, hits: [], open: 0, most: 0, statusDuring: 0, shotMs: 0, shotFail: false, sourceMs: 0, tapMs: 0, hangShot: false,
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
        // /status answers off WDA's main queue: never counted as one of its requests at once
        const counted = p !== '/status';
        if (counted) {
          w.open++;
          w.most = Math.max(w.most, w.open);
        } else if (w.open > 0) w.statusDuring++;
        const done = () => {
          if (counted) w.open--;
        };
        res.on('close', done);
        if (!Number.isFinite(wait)) return;
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(v));
        }, wait);
      };
      if (p === '/status') return json(200, { value: { ready: true }, sessionId: w.current || null });
      if (p === '/session') {
        w.current = `S${++w.made}`;
        return json(200, { sessionId: w.current, value: { sessionId: w.current } });
      }
      if (p === '/wda/screen') return json(200, { value: { scale: 3, screenSize: { width: 390, height: 844 } } });
      if (p === '/screenshot') {
        if (w.hangShot) return json(200, {}, Infinity);
        // XCTest's own failure when testmanagerd gave no still in time: a 500 from WDA, which is alive
        if (w.shotFail) return json(500, { value: { error: 'unable to capture screen', message: "Error Domain=com.facebook.WebDriverAgent Code=1 \"Cannot take a screenshot within 20000 ms timeout\"" } }, w.shotMs);
        return json(200, { value: 'AAAA' }, w.shotMs);
      }
      if (p.startsWith('/source')) return json(200, { value: { type: 'Application' } }, w.sourceMs);
      if (p === '/wda/locked') return json(200, { value: false });
      if (p === '/wda/activeAppInfo') return json(200, { value: { bundleId: 'com.apple.springboard' } });
      if (p === '/wda/device/info') return json(200, { value: {} });
      const m = /^\/session\/([^/]+)(\/.*)?$/.exec(p);
      if (!m) return json(404, { value: { error: 'unknown command', message: p } });
      if (m[1] !== w.current) return json(404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
      const sub = m[2] ?? '';
      if (sub === '') return json(200, { value: { capabilities: {} } });
      if (sub === '/window/size') return json(200, { value: { width: 390, height: 844 } });
      if (sub === '/orientation') return json(200, { value: 'PORTRAIT' });
      if (sub === '/appium/settings') return json(200, { value: null });
      if (sub === '/wda/tap') return json(200, { value: null }, w.tapMs);
      json(404, { value: { error: 'unknown command', message: p } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.port = (server.address() as AddressInfo).port;
  return w;
};
const spawned: string[] = [];
const fakeSpawn = ((cmd: string) => {
  const p = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  spawned.push(cmd);
  return p;
}) as unknown as typeof import('node:child_process').spawn;
const xcodes = () => spawned.filter((c) => c === 'xcodebuild').length;

{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-lane-'))); // data/ports.json goes here
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const w = await fakeWda();
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  // quick clocks: a touch gets 250 ms, a probe 150 ms; a request never answered holds the lane 400 ms more; a turn
  // waits 600 ms at most; /status 100 ms, asked 3 times 100 ms apart before anything is restarted
  const m = new WdaManager(cfg, () => 'iPhone-1', fakeSpawn, {
    input: 250, launch: 1000, probe: 150, restart: 3000, status: 100, probes: 3, probeEvery: 100, backoff: [50, 100, 200],
    sessionWait: 500, recoverWait: 3000, hold: 400, laneWait: 600,
  });
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready' && m.screen('U1') !== null), 'ready');
    const runners = xcodes();
    const sessions = w.made;
    w.most = 0;

    // 1. everything at once (what the server did while the owner watched and touched iPhone-1): the orientation
    //    poll, the card's reads, the watch's lock check, a still, a UI read and two taps. The phone gets them one
    //    at a time, never two at once, and every one is answered
    w.shotMs = 120;
    w.sourceMs = 80;
    const all = await Promise.allSettled([
      m.refreshOrientation('U1', 0),
      m.peek('U1', '/wda/activeAppInfo'),
      m.callSoft('U1', 'GET', '/wda/locked', undefined, 3000),
      m.callNoSession('U1', 'GET', '/screenshot', undefined, 2000),
      m.source('U1'),
      m.tap('U1', 10, 10),
      m.tap('U1', 20, 20),
    ]);
    assert.equal(w.most, 1, `one request at a time reached the phone (most at once: ${w.most})`);
    assert.deepEqual(all.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message)), []);
    ok('WDA: the server\'s many callers reach the phone one request at a time, all of them answered');

    // 2. the touch goes before the reads that wait (a still on its way finishes first)
    w.hits.length = 0;
    w.shotMs = 200;
    const first = m.callNoSession('U1', 'GET', '/screenshot', undefined, 2000);
    await sleep(30); // the still is on its way
    const order = [m.source('U1'), m.callSoft('U1', 'GET', '/wda/locked', undefined, 2000)];
    await sleep(10); // the two reads wait their turn
    const tap = m.tap('U1', 30, 30);
    await Promise.all([first, ...order, tap]);
    const seq = w.hits.filter((h) => !h.startsWith('GET /status')).map((h) => (h.includes('/wda/tap') ? 'tap' : h.split(' ')[1]!.split('?')[0]));
    assert.deepEqual(seq.slice(0, 2), ['/screenshot', 'tap'], 'the touch went before the reads that waited');
    assert.deepEqual(new Set(seq.slice(2)), new Set(['/source', '/wda/locked']));
    ok('WDA: a touch goes before the reads that wait its turn');

    // 3. a slow still (8 s on the phone, scaled here): its caller hears "no answer" at its timeout, the touch behind it
    //    waits its turn and is sent only once the phone answered the still (never on top of it). Nothing is recovered,
    //    nothing restarted, the session kept: slow is not dead
    w.shotMs = 500;
    const heals = m.healStats('U1').heals;
    const t0 = Date.now();
    const shot = m.callNoSession('U1', 'GET', '/screenshot', undefined, 200);
    await sleep(10);
    const tap2 = m.tap('U1', 40, 40);
    await assert.rejects(shot, (err: WdaError) => err.status === 502 && /^iPhone-1 did not answer in time \(no answer within 0s\): its WebDriverAgent is busy or stuck, nothing was restarted/.test(err.message));
    await tap2;
    assert.ok(Date.now() - t0 >= 480, `the touch went after the still's late answer (${Date.now() - t0} ms)`);
    assert.equal(w.most, 1, 'never two at once');
    assert.deepEqual([xcodes(), w.made, m.healStats('U1').heals, m.state('U1'), m.linkHealth('U1')!.recoveries], [runners, sessions, heals, 'ready', 0]);
    ok('WDA: a slow still never recovers or restarts anything; the touch behind it waits its turn instead of piling on');

    // 4. a touch that would wait too long behind a slow request is dropped unsent, with why (a 503 "busy", the phone's
    //    name and what it was busy with), never sent late
    w.shotMs = 1500;
    const long = m.callNoSession('U1', 'GET', '/screenshot', undefined, 3000);
    await sleep(10);
    const taps = w.hits.filter((h) => h.includes('/wda/tap')).length;
    await assert.rejects(m.tap('U1', 50, 50), (err: HttpError) => err.status === 503 && err.extra?.state === 'busy' && /^iPhone-1 is busy: its WebDriverAgent is still working on an earlier request \(GET \/screenshot, [\d.]+ s so far\), so POST \/session\/:id\/wda\/tap was not sent/.test(err.message));
    // ...and a background read (the card) is skipped at once
    const t1 = Date.now();
    assert.equal(await m.peek('U1', '/wda/activeAppInfo'), null);
    assert.ok(Date.now() - t1 < 100, 'skipped at once');
    await long;
    assert.equal(w.hits.filter((h) => h.includes('/wda/tap')).length, taps, 'the dropped touch never reached the phone');
    ok('WDA: a touch that would wait too long is dropped unsent with a clear "busy"; background reads skipped');

    // 5. XCTest's still fails on the phone ("Cannot take a screenshot within 20000 ms timeout", a 500): WDA answered,
    //    so it's said as it is, and nothing is recovered or restarted (it used to restart the runner, six times)
    w.shotMs = 0;
    w.shotFail = true;
    await assert.rejects(m.callNoSession('U1', 'GET', '/screenshot', undefined, 2000), (err: HttpError) => /^WebDriverAgent on iPhone-1 could not do it: Error Domain=com\.facebook\.WebDriverAgent Code=1 "Cannot take a screenshot within 20000 ms timeout"$/.test(err.message));
    w.shotFail = false;
    await sleep(300);
    assert.deepEqual([xcodes(), w.made, m.linkHealth('U1')!.recoveries, m.state('U1')], [runners, sessions, 0, 'ready'], 'no recovery, no restart, the session kept');
    await m.tap('U1', 10, 10);
    ok('WDA: XCTest\'s own failed still (a 500) is WDA answering: said as it is, never a recovery or a restart');

    // 6. a still the phone never answers at all (not even late): its hold runs out, then WDA is checked. /status (on
    //    its own connection, never stuck behind the lane) answers and the session still does: nothing is restarted
    w.hangShot = true;
    await assert.rejects(m.callNoSession('U1', 'GET', '/screenshot', undefined, 150), /did not answer in time/);
    assert.equal(m.linkHealth('U1')!.lane.abandoned, true, 'the still holds the lane while the phone may still answer');
    assert.ok(await until(() => m.linkHealth('U1')!.recoveries === 1 && !m.linkHealth('U1')!.lane.inFlight, 3000), 'checked once its hold ran out');
    w.hangShot = false;
    assert.ok(await until(() => logs.some((l) => /\[wda U1\] recovered/.test(l))), 'recovered: WDA is there');
    assert.match(m.healStats('U1').lastHeal!.reason, /^recovering: no answer within [\d.]+ s to GET \/screenshot, not even late$/);
    assert.deepEqual([xcodes(), w.made, m.state('U1')], [runners, sessions, 'ready'], 'nothing restarted, the session kept');
    await m.tap('U1', 10, 10);
    ok('WDA: a request never answered at all has WDA checked after its hold; /status answers, so nothing is restarted');

    // 7. /status is never stuck behind the lane: while a request the phone is slow with holds it, /status is asked
    //    on a connection of its own and answered at once (it used to wait for one of six sockets, all taken by
    //    requests the phone was slow with: busy:6, "/status never answered", a restart). A recover asked meanwhile
    //    waits for the phone to finish (its late answer says WDA is there) and restarts nothing
    w.shotMs = 700;
    const held = m.callNoSession('U1', 'GET', '/screenshot', undefined, 100).catch(() => {});
    await sleep(150);
    assert.equal(m.linkHealth('U1')!.lane.inFlight, 'GET /screenshot');
    const entry = (m as unknown as { entries: Map<string, unknown> }).entries.get('U1');
    const ping = (m as unknown as { ping(e: unknown, ms: number): Promise<{ ok: boolean }> }).ping.bind(m);
    const t2 = Date.now();
    assert.equal((await ping(entry, 300)).ok, true);
    assert.ok(Date.now() - t2 < 250, `answered at once beside the held still (${Date.now() - t2} ms)`);
    assert.ok(w.statusDuring > 0, 'asked while the still was still with the phone');
    assert.equal(await m.recoverNow('U1'), 'ready');
    await held;
    assert.deepEqual([xcodes(), w.made, m.state('U1')], [runners, sessions, 'ready']);
    w.shotMs = 0;
    ok('WDA: /status goes past the lane on its own connection; a recover while the phone is busy restarts nothing');

    // 8. WDA really gone (its port closed): /status refused, then (and only then) a restart; what waited for the old
    //    runner is answered at once with why, never sent to the new one
    w.close();
    await assert.rejects(m.tap('U1', 10, 10));
    assert.ok(await until(() => xcodes() > runners, 3000), 'a dead WDA is still restarted');
    assert.ok(logs.some((l) => /\[wda-restart\] U1 attempt 1\/4: restarting WDA \(.*\/status asked 3 times/.test(l)));
    ok('WDA: a WDA that is really gone is still restarted, after /status went unanswered three times');
  } finally {
    console.log = origLog;
    await m.shutdown(500);
    try {
      w.close();
    } catch {
      /* closed */
    }
    process.chdir(prevCwd);
  }
}

console.log(`\nall ${passed} lane checks passed`);
process.exit(0);
