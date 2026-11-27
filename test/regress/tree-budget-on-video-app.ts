// §7 (TikTok and Instagram freezing on the phone): the agent's own reads of a video app are budgeted. However
// often a client asks for the screen's tree (GET /ui?fresh=1), at most one tree read is on the phone at a time and
// at most one per 3 s reaches a video app (each one is an accessibility snapshot built inside the app).
import { assert, regress, sleep, startFarm } from '../harness/index.js';

regress('tree-budget-on-video-app', async (t) => {
  const farm = await startFarm({ phones: [{}] });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  // TikTok's feed in front: a read takes 400 ms inside the app, then answers
  await farm.post(`/phones/${u}/launch`, { bundleId: 'com.zhiliaoapp.musically', fast: true }, 20_000);
  ph.videoApp = true;
  ph.opts.appReadMs = 400;
  const t0 = Date.now();
  const WINDOW = 9000;
  const askers = [0, 1].map(async () => {
    while (Date.now() - t0 < WINDOW) {
      await farm.get(`/phones/${u}/ui?fresh=1`, 20_000);
      await sleep(300);
    }
  });
  await Promise.all(askers);
  const reads = ph.since(t0).filter((h) => h.appRead && h.queuedAt - t0 < WINDOW);
  let open = 0;
  let most = 0;
  const ev = reads.flatMap((h) => [{ t: h.queuedAt, d: 1 }, { t: h.answeredAt ?? Infinity, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d);
  for (const e of ev) {
    open += e.d;
    most = Math.max(most, open);
  }
  const budget = Math.floor(WINDOW / 3000) + 1;
  t.note(`${reads.length} reads of the app in ${WINDOW / 1000} s (budget ${budget}), most at once ${most}`);
  assert.ok(most <= 1, `${most} tree reads were on the phone at once`);
  assert.ok(reads.length <= budget, `${reads.length} reads of a video app in ${WINDOW / 1000} s (at most ${budget})`);
}, { timeoutMs: 90_000 });
