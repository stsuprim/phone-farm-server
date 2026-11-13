// WebRTC live view in mock mode: signaling over the control socket, the H.264 track (RTP with the offered payload
// type, an IDR after a PLI), the "input"/"input-r" data channels (acks, pong, ts), stats, and rtc-error fallbacks.
// The client side is node-datachannel too (a browser would do the same with RTCPeerConnection).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import ndc from 'node-datachannel';
import WebSocket from 'ws';
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
    await sleep(20);
  }
}

/** NAL type of an RTP H.264 packet (FU-A/STAP-A unwrapped), and whether it starts a NAL. */
function rtpNal(pkt: Buffer): { pt: number; nal: number; ts: number } | null {
  if (pkt.length < 13 || pkt[0]! >> 6 !== 2) return null;
  const pt = pkt[1]! & 0x7f;
  if (pt >= 72 && pt <= 76) return null; // RTCP
  let off = 12 + 4 * (pkt[0]! & 0x0f);
  if (pkt[0]! & 0x10) off += 4 + 4 * pkt.readUInt16BE(off + 2);
  const t = pkt[off]! & 0x1f;
  const nal = t === 28 ? (pkt[off + 1]! & 0x80 ? pkt[off + 1]! & 0x1f : -1) : t === 24 ? pkt[off + 3]! & 0x1f : t;
  return { pt, nal, ts: pkt.readUInt32BE(4) };
}

const token = crypto.randomBytes(16).toString('hex');
const backend = new MockBackend(4, { h264IdleMs: 300 });
const server = createServer(backend, token);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = { authorization: `Bearer ${token}` };
const phones: any[] = await (await fetch(`http://${base}/phones`, { headers: auth })).json();
const udid = phones.find((p) => p.online).udid;

const control = new WebSocket(`ws://${base}/phones/${udid}/control?token=${token}`);
const inbox: any[] = [];
control.on('message', (d) => inbox.push(JSON.parse(d.toString())));
await new Promise((r) => control.once('open', r));
const sendCtl = (m: unknown) => control.send(JSON.stringify(m));

