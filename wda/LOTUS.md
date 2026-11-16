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
| `WebDriverAgentLib/Commands/FBCustomCommands.m` | One line: the include. |

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

## What has to be seen on the Mac

This was written on a PC with no Xcode. The additions were parsed with clang's Objective-C front end against
stand-in headers (syntax and names: `python scripts/objc-check/check.py .` and `check2.py .`, which need
`pip install libclang`), not compiled against the iOS SDK, and never run. The first automatic build on the Mac is
the real check:

1. **It compiles.** If not, the phones stay on the stock WebDriverAgent and `GET /api/wda` says the compiler's
   first error under `fork.perDevice.<udid>.reason`.
2. **The token gate.** `curl -i http://127.0.0.1:<port>/status` on the Mac must show a bare `404` with
   `Content-Length: 0`; with `-H "X-Lotus-Token: …"` (the server has it) it answers.
3. **The self-test.** `fork.perDevice.<udid>.live` in `GET /api/wda` says the mode it found and its notes.
4. **A live drag** on the Phones page follows the pointer while the button is down.

## Turning it off from afar

The Mac pulls this repo by itself, so `LOTUS_FORK.json` is also a switch that needs nobody at the Mac. Push a
commit that changes it:

| In `LOTUS_FORK.json` | What happens when the Mac has pulled it |
|---|---|
| `"enabled": false` | Every phone goes back to the stock WebDriverAgent (the server restarts on the pull and starts each runner as stock). `true` again installs ours again. |
| `"liveTouch": "off"` | Our build stays, but live touch through it is not used: a drag is played whole on release. `"auto"` uses it again (with the mode the self-test found). |

## Updating to a newer upstream

Replace the upstream folders with the new tag's, re-apply the `LOTUS` changes (the table above is all of them),
update `LOTUS_FORK.json` (`version`, `upstream`, `upstreamCommit`) and the two constants in `FBLotusCommands.inc`,
and run `npm test`.
