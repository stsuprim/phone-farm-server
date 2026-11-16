import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Config } from './config.js';
import { isLandscape, Orientation, orientationFromWda, portraitSize, uprightSize, uprightToPanel } from './orient.js';
import { ButtonName, ControlState, HttpError, PathPoint, ScreenInfo, StreamSettings } from './types.js';

export type WdaStatus = 'starting' | 'ready' | 'failed' | 'stopped';

/**
 * unreachable/session/server = WDA (or its session) is down and worth a recovery + retry;
 * rejected = WDA answered but refused the request; unknown = WDA doesn't have that endpoint.
 */
type Kind = 'unreachable' | 'session' | 'server' | 'rejected' | 'unknown';

export class WdaError extends HttpError {
  named = false;
  /** No answer came in time (WDA may only be busy: it works one request at a time), rather than a refused connection. */
  timeout = false;
  constructor(public kind: Kind, message: string) {
    super(502, message);
  }
  get down(): boolean {
    return this.kind === 'unreachable' || this.kind === 'session' || this.kind === 'server';
  }
}

interface Entry {
  udid: string;
  wdaPort: number;
  mjpegPort: number;
  status: WdaStatus;
  control: ControlState;
  wanted: boolean;
  procs: ChildProcess[];
  restarts: number;
  timer?: NodeJS.Timeout;
  sessionId?: string;
  sessionP?: Promise<string>;
  recovering?: Promise<void>;
  checking: boolean;
  lastOk: number;
  /** The screen in points as held in portrait (short side across), with the pixel scale. */
  screen?: ScreenInfo;
  /** How the phone is turned (WDA's /orientation: the foreground app's), when it was last asked, and an ask in flight. */
  orientation: Orientation | null;
  orientAt: number;
  orientP?: Promise<Orientation | null>;
  tapRoute: 0 | 1 | 2; // 0: /wda/tap, 1: /wda/tap/0 (older WDA), 2: W3C actions
  /** The patched WDA's /wda/lotus/touch (scripts/patch-wda.mjs): yes, no (an unpatched build), or not tried yet. */
  fast: 'yes' | 'no' | 'unknown';
  fastFails: number; // the fast route refused touches in a row (3: given up until WDA restarts)
  mjpeg: StreamSettings; // wanted MJPEG settings
  mjpegApplied?: string; // JSON of the settings last applied to the current session
  /** This WDA's /status names its session (so a /status without ours means ours is gone). */
  statusNamesSession?: boolean;
  /** When a quiet call last had the session remade (at most one such remake every few seconds). */
  goneAt?: number;
  agent: http.Agent; // keep-alive connections to WDA (through iproxy): no new usbmux connection per touch
  /** Self-heals so far (a session remade, WDA restarted, a forward respawned), and the last one with its reason. */
  heals: number;
  lastHeal: HealRecord | null;
  /** Actions and reads on their way to WDA now (a quiet read skips while one is: WDA takes one thing at a time). */
  inflight: number;
  /** A liveness probe in progress (shared by everyone asking). */
  probeP?: Promise<boolean>;
  /** Requests of any kind on their way to WDA now (card reads, the orientation, a lock, a screenshot: all of them). */
  busy: number;
  /** When WDA last answered anything at all, whatever it said (Date.now()). */
  lastAnswer: number;
  /** Liveness checks in a row that got no answer in time, and when the first of them was. */
  misses: number;
  missAt: number;
  /** When `control` last left "ready" (state() says so only once that lasted: a blip is never shown). */
  unreadyAt: number;
  /** Recoveries and runner restarts so far, and why the last recovery ran (stats). */
  recoveries: number;
  runnerRestarts: number;
}

/** One self-heal: when (ms since the epoch) and why. */
export interface HealRecord {
  at: number;
  reason: string;
}

/** How long WDA gets to answer each kind of request before it counts as hung (ms). */
export interface WdaTimeouts {
  /** A tap, a button, the home screen, a fast-route touch. */
  input: number;
  /** Launching an app. */
  launch: number;
  /** A liveness probe (GET /session/:id). */
  probe: number;
  /** How long a restarted runner gets to come back. */
  restart: number;
  /** A recovery's first ask of /status (ms; default STATUS_MS); the two asks after it get half as long again. */
  status?: number;
  /** Liveness checks in a row with no answer in time before WDA counts as down (default MISSES)... */
  misses?: number;
  /** ...and only when they span at least this long (ms; default MISS_SPAN_MS). */
  missSpan?: number;
  /** A control state other than "ready" is said only once it lasted this long (ms; default CONTROL_DEBOUNCE_MS). */
  debounce?: number;
}
export const DEFAULT_TIMEOUTS: WdaTimeouts = { input: 8000, launch: 20000, probe: 3000, restart: 90000 };
/**
 * 2026-11-16, the control link that kept failing and recovering: WDA works one request at a time, and one liveness
 * check that got no answer in 3 s (it waited behind a screenshot, a lock, a card read, the orientation) counted as a
 * dead WDA: its session was dropped, and when /status then waited behind the same request (2.5 s) its runner was
 * restarted on the phone (half a minute of "Recovering"). Now WDA counts as down only after MISSES liveness checks
 * in a row over MISS_SPAN_MS got no answer while nothing else answered either; a recovery asks /status three times
 * before it restarts anything and keeps a session that still answers; and a state that isn't "ready" is said only
 * once it lasted CONTROL_DEBOUNCE_MS. A refused connection (WDA isn't listening at all) still recovers at once.
 */
export const MISSES = 3;
export const MISS_SPAN_MS = 15_000;
export const STATUS_MS = 2500;
export const CONTROL_DEBOUNCE_MS = 4000;

const newAgent = () => new http.Agent({ keepAlive: true, maxSockets: 6 });
type HttpErr = Error & { code?: string };

const PORTS_FILE = path.join('data', 'ports.json');
const HEALTH_MS = 10000;
const DEFAULT_MJPEG: StreamSettings = { fps: 60, quality: 50, scale: 50 };
// No waiting for the app to be idle/animations to finish before each action: that's what made taps slow.
const CAPS = { shouldWaitForQuiescence: false, waitForIdleTimeout: 0, shouldUseCompactResponses: true, maxTypingFrequency: 60 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The fast route's tap: press, then lift this long after (a finger's quick tap). */
export const FAST_TAP_HOLD_MS = 50;
/** The route scripts/patch-wda.mjs adds to WebDriverAgent (keep the two in step). */
export const FAST_TOUCH_ROUTE = '/wda/lotus/touch';