const pc = new ndc.PeerConnection('client', { iceServers: [] });
let offered = false;
let rtp = 0;
const nals: { nal: number; at: number; pt: number; ts: number }[] = [];
let failed = false;
try {
  // ---- signaling ----
  pc.onLocalDescription((sdp, type) => {
    if (type !== 'offer' || offered) return;
    offered = true;
    sendCtl({ type: 'rtc-offer', sdp, want: { fps: 30, scale: 100 } });
  });
  pc.onLocalCandidate((candidate, mid) => sendCtl({ type: 'rtc-ice', candidate: candidate.replace(/^a=/, ''), mid }));
  const v = new ndc.Video('0', 'RecvOnly');
  v.addH264Codec(102, 'profile-level-id=42001f;packetization-mode=1;level-asymmetry-allowed=1');
  v.addH264Codec(125, 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1');
  v.parseSdpLine('a=extmap:12 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay');
  const track = pc.addTrack(v);
  track.onMessage((m) => {
    const n = rtpNal(m);
    if (!n) return;
    rtp++;
    if (n.nal > 0) nals.push({ ...n, at: Date.now() });
  });
  const input = pc.createDataChannel('input', { unordered: true, maxRetransmits: 0 });
  const inputR = pc.createDataChannel('input-r');
  const rmsgs: any[] = [];
  inputR.onMessage((m) => rmsgs.push(JSON.parse(String(m))));
  pc.setLocalDescription();

  await until('rtc-answer', () => inbox.some((m) => m.type === 'rtc-answer'));
  const answer = inbox.find((m) => m.type === 'rtc-answer');
  assert.match(answer.sdp, /m=video/);
  assert.match(answer.sdp, /a=sendonly/);
  assert.match(answer.sdp, /a=rtpmap:125 H264\/90000/, 'answers with the 42e01f packetization-mode=1 payload type');
  assert.match(answer.sdp, /playout-delay/);
  assert.doesNotMatch(answer.sdp, /typ (srflx|relay)/, 'host candidates only');
  pc.setRemoteDescription(answer.sdp, 'answer');
  // trickle: candidates already received, and any that come later
  let applied = 0;
  const applyIce = () => {
    for (const m of inbox.filter((x) => x.type === 'rtc-ice').slice(applied)) {
      assert.doesNotMatch(m.candidate, /^a=/);
      pc.addRemoteCandidate(m.candidate, m.mid);
      applied++;
    }
  };
  const iceTimer = setInterval(applyIce, 20);
  await until('rtc-hello', () => inbox.some((m) => m.type === 'rtc-hello'));
  const hello = inbox.find((m) => m.type === 'rtc-hello');
  assert.equal(hello.codec, 'h264');
  for (const k of ['width', 'height', 'fps', 'scale', 'server_time']) assert.equal(typeof hello[k], 'number');
  ok(`signaling: rtc-offer -> rtc-answer (PT 125, playout-delay, host only), trickle ICE, rtc-hello ${hello.width}x${hello.height}`);

  // ---- media ----
  await until('RTP video', () => nals.some((n) => n.nal === 5) && nals.some((n) => n.nal === 1));
  clearInterval(iceTimer);
  assert.ok(nals.every((n) => n.pt === 125));
  const firstSps = nals.findIndex((n) => n.nal === 7);
  const firstIdr = nals.findIndex((n) => n.nal === 5);
  assert.ok(firstSps >= 0 && firstSps < firstIdr, 'SPS/PPS go before the first IDR');
  assert.equal(nals[firstSps]!.ts, nals[firstIdr]!.ts, 'config and keyframe share one RTP timestamp');
  ok(`H.264 over RTP: ${rtp} packets, config before keyframe`);

  // PLI -> IDR well before the 2 s interval
  await sleep(150);
  const ssrcLine = /a=ssrc:(\d+)/.exec(answer.sdp);
  const media = Number(ssrcLine?.[1] ?? 0);
  const pli = Buffer.from([0x81, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0]);
  pli.writeUInt32BE(media >>> 0, 8);
  const asked = Date.now();
  track.sendMessageBinary(pli);
  await until('IDR after PLI', () => nals.some((n) => n.nal === 5 && n.at > asked), 1500);
  const idrIn = nals.find((n) => n.nal === 5 && n.at > asked)!.at - asked;
  ok(`RTCP PLI -> keyframe in ${idrIn} ms`);

  // ---- input channels ----
  await until('input channels open', () => input.isOpen() && inputR.isOpen());
  inputR.sendMessage(JSON.stringify({ id: 1, type: 'tap', x: 100, y: 200 }));
  inputR.sendMessage(JSON.stringify({ type: 'touch', phase: 'down', x: 30, y: 600, t: 0 }));
  for (let i = 1; i <= 10; i++) input.sendMessage(JSON.stringify({ type: 'touch', phase: 'move', x: 30 + i, y: 600 - i * 20, t: i * 16 }));
  await sleep(50);
  inputR.sendMessage(JSON.stringify({ id: 2, type: 'touch', phase: 'up', x: 40, y: 400, t: 200 }));
  inputR.sendMessage(JSON.stringify({ id: 3, type: 'fly' }));
  inputR.sendMessage(JSON.stringify({ type: 'ping', t: 7 }));
  await until('acks', () => rmsgs.filter((m) => m.type === 'ack').length >= 3 && rmsgs.some((m) => m.type === 'pong'));
  const acks = rmsgs.filter((m) => m.type === 'ack');
  assert.deepEqual(acks.filter((a) => a.ok).map((a) => a.id).sort(), [1, 2]);
  assert.equal(acks.find((a) => a.id === 3).ok, false);
  assert.equal(rmsgs.find((m) => m.type === 'pong').t, 7);
  await until('ts message', () => rmsgs.some((m) => m.type === 'ts'), 3000);
  const ts = rmsgs.find((m) => m.type === 'ts');
  assert.ok(Number.isInteger(ts.rtp) && Math.abs(ts.capture_time - Date.now()) < 10000);
  ok('data channels: input (moves) + input-r (tap/down/up acks, pong, ts {rtp, capture_time})');

  // ---- stats ----
  const st = (await (await fetch(`http://${base}/phones`, { headers: auth })).json()).find((p: any) => p.udid === udid).stats;
  assert.equal(st.codec, 'h264');
  assert.equal(st.viewers_webrtc, 1);
  assert.ok(['loopback', 'lan', 'tailscale', 'direct'].includes(st.path), `path ${st.path}`);
  assert.ok(st.fps > 0);
  assert.equal(typeof st.capture_to_encoded_ms, 'number');
  assert.equal(typeof st.encoded_to_sent_ms, 'number');
  ok(`stats: ${st.fps} fps, ${st.viewers} viewer(s), path ${st.path}, capture->encoded ${st.capture_to_encoded_ms} ms, encoded->sent ${st.encoded_to_sent_ms} ms`);

  // ---- errors fall back ----
  sendCtl({ type: 'rtc-offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n' });
  await until('rtc-error', () => inbox.some((m) => m.type === 'rtc-error'));
  assert.match(inbox.find((m) => m.type === 'rtc-error').reason, /video/);
  ok('a bad offer gets rtc-error (client falls back to the WebSocket stream)');
} catch (err) {
  failed = true;
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try {
    pc.close();
  } catch {
    /* ignore */
  }
  control.close();
  server.closeAllConnections();
  server.close();
  await backend.close();
  rtcCleanup();
  if (!failed) console.log(`\nall ${passed} WebRTC checks passed`);
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}
