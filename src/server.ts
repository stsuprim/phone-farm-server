import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { ackExtra, Agent } from './agent.js';
import { bitrateAsk, DEFAULT_CEILING_BPS, RateControl, REMOTE_START_BPS, WsFlow } from './congestion.js';
import { Control, touchAck, TouchOwner } from './control.js';
import { H264Viewer, KIND, RateMeter, REMOTE_DROP_BYTES, Transport, wsMessage } from './h264.js';
import { IdleLock } from './idle.js';
import { imageSize } from './imgsize.js';
import { appName, InfoCache, WdaSigning } from './info.js';
import { THUMB_DEFAULT_FPS, THUMB_MAX_FPS, THUMB_MIN_FPS } from './lanes.js';
import { frameAgrees, Size } from './orient.js';
import type { WdaResigner, WdaSignStatus } from './resign.js';
import { isRemote, pathKind, rtcSignaling } from './rtc.js';
import { SettingsStore } from './settings.js';
import { Backend, H264Want, HttpError, PhoneInfo, Profile, QualityTier, SessionStats, StreamSettings, WarmState } from './types.js';
import type { Updater } from './updater.js';

/** What createServer can be given besides the backend (index.ts passes all of them; tests some). */
export interface ServerExtras {
  settings?: SettingsStore;
  idle?: IdleLock;
  resigner?: WdaResigner;
  /** How often a watched phone's WDA and lock state are checked (ms; default WATCH_MS; 0 = never on its own). */
  watchMs?: number;
  /** Seed of natural touch's randomness (tests); default a random one. */
  touchSeed?: number;
}

/** A phone someone watches (an open control socket or stream, or the focused one) is health-checked this often. */
export const WATCH_MS = 12_000;
/** Focusing a phone waits this long at most for the previous one to lock. */

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

export { ackExtra };

