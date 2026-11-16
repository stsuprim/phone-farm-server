# Mac mini steps for the second 2026-11-15 update (rotation, reliable touch, AI control)

For Rinor: paste everything below the line into Claude Code on the Mac mini, started inside the project folder
(`phone-farm-server`). It needs you at the Mac for a few minutes: turning a phone on its side and saying what you see.

---

You are updating the "Phone Farm Server" on this Mac mini and checking three new things on real iPhones: **rotation**
(pictures upright, taps in the right place when a phone is on its side), **live touch** (acks, auto-release, wake first)
and the **AI control API** (`/ui`, `/tap-element`, `/type`, `/key`, `/launch`, `/act`). Read `README.md` sections
"Orientation and coordinates", "Action reports", "AI control" and "Live touch" first. This code was written on Windows
against a mock phone, so the checks below are the first time it meets real hardware: run every one and write down what
each answered. Work step by step and stop and tell me when a step needs me. **Never print, log or paste `.env` or the API
token**; use it only inside commands through shell variables, as below. Don't `git push` anything, and don't edit the
source: if something is wrong, report it (the fix goes through the repository, the auto-updater would undo local edits).

Set these once in your shell for the checks (they read `.env` without printing it):

```sh
cd ~/phone-farm-server   # or wherever the project is (the plist's WorkingDirectory)
set -a; . ./.env; set +a
B="http://localhost:${PORT:-8787}"; H="Authorization: Bearer $API_TOKEN"; J='content-type: application/json'
U=<UDID of the phone we test with>   # from: curl -s -H "$H" $B/api/devices | python3 -c 'import sys,json; [print(p["udid"], p["name"], p["ios"], p["orientation"]) for p in json.load(sys.stdin)]'
```

1. **Get the new code.** The auto-updater pulls GitHub main within about a minute. Confirm
   `ls src/orient.ts src/agent.ts src/ui.ts docs/MAC_STEPS_2026-11-15b.md` lists all four. If not:
   `curl -s -X POST -H "$H" $B/update/now`, wait 60 s, check again.

2. **Build.** `npm install && npm run build`.
   - `cat native/phonecap/build/phonecap.caps` must say `lanes rotate`.
   - `ls native/phonecap/build/phonecap.error` must say "No such file". **If the file exists** the Swift helper didn't
     compile (it was changed without a compiler at hand): show me `head -30 native/phonecap/build/phonecap.error` and
     carry on. The previous helper keeps running and the server restarts a capture that kept its old shape by itself,
     so everything below still applies; only `CAPTURE_ROTATE` won't work.
   - WDA does **not** need a rebuild (the new calls are standard WDA: `/orientation`, `/source`, `/wda/activeAppInfo`,
     `/wda/pressButton`, the `mjpegFixOrientation` setting).
   - HID touch helper (only if a phone runs iOS 27+): `~/.phonefarm-hid/bin/pip install -U pymobiledevice3`.
   - App names: `which ideviceinstaller || brew install ideviceinstaller`.
   - `npm test` must end with every suite passing, the last three being "rotation", "touch" and "UI" checks (mock mode, no
     phones touched).

3. **Reload the launchd service:**
   `launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`, wait 30 s, then
   `curl -s -H "$H" $B/api/devices | python3 -m json.tool | grep -E '"(name|ready|control|orientation|point_width|point_height)"'`
   -> every phone `ready: true` with `orientation: "portrait"` (phones standing up) and `point_width` < `point_height`.

