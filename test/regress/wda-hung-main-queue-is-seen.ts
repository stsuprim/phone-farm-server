// §10 and R2 ("a hung main queue with a live process is silent"): /status answers off the main queue, so a main
// queue stuck for good looked "alive" and "busy" forever and "recovered" was logged while every request failed.
// With a main-queue heartbeat the phone's state says Hung within seconds, it is never said "ready", and no restart
// starts while one of our requests is still on the phone.
import { assert, regress, sleep, startFarm, until } from '../harness/index.js';

regress('wda-hung-main-queue-is-seen', async (t) => {
  const farm = await startFarm({ phones: [{}], extras: { watchMs: 1000 } });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  const starts = farm.runnerStarts(u).length;
  const ctl = await farm.control(u);
  t.later(() => ctl.close());
  ph.setHung(true);
  const t0 = Date.now();
  // the owner tries a tap now and then
  const tapping = (async () => {
    while (Date.now() - t0 < 30_000) {
      await ctl.send({ type: 'tap', x: 0.5, y: 0.5, unit: 'norm', owner: true }, 15_000);
      await sleep(2000);
    }
  })();
  const hungRe = /"(state|control|raw|main|link)":"hung"/i;
  const seen = await until(async () => hungRe.test(JSON.stringify(await farm.phone(u))), 30_000, 500);
  const seenMs = Date.now() - t0;
  await tapping;
  const restartsWhileOnPhone = farm.runnerStarts(u).length - starts;
  t.note(`hung ${seen ? `said after ${Math.round(seenMs / 1000)} s` : 'never said'}; restarts during it: ${restartsWhileOnPhone}`);
  assert.ok(seen, 'the phone was said "hung" within 30 s');
  assert.equal(restartsWhileOnPhone, 0, 'no restart while our requests were still on the phone');
  ph.setHung(false);
  assert.ok(await farm.waitReady(u, 20_000), 'ready again once the main queue answers');
}, { timeoutMs: 120_000 });
