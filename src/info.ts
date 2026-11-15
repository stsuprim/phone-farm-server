import { KNOWN_APPS } from './apps.js';
import type { AppInfo, DeviceInfo, PhoneFacts, PhoneInfo } from './types.js';

/**
 * The detail card's data (GET /phones/:udid/info, and `info` on each phone in GET /phones): battery, temperature, the
 * app in front, uptime, model, iOS and WDA's signing. The phone's part comes from the backend (`facts`): lockdown's
 * battery domain (ideviceinfo), the IORegistry's AppleSmartBattery (idevicediagnostics) and WDA's activeAppInfo and
 * device info; this file holds their parsers and the ~15 s cache. Gathering never waits on WDA starting or
 * recovering and never touches the live view; anything unknown is null.
 */

export const INFO_FRESH_MS = 15_000;
/** A part that didn't answer this time (WDA busy with a long gesture, a tool that timed out) keeps its last value this long. */
export const INFO_CARRY_MS = 60_000;

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (v === true || v === 'true' || v === 1 || v === '1' ? true : v === false || v === 'false' || v === 0 || v === '0' ? false : null);

export interface BatteryFacts {
  level: number | null; // 0..1
  charging: boolean | null;
  temperatureC: number | null;
}

/**
 * `ideviceinfo -q com.apple.mobile.battery`: "BatteryCurrentCapacity: 87", "BatteryIsCharging: true",
 * "ExternalConnected: true", "FullyCharged: false" (one per line). A full phone on power doesn't charge any more but
 * is still on the charger: that reads as charging.
 */
export function parseBatteryDomain(text: string): BatteryFacts {
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'mi').exec(text)?.[1] ?? null;
  const cap = finite(get('BatteryCurrentCapacity'));
  const charging = bool(get('BatteryIsCharging'));
  const full = bool(get('FullyCharged'));
  const external = bool(get('ExternalConnected'));
  return {
    level: cap !== null && cap >= 0 && cap <= 100 ? round(cap / 100, 2) : null,
    charging: charging === true || (full === true && external !== false) ? true : charging,
    temperatureC: null,
  };
}

/**
 * `idevicediagnostics ioregentry AppleSmartBattery`: a plist whose IORegistry dict holds Temperature (hundredths of a
 * degree Celsius), CurrentCapacity / MaxCapacity (percent on phones that report 100 as the maximum, else mAh),
 * IsCharging and ExternalConnected. Nested dicts repeat some keys: the first one is the entry's own.
 */
export function parseIoreg(xml: string): BatteryFacts {
  const int = (k: string) => {
    const m = new RegExp(`<key>${k}</key>\\s*<(?:integer|real)>(-?[\\d.]+)</(?:integer|real)>`).exec(xml);
    return m ? finite(m[1]) : null;
  };
  const flag = (k: string) => {
    const m = new RegExp(`<key>${k}</key>\\s*<(true|false)\\s*/>`).exec(xml);
    return m ? m[1] === 'true' : null;
  };
  const t = int('Temperature');
  // 0 = no reading; anything outside what a phone survives is a different unit or a bad read
  const temperatureC = t !== null && t > 0 && t / 100 > -30 && t / 100 < 110 ? round(t / 100, 1) : null;
  const cur = int('CurrentCapacity');
  const max = int('MaxCapacity');
  const level = cur !== null && max !== null && max > 0 && cur >= 0 && cur <= max ? round(cur / max, 2) : null;
  const charging = flag('IsCharging');
  return { level, charging: charging === true || (flag('FullyCharged') === true && flag('ExternalConnected') !== false) ? true : charging, temperatureC };
}

/** WDA's GET /wda/batteryInfo: `{level: 0..1, state: 1 unplugged | 2 charging | 3 full}` (UIDevice's). */
export function parseWdaBattery(v: unknown): BatteryFacts {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const level = finite(o.level);
  const state = finite(o.state);
  return {
    level: level !== null && level >= 0 && level <= 1 ? round(level, 2) : null,
    charging: state === 2 || state === 3 ? true : state === 1 ? false : null,
    temperatureC: null,
  };
}

