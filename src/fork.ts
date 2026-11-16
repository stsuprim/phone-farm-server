import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyBuildError, exclusive } from './resign.js';

/**
 * Our own WebDriverAgent build (wda/ in this repo: appium/WebDriverAgent at a pinned tag with our changes, see
 * wda/LOTUS.md). It answers only requests that carry a per-phone token, has no MJPEG server, listens on a high port
 * of its own per phone, serves only the routes this server uses, plays a whole gesture from one command and can hold
 * a finger down across requests (live touch).
 *
 * This file decides how each phone's WebDriverAgent is launched (stock or ours), keeps the tokens and each phone's
 * state, and installs our build by itself: when the build in the repo is newer than what a phone runs, it is built
 * and signed (the same script, team and certificate as the 6-day re-sign), the phone's runner is switched over, and
 * if ours doesn't start the stock one is put back. Nobody has to be at the Mac.
 */

export type WdaFlavor = 'stock' | 'fork';

/**
 * wda/LOTUS_FORK.json: the version of our changes (FBLotusCommands.inc's LotusForkVersion) and the upstream tag.
 * It also holds two switches that can be thrown from afar, since the Mac pulls this repo by itself: `"enabled":
 * false` puts every phone back on the stock WebDriverAgent at the server's next start (which the pull causes), and
 * `"liveTouch": "off"` stops live touch through our build (drags play whole on "up" again).
 */
export interface ForkMeta {
  version: number;
  upstream: string;
  enabled?: boolean;
  liveTouch?: 'auto' | 'off';
}

export function readForkMeta(root: string): ForkMeta | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'wda', 'LOTUS_FORK.json'), 'utf8'));
    const version = Number(j?.version);
    if (!Number.isInteger(version) || version < 1) return null;
    return {
      version, upstream: typeof j.upstream === 'string' ? j.upstream : 'unknown',
      enabled: j.enabled !== false, liveTouch: j.liveTouch === 'off' ? 'off' : 'auto',
    };
  } catch {
    return null;
  }
}

/** The request header our build reads its token from (wda/WebDriverAgentLib/Routing/FBHTTPServer.m). */
export const TOKEN_HEADER = 'x-lotus-token';
/** The environment variable our build is given its token in (xcodebuild passes TEST_RUNNER_<NAME> on as <NAME>). */
export const TOKEN_ENV = 'LOTUS_WDA_TOKEN';
/** Our build's routes. */
/**
 * The live-touch modes: 1-3 hold a finger down between requests (`/lotus/touch`, a mode each way of asking XCTest);
 * 4 (2026-11-17, `LIVE_SEGMENTED`) plays the drag in short whole gestures as it happens (src/segments.ts), for a phone
 * where none of 1-3 works (iOS 18: XCTest lifts every finger at the end of each record). 0: drags play on release.
 */
export const LIVE_SEGMENTED = 4;
export const LIVE_MODES: Record<number, string> = { 0: 'none', 1: 'hold (plain)', 2: 'hold (persistent state)', 3: 'hold (persistent on every move)', 4: 'segmented' };
/** One mode's result in the phone's self-test. */
export interface LiveModeResult {
  mode: number;
  works: boolean;
  why: string | null;
}

export const FORK_ROUTES = { info: '/lotus/info', gesture: '/lotus/gesture', touch: '/lotus/touch', shot: '/lotus/shot', selftest: '/lotus/selftest' } as const;

/** What our build needs to be launched on one phone. */
export interface ForkLaunch {
  /** The Xcode project folder (wda/ in this repo) and where it was built. */
  project: string;
  derivedData: string;
  /** The port it listens on, on the phone and (forwarded) on the Mac. */
  port: number;
  token: string;
}

/** How one phone's WebDriverAgent is launched: what xcodebuild runs, with which environment, and what is forwarded. */
export interface LaunchPlan {
  flavor: WdaFlavor;
  project: string;
  derivedData: string;
  /** Mac port -> phone port of WebDriverAgent itself. */
  wda: { local: number; device: number };
  /** The MJPEG forward (stock WebDriverAgent only; ours has no MJPEG server). */
  mjpeg: { local: number; device: number } | null;
  /** xcodebuild's extra environment. Our build's holds the token: never log it. */
  env: Record<string, string>;
  args: string[];
}

