import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { Control } from './control.js';
import { Backend, HttpError, StreamSettings } from './types.js';
import type { Updater } from './updater.js';

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

/** Stream settings from the query: `?fps=&quality=&scale=`, clamped, with defaults 30 / 50 / 50. */
function streamSettings(q: URLSearchParams): StreamSettings {
  const pick = (k: string, dflt: number, lo: number, hi: number) => {
    const v = Number(q.get(k));
    return q.has(k) && q.get(k) !== '' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : dflt;
  };
  return { fps: pick('fps', 30, 1, 60), quality: pick('quality', 50, 5, 100), scale: pick('scale', 50, 10, 100) };
}

function errorText(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  console.error(err);
  return 'internal error';
}

export function createServer(backend: Backend, token: string, updater?: Updater): http.Server {
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const authorized = (candidate: string | null | undefined): boolean =>
    !!candidate && crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), tokenHash);
  const bearer = (req: http.IncomingMessage): string | null => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    return m ? m[1]!.trim() : null;
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const control = new Control(backend);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, mock: backend.mock });
      if (!authorized(bearer(req))) {
        res.setHeader('www-authenticate', 'Bearer');
        return send(res, 401, { error: 'missing or invalid bearer token' });
      }
      if (req.method === 'GET' && path === '/phones') return send(res, 200, await backend.list());
      if (path === '/update/status' || path === '/update/now') {
        if (!updater) return send(res, 503, { error: 'updater unavailable (mock mode)' });
        if (path === '/update/status') {
          if (req.method !== 'GET') throw new HttpError(405, 'use GET');
          return send(res, 200, await updater.status());
        }
        if (req.method !== 'POST') throw new HttpError(405, 'use POST');
        return send(res, 200, await updater.now());
      }

      const m = /^\/phones\/([^/]+)\/(screenshot|tap|swipe|path|hold|touch|type|home|launch|recover)$/.exec(path);
      if (!m) return send(res, 404, { error: 'not found' });
      const udid = decodeURIComponent(m[1]!);
      const action = m[2]!;

      if (action === 'screenshot') {
        if (req.method !== 'GET') throw new HttpError(405, 'use GET');
        const f = url.searchParams.get('format') ?? 'png';
        if (f !== 'png' && f !== 'jpeg') throw new HttpError(400, 'format must be png or jpeg');
        const img = await backend.screenshot(udid, f);
        res.writeHead(200, { 'content-type': img.contentType, 'content-length': img.data.length, 'cache-control': 'no-store' });
        return void res.end(img.data);
      }

      if (req.method !== 'POST') throw new HttpError(405, 'use POST');
      if (action === 'recover') return send(res, 200, { ok: true, control: await control.recover(udid) });
      const body = await readJson(req);
      await control.handle(udid, { ...body, type: action });
      send(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'internal error' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/phones\/([^/]+)\/(stream|control)\/?$/.exec(url.pathname);
    // browsers can't set headers on WebSocket, so ?token= is accepted as well
    if (!m || !authorized(bearer(req) ?? url.searchParams.get('token'))) {
      socket.write(`HTTP/1.1 ${m ? '401 Unauthorized' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
      return void socket.destroy();
    }
    const udid = decodeURIComponent(m[1]!);
    if (m[2] === 'control') return void wss.handleUpgrade(req, socket, head, (ws) => controlSocket(ws, udid));
    const want = streamSettings(url.searchParams);
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Latest frame only: while one frame is being written, newer ones replace the waiting one.
      let writing = false;
      let waiting: Buffer | null = null;
      const push = (frame: Buffer): void => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (writing) {
          waiting = frame;
          return;
        }
        writing = true;
        ws.send(frame, { binary: true }, () => {
          writing = false;
          const next = waiting;
          waiting = null;
          if (next) push(next);
        });
      };
      let sub: ReturnType<Backend['subscribe']>;
      try {
        sub = backend.subscribe(udid, push, want);
      } catch (err) {
        ws.close(1011, err instanceof HttpError ? err.message.slice(0, 100) : 'error');
        return;
      }
      ws.send(JSON.stringify({ type: 'hello', udid, contentType: sub.contentType, fps: sub.fps, scale: sub.scale, quality: sub.quality }));
      ws.on('close', sub.unsubscribe);
      ws.on('error', sub.unsubscribe);
    });
  });

  /** WS /phones/:udid/control: JSON actions in, `{type:"ack", id, ok[, error]}` out (for messages with an id). */
  function controlSocket(ws: WebSocket, udid: string): void {
    const reply = (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    reply({ type: 'hello', udid });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: Record<string, unknown>;
      try {
        const v = JSON.parse(data.toString());
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        msg = v;
      } catch {
        return reply({ type: 'ack', id: null, ok: false, error: 'message must be a JSON object' });
      }
      const id = msg.id ?? null;
      control.handle(udid, msg, ws).then(
        () => {
          if (id !== null) reply({ type: 'ack', id, ok: true });
        },
        // touches without an id still hear about a failed gesture
        (err) => reply({ type: 'ack', id, ok: false, error: errorText(err) }),
      );
    });
    const done = () => control.release(ws);
    ws.on('close', done);
    ws.on('error', done);
  }

  return server;
}
