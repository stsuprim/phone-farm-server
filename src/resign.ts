import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WebDriverAgent re-sign. A free Apple ID's provisioning profile lasts 7 days; after that WDA won't launch on the
 * phone. This re-runs scripts/build-wda.sh (xcodebuild build-for-testing -allowProvisioningUpdates, which fetches a
 * fresh profile) for each phone 6 days after the last good sign, at a quiet hour when possible, then restarts the
 * phone's WDA runner so the new build is installed. It never runs while someone watches a phone unless expiry is under
 * 12 h, and retries a failure at most every 2 h. The signing time is kept in the config dir (data/wda-sign.json); the
 * real expiry is read from the built runner's embedded.mobileprovision when it's there.
 */

export const DAY_MS = 24 * 3600_000;
export const HOUR_MS = 3600_000;
export const VALID_MS = 7 * DAY_MS; // a free Apple ID's profile
export const RESIGN_AFTER_MS = 6 * DAY_MS;
export const RETRY_MS = 2 * HOUR_MS;
export const URGENT_MS = 12 * HOUR_MS; // under this left: go even during a live session
export const QUIET_WAIT_MS = 18 * HOUR_MS; // past due: wait at most this long for a quiet hour
const SOON_MS = DAY_MS; // under a day left (past the 6-day mark): "soon"

export type SignState = 'ok' | 'soon' | 'expired' | 'resigning' | 'failed';

export interface DeviceSign {
  signedAt: number | null;
  lastError?: string | null;
  lastAttemptAt?: number | null;
}

export interface SignRecord {
  signedAt: number | null; // ms since the epoch
  expiresAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  perDevice: Record<string, DeviceSign>;
}

