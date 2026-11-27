// A whole farm in one process, on fake hardware: the real server (createServer), the real backend and WDA code
// path (RealBackend + WdaManager) pointed at fake phones on local ports (test/harness/fakephone.ts), a fake
// xcodebuild and iproxy (spawned "processes" that only bring a killed fake runner back), and a fake libimobiledevice
// (which phones are on USB, poll by poll). Tests drive it through the server's PUBLIC HTTP and WebSocket API only.
// `mockServer()` is the same API on MOCK=true (MockBackend), for what the fake WDA can't show (the capture).
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { FakePhone, FakePhoneOptions, fakePhones } from './fakephone.js';
import { find } from './src.js';

export interface Api {
  base: string;
  token: string;
  get(p: string, ms?: number): Promise<{ status: number; body: any; ms: number }>;
  post(p: string, body?: unknown, ms?: number): Promise<{ status: number; body: any; ms: number }>;
  phones(): Promise<any[]>;
  phone(udid: string): Promise<any>;
  /** The control socket of a phone: `send` resolves with the ack. */
  control(udid: string): Promise<{ ws: WebSocket; send(msg: Record<string, unknown>, ms?: number): Promise<any>; messages: any[]; close(): void }>;
  /** A live view on the stream socket: resolves at its first binary frame (or rejects after `ms`). */
  stream(udid: string, codec?: 'h264' | 'mjpeg', ms?: number): Promise<{ ws: WebSocket; frames: number; firstMs: number; close(): void }>;
}

export function api(base: string, token: string): Api {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = async (method: string, p: string, body: unknown, ms: number) => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms) });
      const text = await r.text();
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: r.status, body: parsed, ms: Date.now() - t0 };
    } catch (err) {
      return { status: 0, body: { error: (err as Error).name === 'TimeoutError' ? `no answer within ${ms} ms` : (err as Error).message }, ms: Date.now() - t0 };
    }
  };
  const a: Api = {
    base, token,
    get: (p, ms = 60_000) => call('GET', p, undefined, ms),
    post: (p, body = {}, ms = 60_000) => call('POST', p, body, ms),
    phones: async () => {
      const r = await a.get('/phones', 15_000);
      return Array.isArray(r.body) ? r.body : [];
    },
    phone: async (udid) => (await a.phones()).find((p) => p.udid === udid) ?? null,
    control: (udid) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/phones/${encodeURIComponent(udid)}/control?token=${token}`);
        const acks = new Map<number, (m: any) => void>();
        const messages: any[] = [];
        let id = 1;
        ws.on('message', (d) => {
          let m: any;
          try {
            m = JSON.parse(String(d));
          } catch {
            return;
          }
          messages.push(m);
          if (m.type === 'ack' && acks.has(m.id)) {
            acks.get(m.id)!(m);
            acks.delete(m.id);
          }
        });
        ws.once('error', reject);
        ws.once('open', () =>
          resolve({
            ws, messages,
            close: () => ws.close(),
            send: (msg, ms = 30_000) =>
              new Promise((res) => {
                const n = id++;
                const t = setTimeout(() => {
                  acks.delete(n);
                  res({ ok: false, error: `no ack within ${ms} ms` });
                }, ms);
                acks.set(n, (m) => {
                  clearTimeout(t);
                  res(m);
                });
                ws.send(JSON.stringify({ ...msg, id: n }));
              }),
          }),
        );
      }),
    stream: (udid, codec = 'h264', ms = 10_000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/phones/${encodeURIComponent(udid)}/stream?token=${token}&codec=${codec}`);
        const v = { ws, frames: 0, firstMs: -1, close: () => ws.close() };
        const t = setTimeout(() => {
          ws.terminate();
          reject(new Error(`no picture within ${ms} ms`));
        }, ms);
        ws.on('message', (_d, isBinary) => {
          if (!isBinary) return;
          v.frames++;
          if (v.firstMs < 0) {
            v.firstMs = Date.now() - t0;
            clearTimeout(t);
            resolve(v);
          }
        });
        ws.on('error', (e) => {
          clearTimeout(t);
          reject(e);
        });
        ws.on('close', (code, why) => {
          clearTimeout(t);
          if (v.firstMs < 0) reject(new Error(`closed ${code} ${String(why)}`));
        });
      }),
  };
  return a;
}

