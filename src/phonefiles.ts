// The phone's side of a send (2026-11-24): what a backend can do with a file for a phone (our WebDriverAgent build v6
// and later, wda/LOTUS.md), and the real one, which talks to the phone's /lotus/files routes on connections of its own:
// they answer off WebDriverAgent's main queue, so a file never waits for a touch and a touch never waits for a file.
// Names and contents are never logged or put in an error.
import http from 'node:http';
import { HttpError } from './types.js';

/** The first version of our WebDriverAgent build with the /lotus/files routes. */
export const FILES_FORK_VERSION = 6;
export const FILES_ROUTES = {
  can: '/lotus/files/can', ask: '/lotus/files/ask', begin: '/lotus/files/begin', put: '/lotus/files/put',
  land: '/lotus/files/land', dir: '/lotus/files/dir', drop: '/lotus/files/drop',
} as const;

/** What a phone takes now. `ask`: Photos takes it once the phone's own permission prompt is answered. `why`: plain words. */
export interface PhoneFilesState {
  photos: { ok: boolean; why?: string; ask?: boolean };
  files: { ok: boolean; why?: string; folder: string };
  freeBytes?: number;
  /** The phone can't be asked at all right now (offline, its control link starting): a send waits rather than fails. */
  away?: boolean;
}

/** How one whole file that's on the phone is put in its place. */
export interface LandAsk {
  where: 'photos' | 'files';
  /** Photos refused it: into Files, with the reason said. */
  fallback: boolean;
  /** Its place in Files (the folders and the name, with "/"; cleaned). */
  rel: string;
  name: string;
  video: boolean;
  /** Its date on the PC (ms since the epoch). */
  mtime?: number;
  size: number;
  sha256: string;
}
export interface Landed {
  where: 'Photos' | 'Files';
  path?: string;
  why?: string;
}
/** `again`: what's on the phone isn't the file (it went, or differs): send it once more from the start (`files`: to Files, Photos didn't take it). */
export type LandAnswer = Landed | { refused: string; again?: boolean; files?: boolean };

/** The phone can't be reached now (offline, its control link restarting): the send waits and goes on. */
export class PhoneAway extends Error {}

export interface PhoneFiles {
  /** Never throws for a known phone. */
  can(udid: string): Promise<PhoneFilesState>;
  /** Shows the phone's own "add to Photos" prompt once (the control app comes to the front for it). */
  ask(udid: string): Promise<void>;
  /** How many bytes of this file the phone already holds. */
  begin(udid: string, id: string, size: number): Promise<number>;
  /** Bytes at `offset`: the phone's offset afterwards (its own one when `offset` was wrong). */
  put(udid: string, id: string, offset: number, data: Buffer, signal?: AbortSignal): Promise<number>;
  land(udid: string, id: string, ask: LandAsk): Promise<LandAnswer>;
  /** Makes a folder; `unique`: one that isn't there yet ("Name (2)" when taken). Its path as made. */
  dir(udid: string, op: string, rel: string, unique: boolean): Promise<string>;
  /** Forget an unfinished file. */
  drop(udid: string, id: string): Promise<void>;
  close?(): void;
}

export const NEEDS_UPDATE = `the phone's control app needs its update (v${FILES_FORK_VERSION}); the server installs it by itself`;
export const NO_PHOTOS_KEY = "the phone's control app was installed without its Photos text, so iOS gives it no Photos; it comes with the server's next build of it";
export const NO_SHARED_FOLDER = "the phone's control app was installed without a shared folder, so Files doesn't show one; it comes with the server's next build of it";
export const ASK_WHY = 'the first photo or video makes the phone ask once whether Lotus may add to Photos: tap "Allow" on the phone (the live view will do)';

/** What the phone's own answer to GET /lotus/files/can means. */
export function readCan(v: any): PhoneFilesState {
  const folder = typeof v?.files?.folder === 'string' && v.files.folder ? v.files.folder : 'Lotus';
  const status = String(v?.photos?.status ?? '');
  let photos: PhoneFilesState['photos'];
  if (v?.photos?.key !== true) photos = { ok: false, why: NO_PHOTOS_KEY };
  else if (status === 'authorized' || status === 'limited') photos = { ok: true };
  else if (status === 'notDetermined') photos = { ok: true, ask: true, why: ASK_WHY };
  else if (status === 'denied') photos = { ok: false, why: `Photos permission is off for ${folder} on the phone: turn it on in Settings > Privacy & Security > Photos > ${folder}` };
  else photos = { ok: false, why: 'Photos is closed on this phone (Screen Time or a profile restricts it)' };
  const files: PhoneFilesState['files'] = v?.files?.shared === true ? { ok: true, folder } : { ok: false, why: NO_SHARED_FOLDER, folder };
  const free = Number(v?.free);
  return { photos, files, ...(Number.isFinite(free) && free > 0 ? { freeBytes: free } : {}) };
}

/** Where a phone's control app listens now; `away`: not right now (it waits); `no`: it can't take files at all, and why. */
export type FilesTarget = { port: number; token?: string } | { away: string } | { no: string };

