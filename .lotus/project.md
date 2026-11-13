# Phone Farm Server
Mac-mini server for an iPhone farm; Lotus's Windows "Phones" page talks to it. Code written on Windows, runs on the Mac.

## Decisions
- Node 20+/TypeScript, one runtime dep (`ws`). Own .env parser, own PNG encoder (mock), node:http router.
- Real mode: libimobiledevice (`idevice_id`, `ideviceinfo`, `iproxy`) for discovery/port-forward; one `xcodebuild test-without-building` of a pre-built, signed WebDriverAgent per phone (ports 8100+n WDA, 9100+n MJPEG, persisted in data/ports.json). Server drives WDA over HTTP directly (Appium not needed at runtime; only used as the convenient source of the WDA project: `appium driver install xcuitest`).
- Auth: `Authorization: Bearer <API_TOKEN>`; WS also accepts `?token=`. /health is open.
- Mock mode (`MOCK=true`): fake phones, generated PNG screenshots/frames.
- Review is off: only `npm run check` (tsc) and `npm test` (smoke test, mock mode).

## Structure
src/{index,config,server,types,mock,real,wda,mjpeg,png}.ts, scripts/{init-env.mjs,build-wda.sh}, test/smoke.ts, deploy/*.plist, README.md

## Progress
- 2026-11-10: initial full implementation written.
- 2026-11-10: README, launchd plist, build-wda.sh done; `npm run check` and `npm test` (7 checks, mock) pass. Real mode untested (needs Mac).
- 2026-11-13: input replaced per docs/BEST_METHOD.md: CoreDevice HID live touch (native/hid/hid_input.py, iOS 27+), patched WDA fast route /wda/lotus/touch (scripts/patch-wda.mjs via build-wda.sh), old WDA as fallback; receive->injected metered (GET /phones/:udid/input); far viewers: no playout-delay 0/0, keyframe every 10 s.