4. **Rotation.** On the test phone turn **Portrait Orientation Lock off** (Control Center) and open **Safari** (the
   iPhone home screen itself never turns, and some apps don't either: Safari, Notes, Photos and Messages do). Ask me to
   do each turn and wait for me.
   - Phone upright: `curl -s -H "$H" $B/api/devices/$U/orientation` -> `"orientation":"portrait"`, `point_width` < `point_height`.
   - I turn it on its side, **top edge to the left** (turned counter-clockwise). The same call within 3 s ->
     `"orientation":"landscape-left"`, `point_width` > `point_height`, `width` > `height`.
     If it says `landscape-right` instead, note it: the two names are swapped on this iOS/WDA (tell me, carry on).
   - Screenshot, still on its side:
     `curl -s -D /tmp/h.txt -o /tmp/shot.png -H "$H" $B/api/devices/$U/screenshot; grep -i '^x-' /tmp/h.txt; sips -g pixelWidth -g pixelHeight /tmp/shot.png; open /tmp/shot.png`
     -> `x-orientation: landscape-left`, wider than tall, and **I tell you whether the picture is upright** (text
     readable without tilting my head, not squashed). Same with `?format=jpeg` (`-o /tmp/shot.jpg`).
   - The live picture: I open the phone in Lotus's Phones page (or SUPRIM does) and turn the phone both ways and back.
     Meanwhile: `grep -E '\[orient |\[phonecap' server.log | tail -20` and
     `curl -s -H "$H" $B/api/devices | python3 -c 'import sys,json; [print(p["name"], p["orientation"], (p.get("stats") or {}).get("capture_mismatch")) for p in json.load(sys.stdin)]'`.
     Expected: the picture follows within a second or two, upright, right shape; `capture_mismatch` is `None`.
     `[orient ...] ... starting the capture over` once per turn is fine. If the log says
     `a new capture didn't change that` and the picture stays **sideways**: add `CAPTURE_ROTATE=cw` to `.env`
     (`grep -q '^CAPTURE_ROTATE=' .env && sed -i '' 's/^CAPTURE_ROTATE=.*/CAPTURE_ROTATE=cw/' .env || echo 'CAPTURE_ROTATE=cw' >> .env`),
     kickstart, turn again; upside down now -> `ccw`. Tell me which one was needed, and for which phone model.
   - Turn it the other way (**top edge to the right**) -> `landscape-right`; back upright -> `portrait`.

5. **Taps land in the right place when it's on its side.** Phone on its side (top edge left), in an app that turned
   (Safari, Notes...). Read the screen and pick a button **near one corner** whose effect I can see (so a tap that landed
   mirrored would clearly press something else):
   ```sh
   curl -s -H "$H" "$B/api/devices/$U/ui?fresh=1" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["orientation"]); [print(e["id"], e["type"], repr(e["label"]), e["x"], e["y"]) for e in d["elements"] if e["hittable"] and e["type"] in ("Button","Cell","Icon","Link")]'
   curl -s -X POST -H "$H" -H "$J" -d '{"label":"<its label>"}' $B/api/devices/$U/tap-element
   ```
   -> `"ok":true`, `"changed":true`, and **I confirm that button was the one pressed**. Note `via` (`hid`, `wda-fast` or
   `wda`) and the `element`'s `x, y`. Undo it, then repeat with the **top edge right**, with a button in another corner.
   - The wrong spot was pressed and `via` was `"hid"`: add `HID_LANDSCAPE=swap` to `.env` (same
     `grep ... || echo ... >> .env` form as above), kickstart, repeat both sides. Still wrong: `HID_LANDSCAPE=off`
     (WDA then takes taps while the phone is turned). Tell me which setting ended up right.
   - On a phone **without** HID (iOS below 27; `via` was `wda`): try the fast route in landscape. Add
     `WDA_FAST_LANDSCAPE=1`, kickstart, repeat both sides. `via: "wda-fast"` and the right button pressed on both sides =
     keep it. Anything else = remove the line again and tell me what happened.
   - Also one raw tap by position, so the picture's coordinates are checked too: take that element's middle
     (`x + w/2`, `y + h/2`) and send `-d '{"x":<mx>,"y":<my>,"unit":"norm"}' $B/api/devices/$U/tap` -> the same button.
   - Upright again, a tap-element must still press the right thing (`via` `hid` or `wda-fast`).

6. **AI control** (phone upright, unlocked):
   - Read the screen: `curl -s -H "$H" "$B/api/devices/$U/ui" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["app"], d["orientation"], d["count"], d["ms"], "ms"); print(d["text"][:600]); print(json.dumps(d["elements"][:3]))'`
     -> the foreground app, the strings on screen top to bottom, elements with `x, y, w, h` between 0 and 1. Note `ms`
     for the home screen and for a busy app (TikTok/Instagram feed): over ~3000 ms is worth telling me.
   - Apps: `curl -s -H "$H" $B/api/devices/$U/apps | python3 -c 'import sys,json; a=json.load(sys.stdin)["apps"]; print(len(a), [x["name"] for x in a if x["installed"]][:40])'`
     -> the phone's installed apps by name (an empty list of installed ones = `ideviceinstaller` isn't working: show
     me `ideviceinstaller -u $U list --all 2>&1 | head -5`, or `ideviceinstaller -u $U -l 2>&1 | head -5` on an older one).
   - Launch by name with a check: `curl -s -X POST -H "$H" -H "$J" -d '{"name":"Settings","verify":{"app":"Settings"}}' $B/api/devices/$U/launch`
     -> `ok:true, verified:true, app:"com.apple.Preferences", changed:true`.
   - Keys: `-d '{"key":"volumeUp"}' $B/api/devices/$U/key` (the volume bar shows), `{"key":"home"}` (home screen),
     `{"key":"lock"}` (screen off).
   - **Wake first**: right after that lock, `curl -s -X POST -H "$H" -H "$J" -d '{"name":"Settings","verify":{"app":"Settings","timeoutMs":8000}}' $B/api/devices/$U/launch`
     -> the phone wakes and unlocks by itself, then Settings opens: `verified:true`. Note `total_ms`.
   - A whole errand in one call:
     ```sh
     curl -s -X POST -H "$H" -H "$J" -d '{"steps":[{"type":"launch","name":"Settings"},{"type":"swipe","x1":0.5,"y1":0.3,"x2":0.5,"y2":0.7,"ms":250},{"type":"tap-element","text":"Search","timeoutMs":3000},{"type":"type","text":"wifi"},{"type":"wait","text":"Wi-Fi","timeoutMs":5000},{"type":"key","key":"home"}],"verify":{"app":"com.apple.springboard"}}' $B/api/devices/$U/act | python3 -m json.tool
     ```
     -> `ok:true`, `done: 6`, each step `ok:true`; on the phone Settings opens, the search field gets "wifi", then home.
     If a step fails, show me that step's `error` (it says what the screen did say).

