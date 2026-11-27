// The soak: a long run against a REAL running phone-farm server (docs/soak.md). For N hours, on the phones chosen, it
// does what an agent and a watching owner do, only ever as a viewer: reads the screen (GET /ui), opens TikTok and
// Instagram and scrolls them (vertical swipes), goes Home, opens and closes the live view, and measures what matters:
// input p95, read p95, picture age, freezes, runner restarts, Home presses, and every stall with its cause and time to
// recovery. Every event goes to data/soak-<date>.jsonl; the summary at the end ends with a verdict: PASS = zero
// unrecovered stalls.
//
// SAFETY: it never taps, types, posts, deletes, likes, follows, comments, signs out or touches an account. Every
// request goes through `guard()`: an allowlist of read-only GETs and four POSTs (swipe up/down in the middle of the
// screen, Home, launch TikTok or Instagram, an explicit wake at the start). Anything else throws before it's sent.
// The server's address and token come from the environment (SOAK_URL, API_TOKEN), or in the server's folder from its
// .env (API_TOKEN, PORT on 127.0.0.1), and are never printed or logged.
//
//   SOAK_URL=http://127.0.0.1:8787 API_TOKEN=... tsx scripts/soak.ts --hours 2 --phones iPhone-1,iPhone-2
//   tsx scripts/soak.ts --dry-run          (20 s against an in-process MOCK=true server; no env needed)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

// printed before anything (the dry run's in-process server quiets console.log for its own lines)
const print = console.log.bind(console);
const printErr = console.error.bind(console);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- arguments ----
const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(k);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (flag('--help') || flag('-h')) {
  print(`usage: tsx scripts/soak.ts [--hours H | --seconds S] [--phones name|udid,...] [--apps tiktok,instagram]
                      [--live h264|mjpeg|off] [--out file.jsonl] [--dry-run]
env: SOAK_URL (the server, e.g. http://127.0.0.1:8787), API_TOKEN (never printed); in the server's folder both
     default from its .env (API_TOKEN, PORT on 127.0.0.1)`);
  process.exit(0);
}
const DRY = flag('--dry-run');
const seconds = Number(opt('--seconds') ?? (DRY ? 20 : Number(opt('--hours') ?? 1) * 3600));
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--hours / --seconds must be a positive number');
const LIVE = (opt('--live') ?? 'h264') as 'h264' | 'mjpeg' | 'off';
if (!['h264', 'mjpeg', 'off'].includes(LIVE)) throw new Error('--live must be h264, mjpeg or off');
const APPS: Record<string, string> = { tiktok: 'com.zhiliaoapp.musically', instagram: 'com.burbn.instagram' };
const appList = (opt('--apps') ?? 'tiktok,instagram').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
for (const a of appList) if (!APPS[a]) throw new Error(`--apps: only ${Object.keys(APPS).join(', ')} (got ${a})`);
const wantPhones = opt('--phones')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const date = new Date().toISOString().slice(0, 10);
const OUT = path.resolve(opt('--out') ?? path.join(ROOT, 'data', DRY ? `soak-dry-${date}.jsonl` : `soak-${date}.jsonl`));

// ---- pacing (real; the dry run is the same loop, faster) ----
const P = DRY
  ? { dwell: [300, 700], readEvery: 2, appEvery: 6, liveEvery: 5000, liveFor: 4000, monitor: 1000, counters: 3000, readSlow: 10_000, inputSlow: 3000, frameAfterInput: 1500, frozen: 5000 }
  : { dwell: [2500, 6000], readEvery: 3, appEvery: 25, liveEvery: 180_000, liveFor: 60_000, monitor: 5000, counters: 30_000, readSlow: 15_000, inputSlow: 3000, frameAfterInput: 1500, frozen: 5000 };

