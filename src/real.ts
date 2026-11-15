import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInstalled, withKnown } from './apps.js';
import { Config } from './config.js';
import { H264Info, H264Source, helperProducer, phoneStats, StartProducer } from './h264.js';
import { imageSize } from './imgsize.js';
import { PhonecapHost, profileFor } from './lanes.js';
import { HidHost, hidTypable, iosMajor, toHid } from './hid.js';
import type { InputResult } from './inputlog.js';
import { MjpegSource } from './mjpeg.js';
import { frameAgrees, Orientation, Size } from './orient.js';
import { AppInfo, Backend, ButtonName, ControlState, H264Want, HttpError, Image, ImageFormat, InputMethods, PathPoint, PhoneInfo, ScreenInfo, StreamSettings } from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // src/ or dist/ -> project root
// inside a minimal app bundle so macOS gives it its own Camera (TCC) entry (scripts/build-native.mjs)
const HELPER = process.env.PHONECAP_PATH || path.join(ROOT, 'native', 'phonecap', 'build', 'PhoneCap.app', 'Contents', 'MacOS', 'phonecap');
const HELPER_ERROR = path.join(ROOT, 'native', 'phonecap', 'build', 'phonecap.error');
// what the built helper speaks (scripts/build-native.mjs writes it from main.swift's "phonecap-caps:" line)
const HELPER_CAPS = path.join(ROOT, 'native', 'phonecap', 'build', 'phonecap.caps');
// CoreDevice HID live touch (docs/BEST_METHOD.md, plan item 1): one sidecar per phone
const HID_SCRIPT = path.join(ROOT, 'native', 'hid', 'hid_input.py');
// the venv RINOR_TAP_CHECK.md makes; HID_PYTHON wins
const HID_VENV_PYTHON = path.join(os.homedir(), '.phonefarm-hid', 'bin', 'python');
const HID_RETRY_MS = 60000;
/** How long a picture may disagree with the phone's orientation (wide against tall) before the capture starts over. */
const CAPTURE_SETTLE_MS = 1200;
const CAPTURE_RESTARTS = 2;
const APPS_FRESH_MS = 5 * 60_000;

/** What to do about a capture whose picture hasn't got the phone's shape (pure; `rotate` = CAPTURE_ROTATE). */
export function captureFix(frame: Size, o: Orientation | null, s: { rotated: number; tries: number; rotate: 'off' | 'cw' | 'ccw' }): 'ok' | 'unrotate' | 'restart' | 'rotate' | 'give-up' {
  if (frameAgrees(frame, o)) return 'ok';
  if (s.rotated % 180 !== 0) return 'unrotate'; // it's our own quarter turn that disagrees now
  if (s.tries < CAPTURE_RESTARTS) return 'restart'; // a new capture session takes the screen's size as it is now
  return s.rotate === 'off' ? 'give-up' : 'rotate';
}

interface CaptureState {
  size?: Size;
  timer?: NodeJS.Timeout;
  tries: number;
  mismatch: string | null;
}

/** The built helper's capabilities ("lanes": several encoders from one capture); none for an older build. */
function helperCaps(): string[] {
  if (process.env.PHONECAP_LANES === '0') return [];
  try {
    return fs.readFileSync(HELPER_CAPS, 'utf8').split(/[\s,]+/).filter(Boolean);
  } catch {
    return [];
  }
}
import { WdaError, WdaManager } from './wda.js';

