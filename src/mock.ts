import { encodePng } from './png.js';
import { Backend, ControlState, HttpError, Image, ImageFormat, PathPoint, PhoneInfo, ScreenInfo, StreamSettings } from './types.js';

const W = 270;
const H = 585;
const SCREEN_W = 390; // logical points, like a real iPhone
const SCREEN_H = 844;
const PIXEL_SCALE = 3; // reported like an @3x phone
const SCALE = W / SCREEN_W;

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

  constructor(count: number) {
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
        hue: hash(udid) % 360, marks: [], app: 'com.apple.springboard', typed: '', frame: 0,
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
    return [...this.phones.values()].map((p) => ({ ...p.info }));
  }

  screen(udid: string): ScreenInfo | null {
    return this.phones.has(udid) ? { width: SCREEN_W, height: SCREEN_H, scale: PIXEL_SCALE } : null;
  }

  private render(p: MockPhone): Buffer {
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
  async tap(udid: string, x: number, y: number) {
    this.live(udid).marks.push({ x, y, at: Date.now() });
  }
  async gesture(udid: string, points: PathPoint[]) {
    const p = this.live(udid);
    const a = points[0]!;
    const b = points[points.length - 1]!;
    p.marks.push({ x: a[0], y: a[1], x2: b[0], y2: b[1], at: Date.now() });
  }
  async type(udid: string, text: string) {
    const p = this.live(udid);
    p.typed = (p.typed + text).slice(-200);
  }
  async home(udid: string) {
    this.live(udid).app = 'com.apple.springboard';
  }
  async launch(udid: string, bundleId: string) {
    this.live(udid).app = bundleId;
  }

  async recover(udid: string): Promise<ControlState> {
    this.live(udid);
    return 'ready';
  }

  subscribe(udid: string, onFrame: (f: Buffer) => void, want: StreamSettings) {
    const p = this.live(udid);
    const fps = Math.min(want.fps, 30); // PNG encoding caps the mock
    const timer = setInterval(() => onFrame(this.render(p)), Math.round(1000 / fps));
    this.streams.add(timer);
    return {
      contentType: 'image/png',
      fps,
      quality: want.quality,
      scale: 100, // the mock always renders the same size
      unsubscribe: () => {
        clearInterval(timer);
        this.streams.delete(timer);
      },
    };
  }

  async close() {
    clearInterval(this.battTimer);
    for (const t of this.streams) clearInterval(t);
    this.streams.clear();
  }
}

export const MOCK_SCREEN = { width: SCREEN_W, height: SCREEN_H };
