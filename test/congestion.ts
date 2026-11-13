// Congestion control for slow / far links: the rate controller, ping-based WebSocket flow control, RTCP feedback
// parsing, the encoder bitrate following the slowest viewer, and end to end: an H.264 WebSocket viewer whose pongs stop
// coming gets no more frames (no queue builds up), and gets a keyframe and deltas again once they come back.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { bitrateAsk, MIN_BPS, parseRtcp, RateControl, WsFlow } from '../src/congestion.js';
import { H264Source, H264Viewer, KIND, ProducerHooks, Transport } from '../src/h264.js';
import { MockBackend } from '../src/mock.js';
import { isRemote, rtcWant } from '../src/rtc.js';
import { createServer } from '../src/server.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the client's bitrate ask ----
{
  assert.equal(bitrateAsk('4000'), 4_000_000);
  assert.equal(bitrateAsk(10000), 10_000_000);
  assert.equal(bitrateAsk(2_500_000), 2_500_000);
  assert.equal(bitrateAsk('50'), MIN_BPS);
  assert.equal(bitrateAsk(null), null);
  assert.equal(bitrateAsk(''), null);
  assert.equal(bitrateAsk('x'), null);
  assert.equal(rtcWant({ fps: 60, scale: 50, bitrate: 4000 }).bitrate, 4_000_000);
  assert.equal(rtcWant({ fps: 60 }).bitrate, null);
  assert.equal(isRemote('100.95.176.73'), true);
  assert.equal(isRemote('::ffff:100.105.101.113'), true);
  assert.equal(isRemote('82.17.8.138'), true);
  assert.equal(isRemote('192.168.68.20'), false);
  assert.equal(isRemote('127.0.0.1'), false);
  ok('bitrate asks in kbit/s (Lotus) or bit/s; Tailscale / public clients count as remote, LAN and loopback not');
}

// ---- the rate controller ----
{
  let t = 0;
  const rc = new RateControl(8_000_000, 2_000_000, MIN_BPS, () => t);
  assert.equal(rc.bps, 2_000_000);
  t = 500;
  assert.equal(rc.up(), false, 'no raise within a second');
  t = 1000;
  assert.equal(rc.up(), true);
  assert.equal(rc.bps, 2_160_000);
  t = 1100;
  assert.equal(rc.down(0.85, 1_000_000), true);
  assert.equal(rc.bps, 1_080_000, 'never below half at once, even when the link delivered less');
  t = 1500;
  assert.equal(rc.down(0.85), false, 'one cut per hold time');
  t = 2500;
  assert.equal(rc.up(), false, 'no raise within 2 s of a cut');
  t = 3200;
  assert.equal(rc.up(), true);
  for (let i = 0; i < 100; i++) {
    t += 1000;
    rc.up();
  }
  assert.equal(rc.bps, 8_000_000, 'up to the ceiling, not past it');
  for (let i = 0; i < 100; i++) {
    t += 1000;
    rc.down(0.5);
  }
  assert.equal(rc.bps, MIN_BPS, 'down to the floor, not past it');
  ok('rate control: starts where asked, +8 %/s after 2 clean seconds, cuts once per hold, floor and ceiling');
}

// ---- WebSocket flow control, on a fake socket and clock ----
{
  let t = 0;
  let onPong!: (d: Buffer) => void;
  const pings: Buffer[] = [];
  const sock = { ping: (b?: Buffer) => void pings.push(b!), on: (_e: 'pong', f: (d: Buffer) => void) => void (onPong = f) };
  let acks = 0;
  const flow = new WsFlow(sock, (b) => sock.ping(b), { targetMs: 250, now: () => t, onAck: () => acks++ });
  assert.equal(flow.congested(), false);
  flow.sent(100_000);
  assert.equal(pings.length, 1);
  t = 5;
  flow.sent(100_000);
  assert.equal(pings.length, 1, 'at most one ping per 15 ms');
  t = 200;
  onPong(pings[0]!);
  assert.equal(flow.rtt, 200);
  assert.equal(acks, 1);
  assert.equal(flow.congested(), false);
  // a queue builds: pings stop coming back
  t = 300;
  flow.sent(100_000);
  t = 400;
  assert.equal(flow.congested(), false);
  t = 760;
  assert.equal(flow.congested(), true, 'oldest unanswered ping waited 460 ms, 260 beyond the 200 ms base');
  t = 900;
  onPong(pings[1]!);
  assert.equal(flow.congested(), false, 'everything answered');
  assert.equal(flow.lastQueueMs(), 400);
  assert.ok(flow.delivered! > 0, 'delivered rate from the acknowledged bytes');
  // pongs that aren't ours are ignored
  onPong(Buffer.from('nope'));
  onPong(Buffer.alloc(4));
  // a client that never answers: flow control turns itself off instead of starving it
  let t2 = 0;
  const silent = new WsFlow({ ping: () => {}, on: () => {} }, () => {}, { now: () => t2 });
  silent.sent(10);
  t2 = 1000;
  assert.equal(silent.congested(), true);
  t2 = 10_500;
  assert.equal(silent.congested(), false);
  assert.equal(silent.disabled, true);
  ok('WebSocket flow: a ping behind the frames; congested while the oldest waits > base + 250 ms; rate from acks');
}

