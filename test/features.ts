// Idle lock and wake, the WDA re-sign schedule (state and expiry math), connection profiles and thumbnails, and the
// one-command swipe's replay timing; plus the new HTTP routes against the mock backend.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Control, SWIPE_STEP_MS, swipePlan } from '../src/control.js';
import { IdleLock } from '../src/idle.js';
import { profileFor, THUMB_MAX_FPS } from '../src/lanes.js';
import { MockBackend } from '../src/mock.js';
import {
  classifyBuildError, DAY_MS, HOUR_MS, isQuietHour, provisionDates, resignWait, signState, SignRecord, WdaResigner,
} from '../src/resign.js';
import { rtcWant } from '../src/rtc.js';
import { createServer, h264Want, profileOf, streamSettings } from '../src/server.js';
import { SettingsStore } from '../src/settings.js';
import type { Backend, PathPoint } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};

// ---- a backend whose lock state we can see ----
function powerBackend() {
  const calls: string[] = [];
  let locked = false;
  const b = {
    mock: true,
    list: async () => [{ udid: 'P1', online: true, ready: true }],
    screen: () => ({ width: 390, height: 844, scale: 3 }),
    tap: async () => {
      calls.push(`tap locked=${locked}`);
      return { via: 'hid' as const };
    },
    gesture: async (_u: string, pts: PathPoint[]) => {
      calls.push(`gesture ${pts.length}`);
      return { via: 'hid' as const };
    },
    lock: async () => {
      calls.push('lock');
      locked = true;
    },
    unlock: async () => {
      calls.push('unlock');
      locked = false;
    },
    isLocked: async () => locked,
  } as unknown as Backend;
  return { b, calls, isLocked: () => locked };
}

// ---- idle timer ----
{
  let now = 1_000_000;
  const { b, calls, isLocked } = powerBackend();
  let minutes = 10;
  const idle = new IdleLock(b, () => minutes, { now: () => now, tickMs: 0, log: () => {} });
  assert.deepEqual(await idle.tick(), []); // first sight: idle time counts from now
  assert.equal(idle.state('P1').lastActive, now);
  now += 9 * 60_000;
  assert.deepEqual(await idle.tick(), []);
  now += 60_000;
  assert.deepEqual(await idle.tick(), ['P1']);
  assert.equal(isLocked(), true);
  assert.equal(idle.state('P1').locked, true);
  assert.equal(idle.state('P1').screenOn, false);
  ok('idle: locks after idleLockMinutes with no input or viewer');

  // input on a locked phone wakes it first, then goes through
  const control = new Control(b);
  control.onInput = (u) => idle.activity(u);
  await control.handle('P1', { type: 'tap', x: 10, y: 10 });
  assert.deepEqual(calls.slice(-2), ['unlock', 'tap locked=false']);
  assert.equal(idle.state('P1').locked, false);
  assert.equal(idle.state('P1').screenOn, true);
  assert.equal(idle.state('P1').lastActive, now);
  ok('idle: input wakes a locked phone before it is injected');

  // input on an awake phone doesn't wait for anything
  assert.equal(idle.activity('P1'), null);
  ok('idle: input on an awake phone pays nothing');

  // a viewer keeps it awake however long; its close starts the idle time
  const release = idle.viewer('P1');
  now += 60 * 60_000;
  assert.deepEqual(await idle.tick(), []);
  release();
  assert.equal(idle.state('P1').lastActive, now);
  now += 10 * 60_000 - 1;
  assert.deepEqual(await idle.tick(), []);
  now += 1;
  assert.deepEqual(await idle.tick(), ['P1']);
  ok('idle: an open viewer holds it awake; idle time starts when it closes');

  // a viewer opening wakes it
  idle.viewer('P1')();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(isLocked(), false);
  ok('idle: an opened live view wakes the phone');

  // 0 = off
  minutes = 0;
  now += 999 * 60_000;
  assert.deepEqual(await idle.tick(), []);
  assert.equal(IdleLock.due({ locked: false, viewers: 0, lastActive: 0 }, 0, 1e12), false);
  assert.equal(IdleLock.due({ locked: false, viewers: 0, lastActive: 0 }, 1, 60_000), true);
  assert.equal(IdleLock.due({ locked: null, viewers: 1, lastActive: 0 }, 1, 1e9), false);
  ok('idle: 0 minutes turns it off');
}

