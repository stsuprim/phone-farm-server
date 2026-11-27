// 2026-11-21 (2), iPhone-1 with TikTok's For You feed playing: GET /session/:id/window/size took 55 s, then /wda/locked
// (one static flag on the phone) 10 s and 43 s, and the owner's swipes came back "busy" and "no answer within 5s".
// WDA runs every route but /status and the stills on the phone's one main queue, and the routes that read the APP IN
// FRONT through accessibility (orientation, window, /wda/screen, the app's name, the tree) wait on that app, which a
// video feed leaves unanswered for tens of seconds.
//
// 2026-11-22: pausing those reads wasn't enough (the card's /wda/activeAppInfo still went out each time its pause or
// its 10-s quiet window ran out, and it hung WDA's main thread until iOS killed the runner). The server now never reads
// the app in front on its own. Played here on a fake WDA with ONE serial queue (a request the Mac gave up on still
// runs on it): a session, the card, the orientation, a recovery ask nothing of the app; only Lotus's own reads
// (explicit) do, each bounded, one at a time, refused while the app doesn't answer, the owner's touches going beside
// them; a stuck read never has WDA checked or restarted; a refused connection is said at once ("reconnecting") and a
// dead WDA restarted in seconds, with what xcodebuild said last kept.
process.env.INPUT_LOG = '0';
process.env.WDA_FAST = '0'; // the XCTest tap route: one request per tap
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { HttpError } from '../src/types.js';
import { ACCESSIBILITY_DEADLINE_S, APP_READ_MS, appBound, INPUT_QUIET_MS, STALL_MAX_MS, STALL_MS, WdaManager } from '../src/wda.js';

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

assert.deepEqual([ACCESSIBILITY_DEADLINE_S, STALL_MS, STALL_MAX_MS, INPUT_QUIET_MS], [4, 60_000, 300_000, 10_000]);
assert.deepEqual(APP_READ_MS, { tree: 12_000, app: 3000, orientation: 3000, element: 6000, size: 3000 });

// ---- which routes read the app in front (from WDA's own handlers: FBElementCommands, FBOrientationCommands,
// FBCustomCommands; /wda/locked is a static flag, /lotus/gesture is built at absolute coordinates) ----
{
  const yes: [string, string][] = [
    ['GET', '/session/S1/orientation'], ['GET', '/orientation'], ['GET', '/session/S1/window/size'], ['GET', '/wda/screen'],
    ['GET', '/session/S1/wda/screen'], ['GET', '/wda/activeAppInfo'], ['GET', '/source?format=json'], ['GET', '/session/S1/source'],
    ['GET', '/session/S1/element/active'], ['GET', '/session/S1/element/E1/attribute/value'], ['POST', '/session/S1/element/E1/clear'],
    ['POST', '/lotus/field'], ['GET', '/session/S1/rotation'], ['GET', '/wda/apps/list'],
  ];
  const no: [string, string][] = [
    ['GET', '/status'], ['GET', '/session/S1'], ['GET', '/wda/locked'], ['GET', '/wda/batteryInfo'], ['GET', '/session/S1/wda/batteryInfo'],
    ['GET', '/wda/device/info'], ['GET', '/screenshot'], ['GET', '/lotus/shot?scale=50'], ['POST', '/lotus/gesture'], ['POST', '/lotus/touch'],
    ['POST', '/session/S1/wda/pressButton'], ['POST', '/wda/homescreen'], ['POST', '/wda/lock'], ['POST', '/session/S1/wda/keys'],
    ['POST', '/session'], ['POST', '/session/S1/appium/settings'], ['POST', '/session/S1/wda/apps/launch'],
  ];
  for (const [m, p] of yes) assert.equal(appBound(m, p), true, `${m} ${p} reads the app in front`);
  for (const [m, p] of no) assert.equal(appBound(m, p), false, `${m} ${p} never asks the app`);
  ok('the routes that read the app in front through accessibility, and the ones that never do');
}

