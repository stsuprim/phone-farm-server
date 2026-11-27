// §2.1 ("no answer within 80 s to POST /wda/unlock"): a 20 s timeout plus a 60 s hold kept the lane for 80 s while
// the phone's main queue gave nothing back; every touch meanwhile waited 8 s and was dropped as "busy". With one
// deadline per request: the wake answers within a client's 30 s, the phone's state says what is stuck on it, and a
// touch during that is answered (done or refused with the reason) at once, never after a lane wait.
import { assert, regress, sleep, startFarm } from '../harness/index.js';

regress('unlock-not-held-80s', async (t) => {
  const farm = await startFarm({ phones: [{ locked: true }], extras: { watchMs: 0 } });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  ph.opts.stall = ({ route }) => (/\/wda\/unlock$/.test(route) ? 'hang' : undefined);
  const t0 = Date.now();
  const wake = await farm.post(`/phones/${u}/wake`, {}, 40_000);
  const wakeMs = Date.now() - t0;
  assert.ok(ph.hits.some((h) => /\/wda\/unlock$/.test(h.route)), 'the unlock reached the phone');
  assert.ok(wakeMs <= 31_000, `the wake answered in ${Math.round(wakeMs / 1000)} s (a client waits 30 s)`);
  // the unlock is still stuck on the phone: the state says so, and a touch is answered at once
  const p = await farm.phone(u);
  const said = JSON.stringify({ control: p?.control, raw: p?.stats?.controlLink?.wda?.state, onPhone: p?.stats?.controlLink?.wda?.onPhone ?? p?.stats?.controlLink?.wda?.inFlight });
  const s = Date.now();
  const tap = await farm.post(`/phones/${u}/tap`, { x: 0.5, y: 0.5, unit: 'norm', owner: true }, 20_000);
  const tapMs = Date.now() - s;
  t.note(`wake ${wakeMs} ms (${wake.status}), tap ${tapMs} ms (${tap.status} ${String(tap.body?.error ?? '').slice(0, 80)}), state ${said}`);
  assert.notEqual(p?.control, 'ready', 'the phone is not said "ready" while its main queue holds the unlock');
  assert.ok(/unlock/i.test(said), 'the state names what is stuck on the phone (the unlock)');
  assert.ok(tapMs < 2000, `a touch during it was answered in ${tapMs} ms, not after a lane wait`);
  await sleep(10);
}, { timeoutMs: 90_000 });
