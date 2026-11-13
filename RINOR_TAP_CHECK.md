# Fast taps: check on the Mac mini

What changed: taps no longer go through WebDriverAgent's `/wda/tap` (about 0.9 s on the phone itself, which made the
~1.2 s taps). Each tap, swipe or text now takes the first of these that the phone has (see README, "Input", and
`docs/BEST_METHOD.md`):

1. **`hid`**: Apple's CoreDevice HID touch (Xcode 27 Device Hub's path), **iOS 27+ phones only**. Expected: a few ms on
   the Mac, with drags live.
2. **`wda-fast`**: a new WDA route, `POST /wda/lotus/touch`, with no active-app lookup that answers as soon as the touch
   is queued. **WDA must be rebuilt once** for this route to exist (step 3).
3. **`wda`**: the old route, as a fallback.

The server logs every action's receive → injected time and serves it at `GET /phones/<UDID>/input`.

One-time manual steps for Rinor: **step 3** (rebuild WDA, about 2 minutes, no clicking unless Xcode asks for keychain
access) and, only if a phone runs iOS 27, **step 4** (a Python venv). Don't update the iPhones' iOS for this. It can't be
undone, and that decision belongs to the owner.

Paste everything below the line to Claude on the Mac mini:

---

The phone farm server repo is the folder launchd runs as `com.lotus.phonefarm`. Find it with
`launchctl print gui/$(id -u)/com.lotus.phonefarm | grep -i "working directory"` (usually `~/phone-farm-server`), `cd`
there, and do the following. Don't edit, commit or stash anything inside the repo (a dirty tree blocks the auto-updater).
Don't update iOS on the phones. Never print the API token. Read it into a variable with
`TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2-)`, use `H="Authorization: Bearer $TOKEN"` and `B=http://localhost:8787`.
The phones are iPhone-1 `00008110-0008185134F9401E` and iPhone-2 `00008110-00011D903E53A01E`, and the team ID is
`L9HP78DHB9`.

1. **Confirm the update.** `git fetch -q && git log --oneline -3`. HEAD must be the commit
   "feat(input): replace WDA taps with CoreDevice HID live touch + a fast WDA route" (or newer), and
   `ls native/hid/hid_input.py scripts/patch-wda.mjs` must list both files. The auto-updater does this within about
   10 s of a push, plus the build time. If it hasn't happened after 5 minutes, run `grep updater server.log | tail -20` and
   report it. To update by hand: `git pull --ff-only && npm run build && launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`.

2. **Phones' iOS and the current input methods.** For each UDID: `ideviceinfo -u <UDID> -k ProductVersion`, then
   `curl -s -H "$H" $B/phones/<UDID>/input | python3 -m json.tool | head -30`. Note `methods.hid`, `methods.hid_reason`
   and `methods.wda_fast`. `wda_fast` reads `unknown` until the first tap after a restart, and `no` while WDA is unpatched.

3. **Rebuild WDA with the fast touch route (one time).**
   `scripts/build-wda.sh L9HP78DHB9 00008110-0008185134F9401E 00008110-00011D903E53A01E`
   - It first runs `node scripts/patch-wda.mjs "$WDA_PROJECT"` ("added the Lotus fast touch route (v1)"), then builds for
     each phone. If Xcode asks for keychain access, Rinor has to click **Always Allow** at the Mac.
   - **If a build fails:** report the `error:` lines it prints, word for word (the full log is
     `~/wda-build/build-wda-<UDID>.log`, or under `$WDA_DERIVED_DATA`). Then restore the working runner:
     `node scripts/patch-wda.mjs "$(grep '^WDA_PROJECT=' .env | cut -d= -f2-)" --remove && WDA_PATCH=0 scripts/build-wda.sh L9HP78DHB9 00008110-0008185134F9401E 00008110-00011D903E53A01E`,
     then restart. Taps then keep working the old way.
   - Then restart so the runners use the new build: `launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`, and wait
     until `curl -s -H "$H" $B/phones | python3 -c "import json,sys;[print(p['name'],p['ios'],p['ready'],p['control']) for p in json.load(sys.stdin)]"`
     shows both phones `True ready` (30-60 s).
   - If a phone says the developer isn't trusted: on that phone go to Settings > General > VPN & Device Management and trust it.

4. **Only for a phone on iOS 27 or later: live HID touch (one time).**
   `python3 -m venv ~/.phonefarm-hid && ~/.phonefarm-hid/bin/pip install -U pymobiledevice3`, then
   `launchctl kickstart -k gui/$(id -u)/com.lotus.phonefarm`. Check it by hand:
   `PYMOBILEDEVICE3_UDID=<UDID> ~/.phonefarm-hid/bin/pymobiledevice3 developer core-device universal-hid-service tap 32768 3000`
   should tap the top middle of the screen (no root needed). On iOS 18 phones, skip this step: `methods.hid` reads
   `unsupported` with "needs iOS 27 or later", which is expected.

5. **Test taps on both phones.** For each UDID:
   - Open Settings so the taps are harmless: `curl -s -X POST -H "$H" -H 'content-type: application/json' -d '{"bundleId":"com.apple.Preferences"}' $B/phones/<UDID>/launch`
   - Tap the status bar 10 times (it only scrolls to the top), timing each one end to end:
     `for i in $(seq 10); do curl -s -o /dev/stderr -w ' total=%{time_total}s\n' -X POST -H "$H" -H 'content-type: application/json' -d '{"x":195,"y":12}' $B/phones/<UDID>/tap; sleep 0.3; done`
     Each answer looks like `{"ok":true,"via":"wda-fast","ms":12.3}`. `via` is the method and `ms` is the server's receive
     → injected time.
   - Check that a tap really lands. Take a screenshot (`curl -s -H "$H" $B/phones/<UDID>/screenshot -o /tmp/s.png`),
     look at it, tap the **General** row at its point coordinates (screenshot pixels ÷ the phone's `scale` from
     `GET /phones`), take another screenshot and check that the General page opened. Then tap the back arrow
     (about x=30, y=60).
   - Test a swipe: `curl -s -X POST -H "$H" -H 'content-type: application/json' -d '{"x1":195,"y1":600,"x2":195,"y2":250,"ms":300}' $B/phones/<UDID>/swipe`.
     Settings should scroll, and the answer says the `via`.
   - Read the summary: `curl -s -H "$H" $B/phones/<UDID>/input | python3 -m json.tool | head -40` (`tap_avg_ms`,
     `tap_p90_ms`, `methods`, the last actions), plus `grep '\[input' server.log | tail -15`.
   - If `via` is still `wda` after step 3, run `node scripts/patch-wda.mjs "$(grep '^WDA_PROJECT=' .env | cut -d= -f2-)" --check`
     and `grep -E '\[wda .*(fast|lotus)' server.log | tail`, and report both.

6. **Report back, per phone:** iOS version, `methods` (hid, hid_reason, wda_fast), the `via` of the taps and the swipe,
   `tap_avg_ms` and `tap_p90_ms` from `/input`, the curl `total=` times (min/avg/max), whether the General tap visibly
   worked, and how long a tap *looks* on the phone (tap → visible change, by eye, roughly). Also report any WDA build
   error lines and any `[hid ...]` or `[wda ...]` warnings in `server.log`. Expected: `wda-fast` with server
   `ms` around 10-40 and curl totals under ~60 ms on the LAN (it was ~1200 ms). With `hid`, `ms` around 2-10.
