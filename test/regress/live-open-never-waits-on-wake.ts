// §4 ("Couldn't open" was the wake failing, not the picture): opening a live view needs only the USB capture and
// WebRTC. A picture-only open (POST /phones/:udid/open) answers at once even while the phone's WDA is hung, and
// puts nothing on WDA's main queue; the wake is a separate action (POST /wake) that can't fail the open.
import { assert, regress, startFarm } from '../harness/index.js';

regress('live-open-never-waits-on-wake', async (t) => {
  const farm = await startFarm({ phones: [{ locked: true }], extras: { watchMs: 0 } });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  ph.setHung(true); // WDA busy for good: a wake could never finish
  const t0 = Date.now();
  const r = await farm.post(`/phones/${u}/open`, {}, 10_000);
  const ms = Date.now() - t0;
  const onMain = ph.since(t0).filter((h) => h.onMain).map((h) => h.label);
  t.note(`open answered ${r.status} in ${ms} ms; on WDA's main queue: ${onMain.join(', ') || 'nothing'}`);
  assert.ok(r.status >= 200 && r.status < 300, `POST /open answered ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  assert.ok(ms < 3000, `the open answered in ${ms} ms`);
  assert.deepEqual(onMain, [], 'the open put nothing on WDA (no wake, no unlock)');
  ph.setHung(false);
}, { timeoutMs: 40_000 });
