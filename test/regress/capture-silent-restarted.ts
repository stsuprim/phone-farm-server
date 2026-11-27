// §3, fffd0c1 ("never leave a silent phonecap running": iPhone-2 stuck on "connecting" after a replug): a capture
// whose session runs but never gives a frame is ended and started over within its first-frame bound, never two at
// once, and a later start's picture reaches the open that waited.
import { assert, captureRig, regress, until } from '../harness/index.js';

regress('capture-silent-restarted', async (t) => {
  const rig = await captureRig({ firstFrameMs: 'never' }, { firstKeyMs: 1500, openTimeoutMs: 12_000 });
  t.logs = rig.logs;
  t.later(() => rig.close());
  const t0 = Date.now();
  const opening = rig.src.open();
  assert.ok(await until(() => rig.fc.starts >= 2, 5000), `the silent capture was started over (${rig.fc.starts} starts)`);
  const restartMs = Date.now() - t0;
  // from now on a start gives a picture: the open that waited gets it
  rig.fc.opts.firstFrameMs = 50;
  const info = await opening;
  t.note(`started over after ${restartMs} ms; ${rig.fc.starts} starts; picture ${info?.width}x${info?.height} after ${Date.now() - t0} ms`);
  assert.ok(rig.fc.maxAlive <= 1, `${rig.fc.maxAlive} captures ran at once on one screen`);
}, { timeoutMs: 40_000 });
