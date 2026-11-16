import crypto from 'node:crypto';
import { withKnown } from './apps.js';
import { H264Source, phoneStats, RateMeter } from './h264.js';
import { appName } from './info.js';
import { mockProducer } from './h264mock.js';
import { isLandscape, Orientation } from './orient.js';
import { encodePng } from './png.js';
import type { InputResult } from './inputlog.js';
import { AppInfo, Backend, ButtonName, ControlState, H264Want, HttpError, Image, ImageFormat, InputMethods, PathPoint, PhoneFacts, PhoneInfo, ScreenInfo, StreamSettings, WarmState } from './types.js';

const MOCK: InputResult = { via: 'mock' };

export interface MockOptions {
  /** false = no H.264 (clients asking for it get the MJPEG fallback), to test the fallback. Default true. */
  h264?: boolean;
  /** Stop an unused mock H.264 source after this long (default 10 s, like the real one). */
  h264IdleMs?: number;
  /** true = the mock phones take live touch (down/move/up as they come), like CoreDevice HID. Default false. */
  live?: boolean;
  /** The mock capture's first picture comes this long after it starts (a real one takes a second or two). Default 0. */
  h264StartMs?: number;
  /** The mock capture's keyframe interval, seconds (default 2; a far lane's is 10: src/congestion.ts). */
  h264KeySeconds?: number;
  /** A mock phone's gestures and text are answered at once and "play" this long, like HID's queued ones. Default 0. */
  playMs?: number;
}

/** The mock home screen's apps (GET /ui shows them as buttons; tapping one opens it). */
const HOME_APPS: [string, string][] = [
  ['Safari', 'com.apple.mobilesafari'],
  ['Settings', 'com.apple.Preferences'],
  ['Camera', 'com.apple.camera'],
  ['Photos', 'com.apple.mobileslideshow'],
];
const SPRINGBOARD = 'com.apple.springboard';

const PORTRAIT_W = 270; // the mock picture's size in portrait (it's turned with the phone)
const PORTRAIT_H = 585;
const SCREEN_W = 390; // logical points, like a real iPhone
const SCREEN_H = 844;
const PIXEL_SCALE = 3; // reported like an @3x phone
const SCALE = PORTRAIT_W / SCREEN_W;

type RGB = [number, number, number];

// 3x5 digit font (+ colon) for the fake clock/frame counter
const GLYPHS: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
  '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001001001',
  '8': '111101111101111', '9': '111101111001111', ':': '000010000010000',
};

interface Mark { x: number; y: number; x2?: number; y2?: number; at: number }
interface MockPhone {
  info: PhoneInfo;
  hue: number;
  marks: Mark[];
  app: string;
  typed: string;
  frame: number;
  orientation: Orientation;
  /** What reached the phone, in order (tests): "tap x,y", "down x,y", "move x,y", "up x,y", "button volumeUp"... */
  log: string[];
}

