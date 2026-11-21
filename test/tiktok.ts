// 2026-11-22, iPhone-1 with TikTok's For You feed in front (the owner: "EVEN this on the freaking phone1 it breaks
// control after few touches"): the page said "Drag failed: Sending paused a few seconds after 3 failures in a row",
// the phone's stats said the owner's tap waited 10.3 s and failed with "The phone's control link is restarting
// (attempt 1)", the last heal said "restarting WDA (attempt 1/4): unreachable (ECONNRESET); then /status asked 4
// times over 12.0 s, never answered", and a read of the app in front (GET /wda/activeAppInfo, the detail card's)
// was still unanswered 15.5 s later.
//
// Played here end to end, through the real server (createServer + RealBackend + WdaManager, real clocks, the real
// watch, card and list), on a fake phone that does what the phone does:
//   - WebDriverAgent runs every route but /status and the stills on ONE main thread, one at a time, whoever stopped
//     waiting for the answer;
//   - TikTok's feed never answers a read of the app in front through accessibility (orientation, window, screen,
//     the app's name, the tree, elements): XCTest gives up on it after about a minute;
//   - iOS kills an app whose main thread stays blocked (the watchdog): the runner's process goes, its port is
//     closed, every connection is refused (iPhone-1's ECONNRESET), until xcodebuild starts a new runner.
// The owner opens the live view, the picture comes, he touches every 1-2 s for 2 minutes (taps and swipes), rests
// 12 s once, goes Home and back into TikTok; the page asks the card and the list all along.
// Expected (and on 54977f4 it isn't: run this file there): not one touch fails, not one read of the app in front
// reaches the phone, the runner is never killed, never restarted, nothing recovered.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import type { Config } from '../src/config.js';
import { RealBackend } from '../src/real.js';
import { createServer } from '../src/server.js';
import { appBound, WdaManager } from '../src/wda.js';

const DURATION_MS = Number(process.env.TIKTOK_MS) || 120_000;
/** iOS's watchdog: a main thread that doesn't answer this long gets the app killed. */
const WATCHDOG_MS = 10_000;
/** XCTest gives up on an accessibility read of an app that never answers after about this long. */
const APP_HANG_MS = 60_000;

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
};

// ---- the fake phone ----
interface Phone {
  port: number;
  /** Every request that reached WebDriverAgent ("GET /wda/activeAppInfo"), and the reads of the app in front among them. */
  hits: string[];
  appHits: string[];
  /** TikTok's feed is in front (Home puts the Home Screen there; the owner's next tap opens TikTok again). */
  tiktok: boolean;
  /** The runner was killed (its main thread blocked too long), and how many times. */
  deaths: number;
  up: boolean;
  /** The longest the main thread was blocked by one request (ms). */
  longestBlock: number;
  revive(): Promise<void>;
  close(): void;
}

