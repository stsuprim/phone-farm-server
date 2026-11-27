// §8, e8e390e ("touches never wait behind such a read or a dead runner"): while the agent reads TikTok's screen (a
// tree that takes 5 s inside the app, on WDA's ONE main queue), the owner's taps still land at once: p95 of the ack
// under 1 s and none dropped. On a real phone a touch sent "beside" a read waits behind it on the phone, so the only
// way is a reserved turn for input (a look starts only when no input is recent or queued) or a look cut short.
import { assert, p95, regress, sleep, startFarm } from '../harness/index.js';

regress('touches-never-wait-behind-read', async (t) => {
  const farm = await startFarm({ phones: [{}] });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  ph.videoApp = true;
  ph.opts.appReadMs = 5000;
  const ctl = await farm.control(u);
  t.later(() => ctl.close());
  const t0 = Date.now();
  const WINDOW = 12_000;
  const lat: number[] = [];
  const fails: string[] = [];
  await Promise.all([
    (async () => {
      // the agent: a fresh tree, again and again
      while (Date.now() - t0 < WINDOW) {
        await farm.get(`/phones/${u}/ui?fresh=1`, 30_000);
        await sleep(100);
      }
    })(),
    (async () => {
      await sleep(400);
      // the owner: a tap every 600 ms
      while (Date.now() - t0 < WINDOW) {
        const s = Date.now();
        const a = await ctl.send({ type: 'tap', x: 0.5, y: 0.6, unit: 'norm', owner: true }, 15_000);
        lat.push(Date.now() - s);
        if (!a.ok) fails.push(String(a.error).slice(0, 120));
        await sleep(600);
      }
    })(),
  ]);
  t.note(`${lat.length} taps, p95 ${p95(lat)} ms, worst ${Math.max(...lat)} ms, failed ${fails.length}`);
  assert.deepEqual(fails, [], 'no tap was dropped');
  assert.ok(p95(lat) < 1000, `p95 of the owner's taps ${p95(lat)} ms (under 1000 ms)`);
}, { timeoutMs: 90_000 });
