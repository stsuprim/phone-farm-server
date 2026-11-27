// 2026-11-27, docs/root-cause.md §13.3a: one phone's control link as a state machine (src/wda.ts ControlLink, fed by
// /status, the main queue's beat and the lane's journal), checked on a fake clock; then on a fake WDA with one main
// queue (first in, first out, like the real one): a main queue that never moves again while /status answers is hung
// (inputs refused at once) and restarted after its limit, a beat proves what the Mac stopped waiting for done, a
// request whose deadline leaves no time is refused unsent; then detached runners adopted by the next server process
// (data/runners.json), and not adopted when their pid is gone or is something else now.
process.env.INPUT_LOG = '0';
process.env.WDA_FAST = '0'; // the XCTest tap route: one request per tap
delete process.env.WDA_DETACHED;
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { RequestJournal } from '../src/lane.js';
import { HttpError } from '../src/types.js';
import {
  BEAT_ROUTE, BUSY_MS, ControlLink, HUNG_MAX_MS, HUNG_MS, LinkState, readRunners, RESTARTS_PER_HOUR, RUNNERS_FILE, STAND_IN_BEAT_ROUTE, WdaManager, WdaSys,
} from '../src/wda.js';

let passed = 0;
const say = console.log;
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

assert.deepEqual([BUSY_MS, HUNG_MS, HUNG_MAX_MS, RESTARTS_PER_HOUR, BEAT_ROUTE, STAND_IN_BEAT_ROUTE], [2000, 20_000, 90_000, 6, '/lotus/beat', '/wda/locked']);