// ---- the Mac's processes ----
export interface FakeProc {
  cmd: string;
  args: string[];
  udid: string | null;
  at: number;
  killedAt: number | null;
}

export interface FarmOptions {
  phones: FakePhoneOptions[];
  /** createServer's extras (watchMs, focusLockMs, idle...). */
  extras?: Record<string, unknown>;
  /** The USB poll interval; 0 = no polling timer (default; the first poll still runs). */
  pollMs?: number;
  /** ms after xcodebuild starts until a dead fake runner answers again (default 300). */
  reviveMs?: number;
  /** Print the server's log as it goes (default: kept in `logs`, printed when a test fails). */
  verbose?: boolean;
  /** Wait for every phone's control link to be ready (default true). */
  waitReady?: boolean;
}

export interface Farm extends Api {
  phonesOnDesk: FakePhone[];
  procs: FakeProc[];
  runnerStarts(udid?: string): FakeProc[];
  runnerKills(udid?: string): FakeProc[];
  /** Which phones the next `idevice_id -l` says are on USB (a test changes it between polls). */
  usb: Set<string>;
  logs: string[];
  backend: any;
  wda: any;
  server: http.Server;
  waitReady(udid: string, ms?: number): Promise<boolean>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(cond: () => boolean | Promise<boolean>, ms = 10_000, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(step);
  }
  return !!(await cond());
}

let logHooked = false;
const logSinks: ((line: string) => void)[] = [];
function hookLogs(verbose: boolean): string[] {
  const logs: string[] = [];
  logSinks.push((l) => logs.push(l));
  if (!logHooked) {
    logHooked = true;
    const orig = { log: console.log, error: console.error, warn: console.warn };
    const to = (k: 'log' | 'error' | 'warn') => (...a: unknown[]) => {
      const line = a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack ?? x.message : JSON.stringify(x))).join(' ');
      if (/^(ok|not ok|#|PASS|FAIL)\b/.test(line) || verbose) orig[k](...a);
      for (const s of logSinks) s(line);
    };
    console.log = to('log');
    console.error = to('error');
    console.warn = to('warn');
  }
  return logs;
}