const fakePhone = async (): Promise<Phone> => {
  const sockets = new Set<Socket>();
  let session = '';
  let gen = 0; // a new runner: what was queued on the old one is gone with it
  let queue: (() => Promise<void>)[] = [];
  let running = false;
  let busySince = 0;
  let killed: () => void = () => {};
  let killedP = new Promise<void>((r) => (killed = r));
  const ph: Phone = {
    port: 0, hits: [], appHits: [], tiktok: false, deaths: 0, up: true, longestBlock: 0,
    revive: async () => {
      if (ph.up) return;
      session = '';
      killedP = new Promise<void>((r) => (killed = r));
      await new Promise<void>((r) => server.listen(ph.port, '127.0.0.1', r));
      ph.up = true;
    },
    close: () => {
      clearInterval(watchdog);
      ph.up = false;
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
  // the main thread: one route at a time
  const pump = async () => {
    if (running) return;
    running = true;
    const mine = gen;
    while (queue.length && gen === mine) {
      const job = queue.shift()!;
      busySince = Date.now();
      await job();
      if (busySince) ph.longestBlock = Math.max(ph.longestBlock, Date.now() - busySince);
      busySince = 0;
    }
    running = false;
  };
  const onMain = (job: () => Promise<void>) => {
    queue.push(job);
    void pump();
  };
  // iOS's watchdog: the runner is killed, its port closed, every connection to it refused or reset
  const watchdog = setInterval(() => {
    if (!ph.up || !busySince || Date.now() - busySince < WATCHDOG_MS) return;
    ph.longestBlock = Math.max(ph.longestBlock, Date.now() - busySince);
    ph.deaths++;
    ph.up = false;
    gen++;
    queue = [];
    running = false;
    busySince = 0;
    killed();
    server.close();
    for (const s of sockets) s.destroy();
  }, 50);
  watchdog.unref();

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const p = req.url ?? '';
      const route = p.split('?')[0]!;
      const label = `${req.method} ${route.replace(/^\/session\/[^/]+/, '/session/:id')}`;
      ph.hits.push(label);
      const bound = appBound(req.method ?? 'GET', p);
      if (bound) ph.appHits.push(label);
      const json = (status: number, v: unknown) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      // off the main thread: /status, the stills
      if (route === '/status') return json(200, { value: { ready: true }, sessionId: session || null });
      if (route === '/screenshot') return json(200, { value: Buffer.from('not a png').toString('base64') });
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* none */
      }
      onMain(async () => {
        if (bound && ph.tiktok) {
          // TikTok's feed doesn't answer: XCTest waits (and retries) until it gives up, holding the main thread
          await Promise.race([sleep(APP_HANG_MS), killedP]);
          return json(500, { value: { error: 'unknown error', message: 'Failed to get the accessibility snapshot of the app in front' } });
        }
        await sleep(3);
        if (route === '/session' && req.method === 'POST') {
          session = `S${Date.now()}`;
          return json(200, { sessionId: session, value: { sessionId: session } });
        }
        if (route === '/wda/homescreen' || (/\/pressButton$/.test(route) && body?.name === 'home')) {
          ph.tiktok = false; // the Home Screen answers accessibility at once
          return json(200, { value: null });
        }
        if (route === '/wda/lotus/touch') {
          if (!ph.tiktok && ph.hits.filter((h) => h === 'POST /wda/homescreen').length > 0) ph.tiktok = true; // a tap on TikTok's icon
          return json(200, { value: { queued: 1, lotus: 1 } });
        }
        if (route === '/wda/locked') return json(200, { value: false });
        if (route === '/wda/device/info') return json(200, { value: { thermalState: 0 } });
        if (/\/wda\/batteryInfo$/.test(route)) return json(200, { value: { level: 1, state: 2 } });
        if (route === '/wda/activeAppInfo') return json(200, { value: { bundleId: 'com.apple.springboard', name: 'Home Screen' } });
        if (/\/orientation$/.test(route)) return json(200, { value: 'PORTRAIT' });
        if (route === '/wda/screen') return json(200, { value: { scale: 3, screenSize: { width: 428, height: 926 } } });
        const m = /^\/session\/([^/]+)(\/.*)?$/.exec(route);
        if (m && m[1] !== session) return json(404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
        return json(200, { value: m && !m[2] ? { capabilities: {} } : null });
      });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ph.port = (server.address() as AddressInfo).port;
  return ph;
};

// ---- the Mac's processes: xcodebuild starts a new runner (it brings a killed one back), iproxy does nothing ----
type Proc = ChildProcess & EventEmitter & { cmd: string };
const procs: Proc[] = [];
let phone!: Phone;
const fakeSpawn = ((cmd: string) => {
  const p = new EventEmitter() as Proc;
  Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, cmd });
  procs.push(p);
  if (cmd === 'xcodebuild' && phone && !phone.up) setTimeout(() => void phone.revive(), 300).unref();
  return p;
}) as unknown as typeof import('node:child_process').spawn;
const runners = () => procs.filter((p) => p.cmd === 'xcodebuild').length;

const prevCwd = process.cwd();
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tiktok-'))); // data/ goes here
const origLog = console.log;
const logs: string[] = [];
console.log = (...a: unknown[]) => void logs.push(a.join(' '));