const flag = (v: string | null | undefined) => /^(1|true|yes)$/i.test(v ?? '');
/** How often a watched phone is asked how it's turned (ms). The picture's own size change asks at once. */
const ORIENT_POLL_MS = 3000;
/** An MJPEG hello waits this long at most for the first frame (so it can say `connectMs`), then goes without it. */
const MJPEG_HELLO_WAIT_MS = 1500;
/** A warm-up keeps the phone's live touch channel open this long for the viewer that's about to come. */
const WARM_INPUT_MS = 20_000;

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
  // natural touch (the `naturalTouch` setting, on by default): the AI's taps and swipes move like a finger
  const control = new Control(backend, undefined, { natural: () => settings.get().naturalTouch, seed: extras.touchSeed });
  control.onInput = (udid, discrete) => idle.activity(udid, discrete);
  if (idle.supported) control.power = { lock: (u) => idle.lock(u), wake: (u) => idle.wake(u) };
  // the first action after a quiet spell (and one that hung) has the phone's WDA probed and healed first
  if (backend.heal) control.onHeal = (udid, reason) => backend.heal!(udid, reason);
  const agent = new Agent(backend, control);

  // ---- orientation: every open view of a phone hears when it turns (or its picture changes size) ----
  /** The phone as it's turned now: orientation and the upright screen in points and pixels. */
  const view = (udid: string) => {
    const s = backend.screen(udid);
    const px = (v: number) => (s?.scale ? Math.round(v * s.scale) : null);
    return {
      orientation: backend.orientation?.(udid) ?? null,
      point_width: s?.width ?? null, point_height: s?.height ?? null,
      screen_width: s ? px(s.width) : null, screen_height: s ? px(s.height) : null,
    };
  };
  /** `{type: "orientation", ...}` for a view whose picture is `frame` (none: the screen's own pixels). */
  const orientMsg = (udid: string, frame?: Size | null) => {
    const v = view(udid);
    return { type: 'orientation', udid, ...v, width: frame?.width ?? v.screen_width, height: frame?.height ?? v.screen_height };
  };
  const turned = new Map<string, Set<() => void>>();
  const onTurn = (udid: string, fn: () => void): (() => void) => {
    let set = turned.get(udid);
    if (!set) turned.set(udid, (set = new Set()));
    const mine = set;
    mine.add(fn);
    return () => {
      mine.delete(fn);
      if (!mine.size && turned.get(udid) === mine) turned.delete(udid);
    };
  };
  backend.onOrientation = (udid) => {
    for (const fn of [...(turned.get(udid) ?? [])]) {
      try {
        fn();
      } catch {
        /* a closed socket */
      }
    }
    void pushInfo(udid);
  };
  // a phone someone is watching is asked how it's turned every few seconds
  const watched = new Map<string, { n: number; timer: NodeJS.Timeout }>();
  const watch = (udid: string): (() => void) => {
    let w = watched.get(udid);
    if (!w) {
      const timer = setInterval(() => void backend.refreshOrientation?.(udid, ORIENT_POLL_MS - 500).catch(() => {}), ORIENT_POLL_MS);
      timer.unref();
      watched.set(udid, (w = { n: 0, timer }));
      void backend.refreshOrientation?.(udid, 1000).catch(() => {});
    }
    const mine = w;
    mine.n++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--mine.n <= 0) {
        clearInterval(mine.timer);
        if (watched.get(udid) === mine) watched.delete(udid);
      }
    };
  };

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
      // WDA's self-heals (a backend that never heals: none)
      heals: typeof s.heals === 'number' ? s.heals : 0,
      lastHeal: s.lastHeal ?? null,
      ...('h264_available' in s ? { video_path: s.h264_available ? ('h264' as const) : ('mjpeg' as const) } : {}),
      sessions: sessionsOf(udid),
      input: { ...control.meter.stats(udid), methods: backend.inputMethods?.(udid) },
    };
  };
  /**
   * A phone as GET /phones and /api/devices list it: with its lock state, last activity and its detail card's data
   * (`info`: what was last gathered, never waited for here; a gathering starts when it's over ~15 s old).
   */
  const phoneView = (p: PhoneInfo, lan: string[], tailnet: string[]) => {
    const pw = idle.state(p.udid);
    return {
      ...p, lan, tailnet, focused: p.udid === focused, locked: pw.locked, screenOn: pw.screenOn, lastActive: pw.lastActive,
      stats: withInput(p.udid, p.stats), info: info.peek(p),
    };
  };
  const wdaStatus = (): WdaSignStatus | { state: 'unavailable'; lastError: string } =>
    resigner ? resigner.status() : { state: 'unavailable', lastError: backend.mock ? 'mock mode' : 'the WDA re-sign scheduler is off' };
  /** WDA's signing as the detail card shows it. */
  const wdaSigning = (): WdaSigning => {
    const w = wdaStatus();
    return { expiresAt: 'expiresAt' in w ? w.expiresAt ?? null : null, daysLeft: 'daysLeft' in w ? w.daysLeft ?? null : null, state: w.state };
  };
  // the detail cards' data: gathered from the phone at most every ~15 s, off to the side of everything live
  const info = new InfoCache((udid) => (backend.facts ? backend.facts(udid) : Promise.reject(new Error('this backend has no device facts'))), wdaSigning);
  /**
   * Get a phone ready for a viewer that's about to open it: its capture starts (or stays up), its live touch channel
   * opens, and it wakes. Opening the live view then finds a picture at once.
   */
  const warmUp = (udid: string, wake = true): WarmState => {
    let state: WarmState;
    try {
      state = backend.warm?.(udid) ?? { capture: 'unavailable', reason: 'this backend starts its capture with the first viewer' };
    } catch (err) {
      state = { capture: 'unavailable', reason: err instanceof HttpError ? err.message : 'the capture could not be started' };
    }
    if (wake) {
      const release = backend.warmInput?.(udid);
      if (release) setTimeout(release, WARM_INPUT_MS).unref();
      if (idle.supported) void idle.wake(udid, true).catch(() => {});
    }
    return state;
  };
  /** 404 {error: "unknown phone"} or 503 offline, before a wake or lock. */
  const phoneFor = async (udid: string): Promise<PhoneInfo> => {
    const p = (await backend.list()).find((x) => x.udid === udid);
    if (!p) throw new HttpError(404, 'unknown phone');
    if (!p.online) throw new HttpError(503, 'phone is offline');
    return p;
  };

  // ---- info that keeps up: every control socket of a phone hears at once when its card changes ----
  const infoSubs = new Map<string, Set<(msg: unknown) => void>>();
  const onInfo = (udid: string, fn: (msg: unknown) => void): (() => void) => {
    let set = infoSubs.get(udid);
    if (!set) infoSubs.set(udid, (set = new Set()));
    const mine = set;
    mine.add(fn);
    return () => {
      mine.delete(fn);
      if (!mine.size && infoSubs.get(udid) === mine) infoSubs.delete(udid);
    };
  };
  /** `{type: "info", udid, info}` to the phone's control sockets: the card as it is now, with the orientation. */
  async function pushInfo(udid: string): Promise<void> {
    const subs = infoSubs.get(udid);
    if (!subs?.size) return;
    const p = (await backend.list().catch(() => [])).find((x) => x.udid === udid);
    if (!p) return;
    const msg = { type: 'info', udid, info: { ...info.peek(p), orientation: backend.orientation?.(udid) ?? null } };
    for (const fn of [...subs]) {
      try {
        fn(msg);
      } catch {
        /* a closed socket */
      }
    }
  }
  info.onChange = (udid) => void pushInfo(udid);
  // an action may have changed the app in front (or the battery): look again shortly, for the phones on show
  control.onActed = (udid) => {
    if (infoSubs.has(udid)) info.soon(udid);
  };
  // an AI read or a reported action saw the app in front: the cards hear it now
  agent.onApp = (udid, bundleId) => info.patch(udid, { app: { bundleId, name: appName(bundleId) } });

  // ---- one live phone at a time ----
  /** The phone in focus (POST /focus): the only one whose capture runs; null until a client picks one. */
  let focused: string | null = null;
  /** Control sockets and streams open per phone (a viewer is attached). */
  const attached = new Map<string, number>();
  const attach = (udid: string): (() => void) => {
    attached.set(udid, (attached.get(udid) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (attached.get(udid) ?? 1) - 1;
      if (n > 0) attached.set(udid, n);
      else attached.delete(udid);
    };
  };
  const isWatched = (udid: string) => udid === focused || attached.has(udid);
  backend.setWatched?.(isWatched);

  /**
   * Make `udid` the only live phone: the one in focus before it stops its capture and goes to sleep (locks) first,
   * unless an agent action is running on it; then this one is woken and its capture started.
   */
  const focus = async (udid: string) => {
    await phoneFor(udid);
    const prev = focused;
    focused = udid;
    let previous: { udid: string; slept: boolean; reason?: string } | null = null;
    if (prev && prev !== udid) {
      backend.stopCapture?.(prev, 'another phone is in focus');
      if (agent.busy(prev) || control.pending(prev) > 0) {
        previous = { udid: prev, slept: false, reason: 'an agent action is running on it' };
      } else if (!idle.supported) {
        previous = { udid: prev, slept: false, reason: 'this backend cannot lock phones' };
      } else {
        // in the phone's queue, so it never lands on top of an action. 2026-11-16: fire-and-forget: the new phone is
        // never held up by the lock (a slow or timed-out lock only shows in the log, and never marks anything down)
        void control.handle(prev, { type: 'key', key: 'lock' }).then(
          () => console.log(`[focus] ${prev.slice(-8)} is asleep`),
          (err: Error) => console.log(`[focus] ${prev.slice(-8)} stays awake: lock failed: ${err.message}`),
        );
        previous = { udid: prev, slept: false, reason: 'locking' };
      }
      console.log(`[focus] ${prev.slice(-8)} -> ${udid.slice(-8)}${previous.slept ? ' (the previous one is asleep)' : ` (the previous one stays awake: ${previous.reason})`}`);
    }
    const state = warmUp(udid);
    return { focused: udid, previous, ...state, input: backend.inputMethods?.(udid) ?? null };
  };

  // ---- the watch: phones on show are health-checked every WATCH_MS, in their queue ----
  let watching = false;
  const watchTick = async () => {
    if (watching) return;
    watching = true;
    try {
      const ids = new Set([...attached.keys(), ...(focused ? [focused] : [])]);
      const list = ids.size ? await backend.list() : [];
      await Promise.all(
        [...ids].map(async (udid) => {
          const p = list.find((x) => x.udid === udid);
          if (!p?.online) return;
          // WDA alive (a dead session remade, a dead WDA restarted) and the lock known before the next touch
          await control
            .check(udid, async () => {
              if (backend.heal && !(await backend.heal(udid, 'watch'))) return;
              if (backend.isLocked) idle.note(udid, await backend.isLocked(udid).catch(() => null));
            })
            .catch(() => {});
          // the focused phone's capture stays warm while a viewer is attached (its view can reopen at once)
          if (udid === focused && attached.has(udid) && !(p.stats?.viewers ?? 0)) warmUp(udid, false);
          info.peek(p); // the card gathers again when it's ~15 s old: a change is pushed (info.onChange)
        }),
      );
    } finally {
      watching = false;
    }
  };
  const watchEvery = extras.watchMs ?? WATCH_MS;
  const watchTimer = watchEvery > 0 ? setInterval(() => void watchTick(), watchEvery) : undefined;
  watchTimer?.unref();

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
        const list = await backend.list();
        // keep each phone's orientation roughly fresh for whoever lists them (not awaited: the list never waits on a phone)
        for (const p of list) if (p.online && p.ready) void backend.refreshOrientation?.(p.udid, 10_000).catch(() => {});
        return send(res, 200, list.map((p) => phoneView(p, lan, tailnet)));
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

      const m = /^\/(?:phones|api\/devices)\/([^/]+)\/(screenshot|tap|swipe|path|hold|touch|type|key|home|launch|recover|input|wake|lock|ui|apps|orientation|tap-element|act|info|warm|focus)$/.exec(path);
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

      if (action === 'info') {
        // the detail card: battery, temperature, the app in front, uptime, model, iOS, WDA's signing (kept ~15 s)
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        const p = (await backend.list()).find((x) => x.udid === udid);
        if (!p) throw new HttpError(404, 'unknown phone');
        return send(res, 200, { ok: true, udid, ...(await info.get(p, flag(url.searchParams.get('fresh')))) });
      }
      if (action === 'warm') {
        if (req.method !== 'POST') throw new HttpError(405, 'use POST');
        await phoneFor(udid);
        return send(res, 200, { ok: true, udid, ...warmUp(udid), input: backend.inputMethods?.(udid) ?? null });
      }
      if (action === 'focus') {
        // one live phone at a time: this one; the one before it stops its capture and sleeps
        if (req.method !== 'POST') throw new HttpError(405, 'use POST');
        return send(res, 200, { ok: true, udid, ...(await focus(udid)) });
      }

      if (action === 'screenshot') {
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        const f = url.searchParams.get('format') ?? 'png';
        if (f !== 'png' && f !== 'jpeg') throw new HttpError(400, 'format must be png or jpeg');
        await backend.refreshOrientation?.(udid, 2000).catch(() => null);
        const img = await backend.screenshot(udid, f);
        const size = imageSize(img.data);
        res.writeHead(200, {
          'content-type': img.contentType, 'content-length': img.data.length, 'cache-control': 'no-store',
          // the picture is upright: how the phone is turned and the picture's own size
          ...(backend.orientation?.(udid) ? { 'x-orientation': backend.orientation(udid)! } : {}),
          ...(size ? { 'x-width': String(size.width), 'x-height': String(size.height) } : {}),
        });
        return void res.end(img.data);
      }

      // ---- the AI control API: read the screen, act on what it says, hear what changed ----
      if (action === 'ui') {
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        const q = url.searchParams;
        const max = q.has('max') && Number.isFinite(Number(q.get('max'))) ? Number(q.get('max')) : undefined;
        return send(res, 200, { ok: true, ...(await agent.ui(udid, { all: flag(q.get('all')), max, fresh: flag(q.get('fresh')), settle: flag(q.get('settle')) })) });
      }
      if (action === 'apps') {
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        return send(res, 200, { ok: true, udid, apps: await agent.apps(udid) });
      }
      if (action === 'orientation') {
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        await phoneFor(udid);
        await backend.refreshOrientation?.(udid, 500).catch(() => null);
        const v = view(udid);
        return send(res, 200, { ok: true, udid, ...v, width: v.screen_width, height: v.screen_height });
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
      if (action === 'tap-element') return send(res, 200, await agent.inOrder(udid, () => agent.tapElement(udid, body)));
      if (action === 'act') return send(res, 200, await agent.inOrder(udid, () => agent.batch(udid, body)));
      const msg = { ...body, type: action };
      if (action === 'touch') {
        // one live touch event (the fallback when the socket can't open): the same ack fields
        const r = await control.handle(udid, msg);
        return send(res, 200, { ok: true, ...ackExtra(r, t0), ...(touchAck(msg, t0, r) ?? {}) });
      }
      if (body.fast === true || flag(url.searchParams.get('fast'))) {
        // just the action: no look before and after (a client that draws the picture itself)
        const r = await control.handle(udid, msg);
        return send(res, 200, { ok: true, ...ackExtra(r, t0) });
      }
      send(res, 200, await agent.inOrder(udid, () => agent.action(udid, msg)));
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.message });
      console.error(err);
      send(res, 500, { ok: false, error: 'internal error' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const t0 = performance.now(); // the request: `connectMs` counts from here to the first frame
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
      ws.on('close', watch(udid));
      ws.on('close', attach(udid));
      const sess: Sess = { profile, tier: tierOf(url.searchParams), net, t0 };
      if (codec === 'h264') void h264Socket(ws, udid, url.searchParams, remote, sess);
      else mjpegSocket(ws, udid, streamSettings(url.searchParams, remote), codec === 'mjpeg' ? { codec: 'mjpeg' } : {}, remote, sess);
    });
  });

  /** Old behaviour (no `codec`), `codec=mjpeg`, and the fallback when H.264 isn't available (`extra` has the reason). */
  type Sess = { profile: Profile; tier: QualityTier; net: string | null; t0: number };
  function mjpegSocket(ws: WebSocket, udid: string, want: StreamSettings, extra: Record<string, unknown>, remote = false, sess?: Sess): void {
    const meter = new RateMeter();
    const prof: Profile = sess?.profile ?? (remote ? 'remote' : 'lan');
    const t0 = sess?.t0 ?? performance.now();
    let connectMs: number | null = null;
    let said = false; // the hello went
    let firstSent = false;
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
    // the picture's real size (and whether it's upright) comes with the frames: said once known and whenever it changes
    let dims: Size | null = null;
    const sayTurn = () => {
      if (ws.readyState !== WebSocket.OPEN || !said) return; // after the hello: the first frame says the size anyway
      const m = orientMsg(udid, dims);
      // an older WDA's frames stay the panel's in landscape: `turn` is how far clockwise to turn them upright
      const turn = dims && !frameAgrees(dims, m.orientation) ? (m.orientation === 'landscape-left' ? 270 : 90) : 0;
      ws.send(JSON.stringify(turn ? { ...m, turn } : m));
    };
    const push = (frame: Buffer): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (connectMs === null) connectMs = Math.round(performance.now() - t0);
      hello(); // it waited for this frame, to say how long the picture took
      const size = imageSize(frame);
      if (size && (!dims || dims.width !== size.width || dims.height !== size.height)) {
        dims = size;
        sayTurn();
      }
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
      if (!firstSent) {
        firstSent = true;
        ws.send(JSON.stringify({ type: 'first-frame', udid, transport: 'mjpeg-ws', connectMs }));
      }
    };
    let sub: ReturnType<Backend['subscribe']> | undefined;
    /**
     * The hello goes with the first frame, so it says `connectMs` (the request -> that frame); when no frame comes
     * within MJPEG_HELLO_WAIT_MS it goes without (`connectMs: null`; the "first-frame" message says it later).
     */
    const hello = (): void => {
      if (said || !sub || ws.readyState !== WebSocket.OPEN) return;
      said = true;
      clearTimeout(helloTimer);
      const v = view(udid);
      const scale = sub.scale;
      const est = (px: number | null) => (px ? Math.round((px * scale) / 100) : null);
      ws.send(JSON.stringify({
        type: 'hello', ...extra, udid, path: 'mjpeg', profile: prof, quality_tier: sess?.tier ?? 'full',
        contentType: sub.contentType, fps: sub.fps, scale: sub.scale, quality: sub.quality,
        // upright; the frames' real size follows in an "orientation" message with the first frame
        ...v, width: est(v.screen_width), height: est(v.screen_height), connectMs,
      }));
    };
    const helloTimer = setTimeout(hello, MJPEG_HELLO_WAIT_MS);
    try {
      sub = backend.subscribe(udid, push, want);
    } catch (err) {
      clearInterval(retry);
      clearTimeout(helloTimer);
      ws.close(1011, err instanceof HttpError ? err.message.slice(0, 100) : 'error');
      return;
    }
    const mine = sub;
    if (connectMs !== null) hello(); // a backend that gave a frame inside subscribe()
    const since = Date.now();
    const unlist = addLive(udid, () => ({
      path: 'mjpeg', transport: 'mjpeg-ws', net: sess?.net ?? null, profile: prof, quality: sess?.tier ?? 'full', lane: null,
      fps: meter.rate(), latencyMs: null, reason: typeof extra.reason === 'string' ? extra.reason : null, since, connectMs,
    }));
    const unturn = onTurn(udid, sayTurn);
    ws.on('message', (data, isBinary) => {
      const msg = isBinary ? null : parseObject(data);
      if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t ?? null, server_time: Date.now() }));
    });
    const done = () => {
      clearInterval(retry);
      clearTimeout(helloTimer);
      mine.unsubscribe();
      unlist();
      unturn();
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
    const t0 = sess?.t0 ?? performance.now();
    if (typeof src === 'string') reason = src;
    else {
      try {
        // warm: its capture already has a picture (it ran for another viewer, or was kept or started ahead)
        const warm = src.ready;
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
        let connectMs: number | null = null;
        const transport: Transport = {
          kind: 'ws',
          buffered: () => ws.bufferedAmount,
          open: () => ws.readyState === WebSocket.OPEN,
          send: (r) => {
            const m = wsMessage(r);
            ws.send(m);
            flow.sent(m.length);
            if (connectMs === null && r.kind === KIND.KEY) {
              // the first picture left: the request -> this, for the viewer's "opened in N ms"
              connectMs = Math.round(performance.now() - t0);
              ws.send(JSON.stringify({ type: 'first-frame', udid, transport: 'h264-ws', connectMs, warm }));
            }
          },
          fail: (why) => ws.close(1011, why.slice(0, 120)),
          congested: () => flow.congested(),
          dropBytes: remote ? REMOTE_DROP_BYTES : undefined,
        };
        viewer = new H264Viewer(transport, src);
        ws.send(JSON.stringify({
          type: 'hello', codec: 'h264', path: 'h264', udid, ...view(udid), width: info.width, height: info.height, fps: info.fps, scale: info.scale,
          lane: h.kind, profile: remote ? 'remote' : 'lan', quality_tier: want.tier ?? 'full',
          bitrate_kbps: Math.round(rc.bps / 1000), max_kbps: Math.round(rc.max / 1000), server_time: Date.now(),
          // the keyframe follows this message at once: the request -> the first frame, and whether the capture was up
          connectMs: Math.round(performance.now() - t0), warm,
        }));
        // the phone turned, or its picture changed size (a new config and keyframe follow): say so
        const sayTurn = () => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(orientMsg(udid, h.info ?? info)));
        };
        const unturn = onTurn(udid, sayTurn);
        const uninfo = h.onInfo(sayTurn);
        const since = Date.now();
        const vv = viewer;
        const unlist = addLive(udid, () => {
          const st = vv.sessionStats();
          const oneWay = (flow.baseRtt() + flow.lastQueueMs()) / 2;
          return {
            path: 'h264', transport: 'h264-ws', net: sess?.net ?? null, profile: remote ? 'remote' : 'lan', quality: want.tier ?? 'full',
            lane: st.lane, fps: st.fps, latencyMs: st.latencyMs === null ? null : Math.round(st.latencyMs + oneWay), since, connectMs,
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
          unturn();
          uninfo();
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
    // whose touches these are: told when the server lifts one itself (no "up" in time, or the live channel broke)
    const owner: TouchOwner = { touchReleased: (info) => reply({ type: 'touch-released', ...info }) };
    const rtc = rtcSignaling(backend, control, udid, reply, remote, {
      dispatch: (msg, who) => agent.dispatch(udid, msg, who),
      view: () => view(udid),
    });
    // an open live view: keep the phone's live touch channel (HID session) open so the first tap doesn't pay for it
    const releaseInput = backend.warmInput?.(udid);
    // ...and it's activity: the phone wakes and isn't idle-locked while the view is open
    const releaseIdle = idle.viewer(udid);
    // ...and its picture is about to be asked for (the rtc-offer follows): the capture starts now, not then
    warmUp(udid, false);
    const unlist = addLive(udid, () => {
      const i = rtc.info();
      return i ? { path: 'h264' as const, transport: 'webrtc' as const, ...i } : null;
    });
    const v0 = view(udid);
    reply({ type: 'hello', udid, profile: remote ? 'remote' : 'lan', ...v0, width: v0.screen_width, height: v0.screen_height });
    // the phone turned: the picture's size is the WebRTC view's when one runs here, else the screen's own
    const unturn = onTurn(udid, () => reply(orientMsg(udid, rtc.frame())));
    const unwatch = watch(udid);
    // the phone is on show: health-checked every WATCH_MS, and its card's changes are pushed here as they happen
    const unattach = attach(udid);
    const uninfo = onInfo(udid, reply);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = parseObject(data);
      if (!msg) return reply({ type: 'ack', id: null, ok: false, error: 'message must be a JSON object' });
      if (msg.type === 'ping') return reply({ type: 'pong', t: msg.t ?? null, server_time: Date.now() });
      if (rtc.handle(msg)) return;
      // actions answer {type: "ack", id, ...}; a live touch with `seq` answers {ack: seq, ok, ms}
      void agent.dispatch(udid, msg, owner).then((answer) => answer && reply(answer));
    });
    const done = () => {
      control.release(owner);
      rtc.close();
      releaseInput?.();
      releaseIdle();
      unlist();
      unturn();
      unwatch();
      unattach();
      uninfo();
    };
    ws.on('close', done);
    ws.on('error', done);
  }

  server.on('close', () => {
    if (watchTimer) clearInterval(watchTimer);
  });

  return server;
}
