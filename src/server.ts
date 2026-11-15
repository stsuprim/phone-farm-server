import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { bitrateAsk, DEFAULT_CEILING_BPS, RateControl, REMOTE_START_BPS, WsFlow } from './congestion.js';
import { Control } from './control.js';
import { H264Viewer, RateMeter, REMOTE_DROP_BYTES, Transport, wsMessage } from './h264.js';
import { IdleLock } from './idle.js';
import type { InputResult } from './inputlog.js';
import { THUMB_DEFAULT_FPS, THUMB_MAX_FPS, THUMB_MIN_FPS } from './lanes.js';
import type { WdaResigner, WdaSignStatus } from './resign.js';
import { isRemote, pathKind, rtcSignaling } from './rtc.js';
import { SettingsStore } from './settings.js';
import { Backend, H264Want, HttpError, PhoneInfo, Profile, QualityTier, SessionStats, StreamSettings } from './types.js';
import type { Updater } from './updater.js';

/** What createServer can be given besides the backend (index.ts passes all of them; tests some). */
export interface ServerExtras {
  settings?: SettingsStore;
  idle?: IdleLock;
  resigner?: WdaResigner;
}

/**
 * A viewer's connection profile: `profile=lan|remote` from the client wins; else from its address (the LAN and
 * loopback are lan; Tailscale 100.64/10, fd7a:115c:a1e0::/48 and public addresses are remote).
 */
export function profileOf(asked: string | null | undefined, remoteAddress: string): Profile {
  if (asked === 'lan' || asked === 'remote') return asked;
  return isRemote(remoteAddress) ? 'remote' : 'lan';
}

/** `quality=thumb` (a small ~6 fps lane) or `quality=full`; a number (the old JPEG/bitrate quality) is full. */
export function tierOf(q: URLSearchParams): QualityTier {
  return q.get('quality') === 'thumb' || q.get('tier') === 'thumb' ? 'thumb' : 'full';
}

/**
 * The Mac's own base URLs on its LAN (private IPv4), so a client on the same LAN can go direct. Tailscale's
 * 100.64.0.0/10 addresses are not a LAN (a client that picks one is still ~180 ms away): they're listed apart, in
 * `tailnet`, so no client takes a Tailscale address for a local one.
 */
