// Yielding to the owner (2026-11-17, the owner: "WHEN USER IS RANDOMLY TOUCHING WHILE UR WORKING PAUSE ALL UR SEQUENCE
// UNTIL USER LEAVES THE TOUCHES FOR LIKE 5 sec"): his input on a phone (`owner: true` from Lotus's page, or a live
// touch) pauses Lotus's actions and batches on that phone until it has been quiet; a batch hands back what's done and
// what's left; a tap by element whose screen he changed says so. Plus the faster settle (until the picture is still).
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Agent, AGENT_CAPTURE_LINGER_MS, CHANGED_WHILE_TOUCHING, OWNER_QUIET_MS, SETTLE_MAX_MS, SETTLE_MIN_MS, SETTLE_ONE_LOOK_MS, UI_FRESH_MS } from '../src/agent.js';
import { Control } from '../src/control.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import type { Backend } from '../src/types.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const node = (type: string, label: string, x: number, y: number, w: number, h: number) => ({ type: `XCUIElementType${type}`, label, isEnabled: true, isVisible: true, rect: { x, y, width: w, height: h } });
const screenOf = (...children: unknown[]) => ({ type: 'XCUIElementTypeApplication', rect: { x: 0, y: 0, width: 400, height: 800 }, isVisible: true, children: [{ type: 'XCUIElementTypeWindow', rect: { x: 0, y: 0, width: 400, height: 800 }, isVisible: true, children }] });

/** A phone whose screen is a tree; `quiet` is the owner's quiet time for this test (short). */
function phone(quiet = 300, waitOne = 2000) {
  const st = { tree: screenOf() as unknown, taps: [] as string[], onTap: null as null | (() => void), hashes: 0, moving: 0 };
  const b = {
    mock: true,
    screen: () => ({ width: 400, height: 800, scale: 3 }),
    orientation: () => 'portrait' as const,
    refreshOrientation: async () => 'portrait' as const,
    tap: async (_u: string, x: number, y: number) => (st.taps.push(`${Math.round(x)},${Math.round(y)}`), st.onTap?.(), { via: 'mock' as const }),
    gesture: async () => ({ via: 'mock' as const }),
    home: async () => ({ via: 'mock' as const }),
    uiSource: async () => st.tree,
    activeApp: async () => 'com.test.app',
    frameHash: async () => (st.hashes++, st.moving > 0 ? `moving-${st.moving--}` : crypto.createHash('sha1').update(JSON.stringify(st.tree)).digest('hex')),
  } as unknown as Backend;
  const control = new Control(b);
  const agent = new Agent(b, control, { ownerQuietMs: quiet, ownerWaitMs: waitOne, ownerBatchWaitMs: 3000 });
  return { st, control, agent };
}

assert.equal(OWNER_QUIET_MS, 5000, 'the owner gets 5 s');
assert.equal(UI_FRESH_MS, 1000, 'a tree is kept about a second');

// ---- a single action waits while the owner touches, then runs and says how long it waited ----
{
  const { st, agent } = phone(300);
  const r0 = await agent.action('P', { type: 'tap', x: 0.5, y: 0.5, unit: 'norm', natural: false });
  assert.equal(r0.paused, undefined, 'nobody touching: no wait');
  agent.ownerInput('P');
  assert.equal(agent.ownerState('P').active, true);
  const t0 = performance.now();
  const r = await agent.action('P', { type: 'tap', x: 0.5, y: 0.5, unit: 'norm', natural: false });
  assert.ok(performance.now() - t0 >= 280, 'it waited for the quiet');
  assert.ok(r.paused && r.paused.ms >= 250, `paused: ${JSON.stringify(r.paused)}`);
  assert.equal(st.taps.length, 2);
  // the owner on another phone doesn't pause this one
  agent.ownerInput('Q');
  assert.equal((await agent.action('P', { type: 'home' })).paused, undefined);
  // the owner's own action never waits for himself
  agent.ownerInput('P');
  const own = await agent.action('P', { type: 'tap', x: 0.2, y: 0.2, unit: 'norm', owner: true, natural: false });
  assert.equal(own.paused, undefined);
  ok('single action: waits while the owner touches that phone (not another), runs after the quiet, says paused.ms');
}

