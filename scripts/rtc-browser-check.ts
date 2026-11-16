// The WebRTC live view against a real browser engine (Edge, Chrome or Brave, headless): the mock server streams its
// H.264 the way src/rtc.ts does, and the page receives it with Lotus's own live engine (phones-live.js) into a <video>
// set up like the Phones page's (hidden until the first frame). Prints, once a second, what came and what was shown.
//
//   npx tsx scripts/rtc-browser-check.ts [--profile remote|lan] [--seconds 20] [--delay 90] [--jitter 30] [--loss 0]
//       [--key-seconds 10] [--stale 6] [--buffer 80] [--live <path to phones-live.js>] [--browser <exe>]
//       [--bare-keys] [--break-at 8] [--blackout 8:4] [--json]
//
// --delay/--jitter/--loss put a UDP relay between the browser and the server (one way ms, +- ms, % lost), like a far
// link. --stale waits that many seconds after the capture's first keyframe before the viewer joins, so it is primed
// with an old cached keyframe. --buffer is the jitter buffer's target (ms). Faults, to see the page heal:
// --bare-keys sends every keyframe after a session's first without its SPS and PPS (the 2026-11-16 freeze);
// --break-at does that to the session running at that second only (a new peer connection heals it); --blackout
// start:seconds drops every packet for a while (needs the relay: give --delay 1).
// Exit code 1 when the picture stalls (fewer than half the frames that came were shown at the end).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { H264Source, H264Viewer, KIND, Rec } from '../src/h264.js';
import { MockBackend } from '../src/mock.js';
import { rtcCleanup } from '../src/rtc.js';
import { createServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : dflt;
};
const num = (name: string, dflt: number) => Number(opt(name, String(dflt)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = opt('profile', 'remote');
const seconds = num('seconds', 20);
const delay = num('delay', 0);
const jitter = num('jitter', 0);
const loss = num('loss', 0);
const stale = num('stale', 0);
const livePath = opt('live', path.resolve(here, '../../../source/modules/phones/ui/phones-live.js'));
if (!fs.existsSync(livePath)) {
  console.error(`phones-live.js not found at ${livePath} (give it with --live)`);
  process.exit(2);
}
const browser =
  opt('browser', '') ||
  [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));
if (!browser) {
  console.error('no Edge, Chrome or Brave found (give one with --browser)');
  process.exit(2);
}

// ---- faults: keyframes without their SPS and PPS (an empty config makes src/rtc.ts send the next ones bare) ----
const started = Date.now();
const breakAt = num('break-at', 0);
const sessions: { send: (r: Rec) => void; broken: boolean }[] = [];
if (flag('bare-keys') || breakAt) {
  const add = H264Source.prototype.add;
  H264Source.prototype.add = function (this: H264Source, v: H264Viewer) {
    if (v.t.kind === 'rtc') {
      const send = v.t.send.bind(v.t);
      const me = { send, broken: false };
      sessions.push(me);
      (v.t as { send: (r: Rec) => void }).send = (r: Rec) => {
        send(r);
        if (r.kind === KIND.KEY && flag('bare-keys') && !me.broken) (me.broken = true), send({ kind: KIND.CONFIG, time: r.time, payload: Buffer.alloc(0), arrived: r.arrived });
      };
    }
    return add.call(this, v);
  };
}

// ---- the mock server ----
const token = crypto.randomBytes(16).toString('hex');
const backend = new MockBackend(2, { h264KeySeconds: num('key-seconds', profile === 'remote' ? 10 : 2), h264IdleMs: 60_000 });
const server = createServer(backend, token);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const serverPort = (server.address() as AddressInfo).port;
const phones = (await (await fetch(`http://127.0.0.1:${serverPort}/phones`, { headers: { authorization: `Bearer ${token}` } })).json()) as { udid: string; online: boolean }[];
const udid = phones.find((p) => p.online)!.udid;

// ---- a far link: a UDP relay with delay, jitter and loss (in order, like one path) ----
const relay = { port: 0, to: null as { address: string; port: number } | null, from: null as { address: string; port: number } | null };
const front = dgram.createSocket('udp4'); // the browser's side
const back = dgram.createSocket('udp4'); // the server's side
const [darkAt, darkFor] = opt('blackout', '0:0').split(':').map(Number) as [number, number];
function later(last: { t: number }, send: () => void): void {
  if (loss > 0 && Math.random() * 100 < loss) return;
  const at = (Date.now() - started) / 1000;
  if (darkFor && at >= darkAt && at < darkAt + darkFor) return;
  const due = Math.max(last.t, performance.now() + delay + (Math.random() * 2 - 1) * jitter);
  last.t = due;
  setTimeout(() => {
    try {
      send();
    } catch {
      /* closed */
    }
  }, Math.max(0, due - performance.now()));
}
const up = { t: 0 };
const down = { t: 0 };
front.on('message', (m, r) => {
  relay.from = { address: r.address, port: r.port };
  if (relay.to) later(up, () => back.send(m, relay.to!.port, relay.to!.address));
});
back.on('message', (m) => {
  if (relay.from) later(down, () => front.send(m, relay.from!.port, relay.from!.address));
});
await new Promise<void>((r) => front.bind(0, '127.0.0.1', r));
await new Promise<void>((r) => back.bind(0, r));
relay.port = front.address().port;

// ---- the page ----
const PAGE = `<!doctype html><meta charset="utf-8"><title>rtc check</title>
<style>[hidden]{display:none!important} body{margin:0;background:#000} .scr{position:relative;width:208px;height:448px}
.scr>*{position:absolute;inset:0;width:100%;height:100%}</style>
<div class="scr"><canvas id="cv" hidden></canvas><video id="vid" muted autoplay playsinline disablepictureinpicture hidden></video></div>
<script src="/phones-live.js"></script>
<script>
const q = new URLSearchParams(location.search);
const cv = document.getElementById("cv"), vid = document.getElementById("vid");
const events = [], t0 = performance.now();
const say = (what) => events.push({ at: Math.round(performance.now() - t0), what });
const now = () => performance.timeOrigin + performance.now();
const ws = new WebSocket("ws://127.0.0.1:" + q.get("port") + "/phones/" + q.get("udid") + "/control?token=" + q.get("token") + "&profile=" + q.get("profile"));
let id = 1, relayed = false;
const relay = +q.get("relay");
const want = { fps: 60, scale: q.get("profile") === "remote" ? 50 : 100, bitrate: q.get("profile") === "remote" ? 4000 : 10000, profile: q.get("profile") };
// WebRTC only (2026-11-16): the engine keeps itself up (a keyframe, an ICE restart, the connection made anew)
const live = PhonesLive.create({
  udid: q.get("udid"), video: () => vid, want: () => want,
  // through the relay the page's own candidates stay here, so the relay's is the only path
  signal: async (m) => { if (!(relay && m.type === "rtc-ice")) ws.send(JSON.stringify({ id: id++, ...m })); },
  drawn: (w, h) => { if (vid.hidden) (vid.hidden = false), (cv.hidden = true), say("video shown " + w + "x" + h); },
  state: (k, why) => say("state " + k + (why ? ": " + why : "")),
  buffer: () => +q.get("buffer") || 0,
  // like the page's keepPicture: the last frame on the canvas while the peer connection is made anew
  heal: (what, why) => { say("heal " + what + ": " + why); if (what === "rebuild" && vid.videoWidth) { cv.width = vid.videoWidth; cv.height = vid.videoHeight; cv.getContext("2d").drawImage(vid, 0, 0); cv.hidden = false; vid.hidden = true; } },
  ack() {}, note() {},
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "pong") return live.pong({ t: m.t, server_time: m.server_time, back: now() });
  if (m.type === "rtc-answer") relayed = false; // a new session: its own port
  if (relay && m.type === "rtc-answer") m.sdp = m.sdp.split(/\\r?\\n/).filter((l) => !l.startsWith("a=candidate")).join("\\r\\n");
  if (relay && m.type === "rtc-ice") {
    // the far link: the server's first IPv4 candidate, reached through the relay (the others left out)
    const c = /^candidate:(\\S+) (\\d+) udp (\\d+) (\\d+\\.\\d+\\.\\d+\\.\\d+) (\\d+) typ host/i.exec(m.candidate);
    if (!c || relayed) return;
    relayed = true;
    fetch("/relay?address=" + c[4] + "&port=" + c[5]);
    m.candidate = "candidate:" + c[1] + " " + c[2] + " udp " + c[3] + " 127.0.0.1 " + relay + " typ host";
  }
  if (/^rtc-/.test(m.type)) { if (m.type !== "rtc-ice") say(m.type + (m.reason ? ": " + m.reason : "")); live.rtcMsg(m); }
};
ws.onopen = () => {
  setInterval(() => ws.send(JSON.stringify({ type: "ping", t: now() })), 1000);
  setTimeout(() => live.start(), +q.get("wait") || 0);
};
window.__rep = () => {
  const r = live.report(), pq = vid.getVideoPlaybackQuality?.();
  return { at: Math.round(performance.now() - t0), ...r, events: events.splice(0), element: pq ? { total: pq.totalVideoFrames, dropped: pq.droppedVideoFrames } : null };
};
</script>`;
const web = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/phones-live.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync(livePath));
  if (u.pathname === '/relay') {
    relay.to = { address: u.searchParams.get('address') ?? '127.0.0.1', port: Number(u.searchParams.get('port')) };
    return void res.writeHead(204).end();
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
});
await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
const webPort = (web.address() as AddressInfo).port;

