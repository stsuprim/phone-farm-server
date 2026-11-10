# Setup prompt for Claude Code on the Mac mini

Paste everything below the line into Claude Code on the Mac, started inside the project folder
(`phone-farm-server`). Do not put the API token in the chat; it lives in `.env` only.

---

You are setting up the "Phone Farm Server" on this Mac mini (macOS). It is a Node/TypeScript server that
discovers USB iPhones, runs one WebDriverAgent (WDA) per phone, and serves an authenticated HTTP/WebSocket API.
Read `README.md` first. Work step by step, run each check, and stop and tell me if a step needs me
(Apple ID sign-in, phone passcode, "Trust This Computer", keychain prompts). Never print, log or paste the contents
of `.env` or the API token; if you must confirm it exists, check only that the file is there and the key is set.

1. **Node**: run `node -v`. Need v20 or newer. If missing/old: check for Homebrew (`brew -v`; install from https://brew.sh if absent),
   then `brew install node`.
2. **libimobiledevice**: run `brew install libimobiledevice libusbmuxd ideviceinstaller`. Verify `idevice_id -l`,
   `ideviceinfo` and `iproxy` are on PATH (`which idevice_id ideviceinfo iproxy`). Plug in my iPhones; if `idevice_id -l`
   is empty, tell me to unlock each phone and tap Trust.
3. **Xcode checks**: confirm full Xcode (not just Command Line Tools): `xcode-select -p` should point inside
   `/Applications/Xcode.app`. If not: tell me to install Xcode from the App Store, then run
   `sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -runFirstLaunch && sudo xcodebuild -license accept`.
   Check `xcodebuild -version`. Check that an Apple Development signing identity exists
   (`security find-identity -v -p codesigning`); if not, ask me to sign in under Xcode > Settings > Accounts.
   Ask me for my Apple **Team ID** (Xcode > Settings > Accounts, or developer.apple.com > Membership).
   Remind me each phone needs Settings > Privacy & Security > Developer Mode on (reboot required).
4. **Appium + WDA project**: `npm i -g appium && appium driver install xcuitest`. Find the WebDriverAgent folder
   (should be `~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent`; confirm it contains
   `WebDriverAgent.xcodeproj`, otherwise search under `~/.appium`).
5. **npm install**: in the project folder run `npm install`, then `npm run check` and `npm test` (mock-mode smoke test; must pass).
6. **init-env**: run `npm run init-env` (creates `.env` with a random token if absent; it will not overwrite).
   Then edit `.env` with a command that changes only the non-secret lines: set `WDA_PROJECT=<folder from step 4>` and
   `MOCK=false`. Do not print the file. Tell me where `.env` is so I can copy the token to the Windows app myself.
7. **build**: `npm run build`.
8. **build-wda**: collect UDIDs from `idevice_id -l`, then run `scripts/build-wda.sh <TEAM_ID> <UDID> [<UDID> ...]`.
   Allow keychain prompts (tell me to click Always Allow if one appears). If signing fails, report the exact xcodebuild error
   and fix provisioning (e.g. phone not trusted, Developer Mode off, bundle id clash) before retrying. On each phone, if prompted,
   trust the developer certificate in Settings > General > VPN & Device Management.
9. **start**: run `npm start`. Wait about 30 seconds, then verify without exposing the token, using shell variables
   read from `.env` inside the command (e.g. `set -a; . ./.env; set +a; curl -s -H "Authorization: Bearer $API_TOKEN" localhost:${PORT:-8787}/phones`) and
   show me only the JSON list (udid, name, model, iOS, battery, online, ready). Also fetch one `/phones/<udid>/screenshot` to a file and
   confirm it is a valid image. If `ready` stays false, read the `[wda xxxxxxxx]` log lines and diagnose.
10. **Report**: tell me the Mac's LAN IP (`ipconfig getifaddr en0`) and Tailscale IP if installed (`tailscale ip -4`),
    the port, which phones are ready, and what is left. Offer (do not do without my yes) to install the launchd service from
    `deploy/com.lotus.phonefarm.plist` (edit paths first) so it starts at login.
