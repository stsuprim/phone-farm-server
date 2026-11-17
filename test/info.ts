// The detail card's data: the parsers for lockdown's battery domain, the IORegistry's AppleSmartBattery and WDA's
// battery, device and active-app answers; the ~15 s cache (get waits, peek never does); GET /phones/:udid/info and
// `info` on each phone in GET /phones; WDA's quiet read that never waits for it or recovers it.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { appName, basicFacts, InfoCache, mergeBattery, parseActiveApp, parseBatteryDomain, parseDeviceInfo, parseIoreg, parseWdaBattery } from '../src/info.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import type { PhoneFacts, PhoneInfo } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The keys a client's detail card reads, in the order the server gives them. */
const KEYS = ['battery', 'temperatureC', 'app', 'uptimeSec', 'model', 'ios', 'bootedAt', 'wda', 'thermal', 'connectedAt', 'at', 'fresh'];

// ---- parsers ----
{
  // ideviceinfo -q com.apple.mobile.battery
  const lockdown = ['BatteryCurrentCapacity: 87', 'BatteryIsCharging: true', 'ExternalChargeCapable: true', 'ExternalConnected: true', 'FullyCharged: false', 'GasGaugeCapability: true', 'HasBattery: true'].join('\n');
  assert.deepEqual(parseBatteryDomain(lockdown), { level: 0.87, charging: true, temperatureC: null });
  assert.deepEqual(parseBatteryDomain('BatteryCurrentCapacity: 100\r\nBatteryIsCharging: false\r\nExternalConnected: true\r\nFullyCharged: true\r\n'), { level: 1, charging: true, temperatureC: null }, 'full on the charger still reads as charging');
  assert.deepEqual(parseBatteryDomain('BatteryCurrentCapacity: 41\nBatteryIsCharging: false\nExternalConnected: false\nFullyCharged: false'), { level: 0.41, charging: false, temperatureC: null });
  assert.deepEqual(parseBatteryDomain(''), { level: null, charging: null, temperatureC: null }, 'no answer (not paired, tool missing): nulls');
  assert.deepEqual(parseBatteryDomain('BatteryCurrentCapacity: 250'), { level: null, charging: null, temperatureC: null }, 'a level that makes no sense is unknown');

  // idevicediagnostics ioregentry AppleSmartBattery
  const ioreg = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>IORegistry</key><dict>
  <key>AppleRawCurrentCapacity</key><integer>2710</integer>
  <key>AppleRawMaxCapacity</key><integer>3110</integer>
  <key>CurrentCapacity</key><integer>87</integer>
  <key>CycleCount</key><integer>212</integer>
  <key>ExternalConnected</key><true/>
  <key>FullyCharged</key><false/>
  <key>IsCharging</key><true/>
  <key>MaxCapacity</key><integer>100</integer>
  <key>Temperature</key><integer>3015</integer>
  <key>VirtualTemperature</key><integer>2890</integer>
  <key>Voltage</key><integer>4210</integer>
</dict></dict></plist>`;
  assert.deepEqual(parseIoreg(ioreg), { level: 0.87, charging: true, temperatureC: 30.2 }, 'Temperature is hundredths of a degree Celsius');
  assert.equal(parseIoreg(ioreg.replace('3015', '0')).temperatureC, null, '0 is no reading');
  assert.equal(parseIoreg(ioreg.replace('3015', '30150')).temperatureC, null, 'a reading no phone survives is a bad read');
  assert.deepEqual(parseIoreg('ERROR: Could not connect to diagnostics_relay'), { level: null, charging: null, temperatureC: null });
  assert.deepEqual(parseIoreg(ioreg.replace('<key>IsCharging</key><true/>', '<key>IsCharging</key><false />')).charging, false);

  // WDA /wda/batteryInfo
  assert.deepEqual(parseWdaBattery({ level: 0.5, state: 2 }), { level: 0.5, charging: true, temperatureC: null });
  assert.deepEqual(parseWdaBattery({ level: 0.93, state: 1 }), { level: 0.93, charging: false, temperatureC: null });
  assert.deepEqual(parseWdaBattery({ level: -1, state: 0 }), { level: null, charging: null, temperatureC: null }, "UIDevice's unknown");
  assert.deepEqual(parseWdaBattery(null), { level: null, charging: null, temperatureC: null });

  // the first reading that has each part wins
  assert.deepEqual(mergeBattery(parseBatteryDomain(''), parseIoreg(ioreg), parseWdaBattery({ level: 0.1, state: 1 })), { level: 0.87, charging: true, temperatureC: 30.2 });
  assert.deepEqual(mergeBattery(parseBatteryDomain(lockdown.replace('87', '86')), parseIoreg(ioreg)), { level: 0.86, charging: true, temperatureC: 30.2 });
  assert.deepEqual(mergeBattery(null, undefined), { level: null, charging: null, temperatureC: null });

  // WDA /wda/device/info: the thermal state; stock WDA has no uptime (null), a build that says it is read
  const now = 1_800_000_000_000;
  assert.deepEqual(parseDeviceInfo({ currentLocale: 'en_US', name: 'iPhone', thermalState: 1 }, now), { thermal: 'fair', uptimeSec: null, bootedAt: null });
  assert.deepEqual(parseDeviceInfo({ thermalState: 3, uptime: 3600.4 }, now), { thermal: 'critical', uptimeSec: 3600, bootedAt: now - 3_600_000 });
  assert.deepEqual(parseDeviceInfo({ bootTime: (now - 120_000) / 1000 }, now), { thermal: null, uptimeSec: 120, bootedAt: now - 120_000 });
  assert.deepEqual(parseDeviceInfo({ bootTime: now + 5000, thermalState: 9 }, now), { thermal: null, uptimeSec: null, bootedAt: null }, 'a boot in the future is no boot time');
  assert.deepEqual(parseDeviceInfo(null, now), { thermal: null, uptimeSec: null, bootedAt: null });

  // WDA /wda/activeAppInfo: the app in front and its name
  assert.deepEqual(parseActiveApp({ bundleId: 'com.zhiliaoapp.musically', name: 'TikTok', pid: 412 }), { bundleId: 'com.zhiliaoapp.musically', name: 'TikTok' });
  assert.deepEqual(parseActiveApp({ bundleId: 'com.apple.Preferences', name: '' }), { bundleId: 'com.apple.Preferences', name: 'Settings' }, 'WDA gave no name: the well-known one');
  assert.deepEqual(parseActiveApp({ bundleId: 'com.apple.springboard', name: ' ' }), { bundleId: 'com.apple.springboard', name: 'Home Screen' });
  assert.deepEqual(parseActiveApp({ bundleId: 'com.x.game' }, [{ bundleId: 'com.x.game', name: 'Game', installed: true }]), { bundleId: 'com.x.game', name: 'Game' }, "the phone's own list");
  assert.deepEqual(parseActiveApp({ bundleId: 'com.x.unknown' }), { bundleId: 'com.x.unknown', name: null });
  assert.deepEqual(parseActiveApp(null), { bundleId: null, name: null });
  assert.equal(appName('COM.APPLE.MOBILESAFARI'), 'Safari');

  // what the list already knows
  assert.deepEqual(basicFacts({ battery: 64, model: 'iPhone14,5', ios: '18.1' }), {
    battery: { level: 0.64, charging: null }, temperatureC: null, app: { bundleId: null, name: null }, uptimeSec: null,
    model: 'iPhone14,5', ios: '18.1', bootedAt: null, thermal: null, connectedAt: null,
  });
  assert.deepEqual(basicFacts({ battery: null, model: '', ios: '' }).battery, { level: null, charging: null });
  assert.equal(basicFacts({ battery: null, model: '', ios: '' }).model, null, 'an empty model is unknown: null');
  ok('parsers: lockdown battery, IORegistry temperature / 100, WDA battery, thermal state, the app in front; unknown is null');
}

// ---- the cache: ~15 s, one gathering at a time, peek never waits ----
{
  let now = 1_000_000;
  let asked = 0;
  let fail = false;
  let slow = 0;
  const phone = { udid: 'U1', battery: 50, model: 'iPhone14,5', ios: '18.1', online: true } as PhoneInfo;
  const facts = (): PhoneFacts => ({ ...basicFacts(phone), battery: { level: 0.5 + asked / 100, charging: true }, temperatureC: 30, bootedAt: 400_000, uptimeSec: 600, connectedAt: 900_000 });
  const cache = new InfoCache(
    async () => {
      asked++;
      if (slow) await sleep(slow);
      if (fail) throw new Error('the phone went away');
      return facts();
    },
    () => ({ expiresAt: '2026-11-20T03:00:00.000Z', daysLeft: 4.2, state: 'ok' }),
    15_000,
    () => now,
  );
  // nothing gathered yet: peek answers at once with what the list knows, and starts a gathering
  const first = cache.peek(phone);
  assert.deepEqual(Object.keys(first), KEYS);
  assert.deepEqual([first.fresh, first.battery, first.temperatureC, first.model, first.wda.daysLeft], [false, { level: 0.5, percent: 50, charging: null }, null, 'iPhone14,5', 4.2]);
  await sleep(5);
  assert.equal(asked, 1);
  const a = await cache.get(phone);
  assert.equal(asked, 1, 'under 15 s old: not gathered again');
  assert.deepEqual([a.fresh, a.battery, a.temperatureC, a.at], [true, { level: 0.51, percent: 51, charging: true }, 30, 1_000_000]);
  assert.deepEqual([a.bootedAt, a.uptimeSec], [400_000, 600]);
  now += 14_000;
  assert.equal((await cache.get(phone)).uptimeSec, 614, 'the phone kept running: uptime from its boot time');
  assert.equal(asked, 1);
  now += 2_000; // 16 s old
  const stale = cache.peek(phone);
  assert.equal(stale.fresh, false, 'peek gives the old answer and says so');
  assert.equal(stale.temperatureC, 30);
  await sleep(5);
  assert.equal(asked, 2, '...and gathered for the next one');
  assert.equal(cache.peek(phone).battery.level, 0.52);
  // everyone asking while one gathering runs shares it
  now += 20_000;
  slow = 30;
  const [x, y] = await Promise.all([cache.get(phone), cache.get(phone), sleep(1).then(() => cache.peek(phone))]);
  assert.equal(asked, 3);
  assert.equal(x.battery.level, y.battery.level);
  slow = 0;
  // force: gathered now anyway
  await cache.get(phone, true);
  assert.equal(asked, 4);
  // a gathering that fails keeps the last answer
  now += 20_000;
  fail = true;
  const kept = await cache.get(phone);
  assert.deepEqual([kept.fresh, kept.temperatureC, kept.battery.level], [false, 30, 0.54]);
  fail = false;
  // a part that didn't answer this time keeps its last value for a minute (WDA busy with a long gesture), then is null
  const full = facts;
  let partial = true;
  const cache2 = new InfoCache(async () => (partial ? { ...full(), temperatureC: null, app: { bundleId: null, name: null } } : { ...full(), app: { bundleId: 'com.x', name: 'X' } }), () => ({ expiresAt: null, daysLeft: null, state: null }), 15_000, () => now);
  partial = false;
  assert.deepEqual([(await cache2.get(phone)).temperatureC, (await cache2.get(phone)).app.name], [30, 'X']);
  partial = true;
  now += 20_000;
  const carried = await cache2.get(phone);
  assert.deepEqual([carried.temperatureC, carried.app, carried.fresh], [30, { bundleId: 'com.x', name: 'X' }, true], 'carried over from 20 s ago');
  now += 70_000;
  const dropped = await cache2.get(phone);
  assert.deepEqual([dropped.temperatureC, dropped.app], [null, { bundleId: null, name: null }], 'over a minute since it was last known: unknown, so null');
  assert.equal(typeof dropped.battery.level, 'number', 'what did answer is there');
  // an offline phone isn't asked: what was last known
  const before = asked;
  const off = await cache.get({ ...phone, online: false });
  assert.equal(asked, before);
  assert.deepEqual([off.fresh, off.temperatureC], [false, 30]);
  cache.peek({ ...phone, online: false });
  await sleep(5);
  assert.equal(asked, before);
  // a phone never asked: the list's own facts, everything else null
  const none = await cache.get({ udid: 'U2', battery: null, model: '', ios: '', online: false } as PhoneInfo);
  assert.deepEqual(none.battery, { level: null, percent: null, charging: null });
  assert.deepEqual([none.temperatureC, none.app, none.uptimeSec, none.model, none.ios, none.bootedAt], [null, { bundleId: null, name: null }, null, null, null, null]);
  ok('cache: gathered at most every ~15 s, shared while it runs, peek never waits, a failure keeps the last answer');
}

// ---- the server: GET /phones/:udid/info, /api/devices/:udid/info, and `info` in the list ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(4);
  const server = createServer(backend, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}` };
  const get = async (p: string) => {
    const r = await fetch(base + p, { headers: auth });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const list = (await get('/phones')).body as any[];
    const [u1, u2, , u4] = list.map((p) => p.udid as string);
    // the list never waits for a phone: the first one carries what it already knew
    for (const p of list) assert.deepEqual(Object.keys(p.info), KEYS, 'every phone has info');
    assert.deepEqual([list[0].info.fresh, list[0].info.temperatureC, list[0].info.model, list[0].info.battery.level], [false, null, 'iPhone14,5', 0.9]);
    await sleep(20);
    const again = (await get('/api/devices')).body as any[];
    assert.equal(again[0].info.fresh, true, 'gathered in the background for the next list');
    assert.equal(again[0].info.temperatureC, 29.5);
    assert.equal(backend.factsAsked.get(u1!), 1);

    const { status, body } = await get(`/phones/${u1}/info`);
    assert.equal(status, 200);
    // 2026-11-18: the control link as it is, after the card
    assert.deepEqual(Object.keys(body), ['ok', 'udid', ...KEYS, 'control', 'controlDown', 'restarting']);
    assert.deepEqual([body.control, body.controlDown, body.restarting], ['ready', null, null]);
    assert.deepEqual([body.ok, body.udid], [true, u1]);
    assert.deepEqual(body.battery, { level: 0.9, percent: 90, charging: true });
    assert.equal(body.temperatureC, 29.5);
    assert.deepEqual(body.app, { bundleId: 'com.apple.springboard', name: 'Home Screen' });
    assert.deepEqual([body.model, body.ios, body.thermal], ['iPhone14,5', '18.1', 'nominal']);
    assert.ok(Number.isInteger(body.uptimeSec) && body.uptimeSec >= 3600 && body.uptimeSec < 3700, `uptimeSec ${body.uptimeSec}`);
    assert.ok(Math.abs(Date.now() - body.uptimeSec * 1000 - body.bootedAt) < 2000, 'bootedAt (ms) is now - uptime');
    assert.deepEqual(body.wda, { expiresAt: null, daysLeft: null, state: 'unavailable' }, 'no signing in mock mode: nulls');
    assert.equal(typeof body.connectedAt, 'number');
    assert.equal(backend.factsAsked.get(u1!), 1, 'kept ~15 s: the phone is not asked again');
    assert.equal((await get(`/api/devices/${u1}/info`)).body.temperatureC, 29.5, 'the same under /api/devices');
    assert.equal(backend.factsAsked.get(u1!), 1);
    await get(`/phones/${u1}/info?fresh=1`);
    assert.equal(backend.factsAsked.get(u1!), 2, '?fresh=1 asks the phone now');

    // the app in front follows the phone
    await fetch(`${base}/phones/${u1}/launch`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"name":"Settings","fast":true}' });
    assert.deepEqual((await get(`/phones/${u1}/info?fresh=1`)).body.app, { bundleId: 'com.apple.Preferences', name: 'Settings' });

    // a phone that doesn't say its temperature or uptime: null, never a guess
    const quiet = (await get(`/phones/${u2}/info`)).body;
    assert.deepEqual([quiet.temperatureC, quiet.uptimeSec, quiet.bootedAt, quiet.thermal], [null, null, null, null]);
    assert.deepEqual(quiet.battery, { level: 0.83, percent: 83, charging: false });

    // an unplugged phone: 200 with what's known, nothing asked of it
    const off = (await get(`/phones/${u4}/info`)).body;
    assert.deepEqual([off.ok, off.fresh, off.model, off.temperatureC, off.app.bundleId], [true, false, 'iPhone12,1', null, null]);
    assert.equal(backend.factsAsked.get(u4!) ?? 0, 0);

    const unknown = await get('/phones/NOPE/info');
    assert.deepEqual([unknown.status, unknown.body], [404, { ok: false, error: 'unknown phone' }]);
    assert.equal((await fetch(`${base}/phones/${u1}/info`, { method: 'POST', headers: auth })).status, 405);
    assert.equal((await fetch(`${base}/phones/${u1}/info`)).status, 401);
    // /api/status lists the devices the same way
    assert.deepEqual(Object.keys((await get('/api/status')).body.devices[0].info), KEYS);
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('GET /phones/:udid/info (and /api/devices): the card, kept ~15 s, ?fresh=1; `info` on every phone in the list; nulls for the unknown');
}

