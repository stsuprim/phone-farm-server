import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from './config.js';
import { bitrateFor, H264Source, helperProducer, phoneStats } from './h264.js';
import { MjpegSource } from './mjpeg.js';
import { Backend, ControlState, H264Want, HttpError, Image, ImageFormat, PathPoint, PhoneInfo, ScreenInfo, StreamSettings } from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // src/ or dist/ -> project root
// inside a minimal app bundle so macOS gives it its own Camera (TCC) entry (scripts/build-native.mjs)
const HELPER = process.env.PHONECAP_PATH || path.join(ROOT, 'native', 'phonecap', 'build', 'PhoneCap.app', 'Contents', 'MacOS', 'phonecap');
const HELPER_ERROR = path.join(ROOT, 'native', 'phonecap', 'build', 'phonecap.error');
import { WdaManager } from './wda.js';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
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
  private h264Sources = new Map<string, H264Source>();
  private streams = new Map<string, Set<StreamSettings>>(); // what each stream subscriber asked for
  private timer: NodeJS.Timeout;
  private polling = false;

  constructor(private cfg: Config) {
    this.wda = new WdaManager(cfg, (udid) => this.phones.get(udid)?.name ?? udid);
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
          this.h264Sources.get(udid)?.close('phone unplugged');
          this.h264Sources.delete(udid);
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
        stats: this.stats(p.udid),
      };
    });
  }

  private stats(udid: string) {
    const m = this.sources.get(udid);
    const src = this.h264Sources.get(udid);
    const reason = this.helperProblem() ?? src?.unavailable() ?? null;
    return phoneStats(src, { fps: m?.viewers ? m.meter.rate() : 0, viewers: m?.viewers ?? 0 }, reason);
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

  h264(udid: string, want: H264Want): H264Source | string {
    const p = this.known(udid);
    const problem = this.helperProblem();
    if (problem) return problem;
    const settings = { fps: want.fps, scale: want.scale, bitrate: want.bitrate ?? bitrateFor(want.quality, this.cfg.h264BitrateMbps * 1_000_000) };
    let src = this.h264Sources.get(udid);
    if (!src) {
      const online = [...this.phones.values()].filter((x) => x.online).length;
      const args = ['--udid', udid, '--name', p.name];
      if (online === 1) args.push('--any-if-single');
      src = new H264Source(udid.slice(-8), helperProducer(HELPER, args, udid.slice(-8)), settings);
      this.h264Sources.set(udid, src);
    }
    const down = src.unavailable();
    if (down) return down;
    src.setWant(settings);
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
      return { data: jpeg, contentType: 'image/jpeg' };
    }
    const j = await this.wda.callNoSession(udid, 'GET', '/screenshot');
    return { data: Buffer.from(String(j.value), 'base64'), contentType: 'image/png' };
  }

  async tap(udid: string, x: number, y: number) {
    this.known(udid);
    await this.wda.tap(udid, x, y);
  }
  async gesture(udid: string, points: PathPoint[]) {
    this.known(udid);
    await this.wda.actions(udid, points);
  }
  async type(udid: string, text: string) {
    this.known(udid);
    await this.wda.call(udid, 'POST', '/wda/keys', { value: Array.from(text) });
  }
  async home(udid: string) {
    this.known(udid);
    await this.wda.callNoSession(udid, 'POST', '/wda/homescreen', {});
  }
  async launch(udid: string, bundleId: string) {
    this.known(udid);
    await this.wda.call(udid, 'POST', '/wda/apps/launch', { bundleId });
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
    this.wda.shutdown();
  }
}

/** The first line of a build log that is a real compiler error ("error:"), else its first non-empty line. */
export function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /\berror:/i.test(l)) ?? lines[0] ?? 'unknown build error').slice(0, 300);
}
