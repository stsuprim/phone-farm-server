# Root cause: why the phone farm keeps breaking (2026-11-27)

Stage 1 only: evidence and causes, no patch. Written on the PC from the code at `329ba10` (this repo), its
git history, the WebDriverAgent fork in `wda/`, phonecap (`native/phonecap/main.swift`), Lotus's client
(`source/modules/phones/ui/phones.js`, its CLAUDE.md), `cache/fable/phones-drag-report.md` and the Lotus decision
log. **Nothing was run, and there were no Mac logs.** Everything marked *(hypothesis)* needs the Mac. Section 12
lists those points, and the log line or experiment that would settle each one.

A correction to today's framing first. iPhone-1's agent did not "fall back" to WDA screenshots because the
capture was off. Since `cfb1be2` (2026-11-16), **every** look the agent takes is a WDA still, by design, whether the
capture runs or not (`src/stills.ts:6-14`, `src/real.ts:580-602`, `src/real.ts:958-961`). The capture is never
used for it, because iOS tells apps when the screen is captured (`UIScreen.isCaptured`).

---

## 1. Summary: six causes, nine fixes, one pattern

Every fix since 2026-11-13 changed **when, how often, or how long the server waits for** a request to the phone.
None changed **what the phone channel is asked to carry**. These are the true causes:

| # | Root cause | Where |
|---|---|---|
| R1 | **One serial channel carries everything, and the foreground app sets its speed.** The owner's touches, the agent's eyes (stills, UI trees), power (locked?, dark?, unlock, Home), sessions, self-tests and the Photos prompt all go through WDA. WDA runs every route but `/status`, `/screenshot`, `/lotus/shot` and `/lotus/info` on the phone's **one main queue**. Stills go through testmanagerd behind the accessibility reads. TikTok and Instagram never go idle, so a read of them takes seconds to minutes. The Mac can order its own side; it can't pre-empt or cancel work that's already on the phone. | `wda/WebDriverAgentLib/Routing/FBWebServer.m:71`, `FBHTTPServer.m:789-818`, `FBLotusCommands.inc:155-161` |
| R2 | **Health is guessed from timeouts on that same channel.** The only liveness signal, `/status`, answers *off* the main queue. So "busy", "main queue hung for good" and "process gone" can't be told apart. The server swung from restarting too eagerly (to 11-21) to never restarting a hung main queue (after 11-21). There is no main-queue heartbeat. | `src/wda.ts:2077-2112`, `:2120-2205` |
| R3 | **Destructive actions are taken on inferred state.** A wake presses Home **twice** when the screen "can't be looked at" (a busy WDA) and `force` is set. That happens on every live-view open whose capture has no picture after 2.5 s. The "app in front" is the server's own memory of its last command, not an observation. | `src/dark.ts:149-161`, `src/rtc.ts:294,414-423`, `src/server.ts:1106`, `src/wda.ts:1023-1028,1631-1644` |
| R4 | **The video has no truth about its own age or health.** Only the first frame is watched. A re-encoded old frame is stamped "captured now". Congestion control reads 127 ms of jitter as queueing. Capture start, open, idle stop and add race each other on fixed timers. | `main.swift:60-67,1495-1501`, `src/h264.ts:418-457`, `src/rtc.ts:67-85`, `src/congestion.ts:316-344` |
| R5 | **Lifecycles are coupled to the Node process.** Every pushed commit restarts the server within ~10 s, and that tears down every phone's WDA runner and capture (`src/real.ts:1158`), whatever is running: a live view, a posting hand, a self-test. Restarting runners is the very thing that jams XCTest (`src/lane.ts:11`, `0f60be5`). | `src/updater.ts:68-126`, `src/index.ts:39,139-150`, `deploy/com.lotus.phonefarm.plist:23` |
| R6 | **Live touch is a platform limit, not a bug.** On iOS 18, XCTest ends every finger at the end of each event record. The HID path that would give a live finger needs iOS 27. The phones run 18.5 and 18.7.8. | `wda/LOTUS.md` "v2", `src/fork.ts:130-145`, `src/real.ts:665-672` |

A seventh cause runs through all of them: **the verification gap.** Every fix was "proven" by a test whose fake
phone encodes that day's hypothesis. In `test/tiktok.ts:9-15,37-40,145-160`, for example, stills answer instantly and
there's a 10 s iOS watchdog. Nothing was measured on the real phones, and the Objective-C of fork v4-v6 was never
compiled where it was written (`wda/LOTUS.md`). So a green test only showed the code agreed with the guess.

Timeouts are also spread over five layers that don't nest:
- the client: wake 30 s, order queue 1.5 s / 8, 3 strikes then a 4 s pause;
- Rust: 4 s reads;
- `Control`: wake 30 s, heal 20 s, check 5 s;
- the lane: 8 s wait;
- the request: its own timeout plus a 60 s hold.

A request can be abandoned by its caller at one layer while it still occupies a lower one.

---

## 2. WDA stalls ("no answer within 80 s to POST /wda/unlock")

**Symptoms.** Touches come back "busy" or "no answer within 5 s". Wakes and unlocks time out. The control state
flips between `ready`, `busy`, `recovering` and `restarting`. Today, iPhone-1 while a posting hand drove it.

