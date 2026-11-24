// The PC keyboard and clipboard on the phone (2026-11-24): the ops, the keys in order, what a copy or cut gives back,
// secure fields never read, nothing typed in a log, and how WDA is asked (stock, our build old and new).
process.env.INPUT_LOG = '1';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Control } from '../src/control.js';
import { cutText, isSelectAll, KeyStep, MAX_PASTE_TEXT, modFlags, parseClipboard, parseKeyOps, pieces, typable } from '../src/keys.js';
import { LaneBusy } from '../src/lane.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import { Backend, HttpError } from '../src/types.js';
import { WdaManager } from '../src/wda.js';

let passed = 0;
const origLog = console.log;
const logs: string[] = [];
const ok = (name: string) => {
  passed++;
  origLog(`ok - ${name}`);
};
console.log = (...a: unknown[]) => void logs.push(a.join(' '));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
};
const bad = (status: number) => (e: unknown) => e instanceof HttpError && e.status === status;

// ---- the ops ----
{
  assert.deepEqual(parseKeyOps([{ text: 'he' }, { text: 'y' }, { key: 'backspace', mods: [], n: 2 }, { key: 'enter', mods: [], n: 1 }]), [{ text: 'hey\b\b\n' }], 'text, Backspace and Return: one request');
  assert.deepEqual(parseKeyOps([{ key: 'left', mods: ['shift'], n: 3 }]), [{ key: 'left', mods: ['shift'], n: 3 }]);
  assert.deepEqual(parseKeyOps([{ key: 'home', mods: [], n: 1 }, { key: 'end', mods: ['shift'] }, { key: 'up', mods: ['cmd'], n: 1 }]), [
    { key: 'left', mods: ['cmd'], n: 1 }, { key: 'right', mods: ['shift', 'cmd'], n: 1 }, { key: 'up', mods: ['cmd'], n: 1 },
  ], "Home and End are the line's, never the Home button");
  assert.deepEqual(parseKeyOps([{ key: 'ArrowLeft', mods: ['alt'] }, { key: 'Delete' }, { key: 'Escape' }, { key: 'Tab', mods: ['shift'] }]), [
    { key: 'left', mods: ['alt'], n: 1 }, { key: 'delete', mods: [], n: 1 }, { key: 'escape', mods: [], n: 1 }, { key: 'tab', mods: ['shift'], n: 1 },
  ]);
  assert.deepEqual(parseKeyOps([{ key: 'z', mods: ['cmd', 'shift'], n: 1 }]), [{ key: 'z', mods: ['cmd', 'shift'], n: 1 }]);
  assert.deepEqual(parseKeyOps([{ key: 'a', mods: [], n: 2 }, { key: 'b', mods: ['shift'] }]), [{ text: 'aaB' }], 'a letter with no shortcut is typed');
  for (const v of [undefined, [], {}, [{}], [{ text: 5 }], [{ key: 'f99' }], [{ key: 'constructor' }], [{ key: 'a', mods: ['hyper'] }], [{ key: 'a', mods: 'cmd' }], [{ key: 'left', n: 0 }], [{ key: 'left', n: 101 }], [{ key: 'a', text: 'b' }],
    Array.from({ length: 65 }, () => ({ text: 'a' }))]) assert.throws(() => parseKeyOps(v), bad(400));
  assert.throws(() => parseKeyOps([{ text: 'x'.repeat(10_001) }]), bad(413));
  assert.equal(parseKeyOps(Array.from({ length: 64 }, () => ({ text: 'a' }))).length, 1);
  assert.throws(() => parseKeyOps([{ key: 'hunter22' }]), (e: HttpError) => !/hunter/.test(e.message), 'what it held is in no error');
  assert.equal(typable('a\r\nb\rc\bd\u0000\te'), 'a\nb\ncd\te');
  assert.deepEqual([modFlags(['cmd']), modFlags(['shift', 'cmd']), modFlags(['alt']), modFlags(['ctrl'])], [16, 18, 8, 4]);
  assert.ok(isSelectAll({ key: 'a', mods: ['cmd'], n: 1 }) && !isSelectAll({ text: 'a' }) && !isSelectAll({ key: 'a', mods: ['cmd', 'shift'], n: 1 }));
  ok('ops: text put together, the page\'s names, Home/End the line\'s, bounds, nothing typed in an error');
}