7. **Live touch numbers.** I (or SUPRIM) drag and tap on the phone from Lotus's Phones page for half a minute, including
   one long hold and one drag with the phone on its side. Then:
   `curl -s -H "$H" $B/api/devices/$U/input | python3 -c 'import sys,json; d=json.load(sys.stdin); print(json.dumps({k:d[k] for k in ("via","tap_avg_ms","tap_p90_ms","touch","methods")}, indent=1)); [print(r["type"], r["via"], round(r["total_ms"],1), r.get("reason",""), r.get("error","")) for r in d["recent"][-25:]]'`
   -> on an iOS 27+ phone `methods.hid: "ready"`, `touch-down`/`touch-move`/`touch-up` lines `via hid` at a few ms,
   `touch.auto_released` 0 (it counts fingers the server lifted because no event came for 1.5 s; more than 0 during a
   normal hold means the viewer isn't repeating its moves: tell me), `touch.fallbacks` and `fallback_reason` (why a
   gesture went through WDA instead). On older iOS: `tap`/`gesture` lines `via wda-fast`.
   Also `grep -E '\[hid ' server.log | tail -20` for reconnects.

8. **Report back**, per phone: model and iOS; step 2's helper build (caps, any `phonecap.error` lines); step 4 (the
   orientation names matched or were swapped; screenshot and live picture upright in both landscapes or not; any
   `CAPTURE_ROTATE` needed); step 5 (`via` and `verified` per side; which `HID_LANDSCAPE` / `WDA_FAST_LANDSCAPE` ended
   up in `.env`); step 6 (`/ui` times, anything that failed with its `error`); step 7's numbers. Never include the token.

---

## 2026-11-16: detail cards, fast open, reliability (steps 9-12)

Same rules as above (never print the token, don't edit the source, don't push). Read `README.md` sections "Device info
(the detail card)" and "Opening a view fast" first. Nothing native changed: `phonecap` is **not** rebuilt (no Camera
prompt) and WDA does **not** need a rebuild. Set `B`, `H`, `J`, `U` as at the top.

9. **Get the code, build, test.** `ls src/info.ts test/info.ts test/connect.ts test/reliability.ts` lists all four (else
   `curl -s -X POST -H "$H" $B/update/now`, wait 60 s). `npm install && npm run build`, then `npm test`: the last three
   suites must say `all 4 info checks passed`, `all 4 connect checks passed`, `all 9 reliability checks passed`.
   `which idevicediagnostics || brew install libimobiledevice` (the temperature comes from it). Then
   `launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`, wait 30 s.

