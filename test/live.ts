// Live touch on iOS 18 (2026-11-17): XCTest lifts every finger at the end of each record, so the fork's self-test found
// no "hold" mode on either phone. Here: segmented drags (src/segments.ts, live mode 4), and the self-test's flow: the
// phone woken and checked awake first, one more try, every mode's result kept, run after an install and on demand.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { ForkInstaller, ForkTokens, LIVE_SEGMENTED, readSelfTest, SELFTEST_ATTEMPTS, SelfTestAnswer } from '../src/fork.js';
import { MockBackend } from '../src/mock.js';
import { SEG_MIN_MS, SEG_MIN_PT, SEG_OVERHEAD_MS, SEG_SETTLE_MS, Segmenter } from '../src/segments.js';
import { createServer } from '../src/server.js';
import type { PathPoint } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const tick = () => new Promise((r) => setImmediate(r));

// ---- segments ----
{
  let now = 0;
  const sent: { points: PathPoint[]; hold: number }[] = [];
  const s = new Segmenter(async (points, hold) => void sent.push({ points, hold }), () => now);

  // a tap: one gesture on the lift, at its own length
  await s.down(10, 10);
  now = 80;
  await s.up(10, 10);
  assert.deepEqual(sent, [{ points: [[10, 10, 0], [10, 10, 80]], hold: 0 }], 'a tap goes whole');
  sent.length = 0;

  // a long press: a finger held still (said again by the server) is never cut
  now = 1000;
  await s.down(50, 50);
  for (now = 1100; now <= 2000; now += 100) await s.move(50, 50);
  assert.equal(sent.length, 0, 'still: nothing sent');
  // ...then it drags: the hold and the start of the drag go as one gesture (a long press stays a long press)
  now = 2100;
  await s.move(50, 50 + SEG_MIN_PT);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0]!.points[0], sent[0]!.points.at(-1), sent[0]!.hold], [[50, 50, 0], [50, 60, 1100], SEG_SETTLE_MS]);
  sent.length = 0;
  now = 2200;
  await s.up(50, 90);
  assert.deepEqual(sent, [{ points: [[50, 60, 0], [50, 90, 100]], hold: 0 }], 'the rest from where it ended, lifting as the finger did');
  sent.length = 0;

  // a drag: a segment once it's SEG_MIN_MS long and moved SEG_MIN_PT, never sooner
  now = 10_000;
  await s.down(0, 0);
  now += SEG_MIN_MS - 10;
  await s.move(0, 40);
  assert.equal(sent.length, 0, 'too short yet');
  now += 10;
  await s.move(0, 44);
  assert.equal(sent.length, 1, 'long enough and far enough');
  assert.deepEqual(sent[0]!.points, [[0, 0, 0], [0, 40, SEG_MIN_MS - 10], [0, 44, SEG_MIN_MS]]);
  // the phone is busy with it (its length + settle + XCTest's overhead): the next one waits, getting longer
  now += SEG_MIN_MS;
  await s.move(0, 80);
  assert.equal(sent.length, 2, 'one more may wait on the phone');
  const busyFor = SEG_MIN_MS + SEG_SETTLE_MS + SEG_OVERHEAD_MS;
  now += SEG_MIN_MS;
  await s.move(0, 100);
  assert.equal(sent.length, 2, 'not while the phone is further behind');
  now += 2 * busyFor; // well past it
  await s.move(0, 120);
  assert.equal(sent.length, 3);
  sent.splice(1, 1);
  assert.deepEqual(sent[1]!.points[0], [0, 80, 0], 'the next one starts where the last ended');
  assert.deepEqual(sent[1]!.points.at(-1)!.slice(0, 2), [0, 120]);
  now += 50;
  await s.up(0, 130);
  assert.equal(sent.length, 3);
  assert.equal(sent[2]!.hold, 0);
  assert.equal(s.segments, 4);
  assert.equal(s.isDown, false);
  // a move or an up with no finger down sends nothing
  await s.move(5, 5);
  await s.up(5, 5);
  assert.equal(sent.length, 3);
  ok('segments: a tap and a long press go whole; a drag goes in segments while it happens, paced by the phone');

  // in order, even when an answer is slow
  const order: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  let t = 0;
  const s2 = new Segmenter(async () => {
    const k = ++n;
    if (k === 1) await gate;
    order.push(k);
  }, () => t);
  await s2.down(0, 0);
  t = 100;
  const p1 = s2.move(0, 50);
  t = 1000;
  const p2 = s2.up(0, 90);
  await tick();
  assert.deepEqual(order, [], 'the second waits for the first');
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
  ok('segments: sent one after the other, in order');
}

// ---- the self-test: what the phone answered, made sure of ----
{
  assert.deepEqual(readSelfTest({ tested: true, mode: 4, modes: [{ mode: 1, works: false, why: 'x'.repeat(300) }, { mode: 9, works: true, why: null }, { mode: 4, works: true, why: null }] }), {
    tested: true, mode: 4, modes: [{ mode: 1, works: false, why: 'x'.repeat(200) }, { mode: 4, works: true, why: null }],
  });
  assert.equal(readSelfTest({ tested: true, mode: 7 }).mode, 0, 'a mode this server does not know is none');
  assert.equal(readSelfTest({ tested: false, mode: 4 }).mode, 0);
  assert.equal(LIVE_SEGMENTED, 4);
  ok('self-test: modes 1-4 known, each mode result kept short');
}