/** The stock WebDriverAgent's ports on the phone (its defaults). */
export const STOCK_WDA_PORT = 8100;
export const STOCK_MJPEG_PORT = 9100;

/**
 * The launch of one phone's WebDriverAgent. Stock: the project and build of .env, WDA's default ports on the phone
 * (8100, and 9100 for MJPEG) forwarded to this phone's Mac ports. Ours (`fork` given): the project in this repo,
 * its own high port on the phone and on the Mac, the token, and no MJPEG at all (no variable, no forward).
 */
export function launchPlan(
  cfg: { wdaProject: string; wdaDerivedData: string; wdaBasePort: number; mjpegBasePort: number },
  udid: string,
  slot: number,
  fork: ForkLaunch | null,
): LaunchPlan {
  const args = (project: string, derivedData: string) => [
    'test-without-building',
    '-project', path.join(project, 'WebDriverAgent.xcodeproj'),
    '-scheme', 'WebDriverAgentRunner',
    '-destination', `id=${udid}`,
    '-derivedDataPath', derivedData,
  ];
  if (fork) {
    return {
      flavor: 'fork', project: fork.project, derivedData: fork.derivedData,
      wda: { local: fork.port, device: fork.port }, mjpeg: null,
      env: { TEST_RUNNER_USE_PORT: String(fork.port), [`TEST_RUNNER_${TOKEN_ENV}`]: fork.token },
      args: args(fork.project, fork.derivedData),
    };
  }
  return {
    flavor: 'stock', project: cfg.wdaProject, derivedData: cfg.wdaDerivedData,
    wda: { local: cfg.wdaBasePort + slot, device: STOCK_WDA_PORT },
    mjpeg: { local: cfg.mjpegBasePort + slot, device: STOCK_MJPEG_PORT },
    env: { TEST_RUNNER_USE_PORT: String(STOCK_WDA_PORT), TEST_RUNNER_MJPEG_SERVER_PORT: String(STOCK_MJPEG_PORT) },
    args: args(cfg.wdaProject, cfg.wdaDerivedData),
  };
}

/** `WDA_FORK_PORTS=udid=port,udid=port`: a phone's own port, when the default (base + its index) doesn't suit. */
export function parsePorts(v: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (v ?? '').split(/[,\s]+/)) {
    const m = /^([A-Za-z0-9_-]+)[=:](\d+)$/.exec(part.trim());
    const port = m ? Number(m[2]) : NaN;
    if (m && port >= 1024 && port <= 65535) out[m[1]!] = port;
  }
  return out;
}

/** A phone's port for our build: its own from WDA_FORK_PORTS, else base + index (one apart, so no two phones clash). */
export function forkPort(base: number, slot: number, udid: string, own: Record<string, number> = {}): number {
  const p = own[udid];
  if (p !== undefined) return p;
  const port = base + slot;
  return port >= 1024 && port <= 65535 ? port : 28100 + (slot % 1000);
}

/**
 * The tokens, one per phone, made here and kept in the server's data folder (data/wda-tokens.json, readable by this
 * user only; data/ is never in git). A token is only ever handed to xcodebuild's environment and put in the request
 * header: it is never logged and never leaves the Mac.
 */
export class ForkTokens {
  private tokens: Record<string, string> = {};

  constructor(private file?: string) {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && v.length >= 32) this.tokens[k] = v;
    } catch {
      /* first run */
    }
  }

  get(udid: string): string {
    let t = this.tokens[udid];
    if (!t) {
      t = crypto.randomBytes(32).toString('base64url');
      this.tokens[udid] = t;
      this.save();
    }
    return t;
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch (err) {
      console.error(`[wda-fork] could not save the tokens: ${(err as Error).message}`);
    }
  }
}

/**
 * stock = the stock WebDriverAgent runs (ours not installed yet); building = ours is being built and signed (stock
 * still runs); installing = the runner is being switched to ours; fork = ours runs; waiting = the build failed, stock
 * runs, tried again later; rolled-back = ours was installed but didn't start, stock was put back, tried again later.
 */
export type ForkState = 'stock' | 'building' | 'installing' | 'fork' | 'waiting' | 'rolled-back';

