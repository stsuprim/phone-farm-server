# Regression tests: every past bug is a test (2026-11-27)

Every bug class in [root-cause.md](root-cause.md) §2-11, and the `fix:` commits behind them, has one named test in
`test/regress/`. Each one plays the bug on fake hardware through the server's **public** API, and asserts the
invariant that makes it impossible. The list is `test/regress/manifest.json`.

```
npm run regress            # the type-check, every file of the existing suite (one row each), then every class
npm run regress:classes    # only the classes (about 3 minutes, 3 at a time)
npx tsx test/regress/run.ts --only touches-never-wait-behind-read,unlock-not-held-80s
REGRESS_VERBOSE=1 ...      # print the server's last lines for every class, not only for failures
```

## Status words

| Status | Meaning |
|---|---|
| PASS | the class holds |
| FAIL | a fixed bug is back: `npm run regress` exits non-zero |
| PENDING | the class is marked `expectedAfterRebuild`: the behaviour comes with the rebuild (root-cause.md 13.5), so its failure is expected for now and doesn't fail the run |
| XPASS | a pending class now passes: take its `expectedAfterRebuild` mark off in `manifest.json`, so it guards from then on |

The runner also fails when a test file isn't in the manifest, or the manifest names a file that's missing, so a
class can't silently stop running.

## The harness (`test/harness/`)

| File | What |
|---|---|
| `fakephone.ts` | A fake phone: a WebDriverAgent-like HTTP server on a local port. Every route but `/status`, `/screenshot` and `/lotus/shot`/`/lotus/info` runs on **one main queue**, one at a time, whoever stopped waiting. Stills wait behind accessibility reads (testmanagerd). Options: per-route stalls (`stall`), a video app in front with slow or never-answered reads (`videoApp`, `appReadMs`), a hung main queue with `/status` up (`setHung`), a dead runner (`kill`, port closed) that `revive`s when xcodebuild starts, iOS's watchdog (`watchdogMs`), a locked or dark screen, unreadable stills. It journals every request with its queued/started/answered times, so tests assert on what the **phone** saw: `maxMainOpen` (our requests open on its main queue at once), `homePresses()`, `appReads()`, `touches()`, `since(t)`. |
| `farm.ts` | `startFarm()`: the real `createServer` + `RealBackend` + `WdaManager` on fake phones, a fake xcodebuild/iproxy (records starts and kills, brings a killed runner back), a fake libimobiledevice (`farm.usb` is what the next `idevice_id -l` lists). `mockServer()`: the same API on `MOCK=true`. Both give `get`, `post`, `phones`, `control` (the control socket with acks) and `stream` (a live view, resolved at its first frame). Each test runs in a temp working directory, so `data/` is never the repo's. |
| `fakecapture.ts`, `capture.ts` | A fake phonecap (a `StartProducer`): slow device finding, a first frame that never comes, a session that dies mid-stream (no frames, no heartbeat), a still screen (heartbeat, no frames), slow stops, re-encodes of the last picture. `captureRig()` puts it under the real capture source with fake viewers. |
| `src.ts` | `find(piece, name)`: where an export lives now. src/ is being carved into `src/device`, `src/phone`, `src/capture`, `src/transport`; the tests ask here (new place first, old after), so a move is one line in `PLACES`, not a broken suite. |
| `check.ts` | `regress(id, fn)`: one class per file, a time limit, one `#result` line for the runner, the server's last lines on failure. |

Nothing contacts a real phone or server: fake phones listen on 127.0.0.1 only.

## Every bug and its test

Calibrated on 2026-11-27 against the last commit before the rebuild (`33137f6`, a copy outside the working tree):
every PASS class passed there, and every PENDING class failed there for exactly the reason its root-cause section
gives (the numbers in the last column). `soak-dry-run` was written later and checked on the working tree.