// ---- the clipboard's pure parts ----
{
  assert.deepEqual(parseClipboard({ action: 'paste', text: 'a\r\nb' }), { action: 'paste', text: 'a\nb' });
  assert.deepEqual(parseClipboard({ action: 'paste' }), { action: 'paste', text: null });
  assert.deepEqual(parseClipboard({ action: 'copy', text: 'ignored' }), { action: 'copy', text: null });
  assert.throws(() => parseClipboard({ action: 'steal' }), bad(400));
  assert.throws(() => parseClipboard({ action: 'paste', text: 'x'.repeat(MAX_PASTE_TEXT + 1) }), bad(413));
  assert.deepEqual(cutText('hello world', 'hello'), { text: ' world', exact: true });
  assert.deepEqual(cutText('hello', ''), { text: 'hello', exact: true });
  assert.equal(cutText('aXaY', 'aa')?.text, undefined, 'two pieces gone: not a cut');
  assert.deepEqual(cutText('abab', 'ab'), { text: 'ab', exact: true });
  assert.equal(cutText('aba', 'a')!.exact, false, 'ab or ba: said so');
  assert.equal(cutText('same', 'same'), null);
  assert.equal(pieces('x'.repeat(900)).length, 3);
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  assert.deepEqual(pieces(`aa${family}`, 4), ['aa', family], 'never through an emoji');
  ok('clipboard: the request, what a cut took, long texts in pieces');
}

