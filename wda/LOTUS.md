# Our own WebDriverAgent build

This folder is [appium/WebDriverAgent](https://github.com/appium/WebDriverAgent) at tag **v16.15.3** (commit
`02cb92f`), with our changes on top. Upstream's BSD licence is kept in `LICENSE`. Upstream's JavaScript tooling
(`lib/`, `test/`, `package.json`, CI files) is left out: only what the Xcode project builds from is here.

The phone-farm server builds, signs and installs it on each phone by itself (`src/fork.ts`, `scripts/build-wda.sh`
with `WDA_BUILD_FLAVOR=fork`). Nobody has to run anything by hand; see `docs/MAC_STEPS_2026-11-15b.md`, section
"Our own WebDriverAgent build".

## What we changed

Every change is marked `LOTUS` in the source. `LOTUS_FORK.json` holds the version of our changes; the server
installs this build on any phone whose build says another number, so **raise `version` there and
`LotusForkVersion` in `FBLotusCommands.inc` together** whenever the sources here change (`npm test` checks that
they agree).

| File | Change |
|---|---|
| `WebDriverAgentLib/Routing/FBHTTPServer.m` | **Token.** Every request must carry `X-Lotus-Token`, the secret the build was launched with (`LOTUS_WDA_TOKEN` in its environment). It's checked as soon as the headers are read, before the body or any route, by comparing SHA-256 digests without an early exit. Without it (or with a wrong one, or a request that can't be parsed) the answer is a bare `404` with no body and none of WDA's headers or JSON, and the connection is closed. With no token set at launch nothing is served at all. **Routes.** Only the routes the server uses are looked up (`LotusRouteAllowed`); every other one answers "unknown command". |
| `WebDriverAgentLib/Routing/FBWebServer.m` | The MJPEG server is never started; its code is gone. |
| `WebDriverAgentLib/Utilities/FBMjpegServer.{h,m}` | Deleted, and taken out of `WebDriverAgent.xcodeproj`. Nothing ever listens on 9100. |
| `WebDriverAgentLib/Commands/FBLotusCommands.inc` | New. Our routes (below). Included by `FBCustomCommands.m`, so it needs no entry in the Xcode project. |
| `WebDriverAgentLib/Commands/FBCustomCommands.m` | One line: the include. v7: `/wda/activeAppInfo` without the accessibility hit test (below), unless `LOTUS_APP_HIT_TEST=1`. |
| `WebDriverAgentLib/Commands/FBLotusFiles.inc` | New, v6: the files routes, included at the end of `FBLotusCommands.inc`. Photos, AVFoundation and ImageIO link by themselves (modules). |
| `WebDriverAgentLib/Routing/FBWebServer.m` (v6) | `/lotus/files/put` gets the request's raw bytes, and no files request is ever in the verbose log. |
| the runner's `Info.plist` (v6) | Not a source: Xcode makes the runner app itself. The repo's `scripts/lotus-runner-plist.sh` (run by `build-wda.sh` after each fork build) adds `NSPhotoLibraryAddUsageDescription`, `UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace` and the name "Lotus", and signs the app again as `embed-runner-icon.sh` does. When that fails the runner is left as Xcode made it: all else works and `can` says why Photos and Files don't. |