| Bug (root-cause.md) | Fix commits | Test | Status on `33137f6` | What it showed on `33137f6` |
|---|---|---|---|---|
| §2 two requests of ours on the phone's one main queue ("beside" a read) | 7cd29d7, e8e390e | `wda-one-request-at-a-time` | PENDING | 2 main-queue requests open at once |
| §2.1 "no answer within 80 s to POST /wda/unlock" (20 s + 60 s hold) | 7cd29d7 | `unlock-not-held-80s` | PENDING | wake 20 s then 502; a tap waited 8.0 s, then "busy"; state said `ready` |
| §2.3, §8 lock/dark/unlock checks put in front of a touch after 25 s quiet | edf2be3 | `no-power-work-inside-input` | PENDING | `GET /wda/locked` before the tap, tap 983 ms |
| §3 a silent phonecap (runs, no first frame) | fffd0c1 | `capture-silent-restarted` | PASS | restarted within 1.5 s |
| §3 a capture that dies after its first frame is never noticed; a still screen looks the same | fffd0c1 | `capture-silent-mid-stream` | PENDING | the dead session was never restarted |
| §3 the 8 s open timeout is shorter than a cold start (12 s + 5 s) | fffd0c1, cfb1be2 | `capture-cold-start-not-cut` | PENDING | "no H.264 keyframe within 8s" on an 11 s cold start |
| §3 a stop then an immediate start overlap (two phonecaps on one screen) | fffd0c1 | `capture-stop-before-start` | PENDING | 2 captures alive at once |
| §3/§7 capture only while a live view is open; the agent on stills | cfb1be2 | `capture-on-while-agent-works` | PASS | |
| §4 "Couldn't open" is the wake failing: the open waits on WDA | abec0c2, e8e390e | `live-open-never-waits-on-wake` | PENDING | no `POST /open` (404) |
| §5 jitter read as congestion: the far link ratchets to the floor | 0ea1cbb, 1ad607c | `far-link-jitter-not-congestion` | PENDING | 120 s at 185 ms ± 127 ms, no loss: ended at 532 kbit/s, only 66 of 120 s at twice the floor |
| §6 stale frame stamped "now"; no picture age | dfb0700 | `stale-frame-labelled` | PENDING | no picture age from the source |
| §6, R3 Home pressed twice when the screen "can't be looked at" | abec0c2, e8e390e | `no-home-press-from-inference` | PENDING | 2 Home presses nobody asked for; TikTok sent Home |
| §7 the server reads the app in front on its own (watch, card, list, focus) | c221b93, e8e390e | `no-server-own-app-reads` | PASS | 0 reads in 8 s |
| §7 the agent's tree reads of a video app unbudgeted | c221b93 | `tree-budget-on-video-app` | PENDING | 22 reads in 9 s (budget 4) |
| §8 touches wait behind a read on the phone | e8e390e, 914bcfc | `touches-never-wait-behind-read` | PENDING | owner's taps p95 4.6 s behind a 5 s tree |
| §9 live drags: segments cut flicks; whole on release by default | 8bf520d, 6d4266e, d86e36f | `live-drags-whole-on-release` | PASS | |
| §10 slow taken as dead: restart loops | 7cd29d7, edf2be3, cfb1be2 | `wda-slow-is-never-dead` | PASS | 6 s per request for 30 s: 0 restarts, taps said "busy" |
| §10, R2 a hung main queue with the process up is silent ("ready") | e8e390e | `wda-hung-main-queue-is-seen` | PENDING | never said hung in 30 s |
| §10 a dead runner (ECONNRESET) | 0f60be5, edf2be3 | `wda-dead-runner-restarted` | PASS | one restart, back in about 7 s, old runner down first |
| §10 a phone missing from one USB poll torn down | 54977f4 | `usb-miss-not-torn-down` | PASS | |
| §10 runners piled on the phones (restarts overlapping) | 0f60be5, 54977f4 | `xcodebuild-one-at-a-time` | PASS | the second start waited for the first runner |
| c691b99 dead stream viewers kept a capture running | c691b99 | `dead-stream-viewers-closed` | PASS | |
| §11, R5 every update restarts every runner (the API shutdown kills them) | c691b99 | `updates-do-not-restart-runners` | PENDING | both runners killed by `backend.close()` |
| tooling: the soak driver | | `soak-dry-run` | PASS | see [soak.md](soak.md) |

On the in-flight rebuild (the working tree, 2026-11-27 evening) five of those already passed and lost their pending
mark: `no-power-work-inside-input`, `capture-silent-mid-stream`, `capture-cold-start-not-cut`,
`far-link-jitter-not-congestion`, `no-home-press-from-inference`. Still pending: `wda-one-request-at-a-time`,
`unlock-not-held-80s`, `capture-stop-before-start`, `live-open-never-waits-on-wake`, `stale-frame-labelled`,
`tree-budget-on-video-app`, `touches-never-wait-behind-read`, `wda-hung-main-queue-is-seen`,
`updates-do-not-restart-runners` (`manifest.json` is the truth).

## Contracts the pending tests expect from the rebuild

These are the shapes the tests read. A rebuild group that picks another name changes one line in the test or in
`test/harness/src.ts`.

- **G3 lane / G4 actor**: at most one of our requests on the main queue (`maxMainOpen <= 1`); the owner's tap acked
  in under 1 s while the agent reads a video app; nothing of ours on the main queue in front of a tap after a quiet
  spell.
- **G2 control link**: `/phones` says `control: "hung"` (or `stats.controlLink.wda.state: "hung"`) for a main queue
  silent with `/status` up, within 30 s; no restart while our request is still on the phone. While `/wda/unlock` is
  stuck on the phone, the phone isn't `ready` and its state names the unlock (`stats.controlLink.wda.onPhone` or
  `inFlight`), and a tap is answered (done or refused) within 2 s.
- **G5 look**: at most one tree read of a video app per 3 s, one at a time.
- **G6 power**: no Home press from the server's own "no picture" wake (`IdleLock.wakeForPicture`, if it still exists)
  or from opening a live view on a phone whose stills can't be read.
- **G7 capture**: heartbeat records (`KIND.BEAT`); a session whose heartbeat stops is restarted within 8 s and a
  still screen isn't; an open waits on state through an 11 s cold start; a stop completes before a start; repeats keep
  their true capture time (`repeat: true`); `stats()` gives the newest picture's age (`frame_age_ms`).
- **G8 transport**: `LinkControl({ ceiling, start, remote, now })` with `delay.add(rtt)`, `delay.addJitter(ms)` and
  `tick({ sent, nacked, reportLoss })` (the test falls back to `DelayTracker` + `DELAY_MARKS` without it).
- **G9 ops**: `backend.close()` (what `src/index.ts` runs on an update) kills no runner and deletes no session.
- **W2-a server**: `POST /phones/:udid/open` answers within 3 s with WDA hung, and puts nothing on its main queue.

## Adding a class

1. Write `test/regress/<id>.ts` with `regress('<id>', async (t) => { ... })` on the harness. Assert on what the
   fake phone saw, never on the server's own idea of it.
2. Add its entry to `manifest.json` (id, title, section, commits, file, `expectedAfterRebuild`, timeoutMs).
3. Run it on the code from before its fix: it must fail there, for the reason in its comment.
