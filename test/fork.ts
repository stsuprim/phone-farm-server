// Our own WebDriverAgent build (wda/, src/fork.ts): the launch (port, token, no MJPEG), the token on every request
// and the bare answer without it, whole gestures and live touch as commands, the stock WebDriverAgent as the
// fallback, the automatic build + install with its rollback and retries, and what the vendored sources must hold.
// No Mac, no phone: a fake WebDriverAgent that behaves as the build's HTTP layer is written to.
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import { FORK_ROUTES, ForkInstaller, forkPort, ForkTokens, launchPlan, parsePorts, readForkMeta, retryAfter, RETRY_AFTER_MS, STOCK_MJPEG_PORT, STOCK_WDA_PORT, TOKEN_ENV, TOKEN_HEADER, WdaFlavor } from '../src/fork.js';
import { curvePath, seeded } from '../src/human.js';
import { MockBackend } from '../src/mock.js';
import { provisionDates, provisionTeam, WdaResigner } from '../src/resign.js';
import { createServer } from '../src/server.js';
import { FAST_TOUCH_ROUTE, gestureBody, gestureRoute, liveBody, WdaManager } from '../src/wda.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (name: string) => {
  passed++;
  process.stdout.write(`ok - ${name}${os.EOL}`); // not console.log: a part of this file captures the server's log
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
};

// ---- the launch: port, token, no MJPEG ----
{
  const cfg = { wdaProject: '/stock/wda', wdaDerivedData: '/stock/build', wdaBasePort: 8100, mjpegBasePort: 9100 };
  const stock = launchPlan(cfg, 'U1', 2, null);
  assert.equal(stock.flavor, 'stock');
  assert.deepEqual(stock.wda, { local: 8102, device: STOCK_WDA_PORT }, "the stock WDA keeps its default port on the phone, forwarded to this phone's Mac port");
  assert.deepEqual(stock.mjpeg, { local: 9102, device: STOCK_MJPEG_PORT });
  assert.deepEqual(stock.env, { TEST_RUNNER_USE_PORT: '8100', TEST_RUNNER_MJPEG_SERVER_PORT: '9100' });
  assert.ok(stock.args.includes(path.join('/stock/wda', 'WebDriverAgent.xcodeproj')) && stock.args.includes('/stock/build'));

  const fork = launchPlan(cfg, 'U1', 2, { project: '/repo/wda', derivedData: '/fork/build', port: 28102, token: 'T'.repeat(43) });
  assert.equal(fork.flavor, 'fork');
  assert.deepEqual(fork.wda, { local: 28102, device: 28102 }, 'our build listens on its own high port, the same on the phone and the Mac');
  assert.equal(fork.mjpeg, null, 'no MJPEG forward');
  assert.deepEqual(fork.env, { TEST_RUNNER_USE_PORT: '28102', [`TEST_RUNNER_${TOKEN_ENV}`]: 'T'.repeat(43) }, 'the port and the token, and nothing about MJPEG');
  assert.ok(!Object.keys(fork.env).some((k) => /MJPEG/i.test(k)));
  assert.deepEqual(fork.args.slice(0, 1), ['test-without-building']);
  assert.ok(fork.args.includes(path.join('/repo/wda', 'WebDriverAgent.xcodeproj')) && fork.args.includes('/fork/build') && fork.args.includes('id=U1'));

  // a port per phone: base + index, or the phone's own
  assert.deepEqual([forkPort(28100, 0, 'A'), forkPort(28100, 1, 'B'), forkPort(28100, 7, 'C')], [28100, 28101, 28107]);
  assert.equal(forkPort(28100, 1, 'B', { B: 40001 }), 40001);
  assert.deepEqual(parsePorts('AAA-1=30001, BBB_2:30002 junk 80=1 CCC=99999'), { 'AAA-1': 30001, BBB_2: 30002 });
  assert.deepEqual(parsePorts(undefined), {});
  ok('launch: the stock WDA on 8100/9100, ours on its own port with the token and no MJPEG; a port per phone');
}

// ---- the tokens: one per phone, kept in the data folder, never the same twice ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fork-tok-'));
  const file = path.join(dir, 'data', 'wda-tokens.json');
  const t = new ForkTokens(file);
  const a = t.get('U1');
  const b = t.get('U2');
  assert.ok(a.length >= 32 && b.length >= 32 && a !== b);
  assert.equal(t.get('U1'), a, 'a phone keeps its token');
  assert.equal(new ForkTokens(file).get('U1'), a, '...across restarts');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['U1', 'U2']);
  assert.notEqual(new ForkTokens().get('U1'), new ForkTokens().get('U1'), 'made at random');
  ok('tokens: one per phone, random, kept in data/wda-tokens.json');
}

