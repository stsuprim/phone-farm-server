// §10, 7cd29d7 / edf2be3 / cfb1be2 ("slow is never dead"): a phone whose every main-queue request takes seconds
// (TikTok in front, a long read) while /status answers is busy, not dead: no runner is killed or restarted, and the
// requests are answered late (or said busy) rather than failed by a restart.
import { assert, regress, sleep, startFarm } from '../harness/index.js';

regress('wda-slow-is-never-dead', async (t) => {
  const farm = await startFarm({ phones: [{}], extras: { watchMs: 1000 } });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  const starts = farm.runnerStarts(u).length;
  ph.opts.mainMs = 6000; // every main-queue request now takes 6 s
  const end = Date.now() + 30_000;
  let answered = 0;
  let restarting = 0;
  const errors: string[] = [];
  const ctl = await farm.control(u);
  t.later(() => ctl.close());
  await Promise.all([
    (async () => {
      while (Date.now() < end) {
        const a = await ctl.send({ type: 'tap', x: 0.5, y: 0.5, unit: 'norm', owner: true }, 40_000);
        if (a.ok) answered++;
        else {
          errors.push(String(a.error));
          if (/is restarting|restarting \(attempt|recovering/i.test(String(a.error))) restarting++;
        }
        await sleep(1500);
      }
    })(),
    (async () => {
      while (Date.now() < end) {
        await farm.get(`/phones/${u}/info?fresh=1`, 30_000);
        await sleep(2000);
      }
    })(),
  ]);
  const p = await farm.phone(u);
  const link = p?.stats?.controlLink?.wda ?? {};
  t.note(`${answered} taps answered, runner starts ${farm.runnerStarts(u).length - starts}, kills ${farm.runnerKills(u).length}, recoveries ${link.recoveries ?? '?'}; errors: ${[...new Set(errors)].join(' | ').slice(0, 300)}`);
  assert.equal(farm.runnerStarts(u).length - starts, 0, 'no runner was restarted');
  assert.equal(farm.runnerKills(u).length, 0, 'no runner was killed');
  assert.equal(ph.deaths, 0);
  assert.equal(restarting, 0, 'no tap was failed by a restart');
  // a slow tap may come back late or as "busy"; it never comes back as a restart, and the phone still works after
  ph.opts.mainMs = 3;
  const after = await ctl.send({ type: 'tap', x: 0.5, y: 0.5, unit: 'norm', owner: true }, 30_000);
  assert.ok(after.ok, `once it's quick again a tap works: ${after.error ?? ''}`);
  if (typeof link.runnerRestarts === 'number') assert.equal(link.runnerRestarts, 0);
}, { timeoutMs: 120_000 });