/** W3C pointer actions for one finger through the points (x, y in points, t = ms since start). */
export function pointerActions(pts: PathPoint[]): unknown[] {
  const p0 = pts[0]!;
  const out: unknown[] = [
    { type: 'pointerMove', duration: 0, x: Math.round(p0[0]), y: Math.round(p0[1]) },
    { type: 'pointerDown', button: 0 },
  ];
  if (p0[2] > 0) out.push({ type: 'pause', duration: Math.round(p0[2]) });
  const total = pts[pts.length - 1]![2] - p0[2];
  const minDt = Math.max(10, total / 400); // ~100 Hz, at most ~400 segments
  let prev = p0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const lastOne = i === pts.length - 1;
    const dt = Math.round(p[2] - prev[2]);
    if (!lastOne && dt < minDt) continue; // merged into the next segment (time is absolute)
    const x = Math.round(p[0]);
    const y = Math.round(p[1]);
    if (x === Math.round(prev[0]) && y === Math.round(prev[1])) {
      if (dt > 0) out.push({ type: 'pause', duration: dt });
    } else {
      out.push({ type: 'pointerMove', duration: Math.max(0, dt), x, y });
    }
    prev = p;
  }
  out.push({ type: 'pointerUp', button: 0 });
  return out;
}

/** Supervises one xcodebuild(WDA) + two iproxy forwards per phone, keeps a WDA session warm and recovers it. */
export class WdaManager {
  private entries = new Map<string, Entry>();
  private ports: Record<string, number> = {};
  private health: NodeJS.Timeout;
  /** Called when a phone's orientation (or its screen size, once known) changed. */
  onOrientation?: (udid: string) => void;
  /** Whether someone is watching the phone now: its health check probes the session, not just /status. */
  watched?: (udid: string) => boolean;

  constructor(
    private cfg: Config,
    private nameOf: (udid: string) => string = (u) => u,
    private spawnFn: typeof spawn = spawn, // tests: no real iproxy/xcodebuild
    private timeouts: WdaTimeouts = DEFAULT_TIMEOUTS,
  ) {
    try {
      this.ports = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
    } catch {
      /* first run */
    }
    this.health = setInterval(() => this.healthCheck(), HEALTH_MS);
    this.health.unref();
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

  private log(e: Entry, m: string): void {
    console.log(`[wda ${e.udid.slice(-8)}] ${m}`); // UDID end: the start (00008110...) is the chip, same on both phones
  }

  /** A self-heal: counted, kept as the phone's last one and logged with its reason. */
  private healed(e: Entry, reason: string): void {
    e.heals++;
    e.lastHeal = { at: Date.now(), reason: reason.slice(0, 200) };
    console.log(`[wda-heal] ${e.udid.slice(-8)} ${reason}`);
  }

  /** The phone's self-heals (`heals`) and the last one (`lastHeal`), for its stats. */
  healStats(udid: string): { heals: number; lastHeal: HealRecord | null } {
    const e = this.entries.get(udid);
    return { heals: e?.heals ?? 0, lastHeal: e?.lastHeal ?? null };
  }

  /**
   * How WDA's own link is doing, for the phone's stats (`stats.controlLink.wda`): the state as told (debounced) and
   * as it is, liveness checks missed in a row, recoveries and runner restarts so far, ms since WDA last answered.
   */
  linkHealth(udid: string): { state: ControlState; raw: ControlState; misses: number; recoveries: number; runnerRestarts: number; answeredMsAgo: number | null; busy: number } | null {
    const e = this.entries.get(udid);
    if (!e) return null;
    return {
      state: this.state(udid), raw: !e.wanted ? 'down' : e.status === 'starting' ? 'recovering' : e.status !== 'ready' ? 'down' : e.control,
      misses: e.misses, recoveries: e.recoveries, runnerRestarts: e.runnerRestarts,
      answeredMsAgo: e.lastAnswer ? Date.now() - e.lastAnswer : null, busy: e.busy + e.inflight,
    };
  }

  /** `control` changes here, so when it left "ready" is known (state() says a state only once it lasted). */
  private setControl(e: Entry, c: ControlState): void {
    if (c !== 'ready' && e.control === 'ready') e.unreadyAt = Date.now();
    e.control = c;
  }

  /**
   * A liveness check got no answer. True when WDA now counts as down: the connection was refused (nothing listens), or
   * this is the `misses`-th check in a row without an answer in time, over `missSpan`, with nothing else answered
   * meanwhile (any answer at all clears the count: src request()).
   */
  private missed(e: Entry, err: unknown): boolean {
    if (!(err instanceof WdaError) || !err.timeout) return true;
    const now = Date.now();
    if (!e.misses) e.missAt = now;
    e.misses++;
    const down = e.misses >= (this.timeouts.misses ?? MISSES) && now - e.missAt >= (this.timeouts.missSpan ?? MISS_SPAN_MS);
    if (!down && e.misses === 1) this.log(e, `a liveness check got no answer in time (${err.message}); WDA may only be busy, checking again`);
    return down;
  }

  status(udid: string): WdaStatus {
    return this.entries.get(udid)?.status ?? 'stopped';
  }
  /**
   * ready = session warm; recovering = WDA starting or session being remade; down = not running / gave up. A session
   * being remade or checked says "ready" until that has lasted `debounce`: a hiccup that heals in a moment is never
   * shown as the link going down and coming back.
   */
  state(udid: string): ControlState {
    const e = this.entries.get(udid);
    if (!e || !e.wanted) return 'down';
    if (e.status === 'starting') return 'recovering';
    if (e.status !== 'ready') return 'down';
    if (e.control !== 'ready' && Date.now() - e.unreadyAt < (this.timeouts.debounce ?? CONTROL_DEBOUNCE_MS)) return 'ready';
    return e.control;
  }
  /** The screen in points, upright: as the phone is turned now (844 x 390 in landscape). */
  screen(udid: string): ScreenInfo | null {
    const e = this.entries.get(udid);
    return e?.screen ? { ...uprightSize(e.screen, e.orientation), scale: e.screen.scale } : null;
  }
  orientation(udid: string): Orientation | null {
    return this.entries.get(udid)?.orientation ?? null;
  }
  /**
   * Whether this phone's WDA has its MJPEG server (WDA's screenshots as a JPEG stream; stock WDA: yes). A WDA built
   * without it gives stills as PNG screenshots only (src/stills.ts asks here).
   */
  mjpegAvailable(_udid: string): boolean {
    return true;
  }
  mjpegPort(udid: string): number {
    const e = this.entries.get(udid);
    if (!e) throw new HttpError(503, 'WebDriverAgent is not running for this phone');
    return e.mjpegPort;
  }

  start(udid: string): void {
    let e = this.entries.get(udid);
    if (e?.wanted) return;
    const n = this.slot(udid);
    e ??= {
      udid, wdaPort: this.cfg.wdaBasePort + n, mjpegPort: this.cfg.mjpegBasePort + n, status: 'starting', control: 'recovering',
      wanted: true, procs: [], restarts: 0, checking: false, lastOk: 0, orientation: null, orientAt: 0, tapRoute: 0, fast: 'unknown', fastFails: 0,
      mjpeg: { ...DEFAULT_MJPEG }, agent: newAgent(), heals: 0, lastHeal: null, inflight: 0,
      busy: 0, lastAnswer: 0, misses: 0, missAt: 0, unreadyAt: 0, recoveries: 0, runnerRestarts: 0,
    };
    e.wanted = true;
    this.entries.set(udid, e);
    this.launch(e);
  }

  stop(udid: string): void {
    const e = this.entries.get(udid);
    if (!e) return;
    e.wanted = false;
    e.status = 'stopped';
    e.control = 'down';
    this.killProcs(e);
  }

  private killProcs(e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    for (const p of e.procs) p.kill('SIGTERM');
    e.procs = [];
    e.sessionId = undefined;
    e.sessionP = undefined;
    e.mjpegApplied = undefined;
    e.agent.destroy(); // the forwards are gone: so are their connections
    e.agent = newAgent();
  }

  /** Relaunch the phone's runner now (after a re-sign: test-without-building installs the fresh build). */
  restartRunner(udid: string): void {
    const e = this.entries.get(udid);
    if (!e?.wanted) return;
    this.log(e, 'restarting the runner (fresh WDA build)');
    e.restarts = 0;
    this.restart(e);
  }

  /** Kill and relaunch the WDA runner and its forwards right away. */
  private restart(e: Entry): void {
    if (!e.wanted) return;
    this.killProcs(e);
    e.restarts++;
    e.runnerRestarts++;
    this.launch(e);
  }

  private relaunchLater(e: Entry, why: string): void {
    this.killProcs(e);
    if (!e.wanted) return;
    e.status = 'failed';
    e.control = 'down';
    e.restarts++;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(e.restarts, 5));
    this.log(e, `${why}; restart in ${delay / 1000}s`);
    e.timer = setTimeout(() => {
      e.timer = undefined;
      if (e.wanted) this.launch(e);
    }, delay);
  }