**True cause.**
1. *The 80 s is arithmetic, not a coincidence.* `wdaPower(… '/wda/unlock', 20000)` (`src/real.ts:1063`) is a
   20 s timeout. After it, `exchange()` keeps the request open for `HOLD_MS` = 60 s (`src/wda.ts:346, 580-590`). With
   no answer by then, `onStuck(80 s)` fires and logs "no answer within 80.0 s to POST /wda/unlock, not even late:
   checking WebDriverAgent" (`src/wda.ts:1661-1673`). So the phone's main queue gave nothing back for at least
   80 s.
2. *What the agent puts on that queue.* Every agent action is look → act → settle → look (`src/agent.ts:371-440`):
   - The look and the settle are 2 to 5 WDA stills: `frameHash` → `stillHash` → `/lotus/shot` on our build
     (`src/real.ts:584-590, 958-961`).
   - `ui()`, `tap-element` and `verify` add a `/source` tree, `/wda/activeAppInfo` and the orientation. These are
     explicit reads of the app in front, allowed under 12 s / 3 s bounds (`src/wda.ts:388`, `:2661-2690`).
   - In TikTok or Instagram each tree is an accessibility snapshot taken *inside the app*.
   - Every still holds the lane until the phone answers, up to 60 s (`src/wda.ts:1647`). **A still does not
     yield** (only an app-bound read does, `src/wda.ts:1652`).
   - So the agent's stream of looks keeps the lane permanently taken. Touches and unlocks wait 8 s
     (`LANE_WAIT_MS`), then get dropped as "busy" (`src/lane.ts:139-147`).
3. *A wake adds work on the busy phone.* Before any discrete action after 25 s without input (`AWAKE_FOR_MS`,
   `src/idle.ts:30`), `Control.run` does two things inside the phone's queue (`src/control.ts:739-751`):
   - it probes WDA (`onHeal`);
   - it asks "locked?" (`/wda/locked`), then "dark?" (a 5 s PNG screenshot), then `/wda/unlock` (`src/idle.ts:100-140`,
     `src/real.ts:1026-1045, 1075-1090`).
   A posting hand pauses for uploads and typing, so it crosses 25 s often. Each crossing puts more requests on the
   same busy phone.