/** What the phone's own self-test said of live touch (POST /lotus/selftest). */
export interface LiveTest {
  /** It ran (false: the WebDriverAgent app couldn't come to the front; tried again later). */
  tested: boolean;
  /** The live-touch mode that works on this phone (1-3 a held finger, 4 segmented), 0 when none does. */
  mode: number;
  why: string | null;
  notes?: string[];
  /** Each mode's result (2026-11-17), what it is ('hold', 'segmented') and what started the test. */
  modes?: LiveModeResult[];
  kind?: 'hold' | 'segmented' | null;
  trigger?: 'install' | 'retry' | 'demand';
  at: number;
  tries: number;
}

export interface ForkDevice {
  state: ForkState;
  /** The version of our build on the phone (null: none). */
  version: number | null;
  /** Why it isn't on our build (the last failure), or null. */
  reason: string | null;
  /** Failed tries in a row, and when the next one is due (ms since the epoch). */
  attempts: number;
  nextTryAt: number | null;
  /** When the state last changed. */
  at: number;
  live: LiveTest | null;
}

export interface ForkStatus {
  enabled: boolean;
  /** The version in the repo, and the upstream tag it's built on. */
  version: number | null;
  upstream: string | null;
  /** Why nothing can be installed at all (no team id, not macOS...), or null. */
  problem: string | null;
  perDevice: Record<string, Omit<ForkDevice, 'nextTryAt' | 'at'> & { nextTryAt: string | null; at: string; port: number | null }>;
}

const MIN = 60_000;
/** The waits after the 1st, 2nd... failed try in a row; then every 6 hours. */
export const RETRY_AFTER_MS = [2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN, 60 * MIN, 180 * MIN, 360 * MIN];
/** A self-test that couldn't run (the phone was dark or locked) is tried again this much later, this many times. */
export const LIVE_RETRY_MS = 10 * MIN;
export const LIVE_TRIES = 6;
/** One self-test run tries this many times (woken again before each) before it says so. */
export const SELFTEST_ATTEMPTS = 2;

export function retryAfter(attempts: number): number {
  return RETRY_AFTER_MS[Math.min(Math.max(1, attempts), RETRY_AFTER_MS.length) - 1]!;
}

const fresh = (now: number): ForkDevice => ({ state: 'stock', version: null, reason: null, attempts: 0, nextTryAt: null, at: now, live: null });

export interface ForkOptions {
  /** data/wda-fork.json; none = memory only (tests). */
  file?: string;
  meta: ForkMeta | null;
  /** WDA_FORK in .env (default on). */
  enabled: boolean;
  tokens: ForkTokens;
  /** The project (wda/ in this repo) and its build folder. */
  project: string;
  derivedData: string;
  /** A phone's port for our build. */
  port: (udid: string) => number;
  /** Build and sign our WebDriverAgent for one phone (scripts/build-wda.sh, as the re-sign does). */
  build: (udid: string) => Promise<{ ok: boolean; log: string }>;
  /** Restart the phone's runner as `flavor` and wait until it answers (or say why it didn't). */
  switchTo: (udid: string, flavor: WdaFlavor) => Promise<{ ok: boolean; why?: string }>;
  /** The phone's own live-touch self-test (our build's POST /lotus/selftest). */
  selftest?: (udid: string) => Promise<SelfTestAnswer>;
  /**
   * Whether the phone is awake and unlocked now (2026-11-17: the self-test is only run on a phone that is; WDA's
   * /wda/locked and a look at the screen). null: can't tell (the test goes ahead).
   */
  awake?: (udid: string) => Promise<boolean | null>;
  /** Phones plugged in now. */
  devices: () => Promise<string[]>;
  /** Before a build, an install or a self-test: wake the phone (a locked or dark one can refuse the install). */
  prepare?: (udid: string) => Promise<unknown>;
  /** Our build was signed for the phone just now (the 6-day re-sign counts from here). */
  signed?: (udid: string) => void;
  /** Someone is using the phone now (a viewer, a recent action): a self-test that's only being tried again waits. */
  busy?: (udid: string) => boolean;
  /** Why nothing can be built at all (no team id, not macOS), or null. */
  problem?: () => string | null;
  now?: () => number;
  /** How often the check runs (ms; default 60 s; 0 = never on its own: tests call tick()). */
  tickMs?: number;
  log?: (m: string) => void;
}

/** What the phone's /lotus/selftest answers. */
export interface SelfTestAnswer {
  tested: boolean;
  mode: number;
  why?: string | null;
  notes?: string[];
  modes?: LiveModeResult[];
}