The port is not a source change: upstream reads `USE_PORT`. The server gives each phone its own high port
(28100 + the phone's index by default) and forwards the same number on the Mac.

## Our routes

| Route | What |
|---|---|
| `GET /lotus/info` | `{lotus: <version>, upstream, mjpeg: false}`. How the server tells this build from a stock one. Answers off the main queue, so it's quick whatever the phone is doing. |
| `POST /lotus/gesture` | `{points: [[x, y, ms], …], hold, orientation: 1}`. One whole gesture in one command, built at absolute coordinates (no lookup of the app in front), answered when queued. The phone plays all of it itself, so a natural swipe's curve stays smooth whatever the link to the Mac does. |
| `POST /lotus/touch` | `{phase: "down" \| "move" \| "up", x, y, mode, orientation: 1}`. One event of a live touch: the finger stays down on the phone between requests. See below. |
| `GET /lotus/shot?scale=&quality=` | One still as a JPEG (`{jpeg: <base64>}`). What the server and the phone agent look at; this build has no MJPEG stream. |
| `POST /lotus/selftest` | Finds out on the phone itself which way of holding a finger down works. See below. |
| `POST /lotus/field` | v4 (2026-11-18). `{clear: bool}` -> `{found, secure, len, value?, method?, cleared?}`: the field with the keyboard (the app in front's element with keyboard focus). With `clear` it's emptied in one go first, each way only while the field still holds something: the keyboard's Clear key (one HID keypress), then Cmd+A (`typeKey`, Xcode 15+) and one Delete, then a triple tap and one Delete; never a Delete per letter. A secure field (`XCUIElementTypeSecureTextField`, or text that is only bullets) gives its length only, and always gets the Cmd+A step (a web view's password field can read empty when it isn't). Waits for a gesture still playing first. The server reads the field before and after `type` with it (README, "Typing"). Not compiled where it was written: the Mac's build is the check (a failed build keeps v3 running, and the server then answers a clear with 501). |
| `POST /lotus/keys` | v5 (2026-11-24). `{keys: [{usage, n} \| {key, modifierFlags, n}]}` -> `{played}`: the owner's keyboard. `usage`: a HID keypress of the keyboard page; `key`: a character or an XCUIKeyboardKey name with XCUIKeyModifierFlags, as an event record of its own (no lookup of the app in front). v5 also serves upstream's `/session/:id/wda/element/0/keyboardInput` (element 0 only), the server's first choice for shortcuts. **To see on the Mac:** it compiles; Ctrl+A, C, X, V and arrows on the Phones page act in Notes and in TikTok's comment box. A failed build keeps v4 running, and the server then answers shortcuts with 501. |

| `GET /lotus/beat?wait=` | v7 (2026-11-27). The main queue's heartbeat (docs/root-cause.md P3). Standalone (off the main queue): it sends a no-op to the main queue and waits for it at most `wait` ms (50-30000, 5000 by default). `{lotus, main, mainMs \| pendingMs, waitedMs, capabilities}`: `main` whether the no-op ran, `mainMs` its wait on the main queue, else `pendingMs` how long it has waited so far. One no-op of ours waits there at a time, so a hung main queue never fills up. With `/status` (the process) it tells busy, hung and dead apart. `capabilities`: `{beat, shotTiming, appHitTest, offMainGesture}` (also in `/lotus/info`). |
| `GET /lotus/shot` (v7) | Also `{ms, takeMs, waited, mainBusy}`: the route's own time, the screenshot call's (through testmanagerd), `waited` when that took over 250 ms, and `mainBusy` when a no-op sent to the main queue as the shot began hadn't run by its end (the shot came while a read held the main queue). |
| `POST /lotus/gesture/offmain?n=` | v7 **experiment**, off unless the runner is launched with `LOTUS_OFFMAIN_GESTURE=1` (else `unsupported operation`). The body of `/lotus/gesture`, given to XCTest from a private serial queue instead of the main queue, answered once XCTest calls back: `{completed, played, ms, error?}`. `n` must differ per request (identical standalone requests in flight share one answer). Never mixed with `/lotus/gesture`'s queue. The question it answers: may `synthesizeEvent:` be called off the main queue while a `/source` hangs there (root cause §12)? |
| `GET /wda/activeAppInfo` (v7) | No accessibility hit test: the system's list of active apps (testmanagerd's bundle id per pid, at most 1 s each), the most recent first: `{pid, bundleId, name: bundleId, processArguments: {}, hitTest: false, candidates}`. `LOTUS_APP_HIT_TEST=1` brings upstream's way back (it held the main queue for minutes in TikTok, e8e390e). |
| `GET /lotus/files/can`, `POST /lotus/files/{ask,begin,put,land,dir,drop}` | v6 (2026-11-24), `FBLotusFiles.inc`: files from the PC. `begin`, `put` (raw bytes, `?id=&offset=`) and `drop` keep an unfinished file in the runner's own tmp; `land` checks size and SHA-256, then adds it to Photos (PhotoKit, add-only, `shouldMoveFile`, the file's own bytes) or moves it into the runner's Documents, which Files shows as "Lotus", under a free name. Standalone (off the main queue) but `ask`, which brings the runner to the front once for iOS's Photos prompt and goes Home after the answer. Nothing is read from the library, logged, shared or overwritten. |

### Live touch and its self-test

XCTest plays whole event records. A finger that stays down across requests is made of several: a record that
presses and doesn't lift, records that start where the finger is and move it on, and one that lifts. Whether the
contact survives between two records is up to XCTest, and there are three ways to ask for it (`mode`): 1 the
records simply don't lift; 2 the press sets `beginsPersistentState` and the lift `endsPersistentState`; 3 as 2,
with `beginsPersistentState` on every move too.

