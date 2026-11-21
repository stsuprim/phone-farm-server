// WDA restarts only when it's really dead (2026-11-18, "it restarts too much... and maybe this time while restarting
// it broke"): a slow or failed call never restarts anything by itself; /status unanswered several times in a row
// does; calls during a restart get a 503 at once; a recover asked meanwhile joins the restart; the attempts back off
// and end in "control down" (never "recovering" for ever), and a recover or WDA answering again brings it back.
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
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import { Backend, HttpError } from '../src/types.js';
import { DEAD_PROBES, PROBE_EVERY_MS, RESTART_ATTEMPTS, RESTART_BACKOFF_MS, WdaManager } from '../src/wda.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
};

// the real clocks: /status unanswered 4 times, 4 s apart (12-15 s), then 5 s, 15 s, 60 s between at most 4 attempts
assert.deepEqual([DEAD_PROBES, PROBE_EVERY_MS, RESTART_BACKOFF_MS, RESTART_ATTEMPTS], [4, 4000, [5000, 15000, 60000], 4]);

// ---- a fake WDA: answers, is slow on taps, hangs entirely, or is gone (its port closed) ----
type Fake = { current: string; made: number; port: number; hits: string[]; tapMs: number; hang: boolean; refuse: boolean; hangStatus: number; open(): Promise<void>; close(): void };
const fakeWda = async (): Promise<Fake> => {
  let server: http.Server | null = null;
  const w: Fake = {
    current: '', made: 0, port: 0, hits: [], tapMs: 0, hang: false, refuse: false, hangStatus: 0,
    open: async () => {
      server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          const p = req.url ?? '';
          w.hits.push(`${req.method} ${p}`);
          if (w.hang) return; // XCTest stuck: nothing answers
          const json = (status: number, v: unknown, wait = 0) =>
            setTimeout(() => {
              res.writeHead(status, { 'content-type': 'application/json' });
              res.end(JSON.stringify(v));
            }, wait);
          if (p === '/status') {
            if (w.refuse) return json(503, { value: { error: 'unknown error', message: 'not up yet' } }); // a runner still starting
            if (w.hangStatus > 0) return void w.hangStatus--; // this ask never answers
            return json(200, { value: { ready: true }, sessionId: w.current || null });
          }
          if (p === '/session') {
            w.current = `S${++w.made}`;
            return json(200, { sessionId: w.current, value: { sessionId: w.current } });
          }
          if (p === '/wda/screen') return json(200, { value: { scale: 3 } });
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
      await new Promise<void>((r) => server!.listen(w.port, '127.0.0.1', r));
      w.port = (server!.address() as AddressInfo).port;
    },
    close: () => {
      server?.closeAllConnections();
      server?.close();
    },
  };
  await w.open();
  return w;
};

const spawned: string[] = [];
let onXcode: (() => void) | null = null;
const fakeSpawn = ((cmd: string) => {
  const p = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  spawned.push(cmd);
  if (cmd === 'xcodebuild') onXcode?.();
  return p;
}) as unknown as typeof import('node:child_process').spawn;
const xcodes = () => spawned.filter((c) => c === 'xcodebuild').length;
/** A 503 of the restart gate, and how long it took to come. */
const fast503 = async (p: Promise<unknown>, re: RegExp, state: string): Promise<number> => {
  const t0 = Date.now();
  await assert.rejects(p, (err: HttpError) => err instanceof HttpError && err.status === 503 && re.test(err.message) && err.extra?.state === state);
  return Date.now() - t0;
};

