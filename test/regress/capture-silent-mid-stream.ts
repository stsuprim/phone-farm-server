// §3 ("liveness is checked only up to the first frame"): after its first frame nothing watched the capture, so a
// CoreMediaIO session that died mid-stream ran on forever and a still screen looked the same. With a heartbeat from
// the helper the two are told apart: a session whose heartbeat stops is started over within seconds; a still screen
// (heartbeat on, no new frames) is left alone.
import { assert, captureRig, regress, sleep, until } from '../harness/index.js';

regress('capture-silent-mid-stream', async (t) => {
  // 1. a still screen: frames for 1 s, then none, the heartbeat goes on
  const still = await captureRig({ heartbeatMs: 300, stillAfterMs: 1000 });
  t.later(() => still.close());
  await still.watch();
  await sleep(7000);
  const stillStarts = still.fc.starts;
  // 2. a dead session: frames for 1 s, then nothing at all (no frames, no heartbeat), the process still there
  const dead = await captureRig({ heartbeatMs: 300, dieAfterMs: 1000 });
  t.logs = dead.logs;
  t.later(() => dead.close());
  await dead.watch();
  const t0 = Date.now();
  const restarted = await until(() => dead.fc.starts >= 2, 9000, 50);
  t.note(`still screen: ${stillStarts} start(s); dead session: ${restarted ? `started over after ${Date.now() - t0 - 1000} ms of silence` : 'never started over'}`);
  assert.equal(stillStarts, 1, 'a still screen (heartbeat on) is not restarted');
  assert.ok(restarted, 'a session that went silent mid-stream (no heartbeat) was started over within 8 s');
}, { timeoutMs: 40_000 });
