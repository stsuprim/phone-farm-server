// Typing into the focused field (2026-11-18, the phones typing contract): the request, the read-back `check`, secure
// fields never giving their text, emptying a field in one go (never a Delete per letter), and text sent to WDA once only.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Agent } from '../src/agent.js';
import { Control } from '../src/control.js';
import { FieldState, fieldFrom, fieldValueOut, nextClearStep, parseTypeRequest, safeField, scrubTyped, typeCheck, visualLength } from '../src/field.js';
import { Backend, HttpError } from '../src/types.js';
import { WdaManager } from '../src/wda.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
};
const field = (len: number | null, extra: Partial<FieldState> = {}): FieldState => ({ found: true, secure: false, len, ...extra });

// ---- the request ----
{
  assert.deepEqual(parseTypeRequest({ type: 'type', text: 'hi' }), { text: 'hi', enter: false, clear: false });
  assert.deepEqual(parseTypeRequest({ type: 'type', text: 'hi', enter: true, clear: true }), { text: 'hi', enter: true, clear: true });
  assert.deepEqual(parseTypeRequest({ type: 'type', text: '', clear: true }), { text: '', enter: false, clear: true }, 'clear only');
  assert.deepEqual(parseTypeRequest({ type: 'type', clear: true }), { text: '', enter: false, clear: true }, 'clear only, no text');
  assert.deepEqual(parseTypeRequest({ type: 'clear' }), { text: '', enter: false, clear: true }, '{type: "clear"}');
  assert.deepEqual(parseTypeRequest({ type: 'type', text: '', enter: true }), { text: '', enter: true, clear: false }, 'Return only');
  assert.throws(() => parseTypeRequest({ type: 'type', text: '' }), (e: HttpError) => e.status === 400);
  assert.throws(() => parseTypeRequest({ type: 'type' }), (e: HttpError) => e.status === 400);
  assert.throws(() => parseTypeRequest({ type: 'type', text: 5 }), (e: HttpError) => e.status === 400);
  assert.throws(() => parseTypeRequest({ type: 'type', text: 'x'.repeat(20_001) }), (e: HttpError) => e.status === 400);
  assert.equal(parseTypeRequest({ type: 'type', text: 'x', clear: 'yes' }).clear, false, 'only a real true clears');
  ok('type request: {text, enter?, clear?}, clear-only, {type: "clear"}, bad bodies refused');
}

// ---- the check ----
{
  // a cleared (or empty) field: exact
  assert.deepEqual(typeCheck('hello', field(0, { value: '' }), field(5, { value: 'hello' })), { match: true, expected_len: 5, value_len: 5, secure: false });
  assert.equal(typeCheck('hello', field(0, { value: '' }), field(5, { value: 'Hello' })).match, false, 'changed by autocorrect: not a match');
  // the stray letters: "aaa" before a password in a secure field
  assert.deepEqual(typeCheck('abc12345', field(0, { secure: true }), field(10, { secure: true })), { match: false, expected_len: 8, value_len: 10, secure: true });
  assert.equal(typeCheck('abc12345', field(0, { secure: true }), field(8, { secure: true })).match, true);
  // text already there: typed at the caret, the length grows by exactly the text
  assert.equal(typeCheck('lo', field(3, { value: 'hel' }), field(5, { value: 'hello' })).match, true);
  assert.equal(typeCheck('lo', field(3, { value: 'hel' }), field(6, { value: 'helllo' })).match, false);
  assert.equal(typeCheck('pw', field(4, { secure: true }), field(6, { secure: true })).match, true);
  // unreadable after: null
  assert.deepEqual(typeCheck('hi', field(0), null), { match: null, expected_len: 2, value_len: null, secure: false });
  assert.equal(typeCheck('hi', field(0), { found: false, secure: false, len: null }).match, null);
  // nothing known of before: exact or can't tell
  assert.equal(typeCheck('hi', null, field(2, { value: 'hi' })).match, true);
  assert.equal(typeCheck('hi', null, field(4, { value: 'ohhi' })).match, null);
  // letters as a person counts them
  assert.equal(visualLength('héllo👍🏽'), 6);
  assert.equal(typeCheck('👍🏽', field(0, { value: '' }), field(1, { value: '👍🏽' })).expected_len, 1);
  ok('check: exact on an empty or cleared field, lengths on a secure one, the stray letters caught, null when unreadable');
}