// ---- settings ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-settings-'));
  const file = path.join(dir, 'settings.json');
  const s = new SettingsStore(file);
  assert.equal(s.get().idleLockMinutes, 10);
  s.put({ idleLockMinutes: 3 });
  assert.equal(new SettingsStore(file).get().idleLockMinutes, 3);
  assert.throws(() => s.put({ idleLockMinutes: -1 }), /idleLockMinutes/);
  assert.throws(() => s.put({ nope: 1 }), /unknown setting/);
  fs.rmSync(dir, { recursive: true, force: true });
  ok('settings: default 10, saved in the config dir, validated');
}

// ---- re-sign schedule: state and expiry math ----
{
  const t0 = Date.UTC(2026, 10, 1, 12);
  const rec = (o: Partial<SignRecord> = {}): SignRecord => ({ signedAt: t0, expiresAt: null, lastAttemptAt: null, lastError: null, perDevice: {}, ...o });
  let s = signState(rec(), t0 + DAY_MS, false);
  assert.equal(s.state, 'ok');
  assert.equal(s.expiresAt, t0 + 7 * DAY_MS);
  assert.equal(s.daysLeft, 6);
  assert.equal(signState(rec(), t0 + 6 * DAY_MS + HOUR_MS, false).state, 'soon');
  assert.equal(signState(rec(), t0 + 7 * DAY_MS, false).state, 'expired');
  assert.equal(signState(rec(), t0 + 7 * DAY_MS, false).daysLeft, 0);
  assert.equal(signState(rec(), t0, true).state, 'resigning');
  assert.equal(signState(rec({ lastAttemptAt: t0 + 6 * DAY_MS, lastError: 'x' }), t0 + 6 * DAY_MS + 1, false).state, 'failed');
  assert.equal(signState(rec({ signedAt: null }), t0, false).state, 'expired');
  // the profile's own expiry wins
  assert.equal(signState(rec({ expiresAt: t0 + 3 * DAY_MS }), t0 + DAY_MS, false).daysLeft, 2);
  ok('re-sign: state and expiry math (ok / soon / expired / failed / resigning)');

  const day6 = t0 + 6 * DAY_MS;
  assert.equal(resignWait(rec(), t0 + 5 * DAY_MS, 0, true), 'not due yet');
  assert.equal(resignWait(rec(), day6, 0, true), null);
  assert.equal(resignWait(rec(), day6, 0, false), 'waiting for a quiet hour');
  assert.equal(resignWait(rec(), day6 + 18 * HOUR_MS, 0, false), null); // waited long enough for a quiet hour
  assert.equal(resignWait(rec(), day6, 2, true), 'a live session is open');
  assert.equal(resignWait(rec(), t0 + 7 * DAY_MS - 11 * HOUR_MS, 2, false), null); // under 12 h left: even live
  const failed = rec({ lastAttemptAt: day6 + HOUR_MS, lastError: 'boom' });
  assert.equal(resignWait(failed, day6 + 90 * 60_000, 0, true), 'waiting 2 h after a failed try');
  assert.equal(resignWait(failed, day6 + 3 * HOUR_MS, 0, true), null);
  assert.equal(resignWait(rec({ signedAt: null }), t0, 0, false), null); // never signed: now
  ok('re-sign: due at 6 days, quiet hour, live-session guard (< 12 h overrides), 2 h retry');

  assert.equal(isQuietHour(new Date(2026, 10, 1, 3, 30).getTime(), 3), true);
  assert.equal(isQuietHour(new Date(2026, 10, 1, 6, 0).getTime(), 3), false);
  assert.equal(isQuietHour(new Date(2026, 10, 1, 0, 30).getTime(), 23), true);
  assert.match(classifyBuildError('xcodebuild: error: No Accounts: Add a new account in Accounts settings.'), /not signed in to the Apple ID/);
  assert.match(classifyBuildError("error: Signing for \"WebDriverAgentRunner\" requires a development team."), /not signed in/);
  assert.match(classifyBuildError('error: Developer Mode disabled'), /Developer Mode/);
  assert.match(classifyBuildError('foo\nerror: something else'), /something else/);
  const plist = '<plist><dict><key>CreationDate</key>\n<date>2026-11-10T08:00:00Z</date><key>ExpirationDate</key><date>2026-11-17T08:00:00Z</date></dict></plist>';
  assert.deepEqual(provisionDates(plist), { createdAt: Date.parse('2026-11-10T08:00:00Z'), expiresAt: Date.parse('2026-11-17T08:00:00Z') });
  ok('re-sign: quiet hours, Xcode account detection, provisioning profile dates');

  // the scheduler: runs per phone, restarts WDA after a good sign, records failures
  let now = day6 + 5 * 60_000;
  const runs: string[] = [];
  const installed: string[] = [];
  let fail = false;
  const r = new WdaResigner({
    run: async (u) => {
      runs.push(u);
      return fail ? { ok: false, log: 'error: No Accounts' } : { ok: true, log: 'BUILD SUCCEEDED' };
    },
    devices: async () => ['A', 'B'],
    liveViewers: () => 0,
    installed: (u) => installed.push(u),
    now: () => now,
    tickMs: 0,
    quietStartHour: new Date(now).getHours(), // a quiet hour now
    log: () => {},
  });
  (r as unknown as { rec: SignRecord }).rec = rec();
  assert.equal(await r.tick(), true);
  assert.deepEqual(runs, ['A', 'B']);
  assert.deepEqual(installed, ['A', 'B']);
  let st = r.status();
  assert.equal(st.state, 'ok');
  assert.equal(st.daysLeft, 7);
  assert.equal(st.signedAt, new Date(now).toISOString());
  assert.ok(st.perDevice?.A?.signedAt);
  assert.equal(await r.tick(), false); // not due again for 6 days
  now += 6 * DAY_MS;
  fail = true;
  (r as unknown as { o: { quietStartHour: number } }).o.quietStartHour = new Date(now).getHours();
  await r.resignNow();
  st = r.status();
  assert.equal(st.state, 'failed');
  assert.match(st.lastError ?? '', /not signed in to the Apple ID/);
  assert.equal(await r.tick(), false); // within 2 h of the failure
  ok('re-sign: the scheduler signs each phone, restarts WDA, reports failures with the Xcode account hint');
}

