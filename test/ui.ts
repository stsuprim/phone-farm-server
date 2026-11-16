// The AI control API: WDA's /source tree flattened to elements and strings (normalized upright coordinates), the
// element finder, apps by name, and the endpoints an agent drives a phone with (ui, tap-element, type, key, launch,
// apps, act) with what every action reports: {ok, ms, changed, app, orientation, verified?, error?}.
process.env.INPUT_LOG = '0';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { KNOWN_APPS, parseInstalled, resolveApp, withKnown } from '../src/apps.js';
import { MockBackend } from '../src/mock.js';
import { createServer } from '../src/server.js';
import { centerOf, findElements, flattenUi, readingOrder, UI_MAX_ELEMENTS } from '../src/ui.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};

/** A node as WDA's /source?format=json gives it. */
const node = (type: string, label: string | null, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type, label, name: label, value: null, rect: { x, y, width: w, height: h }, isEnabled: '1', isVisible: '1', children, ...extra,
});

// a Settings-like screen, 390 x 844 points
const tree = node('Application', 'Settings', 0, 0, 390, 844, {}, [
  node('Window', null, 0, 0, 390, 844, {}, [
    node('Other', null, 0, 0, 390, 844, {}, [
      node('NavigationBar', 'Settings', 0, 47, 390, 96, {}, [node('StaticText', 'Settings', 16, 91, 120, 41)]),
      node('SearchField', 'Search', 16, 150, 358, 36, { value: 'wifi' }),
      node('Table', null, 0, 190, 390, 600, {}, [
        node('Cell', 'Wi-Fi', 0, 200, 390, 44, {}, [
          node('StaticText', 'Wi-Fi', 60, 211, 50, 21),
          node('StaticText', 'HomeNet', 280, 211, 70, 21),
        ]),
        node('Cell', 'Bluetooth', 0, 244, 390, 44, {}, [node('StaticText', 'Bluetooth', 60, 255, 80, 21), node('StaticText', 'On', 320, 255, 30, 21)]),
        node('Cell', 'Airplane Mode', 0, 288, 390, 44, {}, [
          node('StaticText', 'Airplane Mode', 60, 299, 120, 21),
          node('Switch', 'Airplane Mode', 320, 294, 51, 31, { value: '0' }),
        ]),
        node('Cell', 'General', 0, 900, 390, 44, { isVisible: '0' }), // scrolled off: not visible
        node('Button', 'Sign in', 16, 400, 100, 40, { isEnabled: '0' }),
        node('Button', 'OK', 60, 500, 80, 40),
        node('Button', 'OK', 250, 500, 80, 40),
        node('Other', null, 0, 600, 390, 100), // a nameless container: not listed
        node('Image', null, 16, 620, 40, 40, { name: 'chevron.right' }),
      ]),
    ]),
  ]),
]);

