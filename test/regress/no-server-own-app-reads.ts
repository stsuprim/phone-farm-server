// §7, c221b93 / e8e390e ("never read the app in front on its own"): with TikTok in front (its accessibility never
// answers), nothing the SERVER does by itself reads the app in front: the watch, the card, the list, the focus, a
// warm-up, an open control link. A read like that runs inside TikTok on its main thread and held WDA's main queue.
import { assert, regress, sleep, startFarm } from '../harness/index.js';

regress('no-server-own-app-reads', async (t) => {
  const farm = await startFarm({ phones: [{}], extras: { watchMs: 500 } });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  ph.videoApp = true; // TikTok's feed in front from here on
  ph.opts.appReadMs = 'hang';
  const t0 = Date.now();
  const ctl = await farm.control(u);
  t.later(() => ctl.close());
  await farm.post(`/phones/${u}/focus`, {}, 10_000);
  await farm.post(`/phones/${u}/warm`, {}, 10_000);
  const end = Date.now() + 8000;
  let n = 0;
  while (Date.now() < end) {
    await Promise.all([farm.phones(), n % 2 === 0 ? farm.get(`/phones/${u}/info?fresh=1`, 10_000) : null]);
    n++;
    await sleep(500);
  }
  const reads = ph.since(t0).filter((h) => h.appRead).map((h) => h.label);
  t.note(`${n} list/card polls, reads of the app in front: ${reads.length}`);
  assert.deepEqual(reads, [], 'not one read of the app in front was sent by the server on its own');
  assert.equal(ph.deaths, 0);
}, { timeoutMs: 60_000 });