// ---- still touching after the cap: refused ----
{
  const { agent } = phone(300, 400);
  const keep = setInterval(() => agent.ownerInput('P'), 50);
  agent.ownerInput('P');
  try {
    await assert.rejects(agent.action('P', { type: 'home' }), (e: { status: number; message: string }) => e.status === 409 && /still using the phone/.test(e.message));
  } finally {
    clearInterval(keep);
  }
  ok('single action: an owner still touching after the cap gets a clear refusal (409), nothing done');
}

// ---- a tap by element whose screen the owner changed: "screen changed while you were touching" ----
{
  const { st, agent } = phone(250);
  st.tree = screenOf(node('Button', 'Next', 100, 100, 80, 40));
  agent.ownerInput('P');
  setTimeout(() => (st.tree = screenOf(node('Button', 'Other', 100, 100, 80, 40))), 50); // he moved on
  await assert.rejects(agent.tapElement('P', { label: 'Next' }), (e: { status: number; message: string }) => e.status === 409 && e.message.startsWith(CHANGED_WHILE_TOUCHING));
  assert.equal(st.taps.length, 0, 'nothing tapped');
  // still there after his touches: tapped, `paused` said
  st.tree = screenOf(node('Button', 'Next', 100, 100, 80, 40));
  agent.ownerInput('P');
  const r = await agent.tapElement('P', { label: 'Next' });
  assert.ok(r.paused && r.paused.ms > 0);
  assert.deepEqual(st.taps, ['140,120']);
  ok('tap by element: after the owner touched, a target that is gone is "screen changed while you were touching"; one still there is tapped');
}

// ---- a batch stops before its next step, waits, and hands back done and remaining ----
{
  // (a quiet longer than the settle's one look, SETTLE_ONE_LOOK_MS, so the owner is still touching after step 1)
  const { st, agent } = phone(700);
  let n = 0;
  st.onTap = () => {
    if (++n === 1) agent.ownerInput('P'); // the owner touches while the first step runs
  };
  const steps = [1, 2, 3].map((i) => ({ type: 'tap', x: i / 10, y: 0.5, natural: false, unit: 'norm' }));
  const t0 = performance.now();
  const r = await agent.batch('P', { steps });
  assert.equal(r.ok, true);
  assert.ok(r.paused && r.paused.resumed && r.paused.ms > 0, JSON.stringify(r.paused)); // the rest of the quiet after step 1 settled
  assert.equal(r.done, 1);
  assert.deepEqual(r.remaining, steps.slice(1), 'the steps not run, as given');
  assert.equal(st.taps.length, 1, 'nothing replayed after the owner touched');
  assert.ok(performance.now() - t0 >= 300, "the quiet was kept");
  // without the owner: every step
  st.onTap = null;
  const all = await agent.batch('P', { steps });
  assert.deepEqual([all.done, all.paused, all.remaining], [3, undefined, undefined]);
  ok('batch: the owner touching stops it before the next step; after the quiet it returns { paused: { ms, resumed }, done, remaining }');
}

// ---- the settle (2026-11-27): without a capture, one coalesced look; never a loop of WDA stills ----
{
  const { st, agent } = phone();
  let h0 = st.hashes;
  let t0 = performance.now();
  let r = await agent.action('P', { type: 'home' });
  let took = performance.now() - t0;
  assert.equal(st.hashes - h0, 2, 'one look before, one after: no loop of stills');
  assert.ok(took >= SETTLE_ONE_LOOK_MS - 5 && took < SETTLE_ONE_LOOK_MS + 300, `one settle, one look: ${Math.round(took)} ms`);
  assert.ok(r.timing && r.timing.settle >= SETTLE_ONE_LOOK_MS - 5);
  st.moving = 100; // a screen that never stops (a video): still one look after the settle
  h0 = st.hashes;
  r = await agent.action('P', { type: 'home' });
  assert.equal(st.hashes - h0, 2);
  assert.equal(r.changed, true);
  ok('settle without a capture: one look after the settle, never a loop of stills');
}