const THERMAL = ['nominal', 'fair', 'serious', 'critical'] as const;

/**
 * WDA's GET /wda/device/info: `thermalState` (NSProcessInfo's 0..3). Stock WDA has no uptime; a build that adds
 * `uptime` / `systemUptime` (seconds) or `bootTime` (seconds or ms since the epoch) is read too.
 */
export function parseDeviceInfo(v: unknown, now: number): { thermal: DeviceInfo['thermal']; uptimeSec: number | null; bootedAt: number | null } {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const ts = finite(o.thermalState);
  const thermal = ts !== null && Number.isInteger(ts) && ts >= 0 && ts <= 3 ? THERMAL[ts]! : null;
  let uptimeSec = finite(o.uptime) ?? finite(o.systemUptime);
  let bootedAt: number | null = null;
  const boot = finite(o.bootTime) ?? finite(o.bootedAt);
  if (boot !== null && boot > 0) {
    bootedAt = Math.round(boot < 1e11 ? boot * 1000 : boot);
    if (bootedAt <= now) uptimeSec = Math.round((now - bootedAt) / 1000);
    else bootedAt = null;
  }
  if (uptimeSec !== null && uptimeSec >= 0) {
    uptimeSec = Math.round(uptimeSec);
    bootedAt ??= now - uptimeSec * 1000;
  } else uptimeSec = null;
  return { thermal, uptimeSec, bootedAt };
}

/** WDA's GET /wda/activeAppInfo `{bundleId, name, pid}`: the app in front, its name from the apps we know when WDA has none. */
export function parseActiveApp(v: unknown, apps: AppInfo[] | null = null): DeviceInfo['app'] {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const bundleId = typeof o.bundleId === 'string' && o.bundleId ? o.bundleId : null;
  let name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : null;
  if (bundleId && !name) name = appName(bundleId, apps);
  return { bundleId, name };
}

/** An app's name from its bundle id: the phone's list, the well-known apps, "Home Screen" for SpringBoard; else null. */
export function appName(bundleId: string, apps: AppInfo[] | null = null): string | null {
  const id = bundleId.toLowerCase();
  if (id === 'com.apple.springboard') return 'Home Screen';
  const listed = apps?.find((a) => a.bundleId.toLowerCase() === id && a.name && a.name !== a.bundleId);
  if (listed) return listed.name;
  return Object.entries(KNOWN_APPS).find(([, b]) => b.toLowerCase() === id)?.[0] ?? null;
}

/** The first reading that has each part (lockdown first, then the IORegistry, then WDA). */
export function mergeBattery(...parts: (BatteryFacts | null | undefined)[]): BatteryFacts {
  const out: BatteryFacts = { level: null, charging: null, temperatureC: null };
  for (const p of parts) {
    if (!p) continue;
    out.level ??= p.level;
    out.charging ??= p.charging;
    out.temperatureC ??= p.temperatureC;
  }
  return out;
}

/** What the list already knows about a phone, as facts (the quick answer before anything was gathered). */
export function basicFacts(p: Pick<PhoneInfo, 'battery' | 'model' | 'ios'>): PhoneFacts {
  return {
    battery: { level: typeof p.battery === 'number' ? round(Math.min(100, Math.max(0, p.battery)) / 100, 2) : null, charging: null },
    temperatureC: null,
    app: { bundleId: null, name: null },
    uptimeSec: null,
    model: p.model || null,
    ios: p.ios || null,
    bootedAt: null,
    thermal: null,
    connectedAt: null,
  };
}

export type WdaSigning = DeviceInfo['wda'];

interface Kept {
  facts: PhoneFacts;
  at: number;
}

