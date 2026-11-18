import fs from 'node:fs';
import os from 'node:os';
import { parsePorts } from './fork.js';

export interface Config {
  host: string;
  port: number;
  token: string;
  mock: boolean;
  mockPhones: number;
  wdaProject: string;
  wdaDerivedData: string;
  wdaBasePort: number;
  mjpegBasePort: number;
  pollMs: number;
  autostartWda: boolean;
  autoUpdateSeconds: number; // GitHub poll for the force-updater; 0 = off
  autoUpdateMinutes: number; // same interval in minutes (what index.ts passes to updater.start)
  h264: boolean; // H.264 live view through native/phonecap (macOS)
  h264BitrateMbps: number;
  /** The phone's sound in the live view (AUDIO, on by default; src/audio.ts). */
  audio?: boolean;
  /**
   * The phone's media volume while its sound is routed to the Mac, percent (AUDIO_PHONE_VOLUME, default 0 since
   * 2026-11-18, and never raised while PHONE_SILENT is on). Back to 0 when nobody listens.
   */
  audioPhoneVolume?: number;
  /**
   * 2026-11-18: the phones never make a sound (PHONE_SILENT, on by default): their volume is never raised (whatever
   * AUDIO_PHONE_VOLUME says), the volume-up key is refused, and their volume is driven to 0 whenever their
   * WebDriverAgent comes up and after a wake (src/audio.ts VolumeGuard.silence).
   */
  phoneSilent?: boolean;
  /** CoreDevice HID live touch (docs/BEST_METHOD.md): auto = on iOS 27+ phones, on = try on every phone, off. */
  hidInput: 'auto' | 'on' | 'off';
  /** The Python that has pymobiledevice3 (native/hid/hid_input.py runs with it). */
  hidPython: string;
  /** Seconds without a viewer or input before a phone's touch session closes (frees its camera/mic). */
  hidIdleSeconds: number;
  /**
   * Seconds a phone's capture keeps running after its last viewer left (and after a warm-up nobody joined), so
   * coming back to a phone shows its picture at once.
   */
  captureWarmSeconds: number;
  /** The server's config dir (settings.json, wda-sign.json, ports.json): data/ under the working directory. */
  dataDir: string;
  /** The Apple Team ID WDA is signed with (scripts/build-wda.sh's first argument), for the 6-day re-sign. */
  wdaTeamId: string;
  /** Re-sign WDA every 6 days (free Apple ID profiles last 7). */
  wdaResign: boolean;
  /** Local hour the quiet re-sign window starts (3 hours long). */
  wdaResignHour: number;
  /**
   * Our own WebDriverAgent build (wda/ in this repo, src/fork.ts): installed on each phone by the server itself
   * (WDA_FORK, on by default; off = the stock WebDriverAgent of WDA_PROJECT stays).
   */
  wdaFork?: boolean;
  /** Where our build is built (WDA_FORK_DERIVED_DATA, default ~/wda-fork-build): apart from the stock one's, which stays for a rollback. */
  wdaForkDerivedData?: string;
  /** Our build's port on the first phone, on the phone and on the Mac (WDA_FORK_BASE_PORT, default 28100); the next phone's is one higher. */
  wdaForkBasePort?: number;
  /** A phone's own port (WDA_FORK_PORTS=udid=port,udid=port), when base + index doesn't suit. */
  wdaForkPorts?: Record<string, number>;
  /**
   * Live touch through our build (WDA_LIVE_TOUCH, or "liveTouch" in wda/LOTUS_FORK.json): auto (default) = only a
   * held contact (modes 1-3) the phone's own self-test proved from press to lift, else the owner's drag plays whole
   * on "up" (the path that always worked); segmented = also modes 4-5 (short whole gestures as the finger moves; opt
   * in only); off = never. 2026-11-17: "on" (mode 1 without the self-test's word) is gone: it reads as auto, since an
   * untested hold mode can leave a finger down.
   */
  wdaLiveTouch?: 'auto' | 'segmented' | 'off';
}

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const expand = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());

export function loadConfig(envFile = '.env'): Config {
  loadDotEnv(envFile);
  const e = process.env;
  const token = e.API_TOKEN ?? '';
  if (token.length < 16 || token === 'change-me-to-a-long-random-string') {
    throw new Error('API_TOKEN is missing or too short. Run `npm run init-env` and restart.');
  }
  // AUTO_UPDATE_SECONDS (default 10). The old AUTO_UPDATE_MINUTES is ignored except `0`, which still turns it off.
  const autoUpdateSeconds = e.AUTO_UPDATE_MINUTES?.trim() === '0' ? 0 : Math.max(0, num(e.AUTO_UPDATE_SECONDS, 10));
  return {
    host: e.HOST || '0.0.0.0',
    port: num(e.PORT, 8787),
    token,
    mock: bool(e.MOCK, false),
    mockPhones: num(e.MOCK_PHONES, 4),
    wdaProject: expand(e.WDA_PROJECT ?? ''),
    wdaDerivedData: expand(e.WDA_DERIVED_DATA || '~/wda-build'),
    wdaBasePort: num(e.WDA_BASE_PORT, 8100),
    mjpegBasePort: num(e.MJPEG_BASE_PORT, 9100),
    pollMs: num(e.POLL_MS, 5000),
    autostartWda: bool(e.AUTOSTART_WDA, true),
    autoUpdateSeconds,
    autoUpdateMinutes: autoUpdateSeconds / 60,
    h264: bool(e.H264, true),
    h264BitrateMbps: Math.min(50, Math.max(1, num(e.H264_BITRATE_MBPS, 8))),
    audio: bool(e.AUDIO, true),
    audioPhoneVolume: Math.min(100, Math.max(0, num(e.AUDIO_PHONE_VOLUME, 0))),
    phoneSilent: bool(e.PHONE_SILENT, true),
    hidInput: /^(on|off)$/i.test(e.HID_INPUT ?? '') ? (e.HID_INPUT!.toLowerCase() as 'on' | 'off') : 'auto',
    hidPython: expand(e.HID_PYTHON || 'python3'),
    hidIdleSeconds: Math.max(10, num(e.HID_IDLE_SECONDS, 120)),
    captureWarmSeconds: Math.min(3600, Math.max(10, num(e.CAPTURE_WARM_SECONDS, 120))),
    dataDir: 'data', // relative to the working directory, like data/ports.json (launchd's WorkingDirectory)
    wdaTeamId: (e.WDA_TEAM_ID ?? '').trim(),
    wdaResign: bool(e.WDA_RESIGN, true),
    wdaResignHour: Math.min(23, Math.max(0, Math.round(num(e.WDA_RESIGN_HOUR, 3)))),
    wdaFork: bool(e.WDA_FORK, true),
    wdaForkDerivedData: expand(e.WDA_FORK_DERIVED_DATA || '~/wda-fork-build'),
    wdaForkBasePort: Math.min(65000, Math.max(1024, Math.round(num(e.WDA_FORK_BASE_PORT, 28100)))),
    wdaForkPorts: parsePorts(e.WDA_FORK_PORTS),
    wdaLiveTouch: /^(segmented|off)$/i.test(e.WDA_LIVE_TOUCH ?? '') ? (e.WDA_LIVE_TOUCH!.toLowerCase() as 'segmented' | 'off') : 'auto',
  };
}