{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-restart-'))); // data/ports.json goes here
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const w = await fakeWda();
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  // quick clocks: /status gets 100 ms, asked 3 times 150 ms apart; a restarted runner gets 1.5 s; back-off 80/160/240 ms
  const m = new WdaManager(cfg, (u) => u, fakeSpawn, {
    input: 300, launch: 1000, probe: 150, restart: 1500, status: 100, probes: 3, probeEvery: 150,
    backoff: [80, 160, 240], attempts: 4, sessionWait: 500, recoverWait: 5000, hold: 200,
  });
  process.env.WDA_FAST = '0'; // the XCTest tap route only: one request per tap
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');
    const runners = xcodes();

    // 1. a slow call: a tap that answers after its timeout fails at once (and isn't sent again), WDA is checked in the
    //    background and answers: nothing is restarted, the session is kept, the state stays "ready"
    const sessions = w.made;
    w.tapMs = 500;
    await assert.rejects(m.tap('U1', 10, 10), (err: HttpError) => err.status === 502 && /no answer within/.test(err.message));
    w.tapMs = 0;
    await sleep(700);
    assert.equal(w.hits.filter((h) => h.endsWith('/wda/tap')).length, 1, 'never sent a second time');
    assert.deepEqual([xcodes(), w.made, m.state('U1'), m.restarting('U1')], [runners, sessions, 'ready', null], 'no restart, the session kept');
    await m.tap('U1', 10, 10);

    // 2. two /status asks go unanswered (WDA busy), the third answers: alive, nothing restarted
    w.hangStatus = 2;
    assert.equal(await m.recoverNow('U1'), 'ready');
    assert.equal(xcodes(), runners, 'two unanswered asks then an answer: not dead');
    w.hangStatus = 0; // (an ask left over, when another answer came first, must not hang the next part)
    assert.ok(!logs.some((l) => l.startsWith('[wda-restart]')), 'no restart logged');
    ok('a slow or failed call never restarts WDA; /status unanswered twice, then answered, is alive');

    // 3. WDA hangs for good: the tap is never answered, not even late (its hold in the lane runs out), then 3
    //    unanswered asks of /status in a row, then (and only then) a restart. Meanwhile every call is answered at once
    //    with a 503 that says the attempt; a recover asked meanwhile joins the same restart
    w.hang = true;
    let revive = 0;
    // the new runner's WDA takes a moment (its first /status says not yet), then answers
    onXcode = () => {
      revive++;
      w.hang = false;
      w.refuse = true;
      setTimeout(() => void (w.refuse = false), 300);
    };
    const statusBefore = w.hits.filter((h) => h === 'GET /status').length;
    const tapping = m.tap('U1', 10, 10); // times out; never answered at all: then checked
    await assert.rejects(tapping, (err: HttpError) => err.status === 502);
    assert.ok(await until(() => m.restarting('U1') !== null), 'a restart began');
    assert.equal(w.hits.filter((h) => h === 'GET /status').length - statusBefore, 3, '/status asked three times first');
    assert.equal(xcodes(), runners + 1);
    const ms = await fast503(m.tap('U1', 10, 10), /^The phone's control link is restarting \(attempt 1\)$/, 'restarting');
    assert.ok(ms < 1000, `answered at once (${ms} ms)`);
    await fast503(m.source('U1'), /restarting/, 'restarting');
    assert.throws(() => m.gate('U1'), (err: HttpError) => err.status === 503 && err.extra?.state === 'restarting');
    assert.equal(m.state('U1'), 'recovering');
    assert.deepEqual(m.linkHealth('U1')!.restarting && { ...m.linkHealth('U1')!.restarting, since: 0 }, { attempt: 1, of: 4, since: 0 });
    const joined = m.recoverNow('U1'); // joins: never a second restart
    assert.equal(await joined, 'ready', 'the joined recover ends with the restart');
    assert.equal(xcodes(), runners + 1, 'one restart only');
    assert.equal(revive, 1);
    await m.tap('U1', 10, 10);
    assert.ok(logs.some((l) => /^\[wda-restart\] U1 attempt 1\/4: restarting WDA \(no answer within .*\/status asked 3 times over [\d.]+ s, never answered \(no answer in 0\.1 s x3\)\)$/.test(l)), 'the reason logged');
    assert.ok(logs.some((l) => /^\[wda-restart\] U1 a recover was asked during attempt 1: it joins the restart under way$/.test(l)));
    assert.ok(logs.some((l) => /^\[wda-restart\] U1 attempt 1\/4 ok: WDA is back in [\d.]+ s/.test(l)), 'the outcome and the time logged');
    onXcode = null;
    ok('dead after 3 unanswered asks of /status: restarted once; calls meanwhile get a 503 at once; a recover joins it; logged');

    // 4. WDA gone for good (its port closed): the attempts back off and stop at 4, then control is "down" with the
    //    last error, calls get "control down: ..." at once, and nothing is restarted any more by itself
    const before = xcodes();
    w.close();
    const t0 = Date.now();
    await assert.rejects(m.tap('U1', 10, 10)); // refused: checked at once (3 asks), then restarted
    assert.ok(await until(() => m.controlDown('U1') !== null, 10_000), 'control down after the attempts');
    const took = Date.now() - t0;
    assert.equal(xcodes() - before, 4, 'four attempts');
    assert.ok(took >= 80 + 160 + 240, `backed off between them (${took} ms)`);
    assert.deepEqual([m.state('U1'), m.restarting('U1')], ['down', null]);
    // 2026-11-18: the runner didn't come up twice in a row (a jammed XCTest session): the device link was reset once,
    // and when that didn't help either, the phone needs a replug (said so, never "recovering" for ever)
    assert.match(m.controlDown('U1')!, /^needs replug: WebDriverAgent did not come back after 4 restarts and a reset of the device link \(last: WDA did not answer \/status within 2 s\); .*unplug its USB cable and plug it back in$/);
    assert.equal(m.needsReplug('U1'), true);
    assert.equal(m.linkHealth('U1')!.needsReplug, true);
    assert.equal(logs.filter((l) => /^\[wda-restart\] U1 the runner did not come up 2 times in a row: the XCTest session looks jammed; resetting the device link$/.test(l)).length, 1, 'one reset, after attempt 2');
    const ms2 = await fast503(m.tap('U1', 10, 10), /^control down: needs replug: WebDriverAgent did not come back after 4 restarts/, 'down');
    await assert.rejects(m.tap('U1', 10, 10), (err: HttpError) => err.extra?.needsReplug === true);
    assert.ok(ms2 < 1000);
    assert.equal(await m.probe('U1', 'watch'), false);
    const waits = logs.filter((l) => /^\[wda-restart\] U1 waiting [\d.]+ s before attempt/.test(l)).slice(-3);
    assert.deepEqual(waits.map((l) => /waiting ([\d.]+) s before attempt (\d)/.exec(l)!.slice(1).join('@')), ['0.1@2', '0.2@3', '0.2@4']);
    assert.ok(logs.some((l) => /^\[wda-restart\] U1 control down \(needs replug\) after 4 attempts in [\d.]+ s: .*stays down until a recover/.test(l)));
    await sleep(300);
    assert.equal(xcodes() - before, 4, 'no more restarts by itself');
    ok('a WDA that never comes back: 4 attempts backed off, then "control down" with the last error; calls get a 503 at once');

    // 5. a recover while down starts the attempts afresh; WDA is back
    await w.open();
    assert.equal(await m.recoverNow('U1'), 'ready');
    assert.deepEqual([m.state('U1'), m.controlDown('U1'), m.restarting('U1'), m.needsReplug('U1')], ['ready', null, null, false]);
    assert.ok(logs.some((l) => /^\[wda-restart\] U1 a recover was asked \(control was down: .*\): the attempts start afresh$/.test(l)));
    await m.tap('U1', 10, 10);

    // 6. down again, then WDA answers by itself (the last runner came up late): control is back without a recover
    w.close();
    await assert.rejects(m.tap('U1', 10, 10));
    assert.ok(await until(() => m.controlDown('U1') !== null, 10_000));
    await w.open();
    assert.ok(await until(() => m.state('U1') === 'ready', 5000), 'WDA answering again brings control back');
    assert.equal(m.controlDown('U1'), null);
    assert.ok(logs.some((l) => /^\[wda-restart\] U1 WDA answers again; control is back/.test(l)));
    await m.tap('U1', 10, 10);
    ok('a recover while down tries afresh; WDA answering again by itself brings control back');
  } catch (err) {
    origLog(logs.slice(-30).join('\n'));
    throw err;
  } finally {
    console.log = origLog;
    delete process.env.WDA_FAST;
    m.shutdown();
    w.close();
    process.chdir(prevCwd);
  }
}