4. *What held the main queue the full 80 s can't be told from here.* Candidates:
   - a request whose 60 s hold ran out: the lane is freed, yet the phone still works on it, so the next request
     lands behind it;
   - XCTest's own `pressButton` and lock-state waits inside `fb_unlockScreen`;
   - an accessibility read into the app.
   *(hypothesis; settle with the `[wda]` lines and the lane's `inFlight` around that time in server.log)*

**Why earlier fixes didn't hold.**
- `cfb1be2` and `edf2be3` raised the bar for "dead" (3 misses over 15 s, then 4 `/status` asks). That's a
  threshold: the concurrency stayed.
- `7cd29d7` serialised the Mac's side (the lane). That was right, but the phone's side stays serial *and slow*, so
  the lane only turned timeouts into "busy".
- `c221b93` and `e8e390e` stopped the **server's own** background reads of the app. The agent's explicit reads and
  every still remain, and those are exactly what a posting hand sends.
- `e8e390e`'s "touches go beside a yielding read" (`src/lane.ts:19-23, 221-227`) can't work on a real phone:
  `/lotus/gesture` and `/lotus/touch` are **not** standalone (`FBLotusCommands.inc:156-157`) and run on the main
  queue (`FBWebServer.m:71`). The touch sent "beside" waits on the phone behind the same read. The test that
  passed (`test/tiktok.ts`) sends no app reads at all.

**Invariant that makes it impossible.**
- No request may enter the phone's main queue unless it can be the *only* thing there, within a known budget.
- Looks never share the input channel's turn. The phone's real queue state is observed (a main-queue
  heartbeat), not inferred from the Mac's timers.
- Power actions never run as a side effect of an input.

## 3. Capture and phonecap stalls

**Symptoms.** "Connecting" forever after a replug (11-23). "No picture". A capture that runs but gives nothing.

**True cause.**
- **Liveness is checked only up to the first frame.**
  - phonecap exits 9 when there's no frame 5 s after `startRunning` (`main.swift:60-67, 1269-1274`).
  - The server ends a capture with no keyframe 20 s (device wait) or 8 s (after "capturing") in
    (`src/h264.ts:364-368, 601-618`).
  - After the first frame nothing watches. Both sides assume silence means a still screen (`main.swift:63-66`,
    `src/h264.ts:357-361`). A CoreMediaIO session that dies mid-stream runs on forever, and so does one whose
    phone re-enumerated (`src/presence.ts:6-10`).
- **The open timeout is shorter than a cold start.** phonecap may take 12 s to find the device plus 5 s for the
  first frame (`main.swift:67,82`). `open()` gives up at 8 s (`src/h264.ts:366, 418-446`). The rejection arms the
  2.5 s idle stop (`CAPTURE_GRACE_MS`, `src/real.ts:49,469`), and the client's retries back off 0/1/2/4/8 s
  (`phones-live.js:158`). Any retry later than 2.5 s starts cold again, so a slow cold start can never finish. Idle
  stops don't count as failures, so this never reaches the 60 s give-up either.
- **The idle timer can fire before the track opens.** On a warm source `open()` arms `maybeIdle`
  (`src/h264.ts:421-424`). The viewer is only `add()`ed once ICE and DTLS are up (`src/rtc.ts:498-500, 678-698`).
  That's often over 2.5 s at 185 ms RTT, so the source stops and `add()` restarts it cold (`src/h264.ts:455`).
- **A stop then an immediate start can overlap.** `kill()` drops `proc` at once, but SIGKILL only follows 1.5 s
  later (`src/lanes.ts:328-335`). A new `open()` can spawn a second phonecap on a screen device the first one still
  holds. *(hypothesis: a likely exit 9)*
- **A locked phone gives no frames until it's unlocked once** (`src/idle.ts:216-221`), and the unlock needs WDA.
  After a replug WDA takes 1-2 minutes, so `fffd0c1`'s restarts use up their 3 tries and trigger the 60 s give-up
  while waiting for something no restart can fix (`src/h264.ts:730-738`).
- A lane re-added during an audio hold keeps its encoder, so no keyframe comes (`src/lanes.ts:142, 196-213`,
  `main.swift:1543`).

**Why earlier fixes didn't hold.** `fffd0c1` added two watchdogs and a backoff. Those are timeouts on the first
frame. They don't ask *why* there's no frame (locked, still enumerating, device held by a dying process), and they
leave everything after the first frame unwatched. `cfb1be2` made the capture strictly viewer-scoped with a 2.5 s
grace. That's a policy, but its grace is the timer behind both open races above.

**Invariant.** The capture is a state machine owned by one object. Its liveness comes from a heartbeat from the
helper: the session is running, plus frames handed over and frames encoded per second. A still screen and a dead
session are then different states. An open waits on *state*, not on a fixed 8 s. A stop completes, process exited,
before any start. "No frames because the phone is locked" is a state of its own that waits for the unlock instead
of burning retries.

## 4. Live view "Couldn't open"

**Symptoms.** Lotus says "Couldn't open: the phone didn't answer in time" (or a server reason) when the owner opens
a phone.

**True cause.** On the client, "Couldn't open" is **the wake failing, not the picture.**
- `openOne` waits up to `OPEN_MS` = 30 s for `phones_wake` before any picture is asked for
  (`phones.js:76, 792-818`). Picture failures show as "No picture" instead (agent report, `phones.js:608`).
- `phones_wake` → `POST /phones/:udid/wake` (`src/server.ts:793-798`) → `idle.wake` → `RealBackend.unlock`
  (`src/real.ts:1050-1066`). That call:
  - first waits up to 15 s for WDA to be "ready";
  - then `/wda/locked` (5 s timeout, plus lane wait, plus hold);
  - then `/wda/unlock` (20 s), then up to two dark checks (5 s screenshots);
  - and the whole thing is serialised behind any other wake or lock of that phone (`src/idle.ts` `serial`).
- On a phone whose WDA is busy (a posting hand, TikTok in front) or restarting, that easily runs past 30 s.
- The server's own wake after a replug waits up to 150 s (`PICTURE_WAKE_WAIT_MS`, `src/idle.ts:34`), five times the
  client's limit.

So **opening the picture depends on the control plane**, which is the plane that's busy.

The remaining server-side ways an open fails:
- no keyframe in 8 s;
- ICE not connected in 20 s, or disconnected for 15 s (`src/rtc.ts:289-291`);
- host candidates only, so no relay (`src/rtc.ts:18,425`);
- all 8 lanes busy (`src/lanes.ts:141`);
- phonecap exit codes 2-9 (`main.swift:34-38`).

**Why earlier fixes didn't hold.** `abec0c2` and `e8e390e` made the wake wait longer for WDA, and Lotus 11-26 made
the open always wake first. Both tightened the coupling instead of removing it.

**Invariant.** Opening a live view needs only USB capture and WebRTC. A wake is a separate, optional action that
can't fail the open. A dark or locked screen is shown as such, from the capture itself.

## 5. Video freezes over far links (iPhone-2: 22 freezes of about 7 s; RTT about 185 ms, jitter about 127 ms)

**True cause (strongest first).**
1. **Jitter is read as congestion.** The queue estimate is the latest RTCP RTT minus the lowest of the last 30 s
   (`src/congestion.ts:316-344`). RTP interarrival jitter is never read (`src/congestion.ts:279-291`). With 127 ms of
   jitter, typical samples sit more than 150 ms above the 30 s minimum. That's the remote `cut` mark
   (`src/rtc.ts:130-133`), so the bitrate is cut every 2 s (`DELAY_HOLD_MS`). It only climbs below 50 ms
   (`clear`), which a jittery path rarely reaches. It ratchets down to the 400 kbps floor, and the far lane drops to
   12 fps (`src/h264.ts:129-132, 495-498`).
2. **Keyframes on a starved link.** At the floor, a 1400 px IDR is a large burst against the 64 KB (or 1.5× key)
   drop threshold (`src/h264.ts:188-222`). Dropped deltas mean waiting for a key (PLI at most every 500 ms; far
   lanes' periodic key every 10 s, `src/congestion.ts:31`). *(hypothesis: a drop → key → drop loop)*
3. **A "freeze" may not be a freeze.** A still screen sends no frames (assumed everywhere, `main.swift:63-66`).
   Chrome's `freezeCount` counts any gap over 3× the average frame interval. The client's heal ladder swaps decoders
   at 2 s and rebuilds at 6 s (`REBUILD_S`, `phones-live.js:155`), which comes out at about 7 s per freeze.
   *(can't tell these apart without the client's heal counts and the server's lane fps during each freeze)*

**Why earlier fixes didn't hold.** `e86d204`, `0ea1cbb` and `1ad607c` built congestion control with fixed
thresholds tuned for a quiet path. `2f7f2e0` (SPS/PPS before every IDR) was a real fix for another freeze. The
client's 11-24 software decode fixed a third kind, the GPU decoder. Each freeze kind had its own fix, and nothing
measures which kind a freeze is.

**Invariant.**
- The delay signal is jitter-aware: a trend over a smoothed window, with a threshold that scales with measured
  jitter, so a variance never becomes a cut.
- Frame rate, resolution and bitrate floors are chosen per link class.
- Every freeze the client counts is labelled by cause (no source frames / dropped / decoder / transport), from
  server-sent frame ages.

## 6. A stale frame (an old TikTok picture while the server said "Home Screen")

**True cause.** Two independent inferences, neither observed:
- **The picture lies about its age.**
  - phonecap's `requestKey` re-encodes the *last* buffer stamped `captured: nowMs()` when no frame came for 30 ms
    (`main.swift:1495-1501`; `setLane` and `setRotation` do the same, `:1382-1391, 1543`).
  - The server primes a new viewer with its cached keyframe, however old, when no deltas followed it
    (`src/h264.ts:456-457`).
  - `RtpClock` restamps anything older than 500 ms as just captured (`src/rtc.ts:67-85`).
  - So a capture that stopped delivering answers every PLI with a "fresh" keyframe of an old screen. It also
    resets `lastFrameAt` (`src/rtc.ts:764`), which hides the stall from `stalled()`.
  - Going from TikTok to Home changes the screen and would have produced deltas, so the capture had most likely
    stalled. *(hypothesis; check phonecap's kind-4 stats records, `main.swift:840-850`)*
- **"Home Screen" is the server's memory of its own Home press.** That memory is set on any 2xx of
  `/wda/homescreen` or `pressButton home` (`src/wda.ts:1631-1634`, `setApp` at `:1023-1028`). One such press comes
  from the wake logic: an rtc-offer with no picture after 2.5 s and 6.5 s (`src/rtc.ts:294, 414-423`;
  `src/server.ts:1106`) calls `wakeForPicture(force=true)`. When the screen "can't be looked at" (`dark()` is null:
  WDA too busy for a 5 s screenshot), `wakeScreen` **presses Home twice** (`src/dark.ts:149-161`, the condition at
  `:152`).
- So a slow capture start on a busy phone can send a posting hand's TikTok to the Home Screen. The server then
  believes "Home" while the stale picture shows TikTok. *(hypothesis; settle with server.log `[wake …] the live view
  has no picture and the screen could not be looked at: pressing Home`)*

**Why earlier fixes didn't hold.** `dfb0700` (the restamp) fixed browser playout timing but erased freshness end to
end. `e8e390e` replaced reading the app with remembering it. That's correct for the load, but it made the app state
a guess.

**Invariant.**
- Every frame carries its true source capture time and a `repeat` flag. The client sees the picture's age and
  shows it once it's over about 1 s.
- App and screen state are either observed (with the observation's time) or "unknown".
- No input is ever sent from an inference. A Home press only goes out as an action someone asked for.

## 7. TikTok and Instagram freezing on the phone

**Symptoms.** The app itself stutters or freezes on iPhone-1 and iPhone-2 while it's driven.

**True cause *(probable; needs Instruments on the Mac)*.**
- An XCTest accessibility snapshot (`/source`, element queries, `activeAppInfo`'s hit test) runs *inside the target
  app*, on its main thread, building the accessibility tree of a huge, constantly changing feed. WDA's 4 s
  `accessibilityDeadline` (`src/wda.ts:369`) bounds how long XCTest **waits**, not the work the app does or
  repeats.
- The agent asks for trees often: `UI_FRESH_MS` is 1 s (`src/agent.ts:18`), and every `tap-element` and `verify` adds
  more (`src/agent.ts:445-505`).
- Two side causes:
  - the capture starting and stopping changes `UIScreen.isCaptured`, which apps are told about, and apps may react
    (pause, overlay);
  - starting the capture re-enumerates the phone on USB (`src/presence.ts:6-10`).

**Why earlier fixes didn't hold.** `c221b93` and `e8e390e` cut the server's own reads of the app. The agent's reads
are explicit and still allowed. They're the ones a posting hand uses most.

**Invariant.** The app in front is never read through accessibility in a loop. Trees are asked for only when the
picture changed since the last tree, at most one in flight, with a per-phone budget (for example ≤1 per 3 s while a
video app is in front). Prefer reading the picture: OCR or vision on a still the agent already has.

## 8. Touch and swipe failures

**True cause.**
- **Touches wait behind on-phone work** (R1, §2): a still or a tree holds the main queue or testmanagerd. The
  "beside" path can't jump it on the phone (`FBLotusCommands.inc:156`, `FBWebServer.m:71`).
- **Layered drops.** The client's order queue waits 1.5 s for at most 8 (`phones.js:2273`). The lane drops a touch
  after 8 s (`src/wda.ts:347`). After 3 failures the client pauses 4 s (`phones.js:630-651`). Each layer drops
  independently, and none knows the others' budget.
- **Work inserted before a touch.** After 25 s of quiet, a probe and a lock/dark check run in front of it
  (`src/control.ts:739-751`, `src/idle.ts:100-140`).
- **Coordinates from a guessed orientation.** Since `e8e390e` the orientation comes only from the live picture's
  shape (`noteFrame`, `src/wda.ts:997`). With the capture off (an agent alone) it's the last known value.
  *(risk: a rotated app gets mis-mapped taps; not seen in the evidence)*
- **Segmented drags** (`d86e36f`, `6d4266e`) cut flicks and lost lifts. They were turned off on 11-17 (`8bf520d`,
  `src/fork.ts:130-145`), but remain as an opt-in.

**Why earlier fixes didn't hold.** `914bcfc`, `75e5012`, `4dbc983` and `6250c2a` tuned gesture shape and timing.
Correct, but the failures were about *getting a turn*, not the gesture's shape.

**Invariant.** An input has its own channel to the phone that no look or power action can occupy. If WDA can't
offer one, input gets a reserved slot: a look may only start when no input arrived in the last N ms and none is
queued, and it must be cancellable on the phone (bounded by the fork itself). One deadline travels with each
input from the client down to the phone, and a layer that can't meet it says so at once.

## 9. Live touch off

**True cause.**
- XCTest plays each `XCSynthesizedEventRecord` as a complete event stream and ends every finger still down when the
  record ends. `beginsPersistentState` doesn't change that on iOS 18.5 or 18.7.8 (`wda/LOTUS.md` "v2").
- So a finger can't be held across requests through WDA. The self-test found no hold mode on either phone.
  `usableLiveMode` therefore uses 0 (whole on release) unless segmented is asked for (`src/fork.ts:141-145`).
- The HID path (`native/hid/hid_input.py`) is real live touch but needs iOS 27 (`src/real.ts:669`,
  `docs/BEST_METHOD.md:198`).
- The client removed its live finger stream on 11-17 (`phones.js:2034`).

**Why "fixes" didn't hold.** Fork v1-v3 tried hold modes and then segments. Hold modes can't work on iOS 18;
segments trade flick and lift correctness for a laggy live drag.

**Invariant (a decision, not code).** Live touch exists only where the platform gives a held contact (HID, iOS 27).
Elsewhere drags are whole-on-release by contract, and the UI says so. Updating the phones to iOS 27 can't be
undone: it's the owner's (and Rinor's) call.

## 10. Restart loops

**History of the cause.**
- To 11-18: a timeout on a busy WDA counted as death. Restarts piled runners and forwards onto the phone until
  XCTest jammed (`0f60be5`).
- 11-21: concurrency on the Mac side (`7cd29d7`).
- 11-21: a USB re-enumeration taken as an unplug (`54977f4`).
- 11-22: an `activeAppInfo` hit test hung the main queue, then the runner's process went (ECONNRESET), then a
  restart (`e8e390e`). Whether iOS killed it (a watchdog) or XCTest ended the session is unverified: the 10 s
  watchdog exists only in the fake (`test/tiktok.ts:37-38`).

**What still loops today.**
- A process that dies (ECONNRESET) is restarted within about 6 s (`CONN_PROBE_EVERY_MS`, `src/wda.ts:392`). Good,
  but if what killed it, an app read or a still, is asked again right after, the loop is back.
- A **hung main queue with a live process** is the opposite failure, and it's now silent. `/status` answers, so
  `confirmDead` returns "alive" (`src/wda.ts:2096-2100`). The session check times out and is treated as "busy"
  (`src/wda.ts:2154-2160`). "Recovered" is logged while every main-queue request keeps failing. Nothing restarts
  it, ever.
- Each restart attempt can reset the device link and end in "needs replug" (`src/wda.ts:2229-2240`): a manual step
  hiding behind automation.

**Why fixes didn't hold.** Each moved the line between "busy" and "dead" on a signal that can't separate them (R2).

**Invariant.** Liveness has two independent signals:
- the process: `/status`;
- the main queue: a no-op route *on* the main queue, timed.

The state follows from both: Ready, Busy(op, since), Hung (main queue silent over H with the process up), Dead.
Only Dead, or Hung past a long bound with nothing of ours still on the phone, restarts. A restart never starts
while another runner for the farm is starting, and never more than k per hour per phone.

## 11. Restarts caused by the updater, re-signing and the fork

**True cause.**
- The updater polls GitHub every 10 s (`src/updater.ts:159-165`). On any new commit it force-checks-out, builds and
  calls `shutdown(0)` within 0.5 s (`:123-125`), with no check of what the phones are doing.
- Shutdown calls `backend.close()` → `wda.shutdown()`. That deletes every session and kills every runner and
  capture (`src/real.ts:1151-1159`, `src/wda.ts:3193-3202`). launchd restarts the server 10 s later
  (`deploy/com.lotus.phonefarm.plist:23-27`). Each runner then relaunches through `xcodebuild` one phone at a time
  (`SPAWN_HOLD_MS`, `src/wda.ts:331`), and the WDA sessions and the capture's 1-2 minute warm-up start over.
- On a busy development day (15 commits on 11-16, 9 on 11-17) that's a farm-wide restart every few minutes. A push
  of `wda/` with a new fork version also reinstalls and re-runs the self-test, which puts WDA's own window over the
  screen (`wda/LOTUS.md`).
- The re-signer waits only for live viewers (`src/resign.ts:88`), not for an agent's hand. The fork installer's
  `busy` check covers viewers and 2 minutes of activity (`src/index.ts:101-104`).
- **Which commit the Mac runs isn't known from here.** HANDOFF and the decision log say `c691b99` and the 11-24
  keyboard and files commits were "local only". Fork v4-v6 Objective-C was never compiled on a Mac before
  shipping. A failed fork build silently keeps the older build (`wda/LOTUS.md` "What has to be seen on the Mac").

**Why fixes didn't hold.** `cecf435` (force-update every 10 s) was a deployment convenience. Every reliability fix
since then has shipped through the mechanism that restarts everything.

**Invariant.**
- A server (code) restart never restarts a WDA runner or a capture. The device layer outlives the API layer, or
  is adopted by it on start (runner pid, port and token persisted).
- Updates are debounced (for example 2 min after the last push) and applied only when no lease is held (no viewer,
  no hand, no self-test), or at a set quiet hour.
- Re-signing, fork installs and self-tests take the same gate.

---

## 12. What I could not determine without the Mac (and how to settle each)

| Unknown | Settle it with |
|---|---|
| What held iPhone-1's main queue for 80 s around `/wda/unlock` | server.log `[wda]` lines and the lane's `inFlight` (stats `controlLink.wda`) at that time; the runner's xcodebuild tail (`lastRunnerEnd`) |
| Whether `/lotus/shot` (XCUIScreen through testmanagerd) really waits behind accessibility reads, and its latency in TikTok/Instagram | time 50 shots with TikTok in front, with and without a `/source` in flight |
| Whether XCTest's `eventSynthesizer synthesizeEvent:` may be called off the main queue (it would let touches bypass a stuck read) | a fork experiment route; watch the touch arrive while `/source` hangs |
| Whether iOS kills a runner whose main thread is blocked (e8e390e's claim) or XCTest ends the session | Console.app / `log collect` on the phone around an ECONNRESET |
| Whether iOS screen capture sends no frames on a still screen; why CoreMediaIO sessions go silent mid-stream | phonecap kind-4 stats over a still screen; a long run with a dying session |
| Whether two phonecaps collide on one screen device | phonecap exit lines with pids, timed against the kill |
| What iPhone-2's 22 freezes were (idle gaps, a client rebuild, loss, the bitrate floor) | the client's heal counts and `framesReceived` per freeze; the server's lane fps and bitrate per second |
| Whether the Home presses of §6 happened today | grep server.log for `pressing Home` and `[rtc] … waking the phone` |
| Whether TikTok/Instagram freeze from accessibility snapshots | Instruments Time Profiler on the app during `/source` |
| Whether TikTok/Instagram react to `UIScreen.isCaptured` (decides whether the agent may see the capture) | a short trial with the capture on during a hand |
| Which server commit and fork version each phone actually runs | `GET /health` (`commit`), `GET /api/wda` (`fork.perDevice.*.version`, `reason`) |
| Whether `/wda/unlock`'s `fb_unlockScreen` waits on SpringBoard accessibility | upstream source at v16.15.3 plus a timed call with TikTok in front |

---

## 13. Target architecture

### 13.1 Principles (each closes a root cause)

- **P1 (R1) Planes.** Video (USB capture → encoder → WebRTC), Input (touches, keys, typing), Look (stills, trees)
  and Power (lock, wake) are separate. Video never depends on WDA. Input never waits behind a Look or a Power
  action. Look is cancellable and budgeted.
- **P2 (R1) One owner per phone at a time: a lease.** `owner` (a live view with input), `hand:<id>` (an agent),
  `system:<op>` (resign, fork install, self-test, update). The owner pre-empts a hand (the hand pauses, as
  agent.ts already does). System work waits for no lease, or a quiet hour.
- **P3 (R2) Observed health.** Two signals per phone: the process (`/status`) and the main queue (new fork route
  `GET /lotus/beat`, run *on* the main queue, timed). One state machine owns them.
- **P4 (R3) No action from inference.** Home, wake and unlock go out only as explicit actions, or on an observed
  dark or locked screen. App and screen state carry `observedAt` or are `unknown`.
- **P5 (R4) Honest video.** Source capture time and a `repeat` flag on every frame, a phonecap heartbeat, a capture
  state machine, and jitter-aware congestion control.
- **P6 (R5) Lifecycles split.** The device layer (runners, forwards, phonecap) survives API restarts: spawned
  detached and adopted on start through `data/runners.json` (pid, port, token, flavor). The updater is lease-gated
  and debounced.
- **P7 One deadline.** Every request carries `deadlineAt` from the client inward. Each layer refuses at once what it
  can't finish in time, and nothing is "held" after its caller left without the state saying so.
- **P8 Verify against reality.** A trace recorder on the Mac (every WDA request: queued, sent, answered; capture
  heartbeats; freezes). Tests replay recorded traces instead of hand-written fakes.

### 13.2 Modules and who owns what

| Module (new or carved file) | Owns | Never does |
|---|---|---|
| `src/device/runner.ts` | xcodebuild runner, iproxy forwards, adopt/reap, `data/runners.json`, farm-wide spawn turn | HTTP to WDA, health decisions |
| `src/device/link.ts` | **ControlLink** state machine (13.3a), `/status` + `/lotus/beat` probes, restart policy and rate limit | queue user requests |
| `src/device/wdaclient.ts` | `exchange()`, token, the per-phone **lane** (from `lane.ts`), deadlines; the request journal (what is on the phone now) | decide dead/alive |
| `src/phone/actor.ts` | the per-phone **actor**: one queue of typed commands (`input`, `look`, `power`, `system`) with deadlines; the **lease** (13.3c); the input reservation | talk to sockets or HTTP routes |
| `src/phone/look.ts` | `frame(maxAgeMs)` and `tree()`: single-flight, coalesced, budgeted; picture source chosen by policy (WDA still, or capture frame where the owner allows) | send input; read the app on its own |
| `src/phone/power.ts` (from `idle.ts` + `dark.ts`) | **Power** state from observations (13.3d), idle lock, explicit wake | press Home or unlock on inference; run inside an input's turn |
| `src/capture/source.ts` (from `h264.ts`) + `src/capture/host.ts` (from `lanes.ts`) + `native/phonecap` | **Capture** state machine (13.3b), heartbeat, true frame times, lanes | wake the phone; call WDA |
| `src/transport/rtc.ts` + `src/transport/cc.ts` | WebRTC sessions, a jitter-aware delay controller, frame age to the client | stop or start captures (asks `capture` for a viewer handle) |
| `src/agent.ts` | the AI action API on top of the actor (look → act → settle), with a look budget | its own WDA calls |
| `src/control.ts` | message validation and mapping (points, orientation), gestures and the human-like path | queueing (moves to the actor), heal or wake |
| `src/ops/updater.ts`, `src/ops/lifecycle.ts`, `src/resign.ts`, `src/fork.ts` | updates, re-sign, fork install, self-test: all as `system:` leases | shut the device layer down |
| `src/server.ts` | routes, auth, the WS and RTC signalling; maps state to the client's contract | business logic |
| `src/trace.ts` | the request/frame/freeze journal (ring buffer + `GET /trace`), no secrets | — |

### 13.3 State machines

**a. ControlLink (per phone, `device/link.ts`)**
```
Absent ──usb──▶ Starting ──/status ok + /lotus/beat ok──▶ Ready
Ready ──request on phone > B_busy──▶ Busy(op, since) ──answered──▶ Ready
Busy ──beat silent > H while /status ok──▶ Hung(since)
Hung ──beat ok──▶ Ready
Hung ──silent > H_max (90 s) and journal empty──▶ Restarting(n)
Any ──/status refused or reset ×3 over 6 s──▶ Dead ──▶ Restarting(n)
Restarting ──up──▶ Ready | ──fails, n < N──▶ Restarting(n+1) after backoff | ──n = N──▶ NeedsReplug
Any ──usb gone 3 polls / 10 s──▶ Absent
```
Restarts are capped per hour per phone, and none happens while another runner is Starting.

**b. Capture (per phone, `capture/source.ts`)**
```
Off ──viewer──▶ Finding(device, ≤12 s) ──▶ Starting(first frame)
Starting ──frame──▶ Live ⇄ Still   (Still = heartbeat ok, no new source frames)
Starting ──no frame and Power=Locked──▶ WaitingUnlock (no retries burned)
Live|Still ──heartbeat missing 3 s──▶ Stale ──▶ Restarting(backoff) ──▶ Finding
Restarting ×3 ──▶ GaveUp(until)
last viewer leaves ──grace──▶ Stopping ──process exited──▶ Off   (no start while Stopping)
```
An `open()` resolves on Live, Still or WaitingUnlock (it tells the viewer which), never on a timer.

**c. Lease (per phone, `phone/actor.ts`)**
```
Free ──open with input──▶ Owner ; Free ──hand──▶ Hand(id) ; Free ──system op──▶ System(op)
Hand ──owner input──▶ Owner (the hand Paused until quiet 5 s) ──▶ Hand
Owner|Hand ──release or idle T──▶ Free ; System waits for Free (or a quiet hour, never pre-empts)
```

**d. Power (per phone, `phone/power.ts`)**
```
Unknown ──observed frame (capture or still) not black──▶ Awake(observedAt)
Unknown ──/wda/locked=true──▶ Locked ; ──observed black──▶ Dark
Awake ──observedAt older than 25 s──▶ Unknown   (Unknown means no Home press)
Dark|Locked ──explicit wake──▶ Waking ──observed──▶ Awake | stays Locked (passcode)
```

**e. Updater (`ops/updater.ts`)**
```
Idle ──new commit──▶ Pending(debounce 2 min) ──▶ Building ──ok──▶ Ready
Ready ──all leases Free (or quiet hour)──▶ Restarting the API only (the device layer stays up)
```

### 13.4 Fork changes (wda/, v7)

1. `GET /lotus/beat`: dispatches onto the main queue and answers. Its latency is the main queue's latency.
2. An experiment route: play a gesture from a private serial queue, not main. If XCTest allows it, `/lotus/gesture`
   becomes standalone. Touches then never wait behind a stuck read. **This is the single highest-value experiment.**
3. Bound `activeAppInfo` without an accessibility hit test, or drop its use (the app is known from the agent's
   own launches). An experiment, since the alternatives are private APIs.
4. `/lotus/shot` reports its own duration and whether testmanagerd waited.

### 13.5 Ordered work breakdown (file groups, no overlap)

**Wave 0. Serial, before anything else (one agent each).**

| Group | Files | Work | Done when |
|---|---|---|---|
| W0-a Trace | `src/trace.ts` (new); hook calls in `src/wda.ts` `exchange`/`request`, `src/h264.ts` (records), `src/rtc.ts` (freeze stats); `scripts/collect-trace.sh` (new) | the journal and `GET /trace`, no behaviour change | runs on the Mac for a day of normal use; the §12 questions answered from it |
| W0-b Carve | `src/wda.ts` → `src/device/{runner,link,wdaclient}.ts`; `src/lane.ts` → `device/wdaclient.ts`; `src/real.ts` → `src/phone/{input,look,power}.ts` (thin); `src/h264.ts`/`src/lanes.ts` → `src/capture/{source,host}.ts`; `src/rtc.ts`/`src/congestion.ts` → `src/transport/`; interface file `src/phone/contracts.ts` | a **mechanical** split, no behaviour change, `npm test` green; freezes the interfaces that Wave 1 codes against | tests pass unchanged; one commit |

**Wave 1. In parallel (each group touches only its own files and its own tests).**

| Group | Files (exclusive) | Work |
|---|---|---|
| G1 Fork | `wda/**` | 13.4 items 1, 3 and 4; item 2 as a guarded experiment; `LOTUS_FORK.json` v7; built and checked on the Mac before rollout |
| G2 Control link and runners | `src/device/link.ts`, `src/device/runner.ts`, `test/link*.ts`, `test/restart.ts`, `test/usb.ts` | state machine 13.3a with `/lotus/beat` (stock WDA: `/wda/locked` as a stand-in beat); detached runners adopted from `data/runners.json`; restart rate cap |
| G3 Client and lane | `src/device/wdaclient.ts`, `test/lane.ts`, `test/stall.ts` | deadlines replace hold-after-timeout; a journal of what's on the phone; remove "beside"; an input reservation slot; looks lowest and single-flight |
| G4 Actor and lease | `src/phone/actor.ts` (new), `src/control.ts`, `test/input.ts`, `test/touch.ts`, `test/gestures.ts`, `test/owner.ts` | one typed queue per phone, leases 13.3c; `control.ts` keeps validation and mapping only; no heal or wake inside an input's turn |
| G5 Look and agent | `src/phone/look.ts`, `src/stills.ts`, `src/agent.ts`, `src/ui.ts`, `test/scripts.ts`, `test/features.ts` | `frame(maxAge)` and `tree()` coalesced and budgeted (≤1 tree per 3 s on a video app); the agent's settle uses one coalesced look; capture frames for the agent only behind an owner setting (the `isCaptured` question) |
| G6 Power | `src/phone/power.ts`, `src/idle.ts`, `src/dark.ts`, `test/dark.ts`, `test/unlock.ts` | 13.3d; no Home on `Unknown`; wake explicit only; the idle lock takes the `system` lease |
| G7 Capture | `native/phonecap/main.swift`, `src/capture/source.ts`, `src/capture/host.ts`, `test/h264.ts`, `test/capture.ts` | 13.3b; heartbeat record (1 s); the original capture time plus `repeat` on re-encodes; Stopping before Starting; WaitingUnlock; a lane re-add forces a key |
| G8 Transport | `src/transport/rtc.ts`, `src/transport/cc.ts`, `test/rtc.ts`, `test/congestion.ts` | jitter-aware delay estimate (smoothed percentile trend, threshold ≥ 2× jitter, read RTCP jitter); per-link floors; frame age and `repeat` to the client over the data channel; `stalled()` on true frame age |
| G9 Ops | `src/updater.ts`, `src/index.ts`, `src/lifecycle.ts`, `src/resign.ts`, `src/fork.ts`, `deploy/*.plist`, `test/fork.ts`, `test/longrun.ts` | 13.3e; shutdown leaves the device layer; re-sign, fork install and self-test as `system:` leases |
| G10 Replay harness | `test/harness/**` (new) | a fake phone driven by recorded W0-a traces (main queue, testmanagerd, capture); `test/tiktok.ts` rebuilt on it |

**Wave 2. Serial.**

| Group | Files | Work |
|---|---|---|
| W2-a Server and contract | `src/server.ts`, `src/types.ts`, `test/smoke.ts`, `test/connect.ts`, `test/info.ts`, `test/live.ts` | wire the modules; `POST /open` (picture only) apart from `POST /wake`; error states from the state machines; `deadlineAt` accepted |
| W2-b Lotus client (other repo: `source/modules/phones/`) | `phones.js`, `phones-live.js`, `src/lib.rs` | open never waits on wake; show picture age and the lease (who drives); one deadline per order; drop the strike pause for `busy` states (commit the uncommitted 11-22 diff or replace it) |
| W2-c On the Mac | none | the acceptance run below, against the trace |

**Acceptance on the Mac (all from the trace, not by eye).**
- A posting hand runs 30 minutes in TikTok and then Instagram, while the owner taps every few seconds. Results
  needed:
  - 0 runner restarts;
  - 0 Home presses not asked for;
  - p95 input wait under 300 ms;
  - no input dropped as busy;
  - the main-queue beat p95 noted.
- The live view opens over Tailscale at 185 ms RTT with simulated 127 ms jitter. Results needed:
  - picture age shown;
  - bitrate never at the floor for more than 10 s without loss;
  - every freeze labelled by cause.
- 5 pushes in 10 minutes cause 0 runner or capture restarts.
- A replug gives `WaitingUnlock`, then a picture after one explicit wake, with no give-up.

Effort and order, roughly: W0 first (the trace decides which of G1 item 2 and G5's capture setting are worth
doing). G1, G2 and G7 carry the most risk and need the Mac. G3, G4, G6, G8, G9 and G10 can be written on the PC
against W0-b's interfaces.
