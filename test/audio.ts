// The phone's sound in the live view (2026-11-16, src/audio.ts): the helper's audio records reach the sound and never
// the picture's lanes; "audio on/off" follows the listeners; a capture that dies with sound on falls back to none; the
// WebRTC session's Opus track (its own SSRC, a 48 kHz clock in 20 ms steps, the offer's payload type) next to the
// H.264 one, and a session without sound keeps its picture; the phone's volume goes up only once the sound flows to
// the Mac, back to 0 when nobody listens (the capture held open meanwhile), and a crash's raise is put right at start.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import ndc from 'node-datachannel';
import WebSocket from 'ws';
import { AudioHub, AudioRtpClock, audioPlan, parseOfferAudio, pressesFor, VOLUME_STEPS, VolumeGuard } from '../src/audio.js';
import { encodeRecord, KIND, RecordParser } from '../src/h264.js';
import { PhonecapHost } from '../src/lanes.js';
import { MockBackend } from '../src/mock.js';
import { rtcCleanup } from '../src/rtc.js';
import { createServer } from '../src/server.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

// ---- the offer's audio section, the plan, the RTP clock ----
{
  const chrome = [
    'v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 102', 'a=mid:0', 'a=recvonly', 'a=rtpmap:102 H264/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8', 'a=mid:1', 'a=recvonly', 'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtpmap:0 PCMU/8000', '',
  ].join('\r\n');
  const a = parseOfferAudio(chrome)!;
  assert.deepEqual([a.mid, a.opus, a.pcmu], ['1', 111, 0]);
  assert.match(a.opusFmtp, /useinbandfec/);
  assert.equal(parseOfferAudio(chrome.replace(/m=audio[\s\S]*/, '')), null, 'no audio section: no sound asked');
  assert.equal(parseOfferAudio(chrome.replace('m=audio 9', 'm=audio 0')), null, 'a rejected section');
  assert.equal(parseOfferAudio(chrome.replace('a=mid:1\r\na=recvonly', 'a=mid:1\r\na=inactive')), null, 'an inactive one');
  assert.deepEqual(audioPlan(a, 'opus'), { codec: 'opus', pt: 111, rate: 48000, frameSamples: 960 });
  assert.deepEqual(audioPlan(a, 'pcmu'), { codec: 'pcmu', pt: 0, rate: 8000, frameSamples: 160 });
  assert.equal(typeof audioPlan({ ...a, opus: null }, 'opus'), 'string', 'no Opus offered: a reason');

  const c = new AudioRtpClock(48000, 960);
  const t0 = 1_700_000_000_000;
  const jitter = [0, 3, -2, 5, 1, -4, 2];
  const ts = jitter.map((j, i) => c.stamp(t0 + i * 20 + j));
  for (let i = 1; i < ts.length; i++) assert.equal(ts[i]! - ts[i - 1]!, 960, 'frames in a row: exactly 960 ticks apart, whatever the capture jitter');
  const afterGap = c.stamp(t0 + ts.length * 20 + 500);
  assert.equal(afterGap, Math.round((ts.length * 20 + 500) * 48), 'a gap: anchored to the capture clock again');
  assert.ok(c.stamp(t0) > afterGap, 'never backwards');
  ok('the offer\'s audio (Opus pt, PCMU, rejected/inactive), the plan, a 48 kHz RTP clock in 960-tick steps re-anchored after a gap');
}

