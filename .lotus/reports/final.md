# Phone farm rebuild: final report (2026-11-27)

Commit `5365e76` (local; pushed only after the owner OKs it, see Deploy).

## Root causes (full: docs/root-cause.md)
1. **One serial phone channel for everything.** Touches, the agent's looks, power actions and sessions share WDA's main queue; TikTok/Instagram make accessibility reads slow. A read in flight cannot be pre-empted by a touch on a real phone (`/lotus/gesture` runs on the main queue), so the 11-22 "touches beside a read" fix could never work. The 80 s on `/wda/unlock` was the 20 s timeout plus a 60 s hold.
2. **Health was guessed.** busy / hung / dead looked the same; a hung main queue was never restarted.
3. **Actions came from inference.** Home presses, wakes and unlocks went out on a guessed screen state (`dark.ts:152` could press Home twice); "app in front" was the server's memory of its own last command.
4. **Video could not tell its age or health.** Re-encoded old frames were stamped "now", only the first frame was watched, and 127 ms of jitter was read as congestion (bitrate collapse, freezes).
5. **Every push restarted every runner and capture.**
6. **Live touch off** is a platform limit (XCTest ends a finger at the end of every event record on iOS 18).
7. "Couldn't open" was the client's 30 s timeout on the WDA wake, not the picture.

## What was rebuilt
- Per-phone **actor + lease** (`src/phone/actor.ts`): one typed queue (input/look/power/system), owner pre-empts hand, system work waits for Free, deadlines refuse at once.
- **ControlLink state machine** (`wda.ts`): absent/starting/ready/busy/hung/dead/restarting/needs-replug from `/status` + main-queue beat; hung runners are restarted (rate-capped); detached runners adopted from `data/runners.json`.
- **Always-on capture** for reads: `acquireCapture`/`latestFrame`; agent reads never use WDA screenshots when a capture exists; looks budgeted (<=1 tree/3 s on video apps), single-flight.
- **Power from observation only**; no Home/unlock on a guess.
- **Honest, degrading video**: capture state machine + 1 s heartbeat, true capture time + repeat flag, jitter-aware congestion control (185 ms RTT / 127 ms jitter keeps >=1 Mbps; old controller fell to 400 kbps), frame age and freeze cause to the client.
- **Lease-gated updater** with a **pre-release gate**: build, `npm run regress`, restart only into a passing build, only when all leases are Free or at the quiet hour; API restarts leave runners up.
- **Fork v7**: `GET /lotus/beat`, `/lotus/shot` timing, `activeAppInfo` without the hit test, guarded off-main gesture experiment (off by default).
- **Regression suite** `npm run regress`: type-check + all suites + 24 bug classes (docs/regression.md); **soak driver** `npm run soak -- --hours 4` (docs/soak.md; never posts/likes/types into accounts).
- `GET /trace` journal.

State at commit: `tsc` clean; `npm run regress` 0 fail, 0 pending.

## Soak results
**Not run.** I cannot reach the Mac or the server token from here, and iPhone-1 was posting. Mock-mode dry run passes. To run on the Mac: `URL=http://localhost:8787 API_TOKEN=... npm run soak -- --hours 4 --phones iPhone-1,iPhone-2` (see docs/soak.md). Mac-only items that the soak settles: `HELD_STUCK_MS` 10 s, hung at ~25 s, 1 s open reserve, fork v7 build/install, phonecap Swift (never compiled here), detached xcodebuild surviving the server, iOS keeping capture alive on a still screen.

## Deploy
1. Push to `stsuprim/phone-farm-server` main (the Mac's old updater pulls it within ~10 s and restarts the server: only when no hand is posting).
2. Once on the Mac: `launchctl unload ~/Library/LaunchAgents/com.lotus.phonefarm.plist && launchctl load ...` (needed once for `AbandonProcessGroup`; RINOR_UPDATE_STEPS.md has the paste-able block). Fork v7 builds/installs itself one phone at a time when leases are Free.
3. Run the soak.

## Spec for Lotus's Phones client (all server additions are additive; the old client still works)
Files: `source/modules/phones/ui/phones.js`, `phones-live.js`, `src/lib.rs`.
1. **Open never waits on wake.** Use `POST /phones/:udid/open {}` (picture only; answers `{state,onPhone,lease,capture,pictureAgeMs,picture:'starting'|'stream',...}`, 404/503 on unknown/offline) instead of the wake-then-open path (`phones.js` ~76, 792-818: the 30 s timeout that shows "Couldn't open"). Wake only on an explicit Wake button (`POST /wake`).
2. **One deadline per order.** Send `deadlineAt` (ms epoch) in action bodies/query; show a 503 `{state:'busy'}` as "Busy: <onPhone.op>", not as an error, and do not start the strike pause for `busy`/`hung`/`recovering` states.
3. **Show the true state.** Read `state` (`ready|busy|hung|restarting|needs-replug|down`), `lease` (who drives: owner / hand id / system op), `capture.state`, `pictureAgeMs` from `/phones` and the control-socket `{type:'control'}` messages; show a small "picture 3.2 s old" chip when `pictureAgeMs` > 2000 and "Hand is driving" when `lease.kind=='hand'`.
4. **H.264 socket messages**: handle `capture-state {state,reason,age_ms}` (show "Waiting for unlock" on `WaitingUnlock`, "Reconnecting" on `Stale/Restarting`), `frame-age` (every 1 s; if `age_ms` > 3000 show the stale chip, not a frozen picture), and send `{type:'freeze', ms, why}` when the video element stalls so the server journals it (`GET /trace?kind=freeze`).
5. Keep the playout/jitter buffer adaptive on far links; do not reconnect on a freeze shorter than 10 s (the server degrades bitrate itself).
6. Commit or replace the uncommitted 11-22 diff in `phones.js` (the "beside" strike pause) with item 2.

## Hardware for real-time touch (docs/hardware-touch.md)
Recommended: one Seeed XIAO ESP32-S3 per phone as a Bluetooth HID mouse/keyboard (AssistiveTouch on), driven from the Mac mini over USB serial; new `src/esp.ts` behind the existing `liveTouch*` hooks.
- 2 phones: 3x XIAO ESP32-S3 ($7.49) $22.47 + 5-pack data cables ~$12 = **$34.47** (optional Lightning USB camera adapter -> $63.47).
- 10 phones: 11 boards $82.39 + 3 cable packs $36 + Anker 10-port hub $59.99 = **$178.38** (before shipping/tax).
- Caveat: not tested on iOS 18; absolute positioning and live drags over BLE come from community projects (iOS 26/27). Do a free spike first (Mac's own Bluetooth as the peripheral) on the iPhone 14 Plus.