function run(cmd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

async function info(udid: string, args: string[]): Promise<string> {
  try {
    return await run('ideviceinfo', ['-u', udid, ...args]);
  } catch {
    return '';
  }
}

export class RealBackend implements Backend {
  readonly mock = false;
  private phones = new Map<string, PhoneInfo>();
  private wda: WdaManager;
  private sources = new Map<string, MjpegSource>();
  private h264Sources = new Map<string, H264Source>(); // "udid" (an older helper) or "udid|lane key"
  private hosts = new Map<string, PhonecapHost>(); // one phonecap process per phone, shared by its lanes
  private streams = new Map<string, Set<StreamSettings>>(); // what each stream subscriber asked for
  private timer: NodeJS.Timeout;
  private polling = false;
  private hid = new Map<string, HidHost>(); // CoreDevice HID live touch, per phone (iOS 27+)
  private capture = new Map<string, CaptureState>(); // each phone's picture shape against its orientation
  private appCache = new Map<string, { at: number; apps: AppInfo[] }>();
  /** Set by the server: a phone's orientation or upright size changed. */
  onOrientation?: (udid: string) => void;

  constructor(private cfg: Config) {
    this.wda = new WdaManager(cfg, (udid) => this.phones.get(udid)?.name ?? udid);
    this.wda.onOrientation = (udid) => {
      const c = this.capture.get(udid);
      if (c) c.tries = 0; // the phone turned: a new chance for the capture to follow
      this.captureCheck(udid);
      this.onOrientation?.(udid);
    };
    void this.poll();
    this.timer = setInterval(() => void this.poll(), cfg.pollMs);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let ids: string[] = [];
      try {
        ids = (await run('idevice_id', ['-l'])).split(/\s+/).filter(Boolean);
      } catch (err) {
        console.error('idevice_id failed (is libimobiledevice installed?):', (err as Error).message);
        return;
      }
      for (const udid of ids) {
        const prev = this.phones.get(udid);
        const [name, model, ios, batt] = await Promise.all([
          prev?.name && prev.name !== udid ? prev.name : info(udid, ['-k', 'DeviceName']),
          prev?.model ? prev.model : info(udid, ['-k', 'ProductType']),
          prev?.ios ? prev.ios : info(udid, ['-k', 'ProductVersion']),
          info(udid, ['-q', 'com.apple.mobile.battery', '-k', 'BatteryCurrentCapacity']),
        ]);
        const paired = !!name; // empty output = not trusted/paired yet
        const b = Number.parseInt(batt, 10);
        this.phones.set(udid, {
          udid, name: name || udid, model, ios,
          battery: Number.isFinite(b) ? b : null, online: true, ready: false,
          control: 'down', scale: null, point_width: null, point_height: null, width: null, height: null,
        });
        if (paired && this.cfg.autostartWda) this.wda.start(udid);
      }
      for (const [udid, p] of this.phones) {
        if (!ids.includes(udid)) {
          p.online = false;
          this.wda.stop(udid);
          this.closeH264(udid, 'phone unplugged');
          this.hid.get(udid)?.close();
          this.hid.delete(udid);
          this.appCache.delete(udid);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async list(): Promise<PhoneInfo[]> {
    return [...this.phones.values()].map((p) => {
      const s = this.wda.screen(p.udid);
      const px = (v: number | undefined) => (s?.scale && v ? Math.round(v * s.scale) : null);
      return {
        ...p,
        ready: p.online && this.wda.status(p.udid) === 'ready',
        control: p.online ? this.wda.state(p.udid) : 'down',
        scale: s?.scale ?? null,
        point_width: s?.width ?? null,
        point_height: s?.height ?? null,
        width: px(s?.width),
        height: px(s?.height),
        orientation: this.wda.orientation(p.udid),
        stats: this.stats(p.udid),
      };
    });
  }

  /** The phone's H.264 sources: one per lane (or the one shared source of an older helper). */
  private phoneSources(udid: string): H264Source[] {
    return [...this.h264Sources].filter(([k]) => k === udid || k.startsWith(`${udid}|`)).map(([, s]) => s);
  }

  private closeH264(udid: string, why: string): void {
    for (const [k, s] of [...this.h264Sources]) {
      if (k === udid || k.startsWith(`${udid}|`)) {
        s.close(why);
        this.h264Sources.delete(k);
      }
    }
    this.hosts.get(udid)?.close();
    this.hosts.delete(udid);
    const c = this.capture.get(udid);
    if (c?.timer) clearTimeout(c.timer);
    this.capture.delete(udid);
  }

  // ---- orientation: the phone's (WDA) against the capture's picture ----

  orientation(udid: string): Orientation | null {
    return this.wda.orientation(udid);
  }

  refreshOrientation(udid: string, maxAgeMs?: number): Promise<Orientation | null> {
    return this.wda.refreshOrientation(udid, maxAgeMs);
  }

  /** CAPTURE_ROTATE: off (default), cw / ccw (turn a sideways picture upright that way), or 90 / 180 / 270 (always). */
  private rotateMode(): 'off' | 'cw' | 'ccw' | number {
    const v = (process.env.CAPTURE_ROTATE ?? 'off').trim().toLowerCase();
    if (v === 'cw' || v === 'ccw') return v;
    return v === '90' || v === '180' || v === '270' ? Number(v) : 'off';
  }

  /** A lane's picture size came or changed: the phone may just have turned, so ask it, then see whether they agree. */
  private captureInfo(udid: string, info: H264Info): void {
    if (!(info.width > 0) || !(info.height > 0)) return;
    let c = this.capture.get(udid);
    if (!c) this.capture.set(udid, (c = { tries: 0, mismatch: null }));
    c.size = { width: info.width, height: info.height };
    void this.wda.refreshOrientation(udid, 0).then(
      () => this.captureCheck(udid),
      () => {},
    );
  }

  /**
   * Every frame goes out upright with the phone's shape. USB screen capture follows the phone as it turns, but a
   * running capture session can keep the size it started with, so a picture that stays wide while the phone is tall
   * (or the other way) for CAPTURE_SETTLE_MS gets a new capture session (twice at most per turn); if that doesn't
   * put it right, CAPTURE_ROTATE says which way to turn it, else stats.capture_mismatch says what's wrong.
   */
  private captureCheck(udid: string): void {
    const c = this.capture.get(udid);
    if (!c?.size) return;
    const host = this.hosts.get(udid);
    const mode = this.rotateMode();
    if (typeof mode === 'number') return; // a fixed turn: the owner's word
    const canTurn = helperCaps().includes('rotate');
    const state = () => ({ rotated: host?.rotated ?? 0, tries: host?.running ? c.tries : CAPTURE_RESTARTS, rotate: canTurn ? mode : ('off' as const) });
    const tag = `[orient ${udid.slice(-8)}]`;
    if (captureFix(c.size, this.wda.orientation(udid), state()) === 'ok') {
      if (c.mismatch) console.log(`${tag} the picture has the phone's shape again`);
      c.mismatch = null;
      return;
    }
    if (c.timer) return;
    c.timer = setTimeout(() => {
      c.timer = undefined;
      void this.wda.refreshOrientation(udid, 0).then(() => {
        if (!c.size || this.capture.get(udid) !== c) return;
        const o = this.wda.orientation(udid);
        const what = `the capture is ${c.size.width}x${c.size.height} but the phone is ${o}`;
        switch (captureFix(c.size, o, state())) {
          case 'ok':
            c.mismatch = null;
            return;
          case 'unrotate':
            console.log(`${tag} ${what}: no longer turning the picture`);
            host?.rotate(0);
            return;
          case 'restart':
            c.tries++;
            console.log(`${tag} ${what}: starting the capture over (${c.tries}/${CAPTURE_RESTARTS})`);
            host?.restart('the picture kept its old shape after the phone turned; starting the capture over');
            return;
          case 'rotate':
            console.log(`${tag} ${what}: turning the picture (CAPTURE_ROTATE=${mode})`);
            host?.rotate(mode === 'ccw' ? 270 : 90);
            return;
          default:
            if (c.mismatch !== what) console.log(`${tag} ${what}, and a new capture didn't change that. If the picture is sideways set CAPTURE_ROTATE=cw (or ccw) in .env`);
            c.mismatch = what;
        }
      });
    }, CAPTURE_SETTLE_MS);
    c.timer.unref?.();
  }

  private stats(udid: string) {
    const m = this.sources.get(udid);
    const srcs = this.phoneSources(udid);
    const reason = this.helperProblem() ?? srcs.map((s) => s.unavailable()).find((r) => r) ?? null;
    return { ...phoneStats(srcs, { fps: m?.viewers ? m.meter.rate() : 0, viewers: m?.viewers ?? 0 }, reason, this.buildError()), capture_mismatch: this.capture.get(udid)?.mismatch ?? null };
  }

  /** The last phonecap build's error while an older helper still runs, else null. */
  private buildError(): string | null {
    if (!fs.existsSync(HELPER) || !fs.existsSync(HELPER_ERROR)) return null;
    try {
      return firstErrorLine(fs.readFileSync(HELPER_ERROR, 'utf8'));
    } catch {
      return null;
    }
  }

  /** The phone's screen, long side in pixels (WDA's points x scale), or null before WDA knows it. */
  private longSide(udid: string): number | null {
    const s = this.wda.screen(udid);
    return s?.scale ? Math.round(Math.max(s.width, s.height) * s.scale) : null;
  }

  /** Why the native H.264 helper can't be used on this Mac, or null. */
  private helperProblem(): string | null {
    if (!this.cfg.h264) return 'H.264 is turned off (H264=false in .env)';
    if (process.platform !== 'darwin') return 'H.264 capture needs macOS';
    if (fs.existsSync(HELPER)) return null;
    try {
      return `the phonecap helper failed to build: ${firstErrorLine(fs.readFileSync(HELPER_ERROR, 'utf8'))}`;
    } catch {
      return 'the phonecap helper is not built (run npm run build on the Mac)';
    }
  }

  /**
   * The H.264 source for a viewer. With a lanes helper: one per lane (a LAN viewer's settings as asked; a far viewer's
   * smaller, 30 fps and following its link), all fed by the phone's one phonecap. With an older helper: one shared
   * source per phone, as before.
   */
  h264(udid: string, want: H264Want): H264Source | string {
    const p = this.known(udid);
    const problem = this.helperProblem();
    if (problem) return problem;
    const lanes = helperCaps().includes('lanes');
    const prof = profileFor(want, this.cfg.h264BitrateMbps * 1_000_000, this.longSide(udid));
    const key = lanes ? `${udid}|${prof.key}` : udid;
    let src = this.h264Sources.get(key);
    if (!src) {
      const online = [...this.phones.values()].filter((x) => x.online).length;
      const args = ['--udid', udid, '--name', p.name];
      if (online === 1) args.push('--any-if-single');
      const tag = udid.slice(-8);
      let start: StartProducer;
      if (lanes) {
        let host = this.hosts.get(udid);
        if (!host) {
          this.hosts.set(udid, (host = new PhonecapHost(HELPER, args, tag)));
          const fixed = this.rotateMode();
          if (typeof fixed === 'number' && helperCaps().includes('rotate')) host.rotate(fixed);
        }
        start = host.start;
      } else start = helperProducer(HELPER, args, tag);
      const kind = prof.thumb ? 'thumb' : prof.remote ? 'remote' : 'lan';
      src = new H264Source(lanes ? `${tag} ${kind}` : tag, start, prof.settings, { kind, onInfo: (info) => this.captureInfo(udid, info) });
      this.h264Sources.set(key, src);
    }
    const down = src.unavailable();
    if (down) return down;
    src.setWant(prof.settings);
    return src;
  }

  screen(udid: string): ScreenInfo | null {
    return this.wda.screen(udid);
  }

  private known(udid: string): PhoneInfo {
    const p = this.phones.get(udid);
    if (!p) throw new HttpError(404, `unknown phone ${udid}`);
    if (!p.online) throw new HttpError(503, 'phone is offline');
    return p;
  }

  private source(udid: string): MjpegSource {
    let s = this.sources.get(udid);
    if (!s) {
      s = new MjpegSource(() => this.wda.mjpegPort(udid));
      this.sources.set(udid, s);
    }
    return s;
  }

  async screenshot(udid: string, format: ImageFormat): Promise<Image> {
    this.known(udid);
    if (format === 'jpeg') {
      // grab one frame from the MJPEG stream
      const jpeg = await new Promise<Buffer>((resolve, reject) => {
        const t = setTimeout(() => { off(); reject(new HttpError(504, 'no MJPEG frame within 5s')); }, 5000);
        const off = this.source(udid).add((f) => { clearTimeout(t); off(); resolve(f); });
      });
      // an older WDA's MJPEG frames stay the panel's (sideways in landscape): its PNG route turns its own
      if (frameAgrees(imageSize(jpeg), this.wda.orientation(udid))) return { data: jpeg, contentType: 'image/jpeg' };
    }
    const j = await this.wda.callNoSession(udid, 'GET', '/screenshot');
    return { data: Buffer.from(String(j.value), 'base64'), contentType: 'image/png' };
  }

  // ---- input (docs/BEST_METHOD.md): CoreDevice HID when the phone's session is open, else WDA (fast route first) ----

  /** Why this phone can't use HID live touch, or null. */
  private hidProblem(udid: string): string | null {
    if (this.cfg.hidInput === 'off') return 'turned off (HID_INPUT=off)';
    if (process.platform !== 'darwin' && this.cfg.hidInput !== 'on') return 'needs macOS';
    const ios = this.phones.get(udid)?.ios;
    if (this.cfg.hidInput === 'auto' && iosMajor(ios) < 27) return `needs iOS 27 or later (this phone runs iOS ${ios || 'unknown'})`;
    if (!fs.existsSync(HID_SCRIPT)) return 'native/hid/hid_input.py is missing';
    return null;
  }

  private hidHost(udid: string): HidHost | null {
    if (this.hidProblem(udid)) return null;
    let h = this.hid.get(udid);
    if (!h) {
      const python = process.env.HID_PYTHON ? this.cfg.hidPython : fs.existsSync(HID_VENV_PYTHON) ? HID_VENV_PYTHON : this.cfg.hidPython;
      h = new HidHost(udid, { python, script: HID_SCRIPT, idleMs: this.cfg.hidIdleSeconds * 1000, retryMs: HID_RETRY_MS });
      this.hid.set(udid, h);
    }
    return h;
  }

  /**
   * The phone's HID session when it can take a touch right now, with the upright screen and the orientation its
   * reports are turned by (HID's axes are the panel's: src/orient.ts); else why not (null: this phone never has
   * HID), after starting to open it for the next one.
   */
  private hidReady(udid: string): { h: HidHost; s: ScreenInfo; o: Orientation | null } | { why: string | null } {
    const h = this.hidHost(udid);
    if (!h) return { why: null };
    const s = this.wda.screen(udid);
    if (!s) return { why: "HID waits for the screen size (WDA has no session yet)" };
    let o = this.wda.orientation(udid);
    if (o && o !== 'portrait') {
      // HID_LANDSCAPE: on (default), off (WDA takes a turned phone), swap (the two landscapes the other way round)
      const mode = (process.env.HID_LANDSCAPE ?? 'on').trim().toLowerCase();
      if (mode === 'off' || mode === '0' || mode === 'false') return { why: `HID is portrait only here (HID_LANDSCAPE=off) and the phone is ${o}` };
      if (mode === 'swap') o = o === 'landscape-left' ? 'landscape-right' : o === 'landscape-right' ? 'landscape-left' : o;
    }
    if (h.ready()) return { h, s, o };
    h.kick(); // open it for the next one; WDA takes this one
    return { why: `HID is ${h.state}${h.reason ? ` (${h.reason})` : ''}` };
  }

  liveTouchReady(udid: string): boolean {
    return !!this.phones.get(udid)?.online && 'h' in this.hidReady(udid);
  }

  liveTouchWhy(udid: string): string | null {
    const r = this.hidReady(udid);
    return 'h' in r ? null : r.why;
  }

  async liveTouch(udid: string, phase: 'down' | 'move' | 'up', x: number, y: number): Promise<InputResult> {
    this.known(udid);
    const r = this.hidReady(udid);
    if (!('h' in r)) throw new HttpError(503, r.why ?? 'live touch is not available on this phone');
    const [hx, hy] = toHid(x, y, r.s, r.o);
    await r.h.input(phase, { x: hx, y: hy });
    return { via: 'hid' };
  }

  warmInput(udid: string): () => void {
    return this.hidHost(udid)?.hold() ?? (() => {});
  }

  inputMethods(udid: string): InputMethods {
    const problem = this.hidProblem(udid);
    const h = this.hid.get(udid);
    return {
      hid: problem ? 'unsupported' : h?.state ?? 'off',
      hid_reason: problem ?? h?.reason ?? null,
      wda_fast: this.wda.fastStatus(udid),
    };
  }

  /**
   * HID if its session is open, else WDA for this one gesture, with the reason (`why`; null on a phone that never
   * has HID). A failed HID input falls back at once, and the session reconnects by itself (src/hid.ts).
   */
  private async viaHid(
    udid: string, what: string, send: (r: { h: HidHost; s: ScreenInfo; o: Orientation | null }) => Promise<unknown>,
  ): Promise<{ done: InputResult } | { why: string | null }> {
    const r = this.hidReady(udid);
    if (!('h' in r)) return r;
    try {
      await send(r);
      return { done: { via: 'hid' } };
    } catch (err) {
      console.log(`[hid ${udid.slice(-8)}] ${what} failed, WDA takes it: ${(err as Error).message}`);
      return { why: `HID ${what} failed (${(err as Error).message})` };
    }
  }

  async tap(udid: string, x: number, y: number): Promise<InputResult> {
    this.known(udid);
    const hid = await this.viaHid(udid, 'tap', ({ h, s, o }) => {
      const [hx, hy] = toHid(x, y, s, o);
      return h.input('tap', { x: hx, y: hy });
    });
    if ('done' in hid) return hid.done;
    const via = await this.wda.tap(udid, x, y);
    return hid.why ? { via, reason: hid.why } : { via };
  }
  async gesture(udid: string, points: PathPoint[]): Promise<InputResult> {
    this.known(udid);
    const hid = await this.viaHid(udid, 'gesture', ({ h, s, o }) =>
      h.input('path', { points: points.map(([x, y, t]) => [...toHid(x, y, s, o), Math.round(t)]) }),
    );
    if ('done' in hid) return hid.done;
    const via = await this.wda.actions(udid, points);
    return hid.why ? { via, reason: hid.why } : { via };
  }
  async type(udid: string, text: string): Promise<InputResult> {
    this.known(udid);
    let why: string | null = null;
    if (hidTypable(text)) {
      const hid = await this.viaHid(udid, 'type', ({ h }) => h.input('type', { text }));
      if ('done' in hid) return hid.done;
      why = hid.why;
    }
    await this.wda.call(udid, 'POST', '/wda/keys', { value: Array.from(text) });
    return why ? { via: 'wda', reason: why } : { via: 'wda' };
  }

  // ---- what an agent needs: the UI tree, the foreground app, the apps, buttons, a frame hash ----

  async uiSource(udid: string): Promise<unknown> {
    this.known(udid);
    return this.wda.source(udid);
  }

  async activeApp(udid: string): Promise<string | null> {
    if (!this.phones.get(udid)?.online) return null;
    return this.wda.activeApp(udid);
  }

  /** The phone's apps from ideviceinstaller (either version's list), kept 5 minutes, plus the well-known ones. */
  async apps(udid: string): Promise<AppInfo[]> {
    this.known(udid);
    const kept = this.appCache.get(udid);
    if (kept && Date.now() - kept.at < APPS_FRESH_MS) return kept.apps;
    let installed: AppInfo[] | null = null;
    for (const args of [['-u', udid, 'list', '--all'], ['-u', udid, '-l', '-o', 'list_all'], ['-u', udid, '-l']]) {
      try {
        const found = parseInstalled(await run('ideviceinstaller', args, 25000));
        if (found.length) {
          installed = found;
          break;
        }
      } catch {
        /* not installed, or this version wants the other form */
      }
    }
    const apps = withKnown(installed);
    // without the phone's list, look again sooner
    this.appCache.set(udid, { at: installed ? Date.now() : Date.now() - APPS_FRESH_MS + 60_000, apps });
    return apps;
  }

  async pressButton(udid: string, name: ButtonName): Promise<InputResult> {
    this.known(udid);
    await this.wda.pressButton(udid, name);
    return { via: 'wda' };
  }

  /** A hash of the newest MJPEG frame (WDA's screenshots: identical screens give identical bytes); null without one. */
  async frameHash(udid: string): Promise<string | null> {
    if (!this.phones.get(udid)?.online || this.wda.status(udid) !== 'ready') return null;
    const f = await this.source(udid).grab(150, 1500);
    return f ? crypto.createHash('sha1').update(f).digest('hex').slice(0, 16) : null;
  }
  async home(udid: string): Promise<InputResult> {
    this.known(udid);
    await this.wda.callNoSession(udid, 'POST', '/wda/homescreen', {});
    return { via: 'wda' };
  }
  async launch(udid: string, bundleId: string): Promise<InputResult> {
    this.known(udid);
    await this.wda.call(udid, 'POST', '/wda/apps/launch', { bundleId });
    return { via: 'wda' };
  }

  // ---- idle lock and wake (src/idle.ts): WDA's session-less routes, the session ones on an older WDA ----

  private async wdaPower(udid: string, method: 'GET' | 'POST', route: string, timeout = 15000): Promise<any> {
    try {
      return await this.wda.callNoSession(udid, method, route, method === 'POST' ? {} : undefined, timeout);
    } catch (err) {
      if (err instanceof WdaError && err.kind === 'unknown') return this.wda.call(udid, method, route, method === 'POST' ? {} : undefined, timeout);
      throw err;
    }
  }

  async lock(udid: string): Promise<void> {
    this.known(udid);
    await this.wdaPower(udid, 'POST', '/wda/lock');
  }

  async unlock(udid: string): Promise<void> {
    this.known(udid);
    // home press + swipe up: past the lock screen when the phone has no passcode
    await this.wdaPower(udid, 'POST', '/wda/unlock', 20000);
  }

  async isLocked(udid: string): Promise<boolean | null> {
    const p = this.phones.get(udid);
    if (!p?.online || this.wda.status(udid) !== 'ready') return null;
    try {
      const j = await this.wdaPower(udid, 'GET', '/wda/locked', 5000);
      return typeof j?.value === 'boolean' ? j.value : null;
    } catch {
      return null;
    }
  }

  restartWda(udid: string): void {
    this.wda.restartRunner(udid);
  }

  async recover(udid: string): Promise<ControlState> {
    this.known(udid);
    return this.wda.recoverNow(udid);
  }

  /** The MJPEG server is one per phone: it runs at the most any current subscriber asked for. */
  private streamSettings(udid: string): StreamSettings {
    const set = this.streams.get(udid);
    const all = set?.size ? [...set] : [];
    const most = (k: keyof StreamSettings) => Math.max(...all.map((s) => s[k]));
    return all.length ? { fps: most('fps'), quality: most('quality'), scale: most('scale') } : { fps: 60, quality: 50, scale: 50 };
  }

  subscribe(udid: string, onFrame: (f: Buffer) => void, want: StreamSettings) {
    this.known(udid);
    if (this.wda.status(udid) !== 'ready') throw new HttpError(503, 'WebDriverAgent is not ready');
    let set = this.streams.get(udid);
    if (!set) this.streams.set(udid, (set = new Set()));
    const mine = { ...want };
    set.add(mine);
    const eff = this.streamSettings(udid);
    void this.wda.setMjpeg(udid, eff);
    const off = this.source(udid).add(onFrame);
    return {
      contentType: 'image/jpeg',
      ...eff,
      unsubscribe: () => {
        off();
        if (set!.delete(mine) && set!.size) void this.wda.setMjpeg(udid, this.streamSettings(udid));
      },
    };
  }

  async close() {
    clearInterval(this.timer);
    for (const s of this.h264Sources.values()) s.close();
    for (const h of this.hosts.values()) h.close();
    for (const h of this.hid.values()) h.close();
    this.wda.shutdown();
  }
}

/** The first line of a build log that is a real compiler error ("error:"), else its first non-empty line. */
export function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /\berror:/i.test(l)) ?? lines[0] ?? 'unknown build error').slice(0, 300);
}