// ---- the routes on the mock ----
{
  const backend = new MockBackend(2);
  const server = createServer(backend, 't'.repeat(40), undefined, { watchMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const udid = (await backend.list())[0]!.udid;
  const post = async (route: string, body: unknown, prefix = '/phones') => {
    const r = await fetch(`${base}${prefix}/${udid}/${route}`, { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(40)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: (await r.json()) as any };
  };
  const key = (k: string, mods: string[] = [], n = 1) => ({ key: k, mods, n });
  try {
    backend.setField(udid, 'plain');
    const r = await post('keyboard', { owner: true, ops: [{ text: 'hello wrold' }, key('left', ['shift'], 5), { text: 'world' }, key('home'), { text: '> ' }, key('end'), key('backspace', ['alt']), { text: 'phone' }] });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.ok, r.body.via], [true, 'mock']);
    assert.ok(!JSON.stringify(r.body).includes('phone'), 'the answer holds nothing typed');
    assert.equal(backend.held(udid).text, '> hello phone');
    const own = await (await fetch(`${base}/phones/${udid}/owner`, { headers: { authorization: `Bearer ${'t'.repeat(40)}` } })).json() as any;
    assert.equal(own.active, true, "it's the owner's touch");

    // many calls at once keep their order
    backend.setField(udid, 'plain');
    await Promise.all('abcdefghij'.split('').map((c) => post('keyboard', { owner: true, ops: [{ text: c }] }, '/api/devices')));
    assert.equal([...backend.held(udid).text].sort().join(''), 'abcdefghij');

    // copy: the whole field, exact right after Ctrl+A
    backend.setField(udid, 'plain', 'some text');
    let c = await post('clipboard', { owner: true, action: 'copy' });
    assert.deepEqual([c.body.action, c.body.how, c.body.text, c.body.exact], ['copy', 'field', 'some text', false]);
    assert.ok(c.body.why);
    assert.equal(c.headers.get('cache-control'), 'no-store');
    await post('keyboard', { owner: true, ops: [key('a', ['cmd'])] });
    c = await post('clipboard', { owner: true, action: 'copy' });
    assert.deepEqual([c.body.how, c.body.text, c.body.exact, c.body.why], ['field', 'some text', true, undefined]);
    assert.equal(backend.held(udid).board, 'some text', 'and on the phone');
    c = await post('clipboard', { owner: true, action: 'copy' });
    assert.equal(c.body.exact, true, 'still all selected');
    await post('keyboard', { owner: true, ops: [key('right')] });
    assert.equal((await post('clipboard', { owner: true, action: 'copy' })).body.exact, false);

    // cut: just what was selected
    await post('keyboard', { owner: true, ops: [key('left', ['shift', 'alt'])] });
    c = await post('clipboard', { owner: true, action: 'cut' });
    assert.deepEqual([c.body.how, c.body.text, c.body.exact], ['field', 'text', true]);
    assert.equal(backend.held(udid).text, 'some ');
    c = await post('clipboard', { owner: true, action: 'cut' });
    assert.deepEqual([c.body.how, c.body.text], ['phone-only', undefined], 'nothing selected');

    // paste: the PC's text is typed; with none, the phone's own clipboard
    c = await post('clipboard', { owner: true, action: 'paste', text: 'more\r\nlines' });
    assert.deepEqual([c.body.how, c.body.text], ['typed', undefined]);
    assert.equal(backend.held(udid).text, 'some more\nlines');
    assert.equal((await post('clipboard', { owner: true, action: 'paste' })).body.how, 'phone');
    assert.equal(backend.held(udid).text, 'some more\nlinestext');
    // undo, redo
    await post('keyboard', { owner: true, ops: [key('z', ['cmd'])] });
    assert.equal(backend.held(udid).text, 'some more\nlines');
    await post('keyboard', { owner: true, ops: [key('z', ['cmd', 'shift'])] });
    assert.equal(backend.held(udid).text, 'some more\nlinestext');

    // a password field: never read, paste works
    backend.setField(udid, 'secure', 'hunter22');
    for (const action of ['copy', 'cut']) {
      await post('keyboard', { owner: true, ops: [key('a', ['cmd'])] });
      c = await post('clipboard', { owner: true, action });
      assert.deepEqual([c.body.how, c.body.text], ['phone-only', undefined]);
      assert.ok(!JSON.stringify(c.body).includes('hunter'));
    }
    await post('keyboard', { owner: true, ops: [key('right')] });
    assert.equal((await post('clipboard', { owner: true, action: 'paste', text: '-sesame' })).body.how, 'typed');
    assert.equal(backend.held(udid).text, 'hunter22-sesame');
    backend.setField(udid, 'none');
    assert.equal((await post('clipboard', { owner: true, action: 'copy' })).body.how, 'phone-only');

    // refused: Lotus's, bad bodies, an unknown phone
    for (const [route, body] of [['keyboard', { ops: [{ text: 'x' }] }], ['clipboard', { action: 'copy' }], ['keyboard', { owner: true, ops: [] }], ['clipboard', { owner: true, action: 'steal' }]] as const) {
      assert.equal((await post(route, body)).status, 400, route);
    }
    assert.equal((await post('type', { text: 'plain type still works', owner: true })).status, 200);
    const set = await (await fetch(`${base}/api/settings`, { headers: { authorization: `Bearer ${'t'.repeat(40)}` } })).json() as any;
    assert.equal(set.keyboard, true, 'the settings say this server has it');
    assert.equal((await backend.inputMethods(udid)).keys, 'full');

    const said = logs.filter((l) => /\[input/.test(l)).join('\n');
    assert.ok(/ keyboard via mock/.test(said) && / copy via mock/.test(said), 'the input log has that it happened');
    assert.ok(!/hello|world|hunter|sesame|some text|lines/.test(logs.join('\n')), 'and never what was typed or copied');
    assert.ok(!backend.inputLog(udid).filter((l) => /^(keys|key|paste) /.test(l)).some((l) => /hello|hunter|sesame/.test(l)));
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
  ok('routes: in order, the owner\'s only, copy / cut / paste, a password field never read, nothing typed in a log or an answer');
}

// ---- Control: a phone that can't press shortcuts yet; a slow field; errors hold nothing typed ----
{
  const b = {
    mock: true, screen: () => null,
    keyboard: async (_u: string, s: KeyStep[]) => {
      if (s.some((x) => 'key' in x)) throw new HttpError(501, 'not yet');
      throw new Error('boom hunter22');
    },
    field: async () => ({ found: true, secure: false, len: 4, value: 'text' }),
  } as unknown as Backend;
  const c = new Control(b, undefined, { minGapMs: 0, idleProbeMs: Infinity });
  assert.deepEqual((await c.clipboard('U', { owner: true, action: 'copy' })).clip.text, 'text', 'the field can still go to the PC');
  await assert.rejects(c.clipboard('U', { owner: true, action: 'cut' }), bad(501));
  await assert.rejects(c.handle('U', { type: 'keyboard', owner: true, ops: [{ text: 'hunter22' }] }), (e: HttpError) => e.status === 502 && !/hunter/.test(e.message));
  await assert.rejects(c.handle('U', { type: 'keyboard', ops: [{ text: 'x' }] }), bad(400));
  const order: string[] = [];
  const slow = { mock: true, screen: () => null, keyboard: async (_u: string, s: KeyStep[]) => {
    await sleep(5);
    order.push(...s.map((x) => ('text' in x ? x.text : x.key)));
  }, tap: async () => void order.push('tap') } as unknown as Backend;
  const q = new Control(slow, undefined, { minGapMs: 0, idleProbeMs: Infinity });
  const sent = ['a', 'b', 'c'].map((t) => q.handle('U', { type: 'keyboard', owner: true, ops: [{ text: t }] }));
  await Promise.all([...sent, q.handle('U', { type: 'tap', x: 5, y: 5, unit: 'pt' }), q.handle('U', { type: 'keyboard', owner: true, ops: [{ text: 'd' }] })]);
  assert.deepEqual(order, ['a', 'b', 'c', 'tap', 'd'], 'one queue with the other input');
  const none = new Control({ mock: true, screen: () => null } as unknown as Backend, undefined, { minGapMs: 0, idleProbeMs: Infinity });
  await assert.rejects(none.handle('U', { type: 'keyboard', owner: true, ops: [{ text: 'x' }] }), bad(501));
  ok('control: an older build gives the field\'s text, cut is refused there; errors hold nothing typed');
}

// ---- WDA: each key once; our old build; our new one, and an app in front that doesn't answer ----
{
  const hits: { p: string; body: any }[] = [];
  const w = { made: 0, current: '', fail: false, hang: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const p = req.url ?? '';
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (p === '/status') return json(200, { value: { ready: true }, sessionId: w.current || null });
      if (p === '/session') {
        w.current = `S${++w.made}`;
        return json(200, { sessionId: w.current, value: { sessionId: w.current } });
      }
      const sub = p.replace(/^\/session\/[^/]+/, '');
      if (sub === '') return json(200, { value: { capabilities: {} } });
      if (/^\/(wda\/(keys|performIoHidEvent|element\/0\/keyboardInput)|lotus\/keys)$/.test(sub)) {
        hits.push({ p: sub, body });
        if (w.hang && sub.startsWith('/wda/element')) return; // the app in front never answers
        if (w.fail) return json(500, { value: { error: 'unknown error', message: 'XCTest failed' } });
        return json(200, { value: null });
      }
      if (sub === '/wda/screen') return json(200, { value: { scale: 3 } });
      if (sub === '/window/size') return json(200, { value: { width: 390, height: 844 } });
      if (sub === '/appium/settings') return json(200, { value: null });
      json(404, { value: { error: 'unknown command', message: p } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const fakeSpawn = (() => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcess) as unknown as typeof import('node:child_process').spawn;
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-keys-')));
  const cfg = { wdaBasePort: port, mjpegBasePort: port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  const m = new WdaManager(cfg, (u) => u, fakeSpawn, { input: 300, launch: 1000, probe: 300, restart: 5000, hold: 200 });
  const press = (key: string, mods: ('cmd' | 'shift' | 'alt' | 'ctrl')[] = [], n = 1) => m.pressKey('U1', { key, mods, n });
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');
    assert.equal(m.keysMode('U1'), 'full', 'a stock WDA');
    await press('left', [], 2);
    await press('a', ['cmd']);
    await press('left', ['shift', 'alt'], 2);
    assert.deepEqual(hits, [
      { p: '/wda/performIoHidEvent', body: { page: 7, usage: 0x50, duration: 0.01 } }, { p: '/wda/performIoHidEvent', body: { page: 7, usage: 0x50, duration: 0.01 } },
      { p: '/wda/element/0/keyboardInput', body: { keys: [{ key: 'a', modifierFlags: 16 }] } },
      { p: '/wda/element/0/keyboardInput', body: { keys: [{ key: 'XCUIKeyboardKeyLeftArrow', modifierFlags: 10 }, { key: 'XCUIKeyboardKeyLeftArrow', modifierFlags: 10 }] } },
    ], 'plain keys as HID, shortcuts through keyboardInput');

    // a failure is never pressed a second time (that would be pasted twice)
    hits.length = 0;
    w.fail = true;
    await assert.rejects(press('v', ['cmd']));
    assert.equal(hits.length, 1);
    w.fail = false;

    // our build before v5: text keys only, the rest says it's on its way
    const e = (m as any).entries.get('U1');
    e.forkInfo = { lotus: 4 };
    hits.length = 0;
    assert.equal(m.keysMode('U1'), 'text');
    await press('tab');
    assert.deepEqual(hits, [{ p: '/wda/keys', body: { value: ['\t'], frequency: 30 } }]);
    await assert.rejects(press('left'), bad(501));
    await assert.rejects(press('c', ['cmd']), bad(501));
    assert.equal(hits.length, 1, 'not even asked');

    // v5: plain keys in one request; shortcuts through keyboardInput
    e.forkInfo = { lotus: 5 };
    hits.length = 0;
    await press('down', [], 3);
    await press('x', ['cmd']);
    assert.deepEqual(hits, [{ p: '/lotus/keys', body: { keys: [{ usage: 0x51, n: 3 }] } }, { p: '/wda/element/0/keyboardInput', body: { keys: [{ key: 'x', modifierFlags: 16 }] } }]);
    // the app in front doesn't answer accessibility (TikTok): the way that doesn't ask it
    e.stallUntil = Date.now() + 5000;
    hits.length = 0;
    await press('c', ['cmd']);
    assert.deepEqual(hits, [{ p: '/lotus/keys', body: { keys: [{ key: 'c', modifierFlags: 16, n: 1 }] } }]);
    e.forkInfo = null;
    await assert.rejects(press('c', ['cmd']), (err) => err instanceof LaneBusy, 'a stock WDA has no such way: said at once');
  } finally {
    console.log = origLog;
    m.shutdown();
    server.closeAllConnections();
    server.close();
    process.chdir(prevCwd);
  }
  ok('WDA: plain keys as HID, shortcuts through keyboardInput, sent once; an older build of ours says so; a stalled app is not asked');
}

console.log(`\nall ${passed} keyboard checks passed`);
