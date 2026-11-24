// Sending files to a phone (2026-11-24, research/lotus-app/phones-send-brief.md): the PC's Lotus uploads in pieces into
// a private folder on this Mac, each whole file is checked and then goes to the phone (src/phonefiles.ts) one at a
// time, in order, slower while someone touches or watches that phone. Photos and videos into Photos, the rest and whole
// folders into Files. Nothing on the phone is overwritten; names and contents are never logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { LandAsk, PhoneAway, PhoneFiles, PhoneFilesState } from './phonefiles.js';
import { HttpError } from './types.js';

export const UPLOAD_CHUNK = 4 * 1024 * 1024;
/** The most one send (a batch, else a file) may be. */
export const MAX_SEND_BYTES = 50 * 1024 ** 3;
/** This much of the Mac's disk stays free whatever waits here. */
export const KEEP_FREE_BYTES = 5 * 1024 ** 3;
/** The phone keeps this much free. */
export const PHONE_KEEP_FREE_BYTES = 300 * 1024 ** 2;
export const KEEP_MS = 24 * 3600_000;
/** Uploads known at once (a send is at most 20,000 files). */
export const MAX_UPLOADS = 60_000;
export const MAX_PART_BYTES = 255;
export const MAX_DEPTH = 32;

// ---- names ----

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Marks that only change how a name is drawn (text direction): left out, so a name is what it looks like. */
const DIRECTION = /[؜‎‏‪-‮⁦-⁩﻿]/g;

/** One part of a path: a name that's safe on the phone, or a 400 (which never says the name). */
export function cleanPart(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'a name must be text');
  if (CONTROL.test(v)) throw new HttpError(400, 'a name has control characters');
  const s = v.normalize('NFC').replace(DIRECTION, '').trim();
  if (!s || s === '.' || s === '..') throw new HttpError(400, 'a name is empty, "." or ".."');
  if (/[/\\:]/.test(s)) throw new HttpError(400, 'a name has "/", "\\" or ":"');
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)) throw new HttpError(400, 'a name is not valid text');
  if (Buffer.byteLength(s) > MAX_PART_BYTES) throw new HttpError(400, `a name is longer than ${MAX_PART_BYTES} bytes`);
  return s;
}

/** A path inside a sent folder: parts with "/", never out of it. */
export function cleanRel(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, '"rel" must be a path with "/"');
  const parts = v.split('/');
  if (parts.length > MAX_DEPTH) throw new HttpError(400, `the path is deeper than ${MAX_DEPTH} folders`);
  return parts.map(cleanPart).join('/');
}

/** "name.ext" as "name (n).ext" (n from 2); a folder's dots are part of its name. */
export function numbered(name: string, n: number, folder = false): string {
  if (n < 2) return name;
  const dot = folder ? -1 : name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 17 ? name.slice(dot) : '';
  let stem = ext ? name.slice(0, dot) : name;
  const end = ` (${n})${ext}`;
  while (stem && Buffer.byteLength(stem) + Buffer.byteLength(end) > MAX_PART_BYTES) stem = Array.from(stem).slice(0, -1).join('');
  return stem + end;
}

const PHOTO_EXT = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'dng']);
const VIDEO_EXT = new Set(['mov', 'mp4', 'm4v']);
/** Pictures and videos Photos never takes as they are: they go to Files, and it's said. */
const OTHER_MEDIA = new Set(['webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'ogv', 'tif', 'tiff', 'bmp', 'svg', 'avif', 'jxl', 'psd', 'ico', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2']);

export function mediaKind(name: string): 'photo' | 'video' | 'other-media' | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return PHOTO_EXT.has(ext) ? 'photo' : VIDEO_EXT.has(ext) ? 'video' : OTHER_MEDIA.has(ext) ? 'other-media' : null;
}

export type SendTo = 'auto' | 'photos' | 'files';
export type Plan = { where: 'photos' | 'files'; fallback: boolean; why?: string } | { ask: true } | { fail: string };

/** Where a file goes on a phone that takes `can`. `inFolder`: part of a sent folder (its pictures too go to Files). */
export function planFor(to: SendTo, name: string, inFolder: boolean, can: PhoneFilesState): Plan {
  const kind = mediaKind(name);
  const files = (why?: string): Plan => (can.files.ok ? { where: 'files', fallback: false, ...(why ? { why } : {}) } : { fail: why ? `${why}; and Files: ${can.files.why ?? 'not available'}` : can.files.why ?? 'Files is not available on this phone' });
  if (to === 'files' || (to === 'auto' && inFolder)) return files();
  const media = kind === 'photo' || kind === 'video';
  if (!media) {
    if (to === 'photos') return { fail: 'Photos does not take this kind of file' };
    return files(kind === 'other-media' ? 'Photos does not take this kind of picture or video: it is in Files' : undefined);
  }
  if (can.photos.ask) return { ask: true };
  if (can.photos.ok) return { where: 'photos', fallback: to === 'auto' && can.files.ok };
  const why = can.photos.why ?? 'Photos is not available on this phone';
  return to === 'photos' ? { fail: why } : files(`${why}: it is in Files`);
}

