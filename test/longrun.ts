// Long runs (2026-11-21): the stream sockets' heartbeat (a silent viewer is closed, its capture and hold end), the
// WebRTC connect deadline (an offer that never connects gets an rtc-error, so the client offers again), the
// process's safety net (a forgotten rejection never ends the server; one shutdown, with a deadline), the log's
// rotation, and a soak: hundreds of control and stream sockets opened and dropped without a word, after which the
// server holds no session, no viewer, no open link, and its timers, sockets and memory are back where they began.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ndc from 'node-datachannel';
import WebSocket from 'ws';
import { installGuards, makeShutdown, rotateLog } from '../src/lifecycle.js';
import { MockBackend } from '../src/mock.js';
import { createServer, streamHeartbeat } from '../src/server.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOAK_S = Number(process.env.SOAK_S ?? 20);

// ---- streamHeartbeat on its own ----
{
  class FakeWs extends EventEmitter {
    readyState = WebSocket.OPEN;
    awake = true;
    pings = 0;
    ping() {
      this.pings++;
      if (this.awake) setImmediate(() => this.emit('pong'));
    }
  }
  // a client that answers, then sleeps: closed after the dead time, once
  const a = new FakeWs();
  let deadA = 0;
  const stopA = streamHeartbeat(a, 20, 120, () => deadA++);
  await sleep(100);
  assert.equal(deadA, 0, 'alive while it answers');
  a.awake = false;
  await until('the silent client is found dead', () => deadA === 1, 2000);
  await sleep(100);
  assert.equal(deadA, 1, 'only once');
  stopA();
  // a client that never answered pings (an old one): never closed for it
  const b = new FakeWs();
  b.awake = false;
  let deadB = 0;
  const stopB = streamHeartbeat(b, 20, 60, () => deadB++);
  await sleep(250);
  assert.equal(deadB, 0, 'a client that never answers pings is left alone');
  assert.ok(b.pings > 3, 'but still pinged');
  stopB();
  // its messages count as life too
  const c = new FakeWs();
  let deadC = 0;
  const stopC = streamHeartbeat(c, 20, 120, () => deadC++);
  await sleep(60);
  c.awake = false;
  const talk = setInterval(() => c.emit('message'), 30);
  await sleep(300);
  assert.equal(deadC, 0, 'a client that talks is alive');
  clearInterval(talk);
  await until('then found dead', () => deadC === 1, 2000);
  stopC();
  ok('streamHeartbeat: closes a client that answered and went silent, once; never one that never answered; messages count');
}

// ---- lifecycle: the safety net and the shutdown ----
{
  const said: string[] = [];
  let fatal = 0;
  const g = installGuards(() => fatal++, (m) => said.push(m));
  try {
    void Promise.reject(new Error('forgotten'));
    void Promise.reject(new Error('forgotten'));
    await sleep(50);
  } finally {
    g.uninstall(); // before the checks: a failed one must end this test, not be caught by the guard
  }
  assert.equal(g.rejections(), 2, 'both caught');
  assert.equal(said.filter((m) => m.includes('forgotten')).length, 1, 'the same reason said once a minute');
  assert.equal(fatal, 0, 'a rejection is never fatal');

  const exits: number[] = [];
  let ran = 0;
  const sd = makeShutdown(async () => {
    ran++;
  }, { exit: (c) => exits.push(c), log: () => {} });
  sd(0);
  sd(1);
  await sleep(20);
  assert.deepEqual([ran, exits], [1, [0]], 'runs once, exits with the first code');

  const exits2: number[] = [];
  const t0 = Date.now();
  const hang = makeShutdown(() => new Promise<void>(() => {}), { deadlineMs: 150, exit: (c) => exits2.push(c), log: () => {} });
  hang(1);
  await until('the deadline', () => exits2.length > 0, 2000);
  assert.deepEqual(exits2, [1]);
  assert.ok(Date.now() - t0 < 1000, 'a hung step never holds the exit past the deadline');

  const exits3: number[] = [];
  const failing = makeShutdown(() => {
    throw new Error('step broke');
  }, { exit: (c) => exits3.push(c), log: () => {} });
  failing(0);
  await sleep(20);
  assert.deepEqual(exits3, [0], 'a failing step still exits');
  ok('lifecycle: rejections logged and survived (deduplicated); one shutdown; a deadline; a failing step still exits');
}

