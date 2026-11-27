// §10 (and 0f60be5, edf2be3): a runner whose process is gone (its port refuses every connection: iPhone-1's
// ECONNRESET) is restarted by itself, once, and the phone is ready again; the old runner is torn down before the new
// one starts (never two runners on one phone).
import { assert, regress, startFarm, until } from '../harness/index.js';

regress('wda-dead-runner-restarted', async (t) => {
  const farm = await startFarm({ phones: [{}] });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const before = farm.runnerStarts(ph.udid).length;
  assert.equal(before, 1, 'one runner at the start');

  const t0 = Date.now();
  ph.kill('process gone');
  // a client keeps using it (the owner's taps): the dead link is noticed from those and from the probes
  const tapper = (async () => {
    while (Date.now() - t0 < 25_000 && farm.runnerStarts(ph.udid).length === before) {
      await farm.post(`/phones/${ph.udid}/tap`, { x: 0.5, y: 0.5, unit: 'norm', owner: true }, 6000);
      await new Promise((r) => setTimeout(r, 800));
    }
  })();
  assert.ok(await until(() => farm.runnerStarts(ph.udid).length > before, 30_000, 100), 'a new runner was started within 30 s');
  await tapper;
  assert.ok(await farm.waitReady(ph.udid, 20_000), 'ready again');
  const restartMs = Date.now() - t0;
  const starts = farm.runnerStarts(ph.udid);
  assert.equal(starts.length, before + 1, `exactly one restart (${starts.length - before})`);
  // the old runner was killed before (or as) the new one started
  const old = starts[0]!;
  assert.ok(old.killedAt !== null && old.killedAt <= starts[1]!.at + 50, 'the old runner was torn down before the new one');
  const tap = await farm.post(`/phones/${ph.udid}/tap`, { x: 0.5, y: 0.5, unit: 'norm', owner: true }, 10_000);
  assert.equal(tap.status, 200, `a tap works after the restart: ${JSON.stringify(tap.body)}`);
  t.note(`back in ${Math.round(restartMs / 100) / 10} s`);
}, { timeoutMs: 90_000 });
