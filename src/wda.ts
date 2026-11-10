import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from './config.js';
import { HttpError } from './types.js';

export type WdaStatus = 'starting' | 'ready' | 'failed' | 'stopped';

interface Entry {
  udid: string;
  wdaPort: number;
  mjpegPort: number;
  status: WdaStatus;
  wanted: boolean;
  procs: ChildProcess[];
  restarts: number;
  timer?: NodeJS.Timeout;
  sessionId?: string;
}

const PORTS_FILE = path.join('data', 'ports.json');

/** Supervises one xcodebuild(WDA) + two iproxy forwards per phone. */
export class WdaManager {
  private entries = new Map<string, Entry>();
  private ports: Record<string, number> = {};

  constructor(private cfg: Config) {
    try {
      this.ports = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
    } catch {
      /* first run */
    }
  }

  private slot(udid: string): number {
    if (this.ports[udid] === undefined) {
      const used = new Set(Object.values(this.ports));
      let n = 0;
      while (used.has(n)) n++;
      this.ports[udid] = n;
      fs.mkdirSync('data', { recursive: true });
      fs.writeFileSync(PORTS_FILE, JSON.stringify(this.ports, null, 2));
    }
    return this.ports[udid]!;
  }

  status(udid: string): WdaStatus {
    return this.entries.get(udid)?.status ?? 'stopped';
  }
  mjpegPort(udid: string): number {
    return this.require(udid).mjpegPort;
  }

  private require(udid: string): Entry {
    const e = this.entries.get(udid);
    if (!e) throw new HttpError(503, 'WebDriverAgent is not running for this phone');
    return e;
  }

  start(udid: string): void {
    let e = this.entries.get(udid);
    if (e?.wanted) return;
    const n = this.slot(udid);
    e ??= { udid, wdaPort: this.cfg.wdaBasePort + n, mjpegPort: this.cfg.mjpegBasePort + n, status: 'starting', wanted: true, procs: [], restarts: 0 };
    e.wanted = true;
    this.entries.set(udid, e);
    this.launch(e);
  }

  stop(udid: string): void {
    const e = this.entries.get(udid);
    if (!e) return;
    e.wanted = false;
    e.status = 'stopped';
    this.killProcs(e);
  }

  private killProcs(e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    for (const p of e.procs) p.kill('SIGTERM');
    e.procs = [];
    e.sessionId = undefined;
  }

  private launch(e: Entry): void {
    e.status = 'starting';
    e.sessionId = undefined;
    const log = (m: string) => console.log(`[wda ${e.udid.slice(0, 8)}] ${m}`);
    const spawnLogged = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
      const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stderr?.on('data', () => {}); // drain
      p.stdout?.on('data', () => {});
      p.on('error', (err) => log(`${cmd} failed to start: ${err.message}`));
      return p;
    };

    // device ports are fixed (8100 / 9100); the Mac-side ports differ per phone
    const fwdWda = spawnLogged('iproxy', ['-u', e.udid, `${e.wdaPort}:8100`]);
    const fwdMjpeg = spawnLogged('iproxy', ['-u', e.udid, `${e.mjpegPort}:9100`]);
    const xcode = spawnLogged(
      'xcodebuild',
      [
        'test-without-building',
        '-project', path.join(this.cfg.wdaProject, 'WebDriverAgent.xcodeproj'),
        '-scheme', 'WebDriverAgentRunner',
        '-destination', `id=${e.udid}`,
        '-derivedDataPath', this.cfg.wdaDerivedData,
      ],
      { TEST_RUNNER_USE_PORT: '8100', TEST_RUNNER_MJPEG_SERVER_PORT: '9100' },
    );
    e.procs = [fwdWda, fwdMjpeg, xcode];
    log(`starting (wda :${e.wdaPort}, mjpeg :${e.mjpegPort})`);

    xcode.on('exit', (code) => {
      if (e.procs[2] !== xcode) return; // superseded
      this.killProcs(e);
      if (!e.wanted) return;
      e.status = 'failed';
      e.restarts++;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(e.restarts, 5));
      log(`xcodebuild exited (${code}); restart in ${delay / 1000}s`);
      e.timer = setTimeout(() => e.wanted && this.launch(e), delay);
    });

    // poll WDA /status until it answers
    const waitReady = async () => {
      for (let i = 0; i < 90 && e.wanted && e.procs[2] === xcode; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${e.wdaPort}/status`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) {
            e.status = 'ready';
            e.restarts = 0;
            log('ready');
            return;
          }
        } catch {
          /* not yet */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    void waitReady();
  }

  // ---- WDA HTTP client ----
  private async raw(e: Entry, method: string, p: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${e.wdaPort}${p}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new HttpError(502, `WDA unreachable: ${(err as Error).message}`);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.value?.error) {
      throw new HttpError(502, `WDA error: ${json?.value?.message ?? json?.value?.error ?? res.status}`);
    }
    return json;
  }

  private async session(e: Entry): Promise<string> {
    if (e.sessionId) return e.sessionId;
    const j = await this.raw(e, 'POST', '/session', { capabilities: { alwaysMatch: {} } });
    const id = j.sessionId ?? j.value?.sessionId;
    if (!id) throw new HttpError(502, 'WDA did not return a session id');
    e.sessionId = id;
    return id;
  }

  /** Call a session-scoped WDA endpoint, recreating the session once if it went stale. */
  async call(udid: string, method: string, sub: string, body?: unknown): Promise<any> {
    const e = this.require(udid);
    if (e.status !== 'ready') throw new HttpError(503, `WebDriverAgent is ${e.status}`);
    for (let attempt = 0; ; attempt++) {
      const sid = await this.session(e);
      try {
        return await this.raw(e, method, `/session/${sid}${sub}`, body);
      } catch (err) {
        e.sessionId = undefined;
        if (attempt >= 1) throw err;
      }
    }
  }

  async callNoSession(udid: string, method: string, p: string, body?: unknown): Promise<any> {
    const e = this.require(udid);
    if (e.status !== 'ready') throw new HttpError(503, `WebDriverAgent is ${e.status}`);
    return this.raw(e, method, p, body);
  }

  shutdown(): void {
    for (const e of this.entries.values()) {
      e.wanted = false;
      this.killProcs(e);
    }
  }
}