// ---- profiles and thumbnails ----
{
  assert.equal(profileOf(null, '192.168.1.20'), 'lan');
  assert.equal(profileOf(null, '::ffff:10.0.0.5'), 'lan');
  assert.equal(profileOf(null, '127.0.0.1'), 'lan');
  assert.equal(profileOf(null, '100.101.102.103'), 'remote');
  assert.equal(profileOf(null, 'fd7a:115c:a1e0::1'), 'remote');
  assert.equal(profileOf(null, '8.8.8.8'), 'remote');
  assert.equal(profileOf('lan', '100.101.102.103'), 'lan');
  assert.equal(profileOf('remote', '192.168.1.20'), 'remote');
  assert.equal(profileOf('bogus', '192.168.1.20'), 'lan');
  ok('profile: lan for the LAN, remote for Tailscale 100.x / public; profile= wins');

  const q = (s: string) => new URLSearchParams(s);
  const thumbWant = h264Want(q('quality=thumb'), false);
  assert.equal(thumbWant.tier, 'thumb');
  assert.equal(thumbWant.fps, 6);
  assert.equal(thumbWant.quality, null);
  const thumb = profileFor(thumbWant, 8_000_000, 2778);
  assert.ok(thumb.thumb && thumb.key.startsWith('thumb:'));
  assert.ok(thumb.settings.fps >= 4 && thumb.settings.fps <= THUMB_MAX_FPS);
  assert.ok(thumb.settings.scale <= 13 && thumb.settings.bitrate <= 500_000);
  assert.equal(profileFor(h264Want(q('quality=thumb&fps=60'), true), 8e6, 2778).settings.fps, THUMB_MAX_FPS);
  const full = profileFor(h264Want(q('quality=full'), false), 8_000_000, 2778);
  assert.deepEqual([full.remote, full.settings.fps, full.settings.scale, full.settings.bitrate], [false, 60, 100, 8_000_000]);
  const far = profileFor(h264Want(q('quality=full'), true), 8_000_000, 2778);
  assert.equal(far.remote, true);
  assert.ok(far.settings.adaptFps);
  assert.equal(h264Want(q('quality=70'), false).quality, 70); // the old numeric quality still works
  assert.deepEqual(streamSettings(q('quality=thumb')), { fps: 6, quality: 35, scale: 20 });
  assert.equal(rtcWant({ quality: 'thumb' }).tier, 'thumb');
  assert.equal(rtcWant({ quality: 'thumb' }).fps, 6);
  assert.equal(rtcWant({ profile: 'remote' }).profile, 'remote');
  ok('quality: thumb = small 4-8 fps lane shared by grids; full = the profile lane (lan full, remote adaptive)');
}

