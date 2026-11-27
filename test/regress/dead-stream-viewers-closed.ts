// c691b99 (long runs: dead stream viewers closed): a stream socket whose client answered pings and then went silent
// (a laptop that slept, a dropped Wi-Fi) is closed after the dead bound, so its capture and its idle hold end; a
// jittery but alive client, and a client that never answered pings at all, are left alone.
import { EventEmitter } from 'node:events';
import { assert, find, regress, sleep } from '../harness/index.js';

regress('dead-stream-viewers-closed', async (t) => {
  const streamHeartbeat = await find<(ws: any, pingMs: number, deadMs: number, onDead: (ms: number) => void) => () => void>('server', 'streamHeartbeat');
  const sock = (answers: 'always' | 'then-silent' | 'never') => {
    const ws = new EventEmitter() as EventEmitter & { ping(): void; readyState: number; pings: number };
    ws.readyState = 1;
    ws.pings = 0;
    ws.ping = () => {
      ws.pings++;
      const alive = answers === 'always' || (answers === 'then-silent' && ws.pings <= 2);
      if (alive) setTimeout(() => ws.emit('pong'), 5 + Math.random() * 40);
    };
    return ws;
  };
  const dead: string[] = [];
  const stops = (['always', 'then-silent', 'never'] as const).map((k) => streamHeartbeat(sock(k), 50, 400, () => dead.push(k)));
  await sleep(1200);
  for (const s of stops) s();
  t.note(`closed: ${dead.join(', ') || 'none'}`);
  assert.deepEqual(dead, ['then-silent'], 'only the client that answered and then went silent was closed');
}, { timeoutMs: 10_000 });