// ---- RTCP feedback ----
{
  // RR with one report block: fraction lost 64/256
  const rr = Buffer.alloc(32);
  rr[0] = 0x81;
  rr[1] = 201;
  rr.writeUInt16BE(7, 2);
  rr.writeUInt32BE(1, 4);
  rr.writeUInt32BE(1234, 8);
  rr[12] = 64;
  // generic NACK: PID + BLP with 3 bits = 4 packets
  const nack = Buffer.alloc(16);
  nack[0] = 0x81;
  nack[1] = 205;
  nack.writeUInt16BE(3, 2);
  nack.writeUInt16BE(100, 12);
  nack.writeUInt16BE(0b1011, 14);
  // REMB 1.5 Mbps: exp 4, mantissa 93750
  const remb = Buffer.alloc(24);
  remb[0] = 0x8f;
  remb[1] = 206;
  remb.writeUInt16BE(5, 2);
  remb.write('REMB', 12, 'latin1');
  remb[16] = 1;
  remb[17] = (4 << 2) | (93750 >> 16);
  remb.writeUInt16BE(93750 & 0xffff, 18);
  const pli = Buffer.from([0x81, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2]);
  const info = parseRtcp(Buffer.concat([rr, nack, remb, pli]));
  assert.equal(info.fractionLost, 0.25);
  assert.equal(info.nacked, 4);
  assert.equal(info.remb, 1_500_000);
  assert.equal(info.wantsKey, true);
  const none = parseRtcp(Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 1]));
  assert.deepEqual(none, { fractionLost: null, nacked: 0, remb: null, wantsKey: false });
  assert.doesNotThrow(() => parseRtcp(Buffer.from([0x81, 201, 0, 50, 1, 2])));
  ok('RTCP: receiver report loss, NACKed packets, REMB, PLI in one compound packet; short packets are safe');
}

// ---- the shared encoder follows the slowest viewer ----
{
  const rates: number[] = [];
  let hooks!: ProducerHooks;
  const src = new H264Source(
    't',
    (_w, h) => {
      hooks = h;
      return { key: () => {}, stop: () => {}, bitrate: (b) => void rates.push(b) };
    },
    { fps: 30, scale: 100, bitrate: 8_000_000 },
    { log: () => {} },
  );
  const transport = (): Transport => ({ kind: 'ws', buffered: () => 0, open: () => true, send: () => {}, fail: () => {} });
  const opened = src.open();
  hooks.record({ kind: KIND.INFO, time: 0, payload: Buffer.from('{"width":10,"height":20,"fps":30}'), arrived: 0 });
  hooks.record({ kind: KIND.KEY, time: 1, payload: Buffer.from([0, 0, 0, 1, 0x65]), arrived: 0 });
  await opened;
  const lan = new H264Viewer(transport(), src);
  const far = new H264Viewer(transport(), src);
  src.add(lan);
  src.add(far);
  src.setTarget(lan, 8_000_000);
  assert.deepEqual(rates, [], 'already at 8 Mbps');
  src.setTarget(far, 2_000_000);
  assert.deepEqual(rates, [2_000_000]);
  src.setTarget(far, 2_020_000);
  assert.deepEqual(rates, [2_000_000], 'changes under 3 % are not sent');
  src.setTarget(far, 3_000_000);
  assert.equal(rates.at(-1), 3_000_000);
  assert.equal(src.stats().bitrate_kbps, 3000);
  src.remove(far);
  assert.equal(rates.at(-1), 8_000_000, 'back up when the slow viewer leaves');
  src.close();
  ok('the encoder runs at the slowest viewer\'s target, never above the start setting, and recovers when it leaves');
}

// ---- end to end: a viewer that stops answering pings stops getting frames ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(2, { h264IdleMs: 300 });
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const list: any[] = await (await fetch(`http://127.0.0.1:${port}/phones`, { headers: { authorization: `Bearer ${token}` } })).json();
    const udid = list.find((p) => p.online).udid;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/phones/${udid}/stream?token=${token}&codec=h264&fps=30&bitrate=4000`, { autoPong: false });
    const bins: { at: number; kind: number }[] = [];
    let answering = false;
    ws.on('ping', (d) => answering && ws.pong(d));
    ws.on('message', (d, isBinary) => isBinary && bins.push({ at: Date.now(), kind: (d as Buffer)[0]! }));
    await new Promise((r) => ws.once('open', r));
    await sleep(1500);
    const quietFrom = Date.now() - 700;
    const late = bins.filter((b) => b.at >= quietFrom).length;
    assert.ok(late <= 1, `no pongs: frames stop (got ${late} in the last 700 ms)`);
    const before = bins.length;
    answering = true;
    // answer what's outstanding: the latest ping's pong acknowledges everything before it
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && !(bins.slice(before).some((b) => b.kind === 2) && bins.slice(before).filter((b) => b.kind === 3).length >= 3)) await sleep(20);
    const after = bins.slice(before);
    assert.ok(after.some((b) => b.kind === 2), 'a keyframe once pongs come back');
    assert.ok(after.filter((b) => b.kind === 3).length >= 3, 'then deltas');
    ws.close();
    ok(`H.264 WebSocket: no pongs -> no frames (${late} late), pongs back -> keyframe + ${after.filter((b) => b.kind === 3).length} deltas`);
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
}

console.log(`\nall ${passed} congestion checks passed`);
setTimeout(() => process.exit(0), 100).unref();
