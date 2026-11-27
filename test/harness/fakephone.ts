// A fake phone: a WebDriverAgent-like HTTP server on a local port, shaped like the real one (docs/root-cause.md R1):
//   - every route but /status, /screenshot, /wda/lotus/shot and /wda/lotus/info runs on ONE main queue, one at a
//     time, whether the caller is still waiting or not (nothing on the phone is ever cancelled);
//   - the stills go through "testmanagerd": off the main queue, but they wait while an accessibility read is on it
//     (option `stillsWaitForReads`);
//   - a video app in front (TikTok-like) makes every read of the app in front (the tree, elements, the app's name,
//     orientation, window size) slow (`appReadMs`), or never answered (`appReadMs: 'hang'`);
//   - the main queue can hang for good while /status still answers (`hangMain`), and the runner can die (its port
//     closed, every connection refused) and come back when xcodebuild starts it again (`kill`, `revive`);
//   - optional iOS watchdog: a main queue blocked longer than `watchdogMs` kills the runner.
// Everything that reached it is journaled with its times (queued, started, answered), so a test asserts on what the
// phone saw, never on the server's own idea of it. No real phone is ever contacted: it listens on 127.0.0.1 only.
import http from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import zlib from 'node:zlib';

export type Delay = number | 'hang';

export interface FakePhoneOptions {
  udid?: string;
  name?: string;
  /** ms every main-queue route takes by default (default 3). */
  mainMs?: number;
  /** A route's own time on the main queue (ms or 'hang'); undefined = the default. Called per request. */
  stall?: (hit: { method: string; route: string; label: string; body: any }) => Delay | undefined;
  /** A video app (TikTok, Instagram) is in front: reads of the app in front take this long (default 'hang' while videoApp). */
  videoApp?: boolean;
  appReadMs?: Delay;
  /** Stills wait while an accessibility read is on the main queue (testmanagerd). Default true. */
  stillsWaitForReads?: boolean;
  /** ms a still takes (default 20). */
  stillMs?: number;
  /** The screen is black (dark) on stills. Default false. */
  dark?: boolean;
  /** Stills answer with something that is not a picture (the server can't look at the screen). */
  unreadableStills?: boolean;
  /** The phone is locked (/wda/locked). Default false; /wda/unlock unlocks it. */
  locked?: boolean;
  /** iOS's watchdog: the runner dies when its main queue is blocked this long (0 = never, the default). */
  watchdogMs?: number;
  /** Listen on this port (the farm hands out consecutive ones). */
  port?: number;
}

export interface Hit {
  method: string;
  route: string;
  /** "POST /session/:id/wda/pressButton" */
  label: string;
  body: any;
  onMain: boolean;
  appRead: boolean;
  queuedAt: number;
  startedAt: number | null;
  answeredAt: number | null;
  status: number | null;
  /** The caller had gone (its socket closed) before the answer. */
  abandoned: boolean;
}

/** The routes WDA answers off its main queue (FBLotusCommands.inc / FBWebServer.m, docs/root-cause.md R1). */
export function offMain(route: string): boolean {
  return route === '/status' || route === '/screenshot' || /\/screenshot$/.test(route) || route === '/wda/lotus/shot' || route === '/wda/lotus/info' || route === '/lotus/shot' || route === '/lotus/info';
}
/** A still (a picture of the screen through testmanagerd). */
export function isStill(route: string): boolean {
  return route === '/screenshot' || /\/screenshot$/.test(route) || /\/lotus\/shot$/.test(route);
}
/**
 * A read that asks the app in front through accessibility: the tree, elements, the app's name, orientation, window
 * size, a hit test. Kept here (not imported from src/) so the fake doesn't change when the server's own list does.
 */