// ---- one-command swipe: replay timing ----
{
  // the client's own timing, resampled every 8 ms
  const plan = swipePlan([[0, 0, 1000], [100, 0, 1100], [100, 200, 1300]]);
  assert.equal(plan[0]![2], 0);
  assert.equal(plan[plan.length - 1]![2], 300);
  assert.deepEqual(plan[plan.length - 1]!.slice(0, 2), [100, 200]);
  for (let i = 1; i < plan.length - 1; i++) assert.equal(plan[i]![2] - plan[i - 1]![2], SWIPE_STEP_MS);
  const at = (t: number) => plan.find((p) => p[2] === t)!;
  assert.deepEqual(at(48).slice(0, 2), [48, 0]); // interpolated along the first leg
  assert.deepEqual(at(200).slice(0, 2), [100, 100]); // half way along the second
  ok('swipe: timing starts at 0, kept, and resampled every 8 ms along the path');

  // stretched to `duration`
  const d = swipePlan([[0, 0, 0], [0, 100, 50], [0, 400, 100]], 400);
  assert.equal(d[d.length - 1]![2], 400);
  assert.deepEqual(d.find((p) => p[2] === 200)!.slice(0, 2), [0, 100]);
  // no timing: spread evenly over the duration (default 300 ms)
  const e = swipePlan([[0, 0, 0], [0, 50, 0], [0, 100, 0]]);
  assert.equal(e[e.length - 1]![2], 300);
  assert.deepEqual(e.find((p) => p[2] === 152)!.slice(0, 2).map(Math.round), [0, 51]);
  assert.equal(swipePlan([[5, 5, 0]]).length, 1);
  // a long drag is never cut short
  const long = swipePlan([[0, 0, 0], [0, 1000, 60000]]);
  assert.ok(long.length <= 5000);
  assert.equal(long[long.length - 1]![2], 60000);
  ok('swipe: duration stretches it, untimed points spread evenly, long drags kept whole');

  // over Control: ONE gesture for the whole drag, never per point
  const { b, calls } = powerBackend();
  const c = new Control(b);
  await c.handle('P1', { type: 'swipe', points: [[10, 10, 0], [20, 400, 120], [30, 800, 250]], duration: 250 });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^gesture \d+$/);
  assert.ok(Number(calls[0]!.split(' ')[1]) >= 30);
  await c.handle('P1', { type: 'swipe', points: [[10, 10, 0]] });
  assert.equal(calls[1], 'tap locked=false');
  await assert.rejects(c.handle('P1', { type: 'swipe', points: [[1, 'x']] }), /points/);
  ok('swipe: {type:"swipe", points, duration} is replayed as one gesture on the server; one point is a tap');
}