// ---- the helper's records: the sound never reaches the lanes ----
{
  const got: number[] = [];
  const p = new RecordParser((r) => got.push(r.kind));
  p.push(Buffer.concat([encodeRecord(5, 1, Buffer.from([1, 2])), encodeRecord(6, 2, Buffer.from('{}')), encodeRecord(3, 3, Buffer.from([0, 0, 1, 1]))]));
  assert.deepEqual(got, [5, 6, 3]);
  assert.throws(() => new RecordParser(() => {}).push(encodeRecord(11, 0, Buffer.alloc(0))), 'kind 11 is still a corrupt stream (7-10: heartbeat, still, repeats)');

  // a fake phonecap: what it was started with, what it's told, records it "writes"
  type Fake = ChildProcess & { lines: string[]; args: string[]; out: PassThrough; die(code?: number): void };
  const spawned: Fake[] = [];
  const spawn = (_bin: string, args: string[]): ChildProcess => {
    const ee = new EventEmitter() as Fake;
    const out = new PassThrough();
    const lines: string[] = [];
    const stdin = new PassThrough();
    stdin.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean)));
    Object.assign(ee, { stdout: out, stderr: new PassThrough(), stdin, lines, args, out, kill: (s: string) => (setImmediate(() => ee.emit('exit', null, s)), true), die: (code = 4) => ee.emit('exit', code, null) });
    spawned.push(ee);
    return ee;
  };
  const sink = { frames: 0, infos: 0, ends: 0, why: [] as (string | null)[], frame() { this.frames++; }, infoRecord() { this.infos++; }, ended() { this.ends++; }, unavailable(r: string | null) { this.why.push(r); } };
  const host = new PhonecapHost('phonecap', ['--udid', 'X'], 'test', spawn, sink);
  const lane: number[] = [];
  const exits: string[] = [];
  const prod = host.start({ fps: 30, scale: 50, bitrate: 1_000_000 }, { record: (r) => lane.push(r.kind), exit: (w) => exits.push(w) });
  let f = spawned[0]!;
  assert.ok(f.args.includes('--audio'), 'started with --audio when there is somewhere for the sound to go');
  assert.equal(f.lines.filter((l) => l.startsWith('audio')).length, 0, 'no sound sent while nobody listens');
  host.setAudio(true);
  assert.deepEqual(f.lines.slice(-1), ['audio on']);
  f.out.write(Buffer.concat([encodeRecord(6, 1, Buffer.from('{"codec":"opus"}')), encodeRecord(5, 2, Buffer.from([9])), encodeRecord(KIND.KEY, 3, Buffer.from([0, 0, 1, 0x65])), encodeRecord(5, 4, Buffer.from([9]))]));
  await sleep(10);
  assert.deepEqual([sink.infos, sink.frames], [1, 2], 'kinds 5 and 6 go to the sound');
  assert.deepEqual(lane, [KIND.KEY], 'and only the picture reaches the lane');
  host.setAudio(false);
  assert.deepEqual(f.lines.slice(-1), ['audio off']);

  // held open after its last lane (the volume going back down), closed on the release
  const release = host.hold();
  prod.stop();
  assert.equal(host.running, true, 'held: still capturing (the sound is still on the Mac)');
  const again = host.start({ fps: 30, scale: 50, bitrate: 1_000_000 }, { record: () => {}, exit: () => {} });
  assert.equal(spawned.length, 1, 'a viewer back during the hold takes up the same capture');
  again.stop();
  release();
  assert.equal(host.running, false, 'released: stopped');
  assert.ok(sink.ends >= 1, 'the sound heard that the capture ended');
  await sleep(5); // the ended phonecap exits (a new one never starts on its screen device before)

  // a capture that dies before any picture with sound on, twice: the next one goes without sound (the video first)
  host.setAudio(true);
  host.start({ fps: 30, scale: 50, bitrate: 1_000_000 }, { record: () => {}, exit: () => {} });
  f = spawned[1]!;
  assert.ok(f.args.includes('--audio'));
  assert.deepEqual(f.lines.filter((l) => l.startsWith('audio')), ['audio on'], 'a listener waiting: "audio on" right at the start');
  f.die();
  host.start({ fps: 30, scale: 50, bitrate: 1_000_000 }, { record: () => {}, exit: () => {} });
  spawned[2]!.die();
  host.start({ fps: 30, scale: 50, bitrate: 1_000_000 }, { record: () => {}, exit: () => {} });
  assert.ok(!spawned[3]!.args.includes('--audio'), 'twice dead before a picture with sound: started without it');
  assert.match(String(sink.why[sink.why.length - 1]), /without sound/);
  host.close();
  ok('helper records: sound to the sound, picture to the lanes; "audio on/off" with the listeners; held open for the volume; no sound after two early deaths');
}

