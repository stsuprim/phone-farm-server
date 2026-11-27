// §5 (iPhone-2: 22 freezes of about 7 s over a far link, RTT about 185 ms, jitter about 127 ms): the queue estimate
// read jitter as queueing, so the bitrate was cut every 2 s and ratcheted to the floor. On a link with that much
// jitter and NO loss and NO real queue, the controller holds a usable bitrate: never at the floor for over 10 s, and
// most of the 2 minutes well above it. Seeded, so every run sees the same path.
import { assert, find, maybe, regress } from '../harness/index.js';

regress('far-link-jitter-not-congestion', async (t) => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
  let now = 1_000_000;
  const clock = () => now;
  const START = 1_500_000;
  const CEIL = 2_500_000;
  const rtt = () => 185 + Math.abs(gauss()) * 127; // a long path whose delay varies; nothing queues
  let step: () => number; // one second on; the bitrate after it
  let floor: number;
  let how: string;
  const LinkControl = await maybe('congestion', 'LinkControl');
  if (LinkControl) {
    // the rebuild's loop (LinkControl): RTCP round trips and RTP jitter in, one tick a second
    const lc = new LinkControl({ ceiling: CEIL, start: START, remote: true, now: clock });
    floor = (await maybe<Record<string, { floorBps: number }>>('congestion', 'LINK_CLASSES'))?.far?.floorBps ?? 300_000;
    how = 'LinkControl';
    step = () => {
      for (let i = 0; i < 2; i++) {
        lc.delay.add(rtt());
        lc.delay.addJitter?.(127);
        now += 500;
      }
      return lc.tick({ sent: 120, nacked: 0, reportLoss: 0 }).bps;
    };
  } else {
    // the loop before the rebuild (src/rtc.ts): DelayTracker's queue against DELAY_MARKS.remote, RateControl
    const DelayTracker = await find('congestion', 'DelayTracker');
    const RateControl = await find('congestion', 'RateControl');
    const marks = (await find('rtc', 'DELAY_MARKS')).remote;
    const hold = await find<number>('rtc', 'DELAY_HOLD_MS');
    floor = await find<number>('congestion', 'MIN_BPS');
    const dt = new DelayTracker(30_000, clock);
    const rc = new RateControl(CEIL, START, floor, clock);
    how = 'DelayTracker + DELAY_MARKS';
    step = () => {
      for (let i = 0; i < 2; i++) {
        dt.add(rtt());
        now += 500;
      }
      const q = dt.queueMs();
      if (q !== null && q > marks.hard) rc.down(0.6, null, hold);
      else if (q !== null && q > marks.cut) rc.down(0.85, null, hold);
      else if (q !== null && q < marks.clear) rc.up();
      return rc.bps;
    };
  }
  let run = 0;
  let worstRun = 0;
  let above = 0;
  const N = 120;
  let last = 0;
  for (let s = 0; s < N; s++) {
    last = step();
    run = last <= floor * 1.05 ? run + 1 : 0;
    worstRun = Math.max(worstRun, run);
    if (last >= floor * 2) above++;
  }
  t.note(`${how}: ends at ${Math.round(last / 1000)} kbit/s, longest at the floor ${worstRun} s, ${above}/${N} s at twice the floor or more`);
  assert.ok(worstRun <= 10, `at the floor for ${worstRun} s in a row with no loss`);
  assert.ok(above >= N * 0.6, `only ${above} of ${N} s were well above the floor`);
}, { timeoutMs: 20_000 });
