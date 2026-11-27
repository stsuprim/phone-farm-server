// §3 ("a stop then an immediate start can overlap"): kill() dropped the process at once but SIGKILL came 1.5 s
// later, so a new open could spawn a second phonecap on a screen device the first one still held (likely exit 9). A
// stop completes (the process exited) before any start: never two captures alive on one phone.
import { assert, captureRig, regress, sleep } from '../harness/index.js';

regress('capture-stop-before-start', async (t) => {
  const rig = await captureRig({ stopMs: 1500 }, { idleMs: 200 });
  t.logs = rig.logs;
  t.later(() => rig.close());
  const v = await rig.watch();
  v.close(); // the last viewer leaves: the capture stops after its grace, and takes 1.5 s to exit
  await sleep(350); // stopping now
  const again = await rig.watch(); // the viewer comes back at once
  t.later(() => again.close());
  await sleep(2000);
  t.note(`starts ${rig.fc.starts}, most alive at once ${rig.fc.maxAlive}`);
  assert.ok(rig.fc.maxAlive <= 1, `${rig.fc.maxAlive} captures were alive at once`);
  assert.ok(again.got.length > 0, 'the returning viewer got its picture');
}, { timeoutMs: 30_000 });