// ---- one phone's sound: listeners, flowing, quiet ----
{
  const log: string[] = [];
  const hub = new AudioHub('t', { enable: (on) => log.push(on ? 'on' : 'off'), flowing: () => log.push('flowing'), quiet: (e) => log.push(e ? 'ended' : 'quiet'), log: () => {} });
  hub.frame({ time: 1, payload: Buffer.alloc(1) });
  assert.deepEqual(log, [], 'a frame nobody hears raises nothing');
  const heard: number[] = [];
  const off1 = hub.listen((f) => heard.push(f.time));
  const off2 = hub.listen(() => {});
  assert.deepEqual(log, ['on'], 'on with the first listener only');
  hub.frame({ time: 2, payload: Buffer.alloc(1) });
  hub.frame({ time: 3, payload: Buffer.alloc(1) });
  assert.deepEqual(log, ['on', 'flowing'], 'flowing once, at the first frame heard');
  assert.deepEqual(heard, [2, 3]);
  off1();
  off1();
  assert.deepEqual(log, ['on', 'flowing'], 'a listener left, one is still there');
  off2();
  assert.deepEqual(log, ['on', 'flowing', 'off', 'quiet'], 'the last one gone: off, and quiet (the volume back down)');
  const off3 = hub.listen(() => {});
  hub.frame({ time: 4, payload: Buffer.alloc(1) });
  hub.ended();
  assert.deepEqual(log.slice(-3), ['on', 'flowing', 'ended'], 'the capture ended under a listener: back down at once');
  hub.ended();
  assert.equal(log.filter((x) => x === 'ended').length, 1);
  hub.infoRecord(Buffer.from('{"codec":"none","reason":"no mic"}'));
  assert.equal(hub.reason(), 'no mic');
  hub.infoRecord(Buffer.from('{"codec":"pcmu","rate":8000}'));
  assert.deepEqual([hub.reason(), hub.codec()], [null, 'pcmu']);
  off3();
  ok('the sound hub: on with the first listener, the volume raised only once a frame flows, back down when the last leaves or the capture ends');
}

// ---- the phone's volume ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-vol-'));
  const file = path.join(dir, 'audio-volume.json');
  const presses: string[] = [];
  let failNext = 0;
  const press = async (udid: string, d: 'up' | 'down') => {
    if (failNext > 0) {
      failNext--;
      throw new Error('WDA busy');
    }
    // the file names the phone before its first press up
    if (d === 'up' && !presses.some((p) => p.startsWith(`${udid}:up`))) assert.ok(JSON.parse(fs.readFileSync(file, 'utf8'))[udid], 'named in the file before the first press');
    presses.push(`${udid}:${d}`);
    await sleep(1);
  };
  const v = new VolumeGuard({ percent: 50, press, file, log: () => {}, retryMs: 30 });
  assert.equal(pressesFor(50), 8);
  assert.equal(pressesFor(0), 0);
  assert.equal(pressesFor(100), VOLUME_STEPS);
  await v.raise('A');
  assert.deepEqual(presses, Array(8).fill('A:up'));
  assert.equal(v.isRaised('A'), true);
  await v.raise('A');
  assert.equal(presses.length, 8, 'raised once');
  await v.lower('A');
  assert.equal(presses.filter((p) => p === 'A:down').length, VOLUME_STEPS + 1, 'down all the way: 0 for sure');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'and the file says nothing is raised');
  presses.length = 0;
  await v.lower('B');
  assert.deepEqual(presses, [], 'a phone never raised is never touched');

  // a raise cut short by a lower: it stops going up and goes all the way down
  const r = v.raise('C');
  await sleep(3);
  const l = v.lower('C');
  await Promise.all([r, l]);
  const cUp = presses.filter((p) => p === 'C:up').length;
  assert.ok(cUp < 8, `the raise stopped (${cUp} presses up)`);
  assert.equal(presses.filter((p) => p === 'C:down').length, VOLUME_STEPS + 1);
  assert.equal(v.isRaised('C'), false);

  // a crash after a raise: the next start finds it in the file and puts it back to 0 (retried while WDA is busy)
  presses.length = 0;
  await v.raise('D');
  v.close();
  const v2 = new VolumeGuard({ percent: 50, press, file, log: () => {}, retryMs: 30 });
  assert.deepEqual(v2.pending(), ['D']);
  failNext = 1;
  v2.recover();
  await until('the left-raised phone lowered', () => !v2.isRaised('D'), 3000);
  assert.equal(presses.filter((p) => p === 'D:down').length, VOLUME_STEPS + 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  const off = new VolumeGuard({ percent: 0, press, file, log: () => {} });
  presses.length = 0;
  await off.raise('E');
  assert.deepEqual(presses, [], 'AUDIO_PHONE_VOLUME=0: never touched');
  v2.close();
  fs.rmSync(dir, { recursive: true, force: true });
  ok('the volume: up only when asked (named in the file first), down all the way, a raise cut short, a crash put right at start, 0 % never touches it');
}