// ---- a fake WDA with one main queue ----
type Fake = {
  port: number; current: string; made: number; hits: string[]; bodies: { path: string; body: any }[];
  /** "TikTok" plays: a read of the app in front takes `appMs` on the queue (Infinity: never answered); `deadline`: WDA's deadline cuts it short with a 500. */
  tiktok: boolean; appMs: number; deadline: boolean; probeMs: number; up: boolean; down(): void; reopen(): Promise<void>; close(): void;
};
const fakeWda = async (): Promise<Fake> => {
  const sockets = new Set<Socket>();
  const w: Fake = {
    port: 0, current: '', made: 0, hits: [], bodies: [], tiktok: false, appMs: 900, deadline: false, probeMs: 0, up: true,
    // the runner's process gone: its port closed, every connection refused
    down: () => {
      w.up = false;
      server.close();
      for (const s of sockets) s.destroy();
    },
    reopen: async () => {
      if (w.up) return;
      w.current = '';
      await new Promise<void>((r) => server.listen(w.port, '127.0.0.1', r));
      w.up = true;
    },
    close: () => {
      w.up = false;
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
  let queue: Promise<void> = Promise.resolve(); // WDA's main queue: one route at a time, whoever stopped waiting
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const p = req.url ?? '';
      w.hits.push(`${req.method} ${p}`);
      const body = raw ? JSON.parse(raw) : null;
      w.bodies.push({ path: p, body });
      const send = (status: number, v: unknown) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      // /status answers off the main queue
      if (p === '/status') return send(200, { value: { ready: true }, sessionId: w.current || null });
      const work = (ms: number, status: number, v: unknown) => {
        queue = queue.then(() => new Promise<void>((done) => {
          if (!Number.isFinite(ms)) return; // never answered: the queue stays stuck (until the test lets it go)
          setTimeout(() => {
            send(status, v);
            done();
          }, ms);
        }));
      };
      if (p === '/session' && req.method === 'POST') {
        w.current = `S${++w.made}`;
        return work(0, 200, { sessionId: w.current, value: { sessionId: w.current } });
      }
      if (appBound(req.method ?? 'GET', p) && w.tiktok) {
        if (w.deadline) return work(20, 500, { value: { error: 'unknown error', message: 'The application with process identifier 812 did not confirm its main run loop is responsive within 4.0 second(s) and is likely in an unresponsive state.' } });
        return work(w.appMs, 200, { value: p.includes('orientation') ? 'PORTRAIT' : p.includes('activeAppInfo') ? { bundleId: 'com.zhiliaoapp.musically', name: 'TikTok' } : p.includes('screen') ? { scale: 3, screenSize: { width: 428, height: 926 } } : { type: 'Application' } });
      }
      if (p === '/wda/screen') return work(2, 200, { value: { scale: 3, screenSize: { width: 428, height: 926 } } });
      if (p === '/wda/activeAppInfo') return work(2, 200, { value: { bundleId: 'com.apple.springboard', name: 'Home Screen' } });
      if (p.startsWith('/source')) return work(2, 200, { value: { type: 'Application' } });
      if (p === '/wda/locked') return work(1, 200, { value: false });
      if (p === '/wda/homescreen') return work(1, 200, { value: null });
      const m = /^\/session\/([^/]+)(\/.*)?$/.exec(p);
      if (!m) return work(1, 404, { value: { error: 'unknown command', message: p } });
      if (m[1] !== w.current) return work(1, 404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
      const sub = m[2] ?? '';
      if (sub === '') return work(w.probeMs, 200, { value: { capabilities: {} } });
      if (sub === '/orientation') return work(2, 200, { value: 'PORTRAIT' });
      if (sub === '/window/size') return work(2, 200, { value: { width: 428, height: 926 } });
      if (sub === '/appium/settings' || sub === '/wda/tap' || sub === '/wda/pressButton') return work(2, 200, { value: null });
      work(1, 404, { value: { error: 'unknown command', message: p } });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.port = (server.address() as AddressInfo).port;
  return w;
};
let w!: Fake;
const xcodes: (ChildProcess & EventEmitter)[] = [];
const fakeSpawn = ((cmd: string) => {
  const p = new EventEmitter() as ChildProcess & EventEmitter;
  const out = new PassThrough();
  Object.assign(p, { stdout: out, stderr: new PassThrough(), kill: () => true });
  if (cmd === 'xcodebuild') {
    xcodes.push(p);
    // XCTest's account of the runner it ran, as xcodebuild prints it
    setTimeout(() => out.write('Test Suite \'All tests\' started\nt =     0.00s Start Test\n'), 5).unref();
    if (w && !w.up) setTimeout(() => void w.reopen(), 100).unref(); // a new runner: WDA answers again
  }
  return p;
}) as unknown as typeof import('node:child_process').spawn;

{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-stall-'))); // data/ports.json goes here
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  w = await fakeWda();
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  // quick clocks: an explicit read of the app gets 200 ms; an app that doesn't answer pauses reads of it 3 s (doubling
  // up to 8 s); a request never answered holds the lane 1.5 s; /status 100 ms, asked 3 times 400 ms apart
  const m = new WdaManager(cfg, () => 'iPhone-1', fakeSpawn, {
    input: 300, launch: 1000, probe: 150, restart: 3000, status: 100, probes: 3, probeEvery: 400, backoff: [50, 100, 200],
    sessionWait: 1000, recoverWait: 3000, hold: 1500, laneWait: 500, orient: 200, appRead: 200, stall: 3000, stallMax: 8000, inputQuiet: 300,
  });
  m.modelOf = () => 'iPhone14,8';
  const appHits = () => w.hits.filter((h) => appBound(h.split(' ')[0]!, h.split(' ')[1]!)).length;
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready' && m.screen('U1') !== null), 'ready');

    // 1. WDA is told to bound a read of an app that doesn't answer: in the session's capabilities and its settings;
    //    and making the session asked nothing of the app in front: the size is the model's, the phone upright
    const caps = w.bodies.find((b) => b.path === '/session')!.body;
    assert.equal(caps.capabilities.alwaysMatch.accessibilityDeadline, ACCESSIBILITY_DEADLINE_S);
    assert.equal(caps.desiredCapabilities.accessibilityDeadline, ACCESSIBILITY_DEADLINE_S);
    const settings = w.bodies.filter((b) => b.path.endsWith('/appium/settings')).pop()!.body.settings;
    assert.equal(settings.accessibilityDeadline, ACCESSIBILITY_DEADLINE_S);
    assert.deepEqual([settings.waitForIdleTimeout, settings.animationCoolOffTimeout], [0, 0]);
    assert.equal(appHits(), 0, 'no read of the app in front with a new session');
    assert.deepEqual(m.screen('U1'), { width: 428, height: 926, scale: 3 });
    assert.equal(m.orientation('U1'), 'portrait');
    ok('WDA gets accessibilityDeadline (capability and setting); a session reads nothing of the app in front (the size is the model\'s)');

    // 2. TikTok's feed plays. The card, the list's orientation, a live picture, all of them, all the time: not one
    //    read of the app reaches the phone (they get what's known), and every touch goes
    w.tiktok = true;
    let taps = 0;
    const failed: string[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
      assert.equal(await m.peek('U1', '/wda/activeAppInfo'), null, 'nothing known of the app: null, never asked');
      assert.equal(await m.refreshOrientation('U1', 0), 'portrait');
      assert.equal(await m.refreshOrientation('U1', 600), 'portrait');
      await m.tap('U1', 20, 20).then(() => taps++, (err: Error) => failed.push(err.message));
      await sleep(40);
    }
    assert.deepEqual(failed, [], 'every touch went');
    assert.ok(taps >= 8, `${taps} touches`);
    assert.equal(appHits(), 0, 'not one read of the app in front');
    // the picture says how it's turned: wide is landscape (the side last known, else landscape-left), tall portrait
    const turns: string[] = [];
    m.onOrientation = (u) => turns.push(m.orientation(u)!);
    m.noteFrame('U1', 1388, 642);
    assert.equal(m.orientation('U1'), 'landscape-left');
    assert.deepEqual(m.screen('U1'), { width: 926, height: 428, scale: 3 }, 'the size turned with it');
    m.noteFrame('U1', 642, 1388);
    assert.deepEqual(turns, ['landscape-left', 'portrait']);
    assert.equal(m.linkHealth('U1')!.orientationFrom, 'picture');
    assert.equal(appHits(), 0);
    assert.equal(m.linkHealth('U1')!.appReads.sent, 0);
    ok('an app that never answers accessibility: the card, polls and the picture ask nothing of it; every touch goes');

    // 3. Lotus reads the screen itself (phones_read): its read of the tree goes, bounded; the owner's touch meanwhile
    //    is sent at once (it used to wait its turn behind it in the lane and be dropped "busy"). 2026-11-27: the read
    //    on its way is stopped for the touch (never waited for; Lotus hears so), the journal keeps it while the phone
    //    is still on it; still on it past its own time: the app doesn't answer accessibility, so its other reads (the
    //    app's name, the orientation) are refused at once, unsent, with why
    w.appMs = 700;
    const hits0 = appHits();
    const reading = m.source('U1').then(() => 'answered', (err: Error) => err.message);
    assert.ok(await until(() => m.linkHealth('U1')!.lane.inFlight === 'GET /source', 500), 'the read is on its way');
    const sentBefore = w.hits.filter((h) => h.endsWith('/wda/tap')).length;
    const touched = m.tap('U1', 30, 30).catch((err: Error) => err.message);
    assert.ok(await until(() => w.hits.filter((h) => h.endsWith('/wda/tap')).length === sentBefore + 1, 150), 'the touch reached the phone at once');
    assert.match(await reading, /GET \/source was stopped on its way \(not waited for\) so that POST \/session\/:id\/wda\/tap could go first/);
    assert.deepEqual(m.journal('U1').map((j) => [j.label, j.state, j.appBound]).slice(0, 1), [['GET /source', 'abandoned', true]], 'the journal: the phone may still be on the read');
    assert.equal(m.linkHealth('U1')!.lane.beside, null, 'nothing goes "beside" anything any more');
    await touched;
    assert.ok(await until(() => !!m.linkHealth('U1')!.appStall, 1000), 'still on it past its own time: a stall');
    assert.equal(appHits(), hits0 + 1, 'one read sent');
    const stall = m.linkHealth('U1')!.appStall;
    assert.ok(stall && /no answer to GET \/source within 0\.2 s/.test(stall.why ?? ''), JSON.stringify(stall));
    assert.equal(await m.activeApp('U1'), null, 'the app\'s name: unknown, never a guess');
    assert.equal(await m.refreshOrientation('U1', 0, true), 'portrait', 'the orientation: as known');
    await assert.rejects(m.source('U1'), (err: HttpError) => err.status === 503 && /^iPhone-1 can't read the app in front right now: the app in front isn't answering accessibility reads/.test(err.message));
    assert.equal(appHits(), hits0 + 1, 'nothing more sent while it does not answer');
    assert.equal(m.linkHealth('U1')!.appReads.sent, 1);
    ok("Lotus's own read goes, bounded; the owner's touch stops it and goes at once; while the app doesn't answer, its reads are refused unsent");

    // 4. a read the phone never answers at all (on the journal past its hold): WDA is not checked, nothing restarted
    //    (/status answers: WDA is fine, the app in front isn't), not even for a touch stuck behind it on the phone
    const runners = xcodes.length;
    const sessions = w.made;
    (m as any).entries.get('U1').stallUntil = 0; // its pause is over: Lotus reads again
    w.appMs = Infinity;
    await assert.rejects(m.activeApp('U1').then((v) => (v === null ? Promise.reject(new Error('null')) : v)));
    const t1 = Date.now();
    await m.tap('U1', 40, 40).catch(() => {}); // (the fake's one queue is stuck: this touch waits on the phone)
    assert.ok(await until(() => m.linkHealth('U1')!.appReads.stuck === 1, 4000), 'the read was given up on');
    assert.ok(logs.some((l) => /the app in front doesn't answer accessibility; the phone may still be on it \(the journal says so\) and nothing is restarted for it/.test(l)));
    assert.ok(await until(() => logs.some((l) => /POST \/session\/:id\/wda\/tap is still behind GET \/wda\/activeAppInfo on the phone \(the app in front doesn't answer accessibility\); WDA isn't checked for it/.test(l)), 4000), 'the touch behind it checks nothing');
    assert.deepEqual([xcodes.length, w.made, m.linkHealth('U1')!.recoveries, m.state('U1')], [runners, sessions, 0, 'ready'], 'no check, no restart, the session kept');
    assert.ok(Date.now() - t1 < 4000);
    ok('a read of the app in front never answered: nothing is checked or restarted for it (WDA answers /status)');
  } finally {
    console.log = origLog;
    await m.shutdown(500);
    w.close();
    process.chdir(prevCwd);
  }
}

// ---- a fresh phone for the rest (the stuck queue above stays stuck: that's the phone's own business) ----
{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-stall2-')));
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  w = await fakeWda();
  xcodes.length = 0;
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  const m = new WdaManager(cfg, () => 'iPhone-1', fakeSpawn, {
    input: 300, launch: 1000, probe: 150, restart: 3000, status: 100, probes: 3, probeEvery: 400, backoff: [50, 100, 200],
    sessionWait: 1000, recoverWait: 3000, hold: 1500, laneWait: 500, orient: 200, appRead: 200, stall: 3000, stallMax: 8000, inputQuiet: 300,
  });
  m.modelOf = () => 'iPhone14,8';
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');

    // 5. TikTok stalls a read; Home: another app in front, the stall was TikTok's; Lotus's next read goes and says the
    //    Home Screen; the card knows it was Home (from the press itself), and that a touch came after it
    w.tiktok = true;
    w.appMs = 600;
    assert.equal(await m.activeApp('U1'), null);
    assert.ok(m.linkHealth('U1')!.appStall, 'stalled');
    await until(() => !(m as any).entries.get('U1').appInFlight, 2000);
    w.tiktok = false;
    await m.pressButton('U1', 'home');
    assert.equal(m.linkHealth('U1')!.appStall, null, 'Home clears it');
    assert.deepEqual([m.knownApp('U1')?.from, (m.knownApp('U1')?.info as any)?.bundleId, m.knownApp('U1')?.changedSince], ['home', 'com.apple.springboard', false]);
    await m.tap('U1', 5, 5);
    assert.equal(m.knownApp('U1')?.changedSince, true, 'a touch since: it may have changed');
    assert.equal(await m.activeApp('U1'), 'com.apple.springboard', "Lotus's read goes again");
    assert.equal(m.knownApp('U1')?.from, 'read');
    ok("Home clears the stall; the card knows Home from the press itself; Lotus's next read goes");

    // 6. WDA's deadline cuts a read short (a 500 naming an unresponsive app): the same pause; it doubles while it
    //    keeps happening, and the first quick answer ends it
    w.tiktok = true;
    w.deadline = true;
    assert.equal(await m.activeApp('U1'), null);
    let s = m.linkHealth('U1')!.appStall!;
    assert.ok(s && /4 s deadline cut GET \/wda\/activeAppInfo short/.test(s.why ?? ''), JSON.stringify(s));
    assert.ok(s.until - Date.now() <= 3000);
    (m as any).entries.get('U1').stallUntil = 0; // its pause is over: asked again, and still no answer
    assert.equal(await m.activeApp('U1'), null);
    s = m.linkHealth('U1')!.appStall!;
    assert.ok(s && s.until - Date.now() > 3000 && s.until - Date.now() <= 6000, 'the pause doubled');
    (m as any).entries.get('U1').stallUntil = 0;
    w.tiktok = false;
    w.deadline = false;
    assert.equal(await m.activeApp('U1'), 'com.apple.springboard');
    assert.equal(m.linkHealth('U1')!.appStall, null, 'answered quickly: cleared');
    assert.ok(logs.some((l) => /the app in front answers accessibility reads again/.test(l)));
    ok("WDA's own deadline (a 500) pauses Lotus's reads too; the pause doubles, a quick answer ends it");

    // 7. a recovery asked while the phone's queue is busy: its check of the session isn't answered in time, which is
    //    a busy phone, not a session that's gone (/status names ours): the session is kept, nothing of the app read
    const sessions = w.made;
    const reads = w.hits.filter((h) => appBound(h.split(' ')[0]!, h.split(' ')[1]!)).length;
    w.probeMs = 600;
    assert.equal(await m.recoverNow('U1'), 'ready');
    assert.equal(w.made, sessions, 'the busy session was kept');
    assert.equal(w.hits.filter((h) => appBound(h.split(' ')[0]!, h.split(' ')[1]!)).length, reads, 'and nothing of the app read');
    w.probeMs = 0;
    await sleep(700);
    ok('a recovery keeps a session that is only busy, and reads nothing of the app in front');

    // 8. WDA's process gone (its port closed: every connection refused or reset, iPhone-1's ECONNRESET). The touch that
    //    hits it hears "reconnecting" at once, the touches after it too (never queued behind the check and failed 10 s
    //    later); /status is asked 3 times ~1 s apart, then the runner is restarted; touches during the restart hear
    //    "restarting" at once; what xcodebuild said last is kept with how the runner ended
    const runners = xcodes.length;
    w.down();
    const t2 = Date.now();
    await assert.rejects(m.tap('U1', 10, 10), (err: HttpError) => err.status === 503 && (err.extra?.state === 'recovering' || err.extra?.state === 'restarting'));
    assert.ok(Date.now() - t2 < 2500, `the failed touch was answered at once (${Date.now() - t2} ms)`);
    const t3 = Date.now();
    await assert.rejects(m.tap('U1', 10, 10), (err: HttpError) => err.status === 503 && /control link is (reconnecting|restarting)/.test(err.message));
    assert.ok(Date.now() - t3 < 100, `the next touch too (${Date.now() - t3} ms), never queued behind the check`);
    assert.ok(await until(() => xcodes.length > runners, 5000), 'the dead runner restarted');
    assert.ok(Date.now() - t2 < 4000, `restarted ${Date.now() - t2} ms after WDA went (it took 12 s of /status asks)`);
    assert.ok(await until(() => m.state('U1') === 'ready', 5000), 'and ready again');
    await m.tap('U1', 10, 10);
    const end = m.linkHealth('U1')!.lastRunnerEnd!;
    assert.ok(end && /unreachable \((ECONNREFUSED|ECONNRESET)\); then \/status asked 3 times/.test(end.why), JSON.stringify(end));
    assert.ok(end.xcodebuild.some((l) => /Start Test/.test(l)), 'what xcodebuild said last is kept');
    assert.ok(logs.some((l) => /\[wda-restart\] U1 the runner ended or was given up on/.test(l)));
    ok('WDA gone: every touch hears "reconnecting"/"restarting" at once, the runner is restarted in seconds, its last words kept');
  } catch (err) {
    origLog(logs.slice(-40).join('\n'));
    throw err;
  } finally {
    console.log = origLog;
    await m.shutdown(500);
    w.close();
    process.chdir(prevCwd);
  }
}

console.log(`\nall ${passed} stall checks passed`);
process.exit(0);