// ---- secure fields never give their text ----
{
  const s = safeField({ found: true, secure: true, len: 8, value: 'hunter22' });
  assert.deepEqual(s, { found: true, secure: true, len: 8 });
  assert.equal(safeField({ found: true, secure: false, len: 4, value: '••••' })!.secure, true, 'only bullets: secure');
  assert.equal(safeField({ found: true, secure: false, len: 4, value: '••••' })!.value, undefined);
  assert.deepEqual(fieldValueOut({ found: true, secure: true, len: 8, value: 'hunter22' }), {});
  assert.deepEqual(fieldValueOut(field(2, { value: 'hi' })), { value: 'hi' });
  assert.equal((fieldValueOut(field(300, { value: 'x'.repeat(300) })) as { value: string }).value.length, 200, 'capped at 200');
  // what the phone answered: our build, and a stock element (a placeholder is no text; a SecureTextField loses its value)
  assert.deepEqual(fieldFrom({ found: true, secure: true, len: 3, value: 'abc' }), { found: true, secure: true, len: 3 });
  assert.deepEqual(fieldFrom({ found: true, type: 'XCUIElementTypeSecureTextField', value: '•••••' }), { found: true, secure: true, len: 5 });
  assert.deepEqual(fieldFrom({ found: true, type: 'XCUIElementTypeTextField', value: 'Email', placeholder: 'Email' }), { found: true, secure: false, len: 0, value: '' });
  assert.deepEqual(fieldFrom({ found: true, type: 'XCUIElementTypeTextField', value: 'a@b.c', method: 'select-all', cleared: false }), { found: true, secure: false, len: 5, value: 'a@b.c', method: 'select-all', cleared: false });
  assert.deepEqual(fieldFrom({ found: false }), { found: false, secure: false, len: null });
  assert.equal(fieldFrom(null), null);
  // XCTest names its record after the first letters: never in an error
  const m = scrubTyped("Failed to synthesize event: Type 'hunter22pass…' could not be completed (hunter22password)", 'hunter22password');
  assert.ok(!/hunter/.test(m), m);
  assert.ok(!/abcd/.test(scrubTyped("Type 'abcd'", 'abcd')));
  ok('secure: no text out (by type or bullets), length only; values capped; placeholders are no text; errors scrubbed');
}

// ---- emptying a field: the order, never a Delete per letter ----
{
  assert.equal(nextClearStep(field(0, { value: '' }), []), null, 'already empty');
  assert.equal(nextClearStep(field(5), []), 'element-clear');
  assert.equal(nextClearStep(null, []), 'element-clear', "can't read it: WDA's clear tries");
  assert.equal(nextClearStep(field(0, { secure: true }), []), 'element-clear', 'a secure field may read empty while it is not');
  assert.equal(nextClearStep(field(0, { value: '' }), ['element-clear']), null, 'the clear worked');
  assert.equal(nextClearStep(field(5), ['element-clear']), 'select-all', 'it resisted: select all and one Delete');
  assert.equal(nextClearStep(field(0, { secure: true }), ['element-clear']), 'select-all', 'secure: select all anyway');
  assert.equal(nextClearStep(field(null), ['element-clear']), 'select-all');
  assert.equal(nextClearStep(field(5), ['element-clear', 'select-all']), null, 'each once');
  assert.equal(nextClearStep({ found: false, secure: false, len: null }, ['element-clear']), null, 'no field to select in');
  ok('clear: element clear, then select all + one Delete when it resisted (or a secure field), each once, never per letter');
}