// ---- the uploads ----

export type UploadState = 'receiving' | 'queued' | 'sending' | 'done' | 'failed' | 'cancelled';
const OVER = new Set<UploadState>(['done', 'failed', 'cancelled']);

interface Upload {
  id: string;
  udid: string;
  key: string;
  folder: boolean;
  name: string;
  /** The place in Files; for a file on its own its name. */
  rel: string;
  inFolder: boolean;
  size: number;
  mtime?: number;
  to: SendTo;
  batch?: string;
  state: UploadState;
  offset: number;
  sent: number;
  sha256?: string;
  landed?: { where: 'Photos' | 'Files'; path?: string };
  why?: string;
  at: number;
  touched: number;
  seq: number;
  // in memory only
  hash?: { h: crypto.Hash; n: number };
  writing?: { req: http.IncomingMessage; end: Promise<void> };
  finishing?: Promise<void>;
  abort?: AbortController;
  working?: Promise<void>;
  cancelled?: boolean;
  landing?: boolean;
  tries: number;
  again: number;
  notBefore: number;
}

export interface UploadView {
  id: string;
  state: UploadState;
  offset: number;
  size: number;
  sent: number;
  landed?: { where: 'Photos' | 'Files'; path?: string };
  why?: string;
}

/** How busy a phone is with its people: a file goes slower then. */
export interface Pressure {
  /** A touch or key of the last moment, or one on its way. */
  touch: boolean;
  /** Someone watches it live. */
  live: boolean;
}

