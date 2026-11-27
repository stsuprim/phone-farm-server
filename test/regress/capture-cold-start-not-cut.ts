// §3 ("the open timeout is shorter than a cold start"): after a replug phonecap may take 12 s to find the screen
// device and 5 s more for the first frame, while open() gave up at 8 s; each retry then started cold again and a
// slow start could never finish. With the source's own defaults, an open waits on the capture's state: a capture
// that says it is still finding the device, then capturing, is waited for, not cut at a fixed 8 s.
import { assert, captureRig, regress } from '../harness/index.js';

regress('capture-cold-start-not-cut', async (t) => {
  // the device is found after 7 s, the first frame 4 s later (11 s in all)
  const rig = await captureRig({ findMs: 7000, firstFrameMs: 4000, heartbeatMs: 500 }, { idleMs: 2500 });
  t.logs = rig.logs;
  t.later(() => rig.close());
  const t0 = Date.now();
  let err = '';
  const info = await rig.src.open().catch((e: Error) => {
    err = e.message;
    return null;
  });
  const ms = Date.now() - t0;
  t.note(info ? `picture after ${ms} ms, ${rig.fc.starts} start(s)` : `open failed after ${ms} ms: ${err}`);
  assert.ok(info, `the open waited for the cold start (${err})`);
  assert.equal(rig.fc.starts, 1, 'one cold start, not cut and started cold again');
}, { timeoutMs: 40_000 });
