// 2026-11-21 (the owner: "phone1 was working flawlessly but phone2 shows control down... even the SWITCHING phones
// has some sort of bug"): a phone missing from one `idevice_id -l` (its USB screen capture starting makes it
// re-enumerate) is not unplugged: nothing is torn down, its WDA isn't stopped or restarted, its live view stays; only
// one missed for several polls over ~10 s is. A runner that ends while its phone is off the USB list is started again
// once it's back; xcodebuild starts go one at a time across the farm; the build said is the one being run; a slow
// lock of the phone that was left never heals (restarts) it.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Config } from '../src/config.js';
import { Control } from '../src/control.js';
import { OFFLINE_AFTER_MS, OFFLINE_MISSES, Presence } from '../src/presence.js';
import { RealBackend } from '../src/real.js';
import { Backend, HttpError } from '../src/types.js';
import { WdaManager } from '../src/wda.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
};

const prevCwd = process.cwd();
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-usb-'))); // data/ports.json goes here
const origLog = console.log;
const logs: string[] = [];

// ---- Presence: the poll's list, debounced ----
{
  assert.deepEqual([OFFLINE_MISSES, OFFLINE_AFTER_MS], [3, 10_000]);
  const p = new Presence();
  let c = p.update(['A', 'B'], 0);
  assert.deepEqual(c, { arrived: ['A', 'B'], back: [], missing: [], gone: [] });
  c = p.update(['A'], 5000); // B missed once: missing, not gone
  assert.deepEqual(c, { arrived: [], back: [], missing: ['B'], gone: [] });
  assert.ok(p.has('B') && p.missingSince('B') === 5000);
  c = p.update(['A', 'B'], 10_000); // back: nothing to set up again
  assert.deepEqual(c, { arrived: [], back: ['B'], missing: [], gone: [] });
  assert.equal(p.missingSince('B'), null);
  ok('one poll that misses a phone is a blip: it is "missing", then simply back');

  // three misses but within 10 s: still not gone (a fast poll)
  p.update(['A'], 20_000);
  p.update(['A'], 21_000);
  c = p.update(['A'], 22_000);
  assert.deepEqual(c.gone, []);
  assert.ok(p.has('B'));
  c = p.update(['A'], 30_000); // 10 s after the first miss, and the 4th miss in a row
  assert.deepEqual(c.gone, ['B']);
  assert.ok(!p.has('B'));
  c = p.update(['A', 'B'], 31_000); // plugged in again: a new arrival
  assert.deepEqual(c.arrived, ['B']);
  ok('a phone is unplugged only after several polls in a row over 10 s without it');

  // two misses 10 s apart are not enough (it needs OFFLINE_MISSES in a row)
  const q = new Presence();
  q.update(['A'], 0);
  q.update([], 1000);
  c = q.update([], 12_000);
  assert.deepEqual(c.gone, []);
  c = q.update([], 13_000);
  assert.deepEqual(c.gone, ['A']);
  ok('and only after OFFLINE_MISSES polls in a row');
}

// ---- a fake WDA (answers /status and makes sessions) and a fake spawn ----
type Fake = { port: number; server: http.Server; close(): void };
const fakeWda = async (port = 0): Promise<Fake> => {
  let sid = '';
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const p = req.url ?? '';
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (p === '/status') return json(200, { value: { ready: true }, sessionId: sid || null });
      if (p === '/session') {
        sid = `S${Date.now()}`;
        return json(200, { sessionId: sid, value: { sessionId: sid } });
      }
      if (p === '/wda/screen') return json(200, { value: { scale: 3 } });
      const m = /^\/session\/([^/]+)(\/.*)?$/.exec(p);
      if (!m) return json(404, { value: { error: 'unknown command', message: p } });
      const sub = m[2] ?? '';
      if (sub === '') return json(200, { value: { capabilities: {} } });
      if (sub === '/window/size') return json(200, { value: { width: 390, height: 844 } });
      if (sub === '/orientation') return json(200, { value: 'PORTRAIT' });
      json(200, { value: null });
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    server,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};
type Proc = ChildProcess & EventEmitter & { args: string[]; at: number };
const procs: Proc[] = [];
const fakeSpawn = ((cmd: string, args: string[]) => {
  const p = new EventEmitter() as Proc;
  Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, args, at: Date.now() });
  (p as unknown as { cmd: string }).cmd = cmd;
  procs.push(p);
  return p;
}) as unknown as typeof import('node:child_process').spawn;
const xcodes = (udid?: string) => procs.filter((p) => (p as unknown as { cmd: string }).cmd === 'xcodebuild' && (!udid || p.args.some((a) => a.includes(udid))));