// ---- WebRTC: the Opus track beside the picture ----
const sessions = async (backend: MockBackend, withAudio: boolean) => {
  const token = crypto.randomBytes(16).toString('hex');
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}` };
  const phones: any[] = await (await fetch(`http://${base}/phones`, { headers: auth })).json();
  const udid = phones.find((p) => p.online).udid as string;
  const control = new WebSocket(`ws://${base}/phones/${udid}/control?token=${token}`);
  const inbox: any[] = [];
  control.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((r) => control.once('open', r));
  const sendCtl = (m: unknown) => control.send(JSON.stringify(m));
  const pc = new ndc.PeerConnection('client', { iceServers: [] });
  const video: { ssrc: number }[] = [];
  const audio: { ssrc: number; pt: number; ts: number; at: number }[] = [];
  let offered = false;
  pc.onLocalDescription((sdp, type) => {
    if (type !== 'offer' || offered) return;
    offered = true;
    sendCtl({ type: 'rtc-offer', sdp, want: { fps: 30, scale: 100 } });
  });
  pc.onLocalCandidate((candidate, mid) => sendCtl({ type: 'rtc-ice', candidate: candidate.replace(/^a=/, ''), mid }));
  const v = new ndc.Video('0', 'RecvOnly');
  v.addH264Codec(125, 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1');
  const vt = pc.addTrack(v);
  vt.onMessage((m) => {
    if (m.length > 12 && m[0]! >> 6 === 2 && !((m[1]! & 0x7f) >= 72 && (m[1]! & 0x7f) <= 76)) video.push({ ssrc: m.readUInt32BE(8) });
  });
  // the tracks and channels are kept referenced to the end (a collected one under a live native callback crashes node)
  const keep: unknown[] = [vt];
  if (withAudio) {
    const a = new ndc.Audio('1', 'RecvOnly');
    a.addOpusCodec(111);
    const at = pc.addTrack(a);
    keep.push(at);
    at.onMessage((m) => {
      const pt = m[1]! & 0x7f;
      if (m.length > 12 && m[0]! >> 6 === 2 && !(pt >= 72 && pt <= 76)) audio.push({ ssrc: m.readUInt32BE(8), pt, ts: m.readUInt32BE(4), at: Date.now() });
    });
  }
  keep.push(pc.createDataChannel('input-r'));
  pc.setLocalDescription();
  await until('rtc-answer', () => inbox.some((m) => m.type === 'rtc-answer'));
  const answer = inbox.find((m) => m.type === 'rtc-answer');
  pc.setRemoteDescription(answer.sdp, 'answer');
  let applied = 0;
  const iceTimer = setInterval(() => {
    for (const m of inbox.filter((x) => x.type === 'rtc-ice').slice(applied)) {
      pc.addRemoteCandidate(m.candidate, m.mid);
      applied++;
    }
  }, 20);
  await until('rtc-hello', () => inbox.some((m) => m.type === 'rtc-hello'));
  const close = async () => {
    clearInterval(iceTimer);
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    control.close();
    server.closeAllConnections();
    server.close();
  };
  return { keep, pc, udid, inbox, answer, hello: inbox.find((m) => m.type === 'rtc-hello'), video, audio, sendCtl, close, base, auth };
};