/** A self-test's answer, made sure of: the mode one this server knows, each mode's result kept short. */
export function readSelfTest(r: SelfTestAnswer): { tested: boolean; mode: number; modes: LiveModeResult[] } {
  const mode = r.tested && Number.isInteger(r.mode) && r.mode >= 1 && r.mode <= LIVE_SEGMENTED ? r.mode : 0;
  const modes = (Array.isArray(r.modes) ? r.modes : [])
    .filter((m) => m && Number.isInteger(m.mode) && m.mode >= 1 && m.mode <= LIVE_SEGMENTED)
    .slice(0, 8)
    .map((m) => ({ mode: m.mode, works: m.works === true, why: typeof m.why === 'string' ? m.why.slice(0, 200) : null }));
  return { tested: !!r.tested, mode, modes };
}

/** Keeps each phone's state and installs our build wherever it's missing or older than the repo's. */
export class ForkInstaller {
  private devices: Record<string, ForkDevice> = {};
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private now: () => number;
  private log: (m: string) => void;

  constructor(private o: ForkOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[wda-fork] ${m}`));
    if (o.file) {
      try {
        const j = JSON.parse(fs.readFileSync(o.file, 'utf8'));
        if (j?.perDevice && typeof j.perDevice === 'object') this.devices = j.perDevice;
      } catch {
        /* first run */
      }
    }
    // a build or a switch the last run of the server didn't finish: the phone runs stock, and it's tried again
    for (const d of Object.values(this.devices)) {
      if (d.state === 'building' || d.state === 'installing') {
        d.state = d.version ? 'rolled-back' : 'stock';
        d.reason = 'the server restarted in the middle of the install';
      }
    }
    // turned off (in .env or in wda/LOTUS_FORK.json): every phone starts on the stock WebDriverAgent, and says so
    if (!o.enabled || !o.meta) {
      for (const d of Object.values(this.devices)) {
        if (d.state !== 'stock') Object.assign(d, { state: 'stock', reason: 'our build is turned off: the stock WebDriverAgent runs', attempts: 0, nextTryAt: null, at: this.now() });
      }
    }
    const every = o.tickMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.tick(), every);
      this.timer.unref();
      // soon after the start (the phones are found by then): a new version in the repo is installed right away
      this.first = setTimeout(() => void this.tick(), 20_000);
      this.first.unref();
    }
  }

  private save(): void {
    if (!this.o.file) return;
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      fs.writeFileSync(`${this.o.file}.tmp`, JSON.stringify({ perDevice: this.devices }, null, 2));
      fs.renameSync(`${this.o.file}.tmp`, this.o.file);
    } catch (err) {
      this.log(`could not save the state: ${(err as Error).message}`);
    }
  }

  private device(udid: string): ForkDevice {
    return (this.devices[udid] ??= fresh(this.now()));
  }

  private set(udid: string, patch: Partial<ForkDevice>): ForkDevice {
    const d = this.device(udid);
    if (patch.state && patch.state !== d.state) d.at = this.now();
    Object.assign(d, patch);
    this.save();
    return d;
  }

  /** Why our build can't be installed at all, or null. */
  problem(): string | null {
    if (!this.o.enabled) return 'our WebDriverAgent build is turned off (WDA_FORK=false in .env, or "enabled": false in wda/LOTUS_FORK.json)';
    if (!this.o.meta) return 'wda/LOTUS_FORK.json is missing from this checkout';
    return this.o.problem?.() ?? null;
  }

  /** What our build needs to be launched on `udid` (its token and port). */
  launch(udid: string): ForkLaunch {
    return { project: this.o.project, derivedData: this.o.derivedData, port: this.o.port(udid), token: this.o.tokens.get(udid) };
  }

  /** How the phone's WebDriverAgent starts when the server does: ours when it was installed and ran, else stock. */
  flavorAtStart(udid: string): WdaFlavor {
    return this.o.enabled && this.o.meta && this.devices[udid]?.state === 'fork' ? 'fork' : 'stock';
  }

  /** The working live-touch mode the phone's self-test found (0: none, or not tested yet). */
  liveMode(udid: string): number {
    const l = this.devices[udid]?.live;
    return l?.tested ? l.mode : 0;
  }

  state(udid: string): ForkDevice | null {
    return this.devices[udid] ?? null;
  }

  /**
   * Our build stopped starting on a phone by itself (not during an install): the stock one was put back by the WDA
   * supervisor; noted here, and ours is tried again later.
   */
  failed(udid: string, why: string): void {
    const d = this.device(udid);
    const attempts = d.attempts + 1;
    this.set(udid, { state: 'rolled-back', reason: why.slice(0, 300), attempts, nextTryAt: this.now() + retryAfter(attempts) });
    this.log(`${udid.slice(-8)}: our build stopped starting (${why}); the stock WebDriverAgent is back, next try ${new Date(this.device(udid).nextTryAt!).toISOString()}`);
  }

  /** A phone whose build is missing or older than the repo's, and whose next try is due. */
  due(udid: string): boolean {
    if (this.problem()) return false;
    const d = this.device(udid);
    if (d.state === 'fork' && d.version === this.o.meta!.version) return false;
    return d.nextTryAt === null || this.now() >= d.nextTryAt;
  }

  /** The check: every plugged-in phone that's due gets our build (one at a time); self-tests that couldn't run are tried again. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = exclusive(() => this.run()).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    if (this.problem()) return;
    let ids: string[] = [];
    try {
      ids = await this.o.devices();
    } catch {
      return;
    }
    for (const udid of ids) {
      if (this.due(udid)) await this.install(udid);
      else await this.liveRetry(udid);
    }
  }

  private fail(udid: string, state: 'waiting' | 'rolled-back', reason: string): void {
    const attempts = this.device(udid).attempts + 1;
    const nextTryAt = this.now() + retryAfter(attempts);
    this.set(udid, { state, reason: reason.slice(0, 400), attempts, nextTryAt });
    this.log(`${udid.slice(-8)}: ${state === 'waiting' ? 'not installed' : 'rolled back to the stock WebDriverAgent'}: ${reason} (try ${attempts}; next ${new Date(nextTryAt).toISOString()})`);
  }

  /** Build, sign and install our WebDriverAgent on one phone; the stock one runs until ours answers, and comes back if it doesn't. */
  async install(udid: string): Promise<ForkDevice> {
    const meta = this.o.meta!;
    const tag = udid.slice(-8);
    this.set(udid, { state: 'building', reason: null });
    this.log(`${tag}: building our WebDriverAgent v${meta.version} (${meta.upstream}); the stock one keeps running meanwhile`);
    await this.o.prepare?.(udid).catch(() => {});
    let built: { ok: boolean; log: string };
    try {
      built = await this.o.build(udid);
    } catch (err) {
      built = { ok: false, log: `error: ${(err as Error).message}` };
    }
    if (!built.ok) {
      this.fail(udid, 'waiting', `the build failed: ${classifyBuildError(built.log)}`);
      return this.device(udid);
    }
    this.set(udid, { state: 'installing' });
    this.log(`${tag}: built and signed; switching the phone's runner to it`);
    // a phone that went dark during the build can refuse the install: woken again
    await this.o.prepare?.(udid).catch(() => {});
    let sw: { ok: boolean; why?: string };
    try {
      sw = await this.o.switchTo(udid, 'fork');
    } catch (err) {
      sw = { ok: false, why: (err as Error).message };
    }
    if (!sw.ok) {
      let back: { ok: boolean; why?: string };
      try {
        back = await this.o.switchTo(udid, 'stock');
      } catch (err) {
        back = { ok: false, why: (err as Error).message };
      }
      this.fail(udid, 'rolled-back', `our build did not start (${sw.why ?? 'no answer'})${back.ok ? '' : `; the stock WebDriverAgent did not come back either (${back.why ?? 'no answer'})`}`);
      return this.device(udid);
    }
    this.set(udid, { state: 'fork', version: meta.version, reason: null, attempts: 0, nextTryAt: null, live: null });
    this.log(`${tag}: our WebDriverAgent v${meta.version} is installed and answering`);
    this.o.signed?.(udid);
    await this.liveTest(udid);
    return this.device(udid);
  }

