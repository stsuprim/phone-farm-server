import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './types.js';

/**
 * Server settings the client can change (GET / PUT /api/settings), kept in the server's config dir
 * (data/settings.json, next to data/ports.json). Without a file (tests) they live in memory only.
 */
export interface Settings {
  /** Minutes with no input and no viewer before a phone is locked (screen off). 0 = never. */
  idleLockMinutes: number;
}

// 2026-11-16: natural touch (src/human.ts) is always on; `naturalTouch` is no longer a setting (an older client's
// PUT of it, and one kept in the file, are left out without a word).
export const DEFAULT_SETTINGS: Settings = { idleLockMinutes: 10 };
const MAX_IDLE_LOCK_MINUTES = 24 * 60;

export class SettingsStore {
  private value: Settings = { ...DEFAULT_SETTINGS };

  constructor(private file?: string) {
    if (!file) return;
    try {
      this.value = { ...DEFAULT_SETTINGS, ...SettingsStore.validate(JSON.parse(fs.readFileSync(file, 'utf8')), true) };
    } catch {
      /* first run or an unreadable file: defaults */
    }
  }

  get(): Settings {
    return { ...this.value };
  }

  /** Changes the given fields (unknown ones refused), saves and returns the whole settings. */
  put(patch: Record<string, unknown>): Settings {
    this.value = { ...this.value, ...SettingsStore.validate(patch, false) };
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
      fs.renameSync(tmp, this.file);
    }
    return this.get();
  }

  /** The valid fields of `v`; `lenient` (reading the file) skips bad ones instead of refusing. */
  static validate(v: unknown, lenient: boolean): Partial<Settings> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      if (lenient) return {};
      throw new HttpError(400, 'settings must be a JSON object');
    }
    const out: Partial<Settings> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'idleLockMinutes') {
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= MAX_IDLE_LOCK_MINUTES) {
          out.idleLockMinutes = Math.round(val * 100) / 100;
        } else if (!lenient) throw new HttpError(400, `"idleLockMinutes" must be a number from 0 (off) to ${MAX_IDLE_LOCK_MINUTES}`);
      } else if (k === 'naturalTouch') {
        continue; // not a setting any more: always on
      } else if (!lenient) throw new HttpError(400, `unknown setting ${JSON.stringify(k)}`);
    }
    return out;
  }
}
