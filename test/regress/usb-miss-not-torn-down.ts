// §10, 54977f4 ("a phone missing from one USB poll is never torn down"): starting the capture re-enumerates the phone
// on USB and usbmuxd hiccups, so one `idevice_id -l` without it is only a miss: the phone stays online, its runner
// isn't killed or restarted, and taps keep working. Only a phone gone for several polls (seconds) is unplugged.
import { assert, regress, sleep, startFarm, until } from '../harness/index.js';

regress('usb-miss-not-torn-down', async (t) => {
  const farm = await startFarm({ phones: [{}], pollMs: 300 });
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  const starts = farm.runnerStarts(u).length;
  // missing from about two polls (650 ms), then back
  farm.usb.delete(u);
  let offline = false;
  const watch = (async () => {
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      const p = await farm.phone(u);
      if (!p || p.online === false) offline = true;
      await sleep(50);
    }
  })();
  await sleep(650);
  farm.usb.add(u);
  await watch;
  const tap = await farm.post(`/phones/${u}/tap`, { x: 0.5, y: 0.5, unit: 'norm', owner: true }, 10_000);
  assert.equal(offline, false, 'the phone never showed as unplugged');
  assert.equal(farm.runnerKills(u).length, 0, 'its runner was never killed');
  assert.equal(farm.runnerStarts(u).length - starts, 0, 'no runner was started again');
  assert.equal(tap.status, 200, `a tap right after works: ${JSON.stringify(tap.body)}`);
  // and a real unplug (gone well past the offline bound) is still seen
  farm.usb.delete(u);
  assert.ok(await until(async () => (await farm.phone(u))?.online === false, 20_000, 200), 'a phone gone for good shows as unplugged');
}, { timeoutMs: 60_000 });