// ---- the log's rotation ----
{
  const dir = path.join(ROOT, 'data', `test-log-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const f = path.join(dir, 'server.log');
    fs.writeFileSync(f, 'x'.repeat(50));
    assert.equal(rotateLog(f, 100, 2), false, 'small: left');
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(f, String(i).repeat(200));
      assert.equal(rotateLog(f, 100, 2), true);
      assert.equal(fs.statSync(f).size, 0, 'cut in place');
    }
    assert.equal(fs.readFileSync(`${f}.1`, 'utf8')[0], '4');
    assert.equal(fs.readFileSync(`${f}.2`, 'utf8')[0], '3');
    assert.equal(fs.existsSync(`${f}.3`), false, 'only `keep` older ones');
    assert.equal(rotateLog(path.join(dir, 'none.log'), 100), false, 'no file: nothing');
    // an open append handle (launchd's) writes on at the start of the cut file
    const fd = fs.openSync(f, 'a');
    fs.writeSync(fd, 'y'.repeat(300));
    assert.equal(rotateLog(f, 100, 2), true);
    fs.writeSync(fd, 'after');
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(f, 'utf8'), 'after', 'the append handle writes at the new end');
    ok('log rotation: over the size it moves to .1 (older up to keep), cut in place, an append handle carries on');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- a server: dead stream sockets, the WebRTC deadline, and the soak ----
const token = crypto.randomBytes(16).toString('hex');
const backend = new MockBackend(2, { h264IdleMs: 200 });
const server = createServer(backend, token, undefined, {
  watchMs: 0,
  controlPingMs: 50,
  controlDeadMs: 300,
  streamPingMs: 50,
  streamDeadMs: 300,
  rtcConnectMs: 800,
  rtcDisconnectedMs: 400,
  controlPushMs: 50,
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = { authorization: `Bearer ${token}` };
const phones = async (): Promise<any[]> => (await fetch(`http://${base}/phones`, { headers: auth })).json() as Promise<any[]>;
const udid: string = (await phones()).find((p) => p.online).udid;
const phone = async () => (await phones()).find((p) => p.udid === udid);
const quiet = async () => {
  const p = await phone();
  return p.stats.viewers === 0 && p.stats.sessions.length === 0 && p.stats.controlLink.open === 0;
};

try {
  // a stream viewer that answered pings, then went silent (the laptop slept): closed, its capture ends
  for (const codec of ['h264', 'mjpeg']) {
    const ws = new WebSocket(`ws://${base}/phones/${udid}/stream?token=${token}&codec=${codec}`, { autoPong: false });
    let asleep = false;
    ws.on('ping', (d) => !asleep && ws.pong(d));
    let frames = 0;
    ws.on('message', (_d, bin) => bin && frames++);
    const closed = new Promise<void>((r) => ws.once('close', () => r()));
    await until(`${codec} frames`, () => frames > 2);
    assert.equal((await phone()).stats.viewers, 1, 'a viewer');
    asleep = true;
    const t0 = Date.now();
    await closed;
    assert.ok(Date.now() - t0 < 2000, `${codec}: the silent viewer is closed by the server`);
    await until(`${codec}: no viewer left`, quiet);
  }
  ok('stream sockets: a viewer that answered and went silent is closed, and its viewer and session end (h264, mjpeg)');

  // an offer whose peer connection never connects (the client never takes the answer): rtc-error, nothing kept
  {
    const control = new WebSocket(`ws://${base}/phones/${udid}/control?token=${token}`);
    const inbox: any[] = [];
    control.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise((r) => control.once('open', r));
    // the offer of a client that's gone at once (made by node-datachannel, then closed): the server's ICE checks
    // go nowhere, so its peer connection never connects
    const pc = new ndc.PeerConnection('client', { iceServers: [] });
    const v = new ndc.Video('0', 'RecvOnly');
    v.addH264Codec(102);
    pc.addTrack(v);
    const sdp = await new Promise<string>((r) => {
      pc.onLocalDescription((d) => r(d));
      pc.setLocalDescription();
    });
    await sleep(200); // its candidates gathered
    const offer = pc.localDescription()?.sdp ?? sdp;
    pc.close();
    await sleep(300);
    try {
      control.send(JSON.stringify({ type: 'rtc-offer', sdp: offer }));
      await until('the answer', () => inbox.some((m) => m.type === 'rtc-answer'), 5000);
      const t0 = Date.now();
      await until('rtc-error', () => inbox.some((m) => m.type === 'rtc-error'), 5000);
      const err = inbox.find((m) => m.type === 'rtc-error');
      assert.match(err.reason, /did not connect/);
      assert.ok(Date.now() - t0 < 3000);
      await until('its session gone', async () => (await phone()).stats.sessions.length === 0);
    } finally {
      control.close();
    }
    await until('quiet after the deadline test', quiet);
  }
  ok('WebRTC: an offer that never connects gets rtc-error within the deadline, and its session ends');

  // the control state is pushed on the control socket: in its hello, right after it, and on every change
  {
    let fake: Record<string, unknown> | null = null;
    const list0 = backend.list.bind(backend);
    backend.list = async () => (await list0()).map((p) => (p.udid === udid && fake ? { ...p, ...fake } : p));
    try {
      const control = new WebSocket(`ws://${base}/phones/${udid}/control?token=${token}`);
      const inbox: any[] = [];
      control.on('message', (d) => inbox.push(JSON.parse(d.toString())));
      await new Promise((r) => control.once('open', r));
      const ctl = () => inbox.filter((m) => m.type === 'control');
      await until('the first control message', () => ctl().length === 1);
      assert.deepEqual(ctl()[0], { type: 'control', udid, control: 'ready', controlDown: null, needsReplug: false, restarting: null });
      await sleep(200);
      assert.equal(ctl().length, 1, 'nothing more while nothing changes');
      fake = { control: 'recovering', restarting: { attempt: 1, of: 4, since: 1 } };
      await until('recovering pushed', () => ctl().length === 2);
      assert.deepEqual(ctl()[1], { type: 'control', udid, control: 'recovering', controlDown: null, needsReplug: false, restarting: { attempt: 1, of: 4, since: 1 } });
      fake = { control: 'down', controlDown: 'XCTest is jammed', needsReplug: true, restarting: null };
      await until('needs replug pushed', () => ctl().length === 3);
      assert.equal(ctl()[2].needsReplug, true);
      assert.equal(ctl()[2].controlDown, 'XCTest is jammed');
      control.close();
      // a new socket's hello carries the state as last seen
      const again = new WebSocket(`ws://${base}/phones/${udid}/control?token=${token}`);
      const hello = await new Promise<any>((r) => again.once('message', (d) => r(JSON.parse(d.toString()))));
      assert.equal(hello.type, 'hello');
      assert.equal(hello.control, 'down');
      assert.equal(hello.needsReplug, true);
      fake = null;
      const back = await new Promise<any>((r) => again.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'control' && m.control === 'ready') r(m);
      }));
      assert.equal(back.needsReplug, false);
      again.close();
    } finally {
      backend.list = list0;
    }
    await until('quiet after the control push test', quiet);
  }
  ok('control state pushed: right after the hello, in the next hello, on each change (recovering, needs replug, ready), never repeated');

  // ---- the soak: sockets opened and dropped without a word, for SOAK_S seconds ----
  const resources = () => process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap').length;
  await sleep(500);
  global.gc?.();
  const r0 = resources();
  const m0 = process.memoryUsage().heapUsed;
  const end = Date.now() + SOAK_S * 1000;
  let cycles = 0;
  while (Date.now() < end) {
    const socks: WebSocket[] = [];
    const ctl = new WebSocket(`ws://${base}/phones/${udid}/control?token=${token}`);
    const st = new WebSocket(`ws://${base}/phones/${udid}/stream?token=${token}&codec=${cycles % 2 ? 'h264' : 'mjpeg'}`);
    socks.push(ctl, st);
    let got = 0;
    st.on('message', (_d, bin) => bin && got++);
    await Promise.all(socks.map((s) => new Promise((r) => s.once('open', r))));
    await until('a frame', () => got > 0, 4000);
    // half go with a close frame, half drop (the TCP socket destroyed: no close frame, as a sleeping laptop)
    for (const s of socks) {
      if (cycles % 3 === 0) s.close();
      else (s as any)._socket?.destroy();
    }
    cycles++;
  }
  await until('every socket of the soak closed on the server', quiet, 10_000);
  await sleep(800); // the captures' idle stop (200 ms) and the sockets' ends
  global.gc?.();
  const r1 = resources();
  const m1 = process.memoryUsage().heapUsed;
  const p = await phone();
  assert.equal(p.stats.controlLink.opens, p.stats.controlLink.closes + p.stats.controlLink.open, 'every control socket counted closed');
  assert.ok(cycles >= 20, `enough cycles (${cycles})`);
  assert.ok(r1 <= r0 + 4, `handles flat: ${r0} -> ${r1}`);
  assert.ok(m1 - m0 < 40 * 1024 * 1024, `heap flat: ${(m0 / 1048576).toFixed(1)} -> ${(m1 / 1048576).toFixed(1)} MB`);
  ok(`soak: ${cycles} cycles of control + stream sockets in ${SOAK_S} s; no viewer, session or link left; handles ${r0} -> ${r1}; heap ${(m0 / 1048576).toFixed(1)} -> ${(m1 / 1048576).toFixed(1)} MB`);
} finally {
  server.close();
  server.closeAllConnections();
  await backend.close();
  // no rtcCleanup() here: node-datachannel 0.33.6 crashes in its cleanup() after a peer connection that never
  // connected was closed (seen on Windows; the exit below ends its threads anyway)
}
console.log(`all ${passed} long-run checks passed`);
// as test/rtc.ts: a moment for the WebRTC library's own threads to end before the exit (else it can crash on the way out)
setTimeout(() => process.exit(0), 200).unref();
