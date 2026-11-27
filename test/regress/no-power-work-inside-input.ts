// §2.3 and §8 ("work inserted before a touch"): after a quiet spell (over 25 s without input, AWAKE_FOR_MS), the
// owner's next tap goes to the phone first. No lock check, dark check (a screenshot), unlock, Home or session check
// is put on the phone in front of it: power actions never run as a side effect of an input.
import { assert, regress, sleep, startFarm, maybe } from '../harness/index.js';

regress('no-power-work-inside-input', async (t) => {
  const farm = await startFarm({ phones: [{}], extras: { watchMs: 0 } });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  const awake = (await maybe<number>('idle', 'AWAKE_FOR_MS')) ?? 25_000;
  // one tap so the phone is known awake, then a quiet spell longer than "awake for"
  await farm.post(`/phones/${u}/tap`, { x: 0.5, y: 0.5, unit: 'norm', owner: true }, 10_000);
  await sleep(Math.min(awake, 40_000) + 1500);
  const t0 = Date.now();
  const r = await farm.post(`/phones/${u}/tap`, { x: 0.5, y: 0.5, unit: 'norm', owner: true }, 30_000);
  const ms = Date.now() - t0;
  const hits = ph.since(t0);
  const touchAt = hits.findIndex((h) => /touch|gesture|actions|tap/.test(h.route));
  const before = (touchAt < 0 ? hits : hits.slice(0, touchAt)).filter((h) => h.onMain).map((h) => h.label);
  t.note(`tap answered in ${ms} ms; in front of it on the phone: ${before.join(', ') || 'nothing'}`);
  assert.equal(r.status, 200, `the tap worked: ${JSON.stringify(r.body)}`);
  assert.ok(touchAt >= 0, 'the touch reached the phone');
  assert.deepEqual(before, [], 'nothing of ours was put on the main queue in front of the tap');
  assert.ok(ms < 1000, `the tap was answered in ${ms} ms`);
}, { timeoutMs: 90_000 });