// ---- the journal ----
const runStart = Date.now() - 1000; // the journal is appended to: this run's summary reads only its own lines
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const journal = fs.createWriteStream(OUT, { flags: 'a' });
let secrets: string[] = [];
/** Never a secret or the server's address in what's written or printed. */
const clean = (s: string) => {
  let out = s;
  for (const x of secrets) if (x) out = out.split(x).join('[redacted]');
  return out;
};
const log = (type: string, data: Record<string, unknown> = {}) => {
  journal.write(clean(JSON.stringify({ t: new Date().toISOString(), type, ...data })) + '\n');
};
const say = (m: string) => print(clean(`[soak ${new Date().toISOString().slice(11, 19)}] ${m}`));

// ---- the server ----
let BASE = '';
let TOKEN = '';
let closeDry: (() => Promise<void>) | null = null;
if (DRY) {
  // an in-process MOCK=true server (the harness's), on a local port: nothing real is contacted
  const harness = (await import(pathToFileURL(path.join(ROOT, 'test', 'harness', 'farm.ts')).href)) as any;
  const srv = await harness.mockServer({ phones: 3, mock: { h264IdleMs: 1500 }, extras: { watchMs: 1000 } });
  BASE = srv.base;
  TOKEN = srv.token;
  closeDry = srv.close;
} else {
  // on the Mac, next to the server: API_TOKEN and PORT from the repo's .env when the environment has none (read, never shown)
  const dotenv: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*(API_TOKEN|PORT)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) dotenv[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch {
    /* no .env here */
  }
  BASE = (process.env.SOAK_URL ?? process.env.PHONE_FARM_URL ?? (dotenv.API_TOKEN ? `http://127.0.0.1:${dotenv.PORT || 8787}` : '')).replace(/\/+$/, '');
  TOKEN = process.env.API_TOKEN ?? dotenv.API_TOKEN ?? '';
  if (!BASE || !TOKEN) {
    printErr('set SOAK_URL (the server, e.g. http://127.0.0.1:8787) and API_TOKEN in the environment, run it in the server\'s folder (its .env), or use --dry-run');
    process.exit(2);
  }
}
{
  const u = new URL(BASE);
  secrets = [TOKEN, encodeURIComponent(TOKEN), BASE, u.host, u.hostname].filter((s) => s && s.length >= 3);
}

// ---- the allowlist: the only requests this script can make ----
const SAFE_GET = /^\/(health|phones|trace)$|^\/phones\/[^/]+\/(ui|input|info)$/;
const SAFE_POST = /^\/phones\/[^/]+\/(swipe|home|launch|wake)$/;
const SWIPE_KEYS = new Set(['x1', 'y1', 'x2', 'y2', 'ms', 'unit', 'fast']);
export function guard(method: 'GET' | 'POST', p: string, body?: Record<string, unknown>): void {
  const route = p.split('?')[0]!;
  if (method === 'GET') {
    if (!SAFE_GET.test(route)) throw new Error(`soak guard: GET ${route} is not allowed`);
    return;
  }
  if (!SAFE_POST.test(route)) throw new Error(`soak guard: POST ${route} is not allowed`);
  const what = route.split('/').pop();
  const b = body ?? {};
  if (what === 'launch') {
    if (!Object.values(APPS).includes(String(b.bundleId)) || Object.keys(b).some((k) => !['bundleId', 'fast'].includes(k))) throw new Error('soak guard: only TikTok or Instagram may be launched');
  } else if (what === 'swipe') {
    const n = (k: string) => Number(b[k]);
    const ok = Object.keys(b).every((k) => SWIPE_KEYS.has(k)) && b.unit === 'norm' && Math.abs(n('x1') - n('x2')) < 0.05 && n('x1') >= 0.3 && n('x1') <= 0.7 &&
      Math.min(n('y1'), n('y2')) >= 0.2 && Math.max(n('y1'), n('y2')) <= 0.8 && Math.abs(n('y1') - n('y2')) >= 0.2;
    if (!ok) throw new Error('soak guard: only a vertical scroll in the middle of the screen');
  } else if (Object.keys(b).some((k) => k !== 'fast')) throw new Error(`soak guard: ${what} takes no body`);
}

