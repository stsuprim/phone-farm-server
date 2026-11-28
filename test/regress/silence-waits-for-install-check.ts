// §11, 2026-11-28: v7 rolled back 7 times on both phones. The keep-silent presses (up to 17 volume-down, WDA takes one
// request at a time) fired the moment our build's first session was made, so the install check's /lotus/shot waited
// behind them, failed, and the stock build went back. Now every silence press waits for the install check to pass,
// and the check's still is tried again with a short backoff.
import { assert, regress, startFarm } from '../harness/index.js';

regress('silence-waits-for-install-check', async (t) => {
  const farm = await startFarm({ phones: [{}], cfg: { phoneSilent: true } });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const u = farm.phonesOnDesk[0]!.udid;
  const wda = farm.wda as any;
  const volume = (farm.backend as any).volume;
  const presses: string[] = [];
  volume.silence = (udid: string, _f: boolean, why: string) => {
    presses.push(why);
    return Promise.resolve();
  };

  // 1. a pass: the session comes up during the switch, nothing is pressed until the check has passed
  let checking = false;
  wda.switchFlavor = async () => {
    wda.onSession(u, true); // the first session of our build
    return { ok: true };
  };
  wda.forkWorks = async () => {
    checking = true;
    assert.equal(presses.length, 0, 'no volume press while the install check runs');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(presses.length, 0, 'still none after the check made its request');
    return null;
  };
  const ok = await farm.backend.switchWda(u, 'fork');
  assert.ok(ok.ok && checking, 'the install check passed');
  assert.equal(presses.length, 1, 'the silence runs once, after the pass');
  assert.match(presses[0]!, /install check/);

  // 2. a failure: nothing is pressed by the failed attempt (the stock build's own session silences the phone)
  presses.length = 0;
  wda.forkWorks = async () => 'it gave no still';
  const bad = await farm.backend.switchWda(u, 'fork');
  assert.equal(bad.ok, false);
  assert.equal(presses.length, 0, 'a failed check presses nothing');

  // 3. the hold is gone afterwards: a later fresh session silences at once
  wda.onSession(u, true);
  assert.equal(presses.length, 1, 'a session after the check silences as before');
}, { timeoutMs: 30_000 });

