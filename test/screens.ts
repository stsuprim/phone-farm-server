// 2026-11-18, three fixes: (1) the screen size every fraction -> point conversion stands on comes from the screen
// itself, checked, never a letterboxed app's window, zero or pixels (src/screens.ts), and the UI list holds only what's
// on the screen, in 0..1 (src/ui.ts); (2) a wake for a live view with no picture counts a screen that can't be looked
// at as dark (src/dark.ts) and an idle wake says why it couldn't (src/idle.ts); (3) the phones stay silent: never
// raised, driven down on demand at most every few minutes unless forced (src/audio.ts VolumeGuard.silence).
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VOLUME_STEPS, VolumeGuard } from '../src/audio.js';
import { wakeScreen, WakeOps } from '../src/dark.js';
import { IdleLock } from '../src/idle.js';
import { toPoints } from '../src/orient.js';
import { knownScreen, pickScreen, saneScale, saneSize } from '../src/screens.js';
import type { Backend } from '../src/types.js';
import { flattenUi } from '../src/ui.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. the screen ----
{
  assert.equal(saneSize({ width: 0, height: 0 }), null, 'zero is no screen');
  assert.equal(saneSize({ width: 1284, height: 2778 }), null, 'pixels are not points');
  assert.equal(saneSize({ width: 1, height: 1 }), null);
  assert.equal(saneSize({ width: 'x', height: 926 }), null);
  assert.deepEqual(saneSize({ width: 926, height: 428 }), { width: 428, height: 926 }, 'kept as held in portrait');
  assert.equal(saneScale(0), null);
  assert.equal(saneScale(3), 3);
  assert.deepEqual(knownScreen('iPhone14,8'), { width: 428, height: 926, scale: 3 });
  assert.deepEqual(knownScreen('iPhone14,5'), { width: 390, height: 844, scale: 3 });

  // iPhone-1 after its rebuild: WDA's own (letterboxed) app in front; the screen's own size wins
  const a = pickScreen({ screen: { width: 428, height: 926 }, window: { width: 320, height: 568 }, scale: 3, model: 'iPhone14,8' })!;
  assert.deepEqual([a.width, a.height, a.scale, a.from], [428, 926, 3, 'screen']);
  assert.match(a.note ?? '', /320 x 568 window/);
  // a WDA without the screen's size: a letterboxed window is never taken for the screen; the model's size is
  const b = pickScreen({ window: { width: 320, height: 568 }, scale: 3, model: 'iPhone14,8' })!;
  assert.deepEqual([b.width, b.height, b.from], [428, 926, 'model']);
  // an app's normal window (or Display Zoom's smaller points) is believed when that's all WDA says
  const c = pickScreen({ window: { width: 390, height: 844 }, scale: 3, model: 'iPhone14,5' })!;
  assert.deepEqual([c.width, c.height, c.from], [390, 844, 'window']);
  const z = pickScreen({ window: { width: 390, height: 844 }, scale: 3, model: 'iPhone14,8' })!;
  assert.deepEqual([z.width, z.height, z.from], [390, 844, 'window']);
  // nothing usable: the model's; then the one from before; else none (never a guess, never zero)
  assert.equal(pickScreen({ window: { width: 0, height: 0 }, scale: 0, model: 'iPhone14,5' })!.from, 'model');
  const p = pickScreen({ window: { width: 0, height: 0 }, model: 'iPad99,1', previous: { width: 390, height: 844, scale: 3 } })!;
  assert.deepEqual([p.width, p.height, p.scale, p.from], [390, 844, 3, 'previous']);
  assert.equal(pickScreen({ window: { width: 0, height: 0 } }), null);
  // what a tap at a fraction comes to: the middle of a 428 x 926 screen, not of a 320 x 568 one
  assert.deepEqual(toPoints(0.5, 0.5, 'norm', { width: a.width, height: a.height, scale: a.scale }), [214, 463]);
  ok('screen: the screen\'s own size, checked; never a letterboxed window, zero or pixels; the model\'s size when WDA says nothing usable');
}
{
  const node = (type: string, label: string, x: number, y: number, w: number, h: number) => ({ type: `XCUIElementType${type}`, label, isVisible: '1', isEnabled: '1', rect: { x, y, width: w, height: h } });
  const tree = {
    type: 'XCUIElementTypeApplication', rect: { x: 0, y: 0, width: 428, height: 926 },
    children: [
      node('Icon', 'Settings', 214, 420, 64, 64),
      node('Icon', 'On page two', 214 + 428, 420, 64, 64), // another Home Screen page
      { type: 'XCUIElementTypeScrollView', name: 'list', isVisible: '1', rect: { x: 0, y: -200, width: 428, height: 3000 } },
    ],
  };
  const ui = flattenUi(tree, { width: 428, height: 926 });
  assert.deepEqual(ui.elements.map((e) => e.label ?? e.name), ['Settings', 'list'], 'an element off the screen is not on it');
  for (const e of ui.elements) for (const v of [e.x, e.y, e.w, e.h, e.x + e.w, e.y + e.h]) assert.ok(v >= 0 && v <= 1, `${e.label ?? e.name}: ${v} in 0..1`);
  const s = ui.elements[0]!;
  assert.deepEqual([s.x, s.y], [0.5, 0.4536]);
  // `all` keeps the tree's own rectangles
  const all = flattenUi(tree, { width: 428, height: 926 }, { all: true });
  assert.ok(all.elements.some((e) => e.label === 'On page two' && e.x > 1));
  ok('ui: the list is what\'s on the screen, in 0..1 of it (a tall view as the part that shows); `all` keeps the tree');
}

