import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInstalled, withKnown } from './apps.js';
import { AudioFeed, AudioHub, VolumeGuard } from './audio.js';
import { Config } from './config.js';
import { jpegMaybeBlack, pngIsBlack, wakeScreen } from './dark.js';
import { H264Info, H264Source, helperProducer, phoneStats, StartProducer } from './h264.js';
import { basicFacts, mergeBattery, parseActiveApp, parseBatteryDomain, parseDeviceInfo, parseIoreg, parseWdaBattery } from './info.js';
import { PhonecapHost, profileFor } from './lanes.js';
import { FieldState, scrubTyped } from './field.js';
import { HidHost, HidPartial, hidPlayMs, HidTimeout, hidTypable, iosMajor, toHid } from './hid.js';
import type { InputResult } from './inputlog.js';
import { MjpegSource } from './mjpeg.js';
import { imageSize } from './imgsize.js';
import { frameAgrees, Orientation, Size } from './orient.js';
import { still, stillHash, StillSource } from './stills.js';
import { AppInfo, Backend, ButtonName, ControlState, H264Want, HttpError, Image, ImageFormat, InputMethods, PathPoint, PhoneFacts, PhoneInfo, ScreenInfo, StreamSettings } from './types.js';

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
/** 2026-11-18: text through the HID keyboard only when asked (see type()). */
const HID_TYPING = process.env.HID_TYPING === '1';
/** How fast the phone's keyboard types (keys a second; about HID's old pace, readable on the phone's screen). */
const TYPE_KEYS_PER_SECOND = Math.min(60, Math.max(4, Number(process.env.TYPE_KEYS_PER_SECOND) || 15));
/**
 * 2026-11-16: a phone's USB screen capture runs only while a live view of it is open. It starts with the first viewer
 * and stops this long after the last one left (long enough for a page to redraw or a WebRTC session to be made anew,
 * no longer): iOS tells apps while the screen is captured (UIScreen.isCaptured), so it's never kept warm, started
 * ahead or kept for the phone in focus. The live touch session (HID) goes by the same rule.
 */
export const CAPTURE_GRACE_MS = 2500;
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
import { FAST_TAP_HOLD_MS, WdaError, WdaManager } from './wda.js';
import type { WdaFlavor } from './fork.js';

/** Our build's quick still (GET /lotus/shot): the size and quality the stock WDA's MJPEG frames had (percent). */
const FORK_STILL = { scale: 50, quality: 50 };

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

