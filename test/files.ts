// Sending files to a phone (2026-11-24): names and paths, where a file goes, uploads that resume, the checks, the queue
// to the phone, the Photos prompt, cancel, restarts, and how our WebDriverAgent build is asked. No Mac, no phone: the
// mock lands files in a temp folder, and a fake WebDriverAgent answers the /lotus/files routes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { cleanPart, cleanRel, FileSends, FileSendsOptions, mediaKind, numbered, planFor, Pressure } from '../src/files.js';
import { MockBackend } from '../src/mock.js';
import { ASK_WHY, FILES_ROUTES, FilesTarget, NEEDS_UPDATE, NO_PHOTOS_KEY, NO_SHARED_FOLDER, PhoneAway, PhoneFilesState, readCan, RealFiles } from '../src/phonefiles.js';
import { createServer } from '../src/server.js';
import { HttpError } from '../src/types.js';

let passed = 0;
const origLog = console.log;
const logs: string[] = [];
for (const k of ['log', 'error', 'warn'] as const) console[k] = (...a: unknown[]) => void logs.push(a.join(' '));
const ok = (name: string) => {
  passed++;
  origLog(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(10);
  }
  return false;
};
const bad = (status: number, re?: RegExp) => (e: unknown) => e instanceof HttpError && e.status === status && (!re || re.test(e.message));
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const TOKEN = 't'.repeat(40);

// ---- names and paths ----
{
  assert.equal(cleanPart('Ferien 2026.jpg'), 'Ferien 2026.jpg');
  assert.equal(cleanPart('e\u0301.txt'), '\u00e9.txt', 'one way to write a letter');
  assert.equal(cleanPart('invoice\u202egpj.exe'), 'invoicegpj.exe', 'a name is what it looks like');
  assert.equal(cleanPart('\u{1F468}\u200d\u{1F469}.png'), '\u{1F468}\u200d\u{1F469}.png', 'emoji stay');
  assert.equal(cleanPart('x'.repeat(255)).length, 255);
  for (const v of ['', ' ', '.', '..', ' .. ', 'a/b', 'a\\b', 'C:', 'a\u0000b', 'a\nb', 'a\u007fb', 'a\u0085b', 'x'.repeat(256), '\u00e9'.repeat(128), '\ud800', 5, null, undefined, {}]) {
    assert.throws(() => cleanPart(v), bad(400), JSON.stringify(v));
  }
  assert.throws(() => cleanPart('secret\nname'), (e: HttpError) => !/secret/.test(e.message), 'a refusal never says the name');
  assert.equal(cleanRel('Trip/day 1/a.jpg'), 'Trip/day 1/a.jpg');
  assert.equal(cleanRel(Array(32).fill('d').join('/')).split('/').length, 32);
  for (const v of ['', '/etc/passwd', '../x', 'a/../b', 'a/./b', 'a//b', 'a/', '~/../x/..', 'a\\..\\b', 'C:/x', 'a/\u0000', 'a/\u202e../b'.replace('\u202e', '\u0001'), 'a/\u202e..', Array(33).fill('d').join('/'), 5, null]) {
    assert.throws(() => cleanRel(v), bad(400), JSON.stringify(v));
  }
  assert.deepEqual([numbered('a.jpg', 1), numbered('a.jpg', 2), numbered('a.tar.gz', 3), numbered('noext', 2), numbered('.env', 2), numbered('Trip v1.2', 2, true)],
    ['a.jpg', 'a (2).jpg', 'a.tar (3).gz', 'noext (2)', '.env (2)', 'Trip v1.2 (2)']);
  const long = numbered(`${'\u00e9'.repeat(126)}.jpg`, 12);
  assert.ok(Buffer.byteLength(long) <= 255 && long.endsWith(' (12).jpg'));
  ok('names: cleaned, never out of the folder, numbered within 255 bytes');
}