// the guard checks itself at every start: what must never go out is refused (a tap, typing, another app, a sideways
// swipe, a batch, a key, a screenshot route, anything off the list)
for (const [m, p, b] of [
  ['POST', '/phones/x/tap', { x: 0.5, y: 0.5 }], ['POST', '/phones/x/type', { text: 'a' }], ['POST', '/phones/x/act', {}],
  ['POST', '/phones/x/key', { key: 'enter' }], ['POST', '/phones/x/launch', { bundleId: 'com.apple.Preferences' }],
  ['POST', '/phones/x/swipe', { x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, unit: 'norm' }], ['POST', '/phones/x/swipe', { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.45, unit: 'norm' }],
  ['POST', '/phones/x/tap-element', {}], ['POST', '/phones/x/clipboard', {}], ['POST', '/phones/x/files/uploads', {}], ['GET', '/phones/x/screenshot', undefined],
] as const) {
  let refused = false;
  try {
    guard(m, p, b as Record<string, unknown> | undefined);
  } catch {
    refused = true;
  }
  if (!refused) throw new Error(`soak guard let ${m} ${p} through: refusing to run`);
}

const call = async (method: 'GET' | 'POST', p: string, body?: Record<string, unknown>, ms = 30_000) => {
  guard(method, p, body);
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}${p}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined, signal: AbortSignal.timeout(ms),
    });
    const text = await r.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: r.status, body: parsed, ms: Date.now() - t0, error: r.ok ? null : clean(String(parsed?.error ?? text).slice(0, 200)) };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return { status: 0, body: null, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? `no answer within ${ms} ms` : clean(e.cause?.code ?? e.message).slice(0, 200) };
  }
};

// ---- stalls: opened on a failure, closed (recovered) by the next success of the same kind ----
type Kind = 'server' | 'control' | 'read' | 'input' | 'live';
let stallSeq = 0;
const open = new Map<string, { id: number; cause: string; since: number }>(); // `${phone}|${kind}`
const stall = (phone: string, kind: Kind, cause: string) => {
  const k = `${phone}|${kind}`;
  if (open.has(k)) return;
  const id = ++stallSeq;
  open.set(k, { id, cause, since: Date.now() });
  log('stall', { id, phone, kind, cause });
  say(`STALL ${phone} ${kind}: ${cause}`);
};
const fine = (phone: string, kind: Kind) => {
  const k = `${phone}|${kind}`;
  const s = open.get(k);
  if (!s) return;
  open.delete(k);
  const ms = Date.now() - s.since;
  log('recovered', { id: s.id, phone, kind, cause: s.cause, ms });
  say(`recovered ${phone} ${kind} after ${Math.round(ms / 100) / 10} s (${s.cause})`);
};

// ---- the phones ----
const health0 = await call('GET', '/health', undefined, 10_000);
if (health0.status !== 200) {
  printErr(`the server didn't answer /health (${health0.error ?? health0.status})`);
  process.exit(2);
}
const list0 = await call('GET', '/phones', undefined, 15_000);
if (list0.status !== 200 || !Array.isArray(list0.body)) {
  printErr(`GET /phones failed (${list0.error ?? list0.status}): is API_TOKEN right?`);
  process.exit(2);
}
const all = (list0.body as any[]).filter((p) => p.online !== false);
const chosen = wantPhones ? all.filter((p) => wantPhones.includes(p.udid) || wantPhones.includes(p.name)) : DRY ? all.slice(0, 2) : all;
if (!chosen.length) {
  printErr(`no online phone matches ${wantPhones ? wantPhones.join(', ') : '(any)'}; online: ${all.map((p) => p.name).join(', ') || 'none'}`);
  process.exit(2);
}
const names = new Map<string, string>(chosen.map((p) => [p.udid as string, p.name as string]));
log('start', { phones: [...names.values()], seconds, live: LIVE, apps: appList, dryRun: DRY, server: { commit: health0.body?.commit ?? null, mock: !!health0.body?.mock, uptimeS: health0.body?.uptimeS ?? null } });
say(`${DRY ? 'dry run (mock) ' : ''}for ${Math.round(seconds)} s on ${[...names.values()].join(', ')}; journal ${path.relative(ROOT, OUT)}`);

const END = Date.now() + seconds * 1000;
const running = () => Date.now() < END;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, Math.min(ms, END - Date.now() + 50))));
const between = ([a, b]: number[]) => a! + Math.random() * (b! - a!);