function hsv(h: number, s: number, v: number): RGB {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return [f(5), f(3), f(1)];
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export class MockBackend implements Backend {
  readonly mock = true;
  private phones = new Map<string, MockPhone>();
  private battTimer: NodeJS.Timeout;
  private streams = new Set<NodeJS.Timeout>();
  private h264Sources = new Map<string, H264Source>();
  private mjpeg = new Map<string, { viewers: number; meter: RateMeter }>();
  private born = Date.now();
  /** How often each phone's facts were gathered (tests: the ~15 s cache). */
  readonly factsAsked = new Map<string, number>();
  /** Set by the server: a phone's orientation or upright size changed. */
  onOrientation?: (udid: string) => void;

  constructor(count: number, private opts: MockOptions = {}) {
    const models = ['iPhone14,5', 'iPhone13,2', 'iPhone15,2', 'iPhone12,1'];
    for (let i = 0; i < count; i++) {
      const udid = `00008110-MOCK${String(i + 1).padStart(4, '0')}A1B2C3D4`;
      const online = !(i === 3 && count >= 4); // the 4th mock phone is "unplugged"
      this.phones.set(udid, {
        info: {
          udid, name: `Mock iPhone ${i + 1}`, model: models[i % models.length]!, ios: i % 2 ? '17.5.1' : '18.1',
          battery: 90 - i * 7, online, ready: online, control: online ? 'ready' : 'down',
          scale: PIXEL_SCALE, point_width: SCREEN_W, point_height: SCREEN_H,
          width: SCREEN_W * PIXEL_SCALE, height: SCREEN_H * PIXEL_SCALE,
        },
        hue: hash(udid) % 360, marks: [], app: SPRINGBOARD, typed: '', frame: 0, orientation: 'portrait', log: [],
      });
    }
    // slowly drain the batteries so the UI has something moving
    this.battTimer = setInterval(() => {
      for (const p of this.phones.values()) if (p.info.battery! > 5 && Math.random() < 0.3) p.info.battery!--;
    }, 30000);
    this.battTimer.unref();
  }

  private live(udid: string): MockPhone {
    const p = this.phones.get(udid);
    if (!p) throw new HttpError(404, `unknown phone ${udid}`);
    if (!p.info.online) throw new HttpError(503, 'phone is offline');
    return p;
  }

  async list(): Promise<PhoneInfo[]> {
    return [...this.phones.values()].map((p) => {
      const m = this.mjpeg.get(p.info.udid);
      const src = this.h264Sources.get(p.info.udid);
      const reason = this.opts.h264 === false ? 'H.264 is turned off in this mock' : src?.unavailable() ?? null;
      const s = this.screen(p.info.udid)!;
      return {
        ...p.info, point_width: s.width, point_height: s.height, width: s.width * PIXEL_SCALE, height: s.height * PIXEL_SCALE, orientation: p.orientation,
        stats: phoneStats(src, { fps: m?.viewers ? m.meter.rate() : 0, viewers: m?.viewers ?? 0 }, reason),
      };
    });
  }

  orientation(udid: string): Orientation | null {
    return this.phones.get(udid)?.orientation ?? null;
  }
  async refreshOrientation(udid: string): Promise<Orientation | null> {
    return this.orientation(udid);
  }
  /** Turn a mock phone (tests, and trying a client against a landscape phone). */
  setOrientation(udid: string, o: Orientation): void {
    const p = this.live(udid);
    if (p.orientation === o) return;
    p.orientation = o;
    this.onOrientation?.(udid);
  }
  /** What reached a mock phone, in order (tests). */
  inputLog(udid: string): string[] {
    return this.live(udid).log;
  }

  h264(udid: string, want: H264Want): H264Source | string {
    const p = this.live(udid);
    if (this.opts.h264 === false) return 'H.264 is turned off in this mock';
    let src = this.h264Sources.get(udid);
    if (!src) {
      const make = mockProducer(() => p);
      const slow = this.opts.h264StartMs ?? 0;
      // a capture that takes a moment to give its first picture, like the real helper's start
      const start: typeof make = !slow
        ? make
        : (w, hooks) => {
            let inner: ReturnType<typeof make> | undefined;
            let stopped = false;
            const t = setTimeout(() => {
              if (!stopped) inner = make(w, hooks);
            }, slow);
            return {
              key: () => inner?.key(),
              stop: () => {
                stopped = true;
                clearTimeout(t);
                inner?.stop();
              },
            };
          };
      src = new H264Source(udid.slice(0, 12), start, { fps: want.fps, scale: want.scale, bitrate: 0, keySeconds: this.opts.h264KeySeconds }, {
        idleMs: this.opts.h264IdleMs ?? 10_000,
        log: () => {},
      });
      this.h264Sources.set(udid, src);
    }
    return src;
  }

  /** Start the mock capture ahead of a viewer (it stops after the idle time unless one comes). */
  warm(udid: string): WarmState {
    const src = this.h264(udid, { fps: 60, scale: 100, quality: null });
    if (typeof src === 'string') return { capture: 'unavailable', reason: src };
    const was = src.ready;
    src.warm();
    return { capture: was ? 'warm' : 'starting' };
  }

  /** The detail card's facts of a mock phone (the 2nd one doesn't say its temperature or uptime: nulls). */
  async facts(udid: string): Promise<PhoneFacts> {
    const p = this.phones.get(udid);
    if (!p) throw new HttpError(404, `unknown phone ${udid}`);
    this.factsAsked.set(udid, (this.factsAsked.get(udid) ?? 0) + 1);
    const i = [...this.phones.keys()].indexOf(udid);
    const quiet = i === 1;
    const bootedAt = quiet ? null : this.born - (i + 1) * 3_600_000;
    return {
      battery: { level: p.info.battery === null ? null : Math.round(p.info.battery) / 100, charging: p.info.online ? i % 2 === 0 : null },
      temperatureC: quiet || !p.info.online ? null : 29.5 + i,
      app: p.info.online ? { bundleId: p.app, name: appName(p.app, HOME_APPS.map(([name, bundleId]) => ({ name, bundleId, installed: true }))) } : { bundleId: null, name: null },
      uptimeSec: bootedAt === null ? null : Math.round((Date.now() - bootedAt) / 1000),
      model: p.info.model,
      ios: p.info.ios,
      bootedAt,
      thermal: p.info.online && !quiet ? 'nominal' : null,
      connectedAt: p.info.online ? this.born : null,
    };
  }

  screen(udid: string): ScreenInfo | null {
    const p = this.phones.get(udid);
    if (!p) return null;
    return isLandscape(p.orientation) ? { width: SCREEN_H, height: SCREEN_W, scale: PIXEL_SCALE } : { width: SCREEN_W, height: SCREEN_H, scale: PIXEL_SCALE };
  }

  /** The mock screen as WDA's /source would give it (upright points): a few things to read, tap and type into. */
  private tree(p: MockPhone): Record<string, unknown> {
    const s = this.screen(p.info.udid)!;
    const node = (type: string, label: string | null, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({
      type, label, name: label, value: null, rect: { x, y, width: w, height: h }, isEnabled: '1', isVisible: '1', children: [] as unknown[], ...extra,
    });
    const kids: unknown[] = [node('StaticText', p.info.name, 16, 50, s.width - 32, 24)];
    if (p.app === SPRINGBOARD) {
      const cell = (s.width - 32) / HOME_APPS.length;
      HOME_APPS.forEach(([name], i) => kids.push(node('Icon', name, 16 + i * cell, 120, cell - 8, 70)));
      kids.push(node('Button', 'Hidden', 16, 300, 80, 30, { isVisible: '0' }));
    } else {
      const name = HOME_APPS.find(([, id]) => id === p.app)?.[0] ?? p.app;
      const bar = node('NavigationBar', name, 0, 80, s.width, 44);
      bar.children.push(node('Button', 'Back', 8, 84, 70, 36), node('StaticText', name, s.width / 2 - 60, 88, 120, 28));
      kids.push(bar, node('TextField', 'Search', 16, 140, s.width - 32, 40, { value: p.typed || null }), node('Switch', 'Wi-Fi', s.width - 80, 200, 60, 32, { value: '1' }));
    }
    const win = node('Window', null, 0, 0, s.width, s.height);
    win.children = kids;
    const app = node('Application', p.app === SPRINGBOARD ? 'SpringBoard' : p.app, 0, 0, s.width, s.height);
    app.children = [win];
    return app;
  }

  /** A tap on the mock screen does what the thing under it does: an icon opens its app, Back goes home. */
  private hit(p: MockPhone, x: number, y: number): void {
    const s = this.screen(p.info.udid)!;
    if (p.app === SPRINGBOARD) {
      const cell = (s.width - 32) / HOME_APPS.length;
      const i = Math.floor((x - 16) / cell);
      if (y >= 120 && y <= 190 && i >= 0 && i < HOME_APPS.length && x - 16 - i * cell <= cell - 8) p.app = HOME_APPS[i]![1];
    } else if (x >= 8 && x <= 78 && y >= 84 && y <= 120) p.app = SPRINGBOARD;
  }

  async uiSource(udid: string): Promise<unknown> {
    return this.tree(this.live(udid));
  }
  async activeApp(udid: string): Promise<string | null> {
    return this.phones.get(udid)?.app ?? null;
  }
  async apps(udid: string): Promise<AppInfo[]> {
    this.live(udid);
    return withKnown(HOME_APPS.map(([name, bundleId]) => ({ name, bundleId, installed: true })));
  }
  async pressButton(udid: string, name: ButtonName): Promise<InputResult> {
    this.live(udid).log.push(`button ${name}`);
    return MOCK;
  }
  /** Changes when the mock screen does (the app, the typed text, the orientation, the lock). */
  async frameHash(udid: string): Promise<string | null> {
    const p = this.phones.get(udid);
    if (!p?.info.online) return null;
    return crypto.createHash('sha1').update(JSON.stringify([p.app, p.typed, p.orientation, this.lockedSet.has(udid)])).digest('hex').slice(0, 16);
  }

  liveTouchReady(udid: string): boolean {
    return !!this.opts.live && !!this.phones.get(udid)?.info.online;
  }
  async liveTouch(udid: string, phase: 'down' | 'move' | 'up', x: number, y: number): Promise<InputResult> {
    const p = this.live(udid);
    p.log.push(`${phase} ${Math.round(x)},${Math.round(y)}`);
    if (phase !== 'move') p.marks.push({ x, y, at: Date.now() });
    return { via: 'hid' };
  }

  private render(p: MockPhone): Buffer {
    // the picture is upright: wide when the mock phone is in landscape
    const wide = isLandscape(p.orientation);
    const W = wide ? PORTRAIT_H : PORTRAIT_W;
    const H = wide ? PORTRAIT_W : PORTRAIT_H;
    const px = new Uint8Array(W * H * 3);
    const c0 = hsv(p.hue, 0.55, 0.95);
    const c1 = hsv((p.hue + 40) % 360, 0.7, 0.45);
    for (let y = 0; y < H; y++) {
      const t = y / H;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        px[i] = c0[0] + (c1[0] - c0[0]) * t;
        px[i + 1] = c0[1] + (c1[1] - c0[1]) * t;
        px[i + 2] = c0[2] + (c1[2] - c0[2]) * t;
      }
    }
    const rect = (x: number, y: number, w: number, h: number, c: RGB) => {
      for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++)
        for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
          const i = (yy * W + xx) * 3;
          px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
        }
    };
    const text = (s: string, x: number, y: number, sc: number, c: RGB) => {
      for (const ch of s) {
        const g = GLYPHS[ch];
        if (g) for (let k = 0; k < 15; k++) if (g[k] === '1') rect(x + (k % 3) * sc, y + Math.floor(k / 3) * sc, sc, sc, c);
        x += 4 * sc;
      }
    };
    const ring = (cx: number, cy: number, rad: number, c: RGB) => {
      for (let a = 0; a < 360; a += 3)
        rect(Math.round(cx + Math.cos((a * Math.PI) / 180) * rad), Math.round(cy + Math.sin((a * Math.PI) / 180) * rad), 3, 3, c);
    };
    const white: RGB = [255, 255, 255];
    rect(0, 0, W, 28, [20, 20, 24]);
    const d = new Date();
    text(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, 10, 8, 3, white);
    text(`${p.info.battery}`, W - 50, 8, 3, white);
    rect(W / 2 - 50, 200, 100, 100, hsv(hash(p.app) % 360, 0.8, 0.9)); // "app" tile coloured by bundle id
    text(String(p.frame % 10000), 10, H - 30, 3, white); // frame counter + moving block so streams visibly move
    rect(20 + ((p.frame * 6) % (W - 60)), H - 70, 30, 20, white);
    const now = Date.now();
    p.marks = p.marks.filter((m) => now - m.at < 1500);
    for (const m of p.marks) {
      ring(m.x * SCALE, m.y * SCALE, 14 + (now - m.at) / 60, [255, 40, 40]);
      if (m.x2 !== undefined && m.y2 !== undefined) {
        for (let s = 0; s <= 20; s++)
          rect(Math.round((m.x + ((m.x2 - m.x) * s) / 20) * SCALE), Math.round((m.y + ((m.y2 - m.y) * s) / 20) * SCALE), 4, 4, [255, 255, 0]);
      }
    }
    p.frame++;
    return encodePng(W, H, px);
  }

  async screenshot(udid: string, _format: ImageFormat): Promise<Image> {
    return { data: this.render(this.live(udid)), contentType: 'image/png' }; // mock always serves PNG
  }
  async tap(udid: string, x: number, y: number, holdMs?: number): Promise<InputResult> {
    const p = this.live(udid);
    p.marks.push({ x, y, at: Date.now() });
    p.log.push(`tap ${Math.round(x)},${Math.round(y)}${holdMs ? ` hold ${Math.round(holdMs)}` : ''}`);
    this.hit(p, x, y);
    return MOCK;
  }
  async gesture(udid: string, points: PathPoint[]): Promise<InputResult> {
    const p = this.live(udid);
    const a = points[0]!;
    const b = points[points.length - 1]!;
    p.marks.push({ x: a[0], y: a[1], x2: b[0], y2: b[1], at: Date.now() });
    p.log.push(`gesture ${points.length}`);
    return this.opts.playMs ? { ...MOCK, play_ms: this.opts.playMs } : MOCK;
  }
  async type(udid: string, text: string): Promise<InputResult> {
    const p = this.live(udid);
    for (const ch of text) p.typed = ch === '\b' ? p.typed.slice(0, -1) : (p.typed + ch).slice(-200);
    p.log.push(`type ${JSON.stringify(text)}`);
    return MOCK;
  }
  async home(udid: string): Promise<InputResult> {
    const p = this.live(udid);
    p.app = SPRINGBOARD;
    p.log.push('home');
    return MOCK;
  }
  async launch(udid: string, bundleId: string): Promise<InputResult> {
    const p = this.live(udid);
    p.app = bundleId;
    p.log.push(`launch ${bundleId}`);
    return MOCK;
  }
  inputMethods(_udid: string): InputMethods {
    return { hid: 'unsupported', hid_reason: 'mock phones', wda_fast: 'no' };
  }

  private lockedSet = new Set<string>();
  async lock(udid: string): Promise<void> {
    this.live(udid).log.push('lock');
    this.lockedSet.add(udid);
  }
  async unlock(udid: string): Promise<void> {
    this.live(udid).log.push('unlock');
    this.lockedSet.delete(udid);
  }
  async isLocked(udid: string): Promise<boolean | null> {
    return this.phones.get(udid)?.info.online ? this.lockedSet.has(udid) : null;
  }
  restartWda(_udid: string): void {}

  async recover(udid: string): Promise<ControlState> {
    this.live(udid);
    return 'ready';
  }

  subscribe(udid: string, onFrame: (f: Buffer) => void, want: StreamSettings) {
    const p = this.live(udid);
    const fps = Math.min(want.fps, 30); // PNG encoding caps the mock
    let m = this.mjpeg.get(udid);
    if (!m) this.mjpeg.set(udid, (m = { viewers: 0, meter: new RateMeter() }));
    const mine = m;
    mine.viewers++;
    const timer = setInterval(() => {
      mine.meter.tick();
      onFrame(this.render(p));
    }, Math.round(1000 / fps));
    this.streams.add(timer);
    let gone = false;
    return {
      contentType: 'image/png',
      fps,
      quality: want.quality,
      scale: 100, // the mock always renders the same size
      unsubscribe: () => {
        clearInterval(timer);
        this.streams.delete(timer);
        if (!gone) mine.viewers--;
        gone = true;
      },
    };
  }

  async close() {
    clearInterval(this.battTimer);
    for (const t of this.streams) clearInterval(t);
    this.streams.clear();
    for (const s of this.h264Sources.values()) s.close();
  }
}

export const MOCK_SCREEN = { width: SCREEN_W, height: SCREEN_H };