// ---- where it goes ----
{
  const all: PhoneFilesState = { photos: { ok: true }, files: { ok: true, folder: 'Lotus' } };
  const noPhotos: PhoneFilesState = { ...all, photos: { ok: false, why: 'Photos is off' } };
  const noFiles: PhoneFilesState = { ...all, files: { ok: false, why: 'no folder', folder: 'Lotus' } };
  assert.deepEqual(['a.JPG', 'b.heic', 'c.webp', 'd.dng', 'e.mov', 'f.MP4', 'g.m4v', 'h.mkv', 'i.webm', 'j.pdf', 'k', 'l.gif'].map(mediaKind),
    ['photo', 'photo', 'photo', 'photo', 'video', 'video', 'video', 'other-media', 'other-media', null, null, 'photo']);
  assert.deepEqual(planFor('auto', 'a.jpg', false, all), { where: 'photos', fallback: true });
  assert.deepEqual(planFor('auto', 'a.jpg', true, all), { where: 'files', fallback: false }, 'a picture inside a folder stays with it');
  assert.deepEqual(planFor('photos', 'a.jpg', true, all), { where: 'photos', fallback: false });
  assert.deepEqual(planFor('files', 'a.jpg', false, all), { where: 'files', fallback: false });
  assert.deepEqual(planFor('auto', 'a.pdf', false, noPhotos), { where: 'files', fallback: false });
  assert.match((planFor('auto', 'a.mkv', false, all) as { why: string }).why, /it is in Files/);
  assert.match((planFor('photos', 'a.pdf', false, all) as { fail: string }).fail, /Photos does not take/);
  assert.deepEqual(planFor('auto', 'a.jpg', false, noPhotos), { where: 'files', fallback: false, why: 'Photos is off: it is in Files' });
  assert.deepEqual(planFor('photos', 'a.jpg', false, noPhotos), { fail: 'Photos is off' });
  assert.deepEqual(planFor('auto', 'a.jpg', false, noFiles), { where: 'photos', fallback: false }, 'Photos works while Files does not');
  assert.deepEqual(planFor('auto', 'a.pdf', false, noFiles), { fail: 'no folder' });
  assert.deepEqual(planFor('auto', 'a.jpg', false, { ...all, photos: { ok: true, ask: true } }), { ask: true });
  assert.ok(!('ask' in planFor('auto', 'a.pdf', false, { ...all, photos: { ok: true, ask: true } })), 'only a photo asks');
  // what the phone says
  const st = (status: string, key = true, shared = true) => readCan({ photos: { key, status }, files: { shared, folder: 'Lotus' }, free: 5e9 });
  assert.deepEqual(st('authorized'), { photos: { ok: true }, files: { ok: true, folder: 'Lotus' }, freeBytes: 5e9 });
  assert.deepEqual(st('notDetermined').photos, { ok: true, ask: true, why: ASK_WHY });
  assert.match(st('denied').photos.why!, /Settings > Privacy & Security > Photos > Lotus/);
  assert.match(st('restricted').photos.why!, /Screen Time/);
  assert.equal(st('authorized', false).photos.why, NO_PHOTOS_KEY);
  assert.deepEqual(st('authorized', true, false).files, { ok: false, why: NO_SHARED_FOLDER, folder: 'Lotus' });
  ok('where: photos and videos into Photos, the rest and folders into Files, each without the other');
}