phone = await fakePhone();
const cfg = {
  wdaBasePort: phone.port, mjpegBasePort: 40100, wdaProject: '/x', wdaDerivedData: '/y', pollMs: 60_000, autostartWda: true,
  h264: false, h264BitrateMbps: 8, audio: false, phoneSilent: false, hidInput: 'off', hidPython: 'python3', dataDir: 'data',
} as unknown as Config;
// the phone as libimobiledevice says it: iPhone-1, an iPhone 14 Plus on iOS 18.5
const run = async (cmd: string, args: string[]) => {
  if (cmd === 'idevice_id') return 'U1';
  if (cmd === 'ideviceinfo') {
    const k = args[args.indexOf('-k') + 1];
    if (k === 'DeviceName') return 'iPhone-1';
    if (k === 'ProductType') return 'iPhone14,8';
    if (k === 'ProductVersion') return '18.5';
    if (k === 'BatteryCurrentCapacity') return '100';
  }
  return '';
};
const wda = new WdaManager(cfg, () => 'iPhone-1', fakeSpawn); // the real clocks: HOLD_MS, LANE_WAIT_MS, the probes, all as on the Mac
const backend = new RealBackend(cfg, { run, wda, timer: false });
const token = crypto.randomBytes(16).toString('hex');
const server = createServer(backend, token, undefined, { focusLockMs: 0 });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = { authorization: `Bearer ${token}` };