/**
 * Each phone's facts, kept ~15 s. `get` waits for a gathering when what's kept is older (one at a time per phone,
 * shared by everyone asking); `peek` never waits: it answers with what's kept (or what the list knows) and gathers in
 * the background for the next ask.
 */
export class InfoCache {
  private kept = new Map<string, Kept>();
  private flying = new Map<string, Promise<Kept>>();

  constructor(
    private gather: (udid: string) => Promise<PhoneFacts>,
    private wda: () => WdaSigning,
    private freshMs = INFO_FRESH_MS,
    private now: () => number = Date.now,
  ) {}

  private view(k: Kept | undefined, basic: PhoneFacts, fresh: boolean): DeviceInfo {
    const f = k?.facts;
    return {
      battery: { level: f?.battery.level ?? basic.battery.level, charging: f?.battery.charging ?? basic.battery.charging },
      temperatureC: f?.temperatureC ?? null,
      app: f?.app ?? basic.app,
      // the phone keeps running between two gatherings
      uptimeSec: f?.bootedAt != null ? Math.max(0, Math.round((this.now() - f.bootedAt) / 1000)) : f?.uptimeSec ?? null,
      model: f?.model ?? basic.model,
      ios: f?.ios ?? basic.ios,
      bootedAt: f?.bootedAt ?? null,
      wda: this.wda(),
      thermal: f?.thermal ?? null,
      connectedAt: f?.connectedAt ?? basic.connectedAt,
      at: k?.at ?? this.now(),
      fresh,
    };
  }

  /**
   * One gathering's facts, with the parts that didn't answer this time taken from the last one when that's under a
   * minute old: a card doesn't blank its temperature or its app because WDA was busy for a moment.
   */
  private carry(udid: string, facts: PhoneFacts): PhoneFacts {
    const prev = this.kept.get(udid);
    if (!prev || this.now() - prev.at > INFO_CARRY_MS) return facts;
    const was = prev.facts;
    return {
      ...facts,
      battery: { level: facts.battery.level ?? was.battery.level, charging: facts.battery.charging ?? was.battery.charging },
      temperatureC: facts.temperatureC ?? was.temperatureC,
      app: facts.app.bundleId ? facts.app : was.app,
      thermal: facts.thermal ?? was.thermal,
      uptimeSec: facts.bootedAt === null && facts.uptimeSec === null ? was.uptimeSec : facts.uptimeSec,
      bootedAt: facts.bootedAt ?? was.bootedAt,
    };
  }

  private refresh(udid: string): Promise<Kept> {
    let p = this.flying.get(udid);
    if (!p) {
      p = this.gather(udid)
        .then((facts) => {
          const k = { facts: this.carry(udid, facts), at: this.now() };
          this.kept.set(udid, k);
          return k;
        })
        .finally(() => this.flying.delete(udid));
      this.flying.set(udid, p);
    }
    return p;
  }

  /** The phone's info, gathered now unless what's kept is under ~15 s old (`force`: gathered now anyway). */
  async get(phone: PhoneInfo, force = false): Promise<DeviceInfo> {
    const basic = basicFacts(phone);
    const k = this.kept.get(phone.udid);
    if (!phone.online) return this.view(k, basic, false); // nothing to ask: what was last known
    if (k && !force && this.now() - k.at < this.freshMs) return this.view(k, basic, true);
    try {
      return this.view(await this.refresh(phone.udid), basic, true);
    } catch {
      return this.view(k, basic, false);
    }
  }

  /** Never waits: what's kept (else what the list knows), and a gathering started for next time when that's old. */
  peek(phone: PhoneInfo): DeviceInfo {
    const k = this.kept.get(phone.udid);
    const old = !k || this.now() - k.at >= this.freshMs;
    if (phone.online && old) void this.refresh(phone.udid).catch(() => {});
    return this.view(k, basicFacts(phone), !!k && !old);
  }

  forget(udid: string): void {
    this.kept.delete(udid);
  }
}
