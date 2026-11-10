import { execFile } from 'node:child_process';
import { Config } from './config.js';
import { MjpegSource } from './mjpeg.js';
import { Backend, HttpError, Image, ImageFormat, PhoneInfo } from './types.js';
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
  private timer: NodeJS.Timeout;
  private polling = false;

  constructor(private cfg: Config) {
    this.wda = new WdaManager(cfg);
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
        });
        if (paired && this.cfg.autostartWda) this.wda.start(udid);
      }
      for (const [udid, p] of this.phones) {
        if (!ids.includes(udid)) {
          p.online = false;
          this.wda.stop(udid);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async list(): Promise<PhoneInfo[]> {
    return [...this.phones.values()].map((p) => ({ ...p, ready: p.online && this.wda.status(p.udid) === 'ready' }));
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
    await this.wda.call(udid, 'POST', '/wda/tap/0', { x, y });
  }
  async swipe(udid: string, x1: number, y1: number, x2: number, y2: number, ms: number) {
    this.known(udid);
    await this.wda.call(udid, 'POST', '/wda/dragfromtoforduration', { fromX: x1, fromY: y1, toX: x2, toY: y2, duration: ms / 1000 });
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

  subscribe(udid: string, onFrame: (f: Buffer) => void) {
    this.known(udid);
    if (this.wda.status(udid) !== 'ready') throw new HttpError(503, 'WebDriverAgent is not ready');
    return { contentType: 'image/jpeg', unsubscribe: this.source(udid).add(onFrame) };
  }

  async close() {
    clearInterval(this.timer);
    this.wda.shutdown();
  }
}
