// §9 and 8bf520d (segmented drags cut flicks and lost lifts): on iOS 18 XCTest ends every finger at the end of each
// event record, so the owner's drag plays whole on release unless segments are asked for by name; a hold mode is used
// only when the phone's own self-test proved it; "off" is always whole.
import { assert, find, maybe, regress } from '../harness/index.js';

regress('live-drags-whole-on-release', async (t) => {
  const usableLiveMode = await find<(found: number, setting?: string) => number>('fork', 'usableLiveMode');
  const seg = (await maybe<number>('fork', 'LIVE_SEGMENTED')) ?? 4;
  const gapped = (await maybe<number>('fork', 'LIVE_GAPPED')) ?? 5;
  for (const m of [seg, gapped]) {
    assert.equal(usableLiveMode(m, 'auto'), 0, `a segmented mode (${m}) is never used by default`);
    assert.equal(usableLiveMode(m, undefined), 0, `nor with no setting (${m})`);
    assert.equal(usableLiveMode(m, 'segmented'), m, `only when asked for (${m})`);
  }
  assert.equal(usableLiveMode(0, 'auto'), 0, 'no hold mode found: whole on release');
  assert.equal(usableLiveMode(-1, 'auto'), 0);
  assert.equal(usableLiveMode(Number.NaN, 'auto'), 0);
  for (const m of [1, 2, 3]) assert.equal(usableLiveMode(m, 'off'), 0, `"off" is whole on release (${m})`);
  t.note('segments are opt-in; hold modes only from the self-test');
}, { timeoutMs: 10_000 });
