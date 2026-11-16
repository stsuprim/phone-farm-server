# Phone Farm Server

Mac-mini-side server for an iPhone farm. Lotus's Windows "Phones" page talks to it over HTTP/WebSocket.
Node 20+/TypeScript, two runtime dependencies (`ws`, MIT; `node-datachannel`, MPL-2.0, for WebRTC). It discovers USB iPhones (libimobiledevice), runs one
WebDriverAgent (WDA) per phone on its own ports, and exposes an authenticated API.

## Try it without a Mac (mock mode)

```
npm install
npm run init-env        # creates .env with a random API_TOKEN (gitignored)
MOCK=true npm run dev:mock    # PowerShell: $env:MOCK="true"; npm run dev:mock
npm test                # smoke test against an in-process mock server
```
Mock mode serves 4 fake phones (the 4th is "unplugged"), generated PNG screenshots/frames; taps and swipes show up
as red rings/yellow lines on the next frame. Coordinates are iPhone points (390x844 logical screen).

## API

All endpoints except `/health` need `Authorization: Bearer <API_TOKEN>` (WebSockets also accept `?token=`).
Errors are JSON `{"ok": false, "error": "..."}` with 400/401/404/405/501/503/502 (routes that aren't about one phone answer `{"error": "..."}`). When WebDriverAgent is at fault the status is 502 and the
message names it: `WDA session for <name> is down: ...` (WDA unreachable, session gone, 5xx; already retried once after
recovering) or `WDA refused the request on <name>: ...` (WDA answered but said no).

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/health` | - | `{ok, mock, commit, startedAt}` (no auth): alive, and which build runs (the commit's first 7 characters, when it started), so a client can tell whether the Mac has pulled a change |
| GET | `/phones` | - | `[{udid, name, model, ios, battery, online, ready, control, scale, point_width, point_height, width, height, orientation}]`: `battery` 0-100 or null; `model` the product type (`iPhone14,5`); `ready` = WDA running; `control` = `"ready"` (session warm), `"recovering"` (WDA starting or session being remade) or `"down"`; `orientation` how the phone is turned now (`portrait`, `landscape-left`, `landscape-right`, `portrait-upside-down`; null until WDA has said; see [Orientation and coordinates](#orientation-and-coordinates)); `scale` from WDA (`/wda/screen`); `point_width`/`point_height` the screen in points **as it's turned now** (390 x 844 upright, 844 x 390 on its side), null until known; `width`/`height` the same in pixels (points x scale); `stats` the live view numbers (see [Live view](#live-view-webrtc-h264-mjpeg)); `lan` the Mac's own base URLs on its LAN (private IPv4 only, `["http://192.168.1.20:8787", ...]`, same for every phone); `tailnet` its Tailscale ones (100.64/10), listed apart because a Tailscale address is not a local path; `info` the detail card's data as it was last gathered (see [Device info](#device-info-the-detail-card)); `focused` true for the one phone in focus (see [One live phone at a time](#one-live-phone-at-a-time)); `stats.heals` / `stats.lastHeal` WDA's self-heals (see [Staying responsive](#staying-responsive-wda-self-heal)) |
| GET | `/phones/:udid/info` | `?fresh=1` (ask the phone now) | `{ok, udid, battery: {level, percent, charging}, temperatureC, app: {bundleId, name}, uptimeSec, model, ios, bootedAt, wda: {expiresAt, daysLeft, state}, thermal, connectedAt, at, fresh}`: the detail card, kept ~15 s; anything unknown is `null`. See [Device info](#device-info-the-detail-card) |
| POST | `/phones/:udid/warm` | `{}` | `{ok, udid, capture: "warm"\|"off"\|"unavailable", reason?, input}`: wakes the phone for a viewer that's about to open it and says whether its capture runs; it starts none (2026-11-16). See [Capture only while a live view is open](#capture-only-while-a-live-view-is-open) |
| GET | `/phones/:udid/screenshot` | `?format=png` (default) or `jpeg` | image bytes, always upright at the screen's true shape (`jpeg` = latest MJPEG frame, or a PNG when that frame isn't the phone's shape; mock always returns PNG, check `Content-Type`). Headers `x-orientation`, `x-width`, `x-height` (the picture's own size) |
| WS | `/phones/:udid/stream` | `?codec=` (`h264` or `mjpeg`; absent = MJPEG as before), `?fps=` (1-60, default 60), `?quality=`, `?scale=` (10-100 %; MJPEG default 50, H.264 default 100) | MJPEG: first a text message `{"type":"hello", udid, contentType, fps, scale, quality, orientation, point_width, point_height, screen_width, screen_height, width, height, connectMs}` with the settings actually used, then `{"type":"orientation", ...}` with the frames' real size (and again whenever the phone turns), then one binary message per frame (JPEG from WDA's MJPEG server in real mode, PNG in mock); latest frame only. H.264: see [Live view](#live-view-webrtc-h264-mjpeg). Every hello says `connectMs` (the request -> the first frame, ms) and a `{"type":"first-frame", udid, transport, connectMs}` follows the first frame: see [Opening a view fast](#opening-a-view-fast) |
| WS | `/phones/:udid/control` | JSON text messages, see below | low-latency control over one connection |
| POST | `/phones/:udid/tap` | `{x, y, unit?, hold?, bounds?, natural?}` (`hold` ms; `bounds` `[x, y, w, h]` of the element aimed at; see [Natural touch](#natural-touch)) | the [action report](#action-reports) `{ok, ms, total_ms, via, reason?, changed, app, orientation, verified?, error?}`: `via` how it reached the phone (`hid`, `wda-fast`, `wda`; see [Input](#input-taps-swipes-typing)), `ms` the server's receive -> injected time. Every action below answers with it; with `"fast": true` in the body (or `?fast=1`) it answers just `{ok:true, via, ms}`, without the look before and after |
| GET | `/phones/:udid/input` | - | input latency on the server: `{udid, via, tap_avg_ms, tap_p90_ms, last, samples, touch: {move_avg_ms, move_p90_ms, coalesced, auto_released, fallbacks, fallback_reason}, methods: {hid, hid_reason, wda_fast}, recent: [{at, type, via, ok, wait_ms, inject_ms, total_ms, reason?, error?}]}` (the last 50 actions; `touch` = live touch: move latency, moves folded into a newer one, touches the server lifted itself, gestures that took a slower route and why) |
| POST | `/phones/:udid/swipe` | `{x1, y1, x2, y2, ms?, hold?, unit?, natural?}` (`ms` max 10000; without it 300, or with natural touch a time that fits the length; `hold` ms makes it a drag: pressed first, rested 150 ms before the lift) | the report; a swipe from a point to itself is a long press |
| POST | `/phones/:udid/path` | `{points: [[x, y, ms], ...], unit?}` (`ms` since the gesture began; 1-5000 points, up to 60 s) | the report: one continuous touch with that timing |
| POST | `/phones/:udid/hold` | `{x, y, ms, unit?}` (`ms` default 1000, max 30000) | the report |
| POST | `/phones/:udid/touch` | `{phase, x, y, t, seq, id, unit?}` | `{ok:true, via, ms, ack: seq, id, phase, ...}`; same as a live `touch` message (fallback when the WebSocket can't open) |
| POST | `/phones/:udid/type` | `{text, enter?}` (`enter: true` presses Return after it) | the report |
| POST | `/phones/:udid/key` | `{key}`: `home`, `lock`, `volumeUp`, `volumeDown`, `enter`, `delete` | the report (`lock` locks the phone: the next action wakes it first) |
| POST | `/phones/:udid/home` | `{}` | the report |
| POST | `/phones/:udid/launch` | `{bundleId}` or `{name}` (as `GET .../apps` lists it: `"Settings"`, `"TikTok"`) | the report; 404 with nearby names when no app has that name |
| GET | `/phones/:udid/ui` | `?all=1` (every node, hidden ones and containers too), `?max=` (elements, default 400), `?fresh=1` (skip the 300 ms cache), `?settle=1` (wait for the picture to stop changing first) | the screen as an agent reads it, see [AI control](#ai-control-read-the-screen-act-verify) |
| GET | `/phones/:udid/apps` | - | `{ok, udid, apps: [{bundleId, name, installed}]}`: installed apps (`ideviceinstaller`, cached 5 min) plus well-known ones (`installed: null` = not confirmed on this phone) |
| GET | `/phones/:udid/orientation` | - | `{ok, udid, orientation, point_width, point_height, screen_width, screen_height, width, height}`, asked from WDA now |
| POST | `/phones/:udid/tap-element` | `{id \| label \| name \| text, index?, timeoutMs?, settle?, verify?}` | finds the element and taps its middle: the report + `element`, `matches`, `moved?`; 404 says what the screen does say; 409 when the screen changed under an `id` or the element is off the screen |
| POST | `/phones/:udid/act` | `{steps: [...], verify?, continueOnError?}` | a batch in order: the report + `steps`, `done`, `failedAt?` |
| POST | `/phones/:udid/recover` | `{}` | drops the WDA session, restarts the runner if `/status` fails, makes a new warm session (in the phone's queue, after any waiting actions): `{ok:true, control}`, or 502 `{error}` naming WDA |
| POST | `/phones/:udid/swipe` | `{points: [[x, y, t], ...], duration, unit?}` (a whole drag in one command; `t` ms, `duration` ms optional) | the report: replayed on the server as ONE smooth gesture (resampled every 8 ms; `duration` stretches the client's timing). The `remote` profile sends drags this way, never per point |
| POST | `/phones/:udid/wake` (also `/api/devices/:udid/wake`) | `{}` | wakes and unlocks (WDA `/wda/unlock`: past the lock screen when there's no passcode): `{ok, udid, locked, screenOn, lastActive, warning?}`; 404 `{"error":"unknown phone"}` |
| POST | `/phones/:udid/lock` (also `/api/devices/:udid/lock`) | `{}` | locks, screen off (WDA `/wda/lock`): same answer |
| GET | `/api/devices` | - | the same list as `/phones` (every `/phones/:udid/...` route also answers under `/api/devices/:udid/...`) |
| GET / PUT | `/api/settings` (also `/settings`) | PUT `{idleLockMinutes?}` (0 = off, default 10) | the settings, kept in `data/settings.json`, plus `naturalTouch: true` (not a setting since 2026-11-16: it only says this server has [natural touch](#natural-touch); a PUT of it is taken without a word and changes nothing) |
| GET | `/api/wda` (also `/wda`) | - | `{signedAt, expiresAt, daysLeft, state: "ok"\|"soon"\|"expired"\|"resigning"\|"failed", lastError?, nextAttemptAt, perDevice: {udid: {signedAt, lastError?}}}` (mock: `{state:"unavailable"}`) |
| POST | `/api/wda/resign` (also `/wda/resign`) | - | 202 + the status (`state:"resigning"`): re-signs WDA for every phone now |
| GET | `/api/status` (also `/status`) | - | `{mock, settings, wda, devices}` (`devices` as `/api/devices`) |
| POST | `/phones/:udid/focus` (also `/api/devices/:udid/focus`) | `{}` | `{ok, udid, focused, previous: {udid, slept, reason?} \| null, capture, reason?, input}`: makes this the one live phone. This one wakes and its capture starts (`capture` as `/warm`); the phone in focus before it stops its capture and locks about 1.5 s later, and only if nobody watches it by then (`previous.reason: "locking"`; an agent action running on it keeps it awake: `slept: false` with why). See [One live phone at a time](#one-live-phone-at-a-time); 404 `{"ok":false,"error":"unknown phone"}`, 503 offline |
| GET | `/update/status` | - | `{current, remote, upToDate, lastCheck, lastError}` (runs `git fetch`, compares local HEAD with `origin/main`) |
| POST | `/update/now` | - | force-updates to GitHub main now: `{started:true}` (built; process exits and launchd restarts it) or `{started:false, reason}` (up to date, GitHub unreachable, build failed and rolled back...). 503 in mock mode |

How taps, swipes and typing reach the phone: see [Input](#input-taps-swipes-typing). Every action for a phone, from HTTP,
the control socket or a data channel, goes through one queue per phone, so they run in the order they arrived and never
overlap (at most 50 waiting, then 503; a touch's `down` and `up` are never refused). **A locked or dark phone is woken
first, inside the queue, and then the action runs**: a tap on a sleeping phone is never lost and nothing overtakes it.
Discrete actions (taps, swipes, typing, keys, a touch's `down`) start at least 40 ms after the one before ended, so a
burst reaches WDA spaced and never in parallel; an action that gets no answer in time is answered 504 and the phone is
healed (see [Staying responsive](#staying-responsive-wda-self-heal)).

### Natural touch

Always on (2026-11-16: no setting; `src/human.ts`): the touches sent as commands (`tap`, `swipe`, `hold`,
`tap-element`, their `/act` steps and the control socket's) move like a finger:

- **Swipes** follow a slight bow (3-8 % of their length to one side, at most 24 pt) with minimum-jerk speed (slow off
  the mark, fastest mid-way, slow into the end), sampled every 8 ms. The two ends are exact. Without `ms` they take a
  time that fits the length (about 200 ms for a flick, 330 ms for 300 pt, 460 ms for 800 pt, +-10 %); a given `ms` is
  kept +-8 %. A drag (`hold`) is pressed in place first, moved the same way and rested before the lift.
- **Taps** land up to 3 pt off the place (most within 1-2 pt), inside the element's `bounds` when given (`tap-element`
  sends them) and the screen, and are held 50-120 ms (HID's `hold_ms`, the fast WDA route's `hold`). A long press
  (`hold`) lands the same way.
- **The owner's own touches** are never reshaped: live touch (`down`/`move`/`up`) goes to the phone as it comes, or,
  buffered, is played on `up` through every point at its own time; a whole swipe (`points`) keeps its points and
  timing; a quick buffered tap keeps its real hold (30-250 ms).
- **`natural: false` on a message** (the owner's own whole tap or hold): exact places, straight lines at even speed,
  the routes' own tap hold.

The randomness is seeded (`createServer(..., { touchSeed })` for tests); `test/human.ts` checks it.

### One live phone at a time

`POST /phones/:udid/focus` (or `/api/devices/:udid/focus`) picks the phone on show; a client calls it when the owner
switches phones, before opening the view.

- **Only it streams.** The phone in focus before it is **locked** about 1.5 s after the
  switch (`FOCUS_LOCK_MS`), in its own queue (never on top of an action), without holding the answer up, and **only
  if nobody watches it by then**: the viewer that switched has let go of it, while another Lotus still on it keeps its
  picture and its screen (2026-11-16: a lock under a viewer left a black picture). An agent action running or waiting
  on that phone keeps it awake: `previous.slept: false`, `reason: "an agent action is running on it"`.
- **The new one is ready.** It wakes (past the lock screen), as `POST /warm`. 2026-11-16: neither starts a capture
  any more, and a switch never stops one: see [Capture only while a live view is open](#capture-only-while-a-live-view-is-open).
- `focused: true` marks it in `GET /phones` / `/api/devices` (all `false` until a client picks one). The focus lives
  in the server's memory: after a restart nobody is in focus until a client says so.
- **FPS:** each phone's `stats.fps` (the live view's frames per second now), each lane's `stats.lanes[].fps` and
  each open view's `stats.sessions[].fps` (frames sent to that viewer in the last second).

### A dark screen (2026-11-16)

A phone without a passcode never says "locked": WDA's `/wda/locked` reads SpringBoard's lock state, which stays 0, so
after a lock (the idle lock, a switch of the live phone) or iOS's own Auto-Lock its screen is off while everything said
it was awake. WDA's `/wda/lock` timed out waiting ("Timed out while waiting until the screen gets locked"),
`/wda/unlock` did nothing ("not locked"), the H.264 capture had no frames to give (so WebRTC failed and the stream fell
back to MJPEG) and every picture was black. Now the screen itself says (`src/dark.ts`):

- **Dark is told from a screenshot.** WDA's PNG, black all over (at most 0.1 % of its pixels brighter than near-black:
  a screen that's on always has a clock). A frame WDA's MJPEG gives within a moment settles a screen that plainly shows
  something without the PNG.
- **`isLocked` means locked or dark**, so the idle lock's own checks work on these phones: before an input after a
  quiet spell, when a viewer opens (every time, also when the phone is thought awake) and with each `rtc-offer`.
- **Waking a dark phone** is what WDA's unlock does, pressed here: Home (the screen comes on), 0.9 s, Home again (past
  the lock screen), twice at most. Home is never pressed on a screen that shows something (it would leave the app in
  front) nor when the screen can't be told.
- **A lock that left the screen dark took**, whatever WDA said, so the list says `locked: true` and the next viewer
  or input wakes it. A phone that's already dark isn't locked again (the lock button would turn its screen on).
- **A watched phone never stays black.** The watch (every 12 s; the screen itself every 4th tick) wakes a phone found
  locked or dark while a viewer is attached, unless it was locked on request (the Lock key, `POST /lock`).

`test/dark.ts` checks the screenshot test, the wake, the idle lock's part and the switch.

### Staying responsive (WDA self-heal)

What used to leave a phone not answering after a while, and what the server does about each:

| Cause | Fix |
|---|---|
| The WDA session expired or was replaced while nobody was looking (`/status` still answers, so the old 10 s check saw nothing) | Every phone that's watched (a control socket or stream open, or in focus) has its **session itself** probed every 12 s (`GET /session/:id`, 3 s at most), in its queue; a dead one is remade |
| XCTest hung under WDA: a request that never answers held the phone's queue for 30 s, then 45 s of recovery | Per-request timeouts (taps, keys, home: 8 s; launch 20 s; a gesture 8 s plus its length; typing by its length); a hung session is recovered, and when no new session can be made either, **WDA is restarted** through the usual restart path. The queue never waits more than 20 s (plus the action's own length) for one action: the caller gets 504 `... got no answer within N s: the phone is being checked and healed; it may still happen, so look at the screen before trying again`, the phone is healed, and the next action waits at most 5 s more for the hung one to settle |
| The WDA port forward (`iproxy`) died (usbmuxd hiccup, the phone re-enumerating after a long sleep) | It's started again by itself; WDA isn't restarted for it |
| WDA itself died, or is waiting out a restart back-off | The probe restarts it now |
| The phone went dark by itself (iOS Auto-Lock) and the "is it locked?" ask timed out (1.5 s) after a long idle: the tap went to a dark phone, and **every tap for the next 25 s** too | The first action after **30 s** without one probes WDA first (and heals it), then asks whether the phone is locked (4 s), wakes it if so, then acts: **one request**. An ask that gets no answer is asked again by the next input. The 12 s watch also asks, so a phone found locked is woken by the next touch without asking |
| The HID helper died or its session broke | (already) the input falls back to WDA at once and the session reopens by itself while someone watches |

Every heal is logged as `[wda-heal] <udid end> <reason>` and counted: each phone's `stats.heals` (since the server
started) and `stats.lastHeal` `{at, reason}` (null when there was none), in `GET /phones` / `/api/devices`.

### A stable control link (2026-11-16)

The owner: "what is the problem with the CONTROL LINK failing and recovering all the time". **The cause:** WDA works
one request at a time, and one liveness check that got no answer in 3 s counted as a dead WDA. The check waited behind
whatever WDA was doing (a screenshot of the dark-screen look, a lock that waits for "locked" on a phone without a
passcode, a card's read, the orientation poll: none of them counted as "busy"), so its session was dropped
("Recovering"), and when `/status` then waited behind the same request for 2.5 s the runner was restarted on the phone
(half a minute). Over and over, with nothing wrong.

- **Busy isn't down.** Every request to WDA counts as busy; a liveness check is skipped while one is on its way, and
  any answer at all (whatever it says) means WDA is there and clears the count.
- **Several missed beats, not one.** WDA counts as down only after `MISSES` (3) liveness checks in a row got no
  answer in time, over at least 15 s. A refused connection (nothing listens) still recovers at once.
- **A recovery fixes only what's wrong.** It asks `/status` three times (2.5 s, then 3.75 s twice) before it restarts
  the runner, and keeps a session that still answers (it was only slow); a session WDA itself says is gone is remade.
- **No "down" for a hiccup.** `control` says `recovering` or `down` only once that lasted 4 s
  (`CONTROL_DEBOUNCE_MS`); a session remade in a moment is never shown. A restarting runner says so at once.
- **The control socket.** The server answers `{type:"ping"}` in the message handler, beside whatever the phone's
  queue is doing. It pings each socket every 10 s and closes one nothing was heard from for 35 s (a link that died
  without a word would otherwise count as someone watching, and keep the capture up). Any number of sockets may be
  open for one phone; none closes another.
- **Measured.** `stats.controlLink` on each phone of `GET /phones`: `{open, opens, closes, drops, lastOpen,
  lastClose: {at, code, reason, why: "client"|"dropped"|"dead", livedMs}, wda: {state, raw, misses, recoveries,
  runnerRestarts, answeredMsAgo, busy}}` (`drops`: closes that weren't the client's own; `wda.state` is what
  `control` says, `wda.raw` what it is underneath).

### Device info (the detail card)

`GET /phones/:udid/info` (also `/api/devices/:udid/info`), and `info` on every phone in `GET /phones` / `/api/devices`:

```json
{"ok":true,"udid":"...","battery":{"level":0.87,"percent":87,"charging":true},"temperatureC":30.2,
 "app":{"bundleId":"com.zhiliaoapp.musically","name":"TikTok"},"uptimeSec":null,"model":"iPhone14,5","ios":"18.1",
 "bootedAt":null,"wda":{"expiresAt":"2026-11-21T03:12:40.000Z","daysLeft":5.4,"state":"ok"},
 "thermal":"nominal","connectedAt":1794000000000,"at":1794000123456,"fresh":true}
```

| Field | What | From |
|---|---|---|
| `battery.level`, `battery.percent` | `level` a fraction 0..1; `percent` the same as a whole number 0..100 (`round(level * 100)`; the list's own `battery` is 0..100 too) | lockdown's battery domain (`ideviceinfo -q com.apple.mobile.battery`: `BatteryCurrentCapacity`), else the IORegistry, else WDA's `/wda/batteryInfo` |
| `battery.charging` | `true` while it's on power and charging (or full on the charger) | `BatteryIsCharging` / `FullyCharged` + `ExternalConnected`, else the IORegistry's `IsCharging`, else WDA |
| `temperatureC` | the battery's temperature, degrees Celsius, one decimal | `idevicediagnostics ioregentry AppleSmartBattery`: `Temperature` (hundredths of a degree, so / 100; a battery that says whole degrees is read as degrees; under 1 or 90+ is a bad read: null) |
| `app` | the app in front: `{bundleId, name}` | WDA `/wda/activeAppInfo`; the name from the phone's app list or the well-known apps when WDA gives none (`"Home Screen"` for SpringBoard) |
| `uptimeSec`, `bootedAt` | seconds since the phone booted, and when that was (ms since the epoch) | **`null` on stock WDA**: neither lockdown nor WDA's `/wda/device/info` says when an iPhone booted. They're read when a WDA build adds `uptime` / `systemUptime` (seconds) or `bootTime` to `/wda/device/info` |
| `model`, `ios` | the product type (`iPhone14,5`) and the iOS version | `ideviceinfo` `ProductType`, `ProductVersion` |
| `wda` | WebDriverAgent's signing: `expiresAt` (ISO 8601), `daysLeft`, `state` (as `GET /api/wda`; `"unavailable"` in mock mode or with the re-sign off) | the re-sign scheduler |
| `thermal` | iOS's own word on heat: `nominal`, `fair`, `serious`, `critical` | WDA `/wda/device/info` `thermalState` |
| `connectedAt` | when the server last saw the phone plugged in (ms since the epoch) | the server |
| `at`, `fresh` | when this was gathered (ms), and whether it's a gathered answer under ~15 s old (`false`: the quick answer from what the list already knew, or an older one) | the server |

- **Anything the phone (or its tools) can't say is `null`**; the shape never changes (`battery`, `app` and `wda` are always
  objects). A part that doesn't answer once (WDA busy with a long gesture) keeps its last value for a minute.
- **Kept ~15 s.** `GET .../info` asks the phone when what's kept is older (one asking at a time per phone, shared by
  everyone waiting; about 0.3-1 s), `?fresh=1` asks now anyway. **The list never waits**: `info` there is what's kept,
  and a gathering starts in the background for the next list when that's over ~15 s old (the first list after a start
  carries `fresh: false` with only what the list itself knows: battery level, model, iOS).
- It never touches the live view or the input: lockdown and the IORegistry are read through libimobiledevice (they work
  while WDA is down), and the WDA reads are quick ones (2.5 s at most) that never wait for WDA to start and never
  recover it.
- 404 `{"ok":false,"error":"unknown phone"}`; an unplugged phone answers 200 with what was last known.

#### Info that keeps up

Every control socket of a phone (`WS /phones/:udid/control`) is told at once when its card changes, so cards don't
wait for the next list:

```json
{"type":"info","udid":"...","info":{"battery":{"level":0.87,"percent":87,"charging":true},"temperatureC":30.2,
 "app":{"bundleId":"com.apple.Preferences","name":"Settings"},"...":"the rest as GET /info","orientation":"portrait"}}
```

`info` is the card as `GET /info` gives it, plus `orientation`. It's sent when:
- an AI read or a reported action (`report`/`verify`, `/tap-element`, `/act`, `/ui`) saw a different app in front: at once;
- any other action ran (a tap, a swipe, Home...): the card is gathered again about 1.2 s later and sent when the app in
  front, the battery level, charging or the thermal state changed;
- the phone turned (also `{"type":"orientation"}` as before);
- the card was gathered for another reason (the list, the 12 s watch of a phone on show) and one of those changed.

### Capture only while a live view is open

2026-11-16 (the owner: "we really don't need it to be LIVE all the time ... ONLY when we start on LIVE VIEW we start
seeing it"). iOS tells apps while the screen is captured (`UIScreen.isCaptured`), so the phone's USB screen capture
(`phonecap`, the H.264 lanes, WebRTC) runs only under a picture someone asked for.

- **Starts with the first viewer**: an `rtc-offer` on the control socket, or a stream WebSocket. Nothing else starts
  it: not `POST /focus`, not `POST /warm`, not a control socket by itself, not the watch. No warm capture, no
  prestart, nothing kept for the phone in focus (`CAPTURE_WARM_SECONDS` is ignored).
- **Stops completely `CAPTURE_GRACE_MS` (2.5 s) after the last viewer left**: long enough for a page to redraw or a
  WebRTC session to be made anew, no longer. A switch of the focus never stops a capture someone still watches.
- **`capturing`** on each phone of `GET /phones` says whether it runs now. `POST /warm` and `/focus` answer
  `capture`: `"warm"` (running under a viewer), `"off"` (nobody is watching) or `"unavailable"`.
- **The live touch session (HID) goes by the same rule**: opened while a live view holds it, closed 2.5 s after the
  last one left, never opened for an agent's tap on a phone nobody watches (WDA takes that).
- **The agent works from stills** (`src/stills.ts`): `/screenshot`, `/ui`, `/act`, `/tap-element` and every look
  before and after an action use WDA's own single screenshots (a frame of WDA's MJPEG server on a stock WDA, else its
  PNG), never a frame of the capture, and never start it or keep it running.

### Opening a view

The slow part of opening a live view is the capture: `phonecap` starting and the phone's screen showing up as a capture
device takes a second or two; everything after it is a few ms.

- **A keyframe at once.** A joining viewer gets the cached config + keyframe immediately and a fresh one is asked from
  the encoder; an MJPEG viewer joining a running stream gets its newest frame without waiting for the next.
- **`connectMs`** = the request (the stream's upgrade, the `rtc-offer`) -> the first frame, in ms, and **`warm`** =
  the capture already had a picture when the request came:
  - H.264 WebSocket hello: `{..., "connectMs": 12, "warm": true}` (the keyframe follows the hello at once).
  - MJPEG hello: `connectMs` too; the hello goes out with the first frame (when none comes within 1.5 s it goes
    without, `connectMs: null`).
  - `rtc-hello`: `connectMs` = the offer -> the capture has a picture to send, and `warm`.
  - After the first frame is actually sent, every transport says `{"type":"first-frame", udid, transport:
    "webrtc"|"h264-ws"|"mjpeg-ws", connectMs, warm}` (on the control socket for WebRTC: there it includes ICE and DTLS,
    so it's the real time the view took to open).
  - `stats.sessions[].connectMs` keeps it per open view.
- The WebRTC library loads when the server starts, not under the first offer.

### Orientation and coordinates

`orientation` is how the phone is held: `portrait`, `landscape-left` (turned 90 degrees counter-clockwise, its top edge on the
left; WDA's `LANDSCAPE`), `landscape-right` (turned clockwise) or `portrait-upside-down`. It's read from WDA
(`GET /session/:id/orientation`) with the screen size, cached, asked again every 3 s while a view of the phone is open
(and at once when the picture's size changes), and sent to every open view when it changes:

```json
{"type":"orientation","udid":"...","orientation":"landscape-left","point_width":844,"point_height":390,
 "screen_width":2532,"screen_height":1170,"width":2532,"height":1170}
```

`point_width`/`point_height` and `screen_width`/`screen_height` are the screen **as it's turned now**, in points and in
pixels; `width`/`height` are the size of that view's own frames (the stream's or the WebRTC track's; the screen's on a
control socket with no video). The device list, every hello (`hello`, `rtc-hello`) and `GET .../orientation` carry the
same fields. **Every picture is upright**: screenshots, MJPEG frames (`mjpegFixOrientation`), H.264. Draw it at its own
aspect ratio. An MJPEG `orientation` message may also say `turn: 90 | 270`: an old WDA build that can't turn its frames
sent them sideways, and the viewer should turn them that many degrees clockwise.

**Coordinates are in the upright picture**, top-left origin, whichever way the phone is turned. `unit` says what they are:

| `unit` | Meaning |
|---|---|
| `"norm"` (preferred) | 0..1 of the upright picture: `{x: 0.5, y: 0.5}` is the middle in any orientation and at any stream size |
| `"px"` | pixels of the upright picture; send its size as `w`, `h` (the frame the click was on), else screen pixels (points x scale) |
| `"pt"` | points, WDA's upright coordinate space (0 to `point_width`/`point_height`) |

Without `unit`: when every coordinate of the message is within 0..1 and not all are whole numbers it's normalized, else
points (what older clients send). Pixels must say `"unit": "px"`. The server clamps to the screen and maps to what each
route wants: WDA takes upright points; HID touches the glass itself, so the point is turned onto the panel
(`landscape-left`: panel x = 1 - v, y = u; `landscape-right`: x = v, y = 1 - u; upside down: both flipped; `src/orient.ts`).
A live touch's unit is its `down`'s. Normalized or pixel coordinates before the screen size is known answer 503.

### Action reports

Every action over HTTP (`tap`, `swipe`, `path`, `hold`, `type`, `key`, `home`, `launch`, `tap-element`) answers:

```json
{"ok":true,"ms":3.1,"total_ms":412.6,"via":"hid","changed":true,"app":"com.apple.Preferences","orientation":"portrait",
 "verified":true}
```

- `ok`: the action reached the phone. A failure is an HTTP error `{"ok": false, "error": "..."}`.
- `ms`: the server's receive -> injected time. `total_ms`: with the looks before and after (and the verify).
- `via`: `hid`, `wda-fast`, `wda` (or `mock`); `reason`: why a slower route took it, when one did.
- `changed`: did the screen change? The picture before and ~350 ms after (1 s after a launch; `settleMs` in the body
  changes it) compared by hash (the newest MJPEG frame; the UI tree when there's no frame). `null` = couldn't tell.
- `app`: the foreground app's bundle id after it. `orientation`: as above.
- `verify` in the body waits for a condition and adds `verified`: `{text?, label?, app?, gone?, timeoutMs?}` (default
  3000, max 20000): `text` appears anywhere on screen (case-insensitive, part of a line), `label` an element with exactly
  that label, `app` the foreground app (name or bundle id); `gone: true` waits for the text/label to disappear. When it
  doesn't come: `verified: false` and `error: "verify: no \"Wi-Fi\" on screen (waited 3000 ms)"`, still `ok: true` and 200
  (the action itself went).
- `"fast": true` (or `?fast=1`) skips all of it: `{ok:true, via, ms}` (for a viewer that sees the picture anyway). The
  report costs ~0.4 s on top of the action.
- A gesture answered when it was queued on the phone (`hid`, `wda-fast`) is still playing there: the look after comes
  after it has played (`total_ms` includes it; `ms` stays receive -> injected), and if it broke off on the phone the
  answer is 502 `{"ok":false,"error":"the gesture broke off on the phone (HID: ...); look at the screen before trying again"}`.

Reported actions for one phone run one at a time, in the order they arrived (each owns its look before and after).

### AI control: read the screen, act, verify

`GET /phones/:udid/ui` gives the screen from WDA's accessibility tree (`/source?format=json`), flattened:

```json
{"ok":true,"udid":"...","orientation":"portrait","app":"com.apple.springboard","point_width":390,"point_height":844,
 "width":1170,"height":2532,"count":5,"total":8,"truncated":false,"hash":"6cd13c3d62a019bc","ms":212.4,"cached":false,
 "text":"Mock iPhone 1\nSafari\nSettings\nCamera\nPhotos","lines":["Mock iPhone 1","Safari","Settings","Camera","Photos"],
 "elements":[{"id":"0.0.2","type":"Icon","label":"Settings","name":"Settings","value":null,
              "x":0.2705,"y":0.1422,"w":0.209,"h":0.0829,"enabled":true,"visible":true,"hittable":true}]}
```

- `elements`: visible elements that have text or can be acted on (buttons, fields, switches, cells, icons, links...), in
  reading order. `id` is the element's path in the tree (stable while the screen doesn't change); `type` is the XCUI type
  without the prefix; `x, y, w, h` are **normalized in the upright picture** (the top-left corner and size, so its middle
  is `x + w/2, y + h/2`); `hittable` = on screen, visible and enabled. Strings are cut at 200 characters.
- `text`/`lines`: every visible string, top to bottom, left to right (at most 6000 characters). `total`: nodes in the
  tree; `truncated`: more than `max` (400) elements matched; `hash`: changes when the screen's content does.
- `?all=1`: hidden elements and containers too; `?fresh=1`: not the answer from the last 300 ms; `?settle=1`: wait for
  the picture to stop changing first (at most ~0.9 s), then read.
- A big screen can take WDA a second or more; the same question asked meanwhile shares the one answer.
- **Never a stale screen.** An answer read before the phone's last input is never given again, however recent (a tap,
  then `/ui` 10 ms later, is a new read), and a read that an input overtook is read once more before it's answered.

`POST /phones/:udid/tap-element` `{id | label | name | text, index?, timeoutMs?, verify?}`: `id` from `/ui`; `label` /
`name` match the whole string first, then its start, then any part (case-insensitive); `text` looks in label, value and
name. Hittable matches come first, then reading order; `index` picks another one (0-based). `timeoutMs` (max 15000)
waits for the element to appear. It taps the element's middle and answers the report plus `element` (the one tapped)
and `matches`. No match: 404 `{"ok":false,"error":"no element matches label \"Buy now\"; the screen says: Settings | Back | ..."}`.

What keeps a tap on the right thing:

- **Transitions.** When the phone had input in the last 1.5 s (the step before, a launch, someone's touch), the picture
  is waited for to stop changing first (two looks 150 ms apart that are the same; at most ~0.9 s, so a video never
  blocks), and an element that isn't there yet is waited for up to 1 s even without `timeoutMs`: a button is tapped
  where it comes to rest, not where it was while its screen slid in. `"settle": false` skips the wait; `"timeoutMs": 0`
  means "now or 404".
- **Ids from a screen that changed.** An `id` is a place in the tree, so after the screen changed something else sits
  there. Send what you read at that id beside it (`{"id":"0.2.1","label":"Buy now"}`; `name` or `text` work too): if
  the element at that id no longer says so, the one that does is tapped instead (`"moved": true` in the answer), and
  when nothing on screen does, nothing is tapped: 409 `{"ok":false,"error":"the screen changed since it was read:
  0.2.1 is now Button \"Delete\", not label \"Buy now\"; read the screen again"}`. An `id` alone taps whatever is there.
- **Off the screen.** An element whose middle is outside the screen isn't tapped at the screen's edge: 409
  `"... is off the screen (its middle is at 0.35, 1.15): scroll it into view first"`.

`POST /phones/:udid/act` runs steps in order and stops at the first that fails (or whose `verify` doesn't come), unless
`continueOnError: true`:

```json
{"steps":[{"type":"launch","name":"Settings"},
          {"type":"tap-element","label":"Wi-Fi","timeoutMs":3000},
          {"type":"wait","text":"Networks","timeoutMs":5000},
          {"type":"swipe","x1":0.5,"y1":0.8,"x2":0.5,"y2":0.3,"ms":250},
          {"type":"type","text":"hello","enter":true},
          {"type":"key","key":"home"}],
 "verify":{"app":"com.apple.springboard"}}
```

Steps (1-50): `tap`, `tap-element` (a `tap` without `x` is one), `swipe`, `path`, `hold`, `type`, `key`, `home`,
`launch`, `wake`, `lock`, each with the body its own endpoint takes (and its own `verify`), plus `{"type":"wait","ms":500}`
and `{"type":"wait", text | label | app, gone?, timeoutMs}`. Answer:

```json
{"ok":true,"ms":4210.3,"changed":true,"app":"com.apple.springboard","orientation":"portrait","verified":true,"done":6,
 "steps":[{"i":0,"type":"launch","ok":true,"ms":180.2,"total_ms":1390.1,"via":"wda","changed":true,"app":"com.apple.Preferences","orientation":"portrait"},
          {"i":1,"type":"tap-element","ok":true,"ms":3.0,"via":"hid","changed":true,"element":"0.0.4.1","label":"Wi-Fi","matches":1}]}
```

`ok` = every step went and every verify came; otherwise `ok: false` (still 200), `failedAt` (the step's index) and
`error: "step 1 (tap-element): no element matches ..."`; `done` = steps that went.

### Control WebSocket

`WS /phones/:udid/control?token=...` (or the bearer header). The server first sends `{"type":"hello", udid, profile,
orientation, point_width, point_height, screen_width, screen_height, width, height}`, and `{"type":"orientation", ...}`
whenever the phone turns, and `{"type":"info", udid, info}` whenever its detail card changes (see
[Info that keeps up](#info-that-keeps-up)). Messages in:

- `{id, type:"tap", x, y}`, `{id, type:"swipe", x1, y1, x2, y2, ms}`, `{id, type:"swipe", points, duration}`,
  `{id, type:"path", points}`, `{id, type:"hold", x, y, ms}`, `{id, type:"home"}`, `{id, type:"type", text, enter?}`,
  `{id, type:"key", key}`, `{id, type:"launch", bundleId | name}`, `{id, type:"wake"}`, all with `unit` as over HTTP.
- `{id, type:"tap-element", element | label | name | text, index?, timeoutMs?, verify?}` (`element` = the element's id
  from `/ui`, since `id` is the ack's here).
- Any of them with `"report": true` or a `verify`: the ack carries the whole [action report](#action-reports).
- live touch: `{type:"touch", phase:"down"|"move"|"up", x, y, t, seq, id}`, below.
- clock sync: `{type:"ping", t}` -> `{type:"pong", t, server_time}` right away (also on the stream socket and the `input-r`
  data channel). With the round trip the client estimates the server clock offset, and with the capture times below it
  shows glass-to-glass latency.
- WebRTC signaling: `rtc-offer`, `rtc-ice`, `rtc-close` (see [Live view](#live-view-webrtc-h264-mjpeg)).

Replies: `{"type":"ack", id, ok:true, via, ms, reason?}` once the action is injected on the phone (with HID or the fast WDA
route that's a few ms after it arrives: the phone plays it from its own queue; with the old WDA route, once XCTest finished
it), or `{"type":"ack", id, ok:false, error}`. With `report`/`verify`/`tap-element` the ack is
`{"type":"ack", id, ok, ms, total_ms, via, changed, app, orientation, verified?, error?, element?, matches?}`. Messages
without an `id` get no ack on success; a failure still answers, with `id: null`. Messages on one socket are done in the
order sent (a plain action behind a reported one waits for it).

### Live touch

```json
{"type":"touch","phase":"down","x":0.42,"y":0.63,"unit":"norm","t":0,"seq":1,"id":"g7"}
{"type":"touch","phase":"move","x":0.43,"y":0.60,"t":16,"seq":2,"id":"g7"}
{"type":"touch","phase":"up","x":0.45,"y":0.52,"t":48,"seq":3,"id":"g7"}
```

`phase` `down` | `move` | `up`; `x, y` in the upright picture (`unit` as above; the `down`'s unit holds for the touch);
`t` ms since the press began (optional; the server's clock otherwise); `seq` a number that grows with every event of
the connection; `id` names the touch (any string or number, the same on all its events). One finger per phone. The same
messages go over the control socket, the `input` / `input-r` data channels and `POST .../touch`.

Every event with a `seq` is answered, on the channel it came by:

```json
{"ack":2,"id":"g7","phase":"move","ok":true,"ms":2.4,"via":"hid"}
```

`ack` = its `seq`; `ms` = the server's receive -> injected time (the input latency; `GET .../input` has the averages);
`via` = `hid` (live on the phone), `buffered` (kept for the `up`), or on the `up` of a buffered touch the route that
played it (`wda-fast`, `wda`); `reason` why it isn't live; `coalesced: true` a move folded into a newer one; `stray: true`
an event for a touch the server no longer has (lifted by the timeout, replaced by a new `down`); on failure
`{"ack": seq, id, phase, ok: false, error, ms}`. Events without `seq` (older clients) work as before and aren't acked
(a failure still is).

- **Order.** Events are applied in the order they arrive, through the phone's queue. `down` and `up` are never dropped,
  never refused by a full queue, and never overtaken. A `move` with a `seq` older than one already applied is skipped
  (the unordered channel).
- **Coalescing.** While a move waits for the phone, newer moves replace it: the phone always gets the newest point and
  a slow link never builds a backlog. All of them are acked when that point is injected.
- **One contact from `down` to `up`** (2026-11-16). A finger held still stays down for as long as its sender's link is
  alive: any message on its socket or channel counts, its pings too, so a long press needs no repeated `move` (one a
  few times a second is still welcome), and the server says the contact again to the phone every 0.8 s. The owner's
  live touch never waits for WDA's health checks, the idle probe, the look at a quiet phone's screen or the gap
  between two actions, and natural touch never reshapes or delays it.
- **Auto-release.** The server lifts a live touch itself, and tells its sender
  `{"type":"touch-released", id, reason:"timeout"}`, only when the link died: no event of the touch and nothing at
  all from its sender for 6 s, or a sender that is alive but silent about the touch for 30 s (a frozen page). A touch
  whose socket or channel closed waits 2.5 s for the same touch (`id`) to go on over another link, then it's lifted.
  A new `down` lifts it too. The HID sidecar has its own 12 s watchdog below that, and lifts when its session closes.
- **Live or buffered.** With CoreDevice HID (below) `down`, each `move` and `up` reach the phone as they come, like a
  real finger. Without it (WDA can't keep a finger down between requests) they're buffered and played as one gesture
  when `up` arrives, with every point and its timing; a still touch lifted within 250 ms becomes a tap. A buffered touch
  never lifted is forgotten after 60 s.
- **Failures.** A `down` that can't go live (HID closed, starting, failed) is acked `via: "buffered"` with the `reason`,
  and the whole gesture plays through WDA on `up`: one fallback per gesture, never half of each. If the live channel
  breaks mid-drag the finger is lifted, the event answers `ok: false` and the sender gets
  `{"type":"touch-released", id, reason:"lost", error}`; the gesture is not replayed (that would play it twice). HID
  reconnects by itself (after 1, 2, 5, 15, 30 s, then every minute; at once when its session just closed).
- **A locked or dark phone**: the `down` (or the tap) wakes it first, then goes.
- **A finger stays down at least 30 ms.** A quick tap whose `down` waited in the phone's queue (the phone waking, a
  gesture still playing) is not pressed and lifted in the same instant.

One-command drags stay: `{type:"swipe", points: [[x, y, t], ...], duration}` is replayed on the server as one smooth
gesture (the `remote` profile's way).

## Input: taps, swipes, typing

Research and ranking: [docs/BEST_METHOD.md](docs/BEST_METHOD.md). WDA's own `/wda/tap` costs ~0.9 s *on the phone* (it looks
up the active app through accessibility on every call, then XCTest waits for the daemon to confirm the event), which was
the ~1.2 s tap on the LAN. It was replaced, not tuned. Each action takes the first of these that the phone has now:

1. **`hid`: CoreDevice HID** (the path Xcode 27's Device Hub uses; iOS 27+ only). `native/hid/hid_input.py` (one per phone,
   pymobiledevice3) holds a touch session open while someone views the phone (the media-stream auth gate, ~0.5-2 s to
   open once, not per tap) and writes 58-byte touchscreen reports to it: a tap is a few ms on the Mac, live drags, typing
   through a virtual HID keyboard (printable ASCII; other text goes through WDA). The session closes after
   2.5 s with no live view holding it (2026-11-16; `HID_IDLE_SECONDS` is ignored): while it's open the phone's camera/mic apps get black/silence, and
   it can't start while one is in the foreground. In landscape the point is turned onto the panel (`HID_LANDSCAPE=swap` if the two landscapes come out mirrored on the Mac, `off` to use WDA
   whenever the phone is turned). Any failure falls back to WDA for that gesture, with the reason in its ack, and HID
   reconnects by itself (1, 2, 5, 15, 30 s, then every minute).
2. **`wda-fast`: the patched WDA route** `POST /wda/lotus/touch` (`scripts/patch-wda.mjs`, applied by
   `scripts/build-wda.sh`): builds the touch at absolute coordinates with no active-app lookup and answers as soon as it's
   queued on the phone (a small queue there keeps the order). Taps, swipes, paths and holds. Needs WDA rebuilt once with
   the patch; an unpatched WDA answers 404 and the server uses 3 for that runner. Portrait only unless `WDA_FAST_LANDSCAPE=1` (then the point is turned onto the panel; try it on the Mac before keeping it).
3. **`wda`: the old routes**: `/wda/tap` (or `/wda/tap/0`, or a pointer tap), W3C actions for gestures, `/wda/keys` for
   text. Also `home` and `launch` always.

What the two quick routes mean for order and for failures:

- **A gesture still playing holds the next action.** `hid` and `wda-fast` answer when a swipe, path or hold is queued on
  the phone, which then plays it for its length. Its sender has its ack at once, but the phone's next action starts
  only when it's through, so a Home press or a tap by another route never lands in the middle of a swipe. (The HID
  sidecar plays one thing at a time; an input sent behind a long hold used to time out after 5 s and kill the sidecar
  in the middle of the gesture. It now gets that much longer.)
- **Text is answered when it's typed.** `type` through HID answers after the last key (about 50-70 ms a key), not when
  it's queued, so a tap or Enter sent next finds the whole text there.
- **An input whose outcome isn't known is never repeated.** A HID input that the phone refused (nothing reached it)
  goes through WDA instead, as before. One that got no answer in time, or text that broke off partway, does not: it
  may have happened (or half of it has), and doing it again would tap twice or type the text twice. The action fails
  with 504 `"the phone didn't confirm the tap in time (HID: ...); it may or may not have happened, so it was not
  repeated: look at the screen before trying again"` (502 for text or a gesture that broke off partway), and the HID
  session reconnects by itself.

`GET /phones/:udid/input` and the server log (`[input xxxxxxxx] tap via hid: wait 0 ms + inject 3 ms = 3 ms`, one line
per action, `INPUT_LOG=0` turns them off) give receive -> injected per action. `methods` says what each phone has:
`hid` (`ready`, `starting`, `off`, `failed` with `hid_reason`, or `unsupported` with why) and `wda_fast` (`yes`, `no` =
this WDA build has no fast route, `unknown` = not tried yet).

## Live view: WebRTC, H.264, MJPEG

**Lotus's Phones page uses WebRTC only since 2026-11-16** (no H.264 WebSocket, no MJPEG, no snapshots): its engine
keeps the picture up by itself (a keyframe asked with `rtc-key`, a few seconds for the link to come back, then a new
offer) and says why when it can't connect. The other two transports below stay for older clients.

Three transports, best first. The client tries WebRTC, then the H.264 WebSocket, then MJPEG; the server tells it when it
has to step down (`rtc-error`, or a `codec:"mjpeg"` hello with a `reason`).

**Capture (macOS):** `native/phonecap` is a small Swift tool that captures the iPhone screen over USB the way QuickTime
does (CoreMediaIO's `kCMIOHardwarePropertyAllowScreenCaptureDevices`, then the iPhone as an AVFoundation capture device,
matched by UDID, then name), at up to 60 fps, encodes it with VideoToolbox H.264 in real time (low-latency rate control,
Constrained Baseline, no B-frames, keyframe at least every 2 s, 8 Mbps by default, optional downscale in the capture
pipeline), and writes framed Annex B NAL units to stdout. The server runs one helper per phone on demand, shared by all
viewers, stops it 2.5 s after the last viewer leaves (see [Capture only while a live view is open](#capture-only-while-a-live-view-is-open)), restarts it on a crash with backoff (after 3 failed starts it gives up
for 60 s and viewers get MJPEG), and caches the latest SPS/PPS and keyframe so a new viewer sees a picture at once (then
gets a fresh IDR). It does not need WDA, so the picture works even while WDA restarts.

### WebRTC (primary)

Signaling over the authenticated control WebSocket:

- client -> `{type:"rtc-offer", sdp, want:{fps, scale, quality?}}` (the client makes the offer: a recvonly video
  transceiver and two data channels, below)
- server -> `{type:"rtc-answer", sdp}`, then `{type:"rtc-hello", codec:"h264", width, height, fps, scale, server_time, orientation, point_width, point_height, screen_width, screen_height, connectMs, warm}` once
  frames flow (then `{type:"first-frame", transport:"webrtc", connectMs}` when the first one left on the track), or `{type:"rtc-error", reason}` (H.264 unavailable, bad offer, WebRTC library missing) -> fall back
- trickle ICE both ways: `{type:"rtc-ice", candidate, mid}` (the server's candidates come without the `a=` prefix);
  `{type:"rtc-close"}` ends the session (closing the control socket does too). A new offer replaces the old session.
- client -> `{type:"rtc-key"}`: a fresh keyframe now, as a PLI asks (the client's watchdog sends it when its picture
  stalls). Like PLI/FIR: at most one per 500 ms, and not while a keyframe is still on its way to the viewer.

Media: one sendonly H.264 track (the offer's `packetization-mode=1` H.264 payload type, preferring `42e01f`, answered with
`profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1`). Each access unit goes out as RTP with a 90 kHz
timestamp from the capture time (a frame over 500 ms from now when it's sent, such as a cached keyframe, is stamped as
just captured); **SPS/PPS go with every keyframe in the same access unit** (Chromium's WebRTC decoder can't start from a
bare IDR: `docs/latency.md`, 2026-11-16). A new viewer of a running stream starts from a fresh keyframe (not the cached
one). RTCP PLI/FIR force an IDR, NACKs are answered from a small retransmit buffer, sender reports are sent. If the offer has the `playout-delay` header extension,
every packet carries min=max=0 so Chrome renders frames as soon as they're decoded (the client can also set
`receiver.jitterBufferTarget = 0`).

**ICE: host candidates only, no STUN, no TURN.** The server offers its own LAN and Tailscale (100.x / fd7a:) addresses, so the
path is always direct, never relayed. Browsers/WebView2 hide their own LAN address behind an mDNS `.local` name; that's fine:
the server accepts the peer-reflexive address it actually sees the checks come from (libdatachannel does this by default).

Data channels, created by the client, same JSON as the control socket:

- `input`: `{ordered:false, maxRetransmits:0}` for touch `move`s. Late moves (older `seq`, or older `t` without one) are
  skipped; a burst folds into the latest point ([Live touch](#live-touch)). Acks `{ack: seq, ...}` come back on it.
- `input-r`: ordered, reliable, for everything else (`down`, `up`, `tap`, `home`, `type`, ...) with the same acks
  (`{ack: seq, ...}` for touches, `{type:"ack", id, ok, error?}` for the rest), `touch-released`, plus `ping`/`pong`. The server also sends `{type:"ts", rtp, capture_time}` about once a
  second on it: the RTP timestamp of a frame and its capture time (ms since the epoch, server clock), so the client can
  turn any frame's RTP timestamp into its capture time and measure true glass-to-glass latency.

Library: [node-datachannel](https://github.com/murat-dogan/node-datachannel) 0.33.6 (libdatachannel bindings, prebuilt for
macOS arm64/x64, Linux and Windows), **MPL-2.0**, pinned exactly. `npm install` must keep optional dependencies (they hold the
prebuilt binary). If it can't load, the server still runs and answers offers with `rtc-error`.

### The phone's sound (2026-11-16)

The owner hears each phone through the live view, and the phone itself stays quiet (it sits at Rinor's house).

- **Capture**: `native/phonecap` (`--audio`, caps `audio`) adds an `AVCaptureAudioDataOutput` to the **same** capture session
  as the picture: the iPhone's USB screen device is muxed (picture and sound), as QuickTime's "iPhone" audio input. Samples
  are asked for as 48 kHz stereo float, cut into 20 ms frames and encoded with AudioToolbox's Opus encoder (~80 kbit/s;
  a Mac without one sends G.711 u-law, 8 kHz mono). The sound runs on its own queue; a failure only says so.
- **The phone goes quiet**: while its screen is captured this way, iOS plays the phone's sound out to the Mac instead of its
  own speaker (QuickTime's behaviour). **Still to be confirmed on the phones themselves (iPhone-1 on iOS 18.5, iPhone-2
  on iOS 18.7.8)**: the server can't check it from here. Apps that protect their content (some streaming apps) may go
  silent while the screen is captured; that's the app's choice.
- **Only while the live view is open**: the helper runs only while a viewer watches the phone (it stops 2.5 s after the
  last one left), and it sends sound frames only while a WebRTC session listens (`audio on` / `audio off` on its stdin).
- **WebRTC**: an offer with an audio m-section (recvonly, Opus) gets a sendonly Opus track on it: its own SSRC, a 48 kHz RTP
  clock advancing exactly 960 ticks a frame (re-anchored to the capture clock after a gap), timestamps from the same
  capture clock as the picture's, RTCP sender reports, and the **same stream id** as the picture so the browser lip-syncs
  the two (`AUDIO_SYNC=0`: a stream of its own, never waiting on the picture). Without sound for the phone the section is
  answered without a sender and the picture is untouched. `rtc-hello` has `audio` and `audio_reason`;
  `{type:"rtc-audio", audio, reason}` follows a change. A sound that fails is dropped alone. A capture that dies before
  any picture twice in a row with sound on runs without sound for 10 minutes (the picture first).
- **The phone's volume**: the phones are kept at 0 % media volume. Whether that level scales what the USB capture carries
  isn't documented; it's taken that it does (reports on QuickTime recordings; iOS also keeps a volume per output route).
  So the server raises the phone's media volume to `AUDIO_PHONE_VOLUME` % (default 50: 8 of 16 presses of WDA's volume
  button) **only once sound frames arrive from the capture** (the sound is on the Mac then) while someone listens, and
  presses it all the way back to 0 (17 presses) when the last listener leaves, **while the capture is held open** (so
  the sound never comes out of the phone meanwhile), and at once if the capture dies. `data/audio-volume.json` names each
  raised phone before its first press, so after a crash or a restart the server puts it back to 0 at start (retried
  while WDA isn't up). `AUDIO_PHONE_VOLUME=0` never touches the volume. Do Not Disturb doesn't mute media sound; the
  Ring/Silent switch (or a silent mode) mutes some apps' sound (alerts, games that use the ambient category), not media.
- **Numbers**: `GET /phones` -> `stats.audio` `{codec, reason, level_db, peak_db, frames, listeners, volume_raised}`
  (`level_db` / `peak_db` every 2 s from the helper: a phone playing sound with `peak_db` near -120 means the capture
  carries silence, e.g. a phone volume that does scale it), and `stats.sessions[].audio` `{on, reason, sent}`.
- **TCC**: macOS may count the sound as Microphone. `phonecap --request-access` now asks for Microphone too; a denied
  Microphone gives no sound (`stats.audio.reason` says so) and never stops the picture.

### H.264 over WebSocket (fallback)

`WS /phones/:udid/stream?token=...&codec=h264&fps=&scale=&quality=&bitrate=` (`bitrate` in kbit/s wins; else `quality`
1-100 maps to 2-12 Mbps; default 8 Mbps). A viewer that isn't on the LAN gets a far lane (see below); `full=1` opts out.

1. Text: `{type:"hello", codec:"h264", udid, width, height, fps, scale, server_time, orientation, point_width, point_height,
   screen_width, screen_height, connectMs, warm}`. If H.264 isn't available the hello is
   `{type:"hello", codec:"mjpeg", reason, udid, contentType, fps, scale, quality}` and MJPEG frames follow instead.
2. Binary, one per message: 1 byte kind (`1` config = SPS+PPS, `2` keyframe, `3` delta), 8 bytes capture time (float64
   big-endian, ms since the epoch on the server's clock), then the Annex B payload (start codes included).
   Config always comes right before a keyframe (and only when it changed); the first frames are config + keyframe.
3. Latest-only: when the socket's `bufferedAmount` is high (over 256 KB, 64 KB for a far viewer, or 1.5x a keyframe) or
   the ping after the frames shows a queue (see Far viewers), deltas are dropped until the next keyframe and one is
   requested from the helper as soon as the link has room. Nothing is ever queued.
4. Client text `{type:"key"}` forces a keyframe (deltas are skipped until it arrives); `{type:"ping", t}` answers a pong.

The size can change mid-stream (the phone rotates): `{type:"orientation", ...}` says so (on the control socket for WebRTC), a
new config + keyframe arrive; reconfigure the decoder from the SPS. The server checks every capture's shape against the
phone's orientation: a capture still sending the old shape 1.2 s after a turn is started again (twice at most), and if
that doesn't help `stats.capture_mismatch` says what's wrong and `CAPTURE_ROTATE=cw` (or `ccw`) turns the picture in the
helper.

### MJPEG (last resort)

WDA's MJPEG server (no `codec`, or `codec=mjpeg`, or the fallback): `mjpegServerFramerate` = the highest fps asked for
(default now 60), `mjpegScalingFactor` from `scale`, `mjpegServerScreenshotQuality` from `quality`; latest frame only.

### Far viewers: encoder lanes and congestion control

The helper captures each phone once and feeds up to 8 H.264 encoders ("lanes"), each with its own size, frame rate and
bitrate (`src/lanes.ts`, `native/phonecap/main.swift`). Viewers with the same settings share a lane.

- **LAN** (and loopback): exactly what the client asked (Lotus Smooth: 60 fps, 50 %, 4 Mbps; Sharp: 60 fps, 100 %,
  10 Mbps). Unchanged by anyone else watching.
- **Far** (Tailscale 100.64/10 or a public address): at most 30 fps and about 1400 px on the long side, starting at
  1.5 Mbps and climbing 8 %/s while the link keeps up, to the client's `bitrate` (2.5 Mbps when it asks none). Under
  congestion the bitrate is cut toward what the link delivers and the frame rate follows it (30 -> 20 fps under 1 Mbps,
  12 fps under 650 kbit/s). Keyframes every 2 s, and on request. `full=1` (query) / `want.full: true` (rtc-offer)
  gives a far viewer exactly what it asked.
- WebRTC: delay first, then loss, like GCC. The round trip comes from the browser's receiver reports (LSR/DLSR against
  our sender reports); its excess over the quickest of the last 30 s is the queue in front of the viewer. A far viewer's
  queue over 150 ms cuts the bitrate (x0.85, x0.6 over 500 ms; LAN: 80 / 300 ms), at most every 2 s, before any packet
  is lost (a router buffers seconds of video before it drops, and taps' acks wait in the same queue). Then loss
  (receiver reports + NACKs: > 10 % lost cuts). The bitrate climbs only while the queue stays under 50 ms (LAN 25 ms)
  and under 2 % is lost. PLI/FIR at most every 500 ms (only the far lane re-keys), packets paced at 1.5x the ceiling
  (3-8 Mbit/s, `RTC_PACING=0` turns it off).
- Once the WebRTC link connects, the control socket gets `{type:"rtc-path", path, remote, lane, address}`: the media
  path the server sees (`lan`, `tailscale`, `loopback`, `direct`), whether the viewer is on a far lane and the address of
  the pair ICE chose. Show this rather than classifying addresses on the client: Tailscale's IPv6 addresses
  (`fd7a:115c:a1e0::/48`) look like private LAN ones (`fc00::/7`).
- WebSockets: a ping follows the frames; its pong's round trip beyond the base is the queue. H.264: the bitrate is cut
  past 150 ms of queue, deltas dropped (then a keyframe) past 300 ms. MJPEG: one frame may follow one still on its way,
  never more; a far viewer asks WDA for at most 35 % / quality 40.
- An older helper (no `lanes` in `native/phonecap/build/phonecap.caps`, e.g. a build that failed and kept the previous
  one) gets one shared encoder per phone, as before.

### Stats

`GET /phones` -> each phone's `stats`:
`{codec, fps, encode_ms, capture_to_encoded_ms, encoded_to_sent_ms, viewers, viewers_webrtc, viewers_h264_ws,
viewers_mjpeg, path, rtt_ms, queue_ms, dropped, bitrate_kbps, h264_available, h264_reason, lanes, helper_build_error}`
(`rtt_ms`/`queue_ms`: a WebRTC viewer's RTCP round trip and the queue beyond the path's own; `lanes`: each running lane
`{kind: "lan"|"remote", fps, fps_target, scale, width, height, bitrate_kbps, viewers, dropped, rtt_ms, queue_ms}`; `input`
`{via, tap_avg_ms, tap_p90_ms, last, samples, methods}`, see [Input](#input-taps-swipes-typing)). `codec` is what viewers get now (`h264` if any WebRTC/H.264
viewer, else `mjpeg`, null when nobody watches); timings are running averages in ms (capture -> encoded measured in the
helper from the capture timestamp, encoded -> sent in the server); `path` is the WebRTC path (`lan`, `tailscale`,
`loopback`, `direct`; candidates are always host, never relayed); `h264_reason` says why H.264 can't be used (helper not
built, build error, capture failing, `H264=false`).

### The helper on the Mac

- Built by `npm run build` (`scripts/build-native.mjs`: `xcrun swiftc -O`), so the auto-updater rebuilds it after each pull.
  It only rebuilds when `main.swift`/`Info.plist` change. Needs Xcode or the Command Line Tools (already there for WDA).
  On other systems the step is skipped. If the build fails, the previous helper keeps running (only what it speaks is
  used) and the reason goes to `native/phonecap/build/phonecap.error`, `server.log` (`[updater]`/`[native]`) and every
  phone's `stats.helper_build_error`; with no previous helper the server streams MJPEG and says why in `h264_reason`.
- It is built as a minimal app bundle, `native/phonecap/build/PhoneCap.app` (bundle id `com.lotus.phonecap`, ad-hoc
  signed with a fixed designated requirement, `identifier "com.lotus.phonecap"`, so the Camera grant can survive
  rebuilds; set `PHONECAP_SIGN_IDENTITY` to sign with a real certificate instead), so macOS gives it its own Camera entry.
- Try it by hand (`PC=native/phonecap/build/PhoneCap.app/Contents/MacOS/phonecap`): `$PC --list` lists capture devices
  (iPhones show as `iphone-screen`); `$PC --udid <UDID> > /dev/null` should log `capturing ...`.
- **Permissions (Camera / TCC):** macOS treats iPhone screen capture as a camera and asks the *responsible* process.
  Under launchd that would be `node`, which has no camera usage string and can't be added to the Camera list, so access
  is silently denied. So the helper re-runs itself with responsibility disclaimed (like Chromium/LLDB do): it is then
  judged as `phonecap` (com.lotus.phonecap) itself, wherever it's started from. **Once, at the Mac** (or over Screen
  Sharing), in Terminal: `native/phonecap/build/PhoneCap.app/Contents/MacOS/phonecap --request-access` and click
  **Allow**; it prints `authorized`. If it was denied before: `tccutil reset Camera com.lotus.phonecap`, then again.
  It then shows as `phonecap` in System Settings > Privacy & Security > Camera. With ad-hoc signing, a rebuild of the
  helper (only when `main.swift`/`Info.plist` change) can need this step again. Denied = the helper exits 3 and
  `h264_reason` says "camera access denied: ..." with these steps; the viewer falls back to MJPEG.
  The server must run as a user LaunchAgent in the GUI (Aqua) session (see below), not a LaunchDaemon.
- **The iPhone:** must be trusted (Trust This Computer) and **unlocked at least once after plugging in** before its screen
  capture device appears; it can take a couple of seconds after the helper starts. Only one app can capture a phone at a
  time: close QuickTime's movie recording of it. Enabling screen capture makes the phone add a USB configuration, which may
  drop the WDA forwards once on first use; the server's WDA recovery reconnects them.
- Settings (`.env`): `H264=false` turns the H.264 path off; `H264_BITRATE_MBPS` (default 8); `PHONECAP_PATH` overrides the
  helper location.

### WDA health

The server keeps one WDA session per phone warm (made as soon as WDA answers, with the quiescence/idle waits off so actions
don't wait for animations, and the MJPEG settings applied). On a WDA failure (connection refused, invalid session, 5xx) it
makes a new session, restarts the phone's WDA runner if `/status` doesn't answer, and retries the action once. Every ~10 s
each idle phone gets a `/status` check that recovers the same way before anyone notices (a phone on show has its session
itself probed instead, see [Staying responsive](#staying-responsive-wda-self-heal)). `GET /phones` shows it in `control`.

**A session that expired** is remade and the call asked once more, however WDA says it: the standard 404 `invalid session
id`; any other refusal (a 4xx, a bare 404) on a session call, which is checked against `/status` (its `sessionId` is the
session WDA has now: when that isn't ours, ours is gone); and the quiet calls that used to fail silently until the next
health check (the orientation poll, the MJPEG settings), which now have the session remade right then. A refusal on a
session that is still ours is the phone's answer: it's passed on, not retried.

## Our own WebDriverAgent build (2026-11-16)

The phones run **our own WebDriverAgent build**: `wda/` in this repo, Appium's WebDriverAgent at tag v16.15.3 (BSD-3,
its licence kept) with our changes on top. What it changes, file by file, and what still has to be seen on a real
phone: [wda/LOTUS.md](wda/LOTUS.md).

- **A token on every request.** A stock WebDriverAgent answers anyone who reaches its port (another app on the phone,
  anything on the LAN). Ours answers only requests that carry `X-Lotus-Token`, a secret made per phone by this server
  (`data/wda-tokens.json`, readable by this user only, never in git, never logged) and given to the build at launch
  through xcodebuild's environment (`TEST_RUNNER_LOTUS_WDA_TOKEN`). Anything else gets a bare `404` with no body: no
  `/status`, no WebDriverAgent JSON. The compare is constant-time.
- **No MJPEG server.** It's gone from the code: nothing listens on 9100. Stills come from `GET /lotus/shot`.
- **Its own port per phone**: `WDA_FORK_BASE_PORT` (28100) + the phone's index, the same number on the phone and on
  the Mac; `WDA_FORK_PORTS=udid=port,…` gives a phone its own.
- **Only the routes this server uses** (status, session, screenshot, the UI tree, tap, W3C actions, keys, apps, lock and
  unlock, orientation, the app in front, battery and device info, and `/lotus/…`); the rest answer "unknown command".
- **One command per gesture** (`POST /lotus/gesture`): the curve of a natural swipe is drawn here (`src/human.ts`,
  seeded) and sent whole; the phone plays all of it by itself, smooth whatever the link does meanwhile.
- **Live touch** (`POST /lotus/touch`): a finger held down on the phone from "down" to "up", moved as the moves come
  (`via: "wda-live"`), for phones without CoreDevice HID (before iOS 27). It's used only with the way of holding a
  finger down that the phone's own self-test found working (`POST /lotus/selftest`, run by the server right after the
  install); until then, or when none works, a drag is buffered and played whole on "up" as on a stock WebDriverAgent.
  `stats.input.methods` says `wda: "fork" | "stock"`, `wda_live: "ready" | "off"` and `wda_live_reason`.

**It installs itself** (`src/fork.ts`). When the build in the repo (`wda/LOTUS_FORK.json`'s `version`) is newer than
what a phone runs (right after the server pulls a commit that changes it, or when a phone that hasn't got it is plugged
in), the server builds and signs it for that phone with `scripts/build-wda.sh` (`WDA_BUILD_FLAVOR=fork`: the same team,
certificate and bundle id as the 6-day re-sign, so the phone's developer trust stays valid), into its own build folder
(`WDA_FORK_DERIVED_DATA`, `~/wda-fork-build`). The stock WebDriverAgent keeps running until then. The runner is then
switched; if ours doesn't answer with its token within 4 minutes (or the phone refuses the install) the stock one is put
back at once and it's tried again after 2, 5, 15, 30, 60, 180 minutes, then every 6 hours, the phone woken before each
try. Ours that stops staying up later (three runner exits in a row) falls back to stock the same way. The install is a
fresh sign: the 6-day re-sign counts from it and builds each phone's own kind from then on. With no `WDA_TEAM_ID` in
`.env` the team is read from the WebDriverAgent that's already built.

`GET /api/wda` adds `fork: { enabled, version, upstream, problem, perDevice: { <udid>: { state, version, reason,
attempts, nextTryAt, port, live: { tested, mode, why, notes } } } }`; `state` is `stock`, `building`, `installing`,
`fork`, `waiting` (the build failed) or `rolled-back`. The log says the same under `[wda-fork]`.

Before our build is kept on a phone it must also do the work: a session, the screen's size and a still (else the stock
one comes back). It can be turned off from afar, since the Mac pulls this repo by itself: `"enabled": false` in
`wda/LOTUS_FORK.json` puts every phone back on the stock WebDriverAgent once the Mac has pulled it, and
`"liveTouch": "off"` there stops live touch through our build. Its Objective-C can be syntax-checked on a PC:
`python scripts/objc-check/check.py .` and `check2.py .` (clang's front end through `pip install libclang`,
against stand-in headers; not a build).

A stock WebDriverAgent (a phone not switched yet, or `WDA_FORK=false`) is talked to exactly as before: 8100 and 9100
on the phone, no token, MJPEG stills, whole gestures by `/wda/lotus/touch`.

## Idle lock, WDA re-sign, profiles and thumbnails (2026-11-15)

- **Idle lock** (`src/idle.ts`): after `idleLockMinutes` (GET/PUT `/api/settings`, default 10, 0 = off) with no input and
  no open viewer, the server locks the phone (WDA `/wda/lock`, screen off). A new viewer (stream or control socket) or
  any input wakes it by itself (WDA `/wda/unlock`) before the input runs; input on an awake phone waits for nothing.
  Every phone in `/phones` and `/api/devices` has `locked`, `screenOn` (an estimate: off after a lock) and `lastActive`
  (ms since the epoch). A phone with a passcode stays locked after a wake (`warning` says so): remove the passcode.
- **WDA re-sign** (`src/resign.ts`): a free Apple ID's profile lasts 7 days. Six days after the last good sign the server
  re-runs `scripts/build-wda.sh $WDA_TEAM_ID <udid>` for each phone at a quiet hour (03:00-06:00 local,
  `WDA_RESIGN_HOUR`), then restarts the phone's runner so the new build is installed. Never during a live view unless
  under 12 h are left; a failure retries at most every 2 h. The time is kept in `data/wda-sign.json`, and the real expiry
  is read from the built runner's `embedded.mobileprovision` (so a manual build counts). An Xcode that isn't signed in to
  the Apple ID shows as `lastError: "Xcode is not signed in to the Apple ID ..."`. `WDA_RESIGN=false` turns it off.
- **Profiles**: `?profile=lan|remote` on `/stream` and `/control` (default from the client's address: LAN/loopback =
  lan, Tailscale 100.64/10 / fd7a:115c:a1e0::/48 / public = remote); an `rtc-offer`'s `want.profile` too. `lan`: the full
  lane (source size, 60 fps, `H264_BITRATE_MBPS`), taps and live drags straight through CoreDevice HID when the phone has
  it. `remote`: the adaptive far lane (congestion control, src/lanes.ts), and drags go as one
  `{type:"swipe", points:[[x,y,t],...], duration}` (control socket, data channel or HTTP), replayed on the server as one
  smooth gesture; taps stay single commands.
- **Thumbnails**: `?quality=thumb` (or `want.quality:"thumb"` in an `rtc-offer`) gets a small lane: ~360 px long side,
  6 fps (4-8 with `fps=`), ~250 kbit/s, shared by every thumbnail viewer of that phone; `quality=full` (or none) gets the
  profile's normal lane. A numeric `quality` keeps its old meaning. MJPEG fallback for a thumb: 6 fps, 20 %, quality 35.
- **Which video path**: each phone's `stats.video_path` (`h264` when phonecap works, else `mjpeg` with `h264_reason`),
  every hello carries `path`, `profile` and `quality_tier`, and `stats.sessions` lists each open view:
  `{id, path, transport: "webrtc"|"h264-ws"|"mjpeg-ws", net, profile, quality, lane, fps, latencyMs, reason?, since}`
  (`latencyMs` = capture -> sent on the server plus half the round trip when known).

## Mac setup (real mode)

1. **Xcode**: install from the App Store, open it once, accept the license, then
   `sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -runFirstLaunch`.
   Sign in with an Apple ID in Xcode > Settings > Accounts (a free account works but its signing expires every 7 days and
   allows few devices; a paid Developer account is strongly recommended for a farm). Note your **Team ID**.
2. **Tools**: install [Homebrew](https://brew.sh), then
   `brew install node libimobiledevice libusbmuxd ideviceinstaller`  (provides `idevice_id`, `ideviceinfo`, `iproxy`).
3. **Appium + xcuitest driver** (used for its bundled WebDriverAgent project and for ad-hoc debugging):
   `npm i -g appium && appium driver install xcuitest`.
   WDA lives at `~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent`
   (check with `ls`; set that as `WDA_PROJECT`). The server drives WDA directly over HTTP, so Appium doesn't have to be running.
4. **Phones**: on each iPhone enable Settings > Privacy & Security > **Developer Mode** (reboot), connect by USB,
   tap **Trust This Computer** and enter the passcode. Optional: Settings > Display & Brightness > Auto-Lock = Never,
   and Settings > Developer > Enable UI Automation. Verify: `idevice_id -l` lists the UDID and `ideviceinfo -u <UDID> -k DeviceName` prints a name.
5. **Server**: clone/copy this folder to the Mac, then `npm install && npm run init-env && npm run build`.
   Edit `.env`: `WDA_PROJECT=<path from step 3>`, keep `MOCK=false`. Never commit `.env`; the token inside is what the Windows app needs.
6. **Build + sign WDA once per phone** (reruns are fast):
   `scripts/build-wda.sh <TEAM_ID> <UDID> [<UDID> ...]`
   The first time, Xcode may ask to allow keychain access; click Always Allow. On each phone, if the runner is untrusted:
   Settings > General > VPN & Device Management > trust your developer certificate.
   The script first adds the fast touch route to the WDA checkout (`scripts/patch-wda.mjs`, see
   [Input](#input-taps-swipes-typing)); after a rebuild, restart the service so the runners pick up the new build.
   **iOS 27+ phones (live HID touch):** `python3 -m venv ~/.phonefarm-hid && ~/.phonefarm-hid/bin/pip install -U pymobiledevice3`
   (no root needed; the server finds that Python by itself, `HID_PYTHON` overrides it).
7. **Run**: `npm start`. Within ~10-30 s of plugging a phone in, `GET /phones` shows `online:true, ready:true`.
   Per phone the server runs `xcodebuild test-without-building` (WDA) plus two `iproxy` forwards (WDA port 8100+n, MJPEG 9100+n;
   the slot `n` per UDID is remembered in `data/ports.json`), restarts WDA with backoff if it dies, and stops it when the phone is unplugged.
   A few minutes later it builds and installs [our own WebDriverAgent build](#our-own-webdriveragent-build-2026-11-16) on the phone
   by itself (one forward, port 28100+n, no MJPEG); the stock one of this step is the fallback.
8. **Network**: the server listens on `HOST=0.0.0.0:8787`, so it is reachable on the LAN and via Tailscale
   (`brew install --cask tailscale`, then use the Mac's Tailscale IP). Allow incoming connections for `node` if the macOS firewall asks.
   Because this API can control phones, keep the token secret and don't port-forward it to the internet.

### Run as a launchd service

The service must run in the logged-in GUI session (xcodebuild/codesigning needs the login keychain), so enable
auto-login for the Mac mini user and use a LaunchAgent:

```
cp deploy/com.lotus.phonefarm.plist ~/Library/LaunchAgents/
# edit WorkingDirectory / log paths / node path (`which node`) in that file first
launchctl load ~/Library/LaunchAgents/com.lotus.phonefarm.plist
launchctl list | grep phonefarm          # check it's running
tail -f ~/phone-farm-server/server.log   # logs (the token is never logged)
launchctl unload ~/Library/LaunchAgents/com.lotus.phonefarm.plist   # stop
```
### Auto-update

The Mac sits behind a home router, so nothing outside can trigger an update: the server checks GitHub itself (outbound only) every `AUTO_UPDATE_SECONDS` (default 10, `0` disables; mock mode never updates) with a tiny `git ls-remote origin refs/heads/main`. As soon as main's commit differs from `HEAD` it force-updates: `git fetch`, `git checkout -f -B main origin/main` (a hard reset: local edits and local commits on the Mac are dropped; untracked/ignored files like `.env` stay), `npm install` (only if package files changed), `npm run build`, then exits so launchd (`KeepAlive`) starts the new build. If install or build fails it resets back to the previous commit and rebuilds it, so the running server and `dist/` stay on the working version; the failure goes to `server.log` (`[updater]` lines) and `GET /update/status` (`lastError`, `failedCommit`), and the poller won't retry that commit until a newer one is pushed. `.env` is never read or printed by it. The old `AUTO_UPDATE_MINUTES` is ignored (only `AUTO_UPDATE_MINUTES=0` still turns updates off).

**Update now (manual):** `curl -X POST -H "Authorization: Bearer $API_TOKEN" http://localhost:8787/update/now` runs the same force-update immediately (and retries a commit whose build failed before).

It relies on the launchd service above, so install that first: `cp deploy/com.lotus.phonefarm.plist ~/Library/LaunchAgents/`, edit the paths, `launchctl load ~/Library/LaunchAgents/com.lotus.phonefarm.plist`. To update by hand anyway: `git pull && npm run build` and kickstart:

After `git pull`/code changes run `npm run build` and `launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`.

## Testing

`npm run check` type-checks. `npm test` runs `test/h264.ts` (helper framing, config-before-key, latest-only drop to keyframe,
helper restarts, offer/RTCP parsing, WebRTC's keyframe unit, RTP clock and pacer queue), `test/input.ts` (live touch straight to the phone and its fallbacks, the HID sidecar's
protocol, the WDA patch, latency metering, acks' `via`/`ms`), `test/orient.ts` (upright -> device mapping in all four orientations, units, the capture check, orientation in the list, hellos and on change), `test/touch.ts` (order, coalescing, acks, auto-release, wake first, fallbacks with a reason), `test/ui.ts` (UI tree flattening, the element finder, apps by name, `/ui`, `/tap-element`, `/type`, `/key`, `/launch`, `/act`, reports and verify), `test/info.ts` (the detail card: the battery / IORegistry / WDA parsers, the ~15 s cache, `GET /info`, `info` in the list, WDA's quiet read), `test/connect.ts` (a capture warmed ahead and kept warm, a keyframe at once on join, `connectMs` and `first-frame`, `POST /warm`), `test/reliability.ts` (an expired WDA session remade on a 4xx, never a stale UI tree, the settle wait and ids from a changed screen, a playing gesture holding the next action, HID inputs that time out or break off, HID reconnect), `test/heal.ts` (a fake WDA that expires its session, hangs or dies and an iproxy that exits, all healed and counted; a hung action's 504, bursts spaced, the probe before the first action after idle, wake-on-touch; units; `POST /focus`, `focused`, `percent` and `info` pushed), `test/rtc.ts` (WebRTC in mock mode with a node-datachannel client: signaling, ICE,
RTP, PLI -> IDR, SPS/PPS with every keyframe, `rtc-key`, the RTP clock, data channels and acks, stats, rtc-error), `test/audio.ts` (the sound: the helper's audio records, `audio on/off`, the held capture, the Opus track beside the picture, a session without sound, the volume raised and put back, a crash's raise put right) and `test/smoke.ts` (a mock server: auth, every endpoint, MJPEG,
H.264 WebSocket, the MJPEG fallback, ping/pong). Mock mode's H.264 is a real, decodable stream (a tiny built-in encoder:
Constrained Baseline 208x448, I_PCM keyframes and skip-coded deltas), so clients can test decoding against it.
Against a live server: `URL=http://<mac>:8787 API_TOKEN=<token> npm test` (needs at least one online phone).

**WebRTC against a real browser** (not part of `npm test`: it needs Edge, Chrome or Brave):
`npx tsx scripts/rtc-browser-check.ts [--profile remote|lan] [--delay 90 --jitter 15 --loss 0.2] [--stale 6]`. The mock
server streams to a headless browser that receives it with Lotus's own live engine (`phones-live.js`, found beside this
repo inside Lotus, else `--live <path>`) and prints, each second, the frames that came, were decoded and were shown, with
the keyframes, PLIs, NACKs, freezes and the jitter buffer. `--delay/--jitter/--loss` put a UDP relay in between (a far
link); `--bare-keys`, `--break-at <s>` and `--blackout <s>:<s>` break the stream to watch the page heal. Exit code 1 when
the picture stalls.

**Lotus's Phones page against a real browser** (not part of `npm test` either): `npx tsx scripts/page-check.ts`. The
page's own `phones.js`, `phones-live.js`, `phones-chat.js` and `phones.css` run in a headless browser with a small
stand-in for Lotus and for its Rust commands, against the mock server: the page mounts without an error, the list is on
the left, the phone in the middle and Lotus on the right, the open phone goes live over WebRTC with its numbers on its
card, a click switches phones, a press reaches the phone, and a dropped link says Reconnecting with the last frame kept
and comes back by itself.

## Settings (.env)

`API_TOKEN`, `HOST`, `PORT`, `MOCK`, `MOCK_PHONES`, `WDA_PROJECT`, `WDA_DERIVED_DATA` (default `~/wda-build`),
`WDA_BASE_PORT` (8100), `MJPEG_BASE_PORT` (9100), `POLL_MS` (5000), `AUTOSTART_WDA` (true), `AUTO_UPDATE_SECONDS` (10, 0 = off),
`H264` (true), `H264_BITRATE_MBPS` (8), `PHONECAP_PATH` (default `native/phonecap/build/phonecap`),
`CAPTURE_WARM_SECONDS` (ignored since 2026-11-16: a capture stops 2.5 s after its last viewer).
Input: `HID_INPUT` (`auto` = iOS 27+ phones, `on` = try every phone, `off`), `HID_PYTHON` (the Python with pymobiledevice3;
default `~/.phonefarm-hid/bin/python` if it exists, else `python3`), `HID_IDLE_SECONDS` (120), `HID_TUNNEL` (`auto`,
`userspace`, `native`, `tunneld`), `WDA_FAST` (`0` = never try the fast route), `INPUT_LOG` (`0` = no per-action lines), `HID_LANDSCAPE` (`on` default, `swap`, `off`), `WDA_FAST_LANDSCAPE` (`1` = the fast route in landscape too), `CAPTURE_ROTATE` (`off` default; `cw`/`ccw` turn a sideways picture upright; `90`/`180`/`270` always turn it);
Sound: `AUDIO` (true), `AUDIO_PHONE_VOLUME` (50 %; 0 = never touch the phone's volume), `AUDIO_SYNC` (`0` = the sound in a
stream of its own, no lip sync).
`WDA_PATCH=0` makes `scripts/build-wda.sh` build WDA unpatched. WDA re-sign: `WDA_TEAM_ID` (the Apple Team ID),
`WDA_RESIGN` (true), `WDA_RESIGN_HOUR` (3: the quiet window is 03:00-06:00 local). Our own WebDriverAgent build:
`WDA_FORK` (true; `false` keeps the stock one), `WDA_FORK_BASE_PORT` (28100), `WDA_FORK_PORTS` (`udid=port,…`),
`WDA_FORK_DERIVED_DATA` (`~/wda-fork-build`), `WDA_LIVE_TOUCH` (`auto`: live touch with the mode the phone's self-test found;
`off`; `on`: mode 1 without the self-test). Video: `RTC_PLAYOUT_ZERO=1` gives far viewers
playout-delay 0/0 again.

## Notes / known limits

- Free Apple ID limits: on each phone, trust the developer under Settings > General > VPN & Device Management > Verify App. Free signing expires after 7 days (the server re-signs WDA every 6 days by itself, see above), allows only about 3 devices, so a real farm needs the paid $99/year developer account.

- Latency: expected numbers per stage, before and after, are in [docs/latency.md](docs/latency.md) (estimates).
- Real mode could not be tested on Windows (nor the Swift helper, which was written without a Mac to compile it); the WDA and libimobiledevice calls follow their documented CLIs/endpoints.
  First on-Mac run: check `GET /phones`, then `/screenshot`, and read `server.log` (`[wda xxxxxxxx]` lines) if a phone stays `ready:false`.
- `iproxy` syntax used is the libusbmuxd 2.x form (`iproxy -u UDID LOCAL:REMOTE`).
- `type` sends keystrokes via WDA; a keyboard must be focused on the phone.
- Rotation, landscape touch and the UI tree were written against WDA's documented behaviour and a mock phone, without a Mac: [docs/MAC_STEPS_2026-11-15b.md](docs/MAC_STEPS_2026-11-15b.md) is the on-Mac check, with the knobs to flip if a landscape tap lands mirrored or a picture stays sideways.
- `/apps` needs `ideviceinstaller` (`brew install ideviceinstaller`); without it only well-known apps are listed, unconfirmed.
- `/info`'s temperature needs `idevicediagnostics` (part of libimobiledevice); `uptimeSec` / `bootedAt` are `null` on stock WDA (an iPhone doesn't say its boot time to lockdown or WDA). The detail card, the warm capture and the reliability fixes of 2026-11-16 were written against the mock and fake WDA / HID sidecars: [docs/MAC_STEPS_2026-11-15b.md](docs/MAC_STEPS_2026-11-15b.md) steps 9-12 are their on-Mac check.