// ---- the live view: frames, their age, freezes after an input ----
interface Live {
  ws: WebSocket;
  frames: number;
  lastFrameAt: number;
  ages: number[];
  offset: number; // server clock - ours (from the stream's pong)
}
const lives = new Map<string, Live>();

const openLive = (udid: string): Promise<Live | null> =>
  new Promise((resolve) => {
    const name = names.get(udid)!;
    const t0 = Date.now();
    const url = `${BASE.replace(/^http/, 'ws')}/phones/${encodeURIComponent(udid)}/stream?token=${encodeURIComponent(TOKEN)}&codec=${LIVE}`;
    const ws = new WebSocket(url);
    const lv: Live = { ws, frames: 0, lastFrameAt: 0, ages: [], offset: 0 };
    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      log('action', { phone: name, op: 'live-open', ok, ms: Date.now() - t0, ...(error ? { error: clean(error) } : {}) });
      if (ok) {
        fine(name, 'live');
        resolve(lv);
      } else {
        stall(name, 'live', `live view did not open: ${clean(error ?? '')}`);
        try {
          ws.terminate();
        } catch {
          /* closed */
        }
        resolve(null);
      }
    };
    const timer = setTimeout(() => finish(false, 'no picture within 15 s'), 15_000);
    const pingT = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping', t: Date.now() })), 5000);
    ws.on('message', (d, isBinary) => {
      const now = Date.now();
      if (!isBinary) {
        try {
          const m = JSON.parse(String(d));
          if (m.type === 'pong' && typeof m.server_time === 'number' && typeof m.t === 'number') lv.offset = m.server_time - (m.t + now) / 2;
        } catch {
          /* not JSON */
        }
        return;
      }
      const b = d as Buffer;
      if (LIVE === 'h264') {
        const kind = b[0]! & 0x0f;
        if (kind !== 2 && kind !== 3) return; // config and the rest aren't pictures
        if (b.length >= 9) {
          const capturedAt = b.readDoubleBE(1);
          if (Number.isFinite(capturedAt) && capturedAt > 0) lv.ages.push(Math.max(0, now + lv.offset - capturedAt));
        }
      }
      lv.frames++;
      lv.lastFrameAt = now;
      fine(name, 'live');
      if (lv.frames === 1) finish(true);
    });
    ws.on('error', (e) => finish(false, e.message));
    ws.on('close', (code, why) => {
      clearInterval(pingT);
      finish(false, `closed ${code} ${String(why)}`);
    });
  });

const closeLive = (udid: string) => {
  const lv = lives.get(udid);
  if (!lv) return;
  lives.delete(udid);
  const s = [...lv.ages].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!) : null);
  log('frame-age', { phone: names.get(udid), frames: lv.frames, p50: q(50), p95: q(95), max: s.length ? Math.round(s[s.length - 1]!) : null });
  log('action', { phone: names.get(udid), op: 'live-close', ok: true, ms: 0 });
  try {
    lv.ws.close();
  } catch {
    /* closed */
  }
};

/** After an input on a phone that's on show: the picture must move; no frame is a freeze, none for 5 s a stall. */
const watchAfterInput = (udid: string, at: number) => {
  const lv = lives.get(udid);
  if (!lv || LIVE === 'off') return;
  const name = names.get(udid)!;
  setTimeout(() => {
    if (lives.get(udid) !== lv) return;
    if (lv.lastFrameAt >= at) return;
    log('freeze', { phone: name, gapMs: Date.now() - Math.max(at, lv.lastFrameAt), cause: 'no-frame-after-input', sinceFrameMs: lv.lastFrameAt ? Date.now() - lv.lastFrameAt : null });
    setTimeout(() => {
      if (lives.get(udid) === lv && lv.lastFrameAt < at) stall(name, 'live', 'picture frozen 5 s after an input');
    }, P.frozen - P.frameAfterInput).unref();
  }, P.frameAfterInput).unref();
};