  /**
   * The phone's own self-test of live touch; what it found is kept (and used from then on). 2026-11-17: the phone is
   * woken and unlocked first (the test puts a window of WDA's app over the screen: on a dark or locked phone it saw no
   * touch at all), checked awake, and the test is run once more when it couldn't run or found no mode. Run only
   * right after an install, when one couldn't run (retried later), or on demand (POST /api/wda/:udid/selftest).
   */
  private async liveTest(udid: string, trigger: 'install' | 'retry' | 'demand' = 'install'): Promise<LiveTest> {
    if (!this.o.selftest) return { tested: false, mode: 0, why: 'the self-test is off (WDA_LIVE_TOUCH=off)', at: this.now(), tries: 0 };
    const tries = (trigger === 'demand' ? 0 : this.device(udid).live?.tries ?? 0) + 1;
    let r: SelfTestAnswer = { tested: false, mode: 0, why: 'not run' };
    const notes: string[] = [];
    for (let attempt = 1; attempt <= SELFTEST_ATTEMPTS; attempt++) {
      const ready = await this.wakeForTest(udid);
      if (ready) {
        r = { tested: false, mode: 0, why: ready };
        notes.push(`try ${attempt}: ${ready}`);
        continue;
      }
      try {
        r = await this.o.selftest(udid);
      } catch (err) {
        r = { tested: false, mode: 0, why: (err as Error).message };
      }
      if (r.notes?.length) notes.push(...r.notes.map((n) => `try ${attempt}: ${n}`));
      if (r.tested && readSelfTest(r).mode) break;
    }
    const { tested, mode, modes } = readSelfTest(r);
    const kind = mode >= 1 && mode <= 3 ? 'hold' : mode === LIVE_SEGMENTED ? 'segmented' : null;
    const why = tested
      ? mode
        ? null
        : 'no live-touch mode worked on this phone (not even segmented): drags are played whole'
      : r.why ?? 'the self-test could not run';
    this.set(udid, { live: { tested, mode, why, notes: notes.slice(-8), modes, kind, trigger, at: this.now(), tries } });
    const l = this.device(udid).live!;
    this.log(`${udid.slice(-8)}: live touch self-test (${trigger}): ${l.tested ? (l.mode ? `mode ${l.mode} (${LIVE_MODES[l.mode]}) works` : 'no mode works (drags stay whole gestures)') : `not run (${l.why}); try ${tries} of ${LIVE_TRIES}`}${notes.length ? ` [${notes.join('; ').slice(0, 500)}]` : ''}`);
    return l;
  }