// ---- the browser, over the DevTools protocol ----
const dir = fs.mkdtempSync(path.join(path.resolve(opt('profile-dir', os.tmpdir())), 'rtc-check-'));
const useRelay = delay > 0 || jitter > 0 || loss > 0;
const url = `http://127.0.0.1:${webPort}/?port=${serverPort}&udid=${udid}&token=${token}&profile=${profile}&relay=${useRelay ? relay.port : 0}&wait=${stale * 1000}&buffer=${num('buffer', 0)}`;
const proc = spawn(browser, [
  flag('headed') ? '--new-window' : '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--autoplay-policy=no-user-gesture-required', '--window-size=500,700', ...(opt('browser-args', '') ? opt('browser-args', '').split(' ') : []), 'about:blank',
], { stdio: 'ignore' });
let failed = false;
try {
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try {
      port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    } catch {
      /* not yet */
    }
  }
  if (!port) throw new Error('the browser gave no DevTools port');
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const cdp = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
  await new Promise((r) => cdp.once('open', r));
  let seq = 0;
  const waits = new Map<number, (v: any) => void>();
  cdp.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && waits.has(m.id)) (waits.get(m.id)!(m.result), waits.delete(m.id));
  });
  const call = (method: string, params: object = {}) =>
    new Promise<any>((r) => {
      const id = ++seq;
      waits.set(id, r);
      cdp.send(JSON.stringify({ id, method, params }));
    });
  const version = await call('Browser.getVersion');
  console.log(`${version.product} · profile ${profile} · ${useRelay ? `relay ${delay} ms +-${jitter} ms, ${loss}% loss` : 'direct'}${stale ? ` · joins ${stale} s after the keyframe` : ''}`);
  // the capture starts now, so a viewer that joins later is primed with a cached (old) keyframe
  if (stale) backend.warm(udid);
  await call('Page.navigate', { url });
  let last: any = null;
  const rows: any[] = [];
  for (let s = 0; s < seconds + stale; s++) {
    await sleep(1000);
    const r = (await call('Runtime.evaluate', { expression: 'JSON.stringify(window.__rep?.() ?? null)', returnByValue: true })).result?.value;
    const rep = r ? JSON.parse(r) : null;
    if (breakAt && s + 1 === breakAt + stale) {
      console.log(`   -- the running session's keyframes go bare from here (${sessions.length} session)`);
      for (const x of sessions) if (!x.broken) (x.broken = true), x.send({ kind: KIND.CONFIG, time: Date.now(), payload: Buffer.alloc(0), arrived: Date.now() });
    }
    if (!rep) continue;
    for (const e of rep.events) console.log(`   [${(e.at / 1000).toFixed(1)} s] ${e.what}`);
    const c = rep.rtc ?? {};
    const d = (k: string) => (last?.rtc && c[k] != null ? c[k] - (last.rtc[k] ?? 0) : c[k] ?? 0);
    const shown = rep.frames - (last?.frames ?? 0);
    rows.push({ shown, came: d('framesReceived'), transport: rep.transport });
    console.log(
      `${String(Math.round(rep.at / 1000)).padStart(3)} s ${rep.transport.padEnd(7)} shown ${String(shown).padStart(3)} | came ${String(d('framesReceived')).padStart(3)} decoded ${String(d('framesDecoded')).padStart(3)} ` +
        `dropped ${String(d('dropped')).padStart(3)} pkts ${String(d('packetsReceived')).padStart(4)} lost ${c.lost ?? 0} keys ${c.keyFramesDecoded ?? 0} pli ${c.pliCount ?? 0} nack ${c.nackCount ?? 0} freezes ${c.freezeCount ?? 0} ` +
        `jb ${c.jitterMs == null ? '-' : Math.round(c.jitterMs)} ms lat ${rep.latency?.p50 ?? '-'} ms rtt ${c.rtt == null ? '-' : Math.round(c.rtt)} | el ${rep.element ? `${rep.element.total}/${rep.element.dropped}` : '-'} ` +
        `${c.video ? `rs${c.video.readyState}${c.video.paused ? ' paused' : ''}${c.video.hidden ? ' hidden' : ''}` : ''}${rep.state !== 'live' ? ` ${String(rep.state).toUpperCase()}` : ''}${rep.heal && (rep.heal.keysAsked || rep.heal.linkWaits || rep.heal.rebuilds || rep.heal.replays) ? ` heal k${rep.heal.keysAsked} w${rep.heal.linkWaits} r${rep.heal.rebuilds} p${rep.heal.replays}` : ''}`,
    );
    last = rep;
  }
  if (flag('json')) console.log(JSON.stringify(last, null, 1));
  // the verdict: the last two thirds of the run, WebRTC up and most of what came shown
  const tail = rows.slice(Math.floor(rows.length / 3));
  const came = tail.reduce((n, r) => n + r.came, 0);
  const shown = tail.reduce((n, r) => n + r.shown, 0);
  const onRtc = tail.filter((r) => r.transport === 'webrtc').length;
  failed = onRtc < tail.length * 0.8 || shown < came * 0.5 || shown < tail.length * 5;
  console.log(`${failed ? 'STALLED' : 'ok'}: ${shown} frames shown of ${came} that came over the last ${tail.length} s, WebRTC up ${onRtc}/${tail.length} s`);
  cdp.close();
} catch (err) {
  failed = true;
  console.error('FAILED:', err);
} finally {
  proc.kill();
  front.close();
  back.close();
  web.closeAllConnections();
  web.close();
  server.closeAllConnections();
  server.close();
  await backend.close();
  rtcCleanup();
  await sleep(500);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the browser still holds it */
  }
  process.exit(failed ? 1 : 0);
}
