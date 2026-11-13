import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from './config.js';
import { H264Source, helperProducer, phoneStats, StartProducer } from './h264.js';
import { PhonecapHost, profileFor } from './lanes.js';
import { MjpegSource } from './mjpeg.js';
import { Backend, ControlState, H264Want, HttpError, Image, ImageFormat, PathPoint, PhoneInfo, ScreenInfo, StreamSettings } from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // src/ or dist/ -> project root
// inside a minimal app bundle so macOS gives it its own Camera (TCC) entry (scripts/build-native.mjs)
const HELPER = process.env.PHONECAP_PATH || path.join(ROOT, 'native', 'phonecap', 'build', 'PhoneCap.app', 'Contents', 'MacOS', 'phonecap');
const HELPER_ERROR = path.join(ROOT, 'native', 'phonecap', 'build', 'phonecap.error');
// what the built helper speaks (scripts/build-native.mjs writes it from main.swift's "phonecap-caps:" line)
const HELPER_CAPS = path.join(ROOT, 'native', 'phonecap', 'build', 'phonecap.caps');

/** The built helper's capabilities ("lanes": several encoders from one capture); none for an older build. */
function helperCaps(): string[] {
  if (process.env.PHONECAP_LANES === '0') return [];
  try {
    return fs.readFileSync(HELPER_CAPS, 'utf8').split(/[\s,]+/).filter(Boolean);
  } catch {
    return [];
  }
}
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
  private h264Sources = new Map<string, H264Source>(); // "udid" (an older helper) or "udid|lane key"
  private hosts = new Map<string, PhonecapHost>(); // one phonecap process per phone, shared by its lanes
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
          this.closeH264(udid, 'phone unplugged');
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
  }

  private stats(udid: string) {
    const m = this.sources.get(udid);
    const srcs = this.phoneSources(udid);
    const reason = this.helperProblem() ?? srcs.map((s) => s.unavailable()).find((r) => r) ?? null;
    return phoneStats(srcs, { fps: m?.viewers ? m.meter.rate() : 0, viewers: m?.viewers ?? 0 }, reason, this.buildError());
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
        if (!host) this.hosts.set(udid, (host = new PhonecapHost(HELPER, args, tag)));
        start = host.start;
      } else start = helperProducer(HELPER, args, tag);
      const kind = prof.remote ? 'remote' : 'lan';
      src = new H264Source(lanes ? `${tag} ${kind}` : tag, start, prof.settings, { kind });
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
    for (const h of this.hosts.values()) h.close();
    this.wda.shutdown();
  }
}

/** The first line of a build log that is a real compiler error ("error:"), else its first non-empty line. */
export function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /\berror:/i.test(l)) ?? lines[0] ?? 'unknown build error').slice(0, 300);
}