  /** Wakes the phone for its self-test and checks it's awake: null when it is (or can't be told), else why not. */
  private async wakeForTest(udid: string): Promise<string | null> {
    let woke: string | null = null;
    if (this.o.prepare) {
      try {
        await this.o.prepare(udid);
      } catch (err) {
        woke = (err as Error).message;
      }
    }
    const awake = this.o.awake ? await this.o.awake(udid).catch(() => null) : null;
    if (awake === false) return `the phone stayed locked or dark${woke ? ` (${woke})` : ''}`;
    return null;
  }

  /** A self-test now, on demand (POST /api/wda/:udid/selftest): only on a phone running our build. */
  async selftestNow(udid: string): Promise<LiveTest | { tested: false; why: string }> {
    const d = this.devices[udid];
    if (!d || d.state !== 'fork') return { tested: false, why: 'the phone is not running our WebDriverAgent build' };
    if (!this.o.selftest) return { tested: false, why: 'the self-test is off (WDA_LIVE_TOUCH=off)' };
    return this.liveTest(udid, 'demand');
  }

  private async liveRetry(udid: string): Promise<void> {
    const d = this.devices[udid];
    if (!d || d.state !== 'fork' || !this.o.selftest) return;
    const l = d.live;
    if (l && (l.tested || l.tries >= LIVE_TRIES || this.now() - l.at < LIVE_RETRY_MS)) return;
    // the self-test takes the screen for a few seconds and ends on the Home Screen: not under someone's hands
    if (this.o.busy?.(udid)) return;
    await this.liveTest(udid, 'retry');
  }

  status(): ForkStatus {
    const perDevice: ForkStatus['perDevice'] = {};
    for (const [udid, d] of Object.entries(this.devices)) {
      let port: number | null = null;
      try {
        port = this.o.port(udid);
      } catch {
        port = null;
      }
      perDevice[udid] = { ...d, nextTryAt: d.nextTryAt ? new Date(d.nextTryAt).toISOString() : null, at: new Date(d.at).toISOString(), port };
    }
    return { enabled: this.o.enabled, version: this.o.meta?.version ?? null, upstream: this.o.meta?.upstream ?? null, problem: this.problem(), perDevice };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }
}