/** The base port for the fake WDAs: U1 (slot 0) answers on it; U2 (slot 1) on the next one, when given one. */
const w1 = await fakeWda();
const cfgOf = (extra: Partial<Config> = {}): Config =>
  ({
    wdaBasePort: w1.port, mjpegBasePort: 40000, wdaProject: '/x', wdaDerivedData: '/y', pollMs: 60_000, autostartWda: true,
    h264: false, h264BitrateMbps: 8, audio: false, phoneSilent: false, hidInput: 'off', hidPython: 'python3', dataDir: 'data',
    ...extra,
  }) as unknown as Config;
const quick = { input: 300, launch: 1000, probe: 150, restart: 1500, status: 100, probes: 3, probeEvery: 150, backoff: [80, 160, 240], attempts: 4, sessionWait: 500, recoverWait: 2000, hold: 200, usbWait: 3000 };

console.log = (...a: unknown[]) => void logs.push(a.join(' '));
try {
  // ---- the backend's poll: a blip tears nothing down; only a phone gone for good is unplugged ----
  {
    procs.length = 0;
    let listed = ['U1', 'U2'];
    const asked: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      asked.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'idevice_id') return listed.join('\n');
      if (cmd === 'ideviceinfo') {
        const k = args[args.indexOf('-k') + 1];
        if (k === 'DeviceName') return args[1] === 'U1' ? 'iPhone-1' : 'iPhone-2';
        if (k === 'ProductType') return 'iPhone14,5';
        if (k === 'ProductVersion') return '18.1';
        if (k === 'BatteryCurrentCapacity') return '80';
      }
      return '';
    };
    const wda = new WdaManager(cfgOf(), (u) => u, fakeSpawn, quick);
    const calls: string[] = [];
    const stop = wda.stop.bind(wda);
    wda.stop = (u: string) => {
      calls.push(`stop ${u}`);
      stop(u);
    };
    const b = new RealBackend(cfgOf(), { run, wda, timer: false, presence: new Presence({ misses: 3, afterMs: 0 }) });
    const bb = b as unknown as { poll(): Promise<void>; closeH264(u: string, why: string): void };
    const closeH264 = bb.closeH264.bind(b);
    bb.closeH264 = (u: string, why: string) => {
      calls.push(`close ${u}: ${why}`);
      closeH264(u, why);
    };
    await sleep(50); // the constructor's own first poll
    await bb.poll();
    assert.ok(await until(() => xcodes('U2').length === 1, 3000), "U2's WDA started (after U1's: one start at a time)");
    const before = (await b.list()).find((p) => p.udid === 'U2')!;
    assert.equal(before.online, true);
    assert.equal(before.name, 'iPhone-2');
    const u2Runs = xcodes('U2').length;

    // U2 missing from one poll (its capture just started: it re-enumerates), then back
    listed = ['U1'];
    await bb.poll();
    let u2 = (await b.list()).find((p) => p.udid === 'U2')!;
    assert.equal(u2.online, true, 'still online after one miss');
    assert.deepEqual(calls, [], 'nothing stopped or closed for a blip');
    assert.ok(wda.offUsb('U2'), 'WDA knows it is off the USB list for a moment');
    listed = ['U1', 'U2'];
    await bb.poll();
    u2 = (await b.list()).find((p) => p.udid === 'U2')!;
    assert.equal(u2.online, true);
    assert.equal(u2.name, 'iPhone-2', 'its name kept');
    assert.ok(!wda.offUsb('U2'));
    assert.equal(xcodes('U2').length, u2Runs, 'no new WDA start for a phone that was only missing');
    assert.deepEqual(calls, []);
    assert.ok(logs.some((l) => /\[usb U2\] back after a moment off the USB list: nothing was torn down/.test(l)));
    ok('a phone missing from one poll stays online: its WDA is not stopped or started again, its live view not closed');

    // two misses in a row: still nothing; the third: unplugged, torn down once
    listed = ['U1'];
    await bb.poll();
    await bb.poll();
    assert.deepEqual(calls, []);
    assert.equal((await b.list()).find((p) => p.udid === 'U2')!.online, true);
    await bb.poll();
    assert.deepEqual(calls, ['stop U2', 'close U2: phone unplugged']);
    assert.equal((await b.list()).find((p) => p.udid === 'U2')!.online, false);
    assert.equal((await b.list()).find((p) => p.udid === 'U1')!.online, true, 'the other phone untouched');
    // plugged in again: online, WDA started again
    listed = ['U1', 'U2'];
    const runsBefore = xcodes('U2').length;
    await bb.poll();
    assert.equal((await b.list()).find((p) => p.udid === 'U2')!.online, true);
    assert.ok(await until(() => xcodes('U2').length > runsBefore, 3000), 'WDA started again for a phone plugged back in');
    ok('only a phone missed for several polls in a row is unplugged (WDA stopped, live view closed), and set up again when it is back');

    // a failed idevice_id counts against nobody
    calls.length = 0;
    const failing = new RealBackend(cfgOf({ autostartWda: false }), { run: async () => Promise.reject(new Error('timed out')), timer: false, wda: new WdaManager(cfgOf(), (u) => u, fakeSpawn, quick) });
    await (failing as unknown as { poll(): Promise<void> }).poll();
    assert.deepEqual(await failing.list(), []);
    ok('a failed idevice_id marks nobody missing');

    // the build said is the one this phone runs, even while it isn't up (it said "stock" for our build)
    const forked = new WdaManager(cfgOf(), (u) => u, fakeSpawn, quick);
    forked.fork = { flavorAtStart: () => 'fork', launch: () => ({ project: '/w', derivedData: '/d', port: 28100, token: 't0ken' }), failed: () => {}, liveMode: () => 0 };
    const fb = new RealBackend(cfgOf({ autostartWda: false }), { run: async () => '', timer: false, wda: forked });
    forked.start('U9');
    assert.equal(fb.inputMethods('U9').wda, 'fork', 'our build, while it starts');
    assert.equal(fb.wdaBuild('U9').flavor, 'fork');
    await fb.close();
    await failing.close();
    ok("the input methods say the build the phone runs (our build), never \"stock\" just because it isn't up yet");
    await b.close();
  }

  // ---- WDA: a phone off the USB list is never restarted; its runner starts again once it's back ----
  {
    procs.length = 0;
    const m = new WdaManager(cfgOf(), (u) => u, fakeSpawn, quick);
    try {
      m.start('U1');
      assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');
      const runs = xcodes('U1').length;
      // the phone re-enumerates: off the list; its WDA unreachable meanwhile
      m.setPresent('U1', false);
      w1.server.close();
      w1.server.closeAllConnections();
      assert.equal(await m.probe('U1', 'watch'), false, 'nothing to probe while it is off USB');
      await assert.rejects(m.recoverNow('U1'), (err: HttpError) => /reconnecting over USB/.test(err.message));
      await sleep(300);
      assert.equal(xcodes('U1').length, runs, 'no restart while it is off the USB list');
      assert.equal(m.restarting('U1'), null);
      // its xcodebuild ends meanwhile (CoreDevice lost the phone): not relaunched at a phone that isn't there
      xcodes('U1').at(-1)!.emit('exit', 65);
      await sleep(300);
      assert.equal(xcodes('U1').length, runs, 'not relaunched while the phone is away');
      assert.ok(logs.some((l) => /\[wda U1\] xcodebuild exited \(65\); the phone is off the USB list for a moment: started again once it's back/.test(l)));
      // back: started again at once (one restart, its reason saying so)
      await new Promise<void>((r) => w1.server.listen(w1.port, '127.0.0.1', r));
      m.setPresent('U1', true);
      assert.ok(await until(() => xcodes('U1').length === runs + 1, 3000), 'relaunched once the phone is back');
      assert.ok(await until(() => m.state('U1') === 'ready', 5000), 'and ready again');
      assert.ok(logs.some((l) => /\[wda-heal\] U1 restarting WDA \(attempt 1\/4\): xcodebuild exited \(65\); the phone is back on USB after/.test(l)));
      ok('a phone off the USB list for a moment: no probe, recover or restart; a runner that ended meanwhile starts again once it is back');
    } finally {
      await m.shutdown(1000);
    }
  }

  // ---- xcodebuild starts go one at a time across the farm ----
  {
    procs.length = 0;
    // U1 answers on its port (slot 0); U2 (slot 1) answers only once its own fake is up
    const m = new WdaManager(cfgOf(), (u) => u, fakeSpawn, { ...quick, spawnHold: 700 });
    try {
      m.start('U2'); // nothing answers on its port yet: it stays starting and holds the turn (700 ms at most)
      m.start('U1');
      await sleep(200);
      assert.equal(xcodes('U1').length, 0, "U1's xcodebuild waits while U2's is starting");
      assert.ok(logs.some((l) => /\[wda U1\] waiting for U2's WebDriverAgent to finish starting first \(one xcodebuild start at a time\)/.test(l)));
      assert.ok(await until(() => xcodes('U1').length === 1, 2000), 'then U1 (held 700 ms at most)');
      assert.ok(xcodes('U1')[0]!.at - xcodes('U2')[0]!.at >= 600);
      assert.ok(await until(() => m.state('U1') === 'ready', 3000));
      ok('a runner that does not come up holds the next phone back only SPAWN_HOLD_MS');

      // U1 ready: a restart of it and a new start of U3 at once: U3 waits until U1's runner answers, not longer
      procs.length = 0;
      m.restartRunner('U1');
      await sleep(20);
      m.start('U3');
      await sleep(20);
      assert.ok(await until(() => m.state('U1') === 'ready', 3000));
      assert.ok(await until(() => xcodes('U3').length === 1, 1000), 'U3 starts right after U1 answers');
      assert.ok(xcodes('U3')[0]!.at >= xcodes('U1')[0]!.at);
      // an xcodebuild that ends gives the turn on at once
      procs.length = 0;
      m.stop('U2');
      m.stop('U3');
      m.start('U2'); // nothing answers on its port: it holds the turn
      await sleep(20);
      m.start('U4');
      await sleep(20);
      assert.equal(xcodes('U4').length, 0, 'U4 waits while U2 starts');
      xcodes('U2').at(-1)!.emit('exit', 65);
      assert.ok(await until(() => xcodes('U4').length === 1, 300), 'U4 goes once that xcodebuild ended');
      assert.ok(xcodes('U4')[0]!.at - xcodes('U2')[0]!.at < 600, 'at its end, not after the hold');
      ok('xcodebuild starts go one at a time across the farm (the next once the last is up or ended)');
    } finally {
      await m.shutdown(1000);
    }
  }

  // ---- the lock of the phone that was left: never heals it, however slow ----
  {
    let release!: () => void;
    const b = { mock: true, screen: () => ({ width: 390, height: 844, scale: 3 }) } as unknown as Backend;
    const c = new Control(b, undefined, { actionTimeoutMs: 100, minGapMs: 0, idleProbeMs: 0 });
    const heals: string[] = [];
    c.onHeal = async (_u, reason) => void heals.push(reason);
    c.power = { lock: () => new Promise<void>((r) => (release = r)), wake: async () => {} };
    await assert.rejects(c.handle('P', { type: 'key', key: 'lock' }), (err: HttpError) => err.status === 504 && /nothing was restarted/.test(err.message));
    assert.deepEqual(heals, [], 'a slow lock heals nothing');
    release();
    ok('a slow lock (the focus putting the phone that was left to sleep) never heals or restarts it');
  }
} catch (err) {
  origLog(logs.slice(-40).join('\n'));
  throw err;
} finally {
  console.log = origLog;
  w1.close();
  process.chdir(prevCwd);
}
console.log(`usb: ${passed} passed`);