10. **The detail card** (phone unlocked, on its home screen):
    ```sh
    time curl -s -H "$H" "$B/api/devices/$U/info?fresh=1" | python3 -m json.tool
    ```
    -> `battery.level` between 0 and 1 and equal to the phone's own percentage, `charging: true` (it's on USB),
    `temperatureC` a believable number (about 20-45), `app` `com.apple.springboard` / `"Home Screen"`, `model`, `ios`,
    `wda.daysLeft` and `wda.state`, `thermal: "nominal"`. `uptimeSec` and `bootedAt` are `null`: expected (stock WDA
    doesn't say when the phone booted). Note the `time` (it should be about a second or less).
    - Open Settings on the phone, ask again with `?fresh=1` -> `app: {"bundleId":"com.apple.Preferences","name":"Settings"}`.
    - Without `?fresh=1`, twice in a row: the second answers at once with the same `at` (kept ~15 s).
    - The list carries it:
      `curl -s -H "$H" $B/api/devices | python3 -c 'import sys,json; [print(p["name"], p["info"]["battery"], p["info"]["temperatureC"], p["info"]["app"], p["info"]["fresh"]) for p in json.load(sys.stdin)]'`
      (run it twice, a few seconds apart: the first may say `fresh False` with only the level, the second has it all).
    - `temperatureC` is `null`: show me
      `idevicediagnostics -u $U ioregentry AppleSmartBattery 2>&1 | grep -A1 -E '<key>(Temperature|IsCharging|CurrentCapacity|MaxCapacity)</key>' | head -12`
      (or its error line). `battery.level` is `null`: show me `ideviceinfo -u $U -q com.apple.mobile.battery 2>&1 | head`.

11. **Opening a view fast.** This shell function opens the H.264 stream as Lotus does and prints how long the picture
    took (it reads the token from the environment and never prints it):
    ```sh
    open_view() { U="$U" TOKEN="$API_TOKEN" PORT="${PORT:-8787}" node -e '
      const WebSocket = require("ws");
      const ws = new WebSocket(`ws://localhost:${process.env.PORT}/api/devices/${process.env.U}/stream?codec=h264&fps=60&scale=50&bitrate=4000`, { headers: { authorization: `Bearer ${process.env.TOKEN}` } });
      ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(d.toString());
        if (m.type === "hello") console.log("hello", m.codec, "connectMs", m.connectMs, "warm", m.warm, m.reason || "");
        if (m.type === "first-frame") { console.log("first-frame", m.transport, "connectMs", m.connectMs); setTimeout(() => ws.close(), 500); } });
      ws.on("error", (e) => console.log("error", e.message)); setTimeout(() => process.exit(0), 12000);'; }
    ```
    - **Cold.** Nobody has had this phone open for over 2 minutes (`grep -E 'no viewers for a while' server.log | tail -2`
      shows its capture stopped; else wait). `open_view` -> `hello h264 connectMs <N> warm false`. Note N (a second or
      two is normal: the capture starting).
    - **Warm.** `open_view` again right away -> `warm true` and `connectMs` under ~100. Note it.
    - **Started ahead.** Wait until the capture stopped again (over 2 minutes; the same grep), then
      `curl -s -X POST -H "$H" $B/api/devices/$U/warm` -> `"capture":"starting"`; 4 s later the same call ->
      `"capture":"warm"`; then `open_view` -> `warm true`, `connectMs` small. `grep -E '\[h264 .*thumb\]' server.log | tail -3`
      shows the small lane it started.
    - **In Lotus.** I (or SUPRIM) open the phone's live view, close it, open another phone, come back within two minutes.
      While it's open:
      `curl -s -H "$H" $B/api/devices | python3 -c 'import sys,json; [print(p["name"], [(s["transport"], s.get("connectMs")) for s in p["stats"]["sessions"]]) for p in json.load(sys.stdin)]'`
      -> each session's `connectMs`. Tell me how it felt (the picture there at once, or a wait).
    - With nobody watching a warm phone: `ps -axo %cpu,command | grep -i '[p]honecap'` -> note the CPU. If a warm capture
      costs too much, set `CAPTURE_WARM_SECONDS=30` in `.env` (`10` is the old behaviour) and kickstart; tell me.
    - `hello mjpeg ... <reason>` instead of `h264`: the capture isn't working at all (not this update): show me the reason.

12. **Reliability** (phone unlocked, upright):
    - **A session that expired.** Make a second WDA session behind the server's back, which ends the server's own.
      The phone's WDA port: `grep -E "wda ${U: -8}\] starting" server.log | tail -1` -> `(wda :81xx, ...)`. Then:
      ```sh
      curl -s -X POST -H "$J" -d '{"capabilities":{"alwaysMatch":{}}}' http://localhost:<that port>/session > /dev/null
      curl -s -X POST -H "$H" -H "$J" -d '{"name":"Settings","verify":{"app":"Settings"}}' $B/api/devices/$U/launch
      grep -E 'session expired|recovering|recovered|session was replaced' server.log | tail -5
      ```
      -> the launch answers `ok:true, verified:true` (one try, a second or two slower), and the log shows the session
      being remade. `control` in `/api/devices` is `ready` afterwards.
    - **A batch with no waits of its own**, five times (each step reads the screen after the one before, waits for
      the transition to end and for its element to arrive):
      ```sh
      for i in 1 2 3 4 5; do curl -s -X POST -H "$H" -H "$J" -d '{"steps":[{"type":"launch","name":"Settings"},{"type":"tap-element","label":"General"},{"type":"tap-element","label":"About"},{"type":"wait","text":"Name","timeoutMs":4000},{"type":"key","key":"home"}],"verify":{"app":"com.apple.springboard"}}' $B/api/devices/$U/act | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["ok"], d["done"], d.get("error",""), [round(s.get("total_ms", s.get("ms", 0))) for s in d["steps"]])'; done
      ```
      -> `True 5` five times. A failure: show me the line (its `error` says what the screen did say). Settings opens
      where it was left, so from the second run on it may already be inside General or About and `General` isn't
      there to tap: that's Settings, not a bug. Go back to Settings' first page on the phone between runs, or say so.
    - **An id from a screen that changed.** On the home screen:
      `curl -s -H "$H" "$B/api/devices/$U/ui?fresh=1" | python3 -c 'import sys,json; [print(e["id"], e["type"], repr(e["label"])) for e in json.load(sys.stdin)["elements"] if e["type"]=="Icon"][:8]'`
      -> pick one icon's `id` and `label`. Open Settings on the phone, then
      `curl -s -X POST -H "$H" -H "$J" -d '{"id":"<that id>","label":"<that label>"}' $B/api/devices/$U/tap-element`
      -> HTTP 409 `the screen changed since it was read: ...` and **nothing is pressed** in Settings.
    - **iOS 27+ phones only (HID).** A long hold with a tap right behind it:
      ```sh
      curl -s -X POST -H "$H" -H "$J" -d '{"x":0.5,"y":0.5,"ms":7000,"unit":"norm","fast":true}' $B/api/devices/$U/hold
      time curl -s -X POST -H "$H" -H "$J" -d '{"x":0.5,"y":0.12,"unit":"norm","fast":true}' $B/api/devices/$U/tap
      grep -E '\[hid ' server.log | tail -6
      ```
      -> the hold answers at once (`via: "hid"`), the tap about 7 s later with `ok:true, via:"hid"` (it waited for the
      hold; it used to time out after 5 s), and the log has no `timed out` and no new `touch session open` line.
      Then typing: tap into Settings' search field on the phone, and
      `time curl -s -X POST -H "$H" -H "$J" -d '{"text":"hello world"}' $B/api/devices/$U/type` -> `via: "hid"`, `ms`
      about 600-900 (the typing itself, answered when the last key is in), and the field holds exactly `hello world`.

    **Report back** for steps 9-12, per phone: the three suites' last lines; step 10's JSON (the whole answer; it has no
    secrets) and its time, and any `null` that shouldn't be; step 11's cold, warm and warmed-ahead `connectMs`, how it
    felt in Lotus, the idle `phonecap` CPU; step 12's four answers and the log lines. Never include the token.

---

## 2026-11-16 (later): one live phone, staying responsive, info that keeps up (steps 13-16)

Same rules as above (never print the token, don't edit the source, don't push). Read `README.md` sections "One live
phone at a time", "Staying responsive (WDA self-heal)" and "Info that keeps up" first. Nothing native changed:
`phonecap` and WDA are **not** rebuilt. Set `B`, `H`, `J`, `U` as at the top; `U2` = a second phone's UDID.

13. **Get the code, build, test.** `ls test/heal.ts` (else `curl -s -X POST -H "$H" $B/update/now`, wait 60 s).
    `npm install && npm run build`, then `npm test`: the last suite must say `all 5 heal checks passed`. Then
    `launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`, wait 30 s.

14. **One live phone at a time.**
    ```sh
    curl -s -X POST -H "$H" $B/api/devices/$U/focus | python3 -m json.tool
    curl -s -X POST -H "$H" $B/api/devices/$U2/focus | python3 -m json.tool
    curl -s -H "$H" $B/api/devices | python3 -c 'import sys,json; [print(p["name"], p["focused"], p["locked"], p["info"]["battery"]) for p in json.load(sys.stdin)]'
    grep -E '\[focus\]|\[capture .*stopped' server.log | tail -4
    ```
    -> the second answer has `"previous": {"udid": "<U>", "slept": true}`; **the first phone's screen goes dark**, the
    second one wakes; the list shows `focused` true only for `U2`, and `battery` has both `level` (0..1) and `percent`
    (0..100, the phone's own number). `ps -axo %cpu,command | grep -i '[p]honecap'` a few seconds later: one capture
    running (the focused phone's), not two.

15. **Doesn't stop answering after a while.** In Lotus, open the focused phone, tap around, then **leave it alone for
    5 minutes** with the view open (let the phone's own Auto-Lock turn the screen off if it does). Then tap once.
    -> the phone wakes and the tap lands, in one go (a second or two at most). Then:
    `grep -E '\[wda-heal\]|was dark|woke' server.log | tail -10` and
    `curl -s -H "$H" $B/api/devices | python3 -c 'import sys,json; [print(p["name"], p["stats"]["heals"], p["stats"]["lastHeal"]) for p in json.load(sys.stdin)]'`
    -> note every `[wda-heal]` line (each names why). Also do a burst: tap 15 times as fast as you can in Lotus; every
    tap should land, none should be stuck behind another. If a tap ever answers `got no answer within`, show me the
    `[wda-heal]` lines around that time.

16. **Info that keeps up.** With the phone open in Lotus, open Settings on it from Lotus (tap its icon): the card's app
    should switch to Settings within about 2 s, without reloading. Unplug its charger for 30 s and plug it back:
    `charging` follows within ~15 s.

    **Report back** for steps 13-16: the suite's last line; step 14's two answers (no secrets in them) and whether the
    first phone really went dark; step 15's `[wda-heal]` lines and `heals` numbers, how the tap after 5 minutes felt;
    step 16 yes/no. Never include the token.

---

## Our own WebDriverAgent build (2026-11-16): nothing to do by hand

From this version on the server runs **our own WebDriverAgent build** on the phones (`wda/` in this repo: Appium's
WebDriverAgent v16.15.3 with our changes, see `wda/LOTUS.md`). **You don't have to build, sign or install anything.**
The server does all of it by itself, with the same script, Apple team, certificate and bundle id as the 6-day
re-sign, so each phone's developer trust stays as it is (no re-trust in Settings).

**No manual re-sign is needed now.** Installing our build signs it afresh (a new 7-day profile), and the 6-day
re-sign counts from then and builds from `wda/` from then on.

### What the server does, per phone, after it pulls this version

1. About 20 s after it starts it sees that the phone's build is older than the repo's (`wda/LOTUS_FORK.json`).
2. It wakes the phone and **builds and signs** our build into `~/wda-fork-build` (3 to 8 minutes the first time).
   The stock WebDriverAgent keeps running meanwhile: the phone stays usable.
3. It **switches the phone's runner** to our build (the phone is out for about half a minute) and waits until it
   answers with its token on its own port (28100 + the phone's index, on the phone and on the Mac). Nothing
   listens on 8100 or 9100 any more for that phone.
4. If our build doesn't answer within 4 minutes, or the phone refuses the install, it **puts the stock
   WebDriverAgent back** at once and tries again later: after 2, 5, 15, 30, 60 and 180 minutes, then every 6 hours.
   It wakes the phone before each try.
5. Once our build runs it does a **live-touch self-test** on the phone (the WebDriverAgent app comes to the front
   for a few seconds, the screen goes black and comes back to the Home Screen). If the phone was dark it tries the
   self-test again every 10 minutes, six times.

### Watch it (optional)

```sh
curl -s -H "$H" $B/api/wda | python3 -m json.tool        # "fork": the version and each phone's state and reason
grep '\[wda-fork\]' server.log | tail -20
```

| `fork.perDevice.<udid>.state` | Meaning |
|---|---|
| `stock` | Not installed yet (it's about to be). |
| `building` | Being built and signed; the stock one runs. |
| `installing` | The runner is being switched. |
| `fork` | Our build runs. `version` is its number; `live` says what the self-test found. |
| `waiting` | The build failed; `reason` says why; `nextTryAt` says when it's tried again. The stock one runs. |
| `rolled-back` | Our build was installed but didn't start; the stock one was put back; tried again at `nextTryAt`. |

### When a hand IS needed (the same cases as the 6-day re-sign)

`reason` in `GET /api/wda` says which one:

- **"Xcode is not signed in to the Apple ID"**: open Xcode > Settings > Accounts, sign in, then nothing else: the
  next try picks it up (or `curl -s -X POST -H "$H" $B/api/wda/resign`).
- **"the phone needs attention (unlock it / Trust this computer)"**: unlock the phone once (or tap Trust). Our
  phones have no passcode, so this should not come up.
- **"the Apple Team ID is not known"**: only on a Mac where WebDriverAgent was never built. Put `WDA_TEAM_ID=` in
  `.env` and restart the service. (On this Mac the team is read from the WebDriverAgent that's already built.)
- **A compiler error** (`error: …` from a file under `wda/`): our changes were written without Xcode at hand. Send
  SUPRIM the output of
  `grep -E "error:" ~/wda-fork-build/build-wda-<UDID>.log | head -20`.
  Nothing is broken meanwhile: the phones stay on the stock WebDriverAgent.

To see a build's errors yourself: `WDA_BUILD_FLAVOR=fork scripts/build-wda.sh <TEAM_ID> <UDID>`.

### Checks, when someone is at the Mac (not required)

1. `curl -s -H "$H" $B/api/wda | python3 -m json.tool` -> every phone `"state": "fork"`, `"version": 1`.
2. The token gate. Find the phone's port (`fork.perDevice.<udid>.port`, 28100 for the first phone):
   `curl -i http://127.0.0.1:28100/status` -> `HTTP/1.1 404 Not Found`, `Content-Length: 0`, no JSON. That is what
   anything without the token gets. (The token is in `data/wda-tokens.json`; never paste it anywhere.)