// ---- the routes on the mock ----
type Api = (method: string, route: string, body?: unknown, raw?: Buffer) => Promise<{ status: number; body: any }>;
const start = async (o: Partial<FileSendsOptions> = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sends-'))) => {
  const backend = new MockBackend(4);
  const server = createServer(backend, TOKEN, undefined, { watchMs: 0, filesDir: dir, files: { retryMs: 30, sweepMs: 0, free: async () => 100 * 1024 ** 3, ...o } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const udid = (await backend.list())[0]!.udid;
  const api: Api = async (method, route, body, raw) => {
    const r = await fetch(`${base}${route.startsWith('/') ? route : `/phones/${udid}/files/${route}`}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': raw ? 'application/octet-stream' : 'application/json' },
      body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  let n = 0;
  const make = (name: string, data: Buffer, more: Record<string, unknown> = {}) => api('POST', 'uploads', { name, size: data.length, to: 'auto', key: `key${process.pid}${n++}xxxxxx`, ...more });
  /** A whole file: made, sent in pieces, finished. Its id. */
  const send = async (name: string, data: Buffer, more: Record<string, unknown> = {}): Promise<string> => {
    const c = await make(name, data, more);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    for (let at = 0; at < data.length; at += c.body.chunk) assert.equal((await api('PUT', `uploads/${c.body.id}?offset=${at}`, undefined, data.subarray(at, at + c.body.chunk))).status, 200);
    const f = await api('POST', `uploads/${c.body.id}/finish`, { sha256: sha(data) });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    return c.body.id;
  };
  const over = async (id: string) => {
    let v: any;
    assert.ok(await until(async () => ['done', 'failed', 'cancelled'].includes((v = (await api('GET', `uploads/${id}`)).body).state), 8000), JSON.stringify(v));
    return v;
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sleep(30);
    await backend.close();
  };
  return { backend, server, base, udid, api, make, send, over, stop, dir, phone: backend.files.phone(udid), at: (...p: string[]) => backend.files.at(udid, ...p) };
};
const left = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.part'));

{
  const t = await start({ chunk: 1000, phoneChunk: 700 });
  try {
    const can = (await t.api('GET', 'can')).body;
    assert.deepEqual([can.ok, can.photos, can.files, can.chunk], [true, { ok: true }, { ok: true, folder: 'Lotus' }, 1000]);
    assert.ok(can.maxBytes > 0 && can.freeBytes > 0);
    assert.equal((await t.api('GET', '/api/settings')).body.files, true, 'the server says it takes files');
    assert.equal((await fetch(`${t.base}/phones/${t.udid}/files/can`)).status, 401);
    assert.equal((await t.api('GET', '/phones/NOPE/files/can')).status, 404);
    assert.equal((await t.api('GET', `/api/devices/${t.udid}/files/can`)).status, 200, 'both paths');
    if (process.platform !== 'win32') assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);

    // a photo in pieces, byte for byte, its date kept
    const pic = crypto.randomBytes(2500);
    const when = Date.UTC(2021, 4, 6, 7, 8, 9);
    let id = await t.send('beach day.jpg', pic, { mtime: when });
    let v = await t.over(id);
    assert.deepEqual([v.state, v.landed, v.offset, v.sent, v.size, v.why], ['done', { where: 'Photos' }, 2500, 2500, 2500, undefined]);
    assert.ok(fs.readFileSync(t.at('Photos', 'beach day.jpg')).equals(pic));
    assert.equal(Math.round(fs.statSync(t.at('Photos', 'beach day.jpg')).mtimeMs), when);
    assert.equal(left(t.dir).length, 0, "the Mac's copy is gone once it landed");
    assert.ok(!fs.readdirSync(t.dir).some((f) => fs.readFileSync(path.join(t.dir, f), 'utf8').includes('beach')), 'and its name with it');
    assert.equal((await t.api('POST', `uploads/${id}/finish`, { sha256: sha(pic) })).body.state, 'done', 'asked again: the same answer');

    // a document, twice: nothing overwritten
    const doc = Buffer.from('a document');
    v = await t.over(await t.send('notes.pdf', doc));
    assert.deepEqual(v.landed, { where: 'Files', path: 'Lotus/notes.pdf' });
    v = await t.over(await t.send('notes.pdf', Buffer.from('another')));
    assert.equal(v.landed.path, 'Lotus/notes (2).pdf');
    assert.equal(fs.readFileSync(t.at('Files', 'notes.pdf'), 'utf8'), 'a document');
    // an empty file
    v = await t.over(await t.send('empty.txt', Buffer.alloc(0)));
    assert.deepEqual([v.state, v.landed.path], ['done', 'Lotus/empty.txt']);
    // one Photos can't take
    v = await t.over(await t.send('odd.mp4', Buffer.from('REFUSE av1')));
    assert.deepEqual([v.state, v.landed.where], ['done', 'Files']);
    assert.match(v.why, /Photos can't take .*it is in Files/);
    v = await t.over(await t.send('odd.mp4', Buffer.from('REFUSE av1'), { to: 'photos' }));
    assert.deepEqual([v.state, v.landed], ['failed', undefined]);
    v = await t.over(await t.send('film.mkv', Buffer.from('mkv')));
    assert.deepEqual([v.landed.where, /Photos does not take/.test(v.why)], ['Files', true]);

    // a folder with its structure, an empty one too; sent again it's "Trip (2)" as a whole
    for (const [batch, top] of [['b1', 'Trip'], ['b2', 'Trip (2)']] as const) {
      const a = await t.send('a.jpg', Buffer.from('pa'), { rel: 'Trip/day 1/a.jpg', batch });
      const b = await t.send('b.txt', Buffer.from('tb'), { rel: 'Trip/b.txt', batch });
      const e = await t.api('POST', 'folder', { rel: 'Trip/nothing here', batch });
      assert.equal(e.status, 200);
      assert.equal((await t.api('POST', 'folder', { rel: 'Trip/nothing here', batch })).body.id, e.body.id, 'asked again: the same');
      for (const x of [a, b, e.body.id]) assert.equal((await t.over(x)).state, 'done');
      assert.equal(fs.readFileSync(t.at('Files', top, 'day 1', 'a.jpg'), 'utf8'), 'pa');
      assert.equal(fs.readFileSync(t.at('Files', top, 'b.txt'), 'utf8'), 'tb');
      assert.ok(fs.statSync(t.at('Files', top, 'nothing here')).isDirectory());
      const l = (await t.api('GET', `uploads?batch=${batch}`)).body;
      assert.deepEqual([l.count, l.counts], [3, { done: 3 }]);
      assert.equal((await t.api('GET', `uploads?batch=${batch}&brief=1`)).body.uploads.length, 0);
      assert.equal((await t.api('GET', `uploads?batch=${batch}&after=${Date.now() + 1000}`)).body.uploads.length, 0);
    }
    assert.ok(!fs.existsSync(t.at('Files', 'Trip (2)', 'b (2).txt')));

    // bad requests
    for (const [name, more] of [['../x', {}], ['a/b', {}], ['x.txt', { rel: '../../x.txt' }], ['x.txt', { rel: '/x.txt' }], ['x.txt', { size: -1 }], ['x.txt', { size: 1.5 }], ['x.txt', { to: 'mail' }], ['x.txt', { key: 'short' }], ['x.txt', { batch: 'a b' }], ['x.txt', { mtime: 'now' }]] as const) {
      assert.equal((await t.make(name, doc, more as Record<string, unknown>)).status, 400, `${name} ${JSON.stringify(more)}`);
    }
    for (const [m, r, s] of [['GET', 'uploads/zz', 404], ['PUT', `uploads/${'0'.repeat(32)}?offset=0`, 404], ['POST', 'can', 405], ['GET', 'folder', 405], ['GET', 'uploads', 400], ['PATCH', 'uploads', 405], ['GET', `uploads/..%2f..%2fx`, 404]] as const) {
      assert.equal((await t.api(m, r, m === 'GET' ? undefined : {})).status, s, `${m} ${r}`);
    }
    const other = (await t.backend.list())[1]!.udid;
    assert.equal((await t.api('GET', `/phones/${other}/files/uploads/${id}`)).status, 404, "another phone's upload");
    const off = (await t.backend.list())[3]!.udid;
    const oc = (await t.api('GET', `/phones/${off}/files/can`)).body;
    assert.deepEqual([oc.ok, oc.away, /offline/.test(oc.photos.why)], [false, true, true]);
    ok('sends: Photos and Files, byte for byte, dates kept, taken names numbered, folders whole, refusals plain');
  } finally {
    await t.stop();
  }
}

// ---- uploads: resume, the offset, the checks ----
{
  const t = await start({ chunk: 1000 });
  try {
    const data = crypto.randomBytes(2300);
    const key = 'resume-key-1';
    const c = (await t.make('r.bin', data, { key })).body;
    assert.deepEqual([c.state, c.offset, c.chunk], ['receiving', 0, 1000]);
    assert.equal((await t.api('PUT', `uploads/${c.id}?offset=0`, undefined, data.subarray(0, 1000))).body.offset, 1000);
    let r = await t.api('PUT', `uploads/${c.id}?offset=0`, undefined, data.subarray(0, 1000));
    assert.deepEqual([r.status, r.body.offset], [409, 1000], 'the wrong place: the right one is said');
    r = await t.api('PUT', `uploads/${c.id}?offset=2000`, undefined, data.subarray(2000));
    assert.deepEqual([r.status, r.body.offset], [409, 1000]);
    r = await t.api('PUT', `uploads/${c.id}`, undefined, data.subarray(0, 10));
    assert.equal(r.status, 409);
    r = await t.api('PUT', `uploads/${c.id}?offset=1000`, undefined, crypto.randomBytes(1001));
    assert.deepEqual([r.status, r.body.chunk], [413, 1000]);
    r = await t.api('POST', `uploads/${c.id}/finish`, { sha256: sha(data) });
    assert.deepEqual([r.status, r.body.offset], [409, 1000], 'not whole yet');
    // the same key: the unfinished one
    const again = (await t.make('r.bin', data, { key })).body;
    assert.deepEqual([again.id, again.offset], [c.id, 1000]);
    // a link that dies in the middle of a piece: what came stays
    await new Promise<void>((done) => {
      const req = http.request(`${t.base}/phones/${t.udid}/files/uploads/${c.id}?offset=1000`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-length': 1000 } });
      req.on('error', () => done());
      req.write(data.subarray(1000, 1400), () => setTimeout(() => req.destroy(), 80));
      req.on('close', () => done());
    });
    let at = 0;
    assert.ok(await until(async () => (at = (await t.api('GET', `uploads/${c.id}`)).body.offset) === 1400), `${at}`);
    assert.equal((await t.api('PUT', `uploads/${c.id}?offset=1400`, undefined, data.subarray(1400))).body.offset, 2300);
    r = await t.api('PUT', `uploads/${c.id}?offset=2300`, undefined, Buffer.from('x'));
    assert.equal(r.status, 400, 'more than the file has');
    assert.equal((await t.api('POST', `uploads/${c.id}/finish`, { sha256: 'nope' })).status, 400);
    // not the file that was sent: from the start
    r = await t.api('POST', `uploads/${c.id}/finish`, { sha256: sha(Buffer.from('other')) });
    assert.deepEqual([r.status, r.body.offset], [422, 0]);
    assert.equal((await t.api('GET', `uploads/${c.id}`)).body.state, 'receiving');
    for (let p = 0; p < data.length; p += 1000) await t.api('PUT', `uploads/${c.id}?offset=${p}`, undefined, data.subarray(p, p + 1000));
    assert.equal((await t.api('POST', `uploads/${c.id}/finish`, { sha256: sha(data).toUpperCase() })).status, 200);
    assert.equal((await t.over(c.id)).state, 'done');
    assert.ok(fs.readFileSync(t.at('Files', 'r.bin')).equals(data));
    // landed: the same key without its batch is a new send; with the same batch it's the one that landed
    assert.notEqual((await t.make('r.bin', data, { key })).body.id, c.id);
    const b1 = (await t.make('s.bin', Buffer.alloc(0), { key: 'batch-key-1', batch: 'B' })).body.id;
    await t.api('POST', `uploads/${b1}/finish`, { sha256: sha(Buffer.alloc(0)) });
    await t.over(b1);
    assert.equal((await t.make('s.bin', Buffer.alloc(0), { key: 'batch-key-1', batch: 'B' })).body.id, b1);
    assert.notEqual((await t.make('s.bin', Buffer.alloc(0), { key: 'batch-key-1', batch: 'C' })).body.id, b1);
    // a retry of a failed one in its batch: the new one stands for it
    t.phone.refuses = 'BAD';
    const f1 = (await t.make('f.mp4', Buffer.from('BAD'), { key: 'retry-key-1', batch: 'R', to: 'photos' })).body.id;
    await t.api('PUT', `uploads/${f1}?offset=0`, undefined, Buffer.from('BAD'));
    await t.api('POST', `uploads/${f1}/finish`, { sha256: sha(Buffer.from('BAD')) });
    assert.equal((await t.over(f1)).state, 'failed');
    assert.notEqual((await t.make('f.mp4', Buffer.from('BAD'), { key: 'retry-key-1', batch: 'R', to: 'photos' })).body.id, f1);
    assert.equal((await t.api('GET', 'uploads?batch=R')).body.count, 1);
    const gone = await t.api('GET', `uploads/${f1}`);
    assert.deepEqual([gone.status, gone.body.error], [404, 'unknown upload']);
    // two pieces of one upload at once: one wins, nothing is written twice
    const two = (await t.make('two.bin', data)).body;
    await Promise.all([0, 0].map(() => t.api('PUT', `uploads/${two.id}?offset=0`, undefined, data.subarray(0, 1000)).catch(() => null)));
    const tw = (await t.api('GET', `uploads/${two.id}`)).body.offset;
    assert.ok(tw <= 1000);
    for (let p = tw; p < data.length; ) p = (await t.api('PUT', `uploads/${two.id}?offset=${p}`, undefined, data.subarray(p, p + 1000))).body.offset;
    assert.equal((await t.api('POST', `uploads/${two.id}/finish`, { sha256: sha(data) })).status, 200);
    assert.equal((await t.over(two.id)).state, 'done');
    ok('uploads: the offset, resuming, a broken piece, the hash, the same key');
  } finally {
    await t.stop();
  }
}

// ---- too large, too full ----
{
  let free = 7 * 1024 ** 3;
  const t = await start({ free: async () => free, maxBytes: 3 * 1024 ** 3 });
  try {
    const ask = (size: number) => t.api('POST', 'uploads', { name: 'big.bin', size, to: 'files', key: `size-key-${size}` });
    const c0 = (await t.api('GET', 'can')).body;
    assert.deepEqual([c0.maxBytes, c0.roomBytes], [3 * 1024 ** 3, 2 * 1024 ** 3], 'the most a send may be; 5 GB of the Mac stay free');
    assert.equal((await ask(4 * 1024 ** 3)).status, 413);
    let r = await ask(2 * 1024 ** 3 + 1);
    assert.deepEqual([r.status, r.body.roomBytes], [507, 2 * 1024 ** 3]);
    assert.equal((await ask(1024 ** 3)).status, 200);
    assert.equal((await t.api('GET', 'can')).body.roomBytes, 1024 ** 3, "what's still to come counts");
    free = 4 * 1024 ** 3;
    assert.equal((await ask(1)).status, 507);
    free = 100 * 1024 ** 3;
    // the most counts for a whole batch
    const part = (n: number) => t.api('POST', 'uploads', { name: 'p.bin', size: 1024 ** 3, to: 'files', batch: 'BIG', key: `batch-part-${n}` });
    assert.deepEqual([(await part(1)).status, (await part(2)).status, (await part(3)).status, (await part(4)).status], [200, 200, 200, 413]);
    assert.equal((await part(3)).status, 200, 'one it already has is still its own');
    await t.api('DELETE', 'uploads?batch=BIG');
    t.phone.free = 500 * 1024 ** 2;
    await sleep(3100);
    r = await ask(400 * 1024 ** 2);
    assert.deepEqual([r.status, /phone is too full/.test(r.body.error)], [507, true]);
    ok('room: the most a file may be, 5 GB of the Mac and a little of the phone stay free');
  } finally {
    await t.stop();
  }
}

// ---- the phone: away, spoiled, the Photos permission ----
{
  const t = await start({ phoneChunk: 64, askWaitMs: 700 });
  try {
    // away: it waits and goes on by itself, from where the phone has it
    const data = crypto.randomBytes(640);
    t.phone.pieceMs = 15;
    const id = await t.send('away.bin', data);
    assert.ok(await until(async () => (await t.api('GET', `uploads/${id}`)).body.sent > 0));
    t.phone.away = true;
    assert.ok(await until(async () => /^waiting for the phone/.test((await t.api('GET', `uploads/${id}`)).body.why ?? '')));
    assert.equal((await t.api('GET', `uploads/${id}`)).body.state, 'queued');
    const sentBefore = (await t.api('GET', `uploads/${id}`)).body.sent;
    assert.ok(sentBefore > 0);
    t.phone.away = false;
    const v = await t.over(id);
    assert.deepEqual([v.state, v.why], ['done', undefined]);
    assert.ok(fs.readFileSync(t.at('Files', 'away.bin')).equals(data));
    assert.equal(t.backend.files.log.filter((l) => l.startsWith('put')).length, 10, 'each piece once');
    t.phone.pieceMs = 0;
    // what's on the phone isn't the file: once more from the start
    t.phone.spoil = 1;
    assert.equal((await t.over(await t.send('spoilt.bin', data))).state, 'done');
    assert.ok(fs.readFileSync(t.at('Files', 'spoilt.bin')).equals(data));
    t.phone.spoil = 99;
    assert.equal((await t.over(await t.send('spoilt2.bin', data))).state, 'failed');
    assert.ok(!fs.existsSync(t.at('Files', 'spoilt2.bin')));
    t.phone.spoil = 0;

    // Photos not asked yet: asked once, the photo waits, a document goes on meanwhile
    t.phone.status = 'notDetermined';
    const c = (await t.api('GET', 'can')).body;
    assert.deepEqual([c.ok, c.photos.ok, c.photos.ask], [true, true, true]);
    const p1 = await t.send('one.jpg', Buffer.from('p1'));
    const p2 = await t.send('two.jpg', Buffer.from('p2'));
    const d = await t.send('doc.txt', Buffer.from('d'));
    assert.equal((await t.over(d)).state, 'done', 'a document never waits for Photos');
    assert.match((await t.api('GET', `uploads/${p1}`)).body.why, /waiting for "Allow" on the phone/);
    t.phone.status = 'authorized';
    assert.deepEqual([(await t.over(p1)).landed, (await t.over(p2)).landed], [{ where: 'Photos' }, { where: 'Photos' }]);
    assert.equal(t.backend.files.log.filter((l) => l === 'ask').length, 1, 'asked once');
    // nobody answers: said, and a later send asks again
    t.phone.status = 'notDetermined';
    const p3 = await t.send('three.jpg', Buffer.from('p3'));
    const r3 = await t.over(p3);
    assert.deepEqual([r3.state, /nobody answered/.test(r3.why)], ['failed', true]);
    const p4 = await t.send('three.jpg', Buffer.from('p3'));
    await until(() => t.backend.files.log.filter((l) => l === 'ask').length === 3);
    assert.equal(t.backend.files.log.filter((l) => l === 'ask').length, 3);
    // refused on the phone: Files, with why
    t.phone.status = 'denied';
    const r4 = await t.over(p4);
    assert.deepEqual([r4.state, r4.landed.where], ['done', 'Files']);
    assert.match(r4.why, /Photos permission is off for Lotus on the phone.*it is in Files/);
    await sleep(3100);
    const no = await t.make('x.jpg', Buffer.from('x'), { to: 'photos' });
    assert.deepEqual([no.status, /permission is off/.test(no.body.error)], [415, true], 'said before a byte is sent');
    // Files not there, Photos is
    t.phone.status = 'authorized';
    t.phone.shared = false;
    const half = (await t.api('GET', 'can')).body;
    assert.deepEqual([half.ok, half.photos.ok, half.files.ok, half.files.why], [true, true, false, NO_SHARED_FOLDER]);
    assert.deepEqual((await t.over(await t.send('only.jpg', Buffer.from('o')))).landed, { where: 'Photos' });
    assert.equal((await t.make('x.txt', Buffer.from('x'))).status, 415);
    ok('phone: away and back, spoiled once, the Photos prompt once, refused, Photos without Files');
  } finally {
    await t.stop();
  }
}

// ---- cancel, order, giving way ----
{
  let pressure: Pressure = { touch: false, live: false };
  const t = await start({ phoneChunk: 100, pressure: () => pressure, liveRate: 1000 });
  try {
    t.phone.pieceMs = 20;
    const big = await t.send('big.bin', crypto.randomBytes(5000), { batch: 'X' });
    const small = await t.send('small.bin', Buffer.from('s'), { batch: 'X' });
    const rec = (await t.make('rec.bin', Buffer.from('later'), { batch: 'X' })).body.id;
    assert.ok(await until(async () => (await t.api('GET', `uploads/${big}`)).body.sent > 200));
    assert.equal((await t.api('GET', `uploads/${small}`)).body.state, 'queued', 'one at a time, in order');
    let r = (await t.api('DELETE', `uploads/${big}`)).body;
    assert.equal(r.state, 'cancelled');
    assert.equal((await t.over(small)).state, 'done');
    assert.ok(!fs.existsSync(t.at('Files', 'big.bin')));
    assert.ok(await until(() => !fs.readdirSync(t.at('tmp')).includes(big)), "the phone's part is gone");
    const b2 = await t.send('big2.bin', crypto.randomBytes(5000), { batch: 'X' });
    await until(async () => (await t.api('GET', `uploads/${b2}`)).body.sent > 0);
    r = (await t.api('DELETE', 'uploads?batch=X')).body;
    assert.deepEqual([r.cancelled, r.landed], [3, { photos: 0, files: 1 }], 'what landed stays, and is said');
    assert.equal((await t.api('GET', `uploads/${rec}`)).body.state, 'cancelled');
    assert.ok(fs.existsSync(t.at('Files', 'small.bin')));
    assert.equal(left(t.dir).length, 0);
    assert.equal((await t.api('PUT', `uploads/${rec}?offset=0`, undefined, Buffer.from('later'))).status, 409);
    // one being put in its place can't be taken back: it's waited for and said
    t.phone.pieceMs = 0;
    t.phone.landMs = 250;
    const l = await t.send('landing.bin', Buffer.from('l'));
    await until(() => t.backend.files.log.at(-1) === 'put 1');
    await sleep(60);
    assert.equal((await t.api('DELETE', `uploads/${l}`)).body.state, 'done');
    t.phone.landMs = 0;
    // a touch goes first (a piece waits), a watched phone gets its share
    pressure = { touch: true, live: false };
    const g = await t.send('g.bin', crypto.randomBytes(100));
    await sleep(250);
    assert.equal((await t.api('GET', `uploads/${g}`)).body.sent, 0, 'the piece waits for the touch');
    pressure = { touch: false, live: true };
    assert.equal((await t.over(g)).state, 'done');
    const t0 = Date.now();
    await t.over(await t.send('slow.bin', crypto.randomBytes(500)));
    assert.ok(Date.now() - t0 >= 400, 'slower while it is watched');
    ok('cancel: one, a batch, one landing; one at a time; touches first, slower while watched');
  } finally {
    await t.stop();
  }
}

// ---- a restart of the server, and a day ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sends-'));
  const data = crypto.randomBytes(3000);
  let t = await start({ chunk: 1000 }, dir);
  t.phone.away = true;
  const half = (await t.make('half.bin', data, { key: 'half-key-1' })).body.id;
  await t.api('PUT', `uploads/${half}?offset=0`, undefined, data.subarray(0, 1000));
  const whole = await t.send('whole.bin', data);
  await t.stop();
  fs.writeFileSync(path.join(dir, `${'a'.repeat(32)}.part`), 'an orphan');
  t = await start({ chunk: 1000 }, dir);
  try {
    assert.ok(!fs.existsSync(path.join(dir, `${'a'.repeat(32)}.part`)));
    assert.equal((await t.over(whole)).state, 'done', 'a queued one goes on by itself');
    assert.ok(fs.readFileSync(t.at('Files', 'whole.bin')).equals(data));
    const c = (await t.make('half.bin', data, { key: 'half-key-1' })).body;
    assert.deepEqual([c.id, c.offset], [half, 1000]);
    for (let p = 1000; p < 3000; p += 1000) await t.api('PUT', `uploads/${half}?offset=${p}`, undefined, data.subarray(p, p + 1000));
    assert.equal((await t.api('POST', `uploads/${half}/finish`, { sha256: sha(data) })).status, 200, 'hashed whole, though the first piece came before');
    assert.equal((await t.over(half)).state, 'done');
  } finally {
    await t.stop();
  }
  // a day
  let now = Date.now();
  const b = new MockBackend(1);
  const u = (await b.list())[0]!.udid;
  const s = new FileSends({ dir, phone: b.files, known: async () => ({ online: true, name: 'x' }), sweepMs: 0, now: () => now, free: async () => 1e12, retryMs: 10 });
  const old = await s.create(u, { name: 'old.bin', size: 10, to: 'auto', key: 'old-key-1' });
  now += 25 * 3600_000;
  await s.sweep();
  assert.match(s.status(u, old.id).why!, /waited here for a day/);
  assert.equal(left(dir).length, 0);
  now += 25 * 3600_000;
  await s.sweep();
  assert.throws(() => s.status(u, old.id), bad(404));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'places.json'), []);
  await s.close();
  await b.close();
  ok('a restart goes on where it was; a day later it is gone');
}

// ---- our WebDriverAgent build, as it is asked ----
{
  const hits: { method: string; url: string; token: unknown; body: Buffer }[] = [];
  const answers: Record<string, (body: Buffer, q: URLSearchParams) => unknown> = {
    [FILES_ROUTES.can]: () => ({ lotus: 6, photos: { key: true, status: 'authorized' }, files: { shared: true, folder: 'Lotus' }, free: 1e9 }),
    [FILES_ROUTES.begin]: () => ({ offset: 2 }),
    [FILES_ROUTES.put]: (b, q) => ({ offset: Number(q.get('offset')) + b.length }),
    [FILES_ROUTES.land]: () => ({ where: 'Files', path: 'Lotus/x', why: 'because' }),
    [FILES_ROUTES.dir]: () => ({ rel: 'Trip (2)' }),
    [FILES_ROUTES.drop]: () => ({ dropped: true }),
  };
  let unknown = false;
  const wda = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const body = Buffer.concat(chunks);
      hits.push({ method: req.method!, url: req.url!, token: req.headers['x-lotus-token'], body });
      const a = answers[url.pathname];
      const v = unknown || !a ? { error: 'unknown command', message: '/private/secret name.jpg' } : a(body, url.searchParams);
      res.writeHead(unknown || !a ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: v }));
    });
  });
  await new Promise<void>((r) => wda.listen(0, '127.0.0.1', r));
  let target: FilesTarget = { port: (wda.address() as AddressInfo).port, token: 'T' };
  let asked = 0;
  const f = new RealFiles({ target: () => target, ask: async () => void asked++, tokenHeader: 'x-lotus-token' });
  assert.deepEqual(await f.can('U'), { photos: { ok: true }, files: { ok: true, folder: 'Lotus' }, freeBytes: 1e9 });
  assert.equal(await f.begin('U', 'id1', 9), 2);
  const bytes = Buffer.from([0, 255, 10, 13, 123]);
  assert.equal(await f.put('U', 'id1', 2, bytes), 7);
  assert.deepEqual(await f.land('U', 'id1', { where: 'files', fallback: false, rel: 'a/secret.bin', name: 'secret.bin', video: false, size: 7, sha256: 'x' }), { where: 'Files', path: 'Lotus/x', why: 'because' });
  assert.equal(await f.dir('U', 'op1', 'Trip', true), 'Trip (2)');
  await f.drop('U', 'id1');
  await f.ask('U');
  assert.equal(asked, 1);
  assert.ok(hits.every((h) => h.token === 'T'), 'the token on every request');
  assert.ok(hits.find((h) => h.url === '/lotus/files/put?id=id1&offset=2')!.body.equals(bytes), 'raw bytes');
  assert.ok(hits.every((h) => !h.url.includes('secret')), 'no name in a URL');
  answers[FILES_ROUTES.land] = () => ({ refused: 'no', again: true, files: true });
  assert.deepEqual(await f.land('U', 'id1', { where: 'photos', fallback: true, rel: 'a', name: 'a', video: false, size: 7, sha256: 'x' }), { refused: 'no', again: true, files: true });
  answers[FILES_ROUTES.put] = () => ({ nothing: 1 });
  await assert.rejects(f.put('U', 'id1', 2, bytes), bad(502));
  unknown = true;
  await assert.rejects(f.begin('U', 'id1', 9), bad(501, /needs its update \(v6\)/));
  assert.equal((await f.can('U')).photos.why, NEEDS_UPDATE);
  await assert.rejects(f.begin('U', 'id1', 9), (e: Error) => !/secret/.test(e.message));
  target = { no: NEEDS_UPDATE };
  assert.deepEqual([(await f.can('U')).files.why, (await f.can('U')).away], [NEEDS_UPDATE, undefined]);
  target = { away: 'iPhone-1 is not connected' };
  assert.equal((await f.can('U')).away, true);
  await assert.rejects(f.begin('U', 'id1', 9), PhoneAway);
  target = { port: 1, token: 'T' };
  await assert.rejects(f.begin('U', 'id1', 9), PhoneAway);
  f.close();
  wda.closeAllConnections();
  wda.close();
  ok('our build: its routes, the token, raw bytes, an older one, one out of reach');
}

for (const l of logs) assert.ok(!/beach|notes\.pdf|Trip|half\.bin|secret/.test(l), `a name in a log: ${l}`);
ok('no name in any log');

origLog(`\nall ${passed} files checks passed`);
