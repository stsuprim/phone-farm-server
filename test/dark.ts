// The black picture (2026-11-16): a phone without a passcode says "not locked" while its screen is off. A dark screen
// is told from a screenshot, woken with Home presses (never on a screen that shows something), a viewer always has
// the phone looked at, one that goes dark while watched is woken, and a switch of the live phone only locks the one
// before when nobody watches it. GET /health says which build runs.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { jpegMaybeBlack, pngIsBlack, wakeScreen, WakeOps } from '../src/dark.js';
import { IdleLock } from '../src/idle.js';
import { MockBackend } from '../src/mock.js';
import { encodePng } from '../src/png.js';
import { createServer } from '../src/server.js';
import { Backend } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await sleep(20);
  return cond();
};

// ---- a screenshot that's black all over ----
{
  const w = 120, h = 260;
  const black = new Uint8Array(w * h * 3);
  assert.equal(pngIsBlack(encodePng(w, h, black)), true, 'a screen that is off');
  // a dark screen that is on: a clock's worth of white pixels (about 1 %)
  const clock = new Uint8Array(black);
  for (let y = 6; y < 12; y++) for (let x = 40; x < 80; x++) clock.fill(255, (y * w + x) * 3, (y * w + x) * 3 + 3);
  assert.equal(pngIsBlack(encodePng(w, h, clock)), false, 'a dark screen with a clock is on');
  // a few stray pixels (noise) are still black
  const noisy = new Uint8Array(black);
  noisy.fill(200, 0, 9);
  assert.equal(pngIsBlack(encodePng(w, h, noisy)), true);
  // near-black counts as black; a dim grey doesn't
  assert.equal(pngIsBlack(encodePng(w, h, new Uint8Array(w * h * 3).fill(10))), true);
  assert.equal(pngIsBlack(encodePng(w, h, new Uint8Array(w * h * 3).fill(60))), false);

  // RGBA rows with the Up and Paeth filters (what a real encoder writes), read through the filters
  const png = (rows: Buffer[], color: number, wide: number) => {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // the CRC isn't read
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(wide, 0);
    ihdr.writeUInt32BE(rows.length, 4);
    ihdr[8] = 8;
    ihdr[9] = color;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  };
  const row = (filter: number, px: number[], n: number) => Buffer.concat([Buffer.from([filter]), Buffer.concat(Array.from({ length: n }, () => Buffer.from(px)))]);
  // opaque black, then rows that only say "as above" (Up, Paeth): black all the way down
  assert.equal(pngIsBlack(png([row(0, [0, 0, 0, 255], 50), ...Array.from({ length: 49 }, (_, i) => row(i % 2 ? 2 : 4, [0, 0, 0, 0], 50))], 6, 50)), true, 'alpha is not brightness');
  // a white first row carried down by Up: white all over
  assert.equal(pngIsBlack(png([row(0, [255, 255, 255, 255], 50), ...Array.from({ length: 49 }, () => row(2, [0, 0, 0, 0], 50))], 6, 50)), false, 'the filters are undone');
  assert.equal(pngIsBlack(Buffer.from('not a png at all, just some bytes here.')), null);

  // a JPEG by its size: small enough to be black, or clearly a picture
  const jpeg = (wd: number, ht: number, bytes: number) => {
    const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, ht >> 8, ht & 255, wd >> 8, wd & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))]);
  };
  assert.equal(jpegMaybeBlack(jpeg(410, 886, 6500)), true, 'a black frame is ~0.018 bytes a pixel');
  assert.equal(jpegMaybeBlack(jpeg(410, 886, 40_000)), false, 'a home screen is far bigger');
  assert.equal(jpegMaybeBlack(Buffer.from([1, 2, 3])), null);
  ok('dark: a black screenshot (PNG, through its filters), a dark screen with a clock is on, a JPEG by its size');
}