// ---- flattening ----
{
  const ui = flattenUi(tree, { width: 390, height: 844 });
  const by = (label: string, type?: string) => ui.elements.find((e) => e.label === label && (!type || e.type === type))!;
  assert.ok(!ui.elements.some((e) => e.type === 'Application' || e.type === 'Window'), 'the app and its window are not listed');
  assert.ok(!ui.elements.some((e) => e.type === 'Other'), 'nameless containers are not listed');
  assert.ok(!ui.elements.some((e) => e.label === 'General'), 'invisible elements are not listed');
  const wifi = by('Wi-Fi', 'Cell');
  assert.deepEqual([wifi.x, wifi.y, wifi.w, wifi.h], [0, 0.237, 1, 0.0521], 'normalized to the upright screen');
  assert.deepEqual(Object.keys(wifi), ['id', 'type', 'label', 'name', 'value', 'x', 'y', 'w', 'h', 'enabled', 'visible', 'hittable']);
  assert.equal(wifi.id, '0.0.0.2.0', "the node's place in the tree");
  assert.deepEqual([wifi.enabled, wifi.visible, wifi.hittable], [true, true, true]);
  const sign = by('Sign in');
  assert.deepEqual([sign.enabled, sign.hittable], [false, false], 'a disabled button is not hittable');
  assert.equal(by('Search').value, 'wifi');
  assert.equal(ui.elements.find((e) => e.name === 'chevron.right')!.label, null);
  assert.ok(ui.total > ui.elements.length);
  assert.equal(ui.truncated, false);
  // every visible string once, top to bottom then left to right
  assert.deepEqual(ui.lines, ['Settings', 'Search', 'wifi', 'Wi-Fi', 'HomeNet', 'Bluetooth', 'On', 'Airplane Mode', '0', 'Sign in', 'OK', 'OK']);
  assert.equal(ui.text, ui.lines.join('\n'));
  assert.match(ui.hash, /^[0-9a-f]{16}$/);
  assert.equal(flattenUi(tree, { width: 390, height: 844 }).hash, ui.hash, 'the same screen: the same hash');
  const other = JSON.parse(JSON.stringify(tree));
  other.children[0].children[0].children[1].value = 'wif';
  assert.notEqual(flattenUi(other, { width: 390, height: 844 }).hash, ui.hash, 'a changed screen: another hash');

  // everything, containers and invisible ones too
  const all = flattenUi(tree, { width: 390, height: 844 }, { all: true });
  assert.equal(all.elements.length, all.total);
  assert.equal(all.elements[0]!.id, '0');
  assert.equal(all.elements.find((e) => e.label === 'General')!.visible, false);

  // capped
  const small = flattenUi(tree, { width: 390, height: 844 }, { max: 5, maxText: 100 });
  assert.equal(small.elements.length, 5);
  assert.equal(small.truncated, true);
  assert.equal(UI_MAX_ELEMENTS, 400);

  // a landscape screen: the same normalized space, of the wide picture; without a screen the root's own size
  const wide = node('Application', 'Game', 0, 0, 844, 390, {}, [node('Button', 'Play', 422, 195, 100, 40)]);
  const g = flattenUi(wide, { width: 844, height: 390 }).elements[0]!;
  assert.deepEqual([g.x, g.y], [0.5, 0.5]);
  assert.deepEqual(flattenUi(wide, null).elements[0]!.x, 0.5);
  // odd input never throws
  assert.deepEqual(flattenUi(null, null).elements, []);
  assert.deepEqual(flattenUi({ type: 'XCUIElementTypeButton', label: 'A', frame: '{{10, 20}, {30, 40}}' }, { width: 100, height: 100 }).elements[0], {
    id: '0', type: 'Button', label: 'A', name: null, value: null, x: 0.1, y: 0.2, w: 0.3, h: 0.4, enabled: true, visible: true, hittable: true,
  });
  ok('flattenUi: elements in normalized upright coordinates, text in reading order, capped, hashed');
}

// ---- reading order ----
{
  const at = (label: string, x: number, y: number) => ({ label, x, y, w: 0.1, h: 0.03 });
  const order = readingOrder([at('d', 0.1, 0.5), at('b', 0.6, 0.102), at('a', 0.1, 0.1), at('c', 0.3, 0.3)]).map((e) => e.label);
  assert.deepEqual(order, ['a', 'b', 'c', 'd'], 'a row is read left to right even when its right end sits a hair higher');
  ok('readingOrder: rows top to bottom, each left to right');
}