let failed = false;
const alive: unknown[] = []; // every session's peer connection and tracks, until the process ends
try {
  // with sound
  {
    const backend = new MockBackend(2, { h264IdleMs: 200 });
    const s = await sessions(backend, true);
    alive.push(s);
    assert.match(s.answer.sdp, /m=audio/);
    assert.match(s.answer.sdp, /a=rtpmap:111 opus\/48000\/2/, 'answers Opus on the offered payload type');
    assert.equal(s.hello.audio, true, 'rtc-hello says the sound is on');
    assert.equal(s.hello.audio_reason, null);
    await until('RTP audio and video', () => s.audio.length >= 25 && s.video.length > 5);
    const aSsrc = new Set(s.audio.map((a) => a.ssrc));
    const vSsrc = new Set(s.video.map((x) => x.ssrc));
    assert.equal(aSsrc.size, 1);
    assert.ok(![...aSsrc].some((x) => vSsrc.has(x)), 'the sound has its own SSRC');
    assert.ok(s.audio.every((a) => a.pt === 111));
    const steps = s.audio.slice(1).map((a, i) => (a.ts - s.audio[i]!.ts) >>> 0);
    assert.ok(steps.filter((d) => d === 960).length >= steps.length * 0.8, `48 kHz in 20 ms steps (${steps.slice(0, 8).join(', ')})`);
    const ssrcLines = [...String(s.answer.sdp).matchAll(/a=msid:(\S+) (\S+)/g)].map((m) => m[1]);
    assert.ok(ssrcLines.length >= 2 && ssrcLines.every((x) => x === 'lotus-phone'), 'one stream id for both: the browser syncs them from their sender reports');
    assert.deepEqual(backend.audioLog.slice(0, 2), ['on', 'flowing'], 'the sound turned on with the listener and flowed (the volume would go up now)');
    const st = (await (await fetch(`http://${s.base}/phones`, { headers: s.auth })).json()).find((p: any) => p.udid === s.udid).stats;
    const mine = (st.sessions ?? []).find((x: any) => x.transport === 'webrtc');
    assert.ok(mine?.audio?.on && mine.audio.sent > 0, 'stats.sessions say the sound is sent');
    ok(`WebRTC: an Opus track (pt 111, its own SSRC, same stream id) beside the picture: ${s.audio.length} audio packets, ${s.video.length} video`);

    // the view closes: the sound stops with it, the volume goes back down, the capture stops after its grace
    s.sendCtl({ type: 'rtc-close' });
    await until('sound off', () => backend.audioLog.includes('off'));
    assert.ok(backend.audioLog.includes('quiet'), 'nobody listens: the volume back down');
    await until('capture stopped', () => !backend.capturing(s.udid), 3000);
    const n = s.audio.length;
    await sleep(120);
    assert.equal(s.audio.length, n, 'no sound once the view closed');
    ok('the view closed: the sound off, the volume back down, the capture stopped after its grace');
    await s.close();
    await sleep(400); // the server ends its session on the control socket's close
    await backend.close();
  }
  // the client asked for no sound: the picture as before
  {
    const backend = new MockBackend(2, { h264IdleMs: 200 });
    const s = await sessions(backend, false);
    alive.push(s);
    assert.equal(s.hello.audio, false);
    await until('video', () => s.video.length > 5);
    assert.deepEqual(backend.audioLog, [], 'no sound asked: never turned on');
    await s.close();
    await sleep(400); // the server ends its session on the control socket's close
    await backend.close();
  }
  // no sound on this phone: answered inactive, the picture unaffected, and why
  {
    const backend = new MockBackend(2, { h264IdleMs: 200, audio: 'the capture helper on the Mac has no sound yet' });
    const s = await sessions(backend, true);
    alive.push(s);
    assert.equal(s.hello.audio, false);
    assert.match(String(s.hello.audio_reason), /no sound yet/);
    assert.doesNotMatch(String(s.answer.sdp).split(/\r?\nm=/).find((x: string) => x.startsWith('audio')) ?? '', /a=ssrc:/, 'the audio section carries no sender (no SSRC)');
    await until('video', () => s.video.length > 5);
    assert.equal(s.audio.length, 0);
    ok('no sound for the phone: the audio section answered without a sender, rtc-hello says why, the picture goes on');
    await s.close();
    await sleep(400); // the server ends its session on the control socket's close
    await backend.close();
  }
} catch (err) {
  failed = true;
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  await sleep(300); // libdatachannel's threads finish closing the peer connections before its cleanup
  rtcCleanup();
  if (!failed) console.log(`\nall ${passed} audio checks passed`);
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}
