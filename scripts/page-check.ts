// Lotus's Phones page against a real browser engine (Edge, Chrome or Brave, headless) and the mock server: the page's
// own phones.js, phones-live.js, phones-chat.js and phones.css, with a small stand-in for Lotus (`ST`) and for the
// Rust side's commands (`phones_list`, `phones_link`, `phones_signal` ...), which here talk to the mock server. It
// checks what can't be seen from a syntax check: the page mounts without an error, the list is on the left, the phone
// in the middle and Lotus's chat on the right, the open phone goes live over WebRTC (its card shows fps and latency),
// a click on another card switches, and a server that stops answering gets "Reconnecting" and the picture back.
//
//   npx tsx scripts/page-check.ts [--ui <Lotus's source/modules/phones/ui folder>] [--browser <exe>] [--seconds 6]
//
// Not part of npm test (it needs a browser). Exit code 1 when a check fails.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MockBackend } from '../src/mock.js';
import { rtcCleanup } from '../src/rtc.js';
import { createServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : dflt;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uiDir = opt('ui', path.resolve(here, '../../../source/modules/phones/ui'));
if (!fs.existsSync(path.join(uiDir, 'phones.js'))) {
  console.error(`phones.js not found in ${uiDir} (give the folder with --ui)`);
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

const token = crypto.randomBytes(16).toString('hex');
const backend = new MockBackend(2, { h264KeySeconds: 2, h264IdleMs: 60_000 });
const server = createServer(backend, token, undefined, { focusLockMs: 300 });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const serverPort = (server.address() as AddressInfo).port;

// Lotus and Rust, stood in for: `ST` as phones.js uses it, and the commands as small calls to the mock server (HTTP
// through this page's own /api, the control link as a WebSocket of the page's).
const STUB = `
const q = new URLSearchParams(location.search);
window.__errors = [];
addEventListener("error", (e) => __errors.push(String(e.message || e.error)));
addEventListener("unhandledrejection", (e) => __errors.push("rejection: " + String(e.reason?.message ?? e.reason)));
const api = async (method, p, body) => {
  const r = await fetch("/api" + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error("The phone server said no (HTTP " + r.status + ")" + (j?.error ? ": " + j.error : ""));
  return j;
};
let link = null, sid = 1;
const commands = {
  phones_config: async () => null,
  phones_forget: async () => null,
  phones_profile: async () => "remote",
  phones_route: async () => ({ profile: "remote", path: "remote", reason: "" }),
  phones_list: () => api("GET", "/phones"),
  phones_info: ({ udid }) => api("GET", "/phones/" + udid + "/info"),
  phones_focus: ({ udid }) => api("POST", "/phones/" + udid + "/focus", {}),
  phones_wake: ({ udid }) => api("POST", "/phones/" + udid + "/wake", {}),
  phones_lock: ({ udid }) => api("POST", "/phones/" + udid + "/lock", {}),
  phones_wda: () => api("GET", "/api/wda"),
  phones_settings_get: () => api("GET", "/api/settings"),
  phones_act: ({ udid, what, body }) => api("POST", "/phones/" + udid + "/" + what, { ...body, fast: true }),
  // like Rust's link: kept open, and opened again a moment after it drops
  phones_link: async ({ udid, on }) => {
    if (link) (link.gone = true), link.ws.close();
    const me = (link = { ws: null, udid, gone: false });
    const say = (m) => link === me && on.onmessage(m);
    const open = () => {
      const ws = (me.ws = new WebSocket("ws://127.0.0.1:" + q.get("port") + "/phones/" + udid + "/control?token=" + q.get("token") + "&profile=remote"));
      say({ type: "link", udid, state: "connecting" });
      ws.onopen = () => {
        say({ type: "link", udid, state: "ready" });
        me.ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping", t: Date.now() })), 2000);
      };
      ws.onclose = () => {
        clearInterval(me.ping);
        if (me.gone || link !== me) return;
        say({ type: "link", udid, state: "down" });
        setTimeout(() => !me.gone && link === me && open(), 300);
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "pong") return say({ type: "pong", udid, t: m.t, server_time: m.server_time, back: Date.now() });
        if (/^rtc-/.test(m.type) || m.type === "orientation" || typeof m.ack === "number") return say({ ...m, udid });
        if (m.type === "info") return say({ type: "info", udid: m.udid ?? udid, info: m.info });
      };
    };
    open();
    return null;
  },
  phones_link_stop: async () => { if (link) (link.gone = true), link.ws.close(); link = null; },
  phones_signal: async ({ udid, msg }) => {
    if (!link || link.udid !== udid || link.ws.readyState !== 1) throw new Error("no-link");
    link.ws.send(JSON.stringify({ id: sid++, ...msg }));
  },
  phones_touch: async ({ udid, phase, x, y, t, seq }) => {
    if (!link || link.ws.readyState !== 1) throw new Error("no-link");
    link.ws.send(JSON.stringify({ type: "touch", phase, x, y, t, seq, id: 1, unit: "norm" }));
    return "ws";
  },
};
window.__drop = () => link?.ws.close();
window.__calls = [];
window.__TAURI__ = {
  core: {
    invoke: (cmd, a) => (__calls.push(cmd), commands[cmd] ? commands[cmd](a ?? {}) : Promise.reject(new Error("no such command here: " + cmd))),
    Channel: class { onmessage() {} },
  },
  event: { listen: async () => () => {} },
};
window.ST = {
  edition: { builder: true },
  store: { readJSON: async () => ({ server: "http://mock", token: "kept", lan: "" }), writeJSON: async () => {} },
  settings: { refresh() {} },
  lotus: { add(mod, tools) { window.__tools = tools; }, view() {}, ask: async () => {} },
  dialog: { confirm: async () => false },
  go() {},
  register(m) { window.__mod = m; },
};`;
const PAGE = `<!doctype html><meta charset="utf-8"><title>phones page check</title>
<link rel="stylesheet" href="/ui/phones.css">
<style>html,body{margin:0;height:100%;background:#000;color:#fff;font:13px "Segoe UI",sans-serif} #host{position:absolute;inset:0} button{background:none;border:0}</style>
<body><div id="host"></div>
<script>${STUB}</script>
<script src="/ui/phones-live.js"></script>
<script src="/ui/phones-chat.js"></script>
<script src="/ui/phones.js"></script>
<script>
__mod.onUnlock?.();
__mod.mount(document.getElementById("host"));
window.__see = () => {
  const box = (s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) } : null; };
  const rows = [...document.querySelectorAll(".ph-row")].map((el) => ({
    udid: el.dataset.udid, on: el.classList.contains("on"), k: el.dataset.k, name: el.querySelector(".ph-rname").textContent, state: el.querySelector(".ph-rw").textContent,
    fps: el.querySelector('[data-f="fps"] b').textContent, ms: el.querySelector('[data-f="lat"] b').textContent, bat: el.querySelector('[data-f="bat"] b').textContent, temp: el.querySelector('[data-f="temp"] b').textContent,
    app: el.querySelector(".ph-rapp").textContent, route: el.querySelector(".ph-rroute").textContent, h: Math.round(el.getBoundingClientRect().height),
  }));
  const vid = document.querySelector(".ph-vid"), cv = document.querySelector(".ph-cv"), cover = document.querySelector(".ph-cover"), boot = document.querySelector(".ph-boot");
  return {
    errors: __errors, rows, list: box(".ph-list"), stage: box(".ph-screen"), chat: box(".ph-aic .aic"), count: document.querySelector(".ph-count")?.textContent,
    video: { hidden: vid.hidden, w: vid.videoWidth, h: vid.videoHeight }, canvas: { hidden: cv.hidden, w: cv.width }, cover: cover.hidden ? "" : cover.textContent.trim(),
    chip: boot.classList.contains("show") ? boot.textContent.trim() : "", dim: document.querySelector(".ph-screen").classList.contains("wait"),
    text: document.querySelector(".ph-shell").innerText, calls: [...new Set(__calls)],
  };
};
</script>`;
const web = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname.startsWith('/ui/')) {
    const f = path.join(uiDir, path.basename(u.pathname));
    if (!fs.existsSync(f)) return void res.writeHead(404).end();
    return void res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : f.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript' }).end(fs.readFileSync(f));
  }
  if (u.pathname.startsWith('/api/')) {
    // the page's HTTP, passed on to the mock server with the token (the page never has it, as in Lotus)
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const up = http.request(
        { host: '127.0.0.1', port: serverPort, path: u.pathname.slice(4) + u.search, method: req.method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
        (r) => {
          res.writeHead(r.statusCode ?? 502, { 'content-type': 'application/json' });
          r.pipe(res);
        },
      );
      up.on('error', () => res.writeHead(502).end('{}'));
      up.end(Buffer.concat(chunks));
    });
    return;
  }
  if (u.pathname === '/lotus-peach.svg') return void res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"/>');
  res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
});
await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
const webPort = (web.address() as AddressInfo).port;

