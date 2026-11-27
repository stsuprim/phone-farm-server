# Integrator (2026-11-27)

The four workers' parts are wired into one server. The 9 pending regression classes pass for real (no pending marks
left in `test/regress/manifest.json`), and the three stale suites now assert the new behaviour. Gate: `npx tsc --noEmit`
is clean and `npm run regress` passes (result in `.lotus/regress-run3.log`). Nothing was committed or pushed, and
nothing contacted a phone or a server.

## What was wired

- **Capture.**
  - `RealBackend` registers itself with `setCaptureBackend`.
  - Every `H264Source` gets `locked: () => seenLocked(udid)`, and the source is noted with `noteSource`.
  - `observe()` calls `noteUnlocked` when a phone is seen `on` after a non-on state.
  - `captureState(udid)` gives `{state, why, pictureAgeMs}`.
- **Agent.**
  - `setAgentSeesCapture` is wired to the optional setting `agentSeesCapture` (on when absent; `AGENT_SEES_CAPTURE=0` still turns it off).
  - `agent.close()` runs on the server's `close`.
  - Video apps: the app in front comes from what's known (our own launch, `wda.knownApp`), not an extra read. Snapshots ask the orientation without an accessibility read, and an in-flight tree read is joined.
- **Leases.**
  - The fork and re-sign `systemTurn` goes to `actors.of(udid).trySystem(op)` through `setSystemClaim`.
  - The updater's `setLeaseProbe` reads the actors' leases: `hand:<id>`, `system:<op>`, `owner` or busy. Otherwise it goes on viewers and activity in the last 2 minutes.