// ---- the element finder ----
{
  const els = flattenUi(tree, { width: 390, height: 844 }).elements;
  const one = (q: Parameters<typeof findElements>[1]) => findElements(els, q)[0];
  assert.equal(one({ id: '0.0.0.2.0' })!.label, 'Wi-Fi');
  assert.equal(one({ label: 'bluetooth' })!.type, 'Cell', 'any case; the control (the cell) rather than the text inside it');
  assert.equal(findElements(els, { label: 'Bluetooth' }).length, 1, 'a cell and its own label are one thing');
  assert.equal(one({ text: 'homenet' })!.type, 'StaticText');
  assert.equal(one({ text: 'Airplane' })!.label, 'Airplane Mode', 'starts with, when nothing is equal');
  assert.equal(one({ text: 'plane mo' })!.label, 'Airplane Mode', 'contains, when nothing starts with it');
  assert.equal(one({ text: 'wifi' })!.type, 'SearchField', "a field's value counts as its text");
  assert.equal(one({ name: 'chevron.right' })!.type, 'Image');
  assert.equal(one({ text: 'Airplane Mode', type: 'Switch' })!.type, 'Switch');
  // several: reading order, picked by index
  const oks = findElements(els, { label: 'OK' });
  assert.deepEqual(oks.map((e) => e.x), [0.1538, 0.641]);
  assert.equal(findElements(els, { label: 'OK', index: 1 }).length, 2, 'index picks among them (the caller does)');
  assert.deepEqual(findElements(els, { text: 'Nope' }), []);
  assert.deepEqual(findElements(els, {}), []);
  // a disabled one is found when it's the only one (the caller sees enabled: false)
  assert.equal(one({ label: 'Sign in' })!.enabled, false);
  assert.deepEqual(centerOf(one({ label: 'OK' })!), [0.1538 + 0.2051 / 2, 0.5924 + 0.0474 / 2]);
  ok('findElements: by id, label, name or text (equal, starts with, contains), hittable first, reading order, index');
}

// ---- apps by name ----
{
  const csv = 'CFBundleIdentifier, CFBundleVersion, CFBundleDisplayName\ncom.apple.Maps, "3141.1", "Maps"\ncom.zhiliaoapp.musically, "37.1.0", "TikTok"\nTotal: 2 apps';
  assert.deepEqual(parseInstalled(csv), [
    { bundleId: 'com.apple.Maps', name: 'Maps', installed: true },
    { bundleId: 'com.zhiliaoapp.musically', name: 'TikTok', installed: true },
  ]);
  assert.deepEqual(parseInstalled('com.burbn.instagram - Instagram 300.0\n'), [{ bundleId: 'com.burbn.instagram', name: 'Instagram', installed: true }]);
  assert.deepEqual(parseInstalled('ERROR: could not connect'), []);
  const apps = withKnown(parseInstalled(csv));
  assert.equal(apps.find((a) => a.bundleId === 'com.apple.Maps')!.installed, true);
  assert.equal(apps.find((a) => a.name === 'Settings')!.installed, null, 'a well-known app the list does not hold: unconfirmed');
  assert.equal(resolveApp(apps, 'tiktok'), 'com.zhiliaoapp.musically');
  assert.equal(resolveApp(apps, 'Settings'), KNOWN_APPS.Settings);
  assert.equal(resolveApp(apps, 'set'), 'com.apple.Preferences', 'starts with');
  assert.equal(resolveApp(apps, 'com.apple.Maps'), 'com.apple.Maps');
  assert.equal(resolveApp(apps, 'com.example.unlisted'), 'com.example.unlisted', 'a bundle id the list does not hold goes as it is');
  assert.throws(() => resolveApp(apps, 'No Such App'), /no app named "No Such App"/);
  ok('apps: ideviceinstaller lists (both forms), well-known apps, names -> bundle ids');
}