// ---- a fake WebDriverAgent ----
// `token` set: it behaves as our build's HTTP layer is written to (wda/WebDriverAgentLib/Routing/FBHTTPServer.m):
// without the right X-Lotus-Token the answer is a bare 404 with no body and nothing of WDA in it; only the listed
// routes are served. `token` null: a stock WDA (no token asked, MJPEG-era routes, no /lotus/).
interface Fake {
  port: number;
  token: string | null;
  hits: { method: string; path: string; token: string | undefined; body: any }[];
  failedOnce: string | null;
  close(): void;
}
const fakeWda = async (token: string | null): Promise<Fake> => {
  const w: Fake = { port: 0, token, hits: [], failedOnce: null, close: () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const p = req.url ?? '';
      const given = req.headers[TOKEN_HEADER] as string | undefined;
      let body: any = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }
      w.hits.push({ method: req.method ?? '', path: p, token: given, body });
      if (w.token && given !== w.token) {
        res.writeHead(404, { 'content-length': '0', connection: 'close' });
        return void res.end();
      }
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      const unknown = () => json(404, { value: { error: 'unknown command', message: p } });
      if (p === '/status') return json(200, { value: { ready: true }, sessionId: 'S1' });
      if (p === '/session') return json(200, { sessionId: 'S1', value: { sessionId: 'S1' } });
      if (p === '/wda/screen') return json(200, { value: { scale: 3 } });
      if (p === '/session/S1') return json(200, { value: { capabilities: {} } });
      if (p === '/session/S1/window/size') return json(200, { value: { width: 390, height: 844 } });
      if (p === '/session/S1/orientation') return json(200, { value: 'PORTRAIT' });
      if (p === '/session/S1/appium/settings') return json(200, { value: null });
      if (p === '/session/S1/actions') return json(200, { value: null });
      if (!w.token) return p === FAST_TOUCH_ROUTE ? json(200, { value: { queued: 1, lotus: 1 } }) : unknown();
      if (p === FORK_ROUTES.info) return json(200, { value: { lotus: 1, upstream: 'v16.15.3', mjpeg: false } });
      if (p === FORK_ROUTES.gesture) return json(200, { value: { queued: 1, lotus: 1 } });
      if (p === FORK_ROUTES.touch) {
        const failed = w.failedOnce;
        w.failedOnce = null;
        return json(200, { value: { lotus: 1, down: body?.phase !== 'up', waiting: 0, ...(failed ? { failed } : {}) } });
      }
      if (p.startsWith(`${FORK_ROUTES.shot}?`)) return json(200, { value: { lotus: 1, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') } });
      if (p === FORK_ROUTES.selftest) return json(200, { value: { lotus: 1, tested: true, mode: 2, notes: ['mode 1: no', 'mode 2: works'] } });
      unknown();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.port = (server.address() as AddressInfo).port;
  w.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return w;
};

/** One request straight to a fake, with any headers: status, headers, body. */
const ask = (port: number, p: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });

interface Spawned {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  p: ChildProcess & EventEmitter;
}
const spawned: Spawned[] = [];
/** What a new xcodebuild does: nothing (the fake WDA is already listening), or exit as a refused install would. */
let xcodeExits: ((s: Spawned) => { code: number; says: string } | null) | null = null;
const fakeSpawn = ((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
  const p = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(p, { stdout, stderr, kill: () => true });
  const s: Spawned = { cmd, args, env: opts?.env ?? {}, p };
  spawned.push(s);
  const exit = cmd === 'xcodebuild' ? xcodeExits?.(s) : null;
  if (exit) {
    setTimeout(() => {
      stderr.write(`${exit.says}\n`);
      setTimeout(() => p.emit('exit', exit.code), 20);
    }, 60);
  }
  return p;
}) as unknown as typeof import('node:child_process').spawn;

// ---- the manager: stock and ours, the token, gestures, live touch, stills, the switch and its failure ----
{
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fork-'))); // data/ports.json goes here
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const TOKEN = new ForkTokens().get('U1');
  const stock = await fakeWda(null);
  const ours = await fakeWda(TOKEN);
  const cfg = { wdaBasePort: stock.port, mjpegBasePort: stock.port + 1, wdaProject: '/stock/wda', wdaDerivedData: '/stock/build', wdaLiveTouch: 'auto' } as unknown as Config;
  const m = new WdaManager(cfg, (u) => u, fakeSpawn, { input: 400, launch: 1000, probe: 400, restart: 5000 });
  let liveMode = 0;
  const failures: string[] = [];
  let atStart: WdaFlavor = 'stock';
  m.fork = {
    flavorAtStart: () => atStart,
    launch: () => ({ project: '/repo/wda', derivedData: '/fork/build', port: ours.port, token: TOKEN }),
    failed: (_u, why) => void failures.push(why),
    liveMode: () => liveMode,
  };
  try {
    // without the token (or with a wrong one) our build says nothing of itself: a bare 404, no body, no JSON, closed
    for (const headers of [{}, { [TOKEN_HEADER]: 'wrong' }, { [TOKEN_HEADER]: `${TOKEN}x` }, { authorization: `Bearer ${TOKEN}` }]) {
      for (const p of ['/status', FORK_ROUTES.info, '/session', '/nope']) {
        const r = await ask(ours.port, p, headers as Record<string, string>);
        assert.deepEqual([r.status, r.body, r.headers['content-type'] ?? null, r.headers.server ?? null], [404, '', null, null], `${p} without a valid token`);
      }
    }
    const good = await ask(ours.port, '/status', { [TOKEN_HEADER]: TOKEN });
    assert.equal(good.status, 200);
    ok('token: no token or a wrong one gets a bare 404 with no body whatever was asked; the right one is answered');

    // a phone on the stock WDA: launched as before, never sent a token, MJPEG there, whole gestures by the old route
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'the stock WDA is ready');
    assert.equal(m.flavor('U1'), 'stock');
    assert.equal(m.forkInfo('U1'), null);
    assert.equal(m.mjpegAvailable('U1'), true);
    assert.equal(m.mjpegPort('U1'), stock.port + 1);
    const x0 = spawned.find((s) => s.cmd === 'xcodebuild')!;
    assert.deepEqual([x0.env.TEST_RUNNER_USE_PORT, x0.env.TEST_RUNNER_MJPEG_SERVER_PORT, x0.env[`TEST_RUNNER_${TOKEN_ENV}`]], ['8100', '9100', undefined]);
    assert.deepEqual(spawned.filter((s) => s.cmd === 'iproxy').map((s) => s.args[2]), [`${stock.port}:8100`, `${stock.port + 1}:9100`]);
    assert.ok(stock.hits.length > 0 && stock.hits.every((h) => h.token === undefined), 'a stock WDA is never sent the token');
    assert.ok(!stock.hits.some((h) => h.path.startsWith('/lotus/')), '...nor asked our routes');
    assert.equal(await m.actions('U1', [[10, 20, 0], [10, 200, 300]]), 'wda-fast');
    assert.equal(stock.hits.at(-1)!.path, FAST_TOUCH_ROUTE);
    assert.match(m.liveWhy('U1') ?? '', /stock WebDriverAgent cannot hold a finger down/);
    assert.equal(await m.forkWorks('U1', 500), "our build isn't up");
    await assert.rejects(m.liveTouch('U1', 'down', 10, 10), /stock WebDriverAgent/);
    await assert.rejects(m.shot('U1', 50, 50), /isn't up/);
    ok('fallback: a stock WDA runs as before (8100/9100, no token, the old gesture route, no live touch)');

    // the switch to our build: a new runner from our project, its own port, the token in its environment
    const before = spawned.length;
    const sw = await m.switchFlavor('U1', 'fork', 8000);
    assert.deepEqual(sw, { ok: true });
    assert.equal(m.flavor('U1'), 'fork');
    assert.deepEqual(m.forkInfo('U1'), { lotus: 1, upstream: 'v16.15.3' });
    const x1 = spawned.slice(before).find((s) => s.cmd === 'xcodebuild')!;
    assert.deepEqual([x1.env.TEST_RUNNER_USE_PORT, x1.env[`TEST_RUNNER_${TOKEN_ENV}`], x1.env.TEST_RUNNER_MJPEG_SERVER_PORT], [String(ours.port), TOKEN, undefined]);
    assert.ok(x1.args.includes(path.join('/repo/wda', 'WebDriverAgent.xcodeproj')) && x1.args.includes('/fork/build'));
    assert.deepEqual(spawned.slice(before).filter((s) => s.cmd === 'iproxy').map((s) => s.args[2]), [`${ours.port}:${ours.port}`], 'one forward, to its own port: nothing to 9100');
    assert.ok(ours.hits.filter((h) => h.path !== '/status' || h.token).length > 0);
    const mine = ours.hits.slice(-6);
    assert.ok(mine.every((h) => h.token === TOKEN), 'every request to our build carries the token');
    assert.equal(m.mjpegAvailable('U1'), false);
    assert.throws(() => m.mjpegPort('U1'), /no MJPEG/);

    // ...and it's kept only if it also does the work: a session, the screen's size, a still
    assert.equal(await m.forkWorks('U1', 3000), null);
    assert.deepEqual(m.screen('U1'), { width: 390, height: 844, scale: 3 });

    // a whole gesture is one command: a natural swipe's curve goes whole and the phone plays it
    const curve = curvePath([195, 700], [195, 200], 330, seeded(7));
    assert.equal(await m.actions('U1', curve), 'wda-fast');
    const g = ours.hits.at(-1)!;
    assert.deepEqual([g.method, g.path], ['POST', FORK_ROUTES.gesture]);
    assert.equal(g.body.orientation, 1);
    assert.equal(g.body.points.length, curve.length, 'every point of the curve, in one command');
    assert.deepEqual([g.body.points[0], g.body.points.at(-1)], [[195, 700, 0], [195, 200, 330]]);
    assert.equal(await m.tap('U1', 100, 100, 80), 'wda-fast');
    assert.deepEqual(ours.hits.at(-1)!.body, { hold: 80, points: [[100, 100, 0]], orientation: 1 });
    assert.equal(gestureRoute('fork'), '/lotus/gesture');
    assert.equal(gestureRoute('stock'), '/wda/lotus/touch');
    assert.deepEqual(gestureBody([[1, 2, 0], [3, 4, 50]]), { points: [[1, 2, 0], [3, 4, 50]], orientation: 1 });
    assert.deepEqual(liveBody('move', [12.5, 40], 2), { phase: 'move', x: 12.5, y: 40, mode: 2, orientation: 1 });
    ok('gestures: one command each on our build (POST /lotus/gesture with the whole curve), the token on every request');

    // live touch: only with the mode the phone's own self-test found; a finger held across requests
    assert.match(m.liveWhy('U1') ?? '', /self-test/);
    await assert.rejects(m.liveTouch('U1', 'down', 10, 10), /self-test/);
    assert.deepEqual(await m.selftest('U1'), { tested: true, mode: 2, why: null, notes: ['mode 1: no', 'mode 2: works'] });
    liveMode = 2;
    assert.equal(m.liveWhy('U1'), null);
    const n = ours.hits.length;
    await m.liveTouch('U1', 'down', 100, 300);
    await m.liveTouch('U1', 'move', 100, 320.26);
    await m.liveTouch('U1', 'move', 100, 350);
    await m.liveTouch('U1', 'up', 100, 350);
    assert.deepEqual(ours.hits.slice(n).map((h) => [h.path, h.body.phase, h.body.x, h.body.y, h.body.mode, h.body.orientation]), [
      ['/lotus/touch', 'down', 100, 300, 2, 1], ['/lotus/touch', 'move', 100, 320.3, 2, 1], ['/lotus/touch', 'move', 100, 350, 2, 1], ['/lotus/touch', 'up', 100, 350, 2, 1],
    ], 'down, the moves in order, up: one contact, each event its own request');
    // 2026-11-17, mode 4 (segmented, src/segments.ts): no /lotus/touch at all; the drag goes in short whole gestures
    // while it happens (the first one before the finger lifts), each starting where the last ended
    liveMode = 4;
    const n4 = ours.hits.length;
    await m.liveTouch('U1', 'down', 100, 300);
    assert.equal(ours.hits.length, n4, 'a press alone sends nothing yet (a tap or a long press goes whole)');
    await sleep(90);
    await m.liveTouch('U1', 'move', 100, 330);
    assert.equal(ours.hits.length, n4 + 1, 'a segment goes while the finger is still down');
    await sleep(250);
    await m.liveTouch('U1', 'up', 100, 360);
    const segs = ours.hits.slice(n4);
    assert.deepEqual(segs.map((h) => h.path), ['/lotus/gesture', '/lotus/gesture']);
    const [s1, s2] = segs.map((h) => h.body as { points: number[][]; hold: number; orientation: number });
    assert.deepEqual([s1!.points[0], s1!.points.at(-1)!.slice(0, 2), s1!.hold, s1!.orientation], [[100, 300, 0], [100, 330], 30, 1], 'the first: from the press, still a moment before its lift');
    assert.ok(s1!.points.at(-1)![2]! >= 80, 'at the pace it was made');
    assert.deepEqual([s2!.points[0], s2!.points.at(-1)!.slice(0, 2), s2!.hold], [[100, 330, 0], [100, 360], 0], 'the last: from where the first ended, lifting as the finger did');
    liveMode = 2;
    // XCTest refused a live record on the phone: said once, and live touch is left alone until the runner restarts
    ours.failedOnce = 'XCTest refused the record';
    await assert.rejects(m.liveTouch('U1', 'down', 5, 5), /could not play the live touch/);
    assert.match(m.liveWhy('U1') ?? '', /stopped working/);
    assert.ok(await until(() => ours.hits.at(-1)!.body?.phase === 'up'), '...and whatever reached the screen is lifted at once');
    // WDA_LIVE_TOUCH=off
    (cfg as { wdaLiveTouch: string }).wdaLiveTouch = 'off';
    assert.match(m.liveWhy('U1') ?? '', /turned off/);
    (cfg as { wdaLiveTouch: string }).wdaLiveTouch = 'auto';
    ok('live touch: off until the self-test finds a mode, then down/move/up go as they come with that mode; a failure turns it off');

    // a still from our build (it has no MJPEG stream)
    const jpeg = await m.shot('U1', 50, 50);
    assert.deepEqual([...jpeg], [0xff, 0xd8, 0xff, 0xd9]);
    assert.equal(ours.hits.at(-1)!.path, '/lotus/shot?scale=50&quality=50');
    ok('stills: a JPEG from GET /lotus/shot');

    // back to stock, then a switch whose install the phone refuses: said with why, nothing left hanging
    assert.deepEqual(await m.switchFlavor('U1', 'stock', 8000), { ok: true });
    assert.equal(m.flavor('U1'), 'stock');
    assert.ok(await until(() => m.state('U1') === 'ready'));
    xcodeExits = (s) => (s.args.includes('/fork/build') ? { code: 65, says: 'error: Unable to install: the device is locked' } : null);
    const bad = await m.switchFlavor('U1', 'fork', 8000);
    assert.equal(bad.ok, false);
    assert.match(bad.why ?? '', /xcodebuild exited \(65\).*device is locked/);
    assert.equal(failures.length, 0, "a failed switch is the caller's to roll back");
    assert.deepEqual(await m.switchFlavor('U1', 'stock', 8000), { ok: true });
    assert.ok(await until(() => m.state('U1') === 'ready'), 'the stock WDA is back');
    ok('switch: to our build and back; a refused install is said with what xcodebuild said, and stock comes back');

    // our build stops starting by itself (not during an install): after three tries the stock one comes back
    m.stop('U1');
    atStart = 'fork';
    xcodeExits = (s) => (s.args.includes('/fork/build') ? { code: 70, says: 'error: Failed to launch the test runner' } : null);
    m.start('U1');
    // (the restarts back off 2 s, then 4 s: an action in between starts the next try at once, as in real use)
    const kick = setInterval(() => void m.probe('U1', 'test').catch(() => {}), 150);
    const gaveUp = await until(() => failures.length === 1, 20_000);
    if (!gaveUp) origLog(logs.slice(-25).join(' ## '));
    assert.ok(gaveUp, 'given up on after three tries');
    clearInterval(kick);
    assert.match(failures[0]!, /xcodebuild exited \(70\)/);
    assert.equal(m.flavor('U1'), 'stock');
    assert.ok(await until(() => m.state('U1') === 'ready', 20_000), 'the stock WDA runs again');
    xcodeExits = null;
    ok('rollback: our build failing to start three times in a row puts the stock WDA back by itself');

    assert.ok(!logs.some((l) => l.includes(TOKEN)), 'the token is never logged');
    assert.ok(logs.some((l) => /starting our own build \(wda :\d+ on the Mac and the phone, token set, no MJPEG\)/.test(l)));
    ok('the log says which build starts and never the token');
  } finally {
    console.log = () => {}; // a check still on its way when the fakes close may say something: left unsaid
    m.shutdown();
    stock.close();
    ours.close();
    process.chdir(prevCwd);
  }
}

// ---- the installer: a new version is installed once, by itself; failures roll back and are tried again later ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fork-inst-'));
  const file = path.join(dir, 'wda-fork.json');
  let now = 1_000_000_000_000;
  const calls: string[] = [];
  const logs: string[] = [];
  let buildOk = true;
  let forkStarts = true;
  let stockBack = true;
  let selftest: { tested: boolean; mode: number; why?: string } = { tested: true, mode: 1 };
  let signed = 0;
  const make = (version: number | null, enabled = true) =>
    new ForkInstaller({
      file, meta: version ? { version, upstream: 'v16.15.3' } : null, enabled, tokens: new ForkTokens(), project: '/repo/wda', derivedData: '/fork/build',
      port: (u) => (u === 'A' ? 28100 : 28101),
      build: async (u) => (calls.push(`build ${u}`), buildOk ? { ok: true, log: '** TEST BUILD SUCCEEDED **' } : { ok: false, log: 'x\nerror: No signing certificate "iOS Development" found\ny' }),
      switchTo: async (u, f) => {
        calls.push(`switch ${u} ${f}`);
        if (f === 'fork') return forkStarts ? { ok: true } : { ok: false, why: 'xcodebuild exited (65): the device is locked' };
        return stockBack ? { ok: true } : { ok: false, why: 'WebDriverAgent did not answer within 240 s' };
      },
      selftest: async (u) => (calls.push(`selftest ${u}`), selftest),
      devices: async () => ['A', 'B'],
      prepare: async (u) => void calls.push(`wake ${u}`),
      signed: () => void signed++,
      now: () => now, tickMs: 0, log: (m) => void logs.push(m),
    });

  // a version lands: every plugged-in phone gets it, one at a time, stock running until ours answers
  let f = make(1);
  assert.deepEqual([f.flavorAtStart('A'), f.due('A'), f.liveMode('A')], ['stock', true, 0]);
  await f.tick();
  assert.deepEqual([...calls], [
    'wake A', 'build A', 'wake A', 'switch A fork', 'wake A', 'selftest A',
    'wake B', 'build B', 'wake B', 'switch B fork', 'wake B', 'selftest B',
  ]);
  assert.equal(signed, 2, 'the re-sign schedule hears of each fresh sign');
  let st = f.status();
  assert.deepEqual([st.enabled, st.version, st.upstream, st.problem], [true, 1, 'v16.15.3', null]);
  assert.deepEqual([st.perDevice.A!.state, st.perDevice.A!.version, st.perDevice.A!.reason, st.perDevice.A!.attempts, st.perDevice.A!.port, st.perDevice.B!.port], ['fork', 1, null, 0, 28100, 28101]);
  assert.deepEqual([st.perDevice.A!.live?.tested, st.perDevice.A!.live?.mode], [true, 1]);
  assert.deepEqual([f.flavorAtStart('A'), f.due('A'), f.liveMode('A')], ['fork', false, 1]);
  // ...once: nothing more happens while the version stays
  calls.length = 0;
  await f.tick();
  await f.tick();
  assert.deepEqual([...calls], [], 'installed once, not again');
  // ...and it's remembered across a restart of the server
  f = make(1);
  assert.deepEqual([f.flavorAtStart('A'), f.due('A'), f.liveMode('B')], ['fork', false, 1]);
  await f.tick();
  assert.deepEqual([...calls], []);
  ok('install: a new version is built, signed and switched to on each phone once, by itself; kept across restarts');

  // a newer version in the repo: installed right away, on the next check
  f = make(2);
  assert.equal(f.due('A'), true);
  assert.equal(f.flavorAtStart('A'), 'fork', 'the phone starts on the build it has until the new one is in');
  await f.tick();
  assert.deepEqual(calls.filter((c) => c.startsWith('build')), ['build A', 'build B']);
  assert.equal(f.status().perDevice.A!.version, 2);
  ok('install: a newer version in the repo is detected and installed once');

  // the build fails: the stock WDA keeps running (no switch), the reason is said, tried again after a wait that grows
  calls.length = 0;
  buildOk = false;
  f = make(3);
  await f.tick();
  assert.deepEqual([...calls], ['wake A', 'build A', 'wake B', 'build B'], 'no switch without a good build');
  st = f.status();
  assert.deepEqual([st.perDevice.A!.state, st.perDevice.A!.attempts, st.perDevice.A!.version], ['waiting', 1, 2]);
  assert.match(st.perDevice.A!.reason ?? '', /the build failed: Xcode is not signed in to the Apple ID/);
  assert.equal(st.perDevice.A!.nextTryAt, new Date(now + RETRY_AFTER_MS[0]!).toISOString());
  calls.length = 0;
  await f.tick();
  assert.deepEqual([...calls], [], 'not before its wait is over');
  now += RETRY_AFTER_MS[0]! + 1;
  await f.tick();
  assert.deepEqual(calls.filter((c) => c.startsWith('build')), ['build A', 'build B']);
  assert.equal(f.status().perDevice.A!.attempts, 2);
  assert.equal(f.status().perDevice.A!.nextTryAt, new Date(now + RETRY_AFTER_MS[1]!).toISOString());
  assert.deepEqual([retryAfter(1), retryAfter(2), retryAfter(99)], [RETRY_AFTER_MS[0], RETRY_AFTER_MS[1], RETRY_AFTER_MS.at(-1)]);
  ok('retry: a failed build leaves the stock WDA running, says why, and is tried again with a growing wait');

  // our build is installed but doesn't start (a locked phone): the stock WDA is put back, and it's tried again later
  calls.length = 0;
  buildOk = true;
  forkStarts = false;
  now += RETRY_AFTER_MS[1]! + 1;
  await f.tick();
  assert.deepEqual(calls.slice(0, 5), ['wake A', 'build A', 'wake A', 'switch A fork', 'switch A stock'], 'rolled back to stock at once');
  st = f.status();
  assert.deepEqual([st.perDevice.A!.state, st.perDevice.A!.attempts], ['rolled-back', 3]);
  assert.match(st.perDevice.A!.reason ?? '', /our build did not start \(xcodebuild exited \(65\): the device is locked\)$/);
  assert.equal(f.flavorAtStart('A'), 'stock');
  // ...and when even the stock one doesn't come back, that's said too
  stockBack = false;
  now += RETRY_AFTER_MS[2]! + 1;
  await f.tick();
  assert.match(f.status().perDevice.A!.reason ?? '', /the stock WebDriverAgent did not come back either \(WebDriverAgent did not answer within 240 s\)/);
  // the phone wakes, the next try takes
  stockBack = true;
  forkStarts = true;
  now += RETRY_AFTER_MS[3]! + 1;
  await f.tick();
  st = f.status();
  assert.deepEqual([st.perDevice.A!.state, st.perDevice.A!.version, st.perDevice.A!.attempts, st.perDevice.A!.reason, st.perDevice.A!.nextTryAt], ['fork', 3, 0, null, null]);
  ok('rollback: our build that does not start is replaced by the stock WDA at once, with the reason, and tried again later');

  // our build stops starting later on (the WDA supervisor fell back to stock): noted, and reinstalled after the wait
  f.failed('A', 'xcodebuild exited (70)');
  assert.deepEqual([f.status().perDevice.A!.state, f.due('A'), f.flavorAtStart('A')], ['rolled-back', false, 'stock']);
  now += RETRY_AFTER_MS[0]! + 1;
  assert.equal(f.due('A'), true);

  // the self-test couldn't run (a dark phone): tried again later, a few times; live touch stays off meanwhile
  calls.length = 0;
  selftest = { tested: false, mode: 0, why: 'the WebDriverAgent app could not come to the front' };
  await f.tick();
  assert.equal(f.liveMode('A'), 0);
  assert.deepEqual([f.status().perDevice.A!.live?.tested, f.status().perDevice.A!.live?.tries], [false, 1]);
  calls.length = 0;
  await f.tick();
  assert.ok(!calls.includes('selftest A'), 'not again at once');
  now += 10 * 60_000 + 1;
  selftest = { tested: true, mode: 3 };
  await f.tick();
  assert.ok(calls.includes('selftest A'));
  assert.equal(f.liveMode('A'), 3);
  // a self-test that ran and found nothing: drags stay whole gestures, and it isn't run over and over
  selftest = { tested: true, mode: 0 };
  f = make(4);
  await f.tick();
  assert.equal(f.liveMode('A'), 0);
  assert.match(f.status().perDevice.A!.live?.why ?? '', /no live-touch mode worked/);
  calls.length = 0;
  now += 60 * 60_000;
  await f.tick();
  assert.deepEqual([...calls], []);
  ok('self-test: its mode is kept and used; one that could not run is tried again later; one that found nothing stays off');

  // turned off, or nothing to build from: the stock WDA stays, and /api/wda says why
  calls.length = 0;
  const off = make(5, false);
  await off.tick();
  assert.deepEqual([...calls], []);
  assert.equal(off.flavorAtStart('A'), 'stock');
  assert.match(off.status().problem ?? '', /WDA_FORK=false/);
  assert.deepEqual([off.status().perDevice.A!.state, off.status().perDevice.A!.reason], ['stock', 'our build is turned off: the stock WebDriverAgent runs'], 'a phone that had our build goes back to stock, and says why');
  // ...and on again: it's installed again
  calls.length = 0;
  const on = make(5);
  assert.equal(on.due('A'), true);
  assert.match(make(null).status().problem ?? '', /LOTUS_FORK\.json is missing/);
  // the two switches in wda/LOTUS_FORK.json (they reach the Mac with a push)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fork-meta-'));
  fs.mkdirSync(path.join(tmp, 'wda'));
  fs.writeFileSync(path.join(tmp, 'wda', 'LOTUS_FORK.json'), JSON.stringify({ version: 3, upstream: 'v1.2.3', enabled: false, liveTouch: 'off' }));
  assert.deepEqual(readForkMeta(tmp), { version: 3, upstream: 'v1.2.3', enabled: false, liveTouch: 'off' });
  fs.writeFileSync(path.join(tmp, 'wda', 'LOTUS_FORK.json'), JSON.stringify({ version: 3, upstream: 'v1.2.3' }));
  assert.deepEqual(readForkMeta(tmp), { version: 3, upstream: 'v1.2.3', enabled: true, liveTouch: 'auto' });
  fs.writeFileSync(path.join(tmp, 'wda', 'LOTUS_FORK.json'), '{"version": 0}');
  assert.equal(readForkMeta(tmp), null);
  assert.ok(logs.some((l) => /A: our WebDriverAgent v1 is installed and answering/.test(l)) && logs.some((l) => /rolled back to the stock WebDriverAgent/.test(l)), 'the server log says each phone\'s outcome');
  ok('off or unavailable: nothing is installed and the status says why; the log says each phone\'s state and reason');
}

// ---- the re-sign: the profile that expires first among the builds in use; /api/wda carries the fork's state ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fork-sign-'));
  const plist = (created: string, expires: string) => `junk<key>CreationDate</key>\n<date>${created}</date>junk<key>ExpirationDate</key><date>${expires}</date>junk`;
  const stockFile = path.join(dir, 'stock.mobileprovision');
  const forkFile = path.join(dir, 'fork.mobileprovision');
  fs.writeFileSync(stockFile, plist('2026-11-14T03:00:00Z', '2026-11-21T03:00:00Z'));
  fs.writeFileSync(forkFile, plist('2026-11-16T12:00:00Z', '2026-11-23T12:00:00Z'));
  assert.equal(provisionDates(fs.readFileSync(forkFile)).expiresAt, Date.parse('2026-11-23T12:00:00Z'));
  let files = [stockFile];
  const now = Date.parse('2026-11-16T12:30:00Z');
  const r = new WdaResigner({
    run: async () => ({ ok: true, log: '' }), devices: async () => ['A'], liveViewers: () => 0, tickMs: 0, now: () => now,
    provisionFile: () => files,
  });
  assert.equal(r.status().expiresAt, '2026-11-21T03:00:00.000Z');
  // every phone moved to our build, signed just now: the schedule goes by its profile
  files = [forkFile];
  r.refresh();
  assert.deepEqual([r.status().signedAt, r.status().expiresAt], ['2026-11-16T12:00:00.000Z', '2026-11-23T12:00:00.000Z']);
  // one phone still on the stock build signed earlier: its profile runs out first, so it's the one that counts
  files = [forkFile, stockFile];
  r.refresh();
  assert.deepEqual([r.status().signedAt, r.status().expiresAt], ['2026-11-14T03:00:00.000Z', '2026-11-21T03:00:00.000Z']);
  assert.equal(provisionTeam('<key>TeamIdentifier</key>\n\t<array>\n\t\t<string>AB12CD34EF</string>\n\t</array>'), 'AB12CD34EF', 'the team is read from the built profile');
  assert.equal(provisionTeam('nothing'), null);
  ok('re-sign: the profile that expires first among the builds in use sets the schedule; the team comes from the built profile');

  // GET /api/wda (and /wda) says our build's state per phone, beside the signing
  const backend = new MockBackend(1);
  const token = 'fork-test-token-0123456789';
  const status = { enabled: true, version: 1, upstream: 'v16.15.3', problem: null, perDevice: { A: { state: 'rolled-back', reason: 'our build did not start (the device is locked)', attempts: 1 } } };
  const server = createServer(backend, token, undefined, { fork: { status: () => status }, watchMs: 0 });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  try {
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const p of ['/api/wda', '/wda']) {
      const j = (await (await fetch(`http://${host}${p}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { fork?: unknown; state?: string };
      assert.deepEqual(j.fork, status);
      assert.equal(j.state, 'unavailable', 'the signing part is as before (mock mode has none)');
    }
    assert.equal((await fetch(`http://${host}/api/wda`)).status, 401);
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('GET /api/wda: the state and the reason per phone');
}

// ---- the vendored sources: what our build must hold (it can't be compiled here; this guards the changes themselves) ----
{
  const wda = path.join(ROOT, 'wda');
  const read = (...p: string[]) => fs.readFileSync(path.join(wda, ...p), 'utf8');
  const meta = readForkMeta(ROOT);
  assert.ok(meta && meta.version >= 1 && /^v\d+\.\d+\.\d+$/.test(meta.upstream), 'wda/LOTUS_FORK.json names the version and the upstream tag');
  assert.match(read('LICENSE'), /BSD License[\s\S]*For WebDriverAgent software[\s\S]*Facebook, Inc\./, "upstream's licence is kept");
  const inc = read('WebDriverAgentLib', 'Commands', 'FBLotusCommands.inc');
  assert.equal(Number(/static const NSInteger LotusForkVersion = (\d+);/.exec(inc)?.[1]), meta!.version, 'the version in the sources is the one in LOTUS_FORK.json');
  assert.equal(/static NSString \*const LotusUpstreamTag = @"([^"]+)";/.exec(inc)?.[1], meta!.upstream);
  for (const route of Object.values(FORK_ROUTES)) assert.ok(inc.includes(`@"${route}"`), `${route} is registered`);
  assert.ok(read('WebDriverAgentLib', 'Commands', 'FBCustomCommands.m').trimEnd().endsWith('#include "FBLotusCommands.inc"'));

  // the token: read from the launch environment, compared in constant time, checked before the body or any route
  const srv = read('WebDriverAgentLib', 'Routing', 'FBHTTPServer.m');
  assert.ok(srv.includes(`environment[@"${TOKEN_ENV}"]`) && srv.includes(`requestHeaders[@"${TOKEN_HEADER}"]`));
  assert.match(srv, /CC_SHA256\(a\.bytes[\s\S]*CC_SHA256\(b\.bytes[\s\S]*diff \|= \(unsigned char\)\(da\[i\] \^ db\[i\]\);[\s\S]*return 0 == diff;/, 'digests compared without an early exit');
  const parse = srv.slice(srv.indexOf('- (nullable FBPendingHTTPRequestHeader *)parsedRequestHeaderFromBuffer:'), srv.indexOf('- (void)dispatchBufferedRequestWithHeader:'));
  assert.ok(parse.indexOf('LotusTokenMatches(') > 0 && parse.indexOf('LotusTokenMatches(') < parse.indexOf('resolveBodyLength:'), 'the token is checked before the body is even sized');
  assert.ok(srv.indexOf('parsedRequestHeaderFromBuffer:buffer forClient:client') < srv.indexOf('[self dispatchBufferedRequestWithHeader:pending'), '...and so before any route');
  const refuse = srv.slice(srv.indexOf('- (void)lotus_refuseClient:'), srv.indexOf('- (void)respondBadRequestToClient:'));
  assert.ok(refuse.includes('HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n') && !/FBResponse|applyDefaultHeaders|WebDriverAgent\/1\.0/.test(refuse), 'the refusal is bare: no WDA header, no JSON');
  const badReq = srv.slice(srv.indexOf('- (void)respondBadRequestToClient:'), srv.indexOf('- (void)applyDefaultHeadersToResponse:'));
  assert.ok(badReq.includes('[self lotus_refuseClient:client]') && !badReq.includes('FBResponseWithStatus'), 'a request that cannot be parsed gets the same bare answer');
  // only the routes the server uses are served
  const allow = /NSString \*pattern = ([\s\S]*?);\n/.exec(srv)?.[1]?.replace(/@"|"\s*\n?\s*/g, '') ?? '';
  const re = new RegExp(allow.replace('(?:/[^/]+)?', '(?:/[^/]+)?'), 'i');
  for (const p of ['/status', '/session', '/session/ABC', '/screenshot', '/session/ABC/screenshot', '/source', '/session/ABC/actions', '/session/ABC/window/size', '/session/ABC/appium/settings', '/orientation',
    '/wda/screen', '/wda/activeAppInfo', '/wda/device/info', '/session/ABC/wda/batteryInfo', '/session/ABC/wda/pressButton', '/wda/homescreen', '/session/ABC/wda/keys', '/wda/lock', '/wda/unlock', '/wda/locked',
    '/session/ABC/wda/tap', '/session/ABC/wda/apps/launch', '/lotus/info', '/lotus/gesture', '/lotus/touch', '/lotus/shot', '/lotus/selftest']) {
    assert.ok(re.test(p), `${p} is served`);
  }
  for (const p of ['/health', '/calibrate', '/wda/shutdown', '/wda/healthcheck', '/session/ABC/url', '/session/ABC/element', '/session/ABC/wda/pasteboard', '/wda/apps/list/x', '/session/ABC/execute', '/session/ABC/alert/text',
    '/wda/siri/activate', '/session/ABC/wda/setPasteboard', '/session/ABC/wda/video/start', '/lotus/other', '/session/ABC/wda/performIoHidEvent', '/session/ABC/wda/keyboard/dismiss']) {
    assert.ok(!re.test(p), `${p} is not served`);
  }
  // no MJPEG server anywhere in what's built
  assert.ok(!fs.existsSync(path.join(wda, 'WebDriverAgentLib', 'Utilities', 'FBMjpegServer.m')) && !fs.existsSync(path.join(wda, 'WebDriverAgentLib', 'Utilities', 'FBMjpegServer.h')));
  assert.ok(!read('WebDriverAgent.xcodeproj', 'project.pbxproj').includes('FBMjpegServer'), 'gone from the Xcode project');
  const web = read('WebDriverAgentLib', 'Routing', 'FBWebServer.m');
  assert.ok(!/initScreenshotsBroadcaster|screenshotsBroadcaster|mjpegServer\b|#import "FBMjpegServer\.h"/.test(web), 'the web server never starts one');
  // live touch: records that don't lift, the persistent-state flags only where XCTest has them, and a stale finger lifted
  assert.ok(inc.includes('respondsToSelector:@selector(setBeginsPersistentState:)') && inc.includes('respondsToSelector:@selector(setEndsPersistentState:)'));
  assert.match(inc, /\+ \(void\)lotus_watchLive[\s\S]*LotusLiveStaleSeconds/);
  assert.ok(inc.includes('#pragma clang diagnostic ignored "-Weverything"'), 'a warning in our additions never fails the build');
  // the build script builds it from this repo with the same team, certificate and bundle id
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'build-wda.sh'), 'utf8');
  assert.ok(!sh.includes('\r'), 'build-wda.sh has Unix line endings');
  assert.match(sh, /if \[ "\$FLAVOR" = "fork" \]; then[\s\S]*PROJ="\$\(pwd\)\/wda"[\s\S]*WDA_FORK_DERIVED_DATA/);
  assert.match(sh, /DEVELOPMENT_TEAM="\$TEAM" CODE_SIGN_IDENTITY="Apple Development" \\\n\s+PRODUCT_BUNDLE_IDENTIFIER="\$BUNDLE"/);
  ok('sources: the licence, the version, the token check before any route, the bare refusal, the route list, no MJPEG, the build script');
}

process.stdout.write(`${os.EOL}all ${passed} fork checks passed${os.EOL}`);
// the WDA managers' health timers are unref'd; anything else left open would hang the run
setTimeout(() => process.exit(0), 100).unref();
