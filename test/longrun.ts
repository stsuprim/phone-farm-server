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
import { farmFree, installGuards, makeShutdown, phoneFree, releaseDevices, rotateLog, setLeaseProbe, systemTurn } from '../src/lifecycle.js';
import { MockBackend } from '../src/mock.js';
import { createServer, streamHeartbeat } from '../src/server.js';
import { createUpdater, Sh } from '../src/updater.js';

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

// ---- 2026-11-27 (docs/root-cause.md §11, 13.3e): a restart ends the API only; the updater waits for Free leases ----
{
  // the device layer: kept on a restart (detached, or simply left), ended only when asked
  const layer = (withDetach: boolean) => {
    const d = { closes: 0, detaches: 0, close: async () => void d.closes++, ...(withDetach ? { detach: async () => void d.detaches++ } : {}) };
    return d;
  };
  const quietLog = () => {};
  let l = layer(true);
  assert.equal(await releaseDevices(l, 'keep', quietLog), 'detached');
  assert.deepEqual([l.closes, l.detaches], [0, 1]);
  l = layer(false);
  assert.equal(await releaseDevices(l, 'keep', quietLog), 'left');
  assert.equal(l.closes, 0, 'no detach(): the runners are left as they are, never ended');
  assert.equal(await releaseDevices(l, 'stop', quietLog), 'closed');
  assert.equal(l.closes, 1);

  // system work waits for the phone's lease, gives up with who holds it, or goes when forced
  let held = true;
  setLeaseProbe(() => [{ udid: 'A', busy: held, who: 'owner' }, { udid: 'B', busy: false }]);
  try {
    assert.deepEqual(farmFree(), { free: false, who: ['owner on A'] });
    assert.equal(phoneFree('B'), true);
    const gaveUp = await systemTurn('resign', 'A', async () => 1, { waitMs: 60, pollMs: 10 });
    assert.deepEqual(gaveUp, { ran: false, why: 'the phone is in use (owner)' });
    setTimeout(() => (held = false), 50);
    const waited = await systemTurn('resign', 'A', async () => farmFree().who, { waitMs: 2000, pollMs: 10 });
    assert.deepEqual(waited, { ran: true, value: ['system:resign on A'] }, 'ran once Free, and was said while it ran');
    held = true;
    assert.equal((await systemTurn('selftest', 'A', async () => 2, { force: true })).ran, true, 'forced: goes whatever the lease');
    setLeaseProbe(() => {
      throw new Error('actor gone');
    });
    assert.equal(phoneFree('A'), false, 'a probe that fails never reads as Free');
  } finally {
    setLeaseProbe(null);
  }
  ok('restart: the device layer is detached or left, never ended (only on "stop"); system work waits for a Free lease');

  // a fake checkout: the updater's git and npm, with a build or a gate that can fail
  const C = (n: number) => n.toString(16).padEnd(40, '0'); // a short hash of its own each (1000000, 2000000...)
  const repo = (start: string) => {
    const r = { head: start, remote: start, buildFails: new Set<string>(), gateFails: new Set<string>(), builds: [] as string[], gates: [] as string[], checkouts: [] as string[] };
    const sh: Sh = async (cmd, args) => {
      const c = `${cmd} ${args.join(' ')}`;
      if (c.startsWith('git ls-remote')) return `${r.remote}\trefs/heads/main`;
      if (c === 'git rev-parse HEAD') return r.head;
      if (c === 'git rev-parse origin/main') return r.remote;
      if (c.startsWith('git fetch') || c.startsWith('git branch') || c.startsWith('npm install')) return '';
      if (c.startsWith('git diff')) return 'src/server.ts';
      if (c.startsWith('git checkout')) {
        r.head = args.at(-1)!;
        r.checkouts.push(r.head);
        return '';
      }
      if (c === 'npm run build') {
        r.builds.push(r.head);
        if (r.buildFails.has(r.head)) throw Object.assign(new Error('Command failed: npm run build'), { stderr: 'error TS2322: nope' });
        return '';
      }
      if (c === 'npm run regress') {
        r.gates.push(r.head);
        if (r.gateFails.has(r.head)) throw Object.assign(new Error('Command failed: npm run regress'), { stdout: 'not ok - a tap was lost' });
        return '';
      }
      throw new Error(`unexpected: ${c}`);
    };
    return { r, sh };
  };
  // the server's process: its restart is the real shutdown (makeShutdown + releaseDevices), the phones' runners counted
  const proc = () => {
    const devices = layer(true);
    const p = { restarts: 0, devices, exits: [] as number[] };
    const shutdown = makeShutdown(async () => void (await releaseDevices(devices, 'keep', quietLog)), { exit: (c) => void p.exits.push(c), log: quietLog });
    return { p, onRestart: () => (p.restarts++, shutdown(0)) };
  };
  const STEP = 10_000; // the poller's interval
  const drive = async (u: ReturnType<typeof createUpdater>, clock: { t: number }, untilMs: number, each?: (t: number) => void) => {
    while (clock.t < untilMs) {
      each?.(clock.t);
      await u.tick();
      clock.t += STEP;
    }
    await sleep(600); // a restart goes 500 ms after it's decided
  };

  // 5 pushes in 10 minutes while a phone is in use: builds in the background, no restart at all; one when it's Free
  {
    const { r, sh } = repo(C(1));
    const { p, onRestart } = proc();
    const clock = { t: Date.parse('2026-11-27T14:00:00Z') };
    let inUse = true;
    const logs: string[] = [];
    const u = createUpdater(onRestart, { sh, now: () => clock.t, quietStartHour: null, hasScript: () => true, log: (m) => void logs.push(m), free: () => (inUse ? { free: false, who: ['owner on A'] } : { free: true, who: [] }) });
    const start = clock.t;
    const pushes = [0, 2.5, 5, 7.5, 9.5].map((m) => start + m * 60_000);
    await drive(u, clock, start + 10 * 60_000, (t) => {
      const due = pushes.filter((at) => at <= t).length;
      if (due) r.remote = C(1 + due);
    });
    assert.equal(r.remote, C(6), 'all five pushes landed');
    assert.equal(p.restarts, 0, 'no restart while a phone is in use');
    assert.deepEqual([p.devices.closes, p.devices.detaches], [0, 0], 'no runner or capture touched');
    assert.ok(r.builds.length <= 4 && r.builds.every((b, i, a) => i === 0 || a[i - 1] !== b), `built in the background, never two in a row of the same: ${r.builds.length}`);
    for (const b of r.builds) assert.ok(r.gates.includes(b), 'every build went through the gate');
    const st = await u.status();
    assert.ok(st.state === 'pending' || st.state === 'ready', `waiting: ${st.state}`);
    // the phone is Free: one restart, into the newest commit, the device layer kept
    inUse = false;
    await drive(u, clock, clock.t + 4 * 60_000);
    assert.equal(p.restarts, 1, 'exactly one restart');
    assert.equal(r.head, C(6), 'into the newest commit');
    assert.deepEqual([p.devices.closes, p.devices.detaches, p.exits], [0, 1, [0]], 'the API went; the runners were detached, never ended');
    assert.equal((await u.status()).state, 'restarting');
    assert.ok(logs.some((m) => /waiting for the phones to be free: owner on A/.test(m)), 'the log says what it waits for');
  }

  // pushes 90 s apart, phones Free: the debounce builds once, after the last
  {
    const { r, sh } = repo(C(1));
    const { p, onRestart } = proc();
    const clock = { t: Date.parse('2026-11-27T14:00:00Z') };
    const u = createUpdater(onRestart, { sh, now: () => clock.t, quietStartHour: null, hasScript: () => true, log: quietLog, free: () => ({ free: true, who: [] }) });
    const start = clock.t;
    await drive(u, clock, start + 10 * 60_000, (t) => {
      const n = Math.min(5, Math.floor((t - start) / 90_000) + 1);
      r.remote = C(1 + n);
    });
    assert.deepEqual(r.builds, [C(6)], 'one build, of the last push, once pushes settled');
    assert.deepEqual([p.restarts, p.devices.closes], [1, 0]);
  }

  // the PRE-RELEASE GATE fails: the old build keeps running, dist/ goes back to it, nothing restarts, the log says why
  {
    const { r, sh } = repo(C(1));
    const { p, onRestart } = proc();
    const clock = { t: Date.parse('2026-11-27T14:00:00Z') };
    const logs: string[] = [];
    const u = createUpdater(onRestart, { sh, now: () => clock.t, quietStartHour: null, hasScript: () => true, log: (m) => void logs.push(m), free: () => ({ free: true, who: [] }) });
    r.remote = C(2);
    r.gateFails.add(C(2));
    await drive(u, clock, clock.t + 3 * 60_000);
    assert.equal(p.restarts, 0, 'never restarted into a build that failed the gate');
    assert.equal(r.head, C(1), 'the running commit is checked out again');
    assert.deepEqual(r.builds, [C(2), C(1)], 'and rebuilt, so dist/ is what runs');
    let st = await u.status();
    assert.deepEqual([st.state, st.failedCommit, st.gate?.ok, st.gate?.ran], ['idle', C(2), false, true]);
    assert.match(st.lastError ?? '', /pre-release gate \(npm run regress\) failed: .*a tap was lost.*kept 1000000 running/);
    assert.ok(logs.some((m) => /gate: npm run regress/.test(m)) && logs.some((m) => /rolling back/.test(m)));
    // not tried again by the poller...
    await drive(u, clock, clock.t + 3 * 60_000);
    assert.deepEqual(r.builds, [C(2), C(1)]);
    // ...until a newer commit
    r.remote = C(3);
    await drive(u, clock, clock.t + 3 * 60_000);
    assert.deepEqual([p.restarts, r.head, p.devices.closes], [1, C(3), 0]);
    st = await u.status();
    assert.deepEqual([st.gate?.commit, st.gate?.ok, st.lastError], [C(3), true, null]);
  }

  // a build that fails is refused the same way; a commit with no `regress` script passes the gate with a warning
  {
    const { r, sh } = repo(C(1));
    const { p, onRestart } = proc();
    const clock = { t: Date.parse('2026-11-27T14:00:00Z') };
    const logs: string[] = [];
    const u = createUpdater(onRestart, { sh, now: () => clock.t, quietStartHour: null, hasScript: () => false, log: (m) => void logs.push(m), free: () => ({ free: true, who: [] }) });
    r.remote = C(2);
    r.buildFails.add(C(2));
    await drive(u, clock, clock.t + 3 * 60_000);
    assert.deepEqual([p.restarts, r.head], [0, C(1)]);
    assert.match((await u.status()).lastError ?? '', /build of 2000000 failed: error TS2322/);
    r.remote = C(3);
    await drive(u, clock, clock.t + 3 * 60_000);
    const st = await u.status();
    assert.deepEqual([p.restarts, st.gate?.ran, st.gate?.ok], [1, false, true]);
    assert.ok(logs.some((m) => /no "regress" script/.test(m)), 'the warning is logged');
    assert.deepEqual(r.gates, [], 'nothing to run');
  }

  // POST /update/now: no debounce; while a phone is in use it waits (unless forced); a quiet hour lets it go
  {
    const { r, sh } = repo(C(1));
    const { p, onRestart } = proc();
    const clock = { t: Date.parse('2026-11-27T14:00:00') };
    const u = createUpdater(onRestart, { sh, now: () => clock.t, quietStartHour: null, hasScript: () => true, log: quietLog, free: () => ({ free: false, who: ['hand:post on A'] }) });
    r.remote = C(2);
    const res = await u.now();
    assert.equal(res.started, false);
    assert.match(res.reason ?? '', /built 2000000; the restart waits until no phone is in use \(hand:post on A\)/);
    assert.deepEqual([(await u.status()).state, (await u.status()).waitingFor], ['ready', ['hand:post on A']]);
    assert.equal((await u.now({ force: true })).started, true);
    await sleep(600);
    assert.deepEqual([p.restarts, p.devices.closes], [1, 0]);

    const q = repo(C(1));
    const q2 = proc();
    const night = { t: new Date(2026, 10, 28, 3, 30).getTime() };
    const v = createUpdater(q2.onRestart, { sh: q.sh, now: () => night.t, quietStartHour: 3, hasScript: () => true, log: quietLog, free: () => ({ free: false, who: ['owner on A'] }) });
    q.r.remote = C(2);
    await drive(v, night, night.t + 3 * 60_000);
    assert.equal(q2.p.restarts, 1, 'at the quiet hour a ready build restarts even with a lease held');
  }
  ok('updater: pushes settle before a build, built and gated in the background, restarted into only when every phone is Free; 5 pushes in 10 min: 0 runner restarts; a failed gate keeps the old build');
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
      // 2026-11-27: the old fields as they were, and the state machines' own beside them (additive: an old client ignores them)
      const old = (m: any) => ({ type: m.type, udid: m.udid, control: m.control, controlDown: m.controlDown, needsReplug: m.needsReplug, restarting: m.restarting });
      assert.deepEqual(old(ctl()[0]), { type: 'control', udid, control: 'ready', controlDown: null, needsReplug: false, restarting: null });
      assert.deepEqual([ctl()[0].state, ctl()[0].onPhone, ctl()[0].lease], ['ready', null, { kind: 'free' }]);
      await sleep(200);
      assert.equal(ctl().length, 1, 'nothing more while nothing changes');
      fake = { control: 'recovering', restarting: { attempt: 1, of: 4, since: 1 } };
      await until('recovering pushed', () => ctl().length === 2);
      assert.deepEqual(old(ctl()[1]), { type: 'control', udid, control: 'recovering', controlDown: null, needsReplug: false, restarting: { attempt: 1, of: 4, since: 1 } });
      assert.equal(ctl()[1].state, 'restarting');
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
