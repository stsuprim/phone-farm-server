// Unit tests for the H.264 pipeline: helper framing, config-before-key, latest-only drop-to-keyframe,
// helper failure handling, and the WebRTC helpers (offer parsing, RTCP PLI/FIR, path kinds).
import assert from 'node:assert/strict';
import { encodeRecord, H264Source, H264Viewer, KIND, ProducerHooks, Rec, RecordParser, Transport, wsMessage } from '../src/h264.js';
import { mockSpsPps } from '../src/h264mock.js';
import { parseOffer, pathKind, rtcpWantsKey } from '../src/rtc.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- framing ----
{
  const recs: [number, number, Buffer][] = [
    [KIND.INFO, 1, Buffer.from('{"width":10,"height":20,"fps":60}')],
    [KIND.CONFIG, 1700000000000.5, mockSpsPps()],
    [KIND.KEY, 1700000000001.25, Buffer.alloc(70000, 5)],
    [KIND.DELTA, 1700000000002, Buffer.alloc(0)],
    [KIND.DELTA, 1700000000003, Buffer.from([0, 0, 0, 1, 0x41, 1, 2, 3])],
  ];
  const bytes = Buffer.concat(recs.map(([k, t, p]) => encodeRecord(k, t, p)));
  for (const step of [1, 7, 13, 4096, bytes.length]) {
    const got: Rec[] = [];
    const parser = new RecordParser((r) => got.push(r));
    for (let off = 0; off < bytes.length; off += step) parser.push(bytes.subarray(off, off + step));
    assert.equal(got.length, recs.length);
    got.forEach((r, i) => {
      assert.equal(r.kind, recs[i]![0]);
      assert.equal(r.time, recs[i]![1]);
      assert.ok(r.payload.equals(recs[i]![2]));
    });
  }
  const msg = wsMessage({ kind: KIND.KEY, time: 1234.5, payload: Buffer.from([9, 8]), arrived: 0 });
  assert.equal(msg[0], 2);
  assert.equal(msg.readDoubleBE(1), 1234.5);
  assert.deepEqual([...msg.subarray(9)], [9, 8]);
  assert.throws(() => new RecordParser(() => {}).push(Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0])));
  ok('helper framing round-trips in any chunking; WS message = kind + float64 BE time + payload');
}

// ---- a hand-driven producer ----
function manual() {
  let hooks!: ProducerHooks;
  const ctl = { keys: 0, starts: 0, stops: 0, emit: (k: number, p: Buffer = Buffer.from([0, 0, 0, 1, k === KIND.KEY ? 0x65 : 0x41])) => hooks.record({ kind: k, time: Date.now(), payload: p, arrived: Date.now() }), exit: (why: string) => hooks.exit(why) };
  const start = (_w: unknown, h: ProducerHooks) => {
    hooks = h;
    ctl.starts++;
    return { key: () => void ctl.keys++, stop: () => void ctl.stops++ };
  };
  return { ctl, start };
}
function fakeTransport() {
  const sent: number[] = [];
  const t: Transport & { buffered_: number; failed: string | null } = {
    kind: 'ws',
    buffered_: 0,
    failed: null,
    buffered() {
      return this.buffered_;
    },
    open: () => true,
    send: (r) => void sent.push(r.kind),
    fail(why) {
      this.failed = why;
    },
  };
  return { t, sent };
}
const want = { fps: 60, scale: 100, bitrate: 8e6 };
const info = Buffer.from(JSON.stringify({ width: 100, height: 200, fps: 60 }));

