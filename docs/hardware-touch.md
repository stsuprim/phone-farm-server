# Hardware touch for the iPhone farm (research, 2026-11-27)

Research only: no code changed, and nothing was measured on Rinor's Mac or phones. **(est.)** marks my own estimates.
Claims from hobby projects are marked as such: none of this is in Apple's documentation, so every one needs a test on
our iOS 18.5 phones before we rely on it.

## TL;DR

1. **What to build: one ESP32-S3 per phone, as a Bluetooth LE HID pointer and keyboard, driven by the Mac mini over
   USB serial.** AssistiveTouch turns a mouse button press into a finger down, a move while it's held into a live drag,
   and the release into a lift. The finger moves on the phone **as it moves in the viewer**, with no waiting for the up
   that WDA needs. The phone's own port stays on the Mac for capture, WDA and CoreDevice. Nothing gets installed on the
   phone, and no adapter is needed.
2. **Absolute positioning looks possible.** Several 2026 projects report that iOS takes an **absolute** pointer
   (X/Y 0..32767) while AssistiveTouch is on, and maps it straight to the screen. Two rules come with it. iOS ignores X/Y
   in a report that also changes a button. Buttons also have to come through a second, **relative** mouse report.
   ([xhoantran/iphone-use](https://github.com/xhoantran/iphone-use), Bluetooth;
   [esp32-iphone-agent PR #99](https://github.com/onehumanbeing/esp32-iphone-agent/pull/99), USB, iOS 27.3;
   [jinwon-int PR #19](https://github.com/jinwon-int/esp32-iphone-agent/pull/19)). Nobody reports this for iOS 18, so
   the firmware keeps a **relative fallback** with homing and calibration.
3. **Cost.** For 2 phones it's about **$34** (3 boards plus cables), or **$63** with a Lightning camera adapter for the
   USB experiment. For 10 phones it's about **$178** with a powered hub. Prices are below.
4. **What it can't do.** One finger only: no live pinch or rotate, and no multi-touch. An AssistiveTouch pointer shows
   on screen. Apps can read that AssistiveTouch is on. Bluetooth typing is US ASCII only. It doesn't replace WDA's or
   CoreDevice's reads, app launch or text.
5. **Where it fits.** It's a third route behind the server's existing `liveTouch` hook: CoreDevice HID on iOS 27, this
   hardware on iOS 18, and the WDA fork as the last fallback.

---

## 1. How others do real-time touch on iOS

| Approach | Who | Live drag? | Notes |
|---|---|---|---|
| XCTest / WebDriverAgent | BrowserStack App Automate, Sauce, Appium farms, Chinese "群控" WDA setups ([CSDN](https://gitcode.csdn.net/6a01523e0a2f6a37c5a91f03.html)) | No: a gesture is a whole path, played after it's built. Live only with tricks (our fork's segmented modes) | `/wda/tap` is about 0.9 s on the phone, about 263 ms patched ([appium-ios #87](https://github.com/appium/appium-ios/pull/87), our `BEST_METHOD.md`). Scrolls up to 20 s in bad cases ([Appium forum](https://discuss.appium.io/t/very-high-20s-latency-for-scrolling-ios-xcuitest-local-usb-local-appium-server/41272)) |
| AssistiveTouch for manual sessions | BrowserStack App Live documents AssistiveTouch on its real devices ([docs](https://www.browserstack.com/docs/app-live/ios-settings/assistive-touch)) and multi-finger gestures ([docs](https://www.browserstack.com/docs/app-live/advanced-features/multi-touch-gestures)) | Their injection path isn't public | We can only tell that clouds use AssistiveTouch too, not how |
| CoreDevice HID (Apple's Device Hub path) | Xcode 27 Device Hub; our `src/hid.ts` | Yes, multi-touch too | iOS 27 only in our tests. Xcode 27 betas broke simulator touch injection for some people ([Bitrise](https://bitrise.io/blog/post/wwdc-2026-device-hub-and-what-it-means-for-ci-cd), [Cursor forum](https://forum.cursor.com/t/self-hosted-macos-worker-computer-use-clicks-on-xcode-27-device-hub-simulator-dont-register-as-taps-screenshots-work-android-emulator-works/176076)) |
| BLE / USB HID mouse with AssistiveTouch | [esp32-iphone-agent](https://github.com/onehumanbeing/esp32-iphone-agent) (XIAO ESP32-S3), [HIDAgent](https://arxiv.org/html/2602.00492v1) (RP2040, CMU, under $30), [iphone-use](https://github.com/xhoantran/iphone-use) (the Mac's own BLE), [Mac_iPhone_touch](https://github.com/Heresyouyou/Mac_iPhone_touch), Gitee [bleTouch](https://gitee.com/woodcol/bleTouch) | Yes: a held button is a finger down | One pointer, AssistiveTouch has to be on |
| USB digitizer touchpad with iOS Zoom on | [aico-link PR #981](https://github.com/AidenAI-IO/aico-link/pull/981) (iOS 26, merged 2026-11-23) | Swipes "land where sent". Live drag not stated | **Direct touch with no pointer**, but it needs USB (the phone's only port) and Zoom on with AssistiveTouch off. Touchscreen descriptors and the absolute mouse were ignored in that mode |
| Robot finger | Tapster 2: $1,650, now retired and open-source ([Tapster](https://tapster-website.herokuapp.com/buy.html), [Tindie](https://www.tindie.com/products/hugs/tapster/)); [TestDevLab's build](https://www.testdevlab.com/blog/how-we-built-a-robot-for-automated-manual-mobile-testing) | Yes, physically | Slow, bulky, one per phone, needs mechanical calibration. Not worth it for us |
| Switch Control | Apple ([guide](https://support.apple.com/en-ug/119835)) | No: scanning with crosshairs | Accessibility for people, too slow for remote touch |

Conclusion: nobody gets live finger tracking on iOS 18 through XCTest. The ones that do use a **HID pointer** (or
Apple's private CoreDevice path on iOS 27).

## 2. Recommended approach

### Now: 2 phones

- **One XIAO ESP32-S3 per phone** (plus one spare), each on its own USB cable to the Mac mini, which powers it and
  talks to it over USB-CDC serial.
- Each board is a **BLE HID composite** bonded to exactly one phone. Report 1 is the keyboard, report 2 the absolute
  pointer, report 3 the relative mouse (buttons, dx, dy, wheel), and report 4 consumer keys (volume, play). This is
  the same layout Mac_iPhone_touch uses ([repo](https://github.com/Heresyouyou/Mac_iPhone_touch)).
- **Why Bluetooth and not USB HID:** the phones' single port is taken by the Mac (QuickTime-path capture, usbmuxd, WDA,
  CoreDevice). USB HID would need a Lightning Camera Adapter or a USB-C hub with pass-through, and that takes the phone
  off the Mac. Bluetooth leaves all of that alone.
- **Why one board per phone and not the Mac's own Bluetooth:** iphone-use shows the Mac itself can be the BLE HID
  peripheral (`CBPeripheralManager`, "tested with two iPhones at once"). It costs $0, and it's **worth a one-day spike
  first**. Its downsides are one shared radio and identity for every phone, and a macOS quirk where 16-bit HID UUIDs are
  rejected and the long form is needed ([Mac_iPhone_touch](https://github.com/Heresyouyou/Mac_iPhone_touch)). A macOS
  update could take it away, and a stuck pairing hits every phone at once. One board per phone isolates faults (a bad
  bond is one phone, fixed by one replug), costs about $7.50 a phone, and doesn't touch the Mac's Bluetooth.

### Scaling to about 10 phones

- 10 boards plus a spare on one **powered USB data hub** (boards draw about 0.1 to 0.3 W each when idle **(est.)**).
  Keep the boards on their own hub, apart from the phones' capture cables.
- **The radio:** each phone holds one BLE link to its own board, so the phone side is never near its limit. The
  practical BLE limits people report are 8 to 10 links per iPhone
  ([Apple bluetooth-dev](https://lists.apple.com/archives/bluetooth-dev/2016/Mar/msg00004.html)), and Classic
  Bluetooth's 7 doesn't apply. Ten BLE links in one room are fine. Put each board within about 30 cm of its phone, and
  label the board and the phone.
- **The Mac side:** 11 `/dev/cu.usbmodem*` serial ports, each told apart by the board's USB serial number (the
  ESP32-S3's MAC). Nothing grows on the Mac's Bluetooth.
- Past about 15 phones, add a second hub. Each hub can also go on its own Mac.

## 3. Parts list for Rinor

The phones are on iOS 18. The iPhone 14 Plus is **Lightning**, but none of this needs its port.

### 2 phones now

| # | Part | Qty | Unit (USD) | Total | Where |
|---|---|---|---|---|---|
| 1 | **Seeed Studio XIAO ESP32-S3** (plain, not Sense or Plus: the board esp32-iphone-agent tested) | 3 (2 + 1 spare) | $7.49 | $22.47 | [Seeed](https://www.seeedstudio.com) (list $7.49, [CNX](https://www.cnx-software.com/2023/03/22/xiao-esp32s3-tiny-esp32-s3-wifi-4-and-ble-5-0-module-for-iot-ai-robotics/), [Make: $7](https://makezine.com/products/boards/seeed-xiao-esp32s3)), DigiKey, Mouser. Amazon resellers are about $10 to $12 |
| 2 | Short USB-A to USB-C **data** cable, 0.5 m (not charge-only) | 1 five-pack | about $12 **(est.)** | $12.00 | Amazon (Anker, Amazon Basics, UGREEN) |
| | **Required total** | | | **$34.47** | plus shipping and tax |
| 3 | *Optional:* Apple Lightning to USB Camera Adapter, only for the USB absolute and digitizer experiment (§7), which takes the phone off the Mac while it runs | 1 | $29 (Apple US list, from memory: verify; resellers $40 to $75 abroad, [BuyWisely](https://buywisely.com.au/au/product/apple-lightning-to-usb-3-camera-adapter-1)) | $29.00 | apple.com |
| | **With the optional part** | | | **$63.47** | |

The Mac mini's own USB ports are enough for 2 boards. A USB-C Mac needs a USB-C to C cable or a hub instead.

### 10 phones

| Part | Qty | Unit | Total |
|---|---|---|---|
| XIAO ESP32-S3 | 11 | $7.49 | $82.39 |
| USB-A to C data cable, 0.5 m (five-packs) | 3 packs | about $12 **(est.)** | $36.00 |
| Anker 10-port 60 W USB 3.0 data hub (A7515) | 1 | $59.99 ([Anker](https://www.anker.com/products/a7515); CDW $61.84) | $59.99 |
| **Total** | | | **$178.38** |

The cheaper board is the XIAO ESP32-C3 at $4.99 ([CNX](https://cnx-software.com/?p=101082)). It has BLE and USB
serial, but **no USB HID**, so the USB fallback is gone. That saves about $28 for 11 boards, which isn't worth it.
Avoid a robot arm (Tapster 2 was $1,650 a unit).

## 4. Firmware (on the ESP32-S3)

- **Stack:** ESP-IDF 5.x with **NimBLE**, or Arduino-ESP32 3.x plus NimBLE-Arduino. Starting points: the
  esp32-iphone-agent firmware (absolute mode built with `flash.sh --abs`) and the serial-driven
  [asterics/esp32_mouse_keyboard](https://github.com/asterics/esp32_mouse_keyboard).
- **HID over GATT:** the composite map from §2, with X/Y 16-bit 0..32767 on report 2. The HID characteristics need
  **encryption**. Without it, iOS subscribes but shows no pointer and reports no error
  ([Mac_iPhone_touch](https://github.com/Heresyouyou/Mac_iPhone_touch)).
- **Bonding:** pair once through AssistiveTouch → Devices → Bluetooth Devices. Store the bond in NVS
  (`CONFIG_BT_NIMBLE_NVS_PERSIST=y`), or it's lost on every power cycle
  ([esp32.com](https://esp32.com/viewtopic.php?p=51554)). Keep one bond per board and refuse new pairings unless the
  server sends `PAIR`. When the link drops, advertise directed to the bonded phone at a fast interval (20 to 30 ms) for
  30 s, then slow down.
- **Connection parameters:** within Apple's rules (min ≥ 15 ms, a multiple of 15, max ≥ min + 15; supervision timeout
  6 to 18 s). Ask for 15 to 30 ms. Some iPhones accept 11.25 ms for HID
  ([Apple forum](https://developer.apple.com/forums/thread/796428),
  [Silabs](https://docs.silabs.com/bluetooth/8.3.0/mobile-apps-suitable-connection-parameters)). Take whatever iOS
  offers. iOS 26 sends repeated parameter updates, and the firmware must accept them
  ([Nordic](https://devzone.nordicsemi.com/f/nordic-q-a/124468/repeated-connection-interval-updates-on-ios-26/549156)).
- **Touch:**
  - `down(x,y)`: send an absolute move, wait one connection interval (PR #99 used 60 ms: tune it down), then a
    relative report with button 1 set and dx = dy = 0.
  - `move(x,y)` while held: an absolute report. If the test shows iOS ignores absolute moves while the button is down,
    send relative deltas instead (§6). Keep **only the newest target** per connection interval: moves never queue.
  - `up`: a relative report with the button cleared.
  - **Hold repeat:** re-send the current state every 100 ms while held, or iOS treats the finger as idle
    ([Mac_iPhone_touch](https://github.com/Heresyouyou/Mac_iPhone_touch)). This matches the server's existing
    `holdRepeatMs`.
  - **Safety:** while held with no host message for 2 s, release the button. Lift on USB loss or a watchdog reset.
- **Keyboard:** US layout keycodes, text in chunks, and an `attach`/`detach` switch for the keyboard. While a hardware
  keyboard is attached, iOS hides the on-screen keyboard
  ([aico-link #981](https://github.com/AidenAI-IO/aico-link/pull/981)), so leave it detached by default.
- **Buttons 2 and 3:** in AssistiveTouch's device settings, map them to Home and App Switcher. That gives the server
  hardware buttons without XCTest.

## 5. Protocol from the server to the board, and where it plugs in

**USB-CDC serial**, not Wi-Fi, MQTT or WebSocket. Delivery is deterministic at about 1 ms (USB full speed), the same
cable powers the board, and there's no network setup or broker hop. MQTT adds a broker and QoS jitter. Wi-Fi only
makes sense for a board too far from the Mac, and then it would be a WebSocket with the same messages.

Newline-delimited ASCII, one line per message (the baud rate doesn't matter on CDC):

```
host → board                          board → host
D <seq> <x> <y>      down             ok <seq> <us>        written to the radio (µs on the board)
M <seq> <x> <y>      move (coalesced) ev conn <peer> <ci_ms>   linked, with the connection interval
U <seq> <x> <y>      up               ev disc <reason>
R <seq> <dx> <dy> <btn>  raw relative  ev bond <peer>
B <seq> <home|switcher>  button 2/3   err <seq> <text>
K <seq> <hex-utf8>   type (US ASCII)  pong <seq> <board-ms>
KA / KD              keyboard attach/detach
P <seq>  ping       I  identify (MAC, fw, bond, mode)
PAIR / UNPAIR / MODE abs|rel
```

x and y are 0..32767 in the phone's **portrait** screen space. The server's `orient.ts` already maps points for HID
(`pointsToHid`).

**Server side**, as a new `src/esp.ts`. It follows the shape of `hid.ts`, but I haven't written it.

- It opens each `/dev/cu.usbmodem*` port, sends `I`, and binds the board's MAC to a phone UDID from
  `data/esp-map.json`, which identification makes (§6, step 2).
- `real.ts`'s `liveTouchReady(udid)` becomes CoreDevice HID ready, **or** the ESP board linked (`ev conn`) and
  calibrated. `liveTouchWhy` gives "touch board not linked", "not calibrated" and so on. `liveTouch(udid, phase, x, y)`
  sends `D`, `M` or `U` and resolves on `ok`.
- Nothing changes in `control.ts`. It already gives live down, move and up for the owner's touch, holds the newest move
  in `next` instead of queueing, repeats the hold, lifts on lost senders, and falls back to buffered WDA when
  `liveTouch` fails. The `via` in acks and the meter gains `"esp"`.
- The order: CoreDevice HID (iOS 27), then the ESP board (iOS 18), then the WDA fork's live modes, then WDA played whole
  on up. Lotus's own swipes can use the board too, since `swipePlan` already steps at 16 ms.
- Reads, app launch, text and the clipboard stay on WDA and CoreDevice, through `lane.ts`.

**Latency (est.):** viewer → Mac is the network. Then Mac → board under 2 ms, board → phone half a connection interval
to one (8 to 30 ms), and iOS's touch pipeline plus one frame (17 to 35 ms). That's about **30 to 65 ms on the phone**,
next to about 263 to 900 ms for WDA's tap. Moves go at the connection interval's rate (33 to 89 Hz), which keeps a
drag smooth.

## 6. Setup and calibration, per phone

1. **Phone settings** (once):
   - Accessibility → Touch → **AssistiveTouch on**, Always Show Menu off, Idle Opacity at its lowest. Pointer Control:
     smallest pointer, Auto-Hide on (1 to 2 s). Dwell off.
   - Settings → General → Trackpad & Mouse: tracking speed left at its default, written down, and never changed again,
     because the relative fallback depends on it ([Apple](https://support.apple.com/en-us/111775)).
   - **Zoom off.** Auto-Lock Never (iphone-use needs this too).
   - Map buttons 2 and 3 to Home and App Switcher.
   - An iOS Shortcut automation can turn AssistiveTouch on when the board connects and off when it disconnects
     ([Apple Community](https://discussions-jp-prz.apple.com/thread/256144633)).
2. **Pair and identify:** the server sends `PAIR` to one unbound board, and Rinor pairs "Lotus Touch NN" under
   AssistiveTouch → Devices → Bluetooth Devices. The server then moves that board's pointer in a small circle and diffs
   every phone's capture to see which screen moved (iphone-use's method). It writes MAC ↔ UDID to `esp-map.json`.
3. **Absolute check (9 points):** send the pointer to a 3×3 grid at 10, 50 and 90 % of each axis. After each point,
   find the pointer in the capture by template match (a gray circle). Fit per-axis scale and offset. A residual under
   1 % (about 4 pt) and stable for 3 runs means **abs mode**, saved per phone. If it doesn't move, or is off by more
   than 3 %, it's **rel mode**.
4. **Relative mode:**
   - **Homing:** 40 reports of (-127, -127) pin the pointer to the top-left corner.
   - **Gain curve:** for step sizes 1, 2, 4, 8, 16 and 32, send 20 steps and measure the distance travelled in the
     capture. That gives points per count per step size, which shows the acceleration. Production then moves in a
     fixed small step (HIDAgent uses 10 px steps "to avoid acceleration effects",
     [paper](https://arxiv.org/html/2602.00492v1)).
   - **Drift:** re-home before each `down` that comes after more than 2 s idle. Correct with the pointer finder when
     the miss is over 2 %. esp32-iphone-agent does the same: it "wiggles the pointer, finds it on screen and corrects
     the miss" ([README](https://github.com/onehumanbeing/esp32-iphone-agent)).
5. **Live-drag check:** a slow 3 s drag across a Notes canvas or a list. The capture should show the content following
   the pointer during the drag, not only at its end. Also check a fast 120 ms flick, a 1 s long-press, and two taps
   400 ms apart (aico-link lost a second tap at 400 ms).
6. **Landscape:** repeat step 3 once in landscape. iOS 16.5 had a bug where the pointer couldn't pass the centre in
   landscape ([Apple forum](https://developer.apple.com/forums/thread/786963)).
7. **Recalibrate** after an iOS update, a change in pointer or tracking settings, a re-pair, or when the pointer finder
   sees drift over 3 % twice in a row.

## 7. Experiments, in order (each about half a day)

1. **The Mac as the peripheral** (free): run iphone-use against the iPhone 14 Plus on iOS 18.5. Do absolute moves
   work? Does a held-button drag go live?
2. **One XIAO ESP32-S3** with esp32-iphone-agent's firmware in Bluetooth mode, absolute build. Check the same two
   things, plus reconnect after phone reboot, board replug and Bluetooth off/on.
3. **Optional, USB:** the digitizer touchpad from aico-link with Zoom on, through the camera adapter. It's direct touch
   with no pointer, but only while the phone is off the Mac. Only pursue it if (1) and (2) fail and a hub that passes
   both USB data and HID turns out to work.

## 8. Honest limits on iOS

- **One finger.** No live pinch, rotate or two-finger scroll. AssistiveTouch's menu has canned multi-finger gestures,
  but they aren't live. Pinch to zoom in apps stays on CoreDevice (iOS 27) or WDA.
- **Absolute positioning is community-verified only** (iOS 26 and 27, plus an unknown version). iOS 18 is untested
  until step 2 of §7. Relative mode drifts: a miss of a few points needs the pointer finder.
- **No HID digitizer over BLE.** iOS and iPadOS have no external touchscreen support or HIDDriverKit, and touchscreen
  descriptors are ignored ([Apple forum](https://developer.apple.com/forums/thread/707559),
  [aico-link #981](https://github.com/AidenAI-IO/aico-link/pull/981)). The one digitizer route is USB with Zoom on.
- **Visible pointer.** A gray circle sits on screen, and it probably shows in capture (auto-hide helps).
  AssistiveTouch's floating button may appear when the menu is set to always show.
- **Detectable.** Apps can read `UIAccessibility.isAssistiveTouchRunning`, a public UIKit API. I know it from Apple's
  UIKit docs but didn't fetch the page this session. An app that cares can see AssistiveTouch is on.
- **Keyboard:** US ASCII only. Emoji and accents need the clipboard, which stays on WDA. With a mouse and a keyboard
  both attached, iOS has misrouted modifier shortcuts to SpringBoard
  ([HF write-up](https://huggingface.co/blog/NatalieY/debugging-aiden)). Keep the keyboard detached unless typing.
- **No reads.** It's blind: it can't find elements, the app in front or text. WDA and CoreDevice stay.
- **Hold edge cases.** With no reports, iOS sees a held finger as idle (hence the 100 ms repeat). A long-press menu or
  a drag-and-drop pickup may need a few points of motion, which is the aico-link note about its 200-unit activation
  move.
- **The lock screen:** the pointer works there, but the passcode needs the keyboard or taps. Avoid it: Auto-Lock Never.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Absolute moves are ignored on iOS 18 | Relative mode with homing and the pointer finder (§6.4). Latency is the same; accuracy is about ±2 % until corrected |
| Bonds get lost or a board won't reconnect after a phone reboot ([Apple forum](https://developer.apple.com/forums/thread/695730)) | NVS bonds, directed advertising, a `ev disc` alert in Lotus's phone card, and Forget plus re-pair as the documented fix |
| 2.4 GHz crowding with 10 boards and Wi-Fi | Boards near their phones, one link per board, BLE's channel hopping. Watch `ev disc` rates |
| An iOS update changes AssistiveTouch behaviour | Recalibration and the live-drag check (§6.5) after each update. WDA stays as the fallback |
| A touch stuck down | Board-side 2 s release, the server's existing touch-release timers, and a lift on USB loss |
| A charge-only cable | Buy data cables. `I` must answer within 1 s of the port appearing |
| Apps flag AssistiveTouch | It can't be avoided with this method. CoreDevice HID on iOS 27 doesn't need it |

## 10. Compared with the current WDA-fork path

| | WDA fork (now, iOS 18) | CoreDevice HID (`hid.ts`, iOS 27) | **ESP32-S3 BLE HID (proposed)** | Mac as BLE peripheral | USB HID or digitizer through an adapter |
|---|---|---|---|---|---|
| Live drag as the finger moves | Only the fork's live or segmented modes, on some phones. Otherwise played on up | Yes | **Yes** (a held button is a finger) | Yes | Yes |
| Tap latency on the phone (est.) | about 263 ms fast, about 900 ms stock | about 60 to 100 ms | **about 30 to 65 ms** | about 30 to 65 ms | about 20 to 50 ms |
| Multi-touch | WDA's W3C actions, played whole | Yes | No | No | No |
| Absolute coordinates | Yes | Yes | Yes if iOS honours it, else relative plus calibration | Same | Yes (abs mouse or digitizer) |
| Keeps the phone's USB for capture and WDA | Yes | Yes | **Yes** | Yes | **No** |
| Depends on XCTest health | Yes (lane, jams, replug) | No | **No** | No | No |
| Phone settings needed | Developer mode, a signed runner | iOS 27 and a pairing | AssistiveTouch on, one pairing | AssistiveTouch on, one pairing | AssistiveTouch, or Zoom with a digitizer |
| Visible or detectable | XCTest is detectable by some apps | Nothing on screen | A pointer, and `isAssistiveTouchRunning` | Same | Same, or Zoom on |
| Text input | Yes, any Unicode | Yes | US ASCII | US ASCII | US ASCII |
| Hardware cost | $0 | $0 | **about $7.50 a phone, about $178 for 10** | $0 | about $30 a phone, plus a hub |
| Scaling risk | XCTest per phone | Apple's private API | One board per phone, isolated | One radio for all | One port per phone |

**Verdict:** for iOS 18 phones, the ESP32-S3 BLE board is the cheapest way to get a finger that follows the owner's
drag live. It goes beside CoreDevice HID and WDA, not instead of them. Try the free Mac-as-peripheral spike first. If it
holds, the boards are still the more robust choice from about 5 phones up.
