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
