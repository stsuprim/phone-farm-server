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
Errors are JSON `{"error": "..."}` with 400/401/404/405/503/502. When WebDriverAgent is at fault the status is 502 and the
message names it: `WDA session for <name> is down: ...` (WDA unreachable, session gone, 5xx; already retried once after
recovering) or `WDA refused the request on <name>: ...` (WDA answered but said no).

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/health` | - | `{ok, mock}` (no auth) |
| GET | `/phones` | - | `[{udid, name, model, ios, battery, online, ready, control, scale, point_width, point_height, width, height}]`: `battery` 0-100 or null; `model` the product type (`iPhone14,5`); `ready` = WDA running; `control` = `"ready"` (session warm), `"recovering"` (WDA starting or session being remade) or `"down"`; `scale`, `point_width`, `point_height` from WDA (`/wda/screen`, window size), cached per WDA session, null until known; `width`/`height` the screen in pixels (points x scale); `stats` the live view numbers (see [Live view](#live-view-webrtc-h264-mjpeg)); `lan` the Mac's own base URLs on its LAN/Tailscale IPv4 addresses (`["http://192.168.1.20:8787", ...]`, same for every phone) |
| GET | `/phones/:udid/screenshot` | `?format=png` (default) or `jpeg` | image bytes (`jpeg` = latest MJPEG frame; mock always returns PNG, check `Content-Type`) |
| WS | `/phones/:udid/stream` | `?codec=` (`h264` or `mjpeg`; absent = MJPEG as before), `?fps=` (1-60, default 60), `?quality=`, `?scale=` (10-100 %; MJPEG default 50, H.264 default 100) | MJPEG: first a text message `{"type":"hello", udid, contentType, fps, scale, quality}` with the settings actually used, then one binary message per frame (JPEG from WDA's MJPEG server in real mode, PNG in mock); latest frame only. H.264: see [Live view](#live-view-webrtc-h264-mjpeg) |
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

- clock sync: `{type:"ping", t}` -> `{type:"pong", t, server_time}` right away (also on the stream socket and the `input-r`
  data channel). With the round trip the client estimates the server clock offset, and with the capture times below it
  shows glass-to-glass latency.
- WebRTC signaling: `rtc-offer`, `rtc-ice`, `rtc-close` (see [Live view](#live-view-webrtc-h264-mjpeg)).

Replies: `{"type":"ack", id, ok:true}` once the action has run, or `{"type":"ack", id, ok:false, error}`. Messages without
an `id` get no ack on success; a failure still answers, with `id: null`.

Live touch: WDA can't keep a finger down between requests, so `down`, the `move`s and `up` are buffered and played as one
pointer action when `up` arrives, with every point and its timing (a `down` sent late, e.g. after a hold, keeps that hold
because its `t` is kept). A still touch lifted within 250 ms becomes a fast tap. A new `down` lifts any unfinished touch;
a touch never lifted is dropped after 60 s or when its socket closes.

**Live drags replay on release, by design of iOS automation.** There is no streaming touch input for iOS from a Mac:
XCTest (which WDA runs on) only synthesizes a *complete* event record (`XCSynthesizedEventRecord`: down, path, up) and
plays it in one go, and WDA's endpoints (`/actions`, the legacy `/wda/touch/perform`) both take the whole gesture up front.
Nothing else can inject touches into an un-jailbroken iPhone (no HID over USB for touch, no public API). So a drag shows on
the phone only after the finger lifts, with its real path and timing; taps go straight through WDA's fast tap. What *is*
done for latency: one warm WDA session per phone, no session/status call before an action, and keep-alive HTTP connections
to WDA (so a touch never pays for a new usbmux connection).

## Live view: WebRTC, H.264, MJPEG

Three transports, best first. The client tries WebRTC, then the H.264 WebSocket, then MJPEG; the server tells it when it
has to step down (`rtc-error`, or a `codec:"mjpeg"` hello with a `reason`).

**Capture (macOS):** `native/phonecap` is a small Swift tool that captures the iPhone screen over USB the way QuickTime
does (CoreMediaIO's `kCMIOHardwarePropertyAllowScreenCaptureDevices`, then the iPhone as an AVFoundation capture device,
matched by UDID, then name), at up to 60 fps, encodes it with VideoToolbox H.264 in real time (low-latency rate control,
Constrained Baseline, no B-frames, keyframe at least every 2 s, 8 Mbps by default, optional downscale in the capture
pipeline), and writes framed Annex B NAL units to stdout. The server runs one helper per phone on demand, shared by all
viewers, stops it 10 s after the last viewer leaves, restarts it on a crash with backoff (after 3 failed starts it gives up
for 60 s and viewers get MJPEG), and caches the latest SPS/PPS and keyframe so a new viewer sees a picture at once (then
gets a fresh IDR). It does not need WDA, so the picture works even while WDA restarts.

### WebRTC (primary)

Signaling over the authenticated control WebSocket:

- client -> `{type:"rtc-offer", sdp, want:{fps, scale, quality?}}` (the client makes the offer: a recvonly video
  transceiver and two data channels, below)
- server -> `{type:"rtc-answer", sdp}`, then `{type:"rtc-hello", codec:"h264", width, height, fps, scale, server_time}` once
  frames flow, or `{type:"rtc-error", reason}` (H.264 unavailable, bad offer, WebRTC library missing) -> fall back
- trickle ICE both ways: `{type:"rtc-ice", candidate, mid}` (the server's candidates come without the `a=` prefix);
  `{type:"rtc-close"}` ends the session (closing the control socket does too). A new offer replaces the old session.

Media: one sendonly H.264 track (the offer's `packetization-mode=1` H.264 payload type, preferring `42e01f`, answered with
`profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1`). Each access unit goes out as RTP with a 90 kHz
timestamp from the capture time; SPS/PPS go with every keyframe in the same access unit. RTCP PLI/FIR force an IDR, NACKs
are answered from a small retransmit buffer, sender reports are sent. If the offer has the `playout-delay` header extension,
every packet carries min=max=0 so Chrome renders frames as soon as they're decoded (the client can also set
`receiver.jitterBufferTarget = 0`).

**ICE: host candidates only, no STUN, no TURN.** The server offers its own LAN and Tailscale (100.x / fd7a:) addresses, so the
path is always direct, never relayed. Browsers/WebView2 hide their own LAN address behind an mDNS `.local` name; that's fine:
the server accepts the peer-reflexive address it actually sees the checks come from (libdatachannel does this by default).

Data channels, created by the client, same JSON as the control socket:

- `input`: `{ordered:false, maxRetransmits:0}` for touch `move`s. Late moves (older `t`) are dropped, a burst is coalesced
  to the latest point.
- `input-r`: ordered, reliable, for everything else (`down`, `up`, `tap`, `home`, `type`, ...) with the same acks
  `{type:"ack", id, ok, error?}`, plus `ping`/`pong`. The server also sends `{type:"ts", rtp, capture_time}` about once a
  second on it: the RTP timestamp of a frame and its capture time (ms since the epoch, server clock), so the client can
  turn any frame's RTP timestamp into its capture time and measure true glass-to-glass latency.

Library: [node-datachannel](https://github.com/murat-dogan/node-datachannel) 0.33.6 (libdatachannel bindings, prebuilt for
macOS arm64/x64, Linux and Windows), **MPL-2.0**, pinned exactly. `npm install` must keep optional dependencies (they hold the
prebuilt binary). If it can't load, the server still runs and answers offers with `rtc-error`.

### H.264 over WebSocket (fallback)

`WS /phones/:udid/stream?token=...&codec=h264&fps=&scale=&quality=` (`quality` 1-100 maps to 2-12 Mbps; default 8 Mbps).

1. Text: `{type:"hello", codec:"h264", udid, width, height, fps, scale, server_time}`. If H.264 isn't available the hello is
   `{type:"hello", codec:"mjpeg", reason, udid, contentType, fps, scale, quality}` and MJPEG frames follow instead.
2. Binary, one per message: 1 byte kind (`1` config = SPS+PPS, `2` keyframe, `3` delta), 8 bytes capture time (float64
   big-endian, ms since the epoch on the server's clock), then the Annex B payload (start codes included).
   Config always comes right before a keyframe (and only when it changed); the first frames are config + keyframe.
3. Latest-only: when the socket's `bufferedAmount` is high (over 256 KB or 1.5x a keyframe), deltas are dropped until the
   next keyframe and one is requested from the helper. Nothing is ever queued.
4. Client text `{type:"key"}` forces a keyframe (deltas are skipped until it arrives); `{type:"ping", t}` answers a pong.

The size can change mid-stream (the phone rotates): a new config + keyframe arrive; reconfigure the decoder from the SPS.

### MJPEG (last resort)

WDA's MJPEG server (no `codec`, or `codec=mjpeg`, or the fallback): `mjpegServerFramerate` = the highest fps asked for
(default now 60), `mjpegScalingFactor` from `scale`, `mjpegServerScreenshotQuality` from `quality`; latest frame only.

### Stats

`GET /phones` -> each phone's `stats`:
`{codec, fps, encode_ms, capture_to_encoded_ms, encoded_to_sent_ms, viewers, viewers_webrtc, viewers_h264_ws,
viewers_mjpeg, path, dropped, h264_available, h264_reason}`. `codec` is what viewers get now (`h264` if any WebRTC/H.264
viewer, else `mjpeg`, null when nobody watches); timings are running averages in ms (capture -> encoded measured in the
helper from the capture timestamp, encoded -> sent in the server); `path` is the WebRTC path (`lan`, `tailscale`,
`loopback`, `direct`; candidates are always host, never relayed); `h264_reason` says why H.264 can't be used (helper not
built, build error, capture failing, `H264=false`).

### The helper on the Mac

- Built by `npm run build` (`scripts/build-native.mjs`: `xcrun swiftc -O`), so the auto-updater rebuilds it after each pull.
  It only rebuilds when `main.swift`/`Info.plist` change. Needs Xcode or the Command Line Tools (already there for WDA).
  On other systems the step is skipped. If the build fails, the server keeps working on MJPEG: the reason goes to
  `native/phonecap/build/phonecap.error`, `server.log` (`[updater]`/`[native]`) and every phone's `stats.h264_reason`.
- It is built as a minimal app bundle, `native/phonecap/build/PhoneCap.app` (bundle id `com.lotus.phonecap`, ad-hoc
  signed; set `PHONECAP_SIGN_IDENTITY` to sign with a real certificate instead), so macOS gives it its own Camera entry.
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

`npm run check` type-checks. `npm test` runs `test/h264.ts` (helper framing, config-before-key, latest-only drop to keyframe,
helper restarts, offer/RTCP parsing), `test/rtc.ts` (WebRTC in mock mode with a node-datachannel client: signaling, ICE,
RTP, PLI -> IDR, data channels and acks, stats, rtc-error) and `test/smoke.ts` (a mock server: auth, every endpoint, MJPEG,
H.264 WebSocket, the MJPEG fallback, ping/pong). Mock mode's H.264 is a real, decodable stream (a tiny built-in encoder:
Constrained Baseline 208x448, I_PCM keyframes and skip-coded deltas), so clients can test decoding against it.
Against a live server: `URL=http://<mac>:8787 API_TOKEN=<token> npm test` (needs at least one online phone).