// ---- Control and /act: clear, type, check, Return after the read-back ----
{
  const calls: string[] = [];
  let value = 'old text';
  let secure = false;
  const read = (): FieldState => (secure ? { found: true, secure: true, len: visualLength(value) } : { found: true, secure: false, len: visualLength(value), value });
  const b = {
    mock: true,
    screen: () => ({ width: 390, height: 844, scale: 3 }),
    type: async (_u: string, text: string) => {
      calls.push(text === '\n' ? 'return' : text === '\b' ? 'delete' : `type ${secure ? '[secret]' : text}`);
      if (text !== '\n') value += text;
      return { via: 'wda' as const };
    },
    field: async (_u: string, o: { clear?: boolean } = {}) => {
      if (o.clear) {
        calls.push('clear');
        const had = value.length > 0;
        value = '';
        return { ...read(), method: had ? 'select-all' : 'empty', cleared: true };
      }
      calls.push('read');
      return read();
    },
  } as unknown as Backend;
  const control = new Control(b, undefined, { minGapMs: 0, idleProbeMs: Infinity });
  const agent = new Agent(b, control);

  const r1: any = await agent.action('U', { type: 'type', text: 'hi@x.com', clear: true, enter: true }, { settleMs: 0 });
  assert.deepEqual(calls, ['clear', 'type hi@x.com', 'read', 'return'], 'cleared in one go, typed, read back, then Return');
  assert.deepEqual([r1.ok, r1.cleared, r1.clear_method, r1.check, r1.value], [true, true, 'select-all', { match: true, expected_len: 8, value_len: 8, secure: false }, 'hi@x.com']);

  calls.length = 0;
  secure = true;
  value = 'aaa';
  const r2: any = await agent.action('U', { type: 'type', text: 'pass' }, { settleMs: 0 });
  assert.deepEqual(calls, ['read', 'type [secret]', 'read']);
  assert.deepEqual(r2.check, { match: true, expected_len: 4, value_len: 7, secure: true }, 'grew by exactly the text');
  assert.equal(r2.value, undefined, 'a secure field: no value');
  assert.ok(!JSON.stringify(r2).includes('pass'), 'the password is nowhere in the answer');

  // /act: {type: "clear"} and a type step carry the same check; never one Delete per letter
  calls.length = 0;
  value = 'something long';
  const batch: any = await agent.batch('U', { steps: [{ type: 'clear', settleMs: 0 }, { type: 'type', text: 'pw', settleMs: 0 }] });
  assert.equal(batch.ok, true);
  assert.deepEqual(calls, ['clear', 'read', 'type [secret]', 'read']);
  assert.deepEqual([batch.steps[0].cleared, batch.steps[0].check], [true, { match: true, expected_len: 0, value_len: 0, secure: true }]);
  assert.deepEqual(batch.steps[1].check, { match: true, expected_len: 2, value_len: 2, secure: true });
  assert.ok(!calls.includes('delete'));

  // a field that couldn't be emptied: the text after it is no match
  const stubborn = { ...b, field: async (_u: string, o: { clear?: boolean } = {}) => (o.clear ? { found: true, secure: true, len: 3, method: 'triple-tap', cleared: false } : { found: true, secure: true, len: 5 }) } as unknown as Backend;
  const r3: any = await new Agent(stubborn, new Control(stubborn, undefined, { minGapMs: 0, idleProbeMs: Infinity })).action('U', { type: 'type', text: 'pw', clear: true }, { settleMs: 0 });
  assert.deepEqual([r3.cleared, r3.check.match], [false, false]);

  // a backend that can't read fields: types as before, no check; clear is refused (never a Delete per letter)
  const old = { ...b, field: undefined } as unknown as Backend;
  const oc = new Control(old, undefined, { minGapMs: 0, idleProbeMs: Infinity });
  const r4: any = await oc.handle('U', { type: 'type', text: 'x' });
  assert.equal(r4.check, undefined);
  await assert.rejects(oc.handle('U', { type: 'clear' }), (e: HttpError) => e.status === 501);
  ok('type/clear through Control and /act: clear in one go, read back before Return, secure stays secret, no per-letter Delete');
}