// ---- 2. waking for a picture ----
{
  const run = async (o: { locked: boolean | null; dark: (boolean | null)[]; force?: boolean }) => {
    const calls: string[] = [];
    const dark = [...o.dark];
    const ops: WakeOps = {
      locked: async () => o.locked,
      unlock: async () => void calls.push('unlock'),
      dark: async () => (calls.push('look'), dark.length > 1 ? dark.shift()! : dark[0]!),
      home: async () => void calls.push('home'),
      sleep: async () => {},
      force: o.force,
    };
    let error = '';
    await wakeScreen(ops).catch((e: Error) => (error = e.message));
    return { calls, error };
  };
  // the capture gave no picture and the screen can't be looked at: Home, Home (once), then it's left as it is
  assert.deepEqual(await run({ locked: false, dark: [null, null], force: true }), { calls: ['look', 'home', 'home', 'look'], error: '' });
  // ...and woke it
  assert.deepEqual(await run({ locked: false, dark: [null, false], force: true }), { calls: ['look', 'home', 'home', 'look'], error: '' });
  // a screen that shows something is never pressed, forced or not
  assert.deepEqual(await run({ locked: false, dark: [false], force: true }), { calls: ['look'], error: '' });
  // not forced: nothing pressed blind (as before)
  assert.deepEqual(await run({ locked: false, dark: [null] }), { calls: ['look'], error: '' });
  ok('wake for a picture: a screen that can\'t be looked at counts as dark (Home, Home), one that shows something is never pressed');
}
{
  const calls: string[] = [];
  let failWith = '';
  const b = {
    mock: true,
    list: async () => [],
    lock: async () => {},
    unlock: async (_u: string, opts?: { force?: boolean }) => {
      calls.push(opts?.force ? 'unlock forced' : 'unlock');
      if (failWith) throw new Error(failWith);
    },
    isLocked: async () => false,
    silence: (_u: string, why: string) => void calls.push(`silence ${why}`),
  } as unknown as Backend;
  const idle = new IdleLock(b, () => 0, { tickMs: 0, log: () => {} });
  assert.equal(await idle.wakeForPicture('P'), null);
  assert.deepEqual(calls, ['unlock forced', 'silence woken'], 'woken (forced), then kept silent');
  calls.length = 0;
  failWith = "the phone's control link is restarting, so its screen can't be woken yet";
  assert.equal(await idle.wakeForPicture('P', false), failWith, 'why it could not be woken, in a line');
  assert.deepEqual(calls, ['unlock']);
  idle.close();
  ok('idle: a wake for a picture is forced, silences the phone after, and says why when it can\'t');
}

// ---- 3. silent ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-'));
  const file = path.join(dir, 'audio-volume.json');
  const presses: string[] = [];
  const v = new VolumeGuard({ percent: 50, silent: true, press: async (u, d) => void presses.push(`${u}:${d}`), file, log: () => {}, silenceEveryMs: 60_000 });
  assert.equal(v.enabled, false, 'never raised while silent');
  await v.raise('A');
  assert.deepEqual(presses, [], 'a listener raises nothing');
  await v.silence('A', true, 'its WDA came up');
  assert.deepEqual(presses, Array(VOLUME_STEPS + 1).fill('A:down'), 'all the way down');
  assert.equal(v.isRaised('A'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'nothing written as raised');
  presses.length = 0;
  await v.silence('A', false, 'woken');
  assert.deepEqual(presses, [], 'a wake right after does not press again');
  await v.silence('A', true, 'its WDA came up again');
  assert.equal(presses.length, VOLUME_STEPS + 1, 'a WDA start always does');
  // a press that fails is tried a few times, then left to the next start (never forever)
  presses.length = 0;
  let fails = 0;
  const w = new VolumeGuard({ percent: 0, silent: true, press: async () => void (fails++, (() => { throw new Error('WDA is not up'); })()), file, log: () => {}, retryMs: 5 });
  await w.silence('B', true);
  await sleep(200);
  assert.equal(fails, 5, 'tried 5 times, then left');
  assert.equal(w.isRaised('B'), false);
  w.close();
  v.close();
  fs.rmSync(dir, { recursive: true, force: true });
  ok('silent: the volume is never raised; driven all the way down when WDA comes up, after a wake at most every few minutes');
}

console.log(`\nall ${passed} screen/wake/silence checks passed`);