## Settings (.env)

`API_TOKEN`, `HOST`, `PORT`, `MOCK`, `MOCK_PHONES`, `WDA_PROJECT`, `WDA_DERIVED_DATA` (default `~/wda-build`),
`WDA_BASE_PORT` (8100), `MJPEG_BASE_PORT` (9100), `POLL_MS` (5000), `AUTOSTART_WDA` (true), `AUTO_UPDATE_MINUTES` (5, 0 = off),
`H264` (true), `H264_BITRATE_MBPS` (8), `PHONECAP_PATH` (default `native/phonecap/build/phonecap`).

## Notes / known limits

- Free Apple ID limits: on each phone, trust the developer under Settings > General > VPN & Device Management > Verify App. Free signing expires after 7 days (rebuild WDA), allows only about 3 devices, so a real farm needs the paid $99/year developer account.

- Latency: expected numbers per stage, before and after, are in [docs/latency.md](docs/latency.md) (estimates).
- Real mode could not be tested on Windows (nor the Swift helper, which was written without a Mac to compile it); the WDA and libimobiledevice calls follow their documented CLIs/endpoints.
  First on-Mac run: check `GET /phones`, then `/screenshot`, and read `server.log` (`[wda xxxxxxxx]` lines) if a phone stays `ready:false`.
- `iproxy` syntax used is the libusbmuxd 2.x form (`iproxy -u UDID LOCAL:REMOTE`).
- `type` sends keystrokes via WDA; a keyboard must be focused on the phone.
