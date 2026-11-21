// 2026-11-21 (2), iPhone-1 with TikTok's For You feed playing: GET /session/:id/window/size took 55 s, then /wda/locked
// (one static flag on the phone) 10 s and 43 s, and the owner's swipes came back "busy" and "no answer within 5s".
// WDA runs every route but /status and the stills on the phone's one main queue, and the routes that read the APP IN
// FRONT through accessibility (orientation, window, /wda/screen, the app's name, the tree) wait on that app, which a
// video feed leaves unanswered for tens of seconds. The server kept sending such reads in the background (the
// orientation poll every 3 s, the card, three with every new session, a recovery that remade a busy session), so the
// phone never came free. Played here on a fake WDA with ONE serial queue (a request the Mac gave up on still runs on
// it), whose app-bound routes take long while "TikTok" plays: one stuck read at most, never a stream of them; touches
// go; a recovery keeps a busy session; the screen size is read once; WDA gets accessibilityDeadline.
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
import { HttpError } from '../src/types.js';
import { ACCESSIBILITY_DEADLINE_S, appBound, INPUT_QUIET_MS, STALL_MAX_MS, STALL_MS, WdaManager } from '../src/wda.js';

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

// ---- which routes read the app in front (from WDA's own handlers: FBElementCommands, FBOrientationCommands,
// FBCustomCommands; /wda/locked is a static flag, /lotus/gesture is built at absolute coordinates) ----
{
  const yes: [string, string][] = [
    ['GET', '/session/S1/orientation'], ['GET', '/orientation'], ['GET', '/session/S1/window/size'], ['GET', '/wda/screen'],
    ['GET', '/session/S1/wda/screen'], ['GET', '/wda/activeAppInfo'], ['GET', '/source?format=json'], ['GET', '/session/S1/source'],
    ['GET', '/session/S1/element/active'], ['GET', '/session/S1/element/E1/attribute/value'], ['POST', '/session/S1/element/E1/clear'],
    ['POST', '/lotus/field'], ['GET', '/session/S1/rotation'],
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
  /** "TikTok" plays: an app-bound read takes `appMs` on the queue; `deadline`: WDA's deadline cuts it short with a 500. */
  tiktok: boolean; appMs: number; deadline: boolean; probeMs: number; close(): void;
};
const APP_RE = /^\/(session\/[^/]+\/)?(orientation|window\/size|wda\/screen|wda\/activeAppInfo|source)/;
const fakeWda = async (): Promise<Fake> => {
  const w: Fake = {
    port: 0, current: '', made: 0, hits: [], bodies: [], tiktok: false, appMs: 900, deadline: false, probeMs: 0,
    close: () => {
      server.closeAllConnections();
      server.close();
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
        queue = queue.then(() => new Promise<void>((done) => setTimeout(() => {
          send(status, v);
          done();
        }, ms)));
      };
      if (p === '/session' && req.method === 'POST') {
        w.current = `S${++w.made}`;
        return work(0, 200, { sessionId: w.current, value: { sessionId: w.current } });
      }
      if (APP_RE.test(p.split('?')[0]!) && w.tiktok) {
        if (w.deadline) return work(20, 500, { value: { error: 'unknown error', message: 'The application with process identifier 812 did not confirm its main run loop is responsive within 4.0 second(s) and is likely in an unresponsive state.' } });
        return work(w.appMs, 200, { value: p.includes('orientation') ? 'PORTRAIT' : p.includes('activeAppInfo') ? { bundleId: 'com.zhiliaoapp.musically', name: 'TikTok' } : p.includes('screen') ? { scale: 3, screenSize: { width: 428, height: 926 } } : { width: 428, height: 926 } });
      }
      if (p === '/wda/screen') return work(2, 200, { value: { scale: 3, screenSize: { width: 428, height: 926 } } });
      if (p === '/wda/activeAppInfo') return work(2, 200, { value: { bundleId: 'com.zhiliaoapp.musically', name: 'TikTok' } });
      if (p.startsWith('/source')) return work(2, 200, { value: { type: 'Application' } });
      if (p === '/wda/locked') return work(1, 200, { value: false });
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.port = (server.address() as AddressInfo).port;
  return w;
};
const fakeSpawn = (() => {
  const p = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  return p;
}) as unknown as typeof import('node:child_process').spawn;

{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-stall-'))); // data/ports.json goes here
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const w = await fakeWda();
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  // quick clocks: an orientation or size read gets 200 ms, an app that doesn't answer pauses background reads 3 s
  // (doubling up to 8 s), none for 300 ms after a touch; a touch waits 500 ms at most for its turn
  const m = new WdaManager(cfg, () => 'iPhone-1', fakeSpawn, {
    input: 300, launch: 1000, probe: 150, restart: 3000, status: 100, probes: 3, probeEvery: 100, backoff: [50, 100, 200],
    sessionWait: 1000, recoverWait: 3000, hold: 3000, laneWait: 500, orient: 200, appRead: 200, stall: 3000, stallMax: 8000, inputQuiet: 300,
  });
  m.modelOf = () => 'iPhone14,8';
  const appHits = () => w.hits.filter((h) => APP_RE.test(h.split(' ')[1]!.split('?')[0]!)).length;
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready' && m.screen('U1') !== null), 'ready');

    // 1. WDA is told to bound a read of an app that doesn't answer: in the session's capabilities and its settings
    const caps = w.bodies.find((b) => b.path === '/session')!.body;
    assert.equal(caps.capabilities.alwaysMatch.accessibilityDeadline, ACCESSIBILITY_DEADLINE_S);
    assert.equal(caps.desiredCapabilities.accessibilityDeadline, ACCESSIBILITY_DEADLINE_S);
    const settings = w.bodies.filter((b) => b.path.endsWith('/appium/settings')).pop()!.body.settings;
    assert.equal(settings.accessibilityDeadline, ACCESSIBILITY_DEADLINE_S);
    assert.deepEqual([settings.waitForIdleTimeout, settings.animationCoolOffTimeout], [0, 0]);
    // the screen's own size, read once; the app's window never asked (the screen answered)
    assert.deepEqual(m.screen('U1'), { width: 428, height: 926, scale: 3 });
    assert.equal(w.hits.filter((h) => h === 'GET /wda/screen').length, 1);
    assert.equal(w.hits.filter((h) => h.endsWith('/window/size')).length, 0, 'no window/size: the screen said its size');
    ok('WDA gets accessibilityDeadline (capability and setting); the screen size comes from the screen, once');

    // 2. TikTok's feed plays. The card caught its name before; the orientation poll asks once, gets no answer in time,
    //    and from then on no background read of the app is sent at all (it used to be one every 3 s, each holding the
    //    phone up to a minute). A touch that comes while that one read is still on the phone hears why it's busy
    assert.equal(((await m.peek('U1', '/wda/activeAppInfo')) as any)?.bundleId, 'com.zhiliaoapp.musically');
    await sleep(650); // no touch lately, and the orientation older than the poll's 600 ms
    w.tiktok = true;
    const before = appHits();
    assert.equal(await m.refreshOrientation('U1', 600), 'portrait', 'what was known');
    assert.equal(appHits() - before, 1);
    const stall = m.linkHealth('U1')!.appStall;
    assert.ok(stall && /no answer to GET \/session\/:id\/orientation within 0\.2 s/.test(stall.why ?? ''), JSON.stringify(stall));
    assert.ok(logs.some((l) => /the app in front isn't answering accessibility reads .*no background reads of it for 3 s/.test(l)));
    await assert.rejects(
      m.tap('U1', 10, 10),
      (err: HttpError) => err.status === 503 && /^iPhone-1 is busy: its WebDriverAgent is still working on an earlier request \(GET \/session\/:id\/orientation, [\d.]+ s so far, still waiting for the phone to answer it; it is reading the app in front, which isn't answering accessibility reads right now/.test(err.message),
    );
    assert.ok(await until(() => m.linkHealth('U1')!.lane.inFlight === null, 2000), 'the stuck read ends on the phone');

    // ...then a busy minute of polls, the card, fresh asks (a changed picture, a UI read) and the owner's swipes: the
    // phone gets the swipes, and not one more read of the app
    const polled = appHits();
    let taps = 0;
    const failed: string[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
      void m.refreshOrientation('U1', 600);
      void m.refreshOrientation('U1', 0);
      assert.equal(((await m.peek('U1', '/wda/activeAppInfo')) as any)?.bundleId, 'com.zhiliaoapp.musically', 'the card keeps the app it knew');
      assert.equal(await m.activeApp('U1'), null, 'an agent is told "unknown", never a guess');
      await m.tap('U1', 20, 20).then(() => taps++, (err: Error) => failed.push(err.message));
      await sleep(60);
    }
    assert.deepEqual(failed, [], 'every touch went');
    assert.ok(taps >= 8, `${taps} touches`);
    assert.equal(appHits(), polled, 'no read of the app in front while it does not answer');
    assert.equal(m.orientation('U1'), 'portrait');
    ok('an app that does not answer accessibility: one stuck read at most (a touch meanwhile hears why); then no background read of it, and every touch goes');

    // 3. a recovery asked while the phone's queue is busy: its check of the session isn't answered in time, which is
    //    a busy phone, not a session that's gone (/status names ours): the session is kept, no new one (it used to be
    //    remade, with three more reads of the app behind the same stuck work)
    const sessions = w.made;
    w.probeMs = 600;
    assert.equal(await m.recoverNow('U1'), 'ready');
    assert.equal(w.made, sessions, 'the busy session was kept');
    w.probeMs = 0;
    await sleep(700); // (the check the Mac gave up on still runs on the phone's queue)
    ok('a recovery keeps a session that is only busy (/status still names it)');

    // 4. Home (another app in front): the stall was TikTok's; the app is asked again
    await m.pressButton('U1', 'home');
    assert.equal(m.linkHealth('U1')!.appStall, null, 'Home clears it');
    w.tiktok = false;
    await sleep(350);
    const n = appHits();
    assert.equal(await m.refreshOrientation('U1', 0), 'portrait');
    assert.equal(appHits(), n + 1, 'asked again once the app changed');
    ok('Home or a launch: the stall was the old app\'s, the new one is asked');

    // 5. WDA's deadline cuts a read short (a 500 naming an unresponsive app): the same pause; it doubles while it
    //    keeps happening, and the first quick answer ends it
    w.tiktok = true;
    w.deadline = true;
    await sleep(350);
    assert.equal(await m.refreshOrientation('U1', 0), 'portrait');
    let s = m.linkHealth('U1')!.appStall!;
    assert.ok(s && /4 s deadline cut GET \/session\/:id\/orientation short/.test(s.why ?? ''), JSON.stringify(s));
    assert.ok(s.until - Date.now() <= 3000);
    (m as any).entries.get('U1').stallUntil = 0; // its pause is over: asked again, and still no answer
    assert.equal(await m.refreshOrientation('U1', 0), 'portrait');
    s = m.linkHealth('U1')!.appStall!;
    assert.ok(s && s.until - Date.now() > 3000 && s.until - Date.now() <= 6000, 'the pause doubled');
    (m as any).entries.get('U1').stallUntil = 0;
    w.tiktok = false;
    w.deadline = false;
    assert.equal(await m.refreshOrientation('U1', 0), 'portrait');
    assert.equal(m.linkHealth('U1')!.appStall, null, 'answered quickly: cleared');
    assert.ok(logs.some((l) => /the app in front answers accessibility reads again/.test(l)));
    ok('WDA\'s own deadline (a 500) pauses the background reads too; the pause doubles, a quick answer ends it');

    // 6. right after a touch the phone is being used: the poll waits (a fresh ask still goes)
    await sleep(650); // the orientation is older than the poll's 600 ms
    await m.tap('U1', 5, 5);
    const k = appHits();
    assert.equal(await m.refreshOrientation('U1', 600), 'portrait');
    assert.equal(appHits(), k, 'no poll right after a touch');
    await sleep(650);
    await m.refreshOrientation('U1', 600);
    assert.equal(appHits(), k + 1, 'polled again once the phone was left alone');
    ok('no background read of the app in front right after a touch');

    // 7. a new session on the same phone: the size it read is kept (not asked again); the orientation is asked
    const screens = w.hits.filter((h) => h === 'GET /wda/screen').length;
    w.current = 'someone-else';
    assert.equal(await m.probe('U1', 'watch'), true);
    assert.equal(w.made, sessions + 1, 'a new session');
    assert.equal(w.hits.filter((h) => h === 'GET /wda/screen').length, screens, 'the size is kept');
    assert.ok(w.hits.some((h) => h === `GET /session/S${w.made}/orientation`));
    assert.deepEqual(m.screen('U1'), { width: 428, height: 926, scale: 3 });
    ok('the screen size is read once per phone and kept across sessions');
  } finally {
    console.log = origLog;
    await m.shutdown(500);
    w.close();
    process.chdir(prevCwd);
  }
}

console.log(`\nall ${passed} stall checks passed`);
process.exit(0);
