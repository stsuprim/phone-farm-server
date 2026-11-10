import fs from 'node:fs';
import os from 'node:os';

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
  };
}