3. Nothing on the old ports for that phone: `ps ax | grep '[i]proxy'` -> one `iproxy` per phone on our build
   (`28100:28100`), none with `:9100`.
4. `fork.perDevice.<udid>.live` -> `"tested": true` and `"mode": 1`, `2` or `3` (a live drag holds the finger down),
   or `"mode": 0` (no way worked on this iOS: drags are played whole on release, as before). Send SUPRIM its `notes`.
5. SUPRIM drags on the Phones page: the phone follows while the button is down.

### Settings (`.env`, all optional)

| Setting | Default | What |
|---|---|---|
| `WDA_FORK` | `true` | `false`: keep the stock WebDriverAgent (the server switches a phone back at its next start). |
| `WDA_FORK_BASE_PORT` | `28100` | Our build's port for the first phone, on the phone and on the Mac; the next phone's is one higher. |
| `WDA_FORK_PORTS` | none | A phone's own port: `udid=port,udid=port`. |
| `WDA_FORK_DERIVED_DATA` | `~/wda-fork-build` | Where our build is built. The stock one's (`WDA_DERIVED_DATA`) stays, for a rollback. |
| `WDA_LIVE_TOUCH` | `auto` | `auto`: live touch only with the mode the phone's self-test found. `off`: never. `on`: mode 1 without the self-test's word. |

During the switch-over both kinds run side by side: a phone still on the stock WebDriverAgent is talked to on
8100 (+ MJPEG on 9100) as before, one on ours on its own port with its token. The server knows which is which.