// ---- HTTP: the new routes on the mock ----
{
  const backend = new MockBackend(2);
  const token = 'x'.repeat(32);
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}` };
  const call = (method: string, p: string, body?: unknown) =>
    fetch(base + p, { method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const udid = (await (await call('GET', '/phones')).json())[0].udid as string;

  for (const p of ['/api/settings', '/settings']) assert.equal((await (await call('GET', p)).json()).idleLockMinutes, 10);
  assert.equal((await (await call('PUT', '/api/settings', { idleLockMinutes: 5 })).json()).idleLockMinutes, 5);
  assert.equal((await call('PUT', '/settings', { idleLockMinutes: 'x' })).status, 400);
  for (const pre of ['/api/devices', '/phones']) {
    const l = await (await call('POST', `${pre}/${udid}/lock`)).json();
    assert.deepEqual([l.ok, l.locked, l.screenOn], [true, true, false]);
    const w = await (await call('POST', `${pre}/${udid}/wake`)).json();
    assert.deepEqual([w.ok, w.locked, w.screenOn], [true, false, true]);
    const nope = await call('POST', `${pre}/nope/wake`);
    assert.equal(nope.status, 404);
    assert.deepEqual(await nope.json(), { ok: false, error: 'unknown phone' });
  }
  assert.equal((await call('GET', `/api/devices/${udid}/wake`)).status, 405);
  const devs: any[] = await (await call('GET', '/api/devices')).json();
  for (const k of ['locked', 'screenOn', 'lastActive']) assert.ok(k in devs[0], `device has ${k}`);
  assert.equal(devs[0].stats.video_path, 'h264');
  assert.ok(Array.isArray(devs[0].stats.sessions));
  const status = await (await call('GET', '/api/status')).json();
  assert.equal(status.settings.idleLockMinutes, 5);
  assert.ok(status.wda.state && Array.isArray(status.devices));
  for (const p of ['/api/wda', '/wda']) assert.equal((await call('GET', p)).status, 200);
  assert.equal((await call('POST', '/api/wda/resign')).status, 503); // no scheduler in mock mode
  assert.equal((await call('POST', `/phones/${udid}/swipe`, { points: [[10, 600, 0], [10, 200, 200]], duration: 200 })).status, 200);
  assert.equal((await call('POST', `/api/devices/${udid}/swipe`, { points: [[10, 600], [10, 200]], duration: 150 })).status, 200);
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  ok('http: settings, wake/lock (both prefixes), unknown phone, devices fields, status, wda, swipe with points');

  // a live view's session shows its path, fps and latency
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`${base.replace('http', 'ws')}/phones/${udid}/stream?codec=h264&token=${token}&profile=remote&quality=thumb`);
  const hello: any = await new Promise((resolve, reject) => {
    ws.on('message', (d, bin) => !bin && resolve(JSON.parse(String(d))));
    ws.on('error', reject);
  });
  assert.equal(hello.path, 'h264');
  assert.equal(hello.profile, 'remote');
  assert.equal(hello.quality_tier, 'thumb');
  await new Promise((r) => setTimeout(r, 400));
  const s = (await (await call('GET', '/phones')).json()).find((p: any) => p.udid === udid).stats.sessions;
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].path, s[0].transport, s[0].profile, s[0].quality, s[0].net], ['h264', 'h264-ws', 'remote', 'thumb', 'loopback']);
  assert.ok(typeof s[0].fps === 'number' && 'latencyMs' in s[0]);
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  server.close();
  await backend.close();
  ok('stats: per-session path, transport, profile, quality, fps and latencyMs');
}

console.log(`\nall ${passed} feature checks passed`);
process.exit(0);