  private launch(e: Entry): void {
    e.fast = 'unknown'; // a rebuilt WDA may have (or lack) the fast route
    e.fastFails = 0;
    e.status = 'starting';
    e.control = 'recovering';
    e.sessionId = undefined;
    e.sessionP = undefined;
    e.mjpegApplied = undefined;
    const spawnLogged = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
      const p = this.spawnFn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      const errTail: string[] = [];
      p.stderr?.on('data', (d: Buffer) => {
        errTail.push(...d.toString().split(/\r?\n/).filter(Boolean));
        if (errTail.length > 5) errTail.splice(0, errTail.length - 5);
      });
      p.on('exit', (code) => {
        if (code && errTail.length) this.log(e, `${cmd} exited with ${code}; last stderr: ${errTail.join(' | ')}`);
      });
      p.stdout?.on('data', () => {});
      p.on('error', (err) => this.log(e, `${cmd} failed to start: ${err.message}`));
      return p;
    };

    // device ports are fixed (8100 / 9100); the Mac-side ports differ per phone. A forward that dies (a usbmuxd
    // hiccup, the phone re-enumerating after a long sleep) is started again by itself: WDA is still fine, and without
    // its forward every request looked like WDA being down (a slow full restart).
    const forward = (slot: 0 | 1, local: number, remote: number): ChildProcess => {
      const p = spawnLogged('iproxy', ['-u', e.udid, `${local}:${remote}`]);
      p.on('exit', (code) => {
        if (!e.wanted || e.procs[slot] !== p) return; // killed on purpose, or superseded
        this.healed(e, `the ${remote === 8100 ? 'WDA' : 'MJPEG'} port forward (iproxy :${local}) exited (${code}); starting it again`);
        setTimeout(() => {
          if (!e.wanted || e.procs[slot] !== p) return;
          if (slot === 0) {
            e.agent.destroy(); // its connections went with it
            e.agent = newAgent();
          }
          e.procs[slot] = forward(slot, local, remote);
        }, 500).unref?.();
      });
      return p;
    };
    const fwdWda = forward(0, e.wdaPort, 8100);
    const fwdMjpeg = forward(1, e.mjpegPort, 9100);
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
    this.log(e, `starting (wda :${e.wdaPort}, mjpeg :${e.mjpegPort})`);

    xcode.on('exit', (code) => {
      if (e.procs[2] !== xcode) return; // superseded
      this.relaunchLater(e, `xcodebuild exited (${code})`);
    });