// ---- the self-test's flow: woken and checked awake first, one more try, after an install and on demand ----
{
  let now = 1_000_000;
  const calls: string[] = [];
  let answers: SelfTestAnswer[] = [];
  let awake: (boolean | null)[] = [];
  const f = new ForkInstaller({
    meta: { version: 2, upstream: 'v16.15.3' }, enabled: true, tokens: new ForkTokens(), project: '/repo/wda', derivedData: '/b',
    port: () => 28100,
    build: async (u) => (calls.push(`build ${u}`), { ok: true, log: '' }),
    switchTo: async (u, fl) => (calls.push(`switch ${u} ${fl}`), { ok: true }),
    selftest: async (u) => (calls.push(`selftest ${u}`), answers.shift() ?? { tested: false, mode: 0, why: 'no answer' }),
    awake: async (u) => (calls.push(`awake? ${u}`), awake.length ? awake.shift()! : true),
    devices: async () => ['A'],
    prepare: async (u) => void calls.push(`wake ${u}`),
    now: () => now, tickMs: 0, log: () => {},
  });

  // right after the install: woken and checked first; iPhone-1's case (nothing reached the window) is tried again
  answers = [
    { tested: true, mode: 0, modes: [{ mode: 1, works: false, why: 'no touch reached the test window' }, { mode: 4, works: false, why: 'no touch reached the test window' }] },
    { tested: true, mode: 4, modes: [{ mode: 1, works: false, why: 'the press was lifted when its record ended' }, { mode: 4, works: true, why: null }], notes: ['mode 4: works'] },
  ];
  await f.tick();
  assert.deepEqual(calls, ['wake A', 'build A', 'wake A', 'switch A fork', 'wake A', 'awake? A', 'selftest A', 'wake A', 'awake? A', 'selftest A']);
  let live = f.status().perDevice.A!.live!;
  assert.deepEqual([live.tested, live.mode, live.kind, live.trigger, live.why], [true, 4, 'segmented', 'install', null]);
  assert.deepEqual(live.modes, [{ mode: 1, works: false, why: 'the press was lifted when its record ended' }, { mode: 4, works: true, why: null }]);
  assert.equal(f.liveMode('A'), 4, 'drags are live (segmented) from now on');
  assert.equal(SELFTEST_ATTEMPTS, 2);
  ok('self-test: after an install it wakes the phone, checks it, and tries once more when the first found nothing');

  // on demand: a phone that stays locked isn't tested; said why
  calls.length = 0;
  awake = [false, false];
  const d = await f.selftestNow('A');
  assert.deepEqual(calls, ['wake A', 'awake? A', 'wake A', 'awake? A'], 'never tested on a locked phone');
  assert.equal(d.tested, false);
  assert.match(String((d as { why: string }).why), /stayed locked or dark/);
  // ...and once it's awake, it runs (a hold mode found wins over segmented)
  calls.length = 0;
  answers = [{ tested: true, mode: 2, modes: [{ mode: 2, works: true, why: null }, { mode: 4, works: true, why: null }] }];
  live = (await f.selftestNow('A')) as typeof live;
  assert.deepEqual(calls, ['wake A', 'awake? A', 'selftest A']);
  assert.deepEqual([live.mode, live.kind, live.trigger, live.tries], [2, 'hold', 'demand', 1]);
  assert.deepEqual(await f.selftestNow('B'), { tested: false, why: 'the phone is not running our WebDriverAgent build' });
  // a page that only opens never runs it: nothing but an install, a due retry or a request does
  calls.length = 0;
  now += 60 * 60_000;
  await f.tick();
  assert.deepEqual(calls, [], 'a tested phone is not tested again by the check');
  ok('self-test: on demand, only on our build and only on an awake phone; never again by itself once it ran');
}

// ---- POST /api/wda/:udid/selftest ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(1);
  const asked: string[] = [];
  const fork = { status: () => ({}), selftestNow: async (u: string) => (asked.push(u), { tested: true, mode: 4, kind: 'segmented' }) };
  const server = createServer(backend, token, undefined, { watchMs: 0, fork });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const [udid] = ((await (await fetch(`http://${host}/phones`, { headers: auth })).json()) as any[]).map((p) => p.udid as string);
    const r = await fetch(`http://${host}/api/wda/${udid}/selftest`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, udid, live: { tested: true, mode: 4, kind: 'segmented' } });
    assert.deepEqual(asked, [udid]);
    assert.equal((await fetch(`http://${host}/api/wda/nope/selftest`, { method: 'POST', headers: auth, body: '{}' })).status, 404);
    assert.equal((await fetch(`http://${host}/api/wda/${udid}/selftest`, { headers: auth })).status, 405);
    ok('POST /api/wda/:udid/selftest runs it now and answers what it found');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await backend.close();
  }
}

console.log(`\nall ${passed} live-touch checks passed`);