const dir = fs.mkdtempSync(path.join(path.resolve(opt('profile-dir', os.tmpdir())), 'page-check-'));
const proc = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--autoplay-policy=no-user-gesture-required', '--window-size=1500,900', 'about:blank'], { stdio: 'ignore' });
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok' : 'FAILED'} - ${what}`);
  if (!ok) failures.push(what);
};
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
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !target; i++) {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    target = list.find((t) => t.type === 'page');
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('the browser has no page');
  const cdp = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => cdp.once('open', r));
  let seq = 0;
  const waits = new Map<number, (v: any) => void>();
  const thrown: string[] = [];
  cdp.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && waits.has(m.id)) (waits.get(m.id)!(m.result), waits.delete(m.id));
    if (m.method === 'Runtime.exceptionThrown') thrown.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'exception');
  });
  const call = (method: string, params: object = {}) =>
    new Promise<any>((r) => {
      const id = ++seq;
      waits.set(id, r);
      cdp.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression: string) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  const see = async () => JSON.parse((await evalJs('JSON.stringify(window.__see())')) ?? 'null');
  await call('Runtime.enable');
  const version = await call('Browser.getVersion');
  console.log(version.product);
  await call('Page.navigate', { url: `http://127.0.0.1:${webPort}/?port=${serverPort}&token=${token}` });
  const seconds = Number(opt('seconds', '6'));
  await sleep(seconds * 1000);

  // ---- the page as it opens ----
  let s = await see();
  check(s && s.errors.length === 0 && thrown.length === 0, `the page mounts and runs without an error${s?.errors.length || thrown.length ? `: ${[...(s?.errors ?? []), ...thrown].join(' | ').slice(0, 400)}` : ''}`);
  check(s.rows.length === 2 && /2 · 2 online/.test(s.count), `the list shows every phone (${s.rows.length}; "${s.count}")`);
  check(s.list && s.stage && s.chat && s.list.right <= s.stage.left && s.stage.right <= s.chat.left, `the list is on the left, the phone in the middle, Lotus on the right (list ${s.list?.left}-${s.list?.right}, phone ${s.stage?.left}-${s.stage?.right}, chat from ${s.chat?.left})`);
  const open = s.rows.find((r: any) => r.on);
  check(open && open.state === 'Live' && open.k === 'on', `the open phone is live (${open?.state})`);
  check(!s.video.hidden && s.video.w > 0 && s.canvas.hidden, `the picture is the WebRTC video (${s.video.w}x${s.video.h})`);
  check(open && Number(open.fps) >= 15, `its card shows the frames a second (${open?.fps})`);
  check(open && /^≈?\d+$/.test(open.ms), `...and the latency (${open?.ms} ms)`);
  check(open && /^\d+%$/.test(open.bat) && /°$/.test(open.temp) && !!open.app, `...the battery, the temperature and the app in front (${open?.bat}, ${open?.temp}, ${open?.app})`);
  check(open && !!open.route, `...and the route (${open?.route})`);
  const other = s.rows.find((r: any) => !r.on);
  check(other && other.fps === '—' && other.ms === '—', `a phone that isn't open shows no fps or latency (${other?.fps}, ${other?.ms})`);
  check(s.rows.every((r: any) => r.h >= 96), `each card is a proper card (${s.rows.map((r: any) => r.h).join(', ')} px tall)`);
  check(!/MJPEG|Snapshots|H\.264|Orientation|iOS|Model|Uptime|Natural touch|Stream/i.test(s.text), 'nothing says MJPEG, Stream, Orientation, iOS, Model, Uptime or Natural touch');
  check(!document_has(s, '.ph-card') && !s.calls.some((c: string) => /phones_stream|phones_shot$/.test(c)), 'no detail card; no stream or screenshot command is asked');
  check(s.cover === '' && !s.dim, 'nothing covers or dims the live picture');
  const tool = String(await evalJs(`window.__tools.find((t) => t.name === "stats").run()`));
  check(/"transport":"webrtc"/.test(tool) && /"state":"live"/.test(tool), 'phones_stats says transport webrtc, state live');

  // ---- another phone ----
  await evalJs(`document.querySelector('.ph-row:not(.on)').click()`);
  await sleep(4000);
  s = await see();
  const now = s.rows.find((r: any) => r.on);
  check(now && now.udid === other.udid && now.state === 'Live' && Number(now.fps) >= 15 && !s.video.hidden, `a click on another card switches, and it goes live (${now?.state}, ${now?.fps} fps)`);
  check(s.errors.length === 0 && thrown.length === 0, 'still without an error');

  // ---- the owner's tap goes to the phone ----
  await evalJs(`(() => { const el = document.querySelector('.ph-screen'), r = el.getBoundingClientRect(); const ev = (t) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 7, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); ev('pointerdown'); setTimeout(() => ev('pointerup'), 80); })()`);
  await sleep(1200);
  const log = ((backend as any).live(now.udid).log as string[]).slice(-3).join(' | ');
  check(/tap /.test(log), `a press on the picture reaches the phone (${log})`);

  // ---- the server's WebRTC session dies under the page: it heals itself, the last frame staying up ----
  await evalJs(`(() => { window.__seen = []; window.__t = setInterval(() => { const s = __see(); __seen.push([s.rows.find((r) => r.on)?.state, s.chip, !s.video.hidden || !s.canvas.hidden, s.cover].join("/")); }, 250); })()`);
  await evalJs('window.__drop()'); // the control link drops, and the server ends its WebRTC session with it
  await sleep(9000);
  const seen = JSON.parse(await evalJs('(clearInterval(__t), JSON.stringify(__seen))')) as string[];
  s = await see();
  const back = s.rows.find((r: any) => r.on);
  check(seen.some((x) => /^Reconnecting\//.test(x)), `a dropped link says Reconnecting (${[...new Set(seen)].join('  ')})`);
  check(seen.every((x) => x.split('/')[2] === 'true'), 'a picture stays on screen the whole time (never a black box)');
  check(back && back.state === 'Live' && Number(back.fps) >= 15 && !s.video.hidden, `and the picture is back by itself (${back?.state}, ${back?.fps} fps)`);
  check(s.errors.length === 0 && thrown.length === 0, `no error through it all${s.errors.length ? `: ${s.errors.join(' | ').slice(0, 300)}` : ''}`);
  cdp.close();
} catch (err) {
  failures.push(String(err));
  console.error('FAILED:', err);
} finally {
  proc.kill();
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
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall page checks passed');
  process.exit(failures.length ? 1 : 0);
}

/** Whether the page's text snapshot came from a page with such an element (the card is gone: its words are the tell). */
function document_has(s: { text: string }, _selector: string): boolean {
  return /Control link|Control app|Touch ms|Latency ms/i.test(s.text);
}