export function isAppRead(method: string, route: string): boolean {
  const r = route.replace(/^\/session\/[^/]+/, '');
  if (method === 'GET' && /^\/(source|orientation|window\/size|window\/rect|wda\/activeAppInfo|wda\/screen|rotation)$/.test(r)) return true;
  if (method === 'GET' && /^\/element\//.test(r)) return true;
  if (method === 'POST' && /^\/(elements?|element\/[^/]+\/elements?)$/.test(r)) return true;
  if (method === 'GET' && route === '/wda/activeAppInfo') return true;
  return false;
}
export function isTouch(route: string): boolean {
  return /\/(lotus\/touch|lotus\/gesture|actions|touch\/perform|dragfromtoforduration|wda\/tap|tap\/[^/]+|wda\/touchAndHold|wda\/swipe)$/.test(route) || /\/wda\/lotus\/(touch|gesture)$/.test(route);
}
export function isHome(route: string, body: any): boolean {
  return /\/wda\/homescreen$/.test(route) || (/\/pressButton$/.test(route) && body?.name === 'home');
}

/** A small PNG of one colour (the fake screen). */
export function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b: Buffer) => {
    let c = -1;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      // a little texture so it never reads as a flat black frame
      raw[o] = (rgb[0] + ((x * 7 + y * 3) % 32)) & 0xff;
      raw[o + 1] = (rgb[1] + ((x * 5) % 32)) & 0xff;
      raw[o + 2] = (rgb[2] + ((y * 5) % 32)) & 0xff;
    }
  }
  if (rgb.every((v) => v === 0)) raw.fill(0, 0); // a dark screen: all black (filter bytes 0 as well)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakePhone {
  readonly udid: string;
  readonly name: string;
  port = 0;
  /** Every request that reached it, in arrival order. */
  readonly hits: Hit[] = [];
  up = false;
  deaths = 0;
  revivals = 0;
  /** The longest the main queue was blocked by one request (ms). */
  longestBlock = 0;
  /** The most main-queue requests the Mac had open on the phone at once (sent, not yet answered or abandoned). */
  maxMainOpen = 0;
  /** Likewise, counting a request the caller abandoned until the phone really finished it (the phone's own view). */
  maxMainOnPhone = 0;
  locked: boolean;
  dark: boolean;
  videoApp: boolean;
  hangMain = false;
  opts: FakePhoneOptions;
  private server: http.Server;
  private sockets = new Set<Socket>();
  private session = '';
  private gen = 0;
  private queue: { hit: Hit; run: () => Promise<void> }[] = [];
  private running = false;
  private busySince = 0;
  private current: Hit | null = null;
  private mainOpen = 0;
  private mainOnPhone = 0;
  private readsOnMain = 0;
  private killedP!: Promise<void>;
  private killedR!: () => void;
  private wd?: NodeJS.Timeout;
  private releaseHang!: () => void;
  private hangP!: Promise<void>;

  constructor(opts: FakePhoneOptions = {}) {
    this.opts = opts;
    this.udid = opts.udid ?? 'FAKE0001';
    this.name = opts.name ?? 'iPhone-1';
    this.locked = !!opts.locked;
    this.dark = !!opts.dark;
    this.videoApp = !!opts.videoApp;
    this.armKill();
    this.armHang();
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  private armKill() {
    this.killedP = new Promise<void>((r) => (this.killedR = r));
  }
  private armHang() {
    this.hangP = new Promise<void>((r) => (this.releaseHang = r));
  }

  async listen(port = this.opts.port ?? 0): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.up = true;
    if (this.opts.watchdogMs) {
      this.wd = setInterval(() => {
        if (this.up && this.busySince && Date.now() - this.busySince >= this.opts.watchdogMs!) this.kill('watchdog');
      }, 50);
      this.wd.unref();
    }
    return this;
  }

  /** The runner dies: its port closes, its queue is gone, every connection is refused. */
  kill(_why = 'killed'): void {
    if (!this.up) return;
    if (this.busySince) this.longestBlock = Math.max(this.longestBlock, Date.now() - this.busySince);
    this.deaths++;
    this.up = false;
    this.gen++;
    this.queue = [];
    this.running = false;
    this.busySince = 0;
    this.current = null;
    this.mainOpen = 0;
    this.mainOnPhone = 0;
    this.readsOnMain = 0;
    this.session = '';
    this.killedR();
    this.server.close();
    for (const s of this.sockets) s.destroy();
  }

  /** xcodebuild started a runner again: the port answers, a new session is needed. */
  async revive(): Promise<void> {
    if (this.up) return;
    this.armKill();
    this.session = '';
    await new Promise<void>((r) => this.server.listen(this.port, '127.0.0.1', () => r()));
    this.up = true;
    this.revivals++;
  }

  /** The main queue hangs (a stuck accessibility read, XCTest waiting) while /status still answers; off again lets it go. */
  setHung(on: boolean): void {
    this.hangMain = on;
    if (!on) {
      this.releaseHang();
      this.armHang();
    }
  }

  close(): void {
    if (this.wd) clearInterval(this.wd);
    this.releaseHang();
    this.up = false;
    this.server.close();
    for (const s of this.sockets) s.destroy();
  }

  // ---- what the tests read ----
  count(re: RegExp): number {
    return this.hits.filter((h) => re.test(h.label)).length;
  }
  homePresses(): Hit[] {
    return this.hits.filter((h) => isHome(h.route, h.body));
  }
  appReads(): Hit[] {
    return this.hits.filter((h) => h.appRead);
  }
  touches(): Hit[] {
    return this.hits.filter((h) => isTouch(h.route));
  }
  sessionsDeleted(): number {
    return this.hits.filter((h) => h.method === 'DELETE' && /^\/session\//.test(h.route)).length;
  }
  /** Hits that came in at or after `t`. */
  since(t: number): Hit[] {
    return this.hits.filter((h) => h.queuedAt >= t);
  }

  // ---- the phone ----
  private pump = async () => {
    if (this.running) return;
    this.running = true;
    const mine = this.gen;
    while (this.queue.length && this.gen === mine) {
      const job = this.queue.shift()!;
      this.busySince = Date.now();
      this.current = job.hit;
      job.hit.startedAt = Date.now();
      await job.run();
      if (this.gen !== mine) break;
      if (this.busySince) this.longestBlock = Math.max(this.longestBlock, Date.now() - this.busySince);
      this.busySince = 0;
      this.current = null;
    }
    if (this.gen === mine) this.running = false;
  };

  private wait(d: Delay | undefined, dflt: number): Promise<void> {
    const killed = this.killedP;
    if (d === 'hang') return Promise.race([killed, new Promise<void>(() => {})]) as Promise<void>;
    return Promise.race([killed, sleep(d ?? dflt)]);
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '/';
      const route = url.split('?')[0]!.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* not JSON */
      }
      const label = `${method} ${route.replace(/^\/session\/[^/]+/, '/session/:id')}`;
      const main = !offMain(route);
      const appRead = isAppRead(method, route);
      const hit: Hit = { method, route, label, body, onMain: main, appRead, queuedAt: Date.now(), startedAt: null, answeredAt: null, status: null, abandoned: false };
      this.hits.push(hit);
      let open = true;
      const gen = this.gen;
      const done = () => {
        if (!open) return;
        open = false;
        if (main) this.mainOpen--;
      };
      res.on('close', () => {
        if (!hit.answeredAt) hit.abandoned = true;
        done();
      });
      if (main) {
        this.mainOpen++;
        this.maxMainOpen = Math.max(this.maxMainOpen, this.mainOpen);
      }
      const json = (status: number, v: unknown) => {
        if (gen !== this.gen) return;
        hit.answeredAt = Date.now();
        hit.status = status;
        done();
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };

      if (!main) {
        hit.startedAt = Date.now();
        if (route === '/status') return json(200, { value: { ready: true, state: 'success' }, sessionId: this.session || null });
        if (route === '/wda/lotus/info' || route === '/lotus/info') return json(404, { value: { error: 'unknown command', message: 'stock WebDriverAgent' } });
        // a still: through testmanagerd, behind any accessibility read on the main queue
        void (async () => {
          if (this.opts.stillsWaitForReads !== false) while (this.readsOnMain > 0 && gen === this.gen) await sleep(10);
          await this.wait(undefined, this.opts.stillMs ?? 20);
          if (this.opts.unreadableStills) return json(200, { value: Buffer.from('not a picture').toString('base64') });
          const png = solidPng(39, 84, this.dark || this.locked ? [0, 0, 0] : this.videoApp ? [180, 30, 60] : [40, 90, 160]);
          return json(200, { value: png.toString('base64') });
        })();
        return;
      }

      this.mainOnPhone++;
      this.maxMainOnPhone = Math.max(this.maxMainOnPhone, this.mainOnPhone);
      this.queue.push({
        hit,
        run: async () => {
          try {
            if (this.hangMain) await Promise.race([this.hangP, this.killedP]);
            if (gen !== this.gen) return;
            const own = this.opts.stall?.({ method, route, label, body });
            if (appRead && this.videoApp) {
              this.readsOnMain++;
              try {
                await this.wait(own ?? this.opts.appReadMs ?? 'hang', 3);
              } finally {
                this.readsOnMain = Math.max(0, this.readsOnMain - 1);
              }
              if (gen !== this.gen) return;
              return json(500, { value: { error: 'unknown error', message: 'Failed to get the accessibility snapshot of the app in front' } });
            }
            if (appRead) this.readsOnMain++;
            try {
              await this.wait(own, this.opts.mainMs ?? 3);
            } finally {
              if (appRead) this.readsOnMain = Math.max(0, this.readsOnMain - 1);
            }
            if (gen !== this.gen) return;
            this.answer(method, route, body, json);
          } finally {
            if (gen === this.gen) this.mainOnPhone = Math.max(0, this.mainOnPhone - 1);
          }
        },
      });
      void this.pump();
    });
  }

  private answer(method: string, route: string, body: any, json: (s: number, v: unknown) => void) {
    if (route === '/session' && method === 'POST') {
      this.session = `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      return json(200, { sessionId: this.session, value: { sessionId: this.session, capabilities: {} } });
    }
    if (isHome(route, body)) {
      this.videoApp = false; // the Home Screen answers accessibility at once
      return json(200, { value: null });
    }
    if (/\/wda\/apps\/launch$/.test(route)) {
      const b = String(body?.bundleId ?? '');
      this.videoApp = /musically|burbn|tiktok|instagram/i.test(b);
      return json(200, { value: null });
    }
    if (route === '/wda/locked' || /\/wda\/locked$/.test(route)) return json(200, { value: this.locked });
    if (/\/wda\/unlock$/.test(route)) {
      this.locked = false;
      this.dark = false;
      return json(200, { value: null });
    }
    if (/\/wda\/lock$/.test(route)) {
      this.locked = true;
      return json(200, { value: null });
    }
    if (isTouch(route)) return json(200, { value: { queued: 1, lotus: 1 } });
    if (/\/wda\/device\/info$/.test(route)) return json(200, { value: { thermalState: 0, name: this.name } });
    if (/\/wda\/batteryInfo$/.test(route)) return json(200, { value: { level: 0.9, state: 2 } });
    if (/\/wda\/activeAppInfo$/.test(route)) return json(200, { value: { bundleId: 'com.apple.springboard', name: 'Home Screen', pid: 1 } });
    if (/\/orientation$/.test(route)) return json(200, { value: 'PORTRAIT' });
    if (/\/wda\/screen$/.test(route)) return json(200, { value: { scale: 3, screenSize: { width: 428, height: 926 }, statusBarSize: { width: 428, height: 47 } } });
    if (/\/window\/size$/.test(route)) return json(200, { value: { width: 428, height: 926 } });
    if (/\/source$/.test(route)) return json(200, { value: '<XCUIElementTypeApplication name="Home Screen"><XCUIElementTypeButton name="Safari" x="20" y="100" width="60" height="60"/></XCUIElementTypeApplication>' });
    if (/\/wda\/apps\/list$/.test(route)) return json(200, { value: [] });
    const m = /^\/session\/([^/]+)(\/.*)?$/.exec(route);
    if (m && m[1] !== this.session) return json(404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
    if (m && method === 'DELETE' && !m[2]) {
      this.session = '';
      return json(200, { value: null });
    }
    return json(200, { value: m && !m[2] ? { capabilities: {} } : null });
  }
}

/** Fake phones on consecutive local ports (WdaManager puts phone n on base + n). */
export async function fakePhones(list: FakePhoneOptions[]): Promise<FakePhone[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000);
    const made: FakePhone[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const o = list[i]!;
        made.push(await new FakePhone({ udid: `FAKE${String(i + 1).padStart(4, '0')}`, name: `iPhone-${i + 1}`, ...o }).listen(base + i));
      }
      return made;
    } catch {
      for (const p of made) p.close();
    }
  }
  throw new Error('no free run of local ports for the fake phones');
}
