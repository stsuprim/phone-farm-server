import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { numbered } from './files.js';
import { LandAnswer, LandAsk, PhoneAway, PhoneFiles, PhoneFilesState, readCan } from './phonefiles.js';

/** How a mock phone is now (tests change it). */
export interface MockFilesPhone {
  status: 'authorized' | 'denied' | 'notDetermined' | 'restricted';
  photosKey: boolean;
  shared: boolean;
  free: number;
  /** The phone can't be reached. */
  away: boolean;
  /** A piece takes this long, and putting a file in its place (ms). */
  pieceMs: number;
  landMs: number;
  /** A file starting with this is one Photos can't take. */
  refuses: string;
  /** Put the wrong bytes on the phone this many times (a file that doesn't match its hash). */
  spoil: number;
}

/**
 * The mock phones' side of a send: into a temp folder, as the real build does it (wda/LOTUS.md, FBLotusCommands.inc):
 * `<dir>/<udid>/Photos` and `<dir>/<udid>/Files`, unfinished ones in `<dir>/<udid>/tmp`.
 */
export class MockFiles implements PhoneFiles {
  private made?: string;
  private phones = new Map<string, MockFilesPhone>();
  /** What reached the phone, in order, without names (tests): "begin", "put 4", "photos", "files", "dir", "drop", "ask". */
  readonly log: string[] = [];

  constructor(private base?: string, private there: (udid: string) => boolean = () => true) {}

  root(): string {
    return (this.made ??= this.base ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mock-phone-files-')));
  }
  at(udid: string, ...p: string[]): string {
    return path.join(this.root(), udid, ...p);
  }
  phone(udid: string): MockFilesPhone {
    let p = this.phones.get(udid);
    if (!p) this.phones.set(udid, (p = { status: 'authorized', photosKey: true, shared: true, free: 64 * 1024 ** 3, away: false, pieceMs: 0, landMs: 0, refuses: 'REFUSE', spoil: 0 }));
    return p;
  }
  private live(udid: string): MockFilesPhone {
    const p = this.phone(udid);
    if (p.away || !this.there(udid)) throw new PhoneAway("the phone can't be reached right now");
    return p;
  }

  async can(udid: string): Promise<PhoneFilesState> {
    const p = this.phone(udid);
    if (p.away || !this.there(udid)) return { photos: { ok: false, why: 'the phone is not connected' }, files: { ok: false, why: 'the phone is not connected', folder: 'Lotus' }, away: true };
    return readCan({ photos: { key: p.photosKey, status: p.status }, files: { shared: p.shared, folder: 'Lotus' }, free: p.free });
  }

  async ask(udid: string): Promise<void> {
    this.live(udid);
    this.log.push('ask');
  }

  async begin(udid: string, id: string, size: number): Promise<number> {
    this.live(udid);
    this.log.push('begin');
    if (fs.existsSync(this.at(udid, 'tmp', `${id}.done`))) return size;
    fs.mkdirSync(this.at(udid, 'tmp'), { recursive: true });
    const f = this.at(udid, 'tmp', id);
    if (!fs.existsSync(f) || fs.statSync(f).size > size) fs.writeFileSync(f, '');
    return fs.statSync(f).size;
  }

  async put(udid: string, id: string, offset: number, data: Buffer, signal?: AbortSignal): Promise<number> {
    const p = this.live(udid);
    if (p.pieceMs) await new Promise((r) => setTimeout(r, p.pieceMs));
    if (signal?.aborted) throw new PhoneAway('stopped');
    const f = this.at(udid, 'tmp', id);
    const have = fs.statSync(f).size;
    if (have !== offset) return have;
    const b = Buffer.from(data);
    if (p.spoil > 0 && offset === 0 && b.length) {
      p.spoil--;
      b[0] = b[0]! ^ 0xff;
    }
    fs.appendFileSync(f, b);
    this.log.push(`put ${b.length}`);
    return have + b.length;
  }

  async land(udid: string, id: string, ask: LandAsk): Promise<LandAnswer> {
    const p = this.live(udid);
    const note = this.at(udid, 'tmp', `${id}.done`);
    if (fs.existsSync(note)) return JSON.parse(fs.readFileSync(note, 'utf8'));
    if (p.landMs) await new Promise((r) => setTimeout(r, p.landMs));
    const f = this.at(udid, 'tmp', id);
    const data = fs.existsSync(f) ? fs.readFileSync(f) : null;
    if (!data || data.length !== ask.size || crypto.createHash('sha256').update(data).digest('hex') !== ask.sha256) return { refused: 'what reached the phone is not the file', again: true };
    let a: LandAnswer;
    const date = ask.mtime && ask.mtime > 0 ? ask.mtime / 1000 : Date.now() / 1000;
    if (ask.where === 'photos') {
      if (p.status !== 'authorized') return { refused: 'Photos refused it' };
      if (!data.subarray(0, p.refuses.length).equals(Buffer.from(p.refuses))) {
        this.place(udid, 'Photos', ask.name, f, date);
        a = { where: 'Photos' };
        this.log.push('photos');
      } else if (!ask.fallback) return { refused: "Photos can't take this file (its format or codec)" };
      else a = { where: 'Files', path: `Lotus/${this.place(udid, 'Files', ask.rel, f, date)}`, why: "Photos can't take this file (its format or codec): it is in Files" };
    } else {
      a = { where: 'Files', path: `Lotus/${this.place(udid, 'Files', ask.rel, f, date)}` };
    }
    if (a.where === 'Files') this.log.push('files');
    fs.writeFileSync(note, JSON.stringify(a));
    return a;
  }

  async dir(udid: string, _op: string, rel: string, unique: boolean): Promise<string> {
    this.live(udid);
    this.log.push('dir');
    const cut = rel.lastIndexOf('/');
    const parent = cut < 0 ? '' : rel.slice(0, cut + 1);
    const name = rel.slice(cut + 1);
    let out = rel;
    for (let n = 2; unique && fs.existsSync(this.at(udid, 'Files', out)); n++) out = parent + numbered(name, n, true);
    fs.mkdirSync(this.at(udid, 'Files', out), { recursive: true });
    return out;
  }

  async drop(udid: string, id: string): Promise<void> {
    this.live(udid);
    this.log.push('drop');
    fs.rmSync(this.at(udid, 'tmp', id), { force: true });
  }

  close(): void {
    if (this.made && !this.base) fs.rmSync(this.made, { recursive: true, force: true });
    this.made = undefined;
  }

  /** Into its place under a free name; never over another file. Its path there. */
  private place(udid: string, where: string, rel: string, from: string, date: number): string {
    const cut = rel.lastIndexOf('/');
    const parent = cut < 0 ? '' : rel.slice(0, cut + 1);
    fs.mkdirSync(this.at(udid, where, parent), { recursive: true });
    let out = rel;
    for (let n = 2; fs.existsSync(this.at(udid, where, out)); n++) out = parent + numbered(rel.slice(cut + 1), n);
    fs.renameSync(from, this.at(udid, where, out));
    fs.utimesSync(this.at(udid, where, out), date, date);
    return out;
  }
}