// ---- one phone's worker: read, scroll, Home, the other app; one thing at a time, like an agent ----
const act = async (udid: string, op: 'read' | 'swipe' | 'home' | 'launch' | 'wake', body?: Record<string, unknown>) => {
  const name = names.get(udid)!;
  const kind: Kind = op === 'read' ? 'read' : 'input';
  const r = op === 'read' ? await call('GET', `/phones/${encodeURIComponent(udid)}/ui`, undefined, 35_000) : await call('POST', `/phones/${encodeURIComponent(udid)}/${op}`, { ...body, fast: true }, 30_000);
  const ok = r.status === 200 && r.body?.ok !== false;
  log('action', { phone: name, op, ok, ms: r.ms, status: r.status, ...(ok ? {} : { error: r.error }), ...(op === 'launch' ? { app: body?.bundleId } : {}) });
  const slow = op === 'read' ? P.readSlow : P.inputSlow;
  if (!ok) stall(name, kind, `${op} failed: ${r.status} ${r.error ?? ''}`.trim());
  else if (r.ms > slow) stall(name, kind, `${op} slow: ${r.ms} ms`);
  else fine(name, kind);
  return ok;
};

const worker = async (udid: string, index: number) => {
  await sleep(index * 400);
  await act(udid, 'wake'); // explicit, once: a locked phone can't be scrolled
  let n = 0;
  let app = index % appList.length;
  let nextLive = Date.now() + 1000 + index * 700;
  let liveUntil = 0;
  while (running()) {
    if (LIVE !== 'off') {
      if (!lives.has(udid) && Date.now() >= nextLive) {
        const lv = await openLive(udid);
        if (lv) {
          lives.set(udid, lv);
          liveUntil = Date.now() + P.liveFor;
        }
        nextLive = Date.now() + P.liveEvery;
      } else if (lives.has(udid) && Date.now() >= liveUntil) closeLive(udid);
    }
    if (n % P.appEvery === 0) {
      // Home, then the next app (TikTok or Instagram) to scroll
      await act(udid, 'home');
      await sleep(between(P.dwell) / 2);
      await act(udid, 'launch', { bundleId: APPS[appList[app % appList.length]!] });
      app++;
      await sleep(between(P.dwell));
    } else if (n % P.readEvery === 0) {
      await act(udid, 'read');
    } else {
      // the next video or post: a vertical scroll in the middle of the screen (never a tap)
      const up = Math.random() < 0.85;
      const at = Date.now();
      const ok = await act(udid, 'swipe', { x1: 0.5, y1: up ? 0.72 : 0.3, x2: 0.5, y2: up ? 0.3 : 0.72, ms: 260, unit: 'norm' });
      if (ok) watchAfterInput(udid, at);
      await sleep(between(P.dwell));
    }
    n++;
  }
  closeLive(udid);
};