let ws: WebSocket | null = null;
try {
  assert.ok(await until(() => wda.state('U1') === 'ready' && wda.screen('U1') !== null, 15_000), 'iPhone-1 ready');
  const startRunners = runners();
  assert.equal(startRunners, 1);
  const setupReads = phone.appHits.length; // (the session was made while the Home Screen was in front)
  phone.appHits.length = 0;
  // the owner opens TikTok (its For You feed: a video playing, accessibility never answered from here on)
  phone.tiktok = true;

  // the owner opens iPhone-1's live view: the control link (the watch, the card's pushes), the card, the picture
  ws = new WebSocket(`${base.replace('http', 'ws')}/phones/U1/control?token=${token}`);
  await new Promise<void>((r, j) => {
    ws!.once('open', () => r());
    ws!.once('error', j);
  });
  const acks = new Map<number, { resolve: (m: any) => void; at: number }>();
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'ack' && acks.has(m.id)) {
      acks.get(m.id)!.resolve(m);
      acks.delete(m.id);
    }
  });
  let nextId = 1;
  const send = (msg: Record<string, unknown>): Promise<any> =>
    new Promise((resolve) => {
      const id = nextId++;
      acks.set(id, { resolve, at: Date.now() });
      ws!.send(JSON.stringify({ ...msg, id }));
    });
  const get = async (p: string) => {
    const r = await fetch(`${base}${p}`, { headers: auth });
    return { status: r.status, body: (await r.json()) as any };
  };
  const card0 = await get('/phones/U1/info?fresh=1');
  assert.equal(card0.status, 200);
  // the live view's picture comes (the USB capture's first frame: 642 x 1388, tall)
  (backend as unknown as { captureInfo(u: string, i: { width: number; height: number; fps: number; scale: number }): void }).captureInfo('U1', { width: 642, height: 1388, fps: 30, scale: 50 });

  // the page keeps asking the card (every 5 s) and the list (every 3 s) while the owner plays with TikTok
  let pagePolls = 0;
  let cardFails = 0;
  let stop = false;
  const page = (async () => {
    let n = 0;
    while (!stop) {
      await sleep(1000);
      n++;
      if (n % 3 === 0) await get('/phones').then(() => pagePolls++, () => {});
      if (n % 5 === 0) await get('/phones/U1/info?fresh=1').then((r) => (r.status === 200 ? pagePolls++ : cardFails++), () => cardFails++);
    }
  })();

  // the owner: a tap or a swipe every 1-2 s for DURATION_MS; a 12 s rest once; Home and back into TikTok once
  const failures: string[] = [];
  let touches = 0;
  let slowest = 0;
  const t0 = Date.now();
  let rested = false;
  let wentHome = false;
  while (Date.now() - t0 < DURATION_MS) {
    const at = Date.now() - t0;
    if (!rested && at > DURATION_MS * 0.3) {
      rested = true;
      await sleep(12_000); // he watches a video: no touch for 12 s (the card's 10-s quiet window runs out)
      continue;
    }
    let msg: Record<string, unknown>;
    if (!wentHome && at > DURATION_MS * 0.6) {
      wentHome = true;
      msg = { type: 'key', key: 'home', owner: true };
    } else if (touches % 3 === 2) {
      msg = { type: 'tap', x: 0.5, y: 0.45, unit: 'norm', natural: false, owner: true };
    } else {
      msg = { type: 'path', points: [[0.5, 0.8, 0], [0.5, 0.55, 120], [0.5, 0.25, 240]], unit: 'norm', owner: true };
    }
    const ts = Date.now();
    const ack = await send(msg);
    slowest = Math.max(slowest, Date.now() - ts);
    touches++;
    if (!ack.ok) failures.push(`${Math.round((Date.now() - t0) / 1000)} s ${msg.type}: ${ack.error}`);
    await sleep(1000 + Math.floor(Math.random() * 1000));
  }
  stop = true;
  await page;
  const card = await get('/phones/U1/info?fresh=1');
  const list = (await get('/phones')).body as any[];
  const link = list[0]?.stats?.controlLink?.wda ?? {};

  origLog(`  ${touches} touches in ${Math.round((Date.now() - t0) / 1000)} s (slowest answer ${slowest} ms), ${pagePolls} card/list polls; ` +
    `reads of the app in front that reached the phone: ${phone.appHits.length}; runner killed: ${phone.deaths}; runners started: ${runners() - startRunners}; ` +
    `recoveries: ${link.recoveries ?? '?'}; longest block of WDA's main thread: ${phone.longestBlock} ms; failed touches: ${failures.length}`);
  if (failures.length) origLog(failures.slice(0, 8).map((f) => `    ${f}`).join('\n'));
  if (phone.appHits.length) origLog(`    reads of the app in front sent: ${phone.appHits.join(', ')}`);

  assert.equal(setupReads, 0, 'the session was made without reading the app in front');
  assert.deepEqual(phone.appHits, [], 'not one read of the app in front reached the phone (the card, the list, the picture, the watch, sessions)');
  assert.equal(phone.deaths, 0, "WDA's main thread was never blocked long enough for iOS to kill the runner");
  assert.equal(runners() - startRunners, 0, 'no runner restarted');
  assert.deepEqual(failures, [], 'not one of the owner\'s touches failed');
  assert.ok(touches >= Math.floor((DURATION_MS - 12_000) / 2100), `${touches} touches`);
  assert.ok(slowest < 2000, `every touch answered at once (slowest ${slowest} ms)`);
  assert.equal(cardFails, 0, 'the card answered every time');
  ok(`TikTok in front, the owner touching every 1-2 s for ${Math.round(DURATION_MS / 1000)} s with the card and list asked: 0 failed touches, 0 reads of the app in front, 0 runner restarts`);

  assert.equal(link.recoveries, 0, 'nothing recovered');
  assert.equal(link.runnerRestarts, 0);
  assert.deepEqual(link.appReads?.sent, 0, 'stats: no read of the app in front sent');
  assert.equal(link.appStall, null, 'no stall: the app was never asked');
  assert.equal(list[0].orientation, 'portrait', "how it's turned: from the live picture's shape");
  // the card: the app in front as last known (Home, from the owner's Home press), never asked; it says it may have changed
  assert.equal(card.status, 200);
  assert.equal(card.body.app?.bundleId, 'com.apple.springboard');
  assert.equal(card.body.app?.from, 'home');
  assert.equal(card.body.app?.maybeChanged, true, 'the owner touched it since: it may be TikTok again');
  ok('the card says the app as last known (Home), never asked; the orientation comes from the picture; nothing recovered or restarted');
} catch (err) {
  origLog(logs.slice(-60).join('\n'));
  throw err;
} finally {
  console.log = origLog;
  ws?.close();
  server.closeAllConnections();
  server.close();
  await backend.close();
  phone.close();
  process.chdir(prevCwd);
}

console.log(`\nall ${passed} TikTok checks passed`);
process.exit(0);