/** The lock's own wait (2026-11-16): short; the state is asked afterwards. */
const LOCK_TIMEOUT_MS = 3000;
/** The screenshot that says whether the screen is dark waits this long at most. */
const DARK_SHOT_MS = 5000;


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
  private seen = new Map<string, number>(); // when each phone was last plugged in (Date.now())
  private playFails = new Map<string, { at: number; error: string }>(); // a queued HID gesture that failed while playing
  private audioHubs = new Map<string, AudioHub>(); // each phone's sound (src/audio.ts)
  private volume: VolumeGuard; // the phone's media volume while its sound is on the Mac
  /** Set by the server: a phone's orientation or upright size changed. */
  onOrientation?: (udid: string) => void;

  constructor(private cfg: Config) {
    this.wda = new WdaManager(cfg, (udid) => this.phones.get(udid)?.name ?? udid);
    this.volume = new VolumeGuard({
      percent: cfg.audio === false ? 0 : cfg.audioPhoneVolume ?? 50,
      press: (udid, dir) => this.wda.pressButton(udid, dir === 'up' ? 'volumeUp' : 'volumeDown'),
      file: path.join(cfg.dataDir, 'audio-volume.json'),
      gapMs: 60,
    });
    // a phone left raised by a crash or a restart goes back to 0 first (tried again while its WDA isn't up yet)
    this.volume.recover();
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
        if (!prev?.online) this.seen.set(udid, Date.now());
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
    return {
      ...phoneStats(srcs, { fps: m?.viewers ? m.meter.rate() : 0, viewers: m?.viewers ?? 0 }, reason, this.buildError()),
      capture_mismatch: this.capture.get(udid)?.mismatch ?? null,
      audio: this.audioStats(udid),
      ...this.wda.healStats(udid),
      wda_link: this.wda.linkHealth(udid),
    };
  }

  /** Whether the phone's USB screen capture runs right now (a live view is open, or closed a moment ago). */
  capturing(udid: string): boolean {
    return !!this.hosts.get(udid)?.running || this.phoneSources(udid).some((s) => s.running);
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
          const sound = this.cfg.audio !== false && helperCaps().includes('audio') ? this.audioHub(udid) : undefined;
          this.hosts.set(udid, (host = new PhonecapHost(HELPER, args, tag, undefined, sound)));
          if (sound?.listeners) host.setAudio(true);
          const fixed = this.rotateMode();
          if (typeof fixed === 'number' && helperCaps().includes('rotate')) host.rotate(fixed);
        }
        start = host.start;
      } else start = helperProducer(HELPER, args, tag);
      const kind = prof.thumb ? 'thumb' : prof.remote ? 'remote' : 'lan';
      // it stops a moment after its last viewer left (CAPTURE_GRACE_MS): never kept warm
      src = new H264Source(lanes ? `${tag} ${kind}` : tag, start, prof.settings, {
        kind, onInfo: (info) => this.captureInfo(udid, info), idleMs: CAPTURE_GRACE_MS,
      });
      this.h264Sources.set(key, src);
    }
    const down = src.unavailable();
    if (down) return down;
    src.setWant(prof.settings);
    return src;
  }

  // ---- the phone's sound (src/audio.ts) ----

  private audioHub(udid: string): AudioHub {
    let hub = this.audioHubs.get(udid);
    if (hub) return hub;
    const tag = udid.slice(-8);
    hub = new AudioHub(tag, {
      enable: (on) => this.hosts.get(udid)?.setAudio(on),
      // the first frame: the sound is on the Mac now, so the phone's volume can go up (it plays nowhere else)
      flowing: () => void this.volume.raise(udid),
      // nobody listens: back to 0 while the capture still holds the sound (held open until it's done); the capture
      // ended: back to 0 at once
      quiet: (ended) => {
        const release = ended ? undefined : this.hosts.get(udid)?.hold();
        void this.volume.lower(udid).finally(() => release?.());
      },
    });
    this.audioHubs.set(udid, hub);
    return hub;
  }

  /** The phone's sound for a WebRTC live view, or why there's none. */
  audio(udid: string): AudioFeed | string {
    this.known(udid);
    if (this.cfg.audio === false) return 'sound is turned off on the server (AUDIO=false)';
    if (this.helperProblem()) return 'no capture helper on the Mac';
    if (!helperCaps().includes('lanes')) return 'the capture helper on the Mac is too old for sound';
    if (!helperCaps().includes('audio')) return "the capture helper on the Mac has no sound yet (it's rebuilt with the next update)";
    return this.audioHub(udid);
  }

  /** The sound's numbers for GET /phones `stats.audio` (null before anyone asked for it). */
  private audioStats(udid: string) {
    const hub = this.audioHubs.get(udid);
    if (!hub) return null;
    const i = hub.info();
    return { ...i, listeners: hub.listeners, volume_raised: this.volume.isRaised(udid) };
  }

  // ---- the detail card (src/info.ts) ----

  /**
   * Battery and charging from lockdown's battery domain, the temperature from the IORegistry's AppleSmartBattery
   * (both through libimobiledevice, so they work while WDA is down), the app in front and iOS's thermal state from
   * WDA when it's up (quick reads that never wait for it or recover it). Whatever doesn't answer is null.
   */
  async facts(udid: string): Promise<PhoneFacts> {
    const p = this.phones.get(udid);
    if (!p) throw new HttpError(404, `unknown phone ${udid}`);
    const basic: PhoneFacts = { ...basicFacts(p), connectedAt: p.online ? this.seen.get(udid) ?? null : null };
    if (!p.online) return basic;
    const quiet = (cmd: string, args: string[], ms: number) => run(cmd, args, ms).catch(() => '');
    const [lockdown, ioreg, app, dev] = await Promise.all([
      quiet('ideviceinfo', ['-u', udid, '-q', 'com.apple.mobile.battery'], 4000),
      quiet('idevicediagnostics', ['-u', udid, 'ioregentry', 'AppleSmartBattery'], 5000),
      this.wda.peek(udid, '/wda/activeAppInfo', 2500),
      this.wda.peek(udid, '/wda/device/info', 2500),
    ]);
    let batt = mergeBattery(parseBatteryDomain(lockdown), parseIoreg(ioreg));
    if (batt.level === null || batt.charging === null) batt = mergeBattery(batt, parseWdaBattery(await this.wda.peek(udid, '/wda/batteryInfo', 2500, true)));
    const d = parseDeviceInfo(dev, Date.now());
    return {
      ...basic,
      battery: { level: batt.level ?? basic.battery.level, charging: batt.charging },
      temperatureC: batt.temperatureC,
      app: parseActiveApp(app, this.appCache.get(udid)?.apps ?? null),
      uptimeSec: d.uptimeSec,
      bootedAt: d.bootedAt,
      thermal: d.thermal,
    };
  }

  playFailure(udid: string, since: number): string | null {
    const f = this.playFails.get(udid);
    return f && f.at >= since ? f.error : null;
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

  /**
   * The phone's stills (src/stills.ts): WDA's own screenshots, never the USB capture's frames. `soft`: the PNG is
   * asked without ever recovering WDA (the server's own looks at the screen).
   */
  private stills(udid: string, soft = false): StillSource {
    return {
      // a stock WDA: a frame of its MJPEG server. Our build has none: its quick JPEG still (GET /lotus/shot), at
      // the size and quality the MJPEG frames had, takes that place; before it's up, the PNG says.
      mjpeg: this.wda.mjpegAvailable(udid)
        ? (maxAgeMs, waitMs) => this.source(udid).grab(maxAgeMs, waitMs)
        : this.wda.forkInfo(udid)
          ? (_maxAgeMs, waitMs) => this.wda.shot(udid, FORK_STILL.scale, FORK_STILL.quality, Math.max(3000, waitMs)).catch(() => null)
          : null,
      png: async (timeoutMs) => {
        const j = soft ? await this.wda.callSoft(udid, 'GET', '/screenshot', undefined, timeoutMs ?? DARK_SHOT_MS) : await this.wda.callNoSession(udid, 'GET', '/screenshot', undefined, timeoutMs);
        if (typeof j?.value !== 'string') throw new HttpError(502, 'WDA gave no screenshot');
        return Buffer.from(j.value, 'base64');
      },
      orientation: () => this.wda.orientation(udid),
    };
  }

  /** One still: WDA's screenshot (JPEG from its MJPEG server when it has one, else its PNG). Never the live capture. */
  async screenshot(udid: string, format: ImageFormat, size?: { maxSide?: number; quality?: number }): Promise<Image> {
    this.known(udid);
    // 2026-11-17: a smaller read on our build: the phone scales its JPEG itself (GET /lotus/shot), so a long side
    // of 800 px at quality 60 comes in a fraction of the PNG's time and bytes
    if (format === 'jpeg' && size?.maxSide && this.wda.forkInfo(udid)) {
      const s = this.wda.screen(udid);
      const long = s ? Math.max(s.width, s.height) * (s.scale || 1) : 0;
      const scale = long > 0 ? Math.min(100, Math.max(10, Math.ceil((size.maxSide / long) * 100))) : FORK_STILL.scale;
      const quality = Math.min(100, Math.max(10, Math.round(size.quality ?? 60)));
      const t0 = performance.now();
      const jpeg = await this.wda.shot(udid, scale, quality, 8000).catch(() => null);
      if (jpeg && frameAgrees(imageSize(jpeg), this.wda.orientation(udid))) {
        if (process.env.INPUT_LOG !== '0') console.log(`[timing] ${udid.slice(-8)} still: ${scale} % at q${quality}, ${jpeg.length} bytes in ${Math.round(performance.now() - t0)} ms`);
        return { data: jpeg, contentType: 'image/jpeg' };
      }
    }
    return still(this.stills(udid), format);
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
      h = new HidHost(udid, {
        python, script: HID_SCRIPT, idleMs: CAPTURE_GRACE_MS, retryMs: HID_RETRY_MS,
        // a path or text answered "queued" that then failed on the phone: the report of that action says so
        onDone: (op, reply) => {
          if (!reply.ok) this.playFails.set(udid, { at: Date.now(), error: `the ${op === 'type' ? 'text' : 'gesture'} broke off on the phone (HID: ${reply.error ?? 'unknown'})` });
        },
      });
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
    // its touch session is a media session on the phone: opened only while a live view holds it (warmInput), never
    // for an agent's tap on a phone nobody watches (WDA takes that)
    if (!h.held) return { why: 'HID live touch opens with a live view (nobody is watching this phone)' };
    h.kick(); // open it for the next one; WDA takes this one
    return { why: `HID is ${h.state}${h.reason ? ` (${h.reason})` : ''}` };
  }

  /**
   * Live touch (a finger held down on the phone from "down" to "up", moved as the moves come) has two ways to the
   * phone: CoreDevice HID (iOS 27+, while a live view holds its session), else our own WebDriverAgent build's
   * /lotus/touch, once the phone's self-test found a way of holding a finger that works there (src/wda.ts liveWhy).
   * A stock WebDriverAgent has neither: the touch is buffered and played whole on "up".
   */
  liveTouchReady(udid: string): boolean {
    if (!this.phones.get(udid)?.online) return false;
    return 'h' in this.hidReady(udid) || this.wda.liveWhy(udid) === null;
  }

  liveTouchWhy(udid: string): string | null {
    const r = this.hidReady(udid);
    if ('h' in r) return null;
    const w = this.wda.liveWhy(udid);
    return w === null ? null : r.why ?? w;
  }

  async liveTouch(udid: string, phase: 'down' | 'move' | 'up', x: number, y: number): Promise<InputResult> {
    this.known(udid);
    const r = this.hidReady(udid);
    if ('h' in r) {
      const [hx, hy] = toHid(x, y, r.s, r.o);
      await r.h.input(phase, { x: hx, y: hy });
      return { via: 'hid' };
    }
    if (this.wda.liveWhy(udid) !== null) throw new HttpError(503, r.why ?? this.wda.liveWhy(udid) ?? 'live touch is not available on this phone');
    await this.wda.liveTouch(udid, phase, x, y);
    return { via: 'wda-live' };
  }

  // ---- our own WebDriverAgent build (src/fork.ts installs it) ----

  /** How each phone's WebDriverAgent starts and what our build needs (set once, before the phones are found). */
  useFork(fork: NonNullable<WdaManager['fork']>): void {
    this.wda.fork = fork;
  }

  /** Restart the phone's runner as the stock WebDriverAgent or our build, waiting until it answers. */
  async switchWda(udid: string, flavor: WdaFlavor): Promise<{ ok: boolean; why?: string }> {
    const r = await this.wda.switchFlavor(udid, flavor);
    if (!r.ok || flavor !== 'fork') return r;
    // ours answers: it must also do the work (a session, the screen's size, a still) before it's kept
    const missing = await this.wda.forkWorks(udid);
    return missing ? { ok: false, why: missing } : r;
  }

  /** The phone's index (its Mac ports are the bases plus it; our build's port on the phone too). */
  wdaSlot(udid: string): number {
    return this.wda.slotOf(udid);
  }

  /** The builds the plugged-in phones run now ("stock", "fork"). */
  wdaFlavors(): WdaFlavor[] {
    return [...new Set([...this.phones.values()].filter((p) => p.online).map((p) => this.wda.flavor(p.udid)))];
  }

  /** Which WebDriverAgent the phone runs, and our build's version when it's ours that answers. */
  wdaBuild(udid: string): { flavor: WdaFlavor; version: number | null } {
    return { flavor: this.wda.flavor(udid), version: this.wda.forkInfo(udid)?.lotus ?? null };
  }

  /** The phone's own live-touch self-test (our build). */
  wdaSelftest(udid: string): ReturnType<WdaManager['selftest']> {
    return this.wda.selftest(udid);
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
      wda: this.wda.forkInfo(udid) ? 'fork' : 'stock',
      wda_live: this.wda.liveWhy(udid) === null ? 'ready' : 'off',
      wda_live_reason: this.wda.liveWhy(udid),
    };
  }

  /**
   * HID if its session is open, else WDA for this one gesture, with the reason (`why`; null on a phone that never
   * has HID). A failed HID input falls back at once, and the session reconnects by itself (src/hid.ts). Not when the
   * outcome isn't known (no answer in time) or it broke off partway (text half typed): doing it again through WDA
   * could tap twice or type the text twice, so that's an error that says to look at the screen first.
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
      const f = hidFailure(what, err);
      if (f instanceof HttpError) {
        console.log(`[hid ${udid.slice(-8)}] ${f.message}`);
        throw f;
      }
      console.log(`[hid ${udid.slice(-8)}] ${what} failed, WDA takes it: ${(err as Error).message}`);
      return { why: f };
    }
  }

  async tap(udid: string, x: number, y: number, holdMs?: number): Promise<InputResult> {
    this.known(udid);
    const hold = typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs > 0 ? Math.min(2000, Math.round(holdMs)) : undefined;
    const fields = hold ? { hold_ms: hold } : {};
    const hid = await this.viaHid(udid, 'tap', ({ h, s, o }) => {
      const [hx, hy] = toHid(x, y, s, o);
      return h.input('tap', { x: hx, y: hy, ...fields });
    });
    // both quick routes answer at the press; the lift follows a moment later
    if ('done' in hid) return { ...hid.done, play_ms: hidPlayMs('tap', fields) };
    const via = await this.wda.tap(udid, x, y, hold);
    const play = via === 'wda-fast' ? { play_ms: hold ?? FAST_TAP_HOLD_MS } : {};
    return hid.why ? { via, reason: hid.why, ...play } : { via, ...play };
  }
  async gesture(udid: string, points: PathPoint[]): Promise<InputResult> {
    this.known(udid);
    const hid = await this.viaHid(udid, 'gesture', ({ h, s, o }) =>
      h.input('path', { points: points.map(([x, y, t]) => [...toHid(x, y, s, o), Math.round(t)]) }),
    );
    // HID and the fast WDA route answer once the gesture is queued; the phone then plays it for its length
    const length = Math.max(0, points[points.length - 1]![2]); // its times count from the gesture's start
    if ('done' in hid) return { ...hid.done, play_ms: length };
    const via = await this.wda.actions(udid, points);
    const play = via === 'wda-fast' ? { play_ms: length } : {};
    return hid.why ? { via, reason: hid.why, ...play } : { via, ...play };
  }
  /**
   * Text goes through the phone's own on-screen keyboard (XCTest, one event record the phone plays at
   * TYPE_KEYS_PER_SECOND), so it can be watched as it's typed. 2026-11-18: no longer through the HID keyboard by
   * default: its every key was a press and a lift sent as two messages down the cable, and a lift that came late (the
   * first key, while the web view made room for the newly attached keyboard) held the key long enough for iOS to repeat
   * it ("aaa" in a password); a HID keyboard also hides the on-screen one. HID_TYPING=1 brings it back.
   */
  async type(udid: string, text: string): Promise<InputResult> {
    this.known(udid);
    let why: string | null = null;
    if (HID_TYPING && hidTypable(text)) {
      // answered when the last key is typed (not when it's queued): what follows finds the whole text there
      const hid = await this.viaHid(udid, 'type', ({ h }) => h.input('type', { text }, { done: true }));
      if ('done' in hid) return hid.done;
      why = hid.why;
    }
    try {
      await this.wda.typeText(udid, text, TYPE_KEYS_PER_SECOND);
    } catch (err) {
      // never the text itself in an answer or a log (XCTest names its record after the first letters)
      const m = scrubTyped((err as Error)?.message ?? String(err), text);
      throw new HttpError(err instanceof HttpError ? err.status : 502, `${m}; it was not typed again: look at the field before trying again`);
    }
    return why ? { via: 'wda', reason: why } : { via: 'wda' };
  }

  /** The focused field: read it, or with `clear` empty it in one go first (WdaManager.field). */
  async field(udid: string, opts: { clear?: boolean } = {}): Promise<FieldState | null> {
    this.known(udid);
    if (opts.clear) return this.wda.field(udid, true);
    try {
      return await this.wda.field(udid, false);
    } catch {
      return null; // a read that fails is "not verified", never a failed action
    }
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

  /** A hash of a still (WDA's own screenshot: identical screens give identical bytes); null without one. Never the live capture. */
  async frameHash(udid: string): Promise<string | null> {
    if (!this.phones.get(udid)?.online || this.wda.status(udid) !== 'ready') return null;
    return stillHash(this.stills(udid, true));
  }
  async home(udid: string): Promise<InputResult> {
    this.known(udid);
    await this.wda.callNoSession(udid, 'POST', '/wda/homescreen', {}, 8000);
    return { via: 'wda' };
  }
  async launch(udid: string, bundleId: string): Promise<InputResult> {
    this.known(udid);
    await this.wda.call(udid, 'POST', '/wda/apps/launch', { bundleId }, 20000);
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

  /**
   * 2026-11-16: a short, soft lock. WDA's /wda/lock can time out ("Timed out while waiting until the screen gets
   * locked") while the screen does go dark: that never marks the WDA session or the phone down (no recovery, no heal);
   * the lock state is asked afterwards instead, and only a phone still unlocked is a failure.
   */
  async lock(udid: string): Promise<void> {
    this.known(udid);
    // already dark: nothing to press (the lock button on a dark phone would turn its screen on)
    if ((await this.dark(udid)) === true) return;
    let why = '';
    try {
      await this.wda.callSoft(udid, 'POST', '/wda/lock', {}, LOCK_TIMEOUT_MS);
      return;
    } catch (err) {
      if (err instanceof WdaError && err.kind === 'unknown') {
        await this.wda.call(udid, 'POST', '/wda/lock', {}, LOCK_TIMEOUT_MS).catch((e2: Error) => (why = e2.message));
        if (!why) return;
      } else why = (err as Error).message;
    }
    const locked = await this.wdaLocked(udid, 2000);
    if (locked === true) return;
    // 2026-11-16: a phone without a passcode never says "locked" (so WDA's lock times out waiting for it) while its
    // screen did go off: a dark screen is a lock that took
    if ((await this.dark(udid)) === true) return;
    throw new Error(`the lock didn't take (${why.slice(0, 120)})`);
  }

  /** WDA's own word on the lock (SpringBoard's lock state: always false on a phone without a passcode); null when it doesn't say. */
  private wdaLocked(udid: string, timeout = 5000): Promise<boolean | null> {
    return this.wda.callSoft(udid, 'GET', '/wda/locked', undefined, timeout).then(
      (j) => (typeof j?.value === 'boolean' ? j.value : null),
      (err) =>
        err instanceof WdaError && err.kind === 'unknown'
          ? this.wda.call(udid, 'GET', '/wda/locked', undefined, timeout).then((j) => (typeof j?.value === 'boolean' ? j.value : null), () => null)
          : null,
    );
  }

  /**
   * Whether the screen is dark (off), from a screenshot (src/dark.ts); null when it can't be told. A frame WDA's MJPEG
   * gives within a moment settles a screen that plainly shows something without the PNG.
   */
  private async dark(udid: string): Promise<boolean | null> {
    if (!this.phones.get(udid)?.online || this.wda.status(udid) !== 'ready') return null;
    const s = this.stills(udid, true);
    try {
      const f = s.mjpeg ? await s.mjpeg(300, 900) : null;
      if (f && jpegMaybeBlack(f) === false) return false;
    } catch {
      /* no MJPEG frame: the screenshot says */
    }
    try {
      return pngIsBlack(await s.png(DARK_SHOT_MS));
    } catch {
      return null;
    }
  }

  /**
   * Wake and unlock. WDA's /wda/unlock gets a locked phone past its lock screen, but does nothing on one that says
   * it isn't locked; 2026-11-16: a phone without a passcode never says so, its screen is just off (after a lock, or
   * iOS's own Auto-Lock), so a dark screen gets what WDA's unlock does: Home (the screen comes on), a moment, Home
   * again (past the lock screen). Never pressed on a screen that shows something (it would leave the app in front).
   */
  async unlock(udid: string): Promise<void> {
    this.known(udid);
    await wakeScreen({
      locked: () => this.wdaLocked(udid),
      // home press + swipe up: past the lock screen when the phone has no passcode
      unlock: () => this.wdaPower(udid, 'POST', '/wda/unlock', 20000),
      dark: () => this.dark(udid),
      home: () => this.wda.homeSoft(udid),
      log: (m) => console.log(`[wake ${udid.slice(-8)}] ${m}`),
    });
  }

  /**
   * Locked, or dark: WDA's word, and the screen itself when WDA says "not locked", since a phone without a passcode
   * says that with its screen off. `quick`: no look at the screen, so only "locked" (true) or can't tell (null).
   * null when it can't tell.
   */
  async isLocked(udid: string, quick = false): Promise<boolean | null> {
    const p = this.phones.get(udid);
    if (!p?.online || this.wda.status(udid) !== 'ready') return null;
    const locked = await this.wdaLocked(udid);
    if (locked === true) return true;
    // "not locked" alone says nothing of the screen: without a look it can't be told
    if (quick) return null;
    const dark = await this.dark(udid);
    return dark === true ? true : locked;
  }

  restartWda(udid: string): void {
    this.wda.restartRunner(udid);
  }

  /** Probe the phone's WDA session and heal what's wrong (src/wda.ts probe); false when WDA can't take input. */
  async heal(udid: string, reason: string): Promise<boolean> {
    if (!this.phones.get(udid)?.online) return false;
    return this.wda.probe(udid, reason);
  }

  setWatched(fn: (udid: string) => boolean): void {
    this.wda.watched = fn;
  }

  /** Stop the phone's capture now, whoever watches it: its viewers are told why. */
  stopCapture(udid: string, why: string): void {
    if (this.phoneSources(udid).length || this.hosts.has(udid)) console.log(`[capture ${udid.slice(-8)}] stopped: ${why}`);
    this.closeH264(udid, why);
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
    if (!this.wda.mjpegAvailable(udid)) throw new HttpError(503, 'this phone runs our own WebDriverAgent build, which has no MJPEG stream (the live view is WebRTC)');
    let set = this.streams.get(udid);
    if (!set) this.streams.set(udid, (set = new Set()));
    const mine = { ...want };
    set.add(mine);
    const eff = this.streamSettings(udid);
    void this.wda.setMjpeg(udid, eff);
    const off = this.source(udid).add(onFrame, true);
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
    this.volume.close();
    this.wda.shutdown();
  }
}

/**
 * What a failed HID input means for its action. A refusal (nothing reached the phone) is a reason: WDA does it
 * instead. No answer in time, or a text or gesture that broke off partway, is an error and WDA does NOT do it again:
 * it may have happened (or half of it has), and a repeat would tap twice or type the text twice.
 */
export function hidFailure(what: string, err: unknown): HttpError | string {
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof HidTimeout) {
    return new HttpError(504, `the phone didn't confirm the ${what} in time (HID: ${message}); it may or may not have happened, so it was not repeated: look at the screen before trying again`);
  }
  if (err instanceof HidPartial) {
    return new HttpError(502, `the ${what} broke off partway on the phone (HID: ${message}); part of it may be there, so it was not repeated: look at the screen before trying again`);
  }
  return `HID ${what} failed (${message})`;
}

/** The first line of a build log that is a real compiler error ("error:"), else its first non-empty line. */
export function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /\berror:/i.test(l)) ?? lines[0] ?? 'unknown build error').slice(0, 300);
}