// ---- the monitor: the server, each phone's control state, the counters (runner restarts, Home presses) ----
let traceOk: boolean | null = null;
const traceSeen = new Set<string>();
const traceCount = new Map<string, { homePresses: number; runnerRestarts: number }>();
let lastUptime = Number(health0.body?.uptimeS ?? 0);
const lastCounters = new Map<string, string>();
let lastCountersAt = 0;
const monitorOnce = async () => {
  {
    const h = await call('GET', '/health', undefined, 10_000);
    if (h.status !== 200) stall('server', 'server', `/health: ${h.error ?? h.status}`);
    else {
      fine('server', 'server');
      const up = Number(h.body?.uptimeS ?? 0);
      if (up + 5 < lastUptime) log('server-restarted', { uptimeS: up, commit: h.body?.commit ?? null });
      lastUptime = up;
    }
    const l = await call('GET', '/phones', undefined, 15_000);
    if (l.status === 200 && Array.isArray(l.body)) {
      for (const p of l.body as any[]) {
        const name = names.get(p.udid);
        if (!name) continue;
        if (p.online === false) stall(name, 'control', 'offline (unplugged?)');
        else if (p.control && p.control !== 'ready') stall(name, 'control', `control ${p.control}${p.controlDown ? `: ${clean(String(p.controlDown)).slice(0, 120)}` : ''}`);
        else fine(name, 'control');
      }
    }
    // the journal of the server, when it has one (GET /trace): Home presses and runner starts it saw
    if (traceOk !== false) {
      const tr = await call('GET', '/trace', undefined, 10_000);
      traceOk = tr.status === 200;
      if (traceOk) {
        const evs: any[] = Array.isArray(tr.body) ? tr.body : Array.isArray(tr.body?.events) ? tr.body.events : [];
        for (const e of evs) {
          const key = JSON.stringify([e.t ?? e.at ?? e.time, e.kind ?? e.type, e.udid ?? e.phone, e.route ?? e.op ?? null]);
          if (traceSeen.has(key)) continue;
          traceSeen.add(key);
          const name = names.get(e.udid ?? e.phone) ?? null;
          if (!name) continue;
          const text = JSON.stringify(e);
          const c = traceCount.get(name) ?? { homePresses: 0, runnerRestarts: 0 };
          if (/homescreen|"name":"home"|"home"|press(ing)? home/i.test(text)) c.homePresses++;
          if (/runner[^"]*(start|restart|spawn)|xcodebuild/i.test(text)) c.runnerRestarts++;
          traceCount.set(name, c);
        }
      }
    }
    if (Date.now() - lastCountersAt >= P.counters && l.status === 200 && Array.isArray(l.body)) {
      lastCountersAt = Date.now();
      for (const p of l.body as any[]) {
        const name = names.get(p.udid);
        if (!name) continue;
        const w = p.stats?.controlLink?.wda ?? {};
        const tc = traceCount.get(name);
        const c = {
          runnerRestarts: Number.isFinite(w.runnerRestarts) ? w.runnerRestarts : tc?.runnerRestarts ?? null,
          recoveries: Number.isFinite(w.recoveries) ? w.recoveries : null,
          homePresses: tc ? tc.homePresses : null,
          source: tc ? 'trace+phones' : 'phones',
        };
        const k = JSON.stringify(c);
        if (lastCounters.get(name) !== k || !lastCounters.has(name)) log('counters', { phone: name, ...c });
        lastCounters.set(name, k);
      }
    }
  }
};
const monitor = async () => {
  while (running()) {
    await monitorOnce();
    await sleep(P.monitor);
  }
};

const stopAll = () => {
  for (const u of [...lives.keys()]) closeLive(u);
};
process.on('SIGINT', () => {
  say('interrupted: writing the summary');
  void finish(130);
});

let finishing = false;
async function finish(code?: number) {
  if (finishing) return;
  finishing = true;
  stopAll();
  // what's still open now counts as unrecovered
  log('end', { open: [...open.entries()].map(([k, s]) => ({ key: k, cause: s.cause, forMs: Date.now() - s.since })) });
  await new Promise<void>((r) => journal.end(() => r()));
  const report = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'soak-report.mjs')).href)) as any;
  const s = report.summarize(report.readJournal(OUT).filter((e: any) => !runStart || Date.parse(e.t) >= runStart));
  print(clean(report.format(s)));
  let ok = s.verdict === 'PASS';
  if (DRY) {
    // the dry run also proves the loop did its work
    const missing = [s.inputs > 0 ? '' : 'no input', s.reads > 0 ? '' : 'no read', LIVE === 'off' || s.liveOpens > 0 ? '' : 'no live view'].filter(Boolean);
    if (missing.length) {
      print(`dry run: ${missing.join(', ')}`);
      ok = false;
    }
    await closeDry?.();
  }
  process.exit(code ?? (ok ? 0 : 1));
}

await Promise.all([monitor(), ...[...names.keys()].map((u, i) => worker(u, i))]);
// a last check of what's still stalled: one more monitor pass and a read per phone get a chance to recover them
if (open.size) {
  lastCountersAt = 0; // and the counters once more
  await monitorOnce();
  for (const u of names.keys()) {
    const name = names.get(u)!;
    if (open.has(`${name}|read`)) await act(u, 'read');
    if (open.has(`${name}|input`)) await act(u, 'home');
  }
} else {
  lastCountersAt = 0;
  await monitorOnce();
}
await finish();
