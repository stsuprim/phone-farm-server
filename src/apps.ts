import { AppInfo, HttpError } from './types.js';

/**
 * Apps by name: an agent says "open Settings", not "com.apple.Preferences". The phone's own list comes from
 * ideviceinstaller when it's there; the well-known apps below are always known, so a launch by name works without it.
 */

export const KNOWN_APPS: Record<string, string> = {
  Safari: 'com.apple.mobilesafari',
  Settings: 'com.apple.Preferences',
  Camera: 'com.apple.camera',
  Photos: 'com.apple.mobileslideshow',
  'App Store': 'com.apple.AppStore',
  Messages: 'com.apple.MobileSMS',
  Mail: 'com.apple.mobilemail',
  Notes: 'com.apple.mobilenotes',
  Clock: 'com.apple.mobiletimer',
  Maps: 'com.apple.Maps',
  Files: 'com.apple.DocumentsApp',
  Calendar: 'com.apple.mobilecal',
  Phone: 'com.apple.mobilephone',
  Contacts: 'com.apple.MobileAddressBook',
  Music: 'com.apple.Music',
  Weather: 'com.apple.weather',
  Calculator: 'com.apple.calculator',
  FaceTime: 'com.apple.facetime',
  Reminders: 'com.apple.reminders',
  Shortcuts: 'com.apple.shortcuts',
  Wallet: 'com.apple.Passbook',
  Health: 'com.apple.Health',
  Podcasts: 'com.apple.podcasts',
  TestFlight: 'com.apple.TestFlight',
  TikTok: 'com.zhiliaoapp.musically',
  Instagram: 'com.burbn.instagram',
  Threads: 'com.burbn.barcelona',
  YouTube: 'com.google.ios.youtube',
  Facebook: 'com.facebook.Facebook',
  Messenger: 'com.facebook.Messenger',
  WhatsApp: 'net.whatsapp.WhatsApp',
  Telegram: 'ph.telegra.Telegraph',
  X: 'com.atebits.Tweetie2',
  Twitter: 'com.atebits.Tweetie2',
  Snapchat: 'com.toyopagroup.picaboo',
  Reddit: 'com.reddit.Reddit',
  Discord: 'com.hammerandchisel.discord',
  Spotify: 'com.spotify.client',
  Chrome: 'com.google.chrome.ios',
  Gmail: 'com.google.Gmail',
  'Google Maps': 'com.google.Maps',
};

/**
 * ideviceinstaller's list, either form: `com.apple.Maps, "3141.1", "Maps"` (CSV, with a "CFBundleIdentifier, ..."
 * header) or the older `com.apple.Maps - Maps 3141.1`.
 */
export function parseInstalled(out: string): AppInfo[] {
  const apps: AppInfo[] = [];
  const seen = new Set<string>();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^CFBundleIdentifier\b/i.test(line) || /^Total:/i.test(line)) continue;
    let bundleId = '';
    let name = '';
    const csv = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*,\s*(?:"[^"]*"|[^,]*)\s*,\s*"?(.*?)"?\s*$/.exec(line);
    const dash = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.*)$/.exec(line);
    if (csv) [, bundleId, name] = csv as unknown as [string, string, string];
    else if (dash) {
      bundleId = dash[1]!;
      name = dash[2]!.replace(/\s+[\d.]+$/, ''); // the version at the end
    } else continue;
    if (!bundleId.includes('.') || seen.has(bundleId)) continue;
    seen.add(bundleId);
    apps.push({ bundleId, name: name.trim() || bundleId, installed: true });
  }
  return apps;
}

/** The installed apps (when the phone's list was read) with the well-known ones it doesn't hold added as unconfirmed (`installed: null`). */
export function withKnown(installed: AppInfo[] | null): AppInfo[] {
  const out = [...(installed ?? [])];
  const have = new Set(out.map((a) => a.bundleId.toLowerCase()));
  for (const [name, bundleId] of Object.entries(KNOWN_APPS)) {
    if (have.has(bundleId.toLowerCase())) continue;
    have.add(bundleId.toLowerCase());
    out.push({ bundleId, name, installed: null }); // the list may hold user apps only: the phone says when it's launched
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const looksLikeBundleId = (s: string) => /^[A-Za-z0-9-]+(\.[A-Za-z0-9_-]+){1,}$/.test(s);

/**
 * An app's bundle id from what an agent called it: a bundle id as it is; else a name, equal first, then starting
 * with it, then containing it (installed apps before unconfirmed ones). Throws 404 with the nearest names.
 */
export function resolveApp(apps: AppInfo[], asked: string): string {
  const want = asked.trim();
  if (!want) throw new HttpError(400, '"name" is empty');
  const byId = apps.find((a) => a.bundleId.toLowerCase() === want.toLowerCase());
  if (byId) return byId.bundleId;
  const w = want.toLowerCase();
  const rank = (a: AppInfo) => (a.installed === true ? 0 : 1);
  const tests: ((n: string) => boolean)[] = [(n) => n === w, (n) => n.startsWith(w), (n) => n.includes(w)];
  for (const t of tests) {
    const hit = apps.filter((a) => t(a.name.toLowerCase())).sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length);
    if (hit.length) return hit[0]!.bundleId;
  }
  if (looksLikeBundleId(want)) return want; // a bundle id the list doesn't hold: let the phone say
  const near = apps.filter((a) => a.installed === true).map((a) => a.name).slice(0, 12).join(', ');
  throw new HttpError(404, `no app named ${JSON.stringify(want)} on this phone${near ? ` (it has: ${near}...)` : ''}`);
}