// ---- the state machine on a fake clock ----
{
  let now = 1_000_000;
  const j = new RequestJournal(() => now);
  const changes: string[] = [];
  const link = new ControlLink(j, { busyMs: 2000, hungMs: 20_000, hungMaxMs: 90_000, deadProbes: 3, restartCap: 2, capWindowMs: 3_600_000 }, () => now, (to: LinkState, from: LinkState) => void changes.push(`${from}>${to}`));
  assert.equal(link.state, 'absent');
  link.setStarting();
  assert.equal(link.state, 'starting');
  // a main-queue answer makes it up (the beat ran)
  link.beatSent(STAND_IN_BEAT_ROUTE, now);
  now += 40;
  link.beatRan(40);
  assert.equal(link.state, 'ready');
  assert.deepEqual(link.snapshot().beat, { route: STAND_IN_BEAT_ROUTE, outstandingSince: null, lastAt: now, lastMs: 40, p95Ms: 40 });

  // busy: something of ours on the phone past BUSY_MS, within its deadline: busy, never hung
  const tap = j.add({ label: 'POST /session/:id/wda/tap', prio: 'input', queue: 'main', appBound: false, sentAt: now, deadlineAt: now + 30_000 });
  now += 2001;
  assert.equal(link.state, 'busy');
  assert.equal(link.snapshot().op, 'POST /session/:id/wda/tap');
  now += 25_000; // still within its deadline: what it owes isn't due yet
  assert.equal(link.state, 'busy', 'within its deadline: busy, not hung');
  assert.equal(link.quiet(), now - (tap.sentAt + 30_000));

  // hung: silent HUNG_MS past what it owes (its deadline)
  j.abandon(tap.id, 'no answer within 30.0 s');
  now = tap.sentAt + 30_000 + 20_001;
  assert.equal(link.state, 'hung');
  assert.match(link.snapshot().why!, /^its main queue has not answered for 20 s past what it owed \(on it: POST \/session\/:id\/wda\/tap\)$/);
  assert.equal(link.restartDue(), null, 'hung, but not for HUNG_MAX_MS yet');
  // a request still in its deadline (someone waits for it) holds the restart off
  now = tap.sentAt + 30_000 + 90_001;
  const read = j.add({ label: 'GET /wda/locked', prio: 'read', queue: 'main', appBound: false, sentAt: now, deadlineAt: now + 5000 });
  assert.equal(link.restartDue(), null, 'something of ours is still in its deadline');
  j.abandon(read.id, 'no answer');
  now += 5001;
  const due = link.restartDue();
  assert.match(due ?? '', /^the phone's main queue has not answered for \d+ s past what it owed, while \/status answers \(hung; on it: POST \/session\/:id\/wda\/tap, sent \d+ s ago\)$/);

  // the cap: RESTARTS per hour, then none until the oldest is an hour old
  link.noteRestart(now);
  link.noteRestart(now);
  assert.equal(link.restartDue(), null, 'capped');
  assert.deepEqual(link.cap(), { ok: false, lastHour: 2, nextAllowedAt: now + 3_600_000 });
  link.clearRestarts(); // an explicit recover starts the count afresh
  assert.ok(link.restartDue());

  // an answer on the main queue (the beat, or a later request) proves it all done: ready again
  link.beatSent(STAND_IN_BEAT_ROUTE, now);
  now += 10;
  link.beatRan(10);
  j.prove('main', now - 10);
  assert.equal(j.count(), 0);
  assert.equal(link.state, 'ready');

  // our build's beat (v7) says its no-op is still waiting since when: quiet counts from then
  link.beatSent(BEAT_ROUTE, now);
  link.beatWaiting(now - 500);
  assert.equal(link.beatPending(), now - 500);
  now += 21_000;
  assert.equal(link.state, 'hung', 'only the beat on it, unanswered past HUNG_MS');
  link.beatRan(21_500);
  assert.equal(link.state, 'ready');

  // dead: /status unanswered deadProbes times in a row (any answer from WDA clears the count)
  link.status(false, false, 'no answer in 3.0 s', now);
  link.status(false, false, 'no answer in 3.0 s', now);
  link.alive();
  assert.equal(link.statusFails(), 0, 'an answer from WDA: the count starts afresh');
  for (let i = 0; i < 3; i++) {
    const at = now;
    now += 3000;
    link.status(false, i === 2, i === 2 ? 'unreachable (ECONNREFUSED)' : 'no answer in 3.0 s', at);
  }
  assert.equal(link.deadWhy(), '/status asked 3 times over 9.0 s, never answered (no answer in 3.0 s x2, unreachable (ECONNREFUSED))');
  link.setDead('dead');
  link.setRestarting(1, 'dead');
  assert.deepEqual([link.state, link.snapshot().attempt, link.snapshot().why], ['restarting', 1, 'dead']);
  link.setNeedsReplug('the device link is gone');
  assert.equal(link.state, 'needs-replug');
  link.setStarting();
  assert.equal(link.statusFails(), 0, 'a new runner starts afresh');
  link.setUp();
  assert.equal(link.state, 'ready');
  link.setAbsent();
  assert.deepEqual(changes, ['absent>starting', 'starting>ready', 'ready>busy', 'busy>hung', 'hung>ready', 'ready>hung', 'hung>ready', 'ready>dead', 'dead>restarting', 'restarting>needs-replug', 'needs-replug>starting', 'starting>ready', 'ready>absent']);
  ok('ControlLink: starting > ready (a main-queue answer) > busy > hung (silent past what it owes) > restart due after HUNG_MAX_MS only with nothing in its deadline, capped per hour; dead after 3 /status misses');
}

// ---- a fake WDA with one main queue (first in, first out); /status and stills off it ----
type Fake = {
  port: number; current: string; made: number; hits: string[];
  /** A tap never finishes on the phone (its main queue stops for good) / takes this long / its connection drops at `dropMs`. */
  hangTap: boolean; tapMs: number; dropMs: number;
  reset(): void; close(): void;
};
const fakeWda = async (): Promise<Fake> => {
  const q: (() => Promise<void>)[] = [];
  let running = false;
  let stuck: (() => void)[] = [];
  const pump = async () => {
    if (running) return;
    running = true;
    while (q.length) await q.shift()!();
    running = false;
  };
  const open = new Set<http.ServerResponse>();
  const w: Fake = {
    port: 0, current: '', made: 0, hits: [], hangTap: false, tapMs: 0, dropMs: 0,
    reset: () => {
      // a new runner: what was on the old main queue is gone
      q.length = 0;
      for (const r of open) r.destroy();
      open.clear();
      const s = stuck;
      stuck = [];
      for (const f of s) f();
      w.hangTap = false;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const p = (req.url ?? '').split('?')[0]!;
      w.hits.push(`${req.method} ${p}`);
      open.add(res);
      res.on('close', () => open.delete(res));
      const send = (status: number, v: unknown) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (p === '/status') return send(200, { value: { ready: true }, sessionId: w.current || null });
      if (p === '/screenshot') return send(200, { value: 'AAAA' });
      // everything else waits its turn on the main queue
      const main = (ms: number, status: number, v: unknown, hang = false) => {
        q.push(async () => {
          if (hang) return new Promise<void>((r) => void stuck.push(r));
          if (ms) await sleep(ms);
          send(status, v);
        });
        void pump();
      };
      if (p === '/session' && req.method === 'POST') {
        w.current = `S${++w.made}`;
        return main(0, 200, { sessionId: w.current, value: { sessionId: w.current } });
      }
      if (p === '/wda/screen') return main(0, 200, { value: { scale: 3, screenSize: { width: 390, height: 844 } } });
      if (p === '/wda/locked') return main(0, 200, { value: false });
      const m = /^\/session\/([^/]+)(\/.*)?$/.exec(p);
      if (!m) return main(0, 404, { value: { error: 'unknown command', message: p } });
      if (m[1] !== w.current) return main(0, 404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
      const sub = m[2] ?? '';
      if (sub === '/wda/tap') {
        if (w.dropMs) setTimeout(() => res.destroy(), w.dropMs);
        return main(w.tapMs, 200, { value: null }, w.hangTap);
      }
      if (sub === '') return main(0, 200, { value: { capabilities: {} } });
      if (sub === '/window/size') return main(0, 200, { value: { width: 390, height: 844 } });
      if (sub === '/orientation') return main(0, 200, { value: 'PORTRAIT' });
      if (sub === '/appium/settings') return main(0, 200, { value: null });
      main(0, 404, { value: { error: 'unknown command', message: p } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.port = (server.address() as AddressInfo).port;
  return w;
};

/** Fake processes with pids; `sys` is a fake real Mac that knows which of them still run. */
const procs = () => {
  const alive = new Set<number>();
  const signalled: number[] = [];
  const spawned: { cmd: string; pid: number }[] = [];
  let next = 40_000;
  let onSpawn: ((cmd: string) => void) | null = null;
  const fake = (pid: number) => {
    const p = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(p, {
      pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), unref: () => {},
      kill: () => {
        alive.delete(pid);
        setImmediate(() => p.emit('exit', null, 'SIGTERM'));
        return true;
      },
    });
    return p;
  };
  const spawn = ((cmd: string) => {
    const pid = ++next;
    alive.add(pid);
    spawned.push({ cmd, pid });
    onSpawn?.(cmd);
    return fake(pid);
  }) as unknown as typeof import('node:child_process').spawn;
  const commands = new Map<number, string>();
  const sys: WdaSys = {
    real: true,
    run: async () => ({ ok: false, out: '' }), // pkill: nothing matched
    descendants: async () => [],
    signal: (pid) => {
      signalled.push(pid);
      return alive.delete(pid);
    },
    alive: (pid) => alive.has(pid),
    listeners: async () => [],
    command: async (pid) => (alive.has(pid) ? commands.get(pid) ?? (spawned.find((s) => s.pid === pid)?.cmd === 'xcodebuild' ? 'xcodebuild test-without-building -destination id=U1' : 'iproxy -u U1') : ''),
  };
  return { alive, signalled, spawned, spawn, sys, commands, xcodes: () => spawned.filter((s) => s.cmd === 'xcodebuild').length, set onSpawn(f: ((cmd: string) => void) | null) { onSpawn = f; } };
};

// ---- a hung main queue (its process answers /status) is restarted after its limit; a beat proves what was abandoned ----
{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-linkstate-')));
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const w = await fakeWda();
  const pr = procs();
  pr.onSpawn = (cmd) => cmd === 'xcodebuild' && w.reset(); // a new runner: a fresh main queue
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  // quick clocks: a touch gets 200 ms and waits 300 ms for its turn at most; busy after 100 ms, hung 300 ms past what
  // it owes, restarted 900 ms past it; `hold` long (the late check stays out of this)
  const m = new WdaManager(cfg, () => 'iPhone-1', pr.spawn, {
    input: 200, launch: 1000, probe: 150, restart: 3000, status: 100, probes: 3, probeEvery: 80, backoff: [50, 100, 200],
    sessionWait: 500, recoverWait: 3000, hold: 60_000, laneWait: 300, busy: 100, hung: 300, hungMax: 900,
  }, { ...pr.sys, real: false });
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready' && m.link('U1')?.state === 'ready'), 'ready');
    const runners = pr.xcodes();
    const sessions = w.made;

    // 1. a slow tap whose connection drops after the Mac stopped waiting: the journal keeps it; the beat (the stand-in,
    //    on the main queue behind it) answers once the phone is through it and proves it done. Nothing restarted
    w.tapMs = 400;
    w.dropMs = 250;
    await assert.rejects(m.tap('U1', 10, 10), (err: HttpError) => err.status === 502);
    assert.deepEqual(m.journal('U1').map((j) => [j.label, j.state]), [['POST /session/:id/wda/tap', 'abandoned']]);
    assert.ok(await until(() => m.journal('U1').length === 0, 2000), 'the beat proved it done');
    assert.ok(w.hits.includes('GET /wda/locked'), 'the stand-in beat went');
    assert.notEqual(m.link('U1')!.beat.lastAt, null);
    assert.deepEqual([pr.xcodes(), w.made, m.linkHealth('U1')!.recoveries, m.link('U1')!.state], [runners, sessions, 0, 'ready']);
    w.tapMs = 0;
    w.dropMs = 0;
    ok('a request the Mac stopped waiting for stays on the journal until the main queue\'s beat proves it done (first in, first out); nothing restarted');

    // 2. a deadline that leaves no time: refused at once, never sent
    const taps = w.hits.filter((h) => h.endsWith('/wda/tap')).length;
    const t0 = Date.now();
    await assert.rejects(m.call('U1', 'POST', '/wda/tap', { x: 1, y: 1 }, 2000, { deadlineAt: Date.now() + 40 }), (err: HttpError) => err.status === 503 && /deadline leaves no time/.test(err.message));
    assert.ok(Date.now() - t0 < 100, 'at once');
    assert.equal(w.hits.filter((h) => h.endsWith('/wda/tap')).length, taps, 'never sent');
    ok('a request whose deadline leaves no time for the phone is refused at once, unsent');

    // 3. XCTest hangs for good under a tap (its main queue never moves again) while /status answers: busy, then hung
    //    (touches refused at once, with why), then after hungMax with nothing in its deadline: the runner restarted
    const seen = new Set<string>();
    const watch = setInterval(() => seen.add(m.link('U1')?.state ?? 'none'), 5);
    w.hangTap = true;
    await assert.rejects(m.tap('U1', 20, 20), (err: HttpError) => err.status === 502);
    assert.ok(await until(() => m.link('U1')!.state === 'hung', 2000), 'hung');
    const s = m.link('U1')!;
    assert.equal(s.op, 'POST /session/:id/wda/tap');
    assert.equal(s.status.fails, 0, '/status answers all along');
    const t1 = Date.now();
    await assert.rejects(m.tap('U1', 30, 30), (err: HttpError) => err.status === 503 && err.extra?.state === 'hung' && /WebDriverAgent is hung: its main queue has not answered/.test(err.message));
    assert.ok(Date.now() - t1 < 100, 'refused at once while hung');
    assert.ok(await until(() => pr.xcodes() === runners + 1, 4000), 'restarted after hungMax');
    assert.match(m.healStats('U1').lastHeal!.reason, /^restarting WDA \(attempt 1\/\d+\): the phone's main queue has not answered for \d+ s past what it owed, while \/status answers \(hung; on it: POST \/session\/:id\/wda\/tap/);
    assert.ok(await until(() => m.state('U1') === 'ready' && !m.restarting('U1') && m.link('U1')!.state === 'ready', 4000), 'ready again');
    clearInterval(watch);
    assert.ok(seen.has('busy') && seen.has('hung') && (seen.has('restarting') || seen.has('starting')), [...seen].join(' '));
    assert.equal(m.link('U1')!.restarts.lastHour, 1, 'counted against the hourly cap');
    await m.tap('U1', 40, 40);
    ok('a main queue that never moves again while /status answers: busy, hung (touches refused at once), restarted after hungMax, counted against the cap');
  } finally {
    console.log = origLog;
    await m.shutdown(500);
    w.close();
    process.chdir(prevCwd);
  }
}

// ---- detached runners: left running by shutdown, adopted by the next server process ----
{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-adopt-')));
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const w = await fakeWda();
  const pr = procs();
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  const opts = { input: 300, launch: 1000, probe: 150, restart: 3000, status: 200, probes: 3, probeEvery: 100, backoff: [50, 100, 200], sessionWait: 500, recoverWait: 3000 };
  const mk = () => new WdaManager(cfg, () => 'iPhone-1', pr.spawn, opts, pr.sys);
  let m = mk();
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');
    assert.equal(pr.xcodes(), 1);
    const rec = readRunners()['U1']!;
    const xcode = pr.spawned.find((x) => x.cmd === 'xcodebuild')!.pid;
    assert.equal(rec.xcode, xcode);
    assert.equal(rec.port, w.port);
    assert.equal(rec.flavor, 'stock');
    assert.ok(rec.fwd.length >= 1 && rec.fwd.every((f) => pr.alive.has(f.pid)), 'its forwards');
    assert.equal(typeof rec.upAt, 'number', 'written once up');
    if (process.platform !== 'win32') assert.equal(fs.statSync(RUNNERS_FILE).mode & 0o777, 0o600, 'the file is the server\'s own');
    assert.ok(fs.existsSync(path.join('data', 'runner-logs')), 'output to files, not pipes');
    const session = w.current;

    // 1. the server stops: the runner is left running, as it is
    await m.shutdown(500);
    assert.ok(pr.alive.has(xcode) && pr.signalled.length === 0, 'nothing ended');
    assert.equal(readRunners()['U1']?.xcode, xcode);

    // 2. the next server process adopts it: no xcodebuild started, the session kept
    m = mk();
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready (adopted)');
    assert.equal(pr.xcodes(), 1, 'no new runner');
    assert.equal(m.linkHealth('U1')!.adopted, true);
    assert.equal(w.current, session, 'its session kept');
    assert.ok(logs.some((l) => /adopting the runner an earlier server process left running \(xcodebuild pid \d+, wda :\d+\)/.test(l)));
    await m.tap('U1', 10, 10);

    // 3. its xcodebuild ends (polled: not our child): a new runner, as for any runner that ended
    pr.alive.delete(xcode);
    assert.ok(await until(() => pr.xcodes() === 2, 6000), 'relaunched');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready again');
    assert.notEqual(readRunners()['U1']?.xcode, xcode);

    // 4. left again, but its pid is now another program's: never adopted, never signalled; a new runner
    await m.shutdown(500);
    const left = readRunners()['U1']!.xcode;
    pr.commands.set(left, '/usr/bin/some-other-program');
    m = mk();
    m.start('U1');
    assert.ok(await until(() => pr.xcodes() === 3, 4000), 'a new runner');
    assert.ok(!pr.signalled.includes(left), 'the other program is left alone');
    assert.ok(logs.some((l) => new RegExp(`pid ${left} is no longer this phone's runner`).test(l)));
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');

    // 5. left again, and gone by the time the next server starts: forgotten, a new runner
    await m.shutdown(500);
    const gone = readRunners()['U1']!.xcode;
    pr.alive.delete(gone);
    m = mk();
    m.start('U1');
    assert.ok(await until(() => pr.xcodes() === 4, 4000), 'a new runner');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');
    assert.notEqual(readRunners()['U1']?.xcode, gone);

    // 6. shutdown({ keepRunners: false }): every runner ended and forgotten
    const last = readRunners()['U1']!.xcode;
    await m.shutdown(500, { keepRunners: false });
    assert.ok(!pr.alive.has(last), 'ended');
    assert.equal(readRunners()['U1'], undefined, 'forgotten');
    ok('detached runners: recorded in data/runners.json, left running by shutdown, adopted by the next server process (no xcodebuild, its session kept); a gone or reused pid is never adopted; keepRunners: false ends them');
  } finally {
    console.log = origLog;
    await m.shutdown(500, { keepRunners: false });
    w.close();
    process.chdir(prevCwd);
  }
}

console.log(`\nall ${passed} link-state checks passed`);
process.exit(0);