/** A temp working directory (data/ goes there), so a test never touches the repo's data/. */
export function tempCwd(tag: string): () => void {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pf-regress-${tag}-`));
  process.chdir(dir);
  return () => {
    process.chdir(prev);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* in use */
    }
  };
}

export async function startFarm(o: FarmOptions): Promise<Farm> {
  process.env.INPUT_LOG = '0';
  const logs = hookLogs(!!o.verbose);
  const back = tempCwd('farm');
  const desk = await fakePhones(o.phones);
  const usb = new Set(desk.map((p) => p.udid));
  const procs: FakeProc[] = [];
  const reviveMs = o.reviveMs ?? 300;

  const fakeSpawn = ((cmd: string, args: string[] = []) => {
    const p = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const joined = args.join(' ');
    const phone = desk.find((d) => joined.includes(d.udid)) ?? null;
    const rec: FakeProc = { cmd, args, udid: phone?.udid ?? null, at: Date.now(), killedAt: null };
    procs.push(rec);
    Object.assign(p, {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, // no pid: nothing real to reap
      kill: () => {
        if (rec.killedAt) return true;
        rec.killedAt = Date.now();
        if (cmd === 'xcodebuild' && phone) phone.kill('runner killed');
        setTimeout(() => {
          (p as any).exitCode = null;
          (p as any).signalCode = 'SIGTERM';
          p.emit('exit', null, 'SIGTERM');
          p.emit('close', null, 'SIGTERM');
        }, 5).unref();
        return true;
      },
    });
    if (cmd === 'xcodebuild' && phone && !phone.up) setTimeout(() => void phone.revive(), reviveMs).unref();
    return p;
  }) as unknown as typeof import('node:child_process').spawn;

  const run = async (cmd: string, args: string[]) => {
    if (cmd === 'idevice_id') return [...usb].join('\n');
    if (cmd === 'ideviceinfo') {
      const u = args[args.indexOf('-u') + 1];
      const ph = desk.find((d) => d.udid === u);
      const k = args[args.indexOf('-k') + 1];
      if (!ph) return '';
      if (k === 'DeviceName') return ph.name;
      if (k === 'ProductType') return 'iPhone14,8';
      if (k === 'ProductVersion') return '18.5';
      if (k === 'BatteryCurrentCapacity') return '90';
    }
    return '';
  };

  const cfg = {
    host: '127.0.0.1', port: 0, token: '', mock: false, mockPhones: 0,
    wdaBasePort: desk[0]!.port, mjpegBasePort: 40100 + Math.floor(Math.random() * 1000), wdaProject: '/fake/WebDriverAgent', wdaDerivedData: '/fake/dd',
    pollMs: o.pollMs || 60_000, autostartWda: true, autoUpdateSeconds: 0, autoUpdateMinutes: 0,
    h264: false, h264BitrateMbps: 8, audio: false, phoneSilent: false, hidInput: 'off', hidPython: 'python3', hidIdleSeconds: 60,
    captureWarmSeconds: 0, dataDir: 'data', wdaTeamId: '', wdaResign: false, wdaResignHour: 3, wdaFork: false,
  };
  fs.mkdirSync('data', { recursive: true });
  // the phones' indexes, so phone n is on base + n (WdaManager reads data/ports.json)
  fs.writeFileSync(path.join('data', 'ports.json'), JSON.stringify(Object.fromEntries(desk.map((d, i) => [d.udid, i]))));

  const WdaManager = await find('wda', 'WdaManager');
  const RealBackend = await find('real', 'RealBackend');
  const createServer = await find('server', 'createServer');
  const wda = new WdaManager(cfg, (u: string) => desk.find((d) => d.udid === u)?.name ?? u, fakeSpawn);
  const backend = new RealBackend(cfg, { run, wda, timer: !!o.pollMs });
  const token = crypto.randomBytes(16).toString('hex');
  const server: http.Server = createServer(backend, token, undefined, { focusLockMs: 0, exactTouch: true, ...(o.extras ?? {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const a = api(base, token);

  const waitReady = (udid: string, ms = 15_000) =>
    until(async () => {
      const p = await a.phone(udid);
      return !!p && p.online !== false && p.control === 'ready';
    }, ms, 100);

  const farm: Farm = {
    ...a, phonesOnDesk: desk, procs, usb, logs, backend, wda, server, waitReady,
    runnerStarts: (udid) => procs.filter((p) => p.cmd === 'xcodebuild' && (!udid || p.udid === udid)),
    runnerKills: (udid) => procs.filter((p) => p.cmd === 'xcodebuild' && p.killedAt !== null && (!udid || p.udid === udid)),
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await Promise.race([backend.close?.().catch(() => {}), sleep(3000)]);
      for (const d of desk) d.close();
      back();
    },
  };
  if (o.waitReady !== false) {
    for (const d of desk) {
      if (!(await waitReady(d.udid, 20_000))) {
        const p = await a.phone(d.udid);
        throw new Error(`${d.name} never got ready: ${JSON.stringify(p && { control: p.control, ready: p.ready, controlDown: p.controlDown })}`);
      }
    }
  }
  return farm;
}

/** The server on MOCK=true (MockBackend), in this process. */
export async function mockServer(o: { phones?: number; mock?: Record<string, unknown>; extras?: Record<string, unknown>; verbose?: boolean } = {}) {
  process.env.INPUT_LOG = '0';
  const logs = hookLogs(!!o.verbose);
  const back = tempCwd('mock');
  const MockBackend = await find('mock', 'MockBackend');
  const createServer = await find('server', 'createServer');
  const backend = new MockBackend(o.phones ?? 3, o.mock ?? {});
  const token = crypto.randomBytes(16).toString('hex');
  const server: http.Server = createServer(backend, token, undefined, { focusLockMs: 0, ...(o.extras ?? {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...api(base, token), backend, server, logs,
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await Promise.race([backend.close?.().catch(() => {}), sleep(2000)]);
      back();
    },
  };
}
