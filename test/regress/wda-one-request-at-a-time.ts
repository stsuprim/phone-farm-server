// §2, 7cd29d7 ("one WDA request at a time per phone"): whatever the clients do at once (the agent's reads and
// actions, the owner's taps, the card, a wake), the phone's main queue never has more than ONE request of ours open
// on it. A second one only waits on the phone behind the first (R1), so the Mac must never send it.
import { assert, regress, sleep, startFarm } from '../harness/index.js';

regress('wda-one-request-at-a-time', async (t) => {
  // every main-queue route takes 150 ms: enough for overlaps to show if anything is sent beside another request
  const farm = await startFarm({ phones: [{ mainMs: 150 }], extras: { watchMs: 700 } });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  ph.maxMainOpen = 0;
  const end = Date.now() + 10_000;
  const loop = async (fn: () => Promise<unknown>, gap: number) => {
    while (Date.now() < end) {
      await fn();
      await sleep(gap);
    }
  };
  const ctl = await farm.control(u);
  t.later(() => ctl.close());
  await Promise.all([
    loop(() => farm.get(`/phones/${u}/ui`, 20_000), 300), // the agent's reads
    loop(() => farm.post(`/phones/${u}/swipe`, { x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.3, unit: 'norm', fast: true }, 20_000), 450), // the agent's acts
    loop(() => ctl.send({ type: 'tap', x: 0.5, y: 0.5, unit: 'norm', owner: true }, 20_000), 250), // the owner
    loop(() => farm.get(`/phones/${u}/info?fresh=1`, 20_000), 900), // the card
    loop(() => farm.post(`/phones/${u}/wake`, {}, 40_000), 3000), // a wake
  ]);
  t.note(`${ph.hits.filter((h) => h.onMain).length} main-queue requests, most open at once: ${ph.maxMainOpen}`);
  assert.ok(ph.maxMainOpen <= 1, `the Mac had ${ph.maxMainOpen} requests open on the phone's main queue at once`);
}, { timeoutMs: 90_000 });