// ---- 2026-11-18, leftovers that jammed XCTest: the old runner is torn down for good before a new one starts ----
// (its WDA session deleted, its xcodebuild SIGTERMed and waited for, strays for the phone killed), never two runners
// per phone, and restarts go one phone at a time.
{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reap-')));
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const w = await fakeWda();
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1000, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  type P = ChildProcess & EventEmitter & { cmd: string; udid: string; dead: boolean };
  const procs: P[] = [];
  const events: string[] = [];
  let nextPid = 5000;
  const runnersAlive = (udid: string) => procs.filter((p) => p.cmd === 'xcodebuild' && p.udid === udid && !p.dead).length;
  const spawn2 = ((cmd: string, args: string[]) => {
    const p = new EventEmitter() as P;
    const udid = cmd === 'iproxy' ? args[1]! : /id=(\S+)/.exec(args.join(' '))![1]!;
    if (cmd === 'xcodebuild') {
      assert.equal(runnersAlive(udid), 0, `never two runners for ${udid}`);
      events.push(`spawn ${udid}`);
    }
    Object.assign(p, {
      cmd, udid, dead: false, pid: nextPid++, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      kill: (sig: string) => {
        if (p.dead) return false;
        if (cmd === 'xcodebuild') events.push(`${sig} ${udid} (session deleted first: ${w.hits.some((h) => h.startsWith('DELETE /session/'))})`);
        // xcodebuild takes a moment to end its test run; a forward ends at once
        setTimeout(() => {
          p.dead = true;
          (p as { signalCode: string }).signalCode = sig;
          p.emit('exit', null, sig);
        }, cmd === 'xcodebuild' ? 150 : 0);
        return true;
      },
    });
    procs.push(p);
    return p;
  }) as unknown as typeof import('node:child_process').spawn;
  const ran: string[] = [];
  const sys = {
    real: true,
    run: async (cmd: string, args: string[]) => (ran.push(`${cmd} ${args.join(' ')}`), { ok: false, out: '' }),
    descendants: async () => [],
    signal: () => false,
    alive: (pid: number) => procs.some((p) => p.pid === pid && !p.dead),
    listeners: async () => [],
  };
  const m = new WdaManager(cfg, (u) => u, spawn2, {
    input: 300, launch: 1000, probe: 150, restart: 600, status: 100, probes: 3, probeEvery: 150,
    backoff: [80, 160, 240], attempts: 4, sessionWait: 500, recoverWait: 5000, killWait: 1000,
  }, sys);
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');
    assert.ok(ran.includes('pkill -TERM -f xcodebuild test-without-building.*id=U1') && ran.includes('pkill -TERM -f iproxy -u U1'), 'strays from an earlier server ended at the first start');
    assert.ok(!ran.some((r) => /build-for-testing/.test(r)), 'a build is never touched');
    const sid = w.current;
    events.length = 0;
    m.restartRunner('U1');
    assert.ok(await until(() => m.state('U1') === 'ready' && events.length >= 2, 5000), 'back after the restart');
    assert.deepEqual(events, ['SIGTERM U1 (session deleted first: true)', 'spawn U1'], 'session deleted, old runner ended, then the new one');
    assert.ok(w.hits.includes(`DELETE /session/${sid}`));
    assert.ok(logs.some((l) => /^\[wda U1\] old runner stopped in [\d.]+ s$/.test(l)));
    ok('a restart deletes the session, ends the old runner (waited for) and its strays, then starts the new one: never two');

    // two phones restarted together: one at a time (the second waits for the first's runner to come up or give up)
    m.start('U2'); // nothing answers on its port: it stays starting
    await sleep(50);
    events.length = 0;
    m.restartRunner('U2');
    m.restartRunner('U1');
    await sleep(300);
    assert.deepEqual(events.filter((x) => x.startsWith('spawn')), ['spawn U2'], 'U1 waits while U2 restarts');
    assert.ok(logs.some((l) => /^\[wda-restart\] U1 waiting for U2's restart to finish first \(one phone at a time\)$/.test(l)));
    assert.ok(await until(() => events.includes('spawn U1'), 5000), 'then U1');
    assert.ok(await until(() => m.state('U1') === 'ready', 5000));
    ok('restarts go one phone at a time');
  } catch (err) {
    origLog(logs.slice(-30).join('\n'));
    throw err;
  } finally {
    console.log = origLog;
    await m.shutdown(2000);
    w.close();
    process.chdir(prevCwd);
  }
}

// ---- the server: the gate's 503 at once with {error, state}; the state and why in /info ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(2);
  let gate: HttpError | null = null;
  (backend as unknown as Backend).controlGate = () => {
    if (gate) throw gate;
  };
  const server = createServer(backend, token, undefined, { watchMs: 0, focusLockMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const [a] = ((await (await fetch(`${base}/phones`, { headers: auth })).json()) as any[]).map((p) => p.udid as string);
    gate = new HttpError(503, "The phone's control link is restarting (attempt 2)", { state: 'restarting' });
    const t0 = Date.now();
    const r = await fetch(`${base}/phones/${a}/ui`, { headers: auth });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: "The phone's control link is restarting (attempt 2)", state: 'restarting' });
    assert.ok(Date.now() - t0 < 1000);
    const act = await fetch(`${base}/phones/${a}/act`, { method: 'POST', headers: auth, body: JSON.stringify({ steps: [] }) });
    assert.equal(act.status, 503);
    gate = null;
    assert.equal((await fetch(`${base}/phones/${a}/ui`, { headers: auth })).status, 200);
    const info = (await (await fetch(`${base}/phones/${a}/info`, { headers: auth })).json()) as any;
    assert.deepEqual([info.control, info.controlDown, info.restarting], ['ready', null, null]);
    const rec = await fetch(`${base}/phones/${a}/recover`, { method: 'POST', headers: auth, body: '{}' });
    assert.deepEqual(await rec.json(), { ok: true, control: 'ready' });
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('server: a restart under way answers 503 {error, state: "restarting"} at once; /info says the control state');
}

console.log(`\nall ${passed} restart checks passed`);
