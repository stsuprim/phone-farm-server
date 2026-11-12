import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Backend, HttpError } from './types.js';
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

function numbers(body: Record<string, unknown>, ...keys: string[]): number[] {
  return keys.map((k) => {
    const v = body[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `"${k}" must be a number`);
    return v;
  });
}

export function createServer(backend: Backend, token: string, updater?: Updater): http.Server {
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const authorized = (candidate: string | null | undefined): boolean =>
    !!candidate && crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), tokenHash);
  const bearer = (req: http.IncomingMessage): string | null => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    return m ? m[1]!.trim() : null;
  };

  const wss = new WebSocketServer({ noServer: true });

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

      const m = /^\/phones\/([^/]+)\/(screenshot|tap|swipe|type|home|launch)$/.exec(path);
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
      const body = await readJson(req);
      switch (action) {
        case 'tap': {
          const [x, y] = numbers(body, 'x', 'y');
          await backend.tap(udid, x!, y!);
          break;
        }
        case 'swipe': {
          const [x1, y1, x2, y2] = numbers(body, 'x1', 'y1', 'x2', 'y2');
          const ms = typeof body.ms === 'number' && body.ms > 0 ? Math.min(body.ms, 10000) : 300;
          await backend.swipe(udid, x1!, y1!, x2!, y2!, ms);
          break;
        }
        case 'type':
          if (typeof body.text !== 'string') throw new HttpError(400, '"text" must be a string');
          await backend.type(udid, body.text);
          break;
        case 'home':
          await backend.home(udid);
          break;
        case 'launch':
          if (typeof body.bundleId !== 'string' || !body.bundleId) throw new HttpError(400, '"bundleId" must be a string');
          await backend.launch(udid, body.bundleId);
          break;
      }
      send(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'internal error' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/phones\/([^/]+)\/stream\/?$/.exec(url.pathname);
    // browsers can't set headers on WebSocket, so ?token= is accepted as well
    if (!m || !authorized(bearer(req) ?? url.searchParams.get('token'))) {
      socket.write(`HTTP/1.1 ${m ? 401 : 404} Unauthorized\r\nConnection: close\r\n\r\n`);
      return void socket.destroy();
    }
    const udid = decodeURIComponent(m[1]!);
    wss.handleUpgrade(req, socket, head, (ws) => {
      let sub: ReturnType<Backend['subscribe']>;
      try {
        sub = backend.subscribe(udid, (frame) => {
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < 2_000_000) ws.send(frame, { binary: true });
        });
      } catch (err) {
        ws.close(1011, err instanceof HttpError ? err.message.slice(0, 100) : 'error');
        return;
      }
      ws.send(JSON.stringify({ type: 'hello', udid, contentType: sub.contentType }));
      ws.on('close', sub.unsubscribe);
      ws.on('error', sub.unsubscribe);
    });
  });

  return server;
}