export function lanUrls(port: number, which: 'lan' | 'tailnet' = 'lan', ifaces = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const k = pathKind(a.address);
      if ((which === 'lan' && k === 'lan') || (which === 'tailnet' && k === 'tailscale')) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

/**
 * H.264 settings from the stream query: fps 1-60 (default 60), scale 10-100 % (default 100), quality 1-100 or none,
 * bitrate (kbit/s, or `kbps`) or none; a bitrate wins over quality. `full=1`: a far viewer gets exactly that too.
 */
export function h264Want(q: URLSearchParams, remote: boolean): H264Want {
  const pick = (k: string, dflt: number, lo: number, hi: number) => {
    const v = Number(q.get(k));
    return q.has(k) && q.get(k) !== '' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : dflt;
  };
  const tier = tierOf(q);
  const numeric = q.has('quality') && q.get('quality') !== '' && Number.isFinite(Number(q.get('quality')));
  return {
    tier,
    fps: pick('fps', tier === 'thumb' ? THUMB_DEFAULT_FPS : 60, 1, 60),
    scale: pick('scale', 100, 10, 100),
    quality: numeric ? pick('quality', 50, 1, 100) : null,
    bitrate: bitrateAsk(q.get('bitrate') ?? q.get('kbps')),
    remote,
    full: /^(1|true|yes)$/i.test(q.get('full') ?? ''),
  };
}

/** Client text messages on a stream or control socket, or null if not a JSON object. */
function parseObject(data: unknown): Record<string, unknown> | null {
  try {
    const v = JSON.parse(String(data));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  throw new HttpError(400, 'body must be a JSON object');
}

/**
 * Stream settings from the query: `?fps=&quality=&scale=`, clamped, with defaults 30 / 50 / 50. A far viewer (not on
 * the LAN) asks WDA for at most 35 % / quality 40: a JPEG a far link carries several times a second.
 */
export function streamSettings(q: URLSearchParams, remote = false): StreamSettings {
  const pick = (k: string, dflt: number, lo: number, hi: number) => {
    const v = Number(q.get(k));
    return q.has(k) && q.get(k) !== '' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : dflt;
  };
  if (tierOf(q) === 'thumb') return { fps: pick('fps', THUMB_DEFAULT_FPS, THUMB_MIN_FPS, THUMB_MAX_FPS), quality: 35, scale: 20 };
  const s = { fps: pick('fps', 30, 1, 60), quality: pick('quality', 50, 5, 100), scale: pick('scale', 50, 10, 100) };
  if (remote && !/^(1|true|yes)$/i.test(q.get('full') ?? '')) {
    s.scale = Math.min(s.scale, 35);
    s.quality = Math.min(s.quality, 40);
  }
  return s;
}

/**
 * The extra fields an ack carries about an injected action (old clients ignore them): how it reached the phone and
 * the server's receive -> injected time.
 */
export function ackExtra(r: InputResult | void, t0: number): Record<string, unknown> {
  return r ? { via: r.via, ms: Math.round((performance.now() - t0) * 10) / 10 } : {};
}

function errorText(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  console.error(err);
  return 'internal error';
}

export function createServer(backend: Backend, token: string, updater?: Updater, extras: ServerExtras = {}): http.Server {
  const settings = extras.settings ?? new SettingsStore();
  const idle = extras.idle ?? new IdleLock(backend, () => settings.get().idleLockMinutes, { tickMs: 0 });
  const resigner = extras.resigner;
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const authorized = (candidate: string | null | undefined): boolean =>
    !!candidate && crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), tokenHash);
  const bearer = (req: http.IncomingMessage): string | null => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    return m ? m[1]!.trim() : null;
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const control = new Control(backend);
  control.onInput = (udid) => idle.activity(udid);

  // every open live view, per phone, for stats.sessions
  type Live = { id: string; info: () => Omit<SessionStats, 'id'> | null };
  const live = new Map<string, Set<Live>>();
  let nextLive = 1;
  const addLive = (udid: string, info: Live['info']): (() => void) => {
    const l: Live = { id: `s${nextLive++}`, info };
    let set = live.get(udid);
    if (!set) live.set(udid, (set = new Set()));
    const mine = set;
    mine.add(l);
    return () => {
      mine.delete(l);
      if (!mine.size && live.get(udid) === mine) live.delete(udid);
    };
  };
  const sessionsOf = (udid: string): SessionStats[] =>
    [...(live.get(udid) ?? [])].flatMap((l) => {
      const i = l.info();
      return i ? [{ id: l.id, ...i }] : [];
    });

  /** A phone's stats with its input part (latency + methods), its video path and its open sessions. */
  const withInput = <T extends object>(udid: string, stats: T | undefined) => {
    const s = (stats ?? {}) as Record<string, unknown>;
    return {
      ...s,
      ...('h264_available' in s ? { video_path: s.h264_available ? ('h264' as const) : ('mjpeg' as const) } : {}),
      sessions: sessionsOf(udid),
      input: { ...control.meter.stats(udid), methods: backend.inputMethods?.(udid) },
    };
  };
  /** A phone as GET /phones and /api/devices list it: with its lock state and last activity. */
  const phoneView = (p: PhoneInfo, lan: string[], tailnet: string[]) => {
    const pw = idle.state(p.udid);
    return { ...p, lan, tailnet, locked: pw.locked, screenOn: pw.screenOn, lastActive: pw.lastActive, stats: withInput(p.udid, p.stats) };
  };
  const wdaStatus = (): WdaSignStatus | { state: 'unavailable'; lastError: string } =>
    resigner ? resigner.status() : { state: 'unavailable', lastError: backend.mock ? 'mock mode' : 'the WDA re-sign scheduler is off' };
  /** 404 {error: "unknown phone"} or 503 offline, before a wake or lock. */
  const phoneFor = async (udid: string): Promise<PhoneInfo> => {
    const p = (await backend.list()).find((x) => x.udid === udid);
    if (!p) throw new HttpError(404, 'unknown phone');
    if (!p.online) throw new HttpError(503, 'phone is offline');
    return p;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, mock: backend.mock });
      if (!authorized(bearer(req))) {
        res.setHeader('www-authenticate', 'Bearer');
        return send(res, 401, { error: 'missing or invalid bearer token' });
      }
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 8787;
      if (req.method === 'GET' && (path === '/phones' || path === '/api/devices')) {
        const lan = lanUrls(port);
        const tailnet = lanUrls(port, 'tailnet');
        return send(res, 200, (await backend.list()).map((p) => phoneView(p, lan, tailnet)));
      }
      if (path === '/api/status' || path === '/status') {
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        const lan = lanUrls(port);
        const tailnet = lanUrls(port, 'tailnet');
        return send(res, 200, {
          mock: backend.mock,
          settings: settings.get(),
          wda: wdaStatus(),
          devices: (await backend.list()).map((p) => phoneView(p, lan, tailnet)),
        });
      }
      if (path === '/api/settings' || path === '/settings') {
        if (req.method === 'GET') return send(res, 200, settings.get());
        if (req.method !== 'PUT' && req.method !== 'POST') throw new HttpError(405, 'use GET or PUT');
        const next = settings.put(await readJson(req));
        void idle.tick().catch(() => {}); // a shorter idle time applies now
        return send(res, 200, next);
      }
      if (path === '/api/wda' || path === '/wda') {
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        return send(res, 200, wdaStatus());
      }
      if (path === '/api/wda/resign' || path === '/wda/resign') {
        if (req.method !== 'POST') throw new HttpError(405, 'use POST');
        if (!resigner) return send(res, 503, { error: backend.mock ? 'WDA re-sign is unavailable in mock mode' : 'the WDA re-sign scheduler is off' });
        return send(res, 202, resigner.start());
      }
      if (path === '/update/status' || path === '/update/now') {
        if (!updater) return send(res, 503, { error: 'updater unavailable (mock mode)' });
        if (path === '/update/status') {
          if (req.method !== 'GET') throw new HttpError(405, 'use GET');
          return send(res, 200, await updater.status());
        }
        if (req.method !== 'POST') throw new HttpError(405, 'use POST');
        return send(res, 200, await updater.now());
      }

      const m = /^\/(?:phones|api\/devices)\/([^/]+)\/(screenshot|tap|swipe|path|hold|touch|type|home|launch|recover|input|wake|lock)$/.exec(path);
      if (!m) return send(res, 404, { error: 'not found' });
      const udid = decodeURIComponent(m[1]!);
      const action = m[2]!;

      if (action === 'wake' || action === 'lock') {
        if (req.method !== 'POST') throw new HttpError(405, 'use POST');
        await phoneFor(udid);
        if (!idle.supported) throw new HttpError(501, 'this backend cannot lock or wake phones');
        try {
          const st = action === 'wake' ? await idle.wake(udid) : await idle.lock(udid);
          return send(res, 200, { ok: true, udid, locked: st.locked, screenOn: st.screenOn, lastActive: st.lastActive, ...(st.error ? { warning: st.error } : {}) });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(502, `${action} failed: ${(err as Error).message}`);
        }
      }

      if (action === 'screenshot') {
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        const f = url.searchParams.get('format') ?? 'png';
        if (f !== 'png' && f !== 'jpeg') throw new HttpError(400, 'format must be png or jpeg');
        const img = await backend.screenshot(udid, f);
        res.writeHead(200, { 'content-type': img.contentType, 'content-length': img.data.length, 'cache-control': 'no-store' });
        return void res.end(img.data);
      }

      if (action === 'input') {
        // input latency (receive -> injected) and the phone's input methods, for checking taps on the Mac
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        return send(res, 200, { udid, ...withInput(udid, undefined)!.input, recent: control.meter.recent(udid).slice(-50) });
      }
      if (req.method !== 'POST') throw new HttpError(405, 'use POST');
      if (action === 'recover') return send(res, 200, { ok: true, control: await control.recover(udid) });
      const body = await readJson(req);
      const t0 = performance.now();
      const r = await control.handle(udid, { ...body, type: action });
      send(res, 200, { ok: true, ...ackExtra(r, t0) });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'internal error' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/(?:phones|api\/devices)\/([^/]+)\/(stream|control)\/?$/.exec(url.pathname);
    // browsers can't set headers on WebSocket, so ?token= is accepted as well
    if (!m || !authorized(bearer(req) ?? url.searchParams.get('token'))) {
      socket.write(`HTTP/1.1 ${m ? '401 Unauthorized' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
      return void socket.destroy();
    }
    const udid = decodeURIComponent(m[1]!);
    // the profile: the client's `profile=lan|remote`, else from its address (a viewer that isn't on the Mac's LAN,
    // Tailscale or the Internet, gets the adaptive far lane, starting at a bitrate a long link carries)
    const addrNow = req.socket.remoteAddress ?? '';
    const profile = profileOf(url.searchParams.get('profile'), addrNow);
    const remote = profile === 'remote';
    const net = addrNow ? pathKind(addrNow) : null;
    if (m[2] === 'control') return void wss.handleUpgrade(req, socket, head, (ws) => controlSocket(ws, udid, remote));
    const codec = url.searchParams.get('codec');
    if (codec !== null && codec !== 'h264' && codec !== 'mjpeg') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // an opened live view is activity: the phone wakes, and isn't idle-locked while it's open
      const releaseIdle = idle.viewer(udid);
      ws.on('close', releaseIdle);
      const sess: Sess = { profile, tier: tierOf(url.searchParams), net };
      if (codec === 'h264') void h264Socket(ws, udid, url.searchParams, remote, sess);
      else mjpegSocket(ws, udid, streamSettings(url.searchParams, remote), codec === 'mjpeg' ? { codec: 'mjpeg' } : {}, remote, sess);
    });
  });

  /** Old behaviour (no `codec`), `codec=mjpeg`, and the fallback when H.264 isn't available (`extra` has the reason). */
  type Sess = { profile: Profile; tier: QualityTier; net: string | null };
  function mjpegSocket(ws: WebSocket, udid: string, want: StreamSettings, extra: Record<string, unknown>, remote = false, sess?: Sess): void {
    const meter = new RateMeter();
    const prof: Profile = sess?.profile ?? (remote ? 'remote' : 'lan');
    // Latest frame only: while one frame is being written, or earlier ones still wait on the way to the viewer
    // (flow control: a slow link never builds a queue of old frames), newer ones replace the waiting one. One more frame
    // may follow one still on its way, so a far link isn't idle for a round trip after every frame.
    let writing = false;
    let waiting: Buffer | null = null;
    const flush = () => {
      const next = waiting;
      waiting = null;
      if (next) push(next);
    };
    const flow = WsFlow.of(ws, { onAck: () => !writing && flush() });
    // a frame held back while the link was full goes once it has room, even if the next pong is slow to come
    const retry = setInterval(() => !writing && waiting && flush(), 100);
    const push = (frame: Buffer): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (writing || ws.bufferedAmount > (remote ? REMOTE_DROP_BYTES : 1024 * 1024) || !flow.canSend(frame.length)) {
        waiting = frame;
        return;
      }
      writing = true;
      meter.tick();
      ws.send(frame, { binary: true }, () => {
        writing = false;
        flush();
      });
      flow.sent(frame.length);
    };
    let sub: ReturnType<Backend['subscribe']>;
    try {
      sub = backend.subscribe(udid, push, want);
    } catch (err) {
      clearInterval(retry);
      ws.close(1011, err instanceof HttpError ? err.message.slice(0, 100) : 'error');
      return;
    }
    const since = Date.now();
    const unlist = addLive(udid, () => ({
      path: 'mjpeg', transport: 'mjpeg-ws', net: sess?.net ?? null, profile: prof, quality: sess?.tier ?? 'full', lane: null,
      fps: meter.rate(), latencyMs: null, reason: typeof extra.reason === 'string' ? extra.reason : null, since,
    }));
    ws.send(JSON.stringify({
      type: 'hello', ...extra, udid, path: 'mjpeg', profile: prof, quality_tier: sess?.tier ?? 'full',
      contentType: sub.contentType, fps: sub.fps, scale: sub.scale, quality: sub.quality,
    }));
    ws.on('message', (data, isBinary) => {
      const msg = isBinary ? null : parseObject(data);
      if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t ?? null, server_time: Date.now() }));
    });
    const done = () => {
      clearInterval(retry);
      sub.unsubscribe();
      unlist();
    };
    ws.on('close', done);
    ws.on('error', done);
  }

  /**
   * `codec=h264`: hello {type:"hello", codec:"h264", width, height, fps, scale, server_time}, then binary
   * [kind 1 config | 2 key | 3 delta][float64 BE capture ms][Annex B]. Falls back to MJPEG with a reason.
   */
  async function h264Socket(ws: WebSocket, udid: string, q: URLSearchParams, remote: boolean, sess?: Sess): Promise<void> {
    let reason: string;
    let src: ReturnType<Backend['h264']>;
    const want = h264Want(q, remote);
    try {
      src = backend.h264(udid, want);
    } catch (err) {
      ws.close(1011, err instanceof HttpError ? err.message.slice(0, 100) : 'error');
      return;
    }
    if (typeof src === 'string') reason = src;
    else {
      try {
        const info = await src.open();
        if (ws.readyState !== WebSocket.OPEN) return;
        const h = src;
        // Congestion control: a ping after the frames measures the queue in front of this viewer; frames are
        // skipped while it's too long, and the encoder's bitrate (and a far lane's frame rate) follow what the link
        // delivers. A far viewer starts low and climbs to its ask.
        const ceiling = want.bitrate ?? (h.ceiling || DEFAULT_CEILING_BPS);
        const rc = new RateControl(ceiling, remote ? Math.min(ceiling, REMOTE_START_BPS) : ceiling);
        let viewer: H264Viewer | undefined;
        const adjust = () => {
          if (!viewer) return;
          const q = Math.max(flow.lastQueueMs(), flow.waitingMs());
          const changed = q > 150 ? rc.down(q > 600 ? 0.6 : 0.85, flow.delivered, Math.max(500, flow.baseRtt() + 200)) : q < 50 ? rc.up() : false;
          if (changed) h.setTarget(viewer, rc.bps);
        };
        const flow = WsFlow.of(ws, { onAck: adjust, targetMs: remote ? 300 : 250 });
        const tick = setInterval(adjust, 500);
        const transport: Transport = {
          kind: 'ws',
          buffered: () => ws.bufferedAmount,
          open: () => ws.readyState === WebSocket.OPEN,
          send: (r) => {
            const m = wsMessage(r);
            ws.send(m);
            flow.sent(m.length);
          },
          fail: (why) => ws.close(1011, why.slice(0, 120)),
          congested: () => flow.congested(),
          dropBytes: remote ? REMOTE_DROP_BYTES : undefined,
        };
        viewer = new H264Viewer(transport, src);
        ws.send(JSON.stringify({
          type: 'hello', codec: 'h264', path: 'h264', udid, width: info.width, height: info.height, fps: info.fps, scale: info.scale,
          lane: h.kind, profile: remote ? 'remote' : 'lan', quality_tier: want.tier ?? 'full',
          bitrate_kbps: Math.round(rc.bps / 1000), max_kbps: Math.round(rc.max / 1000), server_time: Date.now(),
        }));
        const since = Date.now();
        const vv = viewer;
        const unlist = addLive(udid, () => {
          const st = vv.sessionStats();
          const oneWay = (flow.baseRtt() + flow.lastQueueMs()) / 2;
          return {
            path: 'h264', transport: 'h264-ws', net: sess?.net ?? null, profile: remote ? 'remote' : 'lan', quality: want.tier ?? 'full',
            lane: st.lane, fps: st.fps, latencyMs: st.latencyMs === null ? null : Math.round(st.latencyMs + oneWay), since,
          };
        });
        h.setTarget(viewer, rc.bps);
        h.add(viewer);
        const v = viewer;
        ws.on('message', (data, isBinary) => {
          const msg = isBinary ? null : parseObject(data);
          if (msg?.type === 'key') v.forceKey();
          else if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t ?? null, server_time: Date.now() }));
        });
        const done = () => {
          clearInterval(tick);
          h.remove(v);
          unlist();
        };
        ws.on('close', done);
        ws.on('error', done);
        return;
      } catch (err) {
        reason = (err as Error).message;
      }
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    mjpegSocket(ws, udid, streamSettings(q, remote), { codec: 'mjpeg', reason }, remote, sess);
  }

  /**
   * WS /phones/:udid/control: JSON actions in, `{type:"ack", id, ok[, error]}` out (for messages with an id);
   * `{type:"ping", t}` -> `{type:"pong", t, server_time}`; rtc-offer / rtc-ice / rtc-close for the WebRTC view.
   */
  function controlSocket(ws: WebSocket, udid: string, remote: boolean): void {
    const reply = (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const rtc = rtcSignaling(backend, control, udid, reply, remote);
    // an open live view: keep the phone's live touch channel (HID session) open so the first tap doesn't pay for it
    const releaseInput = backend.warmInput?.(udid);
    // ...and it's activity: the phone wakes and isn't idle-locked while the view is open
    const releaseIdle = idle.viewer(udid);
    const unlist = addLive(udid, () => {
      const i = rtc.info();
      return i ? { path: 'h264' as const, transport: 'webrtc' as const, ...i } : null;
    });
    reply({ type: 'hello', udid, profile: remote ? 'remote' : 'lan' });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = parseObject(data);
      if (!msg) return reply({ type: 'ack', id: null, ok: false, error: 'message must be a JSON object' });
      if (msg.type === 'ping') return reply({ type: 'pong', t: msg.t ?? null, server_time: Date.now() });
      if (rtc.handle(msg)) return;
      const id = msg.id ?? null;
      const t0 = performance.now();
      control.handle(udid, msg, ws).then(
        (r) => {
          if (id !== null) reply({ type: 'ack', id, ok: true, ...ackExtra(r, t0) });
        },
        // touches without an id still hear about a failed gesture
        (err) => reply({ type: 'ack', id, ok: false, error: errorText(err) }),
      );
    });
    const done = () => {
      control.release(ws);
      rtc.close();
      releaseInput?.();
      releaseIdle();
      unlist();
    };
    ws.on('close', done);
    ws.on('error', done);
  }


  return server;
}