export interface FileSendsOptions {
  dir: string;
  phone: PhoneFiles;
  /** Its phones (404 for one it doesn't know). */
  known: (udid: string) => Promise<{ online: boolean; name: string }>;
  pressure?: (udid: string) => Pressure;
  /** Before the Photos prompt: the phone awake. */
  wake?: (udid: string) => Promise<unknown>;
  chunk?: number;
  maxBytes?: number;
  keepFree?: number;
  /** A piece to the phone, and the rate while it's watched (bytes a second). */
  phoneChunk?: number;
  liveRate?: number;
  askWaitMs?: number;
  keepMs?: number;
  retryMs?: number;
  /** The Mac's free disk (tests). */
  free?: () => Promise<number>;
  now?: () => number;
  sweepMs?: number;
  log?: (m: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isId = (v: string) => /^[0-9a-f]{32}$/.test(v);
const PLACES = 'places.json';

export class FileSends {
  readonly chunk: number;
  private all = new Map<string, Upload>();
  private byKey = new Map<string, string>();
  /** A batch's top folder as it was made on the phone ("Trip" -> "Trip (2)"): `udid batch top` -> name. */
  private places: Record<string, { name: string; at: number }> = {};
  private workers = new Map<string, Promise<void>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private asks = new Map<string, { at: number; over?: boolean }>();
  private cans = new Map<string, { at: number; v: PhoneFilesState }>();
  private seq = 0;
  private closed = false;
  private sweepTimer?: NodeJS.Timeout;
  private now: () => number;
  private log: (m: string) => void;

  constructor(private o: FileSendsOptions) {
    this.chunk = o.chunk ?? UPLOAD_CHUNK;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[files] ${m}`));
    fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(o.dir, 0o700);
    } catch {
      /* not ours to change */
    }
    this.load();
    const every = o.sweepMs ?? 10 * 60_000;
    if (every > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), every);
      this.sweepTimer.unref();
    }
  }

  // ---- what a phone takes ----

  async can(udid: string, fresh = false): Promise<PhoneFilesState> {
    const was = this.cans.get(udid);
    if (was && !fresh && this.now() - was.at < 3000) return was.v;
    const v = await this.o.phone.can(udid);
    this.cans.set(udid, { at: this.now(), v });
    return v;
  }

  /** GET files/can. */
  async canView(udid: string): Promise<Record<string, unknown>> {
    const p = await this.o.known(udid);
    const v: PhoneFilesState = p.online
      ? await this.can(udid, true)
      : { photos: { ok: false, why: `${p.name} is offline` }, files: { ok: false, why: `${p.name} is offline`, folder: 'Lotus' }, away: true };
    return {
      ok: v.photos.ok || v.files.ok, photos: v.photos, files: v.files, ...(v.away ? { away: true } : {}),
      maxBytes: this.o.maxBytes ?? MAX_SEND_BYTES, roomBytes: await this.room(), ...(v.freeBytes !== undefined ? { freeBytes: v.freeBytes } : {}), chunk: this.chunk,
    };
  }

  private async free(): Promise<number> {
    if (this.o.free) return this.o.free();
    const s = await fs.promises.statfs(this.o.dir);
    return Number(s.bavail) * Number(s.bsize);
  }

  /** What's still to come of the uploads known. */
  private reserved(): number {
    let n = 0;
    for (const u of this.all.values()) if (u.state === 'receiving') n += u.size - u.offset;
    return n;
  }

  /** What the Mac's disk takes right now (more as files land and leave it). */
  private async room(): Promise<number> {
    return Math.max(0, Math.floor((await this.free()) - (this.o.keepFree ?? KEEP_FREE_BYTES) - this.reserved()));
  }

  // ---- the API ----

  /** POST files/uploads. */
  async create(udid: string, body: Record<string, unknown>): Promise<UploadView & { chunk: number }> {
    await this.o.known(udid);
    const name = cleanPart(body.name);
    const relAsked = body.rel === undefined || body.rel === null || body.rel === '' ? null : cleanRel(body.rel);
    const inFolder = relAsked !== null;
    const rel = relAsked ?? name;
    const size = body.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new HttpError(400, '"size" must be a whole number of bytes');
    const to = body.to ?? 'auto';
    if (to !== 'auto' && to !== 'photos' && to !== 'files') throw new HttpError(400, '"to" must be "auto", "photos" or "files"');
    const key = body.key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:+/=-]{8,200}$/.test(key)) throw new HttpError(400, '"key" must be 8-200 plain characters');
    const batch = this.batchOf(body.batch);
    let mtime: number | undefined;
    if (body.mtime !== undefined && body.mtime !== null) {
      if (typeof body.mtime !== 'number' || !Number.isFinite(body.mtime)) throw new HttpError(400, '"mtime" must be a time in ms');
      // seconds are taken too (anything before 1973 in ms is one)
      mtime = Math.round(body.mtime < 1e11 ? body.mtime * 1000 : body.mtime);
    }

    const was = this.find(udid, key);
    if (was && was.size === size) {
      // the same send again: the unfinished upload goes on; a finished one only for the batch that sent it
      if (!OVER.has(was.state) && was.rel === rel && was.to === to && was.inFolder === inFolder) {
        if (batch && was.batch !== batch) {
          was.batch = batch;
          this.save(was);
        }
        return { ...this.view(was), chunk: this.chunk };
      }
      if (was.state === 'done' && batch && was.batch === batch) return { ...this.view(was), chunk: this.chunk };
      if (was.state === 'receiving') this.end(was, 'cancelled', 'sent again another way');
    } else if (was && was.state === 'receiving') this.end(was, 'cancelled', 'the file changed on the PC');

    const most = this.o.maxBytes ?? MAX_SEND_BYTES;
    if (size + this.batchBytes(udid, batch) > most) throw new HttpError(413, 'the send is larger than this server takes', { maxBytes: most });
    const room = await this.room();
    if (size > room) throw new HttpError(507, "the phone server's disk is too full for it", { roomBytes: room });
    const can = await this.can(udid).catch(() => null);
    if (can && !can.away) {
      const plan = planFor(to, name, inFolder, can);
      if ('fail' in plan) throw new HttpError(415, plan.fail, { can: false });
      if (can.freeBytes !== undefined && size + PHONE_KEEP_FREE_BYTES > can.freeBytes) throw new HttpError(507, 'the phone is too full for it', { freeBytes: can.freeBytes });
    }
    if (was && OVER.has(was.state) && was.batch === batch) this.forget(was); // a retry: the new one stands for it
    const u = this.add({ udid, key, folder: false, name, rel, inFolder, size, mtime, to, batch });
    fs.closeSync(fs.openSync(this.part(u.id), 'w', 0o600));
    this.save(u);
    return { ...this.view(u), chunk: this.chunk };
  }

  /** A batch's bytes so far (its failed and cancelled ones left out). */
  private batchBytes(udid: string, batch: string | undefined): number {
    let n = 0;
    if (batch) for (const u of this.all.values()) if (u.batch === batch && u.udid === udid && u.state !== 'failed' && u.state !== 'cancelled') n += u.size;
    return n;
  }

  private forget(u: Upload): void {
    this.all.delete(u.id);
    if (this.byKey.get(`${u.udid} ${u.key}`) === u.id) this.byKey.delete(`${u.udid} ${u.key}`);
    fs.rmSync(this.meta(u.id), { force: true });
  }

  /** POST files/folder: an empty folder, in its turn with the files. */
  async folder(udid: string, body: Record<string, unknown>): Promise<UploadView> {
    await this.o.known(udid);
    const rel = cleanRel(body.rel);
    const batch = this.batchOf(body.batch);
    const key = `folder ${batch ?? ''} ${crypto.createHash('sha256').update(rel).digest('hex')}`;
    const was = batch ? this.find(udid, key) : undefined;
    if (was && was.state !== 'failed' && was.state !== 'cancelled') return this.view(was);
    const u = this.add({ udid, key, folder: true, name: rel.split('/').pop()!, rel, inFolder: true, size: 0, to: 'files', batch });
    u.state = 'queued';
    this.save(u);
    this.kick(udid);
    return this.view(u);
  }

  /** PUT files/uploads/:id?offset=N: the piece goes to disk as it comes. */
  async put(udid: string, id: string, offset: number, req: http.IncomingMessage): Promise<{ offset: number; size: number }> {
    const u = this.get(udid, id);
    if (u.state !== 'receiving' || u.finishing) throw new HttpError(409, `the upload is ${u.finishing ? 'being checked' : u.state}`, { state: u.state, offset: u.offset });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.chunk) throw new HttpError(413, `a piece is at most ${this.chunk} bytes`, { chunk: this.chunk, offset: u.offset });
    if (u.writing) {
      // an earlier piece whose link died without a word: it ends now, and what came of it stays
      u.writing.req.destroy();
      await u.writing.end;
    }
    // the wait above may have moved on
    if (u.state !== 'receiving' || u.finishing || u.writing) throw new HttpError(409, 'another piece of this upload came meanwhile', { offset: u.offset });
    if (!Number.isSafeInteger(offset) || offset !== u.offset) throw new HttpError(409, 'the upload goes on from another place', { offset: u.offset });
    if (Number.isFinite(declared) && offset + declared > u.size) throw new HttpError(400, 'more bytes than the file has', { offset: u.offset });
    let done!: () => void;
    u.writing = { req, end: new Promise<void>((r) => (done = r)) };
    let f: fs.promises.FileHandle | undefined;
    try {
      f = await fs.promises.open(this.part(id), 'r+');
      if (!u.hash && offset === 0) u.hash = { h: crypto.createHash('sha256'), n: 0 };
      let took = 0;
      for await (const c of req) {
        const b = c as Buffer;
        took += b.length;
        if (took > this.chunk) throw new HttpError(413, `a piece is at most ${this.chunk} bytes`, { chunk: this.chunk });
        if (u.offset + b.length > u.size) throw new HttpError(400, 'more bytes than the file has');
        if (u.cancelled || this.closed) throw new HttpError(409, 'the upload was cancelled', { state: 'cancelled' });
        let at = 0;
        while (at < b.length) at += (await f.write(b, at, b.length - at, u.offset + at)).bytesWritten;
        if (u.hash?.n === u.offset) {
          u.hash.h.update(b);
          u.hash.n += b.length;
        } else u.hash = undefined;
        u.offset += b.length;
        u.touched = this.now();
      }
      return { offset: u.offset, size: u.size };
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(err.status, err.message, { ...(err.extra ?? {}), offset: u.offset });
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC') throw new HttpError(507, "the phone server's disk is full", { offset: u.offset });
      if (code === 'ENOENT') {
        this.end(u, 'failed', 'what had arrived of it is gone: send it again');
        throw new HttpError(404, 'unknown upload');
      }
      // the link went in the middle: what came stays, the PC asks for the offset and goes on
      throw new HttpError(400, 'the piece broke off', { offset: u.offset });
    } finally {
      await f?.close().catch(() => {});
      u.writing = undefined;
      done();
    }
  }

  /** POST files/uploads/:id/finish {sha256}: checked, then queued for the phone. */
  async finish(udid: string, id: string, body: Record<string, unknown>): Promise<UploadView> {
    const u = this.get(udid, id);
    const sha = typeof body.sha256 === 'string' ? body.sha256.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, '"sha256" must be 64 hex digits');
    if (u.finishing) await u.finishing.catch(() => {});
    if (u.state !== 'receiving') return this.view(u);
    if (u.writing || u.offset !== u.size) throw new HttpError(409, 'the file is not whole yet', { offset: u.offset });
    const check = this.check(u, sha);
    u.finishing = check;
    try {
      await check;
    } finally {
      u.finishing = undefined;
    }
    return this.view(u);
  }

  private async check(u: Upload, sha: string): Promise<void> {
    let got: string;
    if (u.hash?.n === u.size) got = u.hash.h.digest('hex');
    else {
      const h = crypto.createHash('sha256');
      for await (const c of fs.createReadStream(this.part(u.id), { highWaterMark: 1 << 20 })) h.update(c as Buffer);
      got = h.digest('hex');
    }
    u.hash = undefined;
    if (u.cancelled || OVER.has(u.state)) return;
    if (got !== sha) {
      await fs.promises.truncate(this.part(u.id), 0);
      u.offset = 0;
      throw new HttpError(422, 'what arrived is not the file that was sent: send it again from the start', { offset: 0 });
    }
    u.sha256 = sha;
    u.state = 'queued';
    u.seq = ++this.seq;
    u.touched = this.now();
    this.save(u);
    this.kick(u.udid);
  }

  status(udid: string, id: string): UploadView {
    return this.view(this.get(udid, id));
  }

  /**
   * GET files/uploads?batch=: how many are in which state, and each (`brief`: none; `after`: only those that changed
   * since the `now` of an earlier answer).
   */
  batch(udid: string, batch: string, opts: { brief?: boolean; after?: number } = {}): Record<string, unknown> {
    const b = this.batchOf(batch);
    if (!b) throw new HttpError(400, '"batch" is needed');
    const list = this.inBatch(udid, b);
    const counts: Record<string, number> = {};
    for (const u of list) counts[u.state] = (counts[u.state] ?? 0) + 1;
    const shown = opts.brief ? [] : opts.after ? list.filter((u) => u.touched >= opts.after!) : list;
    return { batch: b, now: this.now(), count: list.length, counts, uploads: shown.map((u) => this.view(u)) };
  }

  /** DELETE files/uploads/:id. One being put in its place can't be taken back: its end is waited for and said. */
  async cancel(udid: string, id: string): Promise<UploadView> {
    const u = this.get(udid, id);
    await this.stop(u);
    return this.view(u);
  }

  async cancelBatch(udid: string, batch: string): Promise<Record<string, unknown>> {
    const b = this.batchOf(batch);
    if (!b) throw new HttpError(400, '"batch" is needed');
    const list = this.inBatch(udid, b);
    // the waiting ones first, so none of them starts meanwhile
    for (const u of list) if (!OVER.has(u.state) && u.state !== 'sending') await this.stop(u);
    for (const u of list) if (!OVER.has(u.state)) await this.stop(u);
    const landed = list.filter((u) => u.state === 'done' && !u.folder);
    return {
      batch: b, cancelled: list.filter((u) => u.state === 'cancelled').length,
      landed: { photos: landed.filter((u) => u.landed?.where === 'Photos').length, files: landed.filter((u) => u.landed?.where === 'Files').length },
    };
  }

  private async stop(u: Upload): Promise<void> {
    if (OVER.has(u.state)) return;
    u.cancelled = true;
    u.writing?.req.destroy();
    await u.writing?.end;
    await u.finishing?.catch(() => {});
    if (u.working) {
      if (!u.landing) u.abort?.abort();
      await Promise.race([u.working, sleep(20_000)]);
      if (OVER.has(u.state)) return;
      if (u.landing) return; // still being put in its place: the state says how it ended
    }
    this.end(u, 'cancelled');
    if (u.sent > 0) void this.o.phone.drop(u.udid, u.id).catch(() => {});
  }

  private inBatch(udid: string, batch: string): Upload[] {
    return [...this.all.values()].filter((u) => u.udid === udid && u.batch === batch);
  }

  private batchOf(v: unknown): string | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(v)) throw new HttpError(400, '"batch" must be 1-100 plain characters');
    return v;
  }

  private find(udid: string, key: string): Upload | undefined {
    const id = this.byKey.get(`${udid} ${key}`);
    return id ? this.all.get(id) : undefined;
  }

  private get(udid: string, id: string): Upload {
    const u = isId(id) ? this.all.get(id) : undefined;
    if (!u || u.udid !== udid) throw new HttpError(404, 'unknown upload');
    return u;
  }

  private add(v: Pick<Upload, 'udid' | 'key' | 'folder' | 'name' | 'rel' | 'inFolder' | 'size' | 'mtime' | 'to' | 'batch'>): Upload {
    if (this.all.size >= MAX_UPLOADS) throw new HttpError(503, 'too many files are waiting here: try again later');
    const at = this.now();
    const u: Upload = { ...v, id: crypto.randomBytes(16).toString('hex'), state: 'receiving', offset: 0, sent: 0, at, touched: at, seq: ++this.seq, tries: 0, again: 0, notBefore: 0 };
    this.all.set(u.id, u);
    this.byKey.set(`${u.udid} ${u.key}`, u.id);
    return u;
  }

  private view(u: Upload): UploadView {
    return {
      id: u.id, state: u.state, offset: u.offset, size: u.size, sent: u.sent,
      ...(u.landed ? { landed: u.landed } : {}), ...(u.why ? { why: u.why } : {}),
    };
  }

  // ---- on the Mac's disk ----

  private part(id: string): string {
    return path.join(this.o.dir, `${id}.part`);
  }
  private meta(id: string): string {
    return path.join(this.o.dir, `${id}.json`);
  }

  private save(u: Upload): void {
    const over = OVER.has(u.state);
    // one that's over keeps no name here: only what a question about it needs
    const v = {
      id: u.id, udid: u.udid, key: u.key, batch: u.batch, state: u.state, size: u.size, at: u.at, touched: u.touched, seq: u.seq, why: u.why, folder: u.folder,
      ...(over
        ? { landed: u.landed ? { where: u.landed.where } : undefined, sent: u.sent, offset: u.offset }
        : { name: u.name, rel: u.rel, inFolder: u.inFolder, mtime: u.mtime, to: u.to, sha256: u.sha256 }),
    };
    this.write(this.meta(u.id), v);
  }

  private write(file: string, v: unknown): void {
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(v), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.log(`could not save an upload's state (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }

  private load(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.o.dir);
    } catch {
      return;
    }
    try {
      const p = JSON.parse(fs.readFileSync(path.join(this.o.dir, PLACES), 'utf8'));
      if (p && typeof p === 'object') this.places = p;
    } catch {
      /* none */
    }
    const kept = new Set<string>();
    for (const n of names) {
      const id = /^([0-9a-f]{32})\.json$/.exec(n)?.[1];
      if (!id) continue;
      try {
        const j = JSON.parse(fs.readFileSync(this.meta(id), 'utf8'));
        if (j.id !== id || typeof j.udid !== 'string' || typeof j.key !== 'string') throw new Error('bad');
        const over = OVER.has(j.state);
        const u: Upload = {
          id, udid: j.udid, key: j.key, folder: j.folder === true, name: over ? '' : cleanPart(j.name), rel: over ? '' : cleanRel(j.rel), inFolder: j.inFolder === true,
          size: Number(j.size) || 0, mtime: Number.isFinite(j.mtime) ? j.mtime : undefined, to: j.to ?? 'files', batch: typeof j.batch === 'string' ? j.batch : undefined,
          state: j.state === 'sending' ? 'queued' : j.state, offset: Number(j.offset) || 0, sent: Number(j.sent) || 0, sha256: typeof j.sha256 === 'string' ? j.sha256 : undefined,
          landed: j.landed, why: typeof j.why === 'string' ? j.why : undefined, at: Number(j.at) || this.now(), touched: Number(j.touched) || Number(j.at) || this.now(), seq: Number(j.seq) || 0,
          tries: 0, again: 0, notBefore: 0,
        };
        if (!over && !u.folder) {
          const have = fs.statSync(this.part(id)).size;
          if (have > u.size || (u.state === 'queued' && have !== u.size)) throw new Error('bad');
          u.offset = have;
        }
        this.all.set(id, u);
        this.byKey.set(`${u.udid} ${u.key}`, id);
        this.seq = Math.max(this.seq, u.seq);
        if (!over) kept.add(`${id}.part`);
        kept.add(`${id}.json`);
      } catch {
        /* unreadable: left out, and deleted below */
      }
    }
    for (const n of names) if (n !== PLACES && !kept.has(n) && /^[0-9a-f]{32}\.|\.tmp$/.test(n)) fs.rmSync(path.join(this.o.dir, n), { force: true });
    for (const udid of new Set([...this.all.values()].filter((u) => u.state === 'queued').map((u) => u.udid))) this.kick(udid, 3000);
  }

  private end(u: Upload, state: 'done' | 'failed' | 'cancelled', why?: string): void {
    if (OVER.has(u.state)) return;
    u.state = state;
    u.why = why;
    u.touched = this.now();
    u.hash = undefined;
    fs.rmSync(this.part(u.id), { force: true });
    this.save(u);
  }

  /** Every ten minutes: what's 24 h old goes. */
  async sweep(): Promise<void> {
    const old = this.now() - (this.o.keepMs ?? KEEP_MS);
    for (const u of [...this.all.values()]) {
      if (u.touched > old) continue;
      if (!OVER.has(u.state)) {
        if (u.landing) continue;
        u.cancelled = true;
        u.writing?.req.destroy();
        u.abort?.abort();
        await u.working?.catch(() => {});
        this.end(u, 'failed', 'it waited here for a day and was deleted: send it again');
        if (u.sent > 0) void this.o.phone.drop(u.udid, u.id).catch(() => {});
        continue;
      }
      this.forget(u);
    }
    let gone = false;
    for (const [k, p] of Object.entries(this.places)) {
      if (p.at > old) continue;
      delete this.places[k];
      gone = true;
    }
    if (gone) this.write(path.join(this.o.dir, PLACES), this.places);
  }

  // ---- to the phone: one file at a time, in order ----

  private kick(udid: string, inMs = 0): void {
    if (this.closed) return;
    const t = this.timers.get(udid);
    if (t) clearTimeout(t);
    this.timers.delete(udid);
    if (inMs > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(udid);
        this.kick(udid);
      }, inMs);
      timer.unref();
      this.timers.set(udid, timer);
      return;
    }
    if (this.workers.has(udid)) return;
    const w = this.work(udid)
      .catch((err) => this.log(`${udid.slice(-8)}: the queue stopped (${(err as Error).name})`))
      .finally(() => {
        this.workers.delete(udid);
        if (this.closed) return;
        const next = this.nextAt(udid);
        if (next !== null) this.kick(udid, Math.max(50, next - this.now()));
      });
    this.workers.set(udid, w);
  }

  private *waiting(udid: string): Iterable<Upload> {
    for (const u of this.all.values()) if (u.udid === udid && u.state === 'queued' && !u.cancelled) yield u;
  }

  private nextAt(udid: string): number | null {
    let at: number | null = null;
    for (const u of this.waiting(udid)) if (at === null || u.notBefore < at) at = u.notBefore;
    return at;
  }

  /** The first in order whose time has come. */
  private first(udid: string): Upload | undefined {
    const now = this.now();
    let best: Upload | undefined;
    for (const u of this.waiting(udid)) if (u.notBefore <= now && (!best || u.seq < best.seq)) best = u;
    return best;
  }

  private async work(udid: string): Promise<void> {
    // a moment, so a worker is known before its first file starts
    await Promise.resolve();
    for (;;) {
      if (this.closed) return;
      const u = this.first(udid);
      if (!u) return;
      const w = this.sendOne(u);
      u.working = w;
      await w;
      u.working = undefined;
    }
  }

  private async sendOne(u: Upload): Promise<void> {
    u.state = 'sending';
    u.abort = new AbortController();
    try {
      await this.transfer(u);
    } catch (err) {
      if (u.cancelled) {
        this.end(u, 'cancelled');
        void this.o.phone.drop(u.udid, u.id).catch(() => {});
      } else if (this.closed) {
        u.state = 'queued';
      } else if (err instanceof PhoneAway) {
        // 0.5 s, 1, 2, ... 60 s; it waits here up to a day
        const wait = Math.min(60_000, (this.o.retryMs ?? 500) * 2 ** Math.min(u.tries++, 10));
        u.state = 'queued';
        u.why = `waiting for the phone: ${err.message}`;
        u.notBefore = this.now() + wait;
        // the rest of this phone's files wait with it
        for (const x of this.waiting(u.udid)) x.notBefore = Math.max(x.notBefore, u.notBefore);
      } else if (err instanceof HttpError) {
        this.end(u, 'failed', err.message);
        if (u.sent > 0) void this.o.phone.drop(u.udid, u.id).catch(() => {});
      } else {
        this.end(u, 'failed', 'the phone server could not read the file it kept');
        this.log(`${u.udid.slice(-8)}: a file failed here (${(err as NodeJS.ErrnoException).code ?? (err as Error).name})`);
      }
    } finally {
      u.abort = undefined;
      u.landing = false;
    }
  }

  private check0(u: Upload): void {
    if (u.cancelled || this.closed) throw new Error('stopped');
  }

  private async transfer(u: Upload): Promise<void> {
    const phone = this.o.phone;
    const can = await this.can(u.udid, true);
    this.check0(u);
    if (can.away) throw new PhoneAway(can.files.why ?? "the phone can't be reached right now");
    if (u.folder) {
      if (!can.files.ok) throw new HttpError(409, can.files.why ?? 'Files is not available on this phone');
      const rel = await this.placeOf(u);
      const made = rel === u.rel || rel.includes('/') ? await phone.dir(u.udid, u.id, rel, false) : rel;
      u.landed = { where: 'Files', path: `${can.files.folder}/${made}` };
      return this.end(u, 'done');
    }
    if (!can.photos.ask) this.asks.delete(u.udid);
    let plan = planFor(u.to, u.name, u.inFolder, can);
    if ('ask' in plan) {
      const answered = await this.askPhotos(u);
      if (!answered) return;
      plan = planFor(u.to, u.name, u.inFolder, await this.can(u.udid, true));
      if ('ask' in plan) throw new PhoneAway('the Photos permission changed meanwhile');
    }
    if ('fail' in plan) throw new HttpError(409, plan.fail);
    this.check0(u);
    for (;;) {
      await this.stream(u);
      this.check0(u);
      const rel = plan.where === 'files' ? await this.placeOf(u) : u.rel;
      const ask: LandAsk = {
        where: plan.where, fallback: plan.fallback, rel, name: u.name, video: mediaKind(u.name) === 'video',
        ...(u.mtime !== undefined ? { mtime: u.mtime } : {}), size: u.size, sha256: u.sha256!,
      };
      this.check0(u);
      u.landing = true;
      const a = await phone.land(u.udid, u.id, ask);
      u.landing = false;
      if ('refused' in a) {
        if (a.again && u.again++ < 2) {
          if (a.files) plan = { where: 'files', fallback: false, why: `${a.refused}: it is in Files` };
          u.sent = 0;
          this.check0(u);
          await phone.drop(u.udid, u.id);
          continue;
        }
        throw new HttpError(409, a.refused);
      }
      u.landed = { where: a.where, ...(a.path ? { path: a.path } : {}) };
      u.sent = u.size;
      return this.end(u, 'done', a.why ?? plan.why);
    }
  }

  /** The file, piece by piece, off this disk onto the phone. */
  private async stream(u: Upload): Promise<void> {
    let at = await this.o.phone.begin(u.udid, u.id, u.size);
    if (at > u.size) throw new HttpError(502, 'the phone holds something else for this file');
    u.sent = at;
    const f = await fs.promises.open(this.part(u.id), 'r');
    const buf = Buffer.allocUnsafe(this.o.phoneChunk ?? 1024 * 1024);
    let back = 0;
    try {
      while (at < u.size) {
        this.check0(u);
        const t0 = this.now();
        await this.giveWay(u);
        const { bytesRead } = await f.read(buf, 0, Math.min(buf.length, u.size - at), at);
        if (!bytesRead) throw new HttpError(409, 'the file kept here is cut short');
        const to = await this.o.phone.put(u.udid, u.id, at, buf.subarray(0, bytesRead), u.abort!.signal);
        if (to !== at + bytesRead && (++back > 3 || to > u.size)) throw new HttpError(502, 'the phone lost its place in the file');
        at = to;
        u.sent = at;
        u.tries = 0;
        u.why = undefined;
        u.touched = this.now();
        const p = this.o.pressure?.(u.udid);
        // watched: the picture's share of the cable comes first
        if (p?.live) await sleep(Math.min(2000, Math.max(0, (bytesRead / (this.o.liveRate ?? 8 * 1024 * 1024)) * 1000 - (this.now() - t0))));
      }
    } finally {
      await f.close().catch(() => {});
    }
  }

  /** A touch on its way or a moment ago goes first (a file waits at most 2 s a piece). */
  private async giveWay(u: Upload): Promise<void> {
    const until = this.now() + 2000;
    while (this.o.pressure?.(u.udid).touch && this.now() < until && !u.cancelled && !this.closed) await sleep(40);
  }

  /** Where it goes in Files: the batch's top folder under a name that was free when its first file landed. */
  private async placeOf(u: Upload): Promise<string> {
    const cut = u.rel.indexOf('/');
    const top = u.folder && cut < 0 ? u.rel : cut > 0 ? u.rel.slice(0, cut) : null;
    if (!top || !u.batch) return u.rel;
    const key = `${u.udid} ${u.batch} ${crypto.createHash('sha256').update(top).digest('hex')}`;
    let p = this.places[key];
    if (!p) {
      p = this.places[key] = { name: await this.o.phone.dir(u.udid, `t${u.id}`, top, true), at: this.now() };
      this.write(path.join(this.o.dir, PLACES), this.places);
    }
    p.at = this.now();
    return p.name + u.rel.slice(top.length);
  }

  /**
   * The phone's own Photos prompt: shown once, then this file waits (others that don't need Photos go on) until it's
   * answered, or a few minutes passed. True: answered.
   */
  private async askPhotos(u: Upload): Promise<boolean> {
    if (!(await this.can(u.udid, true)).photos.ask) {
      this.asks.delete(u.udid);
      return true;
    }
    let a = this.asks.get(u.udid);
    if (a?.over && u.at > a.at) a = undefined; // sent after the last one went unanswered: asked again
    const now = this.now();
    if (!a) {
      await this.o.wake?.(u.udid).catch(() => {});
      await this.o.phone.ask(u.udid);
      this.asks.set(u.udid, (a = { at: now }));
    }
    if (a.over || now - a.at > (this.o.askWaitMs ?? 3 * 60_000)) {
      if (!a.over) this.asks.set(u.udid, { at: now, over: true });
      throw new HttpError(409, 'the phone asked whether Lotus may add to Photos and nobody answered: tap "Allow" on the phone, then send it again');
    }
    u.state = 'queued';
    u.why = 'waiting for "Allow" on the phone: Lotus asks there once whether it may add to Photos';
    u.notBefore = now + Math.min(1500, (this.o.askWaitMs ?? 180_000) / 4);
    return false;
  }

  /** Stops here; what isn't done waits on disk for the next start. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const u of this.all.values()) {
      u.writing?.req.destroy();
      if (!u.landing) u.abort?.abort();
    }
    await Promise.race([Promise.all(this.workers.values()), sleep(3000)]);
    this.o.phone.close?.();
  }
}