// ---- config before key, drop-to-keyframe ----
{
  const { ctl, start } = manual();
  const src = new H264Source('t', start, want, { log: () => {} });
  const opened = src.open();
  assert.equal(ctl.starts, 1);
  ctl.emit(KIND.INFO, info);
  ctl.emit(KIND.CONFIG, mockSpsPps());
  ctl.emit(KIND.KEY);
  const i = await opened;
  assert.equal(i.width, 100);

  // a viewer joining right after a keyframe gets config + key at once and can take deltas
  const a = fakeTransport();
  const va = new H264Viewer(a.t, src);
  src.add(va);
  assert.deepEqual(a.sent, [KIND.CONFIG, KIND.KEY]);
  ctl.emit(KIND.DELTA);
  assert.deepEqual(a.sent, [KIND.CONFIG, KIND.KEY, KIND.DELTA]);

  // a viewer joining after deltas gets the cached config + key, then waits for a fresh key (and one is asked for)
  const b = fakeTransport();
  const vb = new H264Viewer(b.t, src);
  const keysBefore = ctl.keys;
  src.add(vb);
  assert.deepEqual(b.sent, [KIND.CONFIG, KIND.KEY]);
  assert.equal(ctl.keys, keysBefore + 1);
  ctl.emit(KIND.DELTA);
  assert.deepEqual(b.sent, [KIND.CONFIG, KIND.KEY], 'no deltas before the fresh key');
  ctl.emit(KIND.CONFIG, mockSpsPps());
  ctl.emit(KIND.KEY);
  assert.deepEqual(b.sent, [KIND.CONFIG, KIND.KEY, KIND.KEY], 'same config is not repeated');
  ctl.emit(KIND.DELTA);
  assert.equal(b.sent[b.sent.length - 1], KIND.DELTA);

  // backed up: deltas dropped (never queued), a key requested, nothing until the next key once drained
  a.sent.length = 0;
  a.t.buffered_ = 10_000_000;
  const k0 = ctl.keys;
  await sleep(60); // past the source's de-dup window
  ctl.emit(KIND.DELTA);
  ctl.emit(KIND.DELTA);
  assert.deepEqual(a.sent, []);
  assert.equal(ctl.keys, k0 + 1, 'one keyframe asked for');
  a.t.buffered_ = 0;
  ctl.emit(KIND.DELTA);
  assert.deepEqual(a.sent, [], 'still waiting for a keyframe after draining');
  ctl.emit(KIND.KEY);
  ctl.emit(KIND.DELTA);
  assert.deepEqual(a.sent, [KIND.KEY, KIND.DELTA]);
  assert.ok(va.dropped >= 3);

  // a changed config is sent before the key
  a.sent.length = 0;
  ctl.emit(KIND.CONFIG, Buffer.from([0, 0, 0, 1, 0x67, 1]));
  ctl.emit(KIND.KEY);
  assert.deepEqual(a.sent, [KIND.CONFIG, KIND.KEY]);

  // client asks for a key: requested now, deltas skipped until it comes
  a.sent.length = 0;
  await sleep(60);
  const k1 = ctl.keys;
  va.forceKey();
  assert.equal(ctl.keys, k1 + 1);
  ctl.emit(KIND.DELTA);
  ctl.emit(KIND.KEY);
  assert.deepEqual(a.sent, [KIND.KEY]);

  const st = src.stats();
  assert.equal(st.viewers_ws, 2);
  assert.ok(st.fps > 0);
  src.close();
  assert.ok(a.t.failed && b.t.failed);
  ok('config before key; new viewers start from the cached key; latest-only drops to the next keyframe');
}

// ---- idle stop, crash restart, giving up ----
{
  const { ctl, start } = manual();
  const src = new H264Source('t', start, want, { log: () => {}, idleMs: 50, openTimeoutMs: 5000 });
  const p = src.open();
  ctl.emit(KIND.INFO, info);
  ctl.emit(KIND.CONFIG, mockSpsPps());
  ctl.emit(KIND.KEY);
  await p;
  const v = fakeTransport();
  const viewer = new H264Viewer(v.t, src);
  src.add(viewer);
  src.remove(viewer);
  await sleep(120);
  assert.equal(ctl.stops, 1, 'stopped after the idle time');
  assert.equal(src.running, false);

  // three crashes before any keyframe: give up, waiters rejected, unavailable() explains why
  const p2 = src.open();
  ctl.exit('no screen capture device');
  await sleep(700);
  ctl.exit('no screen capture device');
  await sleep(1200);
  ctl.exit('no screen capture device');
  await assert.rejects(p2, /no screen capture device/);
  assert.match(src.unavailable() ?? '', /no screen capture device/);
  src.close();
  ok('helper stops 10 s (here 50 ms) after the last viewer; restarts with backoff; gives up after 3 failed starts');
}

// ---- WebRTC helpers ----
{
  const offer = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 102 127 125 108',
    'a=mid:0',
    'a=extmap:12 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay',
    'a=rtpmap:96 VP8/90000',
    'a=rtpmap:102 H264/90000', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
    'a=rtpmap:127 H264/90000', 'a=fmtp:127 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f',
    'a=rtpmap:125 H264/90000', 'a=fmtp:125 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=rtpmap:108 H264/90000', 'a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:1',
  ].join('\r\n');
  const o = parseOffer(offer);
  assert.deepEqual(o, { mid: '0', pt: 125, fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', playoutDelayId: 12 });
  assert.throws(() => parseOffer('v=0\r\nm=audio 9 RTP/AVP 0\r\n'));

  const rr = Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 1]);
  const pli = Buffer.from([0x81, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2]);
  const fir = Buffer.from([0x84, 206, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0]);
  const nack = Buffer.from([0x81, 205, 0, 3, 0, 0, 0, 1, 0, 0, 0, 2, 0, 5, 0, 0]);
  assert.equal(rtcpWantsKey(Buffer.concat([rr, pli])), true);
  assert.equal(rtcpWantsKey(fir), true);
  assert.equal(rtcpWantsKey(Buffer.concat([rr, nack])), false);

  assert.equal(pathKind('192.168.1.20'), 'lan');
  assert.equal(pathKind('100.101.102.103'), 'tailscale');
  assert.equal(pathKind('fd7a:115c:a1e0::1'), 'tailscale');
  assert.equal(pathKind('127.0.0.1'), 'loopback');
  assert.equal(pathKind('8.8.8.8'), 'direct');
  ok('offer parsing (H.264 pm=1, 42e01f preferred, playout-delay), RTCP PLI/FIR detection, path kinds');
}

console.log(`\nall ${passed} H.264 checks passed`);
