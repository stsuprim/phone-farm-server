# Phone Farm Server

Mac-mini-side server for an iPhone farm. Lotus's Windows "Phones" page talks to it over HTTP/WebSocket.
Node 20+/TypeScript, one runtime dependency (`ws`). It discovers USB iPhones (libimobiledevice), runs one
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
Errors are JSON `{"error": "..."}` with 400/401/404/405/503/502. When WebDriverAgent is at fault the status is 502 and the
message names it: `WDA session for <name> is down: ...` (WDA unreachable, session gone, 5xx; already retried once after
recovering) or `WDA refused the request on <name>: ...` (WDA answered but said no).

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/health` | - | `{ok, mock}` (no auth) |
| GET | `/phones` | - | `[{udid, name, model, ios, battery, online, ready, control, scale, point_width, point_height, width, height}]`: `battery` 0-100 or null; `model` the product type (`iPhone14,5`); `ready` = WDA running; `control` = `"ready"` (session warm), `"recovering"` (WDA starting or session being remade) or `"down"`; `scale`, `point_width`, `point_height` from WDA (`/wda/screen`, window size), cached per WDA session, null until known; `width`/`height` the screen in pixels (points x scale) |
| GET | `/phones/:udid/screenshot` | `?format=png` (default) or `jpeg` | image bytes (`jpeg` = latest MJPEG frame; mock always returns PNG, check `Content-Type`) |
| WS | `/phones/:udid/stream` | `?fps=` (1-60, default 30), `?quality=` (5-100, default 50), `?scale=` (10-100 %, default 50) | first a text message `{"type":"hello", udid, contentType, fps, scale, quality}` with the settings actually used, then one binary message per frame (JPEG from WDA's MJPEG server in real mode, PNG in mock). Latest frame only: while the socket is backed up, older frames are dropped |
| WS | `/phones/:udid/control` | JSON text messages, see below | low-latency control over one connection |
| POST | `/phones/:udid/tap` | `{x, y}` | `{ok:true}` (WDA's fast tap) |
| POST | `/phones/:udid/swipe` | `{x1, y1, x2, y2, ms}` (`ms` default 300, max 10000) | `{ok:true}`; a swipe from a point to itself is a long press |
| POST | `/phones/:udid/path` | `{points: [[x, y, ms], ...]}` (`ms` since the gesture began; 1-5000 points, up to 60 s) | `{ok:true}`: one continuous touch with that timing |
| POST | `/phones/:udid/hold` | `{x, y, ms}` (`ms` default 1000, max 30000) | `{ok:true}` |
| POST | `/phones/:udid/touch` | `{phase, x, y, t}` | `{ok:true}`; same as a live `touch` message (fallback when the WebSocket can't open) |
| POST | `/phones/:udid/type` | `{text}` | `{ok:true}` |
| POST | `/phones/:udid/home` | `{}` | `{ok:true}` |
| POST | `/phones/:udid/launch` | `{bundleId}` | `{ok:true}` |
| POST | `/phones/:udid/recover` | `{}` | drops the WDA session, restarts the runner if `/status` fails, makes a new warm session (in the phone's queue, after any waiting actions): `{ok:true, control}`, or 502 `{error}` naming WDA |
| GET | `/update/status` | - | `{current, remote, upToDate, lastCheck, lastError}` (runs `git fetch`, compares local HEAD with `origin/main`) |
| POST | `/update/now` | - | runs the updater immediately: `{started:true}` (built; process exits and launchd restarts it) or `{started:false, reason}` (dirty tree, up to date, build failed...). 503 in mock mode |

**Coordinates are points** (WDA's coordinate space), never pixels: they go to WDA unchanged, only clamped to the screen
(0 to `point_width - 1` / `point_height - 1`). Extra fields such as `"unit":"pt"` are ignored.
Swipe, path and hold are W3C pointer actions (`POST /session/:id/actions`) with their real durations; tap uses WDA's fast
tap (`/wda/tap`, falling back to `/wda/tap/0` or a pointer tap on older WDA). Every action for a phone, from HTTP or the
control socket, goes through one queue per phone, so they run in order and never overlap (at most 50 waiting, then 503).

### Control WebSocket

`WS /phones/:udid/control?token=...` (or the bearer header). The server first sends `{"type":"hello", udid}`. Messages in:

- `{id, type:"tap", x, y}`, `{id, type:"swipe", x1, y1, x2, y2, ms}`, `{id, type:"path", points}`, `{id, type:"hold", x, y, ms}`,
  `{id, type:"home"}`, `{id, type:"type", text}`, `{id, type:"launch", bundleId}`
- live touch: `{type:"touch", phase:"down"|"move"|"up", x, y, t}` (`t` = ms since the press began; optional, server time otherwise).

Replies: `{"type":"ack", id, ok:true}` once the action has run, or `{"type":"ack", id, ok:false, error}`. Messages without
an `id` get no ack on success; a failure still answers, with `id: null`.

Live touch: WDA can't keep a finger down between requests, so `down`, the `move`s and `up` are buffered and played as one
pointer action when `up` arrives, with every point and its timing (a `down` sent late, e.g. after a hold, keeps that hold
because its `t` is kept). A still touch lifted within 250 ms becomes a fast tap. A new `down` lifts any unfinished touch;
a touch never lifted is dropped after 60 s or when its socket closes.

### WDA health

The server keeps one WDA session per phone warm (made as soon as WDA answers, with the quiescence/idle waits off so actions
don't wait for animations, and the MJPEG settings applied). On a WDA failure (connection refused, invalid session, 5xx) it
makes a new session, restarts the phone's WDA runner if `/status` doesn't answer, and retries the action once. Every ~10 s
each idle phone gets a `/status` check that recovers the same way before anyone notices. `GET /phones` shows it in `control`.

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
7. **Run**: `npm start`. Within ~10-30 s of plugging a phone in, `GET /phones` shows `online:true, ready:true`.
   Per phone the server runs `xcodebuild test-without-building` (WDA) plus two `iproxy` forwards (WDA port 8100+n, MJPEG 9100+n;
   the slot `n` per UDID is remembered in `data/ports.json`), restarts WDA with backoff if it dies, and stops it when the phone is unplugged.
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

The server checks GitHub (outbound only) every `AUTO_UPDATE_MINUTES` (default 5, `0` disables; mock mode never updates). When `origin/main` is ahead it does `git merge --ff-only`, `npm install` (only if package files changed), `npm run build`, then exits so launchd (`KeepAlive`) starts the new build. If the working tree is dirty, local commits exist, or pull/build fails, it skips, keeps the old version running and logs the reason to `server.log` (`[updater]` lines). `.env` is never read or printed by it.

It relies on the launchd service above, so install that first: `cp deploy/com.lotus.phonefarm.plist ~/Library/LaunchAgents/`, edit the paths, `launchctl load ~/Library/LaunchAgents/com.lotus.phonefarm.plist`. To update by hand anyway: `git pull && npm run build` and kickstart:

After `git pull`/code changes run `npm run build` and `launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`.

## Testing

`npm run check` type-checks. `npm test` starts a mock server in-process and exercises auth, every endpoint and the stream.
Against a live server: `URL=http://<mac>:8787 API_TOKEN=<token> npm test` (needs at least one online phone).

## Settings (.env)

`API_TOKEN`, `HOST`, `PORT`, `MOCK`, `MOCK_PHONES`, `WDA_PROJECT`, `WDA_DERIVED_DATA` (default `~/wda-build`),
`WDA_BASE_PORT` (8100), `MJPEG_BASE_PORT` (9100), `POLL_MS` (5000), `AUTOSTART_WDA` (true), `AUTO_UPDATE_MINUTES` (5, 0 = off).

## Notes / known limits

- Free Apple ID limits: on each phone, trust the developer under Settings > General > VPN & Device Management > Verify App. Free signing expires after 7 days (rebuild WDA), allows only about 3 devices, so a real farm needs the paid $99/year developer account.

- Real mode could not be tested on Windows; the WDA and libimobiledevice calls follow their documented CLIs/endpoints.
  First on-Mac run: check `GET /phones`, then `/screenshot`, and read `server.log` (`[wda xxxxxxxx]` lines) if a phone stays `ready:false`.
- `iproxy` syntax used is the libusbmuxd 2.x form (`iproxy -u UDID LOCAL:REMOTE`).
- `type` sends keystrokes via WDA; a keyboard must be focused on the phone.