export interface WdaSignStatus {
  signedAt: string | null; // ISO 8601
  expiresAt: string | null;
  daysLeft: number | null;
  state: SignState;
  lastError?: string;
  nextAttemptAt?: string | null;
  perDevice?: Record<string, { signedAt: string | null; lastError?: string }>;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/** expiresAt: the profile's own expiry when known, else signedAt + 7 days. */
export function expiryOf(r: Pick<SignRecord, 'signedAt' | 'expiresAt'>): number | null {
  return r.expiresAt ?? (r.signedAt ? r.signedAt + VALID_MS : null);
}

/** The state from the record (pure). */
export function signState(r: SignRecord, now: number, resigning: boolean): { state: SignState; daysLeft: number | null; expiresAt: number | null } {
  const expiresAt = expiryOf(r);
  const daysLeft = expiresAt === null ? null : Math.round(((expiresAt - now) / DAY_MS) * 10) / 10;
  if (resigning) return { state: 'resigning', daysLeft, expiresAt };
  const failedSince = r.lastError && r.lastAttemptAt && (!r.signedAt || r.lastAttemptAt > r.signedAt);
  if (expiresAt === null) return { state: failedSince ? 'failed' : 'expired', daysLeft, expiresAt };
  if (now >= expiresAt) return { state: failedSince ? 'failed' : 'expired', daysLeft, expiresAt };
  if (failedSince) return { state: 'failed', daysLeft, expiresAt };
  if (expiresAt - now <= SOON_MS || (r.signedAt !== null && now >= r.signedAt + RESIGN_AFTER_MS)) return { state: 'soon', daysLeft, expiresAt };
  return { state: 'ok', daysLeft, expiresAt };
}

/** Local hour in [start, start + 3): a quiet time for a rebuild (default 03:00-06:00). */
export function isQuietHour(now: number, startHour = 3): boolean {
  const h = new Date(now).getHours();
  return ((h - startHour + 24) % 24) < 3;
}

/**
 * Whether to re-sign now (pure): due 6 days after the last good sign (or now if never), not within 2 h of a failed
 * try, not during a live session unless under 12 h are left, and at a quiet hour unless it's been due 18 h or less
 * than 12 h are left. Returns the reason it waits, or null to go.
 */
export function resignWait(r: SignRecord, now: number, liveViewers: number, quiet: boolean): string | null {
  const expiresAt = expiryOf(r);
  const due = r.signedAt === null ? now : Math.min(r.signedAt + RESIGN_AFTER_MS, (expiresAt ?? Infinity) - DAY_MS);
  if (now < due) return 'not due yet';
  const failed = r.lastError && r.lastAttemptAt && (!r.signedAt || r.lastAttemptAt > r.signedAt);
  if (failed && now - r.lastAttemptAt! < RETRY_MS) return 'waiting 2 h after a failed try';
  const left = expiresAt === null ? -1 : expiresAt - now;
  const urgent = left < URGENT_MS;
  if (liveViewers > 0 && !urgent) return 'a live session is open';
  if (!quiet && !urgent && now - due < QUIET_WAIT_MS && r.signedAt !== null) return 'waiting for a quiet hour';
  return null;
}

/** A readable reason from an xcodebuild log; says so when Xcode's Apple ID isn't signed in. */
export function classifyBuildError(log: string): string {
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const account = lines.find((l) =>
    /no accounts?\b|no account for team|there are no accounts registered|sign in with your apple id|add an account in xcode|session has expired|unable to log in|authentication.*(failed|expired)|requires a development team|no signing certificate .*found|doesn'?t have an account/i.test(l),
  );
  if (account) return `Xcode is not signed in to the Apple ID (Xcode > Settings > Accounts, then build once): ${account.slice(0, 200)}`;
  const devMode = lines.find((l) => /developer mode/i.test(l));
  if (devMode) return `Developer Mode is off on the phone: ${devMode.slice(0, 200)}`;
  const locked = lines.find((l) => /device is locked|passcode|is busy|not paired|trust/i.test(l));
  if (locked) return `the phone needs attention (unlock it / Trust this computer): ${locked.slice(0, 200)}`;
  const limit = lines.find((l) => /maximum number of|exceeded|limit.*app ids?/i.test(l));
  if (limit) return `free Apple ID limit: ${limit.slice(0, 200)}`;
  const err = lines.find((l) => /\berror:/i.test(l));
  return (err ?? lines[lines.length - 1] ?? 'the WDA build failed').slice(0, 300);
}

/** The profile's CreationDate / ExpirationDate from an embedded.mobileprovision (a signed plist; the XML is plain). */
export function provisionDates(buf: Buffer | string): { createdAt: number | null; expiresAt: number | null } {
  const text = typeof buf === 'string' ? buf : buf.toString('latin1');
  const date = (key: string) => {
    const m = new RegExp(`<key>${key}</key>\\s*<date>([^<]+)</date>`).exec(text);
    const t = m ? Date.parse(m[1]!) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  return { createdAt: date('CreationDate'), expiresAt: date('ExpirationDate') };
}

/**
 * One piece of WebDriverAgent work at a time on this Mac: the 6-day re-sign and the install of our own build
 * (src/fork.ts) both build with xcodebuild and restart phones' runners, and must never do so on top of each other.
 */
let wdaWork: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = wdaWork.then(fn, fn);
  wdaWork = p.catch(() => {});
  return p;
}

/**
 * The Apple team a built runner's profile was issued to (its TeamIdentifier), or null. With no WDA_TEAM_ID in .env
 * the team the phones' WebDriverAgent is already signed with is read from here, so nothing has to be typed on the Mac.
 */
export function provisionTeam(buf: Buffer | string): string | null {
  const text = typeof buf === 'string' ? buf : buf.toString('latin1');
  const m = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([A-Z0-9]{6,12})<\/string>/.exec(text);
  return m ? m[1]! : null;
}

/** Runs one phone's build/sign; resolves with the log, rejects with it on failure. */
export type SignRunner = (udid: string) => Promise<{ ok: boolean; log: string }>;

export interface ResignOptions {
  file?: string; // data/wda-sign.json; none = memory only (tests)
  run: SignRunner;
  devices: () => Promise<string[]>; // phones to sign (online)
  liveViewers: () => number;
  /** After a phone's good sign: restart its WDA runner so the fresh build is installed. */
  installed?: (udid: string) => void;
  /** Before a phone's build: wake it (a locked phone can refuse the install). */
  prepare?: (udid: string) => Promise<unknown>;
  /**
   * The built runner's embedded.mobileprovision, read for the real expiry (optional). A function: the files of every
   * build in use now (the stock WebDriverAgent's and our own build's, src/fork.ts); the one that expires first counts.
   */
  provisionFile?: string | (() => string[]);
  now?: () => number;
  tickMs?: number; // default 10 min; 0 = no timer (tests)
  quietStartHour?: number;
  log?: (m: string) => void;
  /** Why it can't run at all (e.g. no team id), shown as lastError. */
  problem?: () => string | null;
}

export class WdaResigner {
  private rec: SignRecord = { signedAt: null, expiresAt: null, lastAttemptAt: null, lastError: null, perDevice: {} };
  private running?: Promise<WdaSignStatus>;
  private timer?: NodeJS.Timeout;
  private now: () => number;
  private log: (m: string) => void;
  private lastWait: string | null = null;