// ---- the endpoints, against the mock phone (a home screen with four icons; an app has Back, a field and a switch) ----
{
  const token = crypto.randomBytes(16).toString('hex');
  const backend = new MockBackend(2);
  const server = createServer(backend, token, undefined, { exactTouch: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const get = (p: string) => fetch(base + p, { headers: auth });
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const udid = (await (await get('/phones')).json())[0].udid as string;
  const dev = `/api/devices/${udid}`;
  const ph = `/phones/${udid}`;
  try {
    // GET /ui
    const ui: any = await (await get(`${dev}/ui`)).json();
    assert.deepEqual([ui.ok, ui.udid, ui.orientation, ui.app], [true, udid, 'portrait', 'com.apple.springboard']);
    assert.deepEqual([ui.point_width, ui.point_height, ui.width, ui.height], [390, 844, 1170, 2532]);
    assert.deepEqual(ui.lines, ['Mock iPhone 1', 'Safari', 'Settings', 'Camera', 'Photos']);
    assert.equal(ui.text, 'Mock iPhone 1\nSafari\nSettings\nCamera\nPhotos');
    assert.equal(ui.count, ui.elements.length);
    const settings = ui.elements.find((e: any) => e.label === 'Settings');
    assert.deepEqual(Object.keys(settings), ['id', 'type', 'label', 'name', 'value', 'x', 'y', 'w', 'h', 'enabled', 'visible', 'hittable']);
    assert.ok(settings.x > 0.25 && settings.x < 0.3 && settings.hittable);
    assert.ok(!ui.elements.some((e: any) => e.label === 'Hidden'));
    assert.equal(ui.cached, false);
    assert.equal((await (await get(`${ph}/ui`)).json()).cached, true, 'asked again within 300 ms: the same answer');
    assert.equal((await (await get(`${ph}/ui?fresh=1`)).json()).cached, false);
    assert.ok((await (await get(`${ph}/ui?all=1`)).json()).elements.some((e: any) => e.label === 'Hidden'));
    assert.equal((await (await get(`${ph}/ui?max=2`)).json()).truncated, true);
    assert.equal((await get('/phones/nope/ui')).status, 404);
    assert.equal((await post(`${ph}/ui`, {})).status, 405);
    ok('GET /ui: elements, text, orientation and app; cached ~300 ms; ?all, ?max, ?fresh');

    // POST /tap-element: by text, with a verify
    const tap: any = await (await post(`${dev}/tap-element`, { text: 'settings', verify: { app: 'Settings', timeoutMs: 2000 } })).json();
    assert.deepEqual([tap.ok, tap.changed, tap.app, tap.orientation, tap.verified, tap.via], [true, true, 'com.apple.Preferences', 'portrait', true, 'mock']);
    assert.equal(typeof tap.ms, 'number');
    assert.deepEqual([tap.element.label, tap.matches], ['Settings', 1]);
    assert.equal(backend.inputLog(udid).pop(), 'tap 146,155', "the element's middle, in points");
    // by id (from GET /ui), by label; an element that isn't there
    const inApp: any = await (await get(`${ph}/ui?fresh=1`)).json();
    assert.deepEqual(inApp.lines, ['Mock iPhone 1', 'Settings', 'Back', 'Search', 'Wi-Fi', '1']);
    const back = inApp.elements.find((e: any) => e.label === 'Back');
    const byId: any = await (await post(`${ph}/tap-element`, { id: back.id })).json();
    assert.deepEqual([byId.ok, byId.changed, byId.app], [true, true, 'com.apple.springboard']);
    const miss = await post(`${ph}/tap-element`, { label: 'Buy now' });
    assert.equal(miss.status, 404);
    const missBody: any = await miss.json();
    assert.equal(missBody.ok, false);
    assert.match(missBody.error, /no element matches label "Buy now"; the screen says: Mock iPhone 1 \| Safari/);
    assert.equal((await post(`${ph}/tap-element`, {})).status, 400);
    assert.match((await (await post(`${ph}/tap-element`, { text: 'Safari', index: 3 })).json()).error, /only 1 element/);
    // it waits for an element that isn't there yet
    setTimeout(() => void backend.launch(udid, 'com.apple.Preferences'), 250);
    const waited: any = await (await post(`${ph}/tap-element`, { label: 'Back', timeoutMs: 3000 })).json();
    assert.deepEqual([waited.ok, waited.app], [true, 'com.apple.springboard']);
    ok('POST /tap-element: by text, id or label, waits for it (timeoutMs), verify; 404 says what the screen does say');

    // POST /launch by name, GET /apps
    const apps: any = await (await get(`${dev}/apps`)).json();
    assert.ok(apps.ok && apps.apps.some((a: any) => a.name === 'Safari' && a.bundleId === 'com.apple.mobilesafari' && a.installed === true));
    const launch: any = await (await post(`${dev}/launch`, { name: 'safari' })).json();
    assert.deepEqual([launch.ok, launch.changed, launch.app], [true, true, 'com.apple.mobilesafari']);
    assert.equal((await (await post(`${ph}/launch`, { bundleId: 'com.apple.camera' })).json()).app, 'com.apple.camera');
    assert.equal((await post(`${ph}/launch`, { name: 'No Such App' })).status, 404);
    assert.equal((await post(`${ph}/launch`, {})).status, 400);
    ok('GET /apps, POST /launch {bundleId | name}');

    // POST /type {text, enter}, POST /key
    const typed: any = await (await post(`${dev}/type`, { text: 'hello', enter: true, verify: { text: 'hello' } })).json();
    assert.deepEqual([typed.ok, typed.changed, typed.verified], [true, true, true]);
    assert.equal(backend.inputLog(udid).pop(), 'type "hello\\n"');
    const del: any = await (await post(`${dev}/key`, { key: 'delete' })).json();
    assert.deepEqual([del.ok, del.changed], [true, true]);
    for (const key of ['enter', 'volumeUp', 'volumeDown']) assert.equal((await (await post(`${ph}/key`, { key })).json()).ok, true, key);
    assert.deepEqual(backend.inputLog(udid).slice(-4), ['type "\\b"', 'type "\\n"', 'button volumeUp', 'button volumeDown']);
    const home: any = await (await post(`${ph}/key`, { key: 'home' })).json();
    assert.deepEqual([home.ok, home.app], [true, 'com.apple.springboard']);
    const lock: any = await (await post(`${ph}/key`, { key: 'lock' })).json();
    assert.equal(lock.ok, true);
    assert.equal(await backend.isLocked(udid), true);
    assert.equal((await (await get('/phones')).json())[0].locked, true);
    assert.equal((await post(`${ph}/key`, { key: 'escape' })).status, 400);
    // the next action wakes it by itself
    const woke: any = await (await post(`${ph}/tap`, { x: 0.5, y: 0.9 })).json();
    assert.deepEqual([woke.ok, woke.changed], [true, true]);
    assert.equal(await backend.isLocked(udid), false);
    ok('POST /type {text, enter}, POST /key (home, lock, volumeUp, volumeDown, enter, delete); a locked phone wakes for the next action');

    // every action reports; a tap that changes nothing says so; verify that doesn't come; fast skips the look
    const nothing: any = await (await post(`${ph}/tap`, { x: 0.5, y: 0.95 })).json();
    assert.deepEqual([nothing.ok, nothing.changed, nothing.app, nothing.orientation], [true, false, 'com.apple.springboard', 'portrait']);
    assert.ok(nothing.total_ms >= nothing.ms);
    const unverified: any = await (await post(`${ph}/tap`, { x: 0.5, y: 0.95, verify: { text: 'Welcome', timeoutMs: 400 } })).json();
    assert.deepEqual([unverified.ok, unverified.verified], [true, false]);
    assert.match(unverified.error, /verify: no "Welcome" on screen \(waited 400 ms\)/);
    const gone: any = await (await post(`${ph}/tap`, { x: 0.5, y: 0.95, verify: { text: 'Welcome', gone: true } })).json();
    assert.equal(gone.verified, true);
    const fast: any = await (await post(`${ph}/tap`, { x: 0.5, y: 0.95, fast: true })).json();
    assert.deepEqual(Object.keys(fast).sort(), ['ms', 'ok', 'via']);
    ok('every action answers {ok, ms, changed, app, orientation, verified?, error?}; fast: true answers {ok, via, ms}');

    // POST /act: a batch, checked at the end
    const act: any = await (
      await post(`${dev}/act`, {
        steps: [
          { type: 'launch', name: 'Settings' },
          { type: 'wait', text: 'Wi-Fi', timeoutMs: 2000 },
          { type: 'tap-element', label: 'Search' },
          { type: 'type', text: 'vpn' },
          { type: 'wait', ms: 50 },
          { type: 'swipe', x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.3, ms: 120 },
          { type: 'key', key: 'home' },
        ],
        verify: { app: 'com.apple.springboard', timeoutMs: 1000 },
      })
    ).json();
    assert.deepEqual([act.ok, act.verified, act.app, act.done, act.steps.length, act.failedAt], [true, true, 'com.apple.springboard', 7, 7, undefined]);
    assert.deepEqual(act.steps.map((s: any) => [s.i, s.type, s.ok]), [
      [0, 'launch', true], [1, 'wait', true], [2, 'tap-element', true], [3, 'type', true], [4, 'wait', true], [5, 'swipe', true], [6, 'key', true],
    ]);
    assert.equal(act.steps[0].changed, true);
    assert.equal(act.steps[2].label, 'Search');
    assert.equal(typeof act.ms, 'number');
    // it stops at the step that fails, and says which
    const bad: any = await (await post(`${ph}/act`, { steps: [{ type: 'key', key: 'home' }, { type: 'tap', text: 'Nowhere' }, { type: 'launch', name: 'Safari' }] })).json();
    assert.deepEqual([bad.ok, bad.failedAt, bad.done, bad.steps.length, bad.app], [false, 1, 1, 2, 'com.apple.springboard']);
    assert.match(bad.error, /step 1 \(tap\): no element matches text "Nowhere"/);
    const on: any = await (await post(`${ph}/act`, { continueOnError: true, steps: [{ type: 'fly' }, { type: 'launch', name: 'Safari' }] })).json();
    assert.deepEqual([on.ok, on.failedAt, on.done, on.app], [false, 0, 1, 'com.apple.mobilesafari']);
    const unv: any = await (await post(`${ph}/act`, { steps: [{ type: 'key', key: 'home' }], verify: { app: 'Camera', timeoutMs: 300 } })).json();
    assert.deepEqual([unv.ok, unv.verified, unv.done], [false, false, 1]);
    assert.equal((await post(`${ph}/act`, { steps: [] })).status, 400);
    assert.equal((await post(`${ph}/act`, { steps: ['tap'] })).status, 400);
    ok('POST /act: a batch of taps, swipes, types, keys, launches and waits; stops at a failure; verify at the end');

    // the same over the control socket: report: true (or a verify) puts the report in the ack; tap-element too
    const ws = new WebSocket(`${base.replace('http', 'ws')}${ph}/control?token=${token}`);
    const acks: any[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'ack') acks.push(m);
    });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ id: 1, type: 'tap', x: 0.5, y: 0.95 }));
    ws.send(JSON.stringify({ id: 2, type: 'launch', name: 'Photos', report: true }));
    ws.send(JSON.stringify({ id: 3, type: 'tap-element', label: 'Back', verify: { app: 'com.apple.springboard' } }));
    ws.send(JSON.stringify({ id: 4, type: 'key', key: 'volumeUp' }));
    for (let i = 0; i < 300 && acks.length < 4; i++) await new Promise((r) => setTimeout(r, 20));
    ws.close();
    const a = (id: number) => acks.find((x) => x.id === id);
    assert.deepEqual(Object.keys(a(1)).sort(), ['id', 'ms', 'ok', 'type', 'via'], 'a plain action: the quick ack, as before');
    assert.deepEqual([a(2).ok, a(2).changed, a(2).app], [true, true, 'com.apple.mobileslideshow']);
    assert.deepEqual([a(3).ok, a(3).verified, a(3).app, a(3).element.label], [true, true, 'com.apple.springboard', 'Back']);
    assert.equal(a(4).ok, true);
    assert.deepEqual(acks.map((x) => x.id), [1, 2, 3, 4], 'sent back to back, done in the order sent');
    ok('control socket: plain acks stay quick; report: true, verify and tap-element answer with the report, in order');
  } finally {
    server.closeAllConnections();
    server.close();
    await backend.close();
  }
}

console.log(`\nall ${passed} UI checks passed`);