    // poll WDA /status until it answers, then warm a session
    const waitReady = async () => {
      for (let i = 0; i < 360 && e.wanted && e.procs[2] === xcode; i++) {
        if ((await this.ping(e, 2000)).ok) {
          if (e.procs[2] !== xcode) return;
          e.status = 'ready';
          e.restarts = 0;
          e.lastOk = Date.now();
          this.log(e, 'ready');
          try {
            await this.session(e);
            this.setControl(e, 'ready');
          } catch (err) {
            this.log(e, `could not make a session yet: ${(err as Error).message}`);
          }
          return;
        }
        await sleep(500);
      }
      if (e.wanted && e.procs[2] === xcode) this.relaunchLater(e, 'WDA did not answer within 3 minutes');
    };
    void waitReady();
  }

  // ---- WDA HTTP client ----
  /**
   * One HTTP request to WDA over the entry's keep-alive agent (Nagle off). A request that fails on a reused idle
   * connection the other side had already closed is retried once on a fresh one, so a stale socket never looks
   * like WDA being down (which would trigger a session recovery).
   */
  private async request(e: Entry, method: string, p: string, body: string | undefined, timeout: number): Promise<{ status: number; text: string }> {
    e.busy++;
    try {
      const r = await this.requestOnce(e, method, p, body, timeout, false);
      // any answer at all, whatever it says: WDA is there
      e.lastAnswer = Date.now();
      e.misses = 0;
      return r;
    } finally {
      e.busy--;
    }
  }

  private requestOnce(e: Entry, method: string, p: string, body: string | undefined, timeout: number, retried: boolean): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const headers: Record<string, string | number> = {};
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(body);
      }
      const req = http.request({ host: '127.0.0.1', port: e.wdaPort, path: p, method, agent: e.agent, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', fail);
      });
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeout);
      function fail(err: HttpErr) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stale = req.reusedSocket && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || /socket hang up/i.test(err.message));
        if (stale && !retried) resolve(thisRef.requestOnce(e, method, p, body, timeout, true));
        else reject(err);
      }
      const thisRef = this;
      req.on('error', fail);
      req.on('socket', (s) => s.setNoDelay(true));
      req.end(body);
    });
  }

  private async raw(e: Entry, method: string, p: string, body?: unknown, timeout = 30000): Promise<any> {
    let res: { status: number; text: string; ok?: boolean };
    try {
      res = await this.request(e, method, p, body === undefined ? undefined : JSON.stringify(body), timeout);
    } catch (err) {
      const x = err as HttpErr;
      const why = x.code === 'TIMEOUT' ? `no answer within ${Math.round(timeout / 1000)}s` : `unreachable (${x.code ?? x.message})`;
      const werr = new WdaError('unreachable', why);
      werr.timeout = x.code === 'TIMEOUT';
      throw werr;
    }
    res.ok = res.status >= 200 && res.status < 300;
    const text = res.text;
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    const v = json?.value;
    const werr: unknown = v && typeof v === 'object' ? v.error : undefined;
    const legacy = typeof json?.status === 'number' && json.status !== 0 ? (json.status as number) : 0; // JSONWP status
    if (res.ok && !werr && !legacy) return json;
    const msg = String((v && typeof v === 'object' ? v.message : v) || werr || `HTTP ${res.status}`).split('\n')[0]!.slice(0, 200);
    let kind: Kind;
    if (werr === 'invalid session id' || legacy === 6 || /session .*(does not exist|not found|is not active|terminated)/i.test(msg)) kind = 'session';
    else if (werr === 'unknown command' || werr === 'unknown method' || legacy === 9 || (res.status === 404 && !werr)) kind = 'unknown';
    else if (res.status >= 500 || legacy === 13) kind = 'server';
    else kind = 'rejected';
    throw new WdaError(kind, msg);
  }

  private async ping(e: Entry, timeout: number): Promise<{ ok: boolean; sessionId?: string }> {
    try {
      const r = await this.request(e, 'GET', '/status', undefined, timeout);
      let j: any = {};
      try {
        j = JSON.parse(r.text);
      } catch {
        /* not JSON */
      }
      const sid = j?.sessionId ?? j?.value?.sessionId;
      if (typeof sid === 'string' && sid) e.statusNamesSession = true;
      return { ok: r.status >= 200 && r.status < 300, sessionId: typeof sid === 'string' && sid ? sid : undefined };
    } catch {
      return { ok: false };
    }
  }

  private session(e: Entry): Promise<string> {
    if (e.sessionId) return Promise.resolve(e.sessionId);
    e.sessionP ??= this.createSession(e).finally(() => {
      e.sessionP = undefined;
    });
    return e.sessionP;
  }

  private async createSession(e: Entry): Promise<string> {
    const j = await this.raw(e, 'POST', '/session', { capabilities: { alwaysMatch: CAPS }, desiredCapabilities: CAPS }, 15000);
    const id = j.sessionId ?? j.value?.sessionId;
    if (!id) throw new WdaError('server', 'WDA did not return a session id');
    e.sessionId = id;
    e.lastOk = Date.now();
    await Promise.all([this.readScreen(e, id), this.applySettings(e, id)]);
    return id;
  }

  /**
   * Screen size in points (window size), scale (/wda/screen) and orientation, read with each new session. WDA's
   * window size is the foreground app's, so it's wide when the phone is in landscape at that moment: it's kept as
   * held in portrait, and `screen()` turns it by the orientation, which is asked again as the phone turns
   * (refreshOrientation). Before this the size was kept as it came, for the whole session: a phone that was (or
   * went) landscape had a list size, a clamp and an HID check for the wrong shape.
   */
  private async readScreen(e: Entry, sid: string): Promise<void> {
    const [size, scr, orient] = await Promise.allSettled([
      this.raw(e, 'GET', `/session/${sid}/window/size`, undefined, 5000),
      this.raw(e, 'GET', '/wda/screen', undefined, 5000),
      this.readOrientation(e, sid),
    ]);
    const w = size.status === 'fulfilled' ? Number(size.value?.value?.width) : NaN;
    const h = size.status === 'fulfilled' ? Number(size.value?.value?.height) : NaN;
    const s = scr.status === 'fulfilled' ? Number(scr.value?.value?.scale) : NaN;
    const before = JSON.stringify([e.screen, e.orientation]);
    if (w > 0 && h > 0) e.screen = { ...portraitSize({ width: w, height: h }), scale: s > 0 ? s : e.screen?.scale ?? null };
    else if (s > 0 && e.screen) e.screen.scale = s;
    // WDA without /orientation: the window's shape still says wide or tall
    const shape: Orientation | null = w > 0 && h > 0 ? (w > h ? (isLandscape(e.orientation) ? e.orientation : 'landscape-left') : isLandscape(e.orientation) || !e.orientation ? 'portrait' : e.orientation) : null;
    const o = (orient.status === 'fulfilled' ? orient.value : null) ?? shape;
    if (o) {
      e.orientation = o;
      e.orientAt = Date.now();
    }
    if (JSON.stringify([e.screen, e.orientation]) !== before) this.onOrientation?.(e.udid);
  }

  private async readOrientation(e: Entry, sid: string): Promise<Orientation | null> {
    try {
      return orientationFromWda((await this.raw(e, 'GET', `/session/${sid}/orientation`, undefined, 4000))?.value);
    } catch (err) {
      this.sessionGone(e, sid, err);
      return null;
    }
  }

  /**
   * A quiet session call (orientation, settings) was told its session is gone: make a new one now, in the background
   * (it reads the screen and applies the settings again), rather than leaving it to the next action or health check.
   */
  private sessionGone(e: Entry, sid: string, err: unknown): void {
    if (!(err instanceof WdaError) || err.kind !== 'session' || e.sessionId !== sid || e.recovering || e.status !== 'ready') return;
    if (e.goneAt && Date.now() - e.goneAt < 5000) return; // a WDA that refuses every session: the health check's job
    e.goneAt = Date.now();
    this.healed(e, `the session expired (${err.message}); making a new one`);
    e.sessionId = undefined;
    e.mjpegApplied = undefined;
    void this.session(e).then(
      () => {
        this.setControl(e, 'ready');
      },
      () => {},
    );
  }

  /**
   * After WDA refused a session call (a 4xx that didn't name the session): whether our session is no longer WDA's
   * (the runner restarted on the phone, or something else made a session, which ends ours). Asks /status, whose
   * `sessionId` is the one WDA has now; ours is dropped when it isn't that one.
   */
  private async sessionExpired(e: Entry, sid: string): Promise<boolean> {
    if (e.sessionId !== sid) return true; // dropped meanwhile (the health check, another call)
    const st = await this.ping(e, 2500);
    if (!st.ok || st.sessionId === sid) return false;
    if (!st.sessionId && !e.statusNamesSession) return false; // a WDA whose /status never names a session: can't tell
    if (e.sessionId === sid) {
      e.sessionId = undefined;
      e.mjpegApplied = undefined;
    }
    return true;
  }

  /**
   * How the phone is turned, asked again unless it was within `maxAgeMs` (one ask at a time per phone). Never
   * recovers WDA: an ask that fails keeps what was known.
   */
  refreshOrientation(udid: string, maxAgeMs = 1500): Promise<Orientation | null> {
    const e = this.entries.get(udid);
    if (!e) return Promise.resolve(null);
    if (e.orientP) return e.orientP;
    if (e.status !== 'ready' || !e.sessionId || e.recovering || Date.now() - e.orientAt < maxAgeMs) return Promise.resolve(e.orientation);
    const sid = e.sessionId;
    e.orientP = this.readOrientation(e, sid)
      .then((o) => {
        e.orientAt = Date.now();
        if (o && o !== e.orientation) {
          this.log(e, `orientation ${e.orientation ?? 'unknown'} -> ${o}`);
          e.orientation = o;
          this.onOrientation?.(e.udid);
        }
        return e.orientation;
      })
      .finally(() => {
        e.orientP = undefined;
      });
    return e.orientP;
  }

  private async applySettings(e: Entry, sid: string): Promise<void> {
    const key = JSON.stringify(e.mjpeg);
    const settings = {
      animationCoolOffTimeout: 0,
      waitForIdleTimeout: 0,
      mjpegServerFramerate: e.mjpeg.fps,
      mjpegServerScreenshotQuality: e.mjpeg.quality,
      mjpegScalingFactor: e.mjpeg.scale,
      // WDA's MJPEG frames are the panel's (portrait) unless told to turn them: a landscape phone came out sideways
      mjpegFixOrientation: true,
    };
    try {
      await this.raw(e, 'POST', `/session/${sid}/appium/settings`, { settings }, 5000);
      e.mjpegApplied = key;
    } catch (err) {
      this.log(e, `settings not applied: ${(err as Error).message}`);
      this.sessionGone(e, sid, err); // a new session applies them
    }
  }

  /** Wanted MJPEG settings; applied now if a session exists, else when the next one is made. */
  async setMjpeg(udid: string, s: StreamSettings): Promise<void> {
    const e = this.entries.get(udid);
    if (!e) return;
    e.mjpeg = { ...s };
    if (e.sessionId && e.mjpegApplied !== JSON.stringify(s)) await this.applySettings(e, e.sessionId);
  }

  private async waitReady(e: Entry, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (e.wanted && e.status !== 'ready' && Date.now() < until) await sleep(250);
  }

  private downError(e: Entry, why: string): WdaError {
    const err = new WdaError('unreachable', `WDA session for ${this.nameOf(e.udid)} is down: ${why}`);
    err.named = true;
    return err;
  }

  private named(e: Entry, err: unknown): HttpError {
    if (err instanceof WdaError) {
      if (err.named) return err;
      const name = this.nameOf(e.udid);
      const out = new WdaError(err.kind, err.down ? `WDA session for ${name} is down: ${err.message}` : `WDA refused the request on ${name}: ${err.message}`);
      out.named = true;
      return out;
    }
    if (err instanceof HttpError) return err;
    return this.downError(e, (err as Error)?.message ?? String(err));
  }

  /** The phone's entry once WDA can take a request; waits out a start or a recovery in progress. */
  private async usable(udid: string): Promise<Entry> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted) {
      const err = new WdaError('unreachable', `WDA session for ${this.nameOf(udid)} is down: WebDriverAgent is not running`);
      err.named = true;
      throw err;
    }
    if (e.status === 'failed' && e.timer) {
      // an action while waiting out the restart backoff: try again now
      clearTimeout(e.timer);
      e.timer = undefined;
      this.launch(e);
    }
    if (e.status === 'starting') await this.waitReady(e, 45000);
    if (e.recovering) await e.recovering.catch(() => {});
    if (e.status !== 'ready') throw this.downError(e, `WebDriverAgent is ${e.status === 'starting' ? 'still starting' : e.status}`);
    return e;
  }

  /**
   * Find out what's wrong and fix only that. WDA is asked /status up to three times (one slow answer isn't a dead
   * WDA; a port forward that just exited is back within a second): only a WDA that never answers has its runner
   * restarted. A WDA that answers keeps its session when that still answers too; one that's gone (`sessionGone`: WDA
   * said so itself) is made anew. Shared by concurrent callers.
   */
  private recover(e: Entry, why: string, sessionGone = false): Promise<void> {
    if (e.recovering) return e.recovering;
    const run = (async () => {
      this.setControl(e, 'recovering');
      e.recoveries++;
      e.misses = 0;
      this.healed(e, `recovering: ${why}`);
      let restarted = false;
      const first = this.timeouts.status ?? STATUS_MS;
      let alive = false;
      for (const ms of [first, first * 1.5, first * 1.5]) {
        if (!e.wanted || e.status !== 'ready') break;
        const t0 = Date.now();
        if ((await this.ping(e, ms)).ok) {
          alive = true;
          break;
        }
        // refused at once (nothing listens, or its forward is being started again): a moment before the next ask
        if (Date.now() - t0 < 700) await sleep(Math.min(700, first / 3));
      }
      if (!alive && e.wanted && e.status === 'ready') {
        this.log(e, 'WDA is not answering (/status asked three times); restarting it');
        this.restart(e);
        restarted = true;
      }
      if (e.status !== 'ready') await this.waitReady(e, restarted ? this.timeouts.restart : 45000);
      if (e.status !== 'ready') throw new WdaError('unreachable', `WebDriverAgent did not come back (${e.status})`);
      // WDA answers. Its session is kept when it still answers too; dropped when it's gone, or when it says nothing
      const sid = e.sessionId;
      if (sid && !restarted) {
        let gone = sessionGone;
        if (!gone) {
          try {
            await this.raw(e, 'GET', `/session/${sid}`, undefined, this.timeouts.probe * 2);
          } catch (err) {
            gone = !(err instanceof WdaError) || err.down || err.kind === 'session' || (await this.sessionExpired(e, sid));
          }
        }
        if (gone && e.sessionId === sid) {
          e.sessionId = undefined;
          e.mjpegApplied = undefined;
        }
      }
      try {
        await this.session(e);
      } catch (err) {
        // /status answers but no session can be made (XCTest hung under it): only a fresh runner fixes that
        if (restarted || !(err instanceof WdaError) || !err.down) throw err;
        this.log(e, `no session could be made (${err.message}); restarting WDA`);
        this.restart(e);
        await this.waitReady(e, this.timeouts.restart);
        if (e.status !== 'ready') throw new WdaError('unreachable', `WebDriverAgent did not come back (${e.status})`);
        await this.session(e);
      }
      this.setControl(e, 'ready');
      this.log(e, 'recovered');
    })();
    e.recovering = run
      .catch((err) => {
        this.setControl(e, 'down');
        this.log(e, `recovery failed: ${(err as Error).message}`);
        throw err;
      })
      .finally(() => {
        e.recovering = undefined;
      });
    return e.recovering;
  }

  private async withRecovery<T>(udid: string, fn: (e: Entry) => Promise<T>): Promise<T> {
    const e = await this.usable(udid);
    e.inflight++;
    try {
      return await this.retryOnce(e, fn);
    } finally {
      e.inflight--;
    }
  }

  private async retryOnce<T>(e: Entry, fn: (e: Entry) => Promise<T>): Promise<T> {
    try {
      const r = await fn(e);
      e.lastOk = Date.now();
      return r;
    } catch (err) {
      if (!(err instanceof WdaError) || !err.down) throw this.named(e, err);
      try {
        await this.recover(e, err.message, err.kind === 'session');
      } catch (err2) {
        throw this.named(e, err2 instanceof WdaError ? err2 : err);
      }
      try {
        const r = await fn(e); // retry once
        e.lastOk = Date.now();
        return r;
      } catch (err3) {
        if (err3 instanceof WdaError && err3.down) void this.recover(e, err3.message).catch(() => {});
        throw this.named(e, err3);
      }
    }
  }

  /** Asked for (POST /recover): drop the session, restart the runner if /status fails, make a new warm session. */
  async recoverNow(udid: string): Promise<ControlState> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted) {
      const err = new WdaError('unreachable', `WDA session for ${this.nameOf(udid)} is down: WebDriverAgent is not running`);
      err.named = true;
      throw err;
    }
    if (e.status === 'failed') {
      if (e.timer) clearTimeout(e.timer);
      e.timer = undefined;
      this.launch(e);
    }
    if (e.recovering) await e.recovering.catch(() => {});
    try {
      await this.recover(e, 'requested by the client');
    } catch (err) {
      throw this.named(e, err);
    }
    return this.state(udid);
  }

  /**
   * Call a session-scoped WDA endpoint; on a WDA failure recover (new session / restarted runner) and retry once. A
   * refusal (a 4xx) that doesn't name the session is checked too: when WDA's session is no longer ours, ours expired
   * without WDA saying so in that answer, so a new one is made and the call asked once more.
   */
  call(udid: string, method: string, sub: string, body?: unknown, timeout = 30000): Promise<any> {
    return this.withRecovery(udid, async (e) => {
      const sid = await this.session(e);
      try {
        return await this.raw(e, method, `/session/${sid}${sub}`, body, timeout);
      } catch (err) {
        if (!(err instanceof WdaError) || err.down || !(await this.sessionExpired(e, sid))) throw err;
        this.healed(e, `the session expired (${err.message}); making a new one`);
        const r = await this.raw(e, method, `/session/${await this.session(e)}${sub}`, body, timeout);
        this.setControl(e, 'ready');
        return r;
      }
    });
  }

  /**
   * A quick read for the detail card: null unless WDA is up and not recovering right now; never waits for a start,
   * never recovers, never throws. `session`: a session route (asked only when a session exists).
   */
  async peek(udid: string, p: string, timeout = 2500, session = false): Promise<unknown> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted || e.status !== 'ready' || e.recovering) return null;
    if (session && !e.sessionId) return null;
    if (e.inflight > 0) return null; // WDA is busy with an action: a card's read never piles on top of it
    try {
      return (await this.raw(e, 'GET', session ? `/session/${e.sessionId}${p}` : p, undefined, timeout))?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A best-effort call that never heals (2026-11-16, for the lock): WDA must be ready already, nothing is waited for or
   * recovered, and any failure (a timeout, WDA's own "Timed out while waiting until the screen gets locked") comes back
   * as a plain rejection, so it never marks the session or the phone down.
   */
  async callSoft(udid: string, method: string, p: string, body?: unknown, timeout = 3000): Promise<any> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted || e.status !== 'ready' || e.recovering) throw new WdaError('rejected', `WebDriverAgent on ${this.nameOf(udid)} isn't ready`);
    try {
      return await this.raw(e, method, p, body, timeout);
    } catch (err) {
      if (err instanceof WdaError && err.kind === 'unknown') throw err; // an older WDA: the caller tries the session route
      throw new WdaError('rejected', (err as Error)?.message ?? String(err));
    }
  }

  /**
   * A Home press that never heals (2026-11-16, the wake of a dark phone): the session's pressButton, else the
   * session-less /wda/homescreen. Rejects like callSoft.
   */
  async homeSoft(udid: string, timeout = 4000): Promise<void> {
    const sid = this.entries.get(udid)?.sessionId;
    if (sid) {
      try {
        await this.callSoft(udid, 'POST', `/session/${sid}/wda/pressButton`, { name: 'home' }, timeout);
        return;
      } catch {
        /* the session-less route */
      }
    }
    await this.callSoft(udid, 'POST', '/wda/homescreen', {}, timeout);
  }

  callNoSession(udid: string, method: string, p: string, body?: unknown, timeout = 30000): Promise<any> {
    return this.withRecovery(udid, (e) => this.raw(e, method, p, body, timeout));
  }

  /** A read that never triggers a recovery (a slow /source on a heavy screen must not restart WDA). */
  private async read(udid: string, p: string, timeout: number): Promise<any> {
    const e = await this.usable(udid);
    e.inflight++;
    try {
      const r = await this.raw(e, 'GET', p, undefined, timeout);
      e.lastOk = Date.now();
      return r;
    } catch (err) {
      throw this.named(e, err);
    } finally {
      e.inflight--;
    }
  }

  /**
   * Is the phone's WDA really there? Asks the session itself (GET /session/:id: /status alone answers while the
   * session is long gone or XCTest under it is stuck), within the probe timeout, and heals what it finds: a session
   * that expired is remade, a WDA that doesn't answer is recovered (restarted when /status fails too), a WDA waiting
   * out a restart back-off is started now. True when WDA can take an action afterwards. One probe at a time per
   * phone; never throws. `reason` names who asked (logged with any heal).
   */
  probe(udid: string, reason: string): Promise<boolean> {
    const e = this.entries.get(udid);
    if (!e || !e.wanted) return Promise.resolve(false);
    e.probeP ??= this.probeNow(e, reason)
      .catch(() => false)
      .finally(() => {
        e.probeP = undefined;
      });
    return e.probeP;
  }

  private async probeNow(e: Entry, reason: string): Promise<boolean> {
    if (e.status === 'failed' && e.timer) {
      clearTimeout(e.timer);
      e.timer = undefined;
      this.healed(e, `${reason}: WDA was waiting to restart; starting it now`);
      this.launch(e);
    }
    if (e.status === 'starting') await this.waitReady(e, 45000);
    if (e.recovering) await e.recovering.catch(() => {});
    if (e.status !== 'ready') return false;
    // something is on its way to WDA (a long gesture, a big /source, a screenshot, a lock, a card's read): WDA
    // works one thing at a time, so a probe now would only wait behind it and look like a hang; that request finds
    // out for itself.
    if (e.inflight > 0 || e.busy > 0) return true;
    const sid = e.sessionId;
    try {
      if (!sid) {
        await this.session(e);
      } else {
        e.inflight++;
        try {
          await this.raw(e, 'GET', `/session/${sid}`, undefined, this.timeouts.probe);
        } finally {
          e.inflight--;
        }
      }
      e.lastOk = Date.now();
      this.setControl(e, 'ready');
      return true;
    } catch (err) {
      if (!(err instanceof WdaError)) throw err;
      // no answer in time, once: WDA may only be busy. It counts as down after several in a row (missed())
      if (err.down && !this.missed(e, err)) return true;
      if (!sid) {
        await this.recover(e, `${reason}: no session could be made (${err.message})`);
      } else if (err.kind === 'session' || (!err.down && (await this.sessionExpired(e, sid)))) {
        this.healed(e, `${reason}: the session expired (${err.message}); making a new one`);
        if (e.sessionId === sid) {
          e.sessionId = undefined;
          e.mjpegApplied = undefined;
        }
        try {
          await this.session(e);
        } catch (err2) {
          await this.recover(e, `${reason}: no new session (${(err2 as Error).message})`);
        }
      } else if (!err.down) {
        // this WDA has no GET /session/:id (or refuses it) and the session is still its own: alive
        e.lastOk = Date.now();
        return true;
      } else {
        await this.recover(e, `${reason}: ${err.message}`);
      }
      e.lastOk = Date.now();
      this.setControl(e, 'ready');
      return true;
    }
  }

  /** What's on screen: WDA's accessibility tree as JSON (src/ui.ts flattens it). */
  async source(udid: string): Promise<unknown> {
    return (await this.read(udid, '/source?format=json', 25000))?.value ?? null;
  }

  /** The foreground app's bundle id, or null. */
  async activeApp(udid: string): Promise<string | null> {
    try {
      const v = (await this.read(udid, '/wda/activeAppInfo', 6000))?.value;
      return typeof v?.bundleId === 'string' && v.bundleId ? v.bundleId : null;
    } catch {
      return null;
    }
  }

  /** A hardware button (XCUIDevice's: volumeUp, volumeDown, home). */
  async pressButton(udid: string, name: ButtonName | 'home'): Promise<void> {
    await this.call(udid, 'POST', '/wda/pressButton', { name }, this.timeouts.input);
  }

  /** Whether this phone's WDA has the fast touch route (unknown until the first touch tries it). */
  fastStatus(udid: string): 'yes' | 'no' | 'unknown' {
    return this.entries.get(udid)?.fast ?? 'unknown';
  }

  /**
   * The patched WDA's fast route (docs/BEST_METHOD.md, plan item 1b): one touch path built at absolute coordinates
   * with no active-app lookup, queued on the phone and answered before XCTest plays it (the phone keeps the order).
   * False when this WDA build hasn't got it, or the phone isn't in portrait (the old routes turn the touch themselves;
   * WDA_FAST_LANDSCAPE=1 sends it here too, turned onto the panel as XCTest's portrait event record expects).
   */
  private async fast(udid: string, body: { points: PathPoint[]; hold?: number }): Promise<boolean> {
    const e = this.entries.get(udid);
    if (!e || e.fast === 'no' || process.env.WDA_FAST === '0') return false;
    const turned = !!e.orientation && e.orientation !== 'portrait';
    if (turned && (process.env.WDA_FAST_LANDSCAPE !== '1' || !e.screen)) return false;
    try {
      const up = e.screen ? uprightSize(e.screen, e.orientation) : null;
      const points = body.points.map(([x, y, t]) => {
        if (turned && up && e.screen) {
          const [px, py] = uprightToPanel(x / up.width, y / up.height, e.orientation);
          [x, y] = [px * e.screen.width, py * e.screen.height];
        }
        return [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(t)];
      });
      await this.callNoSession(udid, 'POST', FAST_TOUCH_ROUTE, { ...body, points, orientation: 1 }, Math.min(5000, this.timeouts.input));
      if (e.fast !== 'yes') this.log(e, 'fast touch route answers (patched WDA)');
      e.fast = 'yes';
      e.fastFails = 0;
      return true;
    } catch (err) {
      if (err instanceof WdaError && err.kind === 'unknown') {
        e.fast = 'no';
        this.log(e, 'this WDA build has no fast touch route (rebuild it with scripts/build-wda.sh); using the XCTest route');
        return false;
      }
      if (err instanceof WdaError && !err.down) {
        // the route refused it: this touch goes the old way; after 3 in a row, every touch does until WDA restarts
        if (++e.fastFails >= 3) e.fast = 'no';
        this.log(e, `fast touch route refused a touch (${err.message})${e.fast === 'no' ? '; using the XCTest route from now on' : ''}`);
        return false;
      }
      throw err;
    }
  }

  /** Tap: the fast route, else /wda/tap, else the older /wda/tap/0, else a W3C pointer tap. */
  async tap(udid: string, x: number, y: number, holdMs?: number): Promise<'wda-fast' | 'wda'> {
    const hold = holdMs && holdMs > 0 ? Math.round(holdMs) : undefined;
    if (await this.fast(udid, { points: [[x, y, 0]], hold: hold ?? FAST_TAP_HOLD_MS })) return 'wda-fast';
    const e = this.entries.get(udid);
    const unknown = (err: unknown) => err instanceof WdaError && err.kind === 'unknown';
    if (!e || e.tapRoute === 0) {
      try {
        await this.call(udid, 'POST', '/wda/tap', { x, y }, this.timeouts.input);
        return 'wda';
      } catch (err) {
        if (!unknown(err)) throw err;
        if (e) e.tapRoute = 1;
      }
    }
    if (!e || e.tapRoute <= 1) {
      try {
        await this.call(udid, 'POST', '/wda/tap/0', { x, y }, this.timeouts.input);
        return 'wda';
      } catch (err) {
        if (!unknown(err)) throw err;
        if (e) e.tapRoute = 2;
      }
    }
    await this.w3c(udid, [[x, y, 0], [x, y, hold ?? 50]]);
    return 'wda';
  }

  /** One finger through the points with their real timing: the fast route, else W3C actions. */
  async actions(udid: string, pts: PathPoint[]): Promise<'wda-fast' | 'wda'> {
    if (await this.fast(udid, { points: pts })) return 'wda-fast';
    await this.w3c(udid, pts);
    return 'wda';
  }

  private async w3c(udid: string, pts: PathPoint[]): Promise<void> {
    const ms = pts[pts.length - 1]![2];
    const actions = [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: pointerActions(pts) }];
    await this.call(udid, 'POST', '/actions', { actions }, this.timeouts.input + ms);
  }

  /** Every ~10 s per phone: /status; recover before the owner notices. Skipped right after a successful action. */
  private healthCheck(): void {
    for (const e of this.entries.values()) {
      if (!e.wanted || e.status !== 'ready' || e.recovering || e.checking) continue;
      if (e.sessionId && Date.now() - Math.max(e.lastOk, e.lastAnswer) < HEALTH_MS - 1000) continue; // it answered lately
      if (e.inflight > 0 || e.busy > 0) continue; // busy with something: that request finds out for itself
      e.checking = true;
      if (this.watched?.(e.udid)) {
        // someone is looking at this phone: ask the session itself, not just /status
        void this.probe(e.udid, 'health check').finally(() => {
          e.checking = false;
        });
        continue;
      }
      void (async () => {
        const st = await this.ping(e, 3000);
        if (!st.ok) {
          // once isn't down: several in a row are (a /status that waited behind a slow request answers the next time)
          const quiet = new WdaError('unreachable', '/status did not answer');
          quiet.timeout = true;
          if (this.missed(e, quiet)) await this.recover(e, 'health check: /status did not answer').catch(() => {});
          return;
        }
        e.lastOk = Date.now();
        if (e.sessionId && st.sessionId && st.sessionId !== e.sessionId) {
          this.healed(e, 'health check: the session was replaced on the phone; making a new one');
          e.sessionId = undefined;
        }
        if (!e.sessionId) {
          try {
            await this.session(e);
          } catch (err) {
            await this.recover(e, `health check: ${(err as Error).message}`).catch(() => {});
            return;
          }
        }
        this.setControl(e, 'ready');
      })().finally(() => {
        e.checking = false;
      });
    }
  }

  shutdown(): void {
    clearInterval(this.health);
    for (const e of this.entries.values()) {
      e.wanted = false;
      this.killProcs(e);
    }
  }
}