// ---- waking: WDA's unlock for a phone that says locked, Home presses for one that's only dark ----
{
  const run = async (o: { locked: boolean | null; dark: (boolean | null)[]; unlockFails?: boolean; explicit?: boolean; force?: boolean }) => {
    const calls: string[] = [];
    const dark = [...o.dark];
    const ops: WakeOps = {
      explicit: o.explicit,
      force: o.force,
      locked: async () => o.locked,
      unlock: async () => {
        calls.push('unlock');
        if (o.unlockFails) throw new Error('WDA said no');
      },
      dark: async () => {
        calls.push('look');
        return dark.length > 1 ? dark.shift()! : dark[0]!;
      },
      home: async () => void calls.push('home'),
      sleep: async () => {},
    };
    let error = '';
    await wakeScreen(ops).catch((e: Error) => (error = e.message));
    return { calls, error };
  };
  // the phone says "not locked" and its screen is off (no passcode): WDA's unlock is no use; Home, Home, and it's on
  assert.deepEqual(await run({ locked: false, dark: [true, false] }), { calls: ['look', 'home', 'home', 'look'], error: '' });
  // awake: nothing is pressed (a Home press would leave the app in front)
  assert.deepEqual(await run({ locked: false, dark: [false] }), { calls: ['look'], error: '' });
  // it can't be told: nothing is pressed blind
  assert.deepEqual(await run({ locked: false, dark: [null] }), { calls: ['look'], error: '' });
  // it says locked: WDA's unlock, and the screen is on
  assert.deepEqual(await run({ locked: true, dark: [false] }), { calls: ['unlock', 'look'], error: '' });
  // it says locked and WDA's unlock fails: that's the error
  assert.equal((await run({ locked: true, dark: [false], unlockFails: true })).error, 'WDA said no');
  // WDA doesn't say: an automatic wake doesn't unlock on that (2026-11-27), the screen decides
  assert.deepEqual(await run({ locked: null, dark: [true, false] }), { calls: ['look', 'home', 'home', 'look'], error: '' });
  // the owner's explicit wake: WDA's unlock goes (it checks the lock itself); it fails: the screen still decides
  assert.deepEqual(await run({ locked: null, dark: [true, false], unlockFails: true, explicit: true }), { calls: ['unlock', 'look', 'home', 'home', 'look'], error: '' });
  // 2026-11-27 (docs/root-cause.md section 6): a live view without a picture (`force`) on a busy WDA (no look): no Home
  assert.deepEqual(await run({ locked: null, dark: [null], force: true }), { calls: ['look'], error: '' });
  assert.deepEqual(await run({ locked: false, dark: [null], force: true, explicit: true }), { calls: ['look'], error: '' });
  // a look that fails after the first round: no second round on a screen that couldn't be looked at
  assert.deepEqual(await run({ locked: false, dark: [true, null] }), { calls: ['look', 'home', 'home', 'look'], error: '' });
  // it stays dark: two rounds, then it says so
  const stuck = await run({ locked: false, dark: [true] });
  assert.deepEqual(stuck.calls, ['look', 'home', 'home', 'look', 'home', 'home', 'look']);
  assert.match(stuck.error, /stayed dark/);
  ok('wake: Home presses for a dark screen that says "not locked", none on a screen that shows something');
}

// ---- the idle lock: a viewer always has the phone looked at; one found dark while watched is woken ----
{
  const calls: string[] = [];
  let dark = false;
  const b = {
    mock: true,
    list: async () => [],
    lock: async () => void ((dark = true), calls.push('lock')),
    unlock: async () => void ((dark = false), calls.push('unlock')),
    isLocked: async () => (calls.push('look'), dark),
  } as unknown as Backend;
  const idle = new IdleLock(b, () => 10, { tickMs: 0, log: () => {} });
  // thought awake (a first viewer found it so)...
  idle.viewer('P')();
  await sleep(10);
  assert.deepEqual(calls, ['look']);
  assert.equal(idle.state('P').locked, false);
  // ...then it went dark by itself and nobody said: the next viewer still looks, and wakes it
  dark = true;
  calls.length = 0;
  const release = idle.viewer('P');
  await sleep(10);
  assert.deepEqual(calls, ['look', 'unlock', 'look'], 'a viewer never trusts "awake"');
  assert.equal(dark, false);
  // found dark by the watch while the viewer is there (iOS's Auto-Lock): woken now
  dark = true;
  calls.length = 0;
  idle.note('P', true);
  await sleep(10);
  assert.deepEqual(calls, ['unlock', 'look'], 'a watched phone never stays black');
  assert.equal(idle.state('P').locked, false);
  // locked on request under the viewer (the Lock key): left locked
  calls.length = 0;
  await idle.lock('P');
  idle.note('P', true);
  await sleep(10);
  assert.deepEqual(calls, ['lock'], 'a lock that was asked for stays');
  release();
  // found dark with nobody watching: only noted
  await idle.wake('P');
  dark = true;
  calls.length = 0;
  idle.note('P', true);
  await sleep(10);
  assert.deepEqual(calls, []);
  assert.equal(idle.state('P').locked, true);
  ok('idle: a viewer always looks and wakes a dark phone; dark while watched is woken; an asked lock stays');
}

