// cfb1be2 (a capture only while a live view is open, the agent on stills): the agent's reads and actions never start
// the phone's USB capture on their own (iOS tells apps their screen is captured), and they never stop or interrupt a
// live view's capture either: while the owner watches and the agent works, the capture stays on; when the last viewer
// leaves it stops after its grace, the agent still working.
import { assert, mockServer, regress, sleep, until } from '../harness/index.js';

regress('capture-on-while-agent-works', async (t) => {
  const GRACE = 400;
  const srv = await mockServer({ phones: 2, mock: { h264IdleMs: GRACE }, extras: { watchMs: 100 } });
  t.logs = srv.logs;
  t.later(() => srv.close());
  const u = (await srv.phones())[0].udid as string;
  const capturing = async () => !!(await srv.phone(u))?.capturing;
  let stop = false;
  const agent = (async () => {
    while (!stop) {
      await srv.get(`/phones/${u}/ui`, 10_000);
      await srv.post(`/phones/${u}/swipe`, { x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.3, unit: 'norm' }, 10_000);
      await sleep(100);
    }
  })();
  t.later(async () => {
    stop = true;
    await agent;
  });
  await sleep(800);
  assert.equal(await capturing(), false, "the agent's work alone never started the capture");
  const view = await srv.stream(u, 'h264', 5000);
  let off = 0;
  for (let i = 0; i < 20; i++) {
    if (!(await capturing())) off++;
    await sleep(100);
  }
  assert.equal(off, 0, 'the capture stayed on the whole time the owner watched and the agent worked');
  assert.ok(view.frames > 0, 'the live view kept getting frames');
  view.close();
  assert.ok(await until(async () => !(await capturing()), GRACE + 3000, 50), 'it stopped after its grace once the viewer left, the agent still working');
  t.note(`${view.frames} frames while the agent worked`);
}, { timeoutMs: 30_000 });
