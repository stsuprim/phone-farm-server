// §6 and R3 ("no Home press from inference"): when a live view has no picture yet and the screen "can't be looked
// at" (WDA too busy for a screenshot, or a still that isn't a picture), the server's own wake must not press Home:
// that sent a posting hand's TikTok to the Home Screen. A Home press only goes out when someone asked for it, or on
// an observed dark or locked screen.
import { assert, find, regress, sleep, startFarm } from '../harness/index.js';

regress('no-home-press-from-inference', async (t) => {
  const IdleLock = await find('idle', 'IdleLock');
  // the server's idle/power object, made here so the test can fire the live view's "no picture yet" wake itself
  let idle: any;
  const farm = await startFarm({
    phones: [{ unreadableStills: true, videoApp: true, appReadMs: 'hang' }],
    extras: { watchMs: 0 },
  }).then(async (f) => f);
  t.logs = farm.logs;
  t.later(() => farm.close());
  const ph = farm.phonesOnDesk[0]!;
  const u = ph.udid;
  try {
    idle = new IdleLock(farm.backend, () => 0, { tickMs: 0 });
  } catch {
    idle = null;
  }
  const t0 = Date.now();
  // 1. the server's "no picture after 2.5 s" wake (src/rtc.ts / server.ts' stream), when it still exists
  if (idle && typeof idle.wakeForPicture === 'function') await Promise.race([idle.wakeForPicture(u, true), sleep(25_000)]);
  // 2. a live view opened on the phone (whatever it does when no picture comes)
  await farm.stream(u, 'h264', 8000).then((v) => v.close(), () => {});
  await sleep(500);
  const homes = ph.homePresses().filter((h) => h.queuedAt >= t0);
  t.note(`Home presses not asked for: ${homes.length}`);
  assert.equal(homes.length, 0, 'no Home press went out without being asked for');
  assert.equal(ph.videoApp, true, 'TikTok is still in front');
}, { timeoutMs: 60_000 });
