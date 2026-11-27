# Phone farm update (2026-11-27, the rebuild): reload the launchd plist once

The Mac pulls, builds and restarts by itself. One thing it can't do itself: the plist now has `AbandonProcessGroup`
(so a server restart for an update no longer takes the phones' WebDriverAgent runners down with it), and launchd only
reads a plist when it's loaded. Until it's reloaded everything works as before, only restarts still restart WDA.

Paste this to Claude on the Mac mini:

---

In `~/phone-farm-server`, do NOT edit, commit or stash anything in the repo, and never print the token.
1. `git log --oneline -1` shows the rebuild's commit.
2. Copy the plist again, keeping this Mac's own paths: `diff deploy/com.lotus.phonefarm.plist
   ~/Library/LaunchAgents/com.lotus.phonefarm.plist`; put the `AbandonProcessGroup` lines (`<key>AbandonProcessGroup</key><true/>`)
   into the installed one, leaving its WorkingDirectory, log and node paths as they are.
3. `launchctl unload ~/Library/LaunchAgents/com.lotus.phonefarm.plist && launchctl load ~/Library/LaunchAgents/com.lotus.phonefarm.plist`
4. `launchctl print gui/$(id -u)/com.lotus.phonefarm | grep -i abandon` says it's set, and
   `curl -s localhost:${PORT:-8787}/health` answers with `build` and `forkVersion`.
5. Report the output of 1, 3 and 4 word for word.

---

# Phone farm update (2026-11-18, typing): nothing to do by hand

The Mac pulls, builds and restarts by itself. Then it builds **our WebDriverAgent v4** (new route `POST /lotus/field`:
read and clear the focused field) and installs it on each phone, one at a time, by itself. Text is typed through the
phone's own keyboard now (not the HID keyboard). To check, paste this to Claude on the Mac mini:

---

In `~/phone-farm-server`, do NOT edit, commit or stash anything. `set -a; . ./.env; set +a` (never print the token), then:
1. `git log --oneline -1` shows the typing commit (`fix(server): ... typing ...`).
2. `curl -s -H "Authorization: Bearer $API_TOKEN" localhost:${PORT:-8787}/api/wda | python3 -m json.tool`: each phone's
   fork `version` becomes `4` within ~15 minutes. If a phone says the build failed, report
   `tail -200 server.log | grep -iE "fork|error:"` word for word (v3 keeps running meanwhile; typing still works, only
   `clear` answers 501).
3. With a text field focused on a phone (tap one, e.g. Safari's address bar): `curl -s -X POST -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" -d '{"text":"hello","clear":true}' localhost:${PORT:-8787}/api/devices/<UDID>/type | python3 -m json.tool`
   should show `"cleared": true` and `"check": {"match": true, "expected_len": 5, ...}`, and the phone's on-screen
   keyboard should stay up while it types.

---

# Phone farm update (e7e5678): what to do on the Mac mini

Pushed: **3e99f8c** (the phonecap fix) + **e7e5678** (README line endings). The Mac pulls it by itself within ~5 minutes,
rebuilds and restarts. What changed: the compile error is fixed (`self.output.videoSettings`), the deprecated
notification names are updated, `h264_reason` now shows the real `error:` line, and the helper is now a signed mini app
(`native/phonecap/build/PhoneCap.app`, id `com.lotus.phonecap`) that asks macOS for Camera **as itself**, not as `node`,
so launchd no longer blocks it. It needs Camera allowed **once, by a person at the Mac** (or over Screen Sharing).

Paste this to Claude on the Mac mini:

---

In `~/phone-farm-server` (the phone farm server, run by launchd as `com.lotus.phonefarm`), do the following.
Do NOT edit, commit or stash anything in the repo: a dirty working tree blocks the auto-updater.

1. **Wait for the new commit.** `git fetch -q && git log --oneline -1 HEAD` until it shows `e7e5678` (or `3e99f8c`); the
   auto-updater does it within ~5 minutes. If it hasn't after 10 minutes: `tail -30 server.log | grep updater` and report
   why; to update by hand: `git pull --ff-only && npm run build && launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`.

2. **Confirm phonecap built.** `ls native/phonecap/build/PhoneCap.app/Contents/MacOS/phonecap` exists and there is no
   `native/phonecap/build/phonecap.error` (if there is, report `grep -n "error:" native/phonecap/build/phonecap.error`
   word for word). Also `codesign -dv native/phonecap/build/PhoneCap.app 2>&1 | grep Identifier` should say `com.lotus.phonecap`.

3. **Check the service runs in the GUI session.** `launchctl print gui/$(id -u)/com.lotus.phonefarm | head -5` must work
   (it must be in `~/Library/LaunchAgents`, not `/Library/LaunchDaemons`). If the installed plist lacks them, add
   `<key>LimitLoadToSessionType</key><string>Aqua</string>` and `<key>ProcessType</key><string>Interactive</string>`
   (see `deploy/com.lotus.phonefarm.plist`), then `launchctl unload` / `launchctl load` it.

4. **One-time Camera access (a human must click Allow).** Tell Rinor to run this himself in Terminal **at the Mac's
   screen** (or over Screen Sharing), because the prompt appears on the Mac's display:
   `~/phone-farm-server/native/phonecap/build/PhoneCap.app/Contents/MacOS/phonecap --request-access`
   - A "phonecap would like to access the camera" prompt appears: click **Allow**. It prints `authorized`.
   - If it says Camera was denied before: `tccutil reset Camera com.lotus.phonecap`, then run the command again.
   - Check: System Settings > Privacy & Security > Camera lists **phonecap**, switched on.
   - Then restart the server: `launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`.

5. **Check capture.** iPhones plugged in by USB, **unlocked and trusted**, QuickTime closed.
   `PC=native/phonecap/build/PhoneCap.app/Contents/MacOS/phonecap; $PC --list` shows each iPhone as `iphone-screen`;
   `$PC --udid <UDID> > /dev/null` logs `capturing ...` (Ctrl+C to stop).

6. **Confirm H.264 live video for both phones.**
   `set -a; . ./.env; set +a; curl -s -H "Authorization: Bearer $API_TOKEN" localhost:${PORT:-8787}/phones`
   (never print the token). Each phone: `stats.h264_available: true`, `h264_reason` null. Open the live view of each
   phone (from the owner's Lotus, or a stream WebSocket), then call `/phones` again and report per phone `stats.codec`
   (should be `h264`), `stats.fps`, `encode_ms`, `capture_to_encoded_ms` and `path`, plus
   `tail -60 server.log | grep -E "\[native\]|\[updater\]|phonecap|\[wda"` (log prefixes now use the UDID's last 8 chars).

Report back: the commit the Mac is on, whether phonecap built, the Camera result, and both phones' codec and FPS.

---

## Already automatic (nothing to do)
- Pulling new commits, `npm install` when packages change, `npm run build` (TypeScript + building and signing
  PhoneCap.app), restarting via launchd. The helper only rebuilds when `main.swift`/`Info.plist` change; after such a
  rebuild the Camera step (4) may be needed again (the ad-hoc signature changes), and `h264_reason` will say so.