// ---- the settle with the capture: as soon as no new frame comes, capped for a screen that keeps moving; no WDA ----
{
  const cap = { gen: 0, movedAt: 0, holds: 0, held: 0 };
  let hashes = 0;
  const b = {
    mock: true,
    screen: () => ({ width: 400, height: 800, scale: 3 }),
    orientation: () => 'portrait' as const,
    home: async () => {
      // the screen changes for a moment after the press, then holds still
      let n = 0;
      const t = setInterval(() => {
        cap.gen++;
        cap.movedAt = Date.now();
        if (++n >= 3) clearInterval(t);
      }, 30);
      return { via: 'mock' as const };
    },
    tap: async () => ({ via: 'mock' as const }),
    frameHash: async () => (hashes++, 'wda-still'),
    pictureToken: () => ({ gen: cap.gen, movedAt: cap.movedAt, keyAt: 1, width: 400, height: 800 }),
    holdPicture: () => {
      cap.holds++;
      cap.held++;
      return () => void cap.held--;
    },
  } as unknown as Backend;
  const agent = new Agent(b, new Control(b), { ownerQuietMs: 300 });
  let t0 = performance.now();
  let r = await agent.action('P', { type: 'home' });
  let took = performance.now() - t0;
  assert.equal(r.changed, true, 'the capture saw the frames the press made');
  assert.ok(took >= SETTLE_MIN_MS && took < SETTLE_MIN_MS + 400, `settled as soon as the frames stopped: ${Math.round(took)} ms`);
  // a screen that never stops: capped
  const mover = setInterval(() => {
    cap.gen++;
    cap.movedAt = Date.now();
  }, 20);
  t0 = performance.now();
  r = await agent.action('P', { type: 'tap', x: 0.5, y: 0.5, unit: 'norm', natural: false });
  took = performance.now() - t0;
  clearInterval(mover);
  assert.ok(took >= SETTLE_MAX_MS - 50 && took < SETTLE_MAX_MS + 400, `a moving screen: capped (${Math.round(took)} ms)`);
  assert.equal(hashes, 0, 'never a WDA still while the capture runs');
  assert.equal(cap.holds, 1, 'the agent holds the capture once while it works');
  assert.equal(cap.held, 1, `and keeps it for ${AGENT_CAPTURE_LINGER_MS / 1000} s after its last work`);
  agent.close();
  assert.equal(cap.held, 0, 'released');
  ok('settle with the capture: back as soon as no new frame comes, capped for a moving screen; the agent holds the capture, no WDA still');
}

// ---- over the server: the owner's input marks the phone, GET …/owner says so ----
{
  const backend = new MockBackend(1);
  const token = 'o'.repeat(32);
  const server = createServer(backend, token, undefined, { watchMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const udid = ((await (await fetch(`${base}/phones`, { headers: auth })).json()) as { udid: string }[])[0]!.udid;
    let s = (await (await fetch(`${base}/phones/${udid}/owner`, { headers: auth })).json()) as { active: boolean };
    assert.equal(s.active, false);
    const t0 = performance.now();
    const r = await fetch(`${base}/phones/${udid}/tap`, { method: 'POST', headers: auth, body: JSON.stringify({ x: 0.5, y: 0.5, unit: 'norm', natural: false, hold: 80, owner: true }) });
    assert.equal(r.status, 200);
    assert.ok(performance.now() - t0 < 1500, 'the owner\'s tap goes straight to the phone');
    s = (await (await fetch(`${base}/phones/${udid}/owner`, { headers: auth })).json()) as { active: boolean; quietMs: number };
    assert.equal(s.active, true);
    assert.equal((await fetch(`${base}/phones/${udid}/screenshot?format=jpeg&max=800&quality=60`, { headers: auth })).status, 200);
    ok('http: an owner: true tap goes straight through and marks the phone (GET /phones/:udid/owner); a small read is asked with max and quality');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await backend.close();
  }
}

await sleep(0);
console.log(`\nall ${passed} owner checks passed`);