// ---- WDA: text sent once only; a stock WDA's clear falls back to select all + one Delete ----
{
  type W = { current: string; made: number; hits: string[]; keys: unknown[]; keysFail: 'none' | 'error' | 'session'; value: string; clearWorks: boolean; selected: boolean; port: number };
  const w: W = { current: '', made: 0, hits: [], keys: [], keysFail: 'none', value: 'stuck', clearWorks: false, selected: false, port: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const p = req.url ?? '';
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      w.hits.push(`${req.method} ${p}`);
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (p === '/status') return json(200, { value: { ready: true }, sessionId: w.current || null });
      if (p === '/session') {
        w.current = `S${++w.made}`;
        return json(200, { sessionId: w.current, value: { sessionId: w.current } });
      }
      if (p === '/wda/screen') return json(200, { value: { scale: 3 } });
      const m = /^\/session\/([^/]+)(\/.*)?$/.exec(p);
      if (!m) return json(404, { value: { error: 'unknown command', message: p } });
      if (m[1] !== w.current) return json(404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
      const sub = m[2] ?? '';
      if (sub === '') return json(200, { value: { capabilities: {} } });
      if (sub === '/window/size') return json(200, { value: { width: 390, height: 844 } });
      if (sub === '/orientation') return json(200, { value: 'PORTRAIT' });
      if (sub === '/appium/settings') return json(200, { value: null });
      if (sub === '/wda/keys') {
        w.keys.push(body);
        if (w.keysFail === 'error') return json(500, { value: { error: 'invalid element state', message: "Failed to synthesize event: Type 'hunter22pass…'" } });
        if (w.keysFail === 'session') {
          w.keysFail = 'none';
          return json(404, { value: { error: 'invalid session id', message: 'Session does not exist' } });
        }
        if (body.value?.join('') === '\b' && w.selected) w.value = '';
        return json(200, { value: null });
      }
      if (sub === '/element/active') return json(200, { value: { ELEMENT: 'E1' } });
      if (sub === '/element/E1/attribute/type') return json(200, { value: 'XCUIElementTypeSecureTextField' });
      if (sub === '/element/E1/attribute/value') return json(200, { value: '•'.repeat(w.value.length) });
      if (sub === '/element/E1/attribute/placeholderValue') return json(200, { value: null });
      if (sub === '/element/E1/clear') {
        if (w.clearWorks) w.value = '';
        return json(200, { value: null });
      }
      if (sub === '/wda/element/0/keyboardInput') {
        w.selected = body.keys?.[0]?.key === 'a' && body.keys?.[0]?.modifierFlags === 16;
        return json(200, { value: null });
      }
      json(404, { value: { error: 'unknown command', message: p } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.port = (server.address() as AddressInfo).port;
  const fakeSpawn = (() => {
    const p = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    return p;
  }) as unknown as typeof import('node:child_process').spawn;
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-typing-')));
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  const cfg = { wdaBasePort: w.port, mjpegBasePort: w.port + 1, wdaProject: '/x', wdaDerivedData: '/y' } as unknown as import('../src/config.js').Config;
  const m = new WdaManager(cfg, (u) => u, fakeSpawn, { input: 300, launch: 1000, probe: 300, restart: 5000 });
  try {
    m.start('U1');
    assert.ok(await until(() => m.state('U1') === 'ready'), 'ready');

    // typed at a readable pace through the phone's keyboard, in one request
    await m.typeText('U1', 'hello', 15);
    assert.deepEqual(w.keys, [{ value: ['h', 'e', 'l', 'l', 'o'], frequency: 15 }]);

    // XCTest failed partway: never sent again (that was text typed twice), and the error doesn't hold the text
    w.keys = [];
    w.keysFail = 'error';
    await assert.rejects(m.typeText('U1', 'hunter22password', 15), (e: HttpError) => !/hunter/.test(e.message));
    assert.equal(w.keys.length, 1, 'not retried after a failure');
    await sleep(100);
    assert.ok(!logs.some((l) => /hunter/.test(l)), 'the text is in no log line');
    w.keysFail = 'none';
    await until(() => m.state('U1') === 'ready');

    // a session WDA no longer knows: refused before anything was typed, so asked once more on a new one
    w.keys = [];
    w.keysFail = 'session';
    await m.typeText('U1', 'ok', 15);
    assert.equal(w.keys.length, 2);

    // clear on a stock WDA: element clear first; it resisted (a web view's password field), so Cmd+A and ONE Delete
    w.keys = [];
    w.value = 'stuck';
    const f = await m.field('U1', true);
    assert.deepEqual(f, { found: true, secure: true, len: 0, method: 'select-all', cleared: true });
    assert.deepEqual(w.keys, [{ value: ['\b'] }], 'one Delete, not one per letter');
    assert.ok(w.hits.some((h) => h.endsWith('/element/E1/clear')));

    // the clear worked: a secure field still gets select all + one Delete (its length can't be trusted)
    w.keys = [];
    w.value = 'abc';
    w.clearWorks = true;
    const g = await m.field('U1', true);
    assert.equal(g!.cleared, true);
    assert.ok(w.keys.length <= 1);

    // a read: secure, its length only
    w.value = 'secret';
    assert.deepEqual(await m.field('U1', false), { found: true, secure: true, len: 6 });
  } finally {
    console.log = origLog;
    m.shutdown();
    server.closeAllConnections();
    server.close();
    process.chdir(prevCwd);
  }
  ok('WDA: text in one request at a readable pace, never re-sent after a failure; stock clear falls back to Cmd+A + one Delete');
}

console.log(`\nall ${passed} typing checks passed`);