// ---- the server: a switch locks the phone before only when nobody watches it; /health says the build ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(3);
  const stopped: string[] = [];
  (backend as unknown as Backend).stopCapture = (u: string) => void stopped.push(u);
  const server = createServer(backend, token, undefined, { watchMs: 0, focusLockMs: 60, version: { commit: 'abc1234', startedAt: '2026-11-16T00:00:00.000Z' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = async (p: string) => (await fetch(`http://${host}${p}`, { method: 'POST', headers: auth, body: '{}' })).status;
  let ws: WebSocket | undefined;
  try {
    const health = (await (await fetch(`http://${host}/health`)).json()) as Record<string, unknown>;
    const { uptimeS, rssMb, ...rest } = health;
    // 2026-11-27: also the build and our WebDriverAgent's version, said together (additive)
    assert.deepEqual(rest, {
      ok: true, mock: true, commit: 'abc1234', startedAt: '2026-11-16T00:00:00.000Z',
      build: { commit: 'abc1234', startedAt: '2026-11-16T00:00:00.000Z' }, forkVersion: null,
    }, 'public, with the build');
    assert.ok(typeof uptimeS === 'number' && uptimeS >= 0 && typeof rssMb === 'number' && rssMb > 0, 'and its uptime and memory');
    const [a, b2, c] = ((await (await fetch(`http://${host}/phones`, { headers: auth })).json()) as any[]).map((p) => p.udid as string);

    // someone (another Lotus) watches A; the focus moves to B: A keeps its capture and stays awake
    ws = new WebSocket(`ws://${host}/phones/${a}/control?token=${token}`);
    await new Promise((r) => ws!.once('open', r));
    assert.equal(await post(`/phones/${a}/focus`), 200);
    assert.equal(await post(`/phones/${b2}/focus`), 200);
    await sleep(200);
    assert.equal(await backend.isLocked(a!), false, 'a watched phone is not locked under its viewer');
    assert.deepEqual(stopped, []);

    // nobody watches B; the focus moves to C: B's capture stops and it sleeps, a moment later
    assert.equal(await post(`/phones/${c}/focus`), 200);
    assert.equal(await backend.isLocked(b2!), false, 'not at once');
    assert.ok(await until(() => backend.isLocked(b2!).then((l) => l === true)), 'the phone before sleeps once nobody watches it');
    assert.deepEqual(stopped, [], 'a capture ends with its last viewer, never by the focus');

    // back to B before its lock is due: it's the focus again, and no lock lands on it. 2026-11-17: the focus no
    // longer wakes a phone (Lotus's Unlock wakes it by POST /wake), so B is woken here as Unlock would
    await backend.unlock(b2!);
    assert.equal(await post(`/phones/${b2}/focus`), 200);
    assert.equal(await post(`/phones/${c}/focus`), 200);
    assert.equal(await post(`/phones/${b2}/focus`), 200);
    await sleep(200);
    assert.equal(await backend.isLocked(b2!), false, 'the phone in focus is never locked by an older switch');
  } finally {
    ws?.close();
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('server: /health says the build; a switch locks the phone before only when nobody watches it');
}

console.log(`\nall ${passed} dark-screen checks passed`);
process.exit(0);
