// §6 ("the picture lies about its age"): a capture that stopped delivering answered every key request with the old
// screen stamped "now", and a new viewer was primed with a cached keyframe however old. Every frame keeps its true
// capture time (a re-encode is flagged `repeat`), and the source says how old its newest picture is.
import { assert, captureRig, regress, sleep } from '../harness/index.js';

regress('stale-frame-labelled', async (t) => {
  // frames for 1 s, then the session dies (a key request re-encodes the last picture, as phonecap does)
  const rig = await captureRig({ dieAfterMs: 1000, rekey: 'true-time' });
  t.logs = rig.logs;
  t.later(() => rig.close());
  await rig.watch();
  await sleep(3000);
  const lastReal = rig.fc.lastFrameAt;
  // a new viewer joins the stalled capture
  const late = rig.viewer();
  rig.src.add(late.viewer);
  await sleep(600);
  const keys = late.got.filter((r) => r.kind === rig.KIND.KEY || r.kind === rig.KIND.KEY_REPEAT);
  const lying = keys.filter((r) => r.time > lastReal + 50 && !r.repeat);
  const stats = rig.src.stats?.() ?? {};
  const age = stats.frame_age_ms ?? stats.frameAgeMs ?? stats.age_ms ?? stats.picture_age_ms ?? null;
  t.note(`${keys.length} keyframe(s) to the late viewer, ${lying.length} stamped newer than the last real frame; source says age ${age}`);
  assert.ok(keys.length > 0, 'the late viewer got a picture');
  assert.deepEqual(lying.map((r) => r.time - lastReal), [], 'no frame claims to be newer than the last real one');
  assert.ok(typeof age === 'number' && age >= 2000, `the source says its newest picture is about 3 s old (said ${age})`);
}, { timeoutMs: 30_000 });