None of that could be tried where this was written, so the phone finds out itself. `POST /lotus/selftest` brings
the WebDriverAgent app to the front, puts a window of its own over the screen, plays press / move / lift into it
for each mode and watches what the window receives. A mode works when the window sees one touch: it begins once,
moves without ending, and ends once at the lift. The server runs the self-test right after it installs the build,
keeps the mode it found (`data/wda-fork.json`), and sends it with every live event. If no mode works, or the
self-test hasn't run, the server doesn't use `/lotus/touch` at all: a drag is then played whole on release, as with
a stock WebDriverAgent. A finger nobody has said anything about for 10 s is lifted by the phone.

**v2 (2026-11-17): segmented drags.** On both phones (iOS 18.5 and 18.7.8) v1's self-test found no mode: XCTest
plays each `XCSynthesizedEventRecord` as a complete event stream and ends every finger still down when the record
ends (`beginsPersistentState` doesn't change that), so no finger can be held between requests through XCTest; and
iPhone-1 saw no touch at all because it was locked while the test ran. v2's self-test still tries modes 1-3 (a
future iOS may keep the contact), then **mode 4, segmented**: two short whole gestures, the second starting where
the first ended, must each reach the window as a complete touch. The server then sends a drag as it happens as
short whole gestures through `/lotus/gesture` (`src/segments.ts`: one once it has lasted 70 ms and moved 10 pt,
still 30 ms before its lift so nothing flings, paced to what the phone can play), never `/lotus/touch`. A tap or a
long press still goes whole; what segmented can't do is carry one contact through a whole drag (a long press that
turns into a drag lifts after its first segment). The answer now has `modes: [{mode, works, why}]`, every mode's
result. The server wakes and unlocks the phone first and checks it's awake (WDA's lock state and a look at the
screen), tries once more when it found nothing, runs it after each install and on demand
(`POST /api/wda/:udid/selftest`; since 2026-11-17 it's started and answered at once, `202 { started, running, since,
live }`, and what it finds shows in `GET /api/wda`), and never when Lotus's page merely opens.

**v3 (2026-11-17): gapped segments, mode 5.** On v2, iPhone-2 (iOS 18.7.8) passed mode 4, but iPhone-1 (iOS 18.5)
gave `'BMMMMMMMME'`, 48 pt, 811 ms: one touch of one segment's length (60 pt less a frame; a merge of both would be
about 110 pt), so one of the two back-to-back segments never reached the window, and a record without a lift
(modes 1-3: press `''`, move `''`) plays nothing at all there. v3:
- `/lotus/gesture` takes `gap` (0-500 ms): the phone's queue, which already plays one record at a time and each only
  after XCTest's completion of the one before, stays busy that long after the gesture before the next record.
- The self-test runs mode 4 (two segments back to back, each its own record and path at offset 0) and then mode 5
  (the same with a pause of 40, then 100, then 200 ms, stopping at the first that works). Each run says what the
  window saw (`seen`), its `gapMs`, and in the notes the first segment's letters and each segment's time.
- The server recounts `seen` as separate begin..end pairs (`countTouches` in `src/fork.ts`) and picks the mode
  itself: a hold mode, else 4, else 5 with its smallest working gap (kept as `live.gapMs`). In mode 5 every segment
  is sent with that `gap` and the pacing (`src/segments.ts`) counts it. Mode 4 sends no `gap`: iPhone-2 is unchanged.

**2026-11-17, settled: segmented drags off by default (server only, no new build).** Segmented drags were the
regression: since v2 (`d86e36f`) and v3 (`6d4266e`) the owner's live touch on a phone whose self-test passed mode 4 or
5 went through the segmenter, so every quick swipe was cut into a segment that stood still 30 ms before its lift (no
flick on either phone), and on iPhone-1 a held drag could be left without its lift. The server now uses a found mode
only when it's a hold mode (1-3, proven from press to lift; never on iOS 18); otherwise the owner's touch is buffered
and played whole on release through `/lotus/gesture`: one record that ends in a lift, the same body the stock era sent
to `/wda/lotus/touch` (tap, quick swipe, long press, held drag). `"liveTouch": "segmented"` turns segmented drags back
on (and even then nothing is cut in a touch's first 350 ms, so a quick swipe stays whole). `GET /api/wda` says the mode
in use per phone as `fork.perDevice.<udid>.liveUsed` (0: whole on release). The v3 build on the phones is unchanged.

## What has to be seen on the Mac

This was written on a PC with no Xcode. The additions were parsed with clang's Objective-C front end against
stand-in headers (syntax and names: `python scripts/objc-check/check.py .` and `check2.py .`, which need
`pip install libclang`), not compiled against the iOS SDK, and never run. The first automatic build on the Mac is
the real check:

1. **It compiles.** If not, the phones stay on the stock WebDriverAgent and `GET /api/wda` says the compiler's
   first error under `fork.perDevice.<udid>.reason`.
2. **The token gate.** `curl -i http://127.0.0.1:<port>/status` on the Mac must show a bare `404` with
   `Content-Length: 0`; with `-H "X-Lotus-Token: …"` (the server has it) it answers.
