// §11 and R5 ("updates do not restart runners"): every pushed commit restarted the server, and its shutdown deleted
// every WDA session and killed every runner and capture (src/real.ts close -> wda.shutdown), which is what jams
// XCTest. The API layer's shutdown (what src/index.ts runs on an update: server.close, then the backend's close)
// leaves the device layer up: no runner killed, no session deleted on the phone.
import { assert, regress, sleep, startFarm } from '../harness/index.js';

regress('updates-do-not-restart-runners', async (t) => {
  const farm = await startFarm({ phones: [{}, {}] });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const t0 = Date.now();
  // the update's shutdown, as src/index.ts does it
  farm.server.closeAllConnections?.();
  farm.server.close();
  await Promise.race([farm.backend.close(), sleep(15_000)]);
  const kills = farm.runnerKills().length;
  const deleted = farm.phonesOnDesk.reduce((n, p) => n + p.since(t0).filter((h) => h.method === 'DELETE' && /^\/session\//.test(h.route)).length, 0);
  const down = farm.phonesOnDesk.filter((p) => !p.up).length;
  t.note(`runners killed ${kills}, sessions deleted ${deleted}, phones' WDA down ${down}`);
  assert.equal(kills, 0, 'no runner was killed by the API shutdown');
  assert.equal(deleted, 0, 'no WDA session was deleted');
  assert.equal(down, 0, "every phone's WDA still answers");
}, { timeoutMs: 60_000 });