  constructor(private o: ResignOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[wda-sign] ${m}`));
    if (o.file) {
      try {
        this.rec = { ...this.rec, ...JSON.parse(fs.readFileSync(o.file, 'utf8')) };
      } catch {
        /* first run */
      }
    }
    this.readProvision();
    const every = o.tickMs ?? 10 * 60_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.tick(), every);
      this.timer.unref();
      setTimeout(() => void this.tick(), 30_000).unref(); // after the phones are found
    }
  }

  /** A manual build (scripts/build-wda.sh run by hand) counts: the built profile's dates win when newer. */
  private readProvision(): void {
    if (!this.o.provisionFile) return;
    if (typeof this.o.provisionFile === 'function') return this.readProvisions(this.o.provisionFile());
    try {
      const { createdAt, expiresAt } = provisionDates(fs.readFileSync(this.o.provisionFile));
      if (createdAt && expiresAt && (!this.rec.signedAt || createdAt > this.rec.signedAt + 60_000)) {
        this.rec.signedAt = createdAt;
        this.rec.expiresAt = expiresAt;
      } else if (createdAt && expiresAt && this.rec.signedAt && Math.abs(createdAt - this.rec.signedAt) < 2 * HOUR_MS) {
        this.rec.expiresAt = expiresAt;
      }
    } catch {
      /* not built yet */
    }
  }

  /**
   * Several builds in use (some phones on the stock WebDriverAgent, some on our own): the profile that expires first
   * is the one the schedule goes by. A newer one moves the record forward (a build signed since); one clearly older
   * than the record moves it back (a build still in use was signed before the last one recorded).
   */
  private readProvisions(files: string[]): void {
    let first: { createdAt: number; expiresAt: number } | null = null;
    for (const f of files) {
      try {
        const { createdAt, expiresAt } = provisionDates(fs.readFileSync(f));
        if (createdAt && expiresAt && (!first || expiresAt < first.expiresAt)) first = { createdAt, expiresAt };
      } catch {
        /* not built (yet) */
      }
    }
    if (!first) return;
    const signed = this.rec.signedAt;
    if (!signed || first.createdAt > signed + 60_000 || first.createdAt < signed - 2 * HOUR_MS) this.rec.signedAt = first.createdAt;
    this.rec.expiresAt = first.expiresAt;
  }

  /** Look at the built profiles again now (our own build was just signed and installed: src/fork.ts) and keep what they say. */
  refresh(): void {
    this.readProvision();
    this.save();
  }

  private save(): void {
    if (!this.o.file) return;
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      fs.writeFileSync(`${this.o.file}.tmp`, JSON.stringify(this.rec, null, 2));
      fs.renameSync(`${this.o.file}.tmp`, this.o.file);
    } catch (err) {
      this.log(`could not save the sign record: ${(err as Error).message}`);
    }
  }

  get record(): SignRecord {
    return JSON.parse(JSON.stringify(this.rec));
  }

  status(): WdaSignStatus {
    const now = this.now();
    const { state, daysLeft, expiresAt } = signState(this.rec, now, !!this.running);
    const problem = this.o.problem?.() ?? null;
    const lastError = this.rec.lastError ?? problem;
    const perDevice: WdaSignStatus['perDevice'] = {};
    for (const [udid, d] of Object.entries(this.rec.perDevice)) {
      perDevice[udid] = { signedAt: iso(d.signedAt), ...(d.lastError ? { lastError: d.lastError } : {}) };
    }
    const failed = this.rec.lastError && this.rec.lastAttemptAt && (!this.rec.signedAt || this.rec.lastAttemptAt > this.rec.signedAt);
    return {
      signedAt: iso(this.rec.signedAt),
      expiresAt: iso(expiresAt),
      daysLeft,
      state,
      ...(lastError ? { lastError } : {}),
      nextAttemptAt: failed ? iso(this.rec.lastAttemptAt! + RETRY_MS) : this.rec.signedAt ? iso(this.rec.signedAt + RESIGN_AFTER_MS) : null,
      perDevice,
    };
  }

  /** The scheduler's check: re-sign when resignWait says go. */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.readProvision();
    const now = this.now();
    const wait = resignWait(this.rec, now, this.o.liveViewers(), isQuietHour(now, this.o.quietStartHour));
    if (wait) {
      if (wait !== this.lastWait && wait !== 'not due yet') this.log(`re-sign due, ${wait}`);
      this.lastWait = wait;
      return false;
    }
    this.lastWait = null;
    // It may wait here behind the install of our own build (src/fork.ts), which signs afresh: looked at again once
    // its turn comes, so a phone signed a minute ago isn't built and restarted a second time.
    let ran = false;
    await this.resignNow(() => {
      this.readProvision();
      const t = this.now();
      return (ran = resignWait(this.rec, t, this.o.liveViewers(), isQuietHour(t, this.o.quietStartHour)) === null);
    });
    return ran;
  }

  /** Re-sign every online phone now (POST /api/wda/resign); one run at a time. `onlyIf`: asked when its turn comes. */
  resignNow(onlyIf?: () => boolean): Promise<WdaSignStatus> {
    if (this.running) return this.running;
    const p = exclusive(async () => (onlyIf && !onlyIf() ? this.status() : this.doResign())).finally(() => {
      this.running = undefined;
    });
    this.running = p;
    return p;
  }

  /** Starts a re-sign without waiting; returns the status (state "resigning"). */
  start(): WdaSignStatus {
    void this.resignNow().catch(() => {});
    return this.status();
  }

  private async doResign(): Promise<WdaSignStatus> {
    const t = this.now();
    this.rec.lastAttemptAt = t;
    const problem = this.o.problem?.() ?? null;
    if (problem) {
      this.rec.lastError = problem;
      this.save();
      this.log(`cannot re-sign: ${problem}`);
      return this.status();
    }
    let ids: string[] = [];
    try {
      ids = await this.o.devices();
    } catch (err) {
      ids = [];
      this.rec.lastError = `could not list phones: ${(err as Error).message}`;
    }
    if (!ids.length) {
      this.rec.lastError = this.rec.lastError?.startsWith('could not list') ? this.rec.lastError : 'no phone connected to sign for';
      this.save();
      return this.status();
    }
    let good = 0;
    const errors: string[] = [];
    for (const udid of ids) {
      const d = (this.rec.perDevice[udid] ??= { signedAt: null });
      d.lastAttemptAt = this.now();
      this.log(`re-signing WDA for ${udid.slice(-8)}`);
      try {
        await this.o.prepare?.(udid).catch(() => {});
        const r = await this.o.run(udid);
        if (!r.ok) throw new Error(classifyBuildError(r.log));
        d.signedAt = this.now();
        d.lastError = null;
        good++;
        this.o.installed?.(udid);
      } catch (err) {
        d.lastError = (err as Error).message.slice(0, 300);
        errors.push(`${udid.slice(-8)}: ${d.lastError}`);
        this.log(`re-sign failed for ${udid.slice(-8)}: ${d.lastError}`);
      }
    }
    if (good === ids.length) {
      this.rec.signedAt = this.now();
      this.rec.expiresAt = null;
      this.readProvision();
      if (!this.rec.expiresAt || this.rec.expiresAt < this.rec.signedAt) this.rec.expiresAt = this.rec.signedAt + VALID_MS;
      this.rec.lastError = null;
      this.log(`WDA signed for ${good} phone(s); expires ${iso(this.rec.expiresAt)}`);
    } else {
      this.rec.lastError = errors.join('; ').slice(0, 600);
    }
    this.save();
    return this.status();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * The real runner: scripts/build-wda.sh <team> <udid> (its log goes to the derived-data folder too). `env`: more
 * environment for the script, per phone (WDA_BUILD_FLAVOR=fork builds our own WebDriverAgent, wda/ in this repo,
 * with the same team and certificate).
 */
export function buildWdaRunner(root: string, team: () => string, timeoutMs = 20 * 60_000, env: (udid: string) => Record<string, string> = () => ({})): SignRunner {
  return (udid) =>
    new Promise((resolve) => {
      const p = spawn('bash', [path.join(root, 'scripts', 'build-wda.sh'), team(), udid], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WDA_FRESH_PROFILE: '1', ...env(udid) }, // a new 7-day profile, not the one about to expire
      });
      const out: string[] = [];
      const keep = (d: Buffer) => {
        out.push(d.toString());
        if (out.length > 400) out.splice(0, out.length - 400);
      };
      p.stdout.on('data', keep);
      p.stderr.on('data', keep);
      const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
      p.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, log: `could not run build-wda.sh: ${err.message}` });
      });
      p.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, log: out.join('') + (code === null ? '\nerror: the build timed out' : '') });
      });
    });
}
