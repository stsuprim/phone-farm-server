// Where the server's pieces live. src/ is being carved into src/device, src/phone, src/capture and src/transport
// (docs/root-cause.md 13.5): the regression tests never import those files by a fixed path, they ask here, which tries
// the new place first and the old one after. A name found nowhere is a clear failure ("not found in ..."), not a
// type error that stops every test from compiling.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PLACES: Record<string, string[]> = {
  server: ['src/server.ts'],
  mock: ['src/mock.ts'],
  real: ['src/real.ts'],
  wda: ['src/device/link.ts', 'src/device/wdaclient.ts', 'src/device/runner.ts', 'src/wda.ts'],
  capture: ['src/capture/source.ts', 'src/h264.ts'],
  idle: ['src/phone/power.ts', 'src/idle.ts'],
  congestion: ['src/transport/cc.ts', 'src/congestion.ts'],
  rtc: ['src/transport/rtc.ts', 'src/rtc.ts'],
  fork: ['src/fork.ts'],
  presence: ['src/presence.ts'],
  trace: ['src/trace.ts'],
};

const cache = new Map<string, Record<string, any>>();

async function load(file: string): Promise<Record<string, any> | null> {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return null;
  if (!cache.has(abs)) cache.set(abs, (await import(pathToFileURL(abs).href)) as Record<string, any>);
  return cache.get(abs)!;
}

/** An export of one of the server's pieces (`find('wda', 'WdaManager')`), wherever it lives now. */
export async function find<T = any>(piece: keyof typeof PLACES, name: string): Promise<T> {
  const tried: string[] = [];
  for (const f of PLACES[piece]!) {
    tried.push(f);
    const m = await load(f);
    if (m && name in m) return m[name] as T;
  }
  throw new Error(`${name} not found in ${tried.join(', ')}`);
}

/** Like find, but undefined when it's nowhere (for what the rebuild adds). */
export async function maybe<T = any>(piece: keyof typeof PLACES, name: string): Promise<T | undefined> {
  try {
    return await find<T>(piece, name);
  } catch {
    return undefined;
  }
}
