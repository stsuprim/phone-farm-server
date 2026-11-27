// 0f60be5 / 54977f4 ("one phone at a time", "xcodebuild starts one at a time"): when both phones' runners die at
// once, the restarts never overlap: a phone's old runner is torn down before its new one starts, and the second
// phone's xcodebuild starts only once the first one's runner is up (or its start turn ran out). Piling runners onto
// the phones is what jammed XCTest.
import { assert, regress, sleep, startFarm, until } from '../harness/index.js';

regress('xcodebuild-one-at-a-time', async (t) => {
  const farm = await startFarm({ phones: [{}, {}], reviveMs: 1500 });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const [a, b] = farm.phonesOnDesk;
  if (!a || !b) throw new Error('two phones');
  const before = farm.runnerStarts().length;
  // when each phone's runner answers again
  const upAt = new Map<string, number>();
  const watch = setInterval(() => {
    for (const p of [a, b]) if (p.up && p.revivals > 0 && !upAt.has(p.udid)) upAt.set(p.udid, Date.now());
  }, 10);
  t.later(() => clearInterval(watch));
  a.kill();
  b.kill();
  const poke = (async () => {
    const end = Date.now() + 40_000;
    while (Date.now() < end && farm.runnerStarts().length < before + 2) {
      await Promise.all([a, b].map((p) => farm.post(`/phones/${p.udid}/tap`, { x: 0.5, y: 0.5, unit: 'norm', owner: true }, 8000)));
      await sleep(700);
    }
  })();
  assert.ok(await until(() => farm.runnerStarts().length >= before + 2, 60_000, 100), 'both phones got a new runner');
  await poke;
  const fresh = farm.runnerStarts().slice(before).sort((x, y) => x.at - y.at);
  const first = fresh[0]!;
  const second = fresh[1]!;
  assert.notEqual(first.udid, second.udid, 'one new runner per phone');
  const firstUp = upAt.get(first.udid!) ?? Infinity;
  t.note(`second start ${second.at - first.at} ms after the first; the first was up after ${firstUp - first.at} ms`);
  assert.ok(second.at >= Math.min(firstUp, first.at + 30_000) - 50, 'the second xcodebuild waited for the first runner to come up');
  for (const p of [a, b]) {
    const s = farm.runnerStarts(p.udid);
    assert.ok(s[0]!.killedAt !== null && s[0]!.killedAt <= s[s.length - 1]!.at + 50, `${p.name}: old runner torn down before the new one`);
  }
}, { timeoutMs: 120_000 });