export interface RealFilesOptions {
  target: (udid: string) => FilesTarget;
  /** The prompt: through the phone's one request lane (it brings an app to the front). */
  ask: (udid: string) => Promise<void>;
  tokenHeader: string;
}

const ANSWER_MS = 20_000;
/** A big video is hashed, moved and taken over by Photos before the phone answers. */
const LAND_MS = 10 * 60_000;

export class RealFiles implements PhoneFiles {
  private agents = new Map<string, http.Agent>();

  constructor(private o: RealFilesOptions) {}

  private agent(udid: string): http.Agent {
    let a = this.agents.get(udid);
    if (!a) this.agents.set(udid, (a = new http.Agent({ keepAlive: true, maxSockets: 2 })));
    return a;
  }

  async can(udid: string): Promise<PhoneFilesState> {
    const none = (why: string, away: boolean): PhoneFilesState => ({ photos: { ok: false, why }, files: { ok: false, why, folder: 'Lotus' }, ...(away ? { away: true } : {}) });
    const t = this.o.target(udid);
    if ('away' in t) return none(t.away, true);
    if ('no' in t) return none(t.no, false);
    try {
      return readCan(await this.call(udid, 'GET', FILES_ROUTES.can, undefined, 8000));
    } catch (err) {
      return none((err as Error).message, err instanceof PhoneAway);
    }
  }

  ask(udid: string): Promise<void> {
    return this.o.ask(udid);
  }

  async begin(udid: string, id: string, size: number): Promise<number> {
    return this.offset(await this.call(udid, 'POST', `${FILES_ROUTES.begin}?id=${id}`, { size }, ANSWER_MS));
  }

  async put(udid: string, id: string, offset: number, data: Buffer, signal?: AbortSignal): Promise<number> {
    return this.offset(await this.call(udid, 'POST', `${FILES_ROUTES.put}?id=${id}&offset=${offset}`, data, 30_000, signal));
  }

  async land(udid: string, id: string, ask: LandAsk): Promise<LandAnswer> {
    const v = await this.call(udid, 'POST', `${FILES_ROUTES.land}?id=${id}`, ask, LAND_MS);
    if (v?.where === 'Photos' || v?.where === 'Files') {
      return { where: v.where, ...(typeof v.path === 'string' ? { path: v.path } : {}), ...(typeof v.why === 'string' ? { why: v.why } : {}) };
    }
    return { refused: typeof v?.refused === 'string' ? v.refused : 'the phone gave no answer about the file', ...(v?.again === true ? { again: true } : {}), ...(v?.files === true ? { files: true } : {}) };
  }

  async dir(udid: string, op: string, rel: string, unique: boolean): Promise<string> {
    const v = await this.call(udid, 'POST', `${FILES_ROUTES.dir}?id=${op}`, { rel, unique }, ANSWER_MS);
    if (typeof v?.rel !== 'string' || !v.rel) throw new HttpError(502, 'the phone could not make the folder');
    return v.rel;
  }

  async drop(udid: string, id: string): Promise<void> {
    await this.call(udid, 'POST', `${FILES_ROUTES.drop}?id=${id}`, {}, 8000);
  }

  close(): void {
    for (const a of this.agents.values()) a.destroy();
    this.agents.clear();
  }

  private offset(v: any): number {
    const n = Number(v?.offset);
    if (!Number.isInteger(n) || n < 0) throw new HttpError(502, 'the phone gave no place to go on from');
    return n;
  }

  /** One request, straight to the phone's control app. Its `value`; PhoneAway when it can't be reached. */
  private call(udid: string, method: string, path: string, body: unknown, timeout: number, signal?: AbortSignal): Promise<any> {
    const t = this.o.target(udid);
    if ('away' in t) return Promise.reject(new PhoneAway(t.away));
    if ('no' in t) return Promise.reject(new HttpError(501, t.no));
    const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: t.port, method, path, agent: this.agent(udid), signal,
        headers: {
          ...(t.token ? { [this.o.tokenHeader]: t.token } : {}),
          ...(raw ? { 'content-length': raw.length, 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', () => reject(new PhoneAway('the phone stopped answering')));
        res.on('end', () => {
          let v: any;
          try {
            v = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.value;
          } catch {
            v = undefined;
          }
          if ((res.statusCode ?? 0) < 300 && v && typeof v === 'object' && !v.error) return resolve(v);
          if (v?.error === 'unknown command') return reject(new HttpError(501, NEEDS_UPDATE));
          // never the phone's own words: they can hold a path
          reject(new HttpError(502, `the phone's control app refused a part of the file (HTTP ${res.statusCode})`));
        });
      });
      const timer = setTimeout(() => req.destroy(new Error('timeout')), timeout);
      req.on('close', () => clearTimeout(timer));
      req.on('error', () => reject(new PhoneAway("the phone can't be reached right now")));
      req.on('socket', (s) => s.setNoDelay(true));
      req.end(raw);
    });
  }
}