// ---- WDA's quiet read: an answer when WDA is up, null otherwise, and never a recovery ----
{
  const { WdaManager } = await import('../src/wda.js');
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-info-'))); // data/ports.json goes here
  let up = true;
  const hits: string[] = [];
  const wda = http.createServer((req, res) => {
    const p = req.url ?? '';
    hits.push(`${req.method} ${p}`);
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    req.resume();
    req.on('end', () => {
      if (!up && p !== '/status') return json(500, { value: { error: 'unknown error', message: 'boom' } });
      if (p === '/status') return json(200, { value: { ready: true }, sessionId: 'S1' });
      if (p === '/session') return json(200, { sessionId: 'S1', value: { sessionId: 'S1' } });
      if (p.endsWith('/window/size')) return json(200, { value: { width: 390, height: 844 } });
      if (p.endsWith('/orientation')) return json(200, { value: 'PORTRAIT' });
      if (p === '/wda/screen') return json(200, { value: { scale: 3 } });
      if (p.endsWith('/appium/settings')) return json(200, { value: {} });
      if (p === '/wda/activeAppInfo') return json(200, { value: { bundleId: 'com.burbn.instagram', name: 'Instagram', pid: 77 } });
      if (p === '/wda/device/info') return json(200, { value: { thermalState: 2, name: 'iPhone' } });
      if (p === '/session/S1/wda/batteryInfo') return json(200, { value: { level: 0.42, state: 2 } });
      json(404, { value: { error: 'unknown command', message: p } });
    });
  });
  await new Promise<void>((r) => wda.listen(0, '127.0.0.1', r));
  const port = (wda.address() as AddressInfo).port;
  const fakeSpawn = (() => {
    const p = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    return p;
  }) as unknown as typeof import('node:child_process').spawn;
  const cfg = { wdaBasePort: port, mjpegBasePort: port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const m = new WdaManager(cfg, (u) => u, fakeSpawn);
  try {
    assert.equal(await m.peek('U1', '/wda/activeAppInfo'), null, 'WDA not started: null, at once');
    m.start('U1');
    for (let i = 0; i < 40 && m.state('U1') !== 'ready'; i++) await sleep(50);
    assert.equal(m.state('U1'), 'ready');
    assert.deepEqual(parseActiveApp(await m.peek('U1', '/wda/activeAppInfo')), { bundleId: 'com.burbn.instagram', name: 'Instagram' });
    assert.equal(parseDeviceInfo(await m.peek('U1', '/wda/device/info'), Date.now()).thermal, 'serious');
    assert.deepEqual(parseWdaBattery(await m.peek('U1', '/wda/batteryInfo', 2500, true)), { level: 0.42, charging: true, temperatureC: null });
    assert.equal(await m.peek('U1', '/wda/nothing'), null, 'an endpoint this WDA lacks: null');
    // WDA answering 500: null, and no recovery (a card's read must never restart the runner or remake the session)
    up = false;
    const sessions = hits.filter((h) => h === 'POST /session').length;
    assert.equal(await m.peek('U1', '/wda/activeAppInfo'), null);
    await sleep(30);
    assert.equal(m.state('U1'), 'ready');
    assert.equal(hits.filter((h) => h === 'POST /session').length, sessions, 'no new session');
    assert.ok(!logs.some((l) => /recovering/.test(l)), 'no recovery');
  } finally {
    console.log = origLog;
    m.shutdown();
    wda.closeAllConnections();
    wda.close();
    process.chdir(prevCwd);
  }
  ok('WDA quiet read: the app in front, the thermal state and the battery when WDA is up; null (never a recovery) otherwise');
}

console.log(`\nall ${passed} info checks passed`);
