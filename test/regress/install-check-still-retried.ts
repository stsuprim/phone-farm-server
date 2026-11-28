// §11, 2026-11-28: the fork install check's /lotus/shot is tried again with a short backoff, so a request ahead of it
// or a slow first screenshot doesn't roll a good build back.
import { assert, regress, startFarm } from '../harness/index.js';

regress('install-check-still-retried', async (t) => {
  const farm = await startFarm({ phones: [{}] });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const u = farm.phonesOnDesk[0]!.udid;
  const wda = farm.wda as any;
  const e = wda.entries.get(u);
  Object.assign(e, { forkInfo: { lotus: 7 }, status: 'ready', sessionId: 's1', screen: { width: 390, height: 844 } });
  let calls = 0;
  wda.shot = async () => {
    if (++calls < 3) throw new Error('timed out behind another request');
    return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  };
  const missing = await wda.forkWorks(u);
  assert.equal(missing, null, `the check passes on the third try: ${missing}`);
  assert.equal(calls, 3);
}, { timeoutMs: 30_000 });