3. **The self-test.** `fork.perDevice.<udid>.live` in `GET /api/wda` says the mode it found (v2: 4, `kind:
   "segmented"`, unless a hold mode works), each mode's result under `modes`, and its notes (for mode 4 the two
   segments' touches, e.g. `'BMMEBMME'`, and how long both took to play: about 250-400 ms is fine). v3: iPhone-2
   should still say mode 4; iPhone-1 mode 5 with `gapMs` 40, 100 or 200 (each run's `seen` under `modes`).
4. **A live drag** on the Phones page follows the pointer while the button is down (with mode 4, a few segments a
   second, each about 100-150 ms behind the pointer); a list scrolls without flinging between segments.

5. **v6, files.** It compiles; the build log ends with "the runner has Photos and Files"; the runner still installs
   and answers; `GET /phones/:udid/files/can` says both `ok` (Photos with `ask`). One photo: the prompt shows "Lotus",
   Allow, the photo is in Photos with its date. A video, a PDF and a folder. A re-sign (reinstall) keeps the folder's
   files. A drag while a 2 GB file is on its way is as quick as before. A photo sent while the phone is locked.

6. **v7, the beat and the experiments.** It compiles; `GET /lotus/beat` answers `main: true` with a `mainMs` of a few
   ms on the Home Screen, and `main: false` with a growing `pendingMs` while a `/source` of TikTok is in flight (then
   `main: true` again once it ends, never two no-ops waiting); `GET /lotus/shot` carries `takeMs` and `mainBusy`
   (time 50 shots with TikTok in front, with and without a `/source` in flight: root cause §12); `/wda/activeAppInfo`
   answers `hitTest: false` with TikTok's bundle id first while TikTok is in front (if SpringBoard comes first, say
   so: the order of the system's list is the open question). With `"offMainGesture": true` pushed (or
   `WDA_OFFMAIN_GESTURE=on` in .env) and the runner restarted: `POST /lotus/gesture/offmain?n=1` with a tap's body
   answers `completed`/`played`, and a tap sent that way while a `/source` hangs lands at once (the experiment);
   a crash of the runner there means XCTest refuses it off the main queue: turn it off again.

## Turning it off from afar

The Mac pulls this repo by itself, so `LOTUS_FORK.json` is also a switch that needs nobody at the Mac. Push a
commit that changes it:

| In `LOTUS_FORK.json` | What happens when the Mac has pulled it |
|---|---|
| `"enabled": false` | Every phone goes back to the stock WebDriverAgent (the server restarts on the pull and starts each runner as stock). `true` again installs ours again. |
| `"liveTouch": "off"` | Our build stays, but live touch through it is not used: a drag is played whole on release. `"auto"` uses it again (with the mode the self-test found). |
| `"liveTouch": "segmented"` | Also uses a segmented finding (modes 4-5) for the owner's drags. Off by default since 2026-11-17 (below). |
| `"appHitTest": true` | v7: `/wda/activeAppInfo` runs upstream's accessibility hit test again (`LOTUS_APP_HIT_TEST=1` at each runner's next start). `WDA_APP_HIT_TEST=off` in .env wins. |
| `"offMainGesture": true` | v7: serves the `/lotus/gesture/offmain` experiment (`LOTUS_OFFMAIN_GESTURE=1` at each runner's next start). `WDA_OFFMAIN_GESTURE=off` in .env wins. |

## Updating to a newer upstream

Replace the upstream folders with the new tag's, re-apply the `LOTUS` changes (the table above is all of them),
update `LOTUS_FORK.json` (`version`, `upstream`, `upstreamCommit`) and the two constants in `FBLotusCommands.inc`,
and run `npm test`.
