// The capture source (src/h264.ts today, src/capture/source.ts after the rebuild) on a fake phonecap, with fake
// viewers that only record what they were sent.
import { fakeCapture, FakeCaptureOptions, Rec } from './fakecapture.js';
import { find } from './src.js';

export interface FakeViewer {
  viewer: any;
  got: Rec[];
  close(): void;
}

export async function captureRig(fakeOpts: FakeCaptureOptions = {}, sourceOpts: Record<string, unknown> = {}) {
  const H264Source = await find('capture', 'H264Source');
  const H264Viewer = await find('capture', 'H264Viewer');
  const KIND = await find<Record<string, number>>('capture', 'KIND');
  const logs: string[] = [];
  const fc = fakeCapture({ beatKind: KIND.BEAT ?? KIND.STATS, ...fakeOpts });
  const want = { fps: 30, scale: 50, bitrate: 4_000_000 };
  const src = new H264Source('fake', fc.start, want, { idleMs: 300, log: (m: string) => logs.push(m), ...sourceOpts });
  const viewers: FakeViewer[] = [];
  const viewer = (): FakeViewer => {
    const got: Rec[] = [];
    let open = true;
    const t = { kind: 'ws' as const, buffered: () => 0, open: () => open, send: (r: Rec) => void got.push(r), fail: () => void (open = false) };
    const v = new H264Viewer(t, src);
    const fv: FakeViewer = {
      viewer: v, got,
      close: () => {
        open = false;
        src.remove(v);
      },
    };
    viewers.push(fv);
    return fv;
  };
  /** A live view: open, then the viewer added (what the server does for a stream or a WebRTC track). */
  const watch = async (): Promise<FakeViewer> => {
    await src.open();
    const v = viewer();
    src.add(v.viewer);
    return v;
  };
  return {
    src, fc, KIND, logs, viewer, watch,
    close: () => {
      for (const v of viewers) v.close();
      try {
        src.close?.('test over');
      } catch {
        /* closed */
      }
    },
  };
}