- **Close and stop.**
  - `RealBackend.close()` (the update's API shutdown) leaves the runners up: `shutdown(…, {keepRunners: true})`.
  - `stop()` ends them, used by `releaseDevices('stop')` for `SIGUSR2` and `STOP_DEVICES_ON_EXIT`.
  - `detach()` is the same as `close()`.
- **WDA's held queue** (`src/wda.ts`):
  - When the main queue still holds a request WDA never answered and hasn't moved for `HELD_STUCK_MS` (10 s), a new request is refused at once. The answer is a 503 `LaneBusy` `{state: 'busy', op, since, reason: 'held'}` naming the held op, and nothing is sent that could land late.
  - `unlock()` and `dark()` skip at once while the queue is stuck.
  - `control` says `recovering` while the oldest held main request isn't an app-bound read. A held read of the app in front stays `ready`, as `test/stall.ts` asks, because the app is at fault there, not WDA.
  - The time before hung counts from when the wire gave up on the held request, not from its longer deadline. So hung is said at about 25 s instead of 33 s.
- **The actor** (`src/phone/actor.ts`):
  - Looks bound to the app in front (`uiSource`, `activeApp`, an asked orientation) yield to the owner: they wait out the owner's quiet time.
  - A control socket's open reserves the phone for 1 s for the owner's first touch (`ownerOpened`). This applies only to app-bound looks and doesn't touch the lease.
- **The trace.** `src/trace.ts` is now the ring-buffer journal. The lane, the control link, the runners, the capture (`capture.state`, `capture.beat`), the freezes (`FreezeTracker`, and the client's `freeze`) and `open` all write to it.
- **`/health`** gives the build and the fork's version (`index.ts` reads `forkMeta.version`).
- **Test harness.** `test/harness/fakecapture.ts`'s `stop()` now returns a Promise that resolves on the fake process's exit, like the real producers'. `capture-stop-before-start` awaited it.

## Route additions (for the Lotus client spec)

All of them are additive. `control` still says only `ready`, `recovering` or `down`, and every old field is unchanged.

- **`GET /health`** (no auth) adds `build: {commit, startedAt}` and `forkVersion: number | null`.
- **`/phones` entries** (and `/api/devices`, `/api/status`'s `devices`) and each control-socket `{type: 'control'}` message add these fields:
  - `state`: `'ready' | 'busy' | 'hung' | 'restarting' | 'needs-replug' | 'down'`
  - `onPhone`: `{op: string, since: number, held: boolean} | null`, the oldest request on the phone
  - `lease`: `{kind: 'free'} | {kind: 'owner', since} | {kind: 'hand', id, since} | {kind: 'system', op, since}`
  - `capture`: `{state: 'Off'|'Finding'|'Starting'|'Live'|'Still'|'Stale'|'Restarting'|'GaveUp'|'WaitingUnlock'|'Stopping', why: string | null} | null`
  - `pictureAgeMs`: `number | null`

  The control message is pushed when `state`, `onPhone.op`, `lease.kind` or `capture.state` changes. Picture age and lease times don't push.
- **`POST /phones/:udid/open`** `{}`:
  - Answers 200 `{ok: true, udid, state, onPhone, lease, capture, pictureAgeMs, control, locked, screenOn, picture: 'starting' | 'stream', pictureWhy?, input}`.
  - Errors: 404 `unknown phone`, 503 `phone is offline`.
  - It holds the picture for 15 s and never wakes the phone or asks WDA anything. Waking stays `POST /wake`.
- **`GET /trace`** (also `/api/trace`):
  - Query: `?udid=&kind=a,b.,c&after=<seq>&since=<ms>&limit=<n ≤ 5000, default 500>`.
  - Answers `{ok: true, now, events: [{seq, at, kind, udid, data}], seq, kept, max: 20000, counts: {kind: n}}`, oldest first.
  - Kinds:
    - requests: `wda.queued|sent|answered|failed|abandoned|cancelled|refused|skipped|joined|dropped`
    - control link: `link.state`, `link.beat`
    - runners: `runner.spawn|adopt|exit|restart`
    - capture: `capture.state`, `capture.beat`
    - other: `freeze`, `open`
  - It holds no secrets: keys like token, text, body, value or clip are dropped.
- **`deadlineAt`** (ms since the epoch, optional) works in any action's body or query, and on `GET /ui?deadlineAt=`.
  - A request whose deadline leaves no time is refused unsent with 503 `{state: 'busy'}`.
  - `/ui`'s budget is `min(25 s, deadlineAt − now)`.
- **H.264 stream socket** (`?codec=h264`):
  - The server sends `{type: 'capture-state', udid, state, reason, capture_time, age_ms}` on every capture change.
  - It sends `{type: 'frame-age', udid, state, capture_time, age_ms}` every 1 s.
  - It takes `{type: 'freeze', ms?, why?}` from the viewer, which is journalled.
  - `stats` adds `frame_age_ms`.
- **Settings:** `agentSeesCapture?: boolean`.

## Test adjustments (and why)

- **`test/heal.ts`:**
  - No probe is sent before the first action or after a quiet spell.
  - A hung action gets a 504 with "look at the screen" and no heal.
  - No wake is put in front of a tap on a screen nobody has seen. Only a lock that was noted wakes first.
  - This is root cause §2, §6 and P4: no action from inference.
- **`test/drag.ts`:** no probe beside the press, and a WDA tap doesn't wait for a health check.
- **`test/screens.ts`:**
  - A dark screen nobody has seen gets no Home press.
  - `wakeForPicture` looks first and wakes only a phone seen locked, never forced.
- **`test/dark.ts` and `test/longrun.ts`:** both compared `/health` or the control message exactly. They now check the old fields as before, and that the new ones are present.
- **`test/harness/fakecapture.ts`:** `stop()` returns a Promise (see above). No regression test was weakened.

## Remaining (Mac only)

- **Reload the launchd plist once** for `AbandonProcessGroup`. It's in the README and in `RINOR_UPDATE_STEPS.md`'s new top block. Until then, a server restart still takes the runners with it.
- **Untested on real phones** (the soak, `npm run soak -- --hours 4`, settles them):
  - `HELD_STUCK_MS` (10 s);
  - the 1 s open reserve;
  - hung at about 25 s.
- **The other workers' Mac items still stand:** the fork v7 build and its install, phonecap's stop and start on hardware, and the quiet-hour checks in their reports.
- **Lotus's client** can now use `/open`, `state`, `onPhone` and `frame-age`. An old client keeps working without them.
