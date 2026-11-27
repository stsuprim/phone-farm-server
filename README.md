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
recovering) or `WDA refused the request on <name>: ...` (WDA answered but said no). While a phone's WDA is being
restarted every call that needs it answers at once with 503 `{"ok": false, "error": "The phone's control link is
restarting (attempt N)", "state": "restarting"}`; after the restarts gave up, 503 `{"error": "control down: ...",
"state": "down"}`; while it's starting, 503 `{"error": "The phone's control link is starting", "state": "starting"}`
(see [Restarts](#restarts-only-when-wda-is-really-dead-2026-11-18)).

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/health` | - | `{ok, mock, commit, startedAt, uptimeS, rssMb}` (no auth): alive, and which build runs (the commit's first 7 characters, when it started), so a client can tell whether the Mac has pulled a change; 2026-11-27 also `build: {commit, startedAt}` and `forkVersion` (our WebDriverAgent's version in this checkout, or null) |
| POST | `/phones/:udid/open` | `{}` | 2026-11-27: the live view's open. Starts only the USB picture, answers at once, never wakes or asks WDA: `{ok, udid, state, onPhone, lease, capture, pictureAgeMs, control, locked, screenOn, picture: "starting"\|"stream", pictureWhy?, input}`. See [State, open, trace](#state-open-and-trace-2026-11-27) |
| GET | `/trace` (also `/api/trace`) | `?udid=&kind=&after=&since=&limit=` | 2026-11-27: the trace journal `{ok, now, events: [{seq, at, kind, udid, data}], seq, kept, max, counts}`. See [State, open, trace](#state-open-and-trace-2026-11-27) |
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
| POST | `/phones/:udid/type` | `{text, enter?, clear?}` (`enter: true` presses Return after it; `clear: true` empties the focused field in one go first, and `text` may then be `""`; see [Typing](#typing)) | the report plus `check` (the field read back), `value` (not for a secure field), and with `clear` `cleared`, `clear_method` |
| POST | `/phones/:udid/clear` | `{}` | empties the focused field in one go: the same as `type` with `{text: "", clear: true}` |
| POST | `/phones/:udid/key` | `{key}`: `home`, `lock`, `volumeUp`, `volumeDown`, `enter`, `delete` | the report (`lock` locks the phone: the next action wakes it first; `volumeUp` is refused with 403 while `PHONE_SILENT` is on) |
| POST | `/phones/:udid/keyboard` | `{owner: true, ops: [{text} \| {key, mods, n}]}` (at most 64 ops, 10,000 characters) | `{ok, via, ms}`; see [The PC keyboard](#the-pc-keyboard-2026-11-24) |
| | `/phones/:udid/files/…` | photos, videos, files and folders onto the phone | see [Files onto a phone](#files-onto-a-phone-2026-11-24) |
| POST | `/phones/:udid/clipboard` | `{owner: true, action: "copy" \| "cut" \| "paste", text?}` | `{ok, action, how, text?, exact?, why?, via, ms}`; see [The PC keyboard](#the-pc-keyboard-2026-11-24) |
| POST | `/phones/:udid/home` | `{}` | the report |
| POST | `/phones/:udid/launch` | `{bundleId}` or `{name}` (as `GET .../apps` lists it: `"Settings"`, `"TikTok"`) | the report; 404 with nearby names when no app has that name |
| GET | `/phones/:udid/ui` | `?all=1` (every node, hidden ones and containers too), `?max=` (elements, default 400), `?fresh=1` (skip the 300 ms cache), `?settle=1` (wait for the picture to stop changing first) | the screen as an agent reads it, see [AI control](#ai-control-read-the-screen-act-verify) |
| GET | `/phones/:udid/apps` | - | `{ok, udid, apps: [{bundleId, name, installed}]}`: installed apps (`ideviceinstaller`, cached 5 min) plus well-known ones (`installed: null` = not confirmed on this phone) |
| GET | `/phones/:udid/orientation` | - | `{ok, udid, orientation, point_width, point_height, screen_width, screen_height, width, height}`, asked from WDA now |
| POST | `/phones/:udid/tap-element` | `{id \| label \| name \| text, index?, timeoutMs?, settle?, verify?}` | finds the element and taps its middle: the report + `element`, `matches`, `moved?`; 404 says what the screen does say; 409 when the screen changed under an `id` or the element is off the screen |
| POST | `/phones/:udid/act` | `{steps: [...], verify?, continueOnError?}` | a batch in order: the report + `steps`, `done`, `failedAt?` |
| POST | `/phones/:udid/recover` | `{}` | checks WDA (`/status` asked up to 4 times over ~12 s), remakes a dead session, restarts the runner only when WDA is really dead; joins a restart under way (never a second one); while control is down, starts the attempts afresh. Not in the phone's queue. Waits at most 20 s for a restart: `{ok:true, control}` (`"recovering"` when it's still under way), or 502 `{error}` naming WDA |
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
burst reaches WDA spaced and never in parallel; an action that gets no answer in time is answered 504 (2026-11-27: with
"look at the screen", and nothing is pressed or healed because of it; see [Architecture](#architecture-2026-11-27)).

### Architecture (2026-11-27)

Why each part is built the way it is: [docs/root-cause.md](docs/root-cause.md), section 13 (principles, owners, state
machines). The short version:

- **One `PhoneActor` per phone** (`src/phone/actor.ts`) owns everything that reaches it: an input line (touches first)
  and a background line (power, looks, system work), and a **lease** (`free`, `owner`, `hand:<id>`, `system:<op>`).
  Re-signing, the fork install and the updater's checks take the system lease (`acquireSystem`) and wait for a free
  phone; the updater asks the actors' leases before it restarts anything (`setLeaseProbe`).
- **One request at a time to WDA** (`src/lane.ts`): every request is in a journal (`queued`, `sent`, `answered`,
  `abandoned`); a request WDA hasn't answered still counts as on the phone until it answers or its deadline passes, so
  nothing is sent behind a stuck one. When the phone's main queue hasn't moved for 10 s, new actions are refused at once
  (503 `{state: "busy", op, since, reason: "held"}`) instead of landing late.
- **The control link is a state machine** (`src/wda.ts`): `ready`, `busy` (held over 2 s), `hung` (no beat 20 s past
  the held request's deadline), `restarting`, `needs-replug`, `down`. Only `hung` or a dead runner restarts the runner;
  a slow call never does.
- **The capture is a state machine** (`src/h264.ts`): `Off`, `Finding`, `Starting`, `Live`, `Still`, `Stale`,
  `WaitingUnlock`, `Restarting`, `GaveUp`, `Stopping`. A stop finishes before the next start; a picture older than a
  second is said to be stale, never shown as live; a phone seen locked waits for its unlock.
- **No action from inference**: nothing is pressed because a screen couldn't be looked at; a tap is never preceded by
  a probe; only a phone *seen* locked or dark is woken first.
- **A server update leaves the runners up** (`RealBackend.close()` keeps them; only a real stop, `SIGUSR2` or
  `STOP_DEVICES_ON_EXIT=true`, ends them), so a restart of the server doesn't restart WDA on the phones. This needs
  `AbandonProcessGroup` in the launchd plist (see [Run as a launchd service](#run-as-a-launchd-service)).

### State, open and trace (2026-11-27)

All additive: an older client that ignores these fields keeps working (`control` still says only `ready`,
`recovering` or `down`).

**In `/phones` (and every list entry, `/api/status`'s `devices`) and in the control socket's `control` messages:**

| Field | Meaning |
|---|---|
| `state` | `"ready"`, `"busy"` (WDA is working on something), `"hung"` (WDA's main queue doesn't answer), `"restarting"`, `"needs-replug"`, `"down"` |
| `onPhone` | `{op, since, held}` or null: the oldest request on the phone now (`op` like `"POST /wda/unlock"`, `since` ms since the epoch, `held` true once its own wait has passed and the phone still hasn't answered) |
| `lease` | `{kind: "free"}`, `{kind: "owner", since}`, `{kind: "hand", id, since}` or `{kind: "system", op, since}` |
| `capture` | `{state, why}` or null: the capture's state (above) and why, when it isn't live |
| `pictureAgeMs` | how old the newest picture from the phone is (null when there's none) |

**`deadlineAt`** (ms since the epoch, optional): in an action's body (or `?deadlineAt=` on any action and on
`GET /ui`), the time after which its answer is no use. A request that can't start before it is refused with 503
`{state: "busy"}` and never sent; `GET /ui` waits at most until it (and never more than 25 s).

**`POST /phones/:udid/open`** opens a live view: it takes the picture for 15 s (for the view's own stream or offer to
pick up) and answers at once with the phone's state. It never wakes, unlocks or waits on WDA; waking is `POST /wake`, a
separate action whose failure can't fail the open. 404 unknown phone, 503 offline.

**`GET /trace`** (`src/trace.ts`) is a ring buffer of the last 20,000 events, in memory only:
`{ok, now, events: [{seq, at, kind, udid, data}], seq, kept, max, counts}`, oldest first. Kinds: `wda.queued`,
`wda.sent`, `wda.answered`, `wda.failed`, `wda.abandoned`, `wda.cancelled`, `wda.refused`, `wda.skipped`,
`wda.joined`, `wda.dropped`, `link.state`, `link.beat`, `runner.spawn`, `runner.adopt`, `runner.exit`,
`runner.restart`, `capture.state`, `capture.beat`, `freeze`, `open`. Query: `udid` (that phone's and the farm's own),
`kind` (comma-separated, a prefix ending in `.` takes the group: `kind=wda.,freeze`), `after` (seq: read on from the
last one seen), `since` (ms since the epoch), `limit` (default 500, at most 5000). It holds labels, times, numbers and
states only: never a token, typed text or a body (fields named like secrets are dropped).

**The H.264 stream socket** (`WS /phones/:udid/stream?codec=h264`) also sends
`{type: "capture-state", udid, state, reason, capture_time, age_ms}` on every capture change and
`{type: "frame-age", udid, state, capture_time, age_ms}` every second (`capture_time` the newest picture's own time,
`age_ms` its age now), and takes `{type: "freeze", ms?, why?}` from the viewer (journalled as `freeze`). Its `stats`
add `frame_age_ms`.

**Settings:** `agentSeesCapture` (optional, true when absent): whether Lotus's agent may read the screen from the live
picture instead of asking WDA.

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
| XCTest hung under WDA: a request that never answers held the phone's queue for 30 s, then 45 s of recovery | Per-request timeouts (taps, keys, home: 8 s; launch 20 s; a gesture 8 s plus its length; typing by its length). A call with no answer in time fails at once and is **never sent again** (it may still happen); WDA is only checked in the background and restarted only when it's really dead (see [Restarts](#restarts-only-when-wda-is-really-dead-2026-11-18)). The queue never waits more than 20 s (plus the action's own length) for one action: the caller gets 504 `... got no answer within N s: the phone is being checked and healed; it may still happen, so look at the screen before trying again`, and the next action waits at most 5 s more for the hung one to settle (and at most 5 s for a health check on the phone) |
| The WDA port forward (`iproxy`) died (usbmuxd hiccup, the phone re-enumerating after a long sleep) | It's started again by itself; WDA isn't restarted for it |
| WDA itself died (its runner ended, or `/status` stopped answering) | Restarted, backed off and capped (see [Restarts](#restarts-only-when-wda-is-really-dead-2026-11-18)) |
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
  answer in time, over at least 15 s. A refused connection (nothing listens) is checked at once.
- **A recovery fixes only what's wrong.** It asks `/status` four times over ~12 s before it restarts the runner
  (2026-11-18, see [Restarts](#restarts-only-when-wda-is-really-dead-2026-11-18)), and keeps a session that still
  answers (it was only slow); a session WDA itself says is gone is remade.
- **No "down" for a hiccup.** `control` says `recovering` or `down` only once that lasted 4 s
  (`CONTROL_DEBOUNCE_MS`); a session remade in a moment is never shown. A restarting runner says so at once.
- **The control socket.** The server answers `{type:"ping"}` in the message handler, beside whatever the phone's
  queue is doing. It pings each socket every 10 s and closes one nothing was heard from for 35 s (a link that died
  without a word would otherwise count as someone watching, and keep the capture up). Any number of sockets may be
  open for one phone; none closes another.
- **Measured.** `stats.controlLink` on each phone of `GET /phones`: `{open, opens, closes, drops, lastOpen,
  lastClose: {at, code, reason, why: "client"|"dropped"|"dead", livedMs}, wda: {state, raw, misses, recoveries,
  runnerRestarts, answeredMsAgo, busy, restarting, controlDown}}` (`drops`: closes that weren't the client's own;
  `wda.state` is what `control` says, `wda.raw` what it is underneath).

### Restarts only when WDA is really dead (2026-11-18)

The owner: "it RESTART TOO MUCH even if 1 single is not responding or whatever small lag happens it restart
automatically ... and maybe this time while restart it broke." iPhone-2 sat in "recovering" for 10+ minutes with every
call to it timing out, so Lotus said the server couldn't be reached. **Why it stuck:** a restarted runner's start
waited for `/status` by counting 360 tries, not by the clock; with each try's 2 s timeout that was up to 15 minutes in
"starting" (= "recovering"). Meanwhile every call waited up to 45 s for it, `POST /recover` queued behind those calls
in the phone's queue, and any call during a restart back-off killed and relaunched the runner at once. Now:

- **Dead means dead.** WDA is restarted only when `/status` went unanswered `DEAD_PROBES` (4) times in a row,
  `PROBE_EVERY_MS` (4 s) apart, 2.5 s each (about 12-15 s), with no other request of WDA's answered meanwhile (any
  answer at all means it's there). Or when its runner (xcodebuild) ended, or `/status` answers but no session can be
  made twice. A single failed or slow call, or a timeout on a long action, never restarts anything by itself: the call
  fails and isn't sent again (2026-11-21: and nothing is checked for it; see "One request at a time per phone").
- **Fast answers during a restart.** While a phone's restart is under way, every call that needs its WDA answers at
  once with 503 `{"error": "The phone's control link is restarting (attempt N)", "state": "restarting"}` (the HTTP
  routes `ui`, `apps`, `tap-element` and `act` check before anything is queued; everything else when it reaches WDA).
  A WDA that's starting gets 1 s, then 503 `"starting"`. Live view, HID touch and the other phones are untouched.
- **One at a time, backed off, capped.** One restart per phone: a `POST /recover` during it joins the same one (never
  a second); a probe or the health check never starts one on top. Attempts wait 5 s, 15 s, then 60 s between them
  (`RESTART_BACKOFF_MS`), at most `RESTART_ATTEMPTS` (4). Each step is bounded: the runner's `/status` within 90 s
  (by the clock), its session within 20 s. After the last one the phone is **control down** with the last error:
  `control: "down"`, `controlDown: "WebDriverAgent did not come back after 4 restarts (last: ...)"` in `GET /phones`
  and `/info`, and calls get 503 `control down: ...` at once. It never loops in "recovering". A `POST /recover`
  starts the attempts afresh, and WDA answering again by itself (the last runner came up late) brings control back.
- **Said.** `GET /phones` and `/info` carry `control`, `controlDown` (null unless down) and `restarting` (`{attempt,
  of, since}` while one is under way, else null); so does `stats.controlLink.wda`.
- **Logged.** Every restart goes to `server.log` as `[wda-restart] <udid end> ...`: why (which check failed and how,
  e.g. `/status asked 4 times over 12.4 s, never answered (no answer in 2.5 s x4)`), each attempt `n/4`, how it
  ended and how long it took, the waits, "control down", a recover joining, control coming back. Never a token.

`test/restart.ts` checks it: a slow call restarts nothing, two unanswered asks then an answer is alive, three in a row
restart once, calls meanwhile get a 503 at once, a recover joins, the attempts back off and end in "control down", and a
recover or WDA answering again brings it back.

### One request at a time per phone (2026-11-21, the root cause)

The owner: "phone1 loaded for a while and did some few touches and it crashed now... the more we fix the more it
breaks". iPhone-1 showed `busy: 6`, nothing answered for 20 s, the owner's touch failed ("no answer within 5s"), then
`recovering: ... Cannot take a screenshot within 20000 ms timeout`, six recoveries and six runner restarts, "Control down".

**Why.** WebDriverAgent does one thing at a time: its routes run on the phone's main queue, and XCTest's testmanagerd
takes a still only once the accessibility read before it is done. The server asked it whatever it wanted whenever it
wanted, all at once: the orientation every 3 s per watcher and with every list, the card's reads, the watch's lock and
dark checks, the settle's stills, Lotus's reads, the owner's touches, the health checks. One slow still held everything
behind it; every request behind it ran out of time on the Mac yet still ran on the phone later (piling up more); the
one keep-alive agent's 6 sockets filled with them, so `/status` waited for a socket and "never answered"; and the
still's own 500 was taken for a dead WDA, whose recovery dropped the session and made a new one behind the same stuck
work: "no session could be made, twice", a runner restart, again and again. Restarting XCTest runners over and over is
what jams it for good. The earlier fixes tuned thresholds and added checks (more requests), never the concurrency.

**Now** (`src/lane.ts`, `src/wda.ts`):

- **A lane per phone.** Every request to its WDA goes through it, at most one on its way at a time. A touch, key,
  typing, launch, lock or lift goes before reads that wait; a request waits `LANE_WAIT_MS` (8 s) at most for its turn,
  then it's dropped unsent with 503 `{"error": "iPhone-1 is busy: its WebDriverAgent is still working on an earlier
  request (GET /lotus/shot, 9.2 s so far), so POST /lotus/gesture was not sent; try again in a moment", "state":
  "busy"}`. Background reads (the orientation poll, the card, a probe, the watch's lock look) are skipped at once while
  anything else is on its way. A request's own timeout counts from when it's sent, not while it waits its turn.
- **A late answer is waited for.** A request whose caller already heard "no answer" keeps the lane until the phone
  answers it (`HOLD_MS`, 60 s at most), so nothing piles up behind it on the phone; its late answer counts as an answer
  (the miss count is cleared). `stats.controlLink.wda.lane` says what's on its way, since when, and how many wait.
- **Slow is not dead.** A timeout never recovers or restarts anything, and a 5xx (XCTest's "Cannot take a screenshot")
  is WDA answering: it's said as it is (`WebDriverAgent on iPhone-1 could not do it: ...`). Only a request never
  answered at all, not even late (its hold ran out), has WDA checked; a restart still needs `/status` unanswered 4
  times (asked once the lane is free, on connections of its own, so it's never stuck behind requests the phone is slow
  with), or no session at all twice while nothing else of ours was answered either.
- **Answers in time, per phone.** `GET /screenshot` answers within 15 s and `GET /ui` within 25 s whatever the phone
  is doing (Lotus waits 20 s and 30 s, and said "The phone server can't be reached" when they took longer); a still
  the phone is too busy for is said so at once, never followed by a slower one behind it. Timeouts say `iPhone-1 did not
  answer in time (...): its WebDriverAgent is busy or stuck, nothing was restarted, and the request may still happen
  on the phone`. A `POST /recover` answers within 20 s.
- **Fewer stills.** While a live view's capture shows the screen changing (a changed frame within 1 s), the screen is
  on: the dark checks skip WDA's screenshot (the capture is never started or kept for this).

`test/lane.ts` checks it: the lane alone (one at a time, a touch first, a late answer holding it, a read dropped after
waiting too long, background reads skipped, a restart answering what waits), the exchange's hold, and a fake WDA: the
server's many callers reach it one at a time, a slow still and a still's 500 recover and restart nothing, a touch that
would wait too long is dropped with a clear "busy", a request never answered has WDA checked (restarted only when it's
really gone), and `/status` goes past the lane.

### The server never reads the app in front on its own (2026-11-22, the root cause in TikTok)

The owner: "EVEN this on the freaking phone1 it breaks control after few touches". iPhone-1, TikTok's For You feed in
front: the page said "Drag failed: Sending paused a few seconds after 3 failures in a row"; the owner's tap had waited
10.3 s and failed with "The phone's control link is restarting (attempt 1)"; the last heal said "restarting WDA
(attempt 1/4): unreachable (ECONNRESET); then /status asked 4 times over 12.0 s, never answered"; and the card's
`GET /wda/activeAppInfo` was still unanswered 15.5 s later.

**Why.** Some of WebDriverAgent's routes read the *app in front* through accessibility (its orientation, window, name,
`/wda/screen`, the tree, elements). WDA answers them on its one main thread, and an app that is busy all the time (a
video feed) never answers them; `/wda/activeAppInfo`'s hit-test into the app isn't even covered by WDA's
`accessibilityDeadline`. The 2026-11-21 fix only *paused* such reads: the card's `/wda/activeAppInfo` still went out each
time its 10-s quiet window or its stall pause ran out (and the orientation was still asked when a live view opened and
with every new session). That one read held WDA's main thread; the lane held the owner's touches behind it; and a main
thread blocked that long is what iOS kills an app for: the runner's process was gone (`/status`, which isn't on the
main thread, was refused, ECONNRESET, while the phone stayed on USB and its port forward stayed up), so the server
restarted it, and the touches that queued behind that check failed 10 s later. Replayed end to end in
`test/tiktok.ts` (a fake phone with one main thread, TikTok never answering, iOS's 10-s watchdog): on 54977f4 the card's
`/wda/activeAppInfo` reached the phone, blocked it 10 s, the runner was killed and restarted, and a swipe failed after
17.5 s with "restarting (attempt 1)", the phone's own evidence.

**Now:**

- **No read of the app in front unless Lotus asked for it.** `src/wda.ts` refuses, unsent, every such request that
  isn't explicit (`appBound()`): the card, the list, the watch, a live view's picture, a new session, a recovery never
  read it. Only Lotus's own reads go: the UI tree (`GET /ui`, phones_read, tap-element), the app's name and orientation
  with it, and the focused field for typing; each bounded (`APP_READ_MS`: the tree 12 s, the app 3 s), one at a time,
  refused at once while that app is known not to answer (`appStall`, 60 s doubling to 5 min), and never checked or
  restarted for when it hangs (WDA answers `/status`: it's the app, not WDA). Stats: `wda.appReads {sent, refused,
  stuck}`.
- **The app's name** on the card is what's last known (Lotus's own read, the server's launch, a Home press) with
  `asOf`, `from` and `maybeChanged` (input came after it), never a guess.
- **The orientation** comes from the live picture's shape (the USB capture follows the phone as it turns), else what
  was known; there's no orientation poll any more. A phone never seen turned is taken as upright.
- **The size** comes from the model's known size (both farm phones), else is read once with Lotus's first look.
- **Touches never wait behind such a read.** A read of the app in front *yields* in the lane: the owner's touches go
  beside it at once (in order), instead of waiting behind it and being dropped "busy".
- **A runner that's gone never swallows touches.** A refused or reset connection is no busy WDA: the request is
  answered at once with `"The phone's control link is reconnecting (...)"` (`state: "recovering"`), so is every
  request while WDA is checked, `/status` is asked every 2 s (not 4), and a dead runner is restarted in ~6 s instead of
  ~12; during the restart requests hear "restarting" at once. Clients count none of these as failed touches.
- **Evidence kept.** How the last runner ended: `wda.lastRunnerEnd {at, why, xcodebuild: [its last lines], inFlight,
  captureStartedMsBefore, captureStoppedMsBefore}` (and `[wda-restart] ... the runner ended or was given up on` in the
  log), so the next one says by itself whether XCTest saw a crash, a kill or a lost device.
- **A live view after a replug** (iPhone-2 "connecting"): the wake that a picture-less view asks for waits for the
  phone's control link to come up (up to 150 s, outside the phone's lock/wake turn) instead of giving up after 15 s, so
  the phone is unlocked as soon as it can be and the viewer's next try gets the picture.

`test/tiktok.ts` (2 minutes, real clocks: TikTok in front, the owner touching every 1-2 s, a rest, Home and back, the
card and the list asked all along) checks 0 failed touches, 0 reads of the app in front, 0 runner restarts;
`test/stall.ts` checks each rule on its own.

### Long runs (2026-11-21)

What keeps the server up for weeks, with phones watched from far links that sleep and drop:

- **Stream sockets have a heartbeat.** `/stream` (H.264 or MJPEG over WebSocket) is pinged every 10 s like the control
  socket; a client that answered pings and then went silent 35 s (a laptop that slept, a Wi-Fi drop with no close frame)
  is closed, so its capture, its idle-lock hold and its watch end instead of running for nobody. A client that never
  answers pings is left alone. Each socket's end runs once (its `close` and `error` both fire).
- **WebRTC gives up a link that can't connect.** A peer connection not connected 20 s after its offer, or "disconnected"
  for 15 s, ends with `rtc-error` (`the WebRTC link did not connect within 20 s` / `stayed disconnected`); the client
  offers again. Before, such a session held the capture and the phone awake until the control socket closed.
- **A forgotten rejection never ends the server.** `unhandledRejection` is logged (the same reason once a minute) and the
  server carries on; an `uncaughtException` is logged and the normal shutdown runs (WDA runners and forwards ended), then
  launchd starts a fresh one (`src/lifecycle.ts`).
- **One shutdown, with a deadline.** SIGTERM, SIGINT, the updater and a crash share one shutdown; each step's failure is
  logged and the rest still run; open HTTP and WebSocket connections are ended; it exits after 20 s at most even when a
  phone never answers (the plist's `ExitTimeOut` is 30 s).
- **`server.log` is rotated.** launchd's log is checked at start and every 10 min: over 20 MB it moves to
  `server.log.1` (older ones to `.2`, `.3`, the oldest dropped) and is cut in place (launchd's handle appends on).
  `LOG_FILE=/other/path` points it elsewhere; `LOG_FILE=` turns it off.
- **launchd** (`deploy/com.lotus.phonefarm.plist`): `ThrottleInterval` 10 (a crash loop restarts at most every 10 s),
  `ExitTimeOut` 30, and open files raised to 8192 (launchd's default is 256: sockets, pipes, iproxy forwards and
  captures for several phones run out of it).
- **The control state is pushed.** A control socket hears `{type: "control", udid, control, controlDown, needsReplug,
  restarting}` right after its `hello`, and again whenever one of those changes (looked at every second while a socket
  is open), and the `hello` carries the same fields when they're known. Before, "recovering", "control down" and "needs
  replug" reached a client only through `GET /phones`. Older clients read only `control` (a string) as before.
- **`GET /health`** also says `uptimeS` and `rssMb` (the process's memory: a slow leak shows as it climbing over days).

`test/longrun.ts` checks it: the heartbeat (a silent viewer closed once; a never-answering one left; messages count),
both stream codecs' dead viewers closed with no viewer or session left, an offer that never connects answered by
`rtc-error`, the control state pushed (after the hello, in the next hello, on each change, never repeated), the safety net and the shutdown, the log's rotation with an open append handle, and a soak (`SOAK_S`, 20 s
in `npm test`): control and stream sockets opened and dropped without a word, hundreds of cycles, after which no viewer,
session or open link is left and the handles and heap are back where they began (90 s, 2321 cycles: heap 14.0 -> 14.5 MB
with `--expose-gc`).

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
| `app` | the app in front as last known: `{bundleId, name, asOf?, from?, maybeChanged?}` | 2026-11-22: never asked for the card (an accessibility read of that app): Lotus's own last read of `/wda/activeAppInfo`, the server's own launch, or a Home press (`from`: `read`, `launch`, `home`; `maybeChanged` when input came after it); the name from the phone's app list or the well-known apps (`"Home Screen"` for SpringBoard) |
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
left; WDA's `LANDSCAPE`), `landscape-right` (turned clockwise) or `portrait-upside-down`. 2026-11-22: it comes from
the live picture's shape (the USB capture follows the phone as it turns: tall is portrait, wide keeps the landscape side
last known, else `landscape-left`), and from WDA (`GET /session/:id/orientation`, the app in front's, an accessibility
read) only with Lotus's own read of the screen; never polled. It's sent to every open view when it changes:

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

Steps (1-50): `tap`, `tap-element` (a `tap` without `x` is one), `swipe`, `path`, `hold`, `type` (with `clear?`),
`clear`, `key`, `home`, `launch`, `wake`, `lock`, each with the body its own endpoint takes (and its own `verify`; a
`type` or `clear` step answers with the same `check`), plus `{"type":"wait","ms":500}`
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
  `{id, type:"path", points}`, `{id, type:"hold", x, y, ms}`, `{id, type:"home"}`, `{id, type:"type", text, enter?, clear?}`, `{id, type:"clear"}`,
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
   open once, not per tap) and writes 58-byte touchscreen reports to it: a tap is a few ms on the Mac, live drags (text
   goes through the phone's own keyboard since 2026-11-18, see [Typing](#typing); `HID_TYPING=1` types through a
   virtual HID keyboard again). The session closes after
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
- **Text is answered when it's typed.** `type` answers after the last key, not when it's queued, so a tap or Enter
  sent next finds the whole text there.
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

### Typing

2026-11-18 (`src/field.ts`; the Lotus side follows `cache/phones-type-contract.md`):

- **Through the phone's own keyboard.** `type` sends the whole text to WDA's `/wda/keys` in one request, played by the
  phone itself at `TYPE_KEYS_PER_SECOND` (default 15, about the old HID pace), so the on-screen keyboard stays up and
  the text can be watched as it's typed. It used to go through the HID keyboard, where each key was a press and a
  lift sent down the cable as two messages: a lift that came late (the first key, while a web view made room for the
  newly attached keyboard) held the key long enough for iOS's key repeat, which is how a password got "aaa" in front
  of it. A HID keyboard also hides the on-screen one. `HID_TYPING=1` brings the HID keyboard back.
- **Sent once.** Text that failed partway is never sent again (not after a WDA recovery, not on a stale socket): the
  answer is an error saying to look at the field. Only a refused session (nothing typed) is asked once more. Errors
  never hold the text (XCTest names its event after the first letters; that's taken out).
- **`clear: true`** (or `{type: "clear"}`) empties the focused field in one go before typing, never one Delete per
  letter. Our WebDriverAgent build (v4, `POST /lotus/field`) does it on the phone: the keyboard's Clear key, then
  Cmd+A and one Delete, then a triple tap and one Delete, each only while the field still holds something (a secure
  field always gets Cmd+A, since a web view's password field can read empty when it isn't). A stock WDA: its element
  clear on the active element, then Cmd+A and one Delete when that left something. The answer says `cleared` and
  `clear_method` (`empty`, `clear-key`, `select-all`, `triple-tap`, `element-clear`). An older build of ours answers
  501 until the server has installed v4 (by itself).
- **Read back.** The field is read before and after the text (before Return, so a form that's sent doesn't hide it):
  `check: {match, expected_len, value_len, secure}`. `match` is exact on an empty or cleared field; with text already
  there the length must grow by exactly the text, which must be inside. `null` when the field couldn't be read. A
  secure field (a password field, or text that is only bullets) gives its length only; anything else adds `value`
  (at most 200 characters). Typed text and secure values are never logged.

### The PC keyboard (2026-11-24)

`src/keys.ts`. The owner's PC keyboard types on the phone he's looking at. Both routes are his only (`owner: true`, else
400), count as his touch (Lotus pauses on that phone), take one turn in the phone's queue with every other input, and
answer within 20 s (`pending: true` and a `note` while a long text is still being typed). What's typed or copied is
never logged, kept or put in an error. `GET /api/settings` says `keyboard: true` on a server that has them;
`stats.input.methods.keys` says per phone `full`, or `text` (text, Return, Backspace and Tab only) while the phone runs
our WebDriverAgent before v5.

- **`POST /keyboard`**: `ops` in order. `{text}`, or `{key, mods, n}`: `key` is `enter`, `backspace`, `delete` (forward),
  `tab`, `escape`, `left`, `right`, `up`, `down`, `home`, `end`, `pageup`, `pagedown`, `space` or one character; `mods` of
  `cmd`, `shift`, `alt`, `ctrl`; `n` 1-100. `home`/`end` are the line's start and end (Cmd+Left/Right), never the Home
  button. Text, Return and Backspace next to each other go as one `/wda/keys` request (40 keys a second). Plain keys are
  HID keypresses (nothing asked of the app in front); shortcuts go through WDA's `keyboardInput`, and while the app in
  front doesn't answer accessibility (TikTok's feed) through our build's `/lotus/keys` (v5), which doesn't ask it
  (`WDA_KEYS=record`: always). Each is sent once: a failed one stops the rest. 501 where the phone's build can't yet.
- **`POST /clipboard`**: `copy` and `cut` press Cmd+C / Cmd+X on the phone. iOS gives a background app no pasteboard, and
  bringing WebDriverAgent to the front would take the owner's app away, so the phone's clipboard is never read. The
  text comes from the focused field when it can be read: `how: "field"` with `text` (a cut: what went missing from the
  field; a copy: the whole field, `exact: true` when it was all selected by Cmd+A right before, else `exact: false`, since
  iOS doesn't say what's selected). Otherwise `how: "phone-only"` with `why` (no field, a password field, nothing
  selected...). `paste` with `text` (at most 10,000) types it at 60 keys a second (`how: "typed"`, in a password field
  too; a newline is Return); without `text` it presses Cmd+V (`how: "phone"`).
- **A password field's text is never read**; its length stays on the Mac.

### Files onto a phone (2026-11-24)

`src/files.ts` (uploads, the queue), `src/phonefiles.ts` (the phone's side), `src/mockfiles.ts`. Photos and videos go into
the phone's **Photos** byte for byte with their own date; everything else, and whole folders, into **Files > On My
iPhone > Lotus**. Nothing is converted, overwritten, deleted, shared or posted. Needs our WebDriverAgent v6 on the phone
(it installs itself). `GET /api/settings` says `files: true` on a server that has it. Why this way:
`research/lotus-app/phones-send-ios.md` in Lotus's folder.

**What the owner does once per phone**
- After v6 is on it, the first photo or video makes the phone ask *"Lotus" would like to add to your Photos*. Tap
  **Allow** there (the live view will do). The control app comes to the front for that one question and the phone then
  goes to its Home Screen. Nothing else ever brings it to the front. Until it's answered photos wait (3 minutes, then
  they fail with why and can be sent again); other files go on. If it was refused: Settings > Privacy & Security >
  Photos > Lotus > Add Photos Only.
- Nothing for Files. The folder shows in Files after the first file. It belongs to the control app (now named "Lotus"
  on the Home Screen): **deleting that app from the phone deletes the files in it**, so move what should stay. While
  a phone is back on the stock WebDriverAgent the folder is hidden, not gone.

**Routes** (`/phones/:udid/files/…` and `/api/devices/:udid/files/…`, the same token; every answer has `ok`)
- `GET can` -> `{ok, photos: {ok, why?, ask?}, files: {ok, why?, folder}, away?, maxBytes, freeBytes?, chunk}`. Photos and
  Files each stand on their own. `photos.ask`: it works, and the phone's prompt comes with the first photo (`why` says
  so). `away`: the phone can't be asked now; a send to it waits. `maxBytes`: the most one send (batch) may be;
  `roomBytes`: what the Mac's disk takes right now.
- `POST uploads` `{name, rel?, size, mtime? (ms), to: "auto"|"photos"|"files", batch?, key}` -> `{id, state, offset, size,
  sent, chunk}`. **`rel` is the whole path with the folder's own name first** (`Trip/day 1/a.jpg`) and is what makes a
  file part of a folder; a file on its own has none. The same `key` gives the unfinished upload, and a finished one only
  to the batch that sent it. 400 a bad name (`..`, absolute, `\`, `:`, control characters, over 255 bytes a part or 32
  deep; never says the name), 415 `{can: false}` the phone can't take it and why, 413 the send is too large, 507
  the Mac (`roomBytes`; more once files landed) or the phone (`freeBytes`) is too full. A failed or cancelled one sent
  again in its batch is replaced by the new one.
- `PUT uploads/:id?offset=N` raw bytes, at most `chunk` (4 MB) -> `{offset, size}`. 409 `{offset}` at another place, 400
  `{offset}` when the piece broke off: go on from there.
- `POST uploads/:id/finish` `{sha256}` -> the upload's state. 409 `{offset}` not whole, 422 `{offset: 0}` not the file.
- `POST folder` `{rel, batch?}`: an empty folder, in its turn.
- `GET uploads/:id` -> `{id, state, offset, size, sent, landed?: {where, path?}, why?}`; `why` also on a `done` one that
  went to Files instead of Photos, and on a `queued` one that waits. `GET uploads?batch=` -> `{batch, now, count, counts,
  uploads}`; `&brief=1` without `uploads`, `&after=<now of an earlier answer>` only those that changed since.
- An unknown upload is a 404 with `error: "unknown upload"`.
- `DELETE uploads/:id`, `DELETE uploads?batch=` (`{batch, cancelled, landed: {photos, files}}`): what landed stays. One
  being put in its place right now is waited for (at most 20 s) and said.

A batch's top folder gets a free name once ("Trip (2)") and all of it goes there; any other taken name gets " (2)".
Files wait in `data/sends` (0700, 0600) until landed, cancelled or a day old; 5 GB of the Mac's disk stays free; an upload
that's over is kept a day for questions about it, with no name on disk (after a restart `landed` has no `path`); names and contents are never logged. The phone checks the SHA-256 too. One file at a
time per phone, in 1 MB pieces on connections of its own (routes off WebDriverAgent's main queue, never in the phone's
request lane): a piece waits for a touch of the last 250 ms (2 s at most) and goes at 8 MB/s while the phone is watched.
A phone that goes away, a restarted runner or server: it goes on from where the phone has it.

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
- **Silent phones (2026-11-18, `PHONE_SILENT`, on by default)**: the phones never make a sound (they sit where people
  live). The raise above is **off** while silent (whatever `AUDIO_PHONE_VOLUME` says; its default is now 0), the
  `volumeUp` key is refused (403), and each phone's volume is pressed all the way down (17 presses of WDA's volume-down,
  presses that never restart WDA) every time its WebDriverAgent comes up (a start, a restart, a rebuild) and after a
  wake (at most every 10 minutes). The sound still reaches the live view as the capture gives it. What the server
  can't reach (keyboard clicks, the lock sound, haptics, the Ring/Silent switch) is set on the phones once, in Settings:
  see "Phone settings for silence" below.
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
makes a new session, restarts the phone's WDA runner only if `/status` stays unanswered (see
[Restarts](#restarts-only-when-wda-is-really-dead-2026-11-18)), and retries the action once (never one that timed out).
Every ~10 s each idle phone gets a `/status` check that recovers the same way before anyone notices (a phone on show has its session
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
   the slot `n` per UDID is remembered in `data/ports.json`), restarts WDA with backoff if it dies (at most 4 attempts, then "control down"), and stops it when the phone is unplugged.
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

**Once, after the 2026-11-27 update:** the plist now has `AbandonProcessGroup` (so launchd doesn't kill the WDA
runners with the server when it restarts for an update). launchd reads a plist only when it's loaded, and the
auto-update can't reload it, so copy it and reload it by hand once (keep your edited paths):

```
cp deploy/com.lotus.phonefarm.plist ~/Library/LaunchAgents/   # then put your WorkingDirectory / log / node paths back
launchctl unload ~/Library/LaunchAgents/com.lotus.phonefarm.plist
launchctl load ~/Library/LaunchAgents/com.lotus.phonefarm.plist
launchctl print gui/$(id -u)/com.lotus.phonefarm | grep -i abandon   # should say it's set
```
Until then the server works as before, only a server restart still takes the runners with it.
### Auto-update

The Mac sits behind a home router, so nothing outside can trigger an update: the server checks GitHub itself (outbound only) every `AUTO_UPDATE_SECONDS` (default 10, `0` disables; mock mode never updates) with a tiny `git ls-remote origin refs/heads/main`. As soon as main's commit differs from `HEAD` it force-updates: `git fetch`, `git checkout -f -B main origin/main` (a hard reset: local edits and local commits on the Mac are dropped; untracked/ignored files like `.env` stay), `npm install` (only if package files changed), `npm run build`, then exits so launchd (`KeepAlive`) starts the new build. If install or build fails it resets back to the previous commit and rebuilds it, so the running server and `dist/` stay on the working version; the failure goes to `server.log` (`[updater]` lines) and `GET /update/status` (`lastError`, `failedCommit`), and the poller won't retry that commit until a newer one is pushed. `.env` is never read or printed by it. The old `AUTO_UPDATE_MINUTES` is ignored (only `AUTO_UPDATE_MINUTES=0` still turns updates off).

**Update now (manual):** `curl -X POST -H "Authorization: Bearer $API_TOKEN" http://localhost:8787/update/now` runs the same force-update immediately (and retries a commit whose build failed before).

It relies on the launchd service above, so install that first: `cp deploy/com.lotus.phonefarm.plist ~/Library/LaunchAgents/`, edit the paths, `launchctl load ~/Library/LaunchAgents/com.lotus.phonefarm.plist`. To update by hand anyway: `git pull && npm run build` and kickstart:

After `git pull`/code changes run `npm run build` and `launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`.

## Testing

**The gate (2026-11-27):** `npm run regress` runs the type-check, every suite file below (one row each) and every bug
class in `test/regress/` (one test per past bug, on fake phones through the public API; nothing contacts a real phone);
it exits non-zero on any FAIL. `npm run regress:classes` runs only the classes, `npx tsx test/regress/run.ts --only
<id>,<id>` a few. See [docs/regression.md](docs/regression.md).

**The soak:** `npm run soak -- --hours 4 --phones iPhone-1,iPhone-2` runs for hours against a real running server (on
the Mac, as a viewer: reads, Home, TikTok or Instagram, vertical scrolls, the live view; never a tap, a post or a like)
and gives input and read p95, picture age, freezes, restarts and every stall with its recovery; `npm run soak --
--dry-run` checks the tool in 20 s against a mock server. See [docs/soak.md](docs/soak.md).

`npm run check` type-checks. `npm test` runs `test/h264.ts` (helper framing, config-before-key, latest-only drop to keyframe,
helper restarts, offer/RTCP parsing, WebRTC's keyframe unit, RTP clock and pacer queue), `test/input.ts` (live touch straight to the phone and its fallbacks, the HID sidecar's
protocol, the WDA patch, latency metering, acks' `via`/`ms`), `test/orient.ts` (upright -> device mapping in all four orientations, units, the capture check, orientation in the list, hellos and on change), `test/touch.ts` (order, coalescing, acks, auto-release, wake first, fallbacks with a reason), `test/ui.ts` (UI tree flattening, the element finder, apps by name, `/ui`, `/tap-element`, `/type`, `/key`, `/launch`, `/act`, reports and verify), `test/info.ts` (the detail card: the battery / IORegistry / WDA parsers, the ~15 s cache, `GET /info`, `info` in the list, WDA's quiet read), `test/connect.ts` (a capture warmed ahead and kept warm, a keyframe at once on join, `connectMs` and `first-frame`, `POST /warm`), `test/reliability.ts` (an expired WDA session remade on a 4xx, never a stale UI tree, the settle wait and ids from a changed screen, a playing gesture holding the next action, HID inputs that time out or break off, HID reconnect), `test/heal.ts` (a fake WDA that expires its session, hangs or dies and an iproxy that exits, all healed and counted; a hung action's 504, bursts spaced, the probe before the first action after idle, wake-on-touch; units; `POST /focus`, `focused`, `percent` and `info` pushed), `test/restart.ts` (WDA restarted only when it's really dead: a slow call restarts nothing, three unanswered asks of `/status` do; a 503 at once during a restart; a recover joins it; 4 attempts backed off, then "control down"; a recover or WDA answering brings it back), `test/lane.ts` (one request at a time per phone: a touch first, a late answer holding the lane, stale reads dropped, background reads skipped, a slow still or a still's 500 never recovering or restarting anything, `/status` past the lane), `test/stall.ts` (run from it: the server never reads the app in front on its own; Lotus's own reads bounded, refused while the app doesn't answer, never in a touch's way; a dead runner said at once and restarted in seconds), `test/tiktok.ts` (2 minutes end to end with TikTok in front: the owner's touches, the card and the list; 0 failed touches, 0 reads of the app, 0 restarts; `TIKTOK_MS` shortens it), `test/rtc.ts` (WebRTC in mock mode with a node-datachannel client: signaling, ICE,
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
Sound: `AUDIO` (true), `PHONE_SILENT` (true: never raised, volume-up refused, driven to 0 when WDA comes up and after a
wake), `AUDIO_PHONE_VOLUME` (0 %; only with `PHONE_SILENT=false`), `AUDIO_SYNC` (`0` = the sound in a
stream of its own, no lip sync).
`WDA_PATCH=0` makes `scripts/build-wda.sh` build WDA unpatched. WDA re-sign: `WDA_TEAM_ID` (the Apple Team ID),
`WDA_RESIGN` (true), `WDA_RESIGN_HOUR` (3: the quiet window is 03:00-06:00 local). Our own WebDriverAgent build:
`WDA_FORK` (true; `false` keeps the stock one), `WDA_FORK_BASE_PORT` (28100), `WDA_FORK_PORTS` (`udid=port,…`),
`WDA_FORK_DERIVED_DATA` (`~/wda-fork-build`), `WDA_LIVE_TOUCH` (`auto`: a held contact only when the phone's self-test
proved it from press to lift, else the owner's touch plays whole on release; `segmented`: also segmented drags, opt-in;
`off`. 2026-11-17: `on` is gone). Video: `RTC_PLAYOUT_ZERO=1` gives far viewers
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

## Phone settings for silence (set once on each phone, 2026-11-18)

The server keeps the media volume at 0, but these sounds and vibrations are the phone's own and only Settings stops them:

1. **Ring/Silent switch** (iPhone 13 / 14 have the side switch): to **Silent** (orange showing). Mutes ringer, alerts,
   lock sound and keyboard clicks.
2. **Settings > Sounds & Haptics**: Ringtone and Alert Volume slider all the way left; **Change with Buttons** off;
   **Keyboard Feedback**: Sound off, Haptic off; **Lock Sound** off; **System Haptics** off; **Haptics**: **Never Play**.
3. **Settings > Accessibility > Touch > Vibration**: off (no vibration of any kind, alerts and emergency included).
4. **Settings > Focus > Do Not Disturb**: on (always), so no notification sound or buzz gets through.

Screen and wake: with no passcode, the server wakes a dark phone itself (Home, Home) before a live view or an action;
a live view that gets no picture wakes it again after 2.5 s and 6.5 s and says why when it can't
(`rtc-error` "no picture: the phone's screen is off and could not be woken (...)").
