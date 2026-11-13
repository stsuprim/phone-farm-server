# Phone farm: the best method for remote view and touch (research, 2026-11-13)

Scope: research and code reading only (no repo changes). Repo read at `e86d204`
(`C:\Users\PREDATOR\Desktop\LOTUS\projects\phone-farm`); Lotus client read in
`source\modules\phones\ui\phones.js` and `phones-live.js`. Numbers marked **(est.)** are estimates.
Numbers with a link were measured by someone else. Nothing here was measured on Rinor's Mac.

---

## TL;DR

1. **Video: keep the method and fix the sender.** USB screen capture, then hardware H.264, then WebRTC
   over UDP is the right family for a viewer 180 ms away. Device clouds and Apple's own Device Hub
   do the same (a hardware codec over RTP/UDP). WebSocket/TCP and MJPEG are the wrong method at
   that distance. The weak part is the **WebRTC sender**. libdatachannel has no transport-wide
   congestion control (TWCC), no delay-based bandwidth estimation (BWE) and no forward error
   correction (FEC). Our code sends whole frames in one burst with no pacing, forces a keyframe
   every 2 s, and sets `playout-delay` to min=max=0. That setting makes Chrome drop late frames
   and ask for keyframe after keyframe on a jittery link. Those choices together explain
   "Remote · 4 fps".
2. **Taps: the method is the bottleneck, not the code.** `/wda/tap` costs about 0.9 s on the
   phone itself. Each call resolves the active app through accessibility, then XCTest waits for
   the daemon to confirm the event. Zeroing the idle waits only saves about 2 %
   ([appium-ios PR #87](https://github.com/appium/appium-ios/pull/87)). That's Rinor's 1200 ms.
   The best method on iOS 27 is **Apple's own CoreDevice HID touch path**, the one Xcode 27's
   Device Hub uses. It sends real down/move/up touch reports straight to backboardd, with no
   XCTest, live drags and multi-touch. On iOS 18 (Rinor's test iPhone 14 Plus runs 18.5) the best
   option is a **patched WDA fast tap**: no active-app lookup, and it answers before injection.
   That's about 263 ms instead of about 900 ms (PR #87).
3. **Expected after the plan (est.):** LAN 60 fps, about 50 to 80 ms video, and taps visible in
   about 60 to 100 ms with HID (about 300 ms with WDA fast). Nepal 30 to 60 fps at 1.5 to 3 Mbps
   and about 150 to 250 ms video. A tap or drag shows on screen about 250 to 350 ms after the
   finger with HID, and about 550 to 700 ms with WDA fast. Today it's 1.3 to 2 s+.

---

## 1. Is the current video architecture the right method for a viewer ~180 ms away?

### What's built (code)
- `native/phonecap/main.swift`: CoreMediaIO/AVFoundation USB screen capture (the QuickTime path),
  then VideoToolbox H.264 with low-latency rate control (`kVTVideoEncoderSpecification_EnableLowLatencyRateControl`,
  L663). Constrained Baseline, no B-frames, **`keySeconds = 2.0`** (L45, applied L692-693).
- `src/rtc.ts`: node-datachannel/libdatachannel sender with host candidates only (L183). It uses
  `H264RtpPacketizer(..., 1200)` (L216) and `RtcpNackResponder` (L218), and sets
  **`playoutDelayMin = 0; playoutDelayMax = 0`** (L212-213). Each frame goes in one
  `sendMessageBinary` (L333) with **no pacer**. Congestion control is loss-only, once a second,
  and only cuts above 10 % loss (L300-308).
- `src/h264.ts`: **one shared encoder per phone**, run at the lowest viewer's target (L320-336). So
  when the owner watches from Nepal, Rinor's LAN view drops to Nepal quality.
- Lotus client (`phones-live.js` L304-327): a recvonly H.264 transceiver,
  `jitterBufferTarget = 0`, and data channels `input` (unordered, no retransmits) and `input-r`
  (reliable). Fallbacks: H.264 over WebSocket (WebCodecs), then MJPEG.

### Verdict: right method, wrong sender settings
| Option | For 180 ms RTT with some loss | Verdict |
|---|---|---|
| MJPEG over WS (WDA mjpeg-server) | Slow phone-side screenshots (7-20 fps), and TCP queues seconds (repo's own `docs/latency.md`) | No |
| H.264 over WebSocket + WebCodecs (ws-scrcpy style) | TCP head-of-line blocking: one loss stalls every later frame for an RTT or more. That's the 3.9-7.3 s the repo measured (`docs/latency.md`, "Far links") | Fallback only |
| WebTransport datagrams + WebCodecs | Possible (WebView2 has both), but we'd write our own congestion control, FEC and jitter handling. Node has no mature server side | Not now |
| **WebRTC (RTP/UDP) with a real congestion-control stack** | Built for this: delay-based GCC on TWCC feedback, pacing, NACK/RTX, FEC, frame dropping | **Yes: keep it, fix the sender** |

Why our WebRTC still collapses at 180 ms (each point checked against the code):
1. **`playout-delay` min=max=0 on a jittery path.** With max=0, libwebrtc renders "as soon as
   possible" and has no slack for late frames. They are dropped before decode, the decoder starves,
   and Chrome sends PLIs again and again. One field report showed 2558 packets received with 0 lost
   but only 3 frames decoded, 31 dropped and 71 PLIs
   ([moonlight-web-stream PR #8](https://github.com/spacedouut/moonlight-web-stream-simplified/pull/8)).
   Advice for the public internet is a max of about 50-100 ms ([lazyharu](https://lazyharu.com/en/webrtc-playout-delay/)).
   A receiver-side `jitterBufferTarget = 0` already asks for "the bare minimum delay the UA can
   provide" without forcing drops ([Chrome intent to ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/4W4orKqA3Rs)).
   The client already sets that.
2. **No pacing, plus big periodic keyframes.** A full-resolution IDR is 100-300 KB
   (`docs/latency.md`), which is 80-250 RTP packets sent at once every 2 s and after every PLI. On a
   long international path that burst overflows a shallow buffer, which causes loss, then a PLI, then
   another keyframe: a loop. libdatachannel has a `PacingHandler` (`include/rtc/pacinghandler.hpp`,
   with `setBitrate` and a max queue), and node-datachannel 0.33.6 wraps it
   (`src/cpp/media-pacinghandler-wrapper.cpp`). We don't use it.
3. **Loss-only congestion control reacts late.** GCC is mainly **delay-based**: it backs off when
   the one-way delay starts to grow, before any loss. Loss-based control only acts once buffers
   overflow, after the latency is already there. libdatachannel has no TWCC and no internal
   bandwidth estimation ([libdatachannel discussion #505](https://github.com/paullouisageneau/libdatachannel/discussions/505)).
   Pion has a TWCC interceptor and a send-side GCC estimator
   (`gcc.NewSendSideBWE`, `OnTargetBitrateChange`) that feeds your encoder's bitrate
   ([pion/webrtc #2437](https://github.com/pion/webrtc/discussions/2437),
   [pion TWCC](https://www.mintlify.com/pion/interceptor/interceptors/twcc)). GStreamer has `rtpgccbwe`.
4. **No FEC.** At 180 ms RTT every NACK retransmit costs at least 180 ms, so the picture freezes
   for that long on each loss. Pion ships a production FlexFEC-03 encoder
   ([pion FEC blog](https://pion.ly/blog/fec-with-pion/), [pkg flexfec](https://pkg.go.dev/github.com/pion/interceptor/pkg/flexfec)).
   Chrome/WebView2 receive RED/ULPFEC by default; FlexFEC receive is behind a field trial (from
   memory, to verify: `WebRTC-FlexFEC-03-Advertised`), which WebView2 can enable through its
   browser arguments.
5. **The encoder isn't shaped for a far viewer.** Low-latency VideoToolbox supports **long-term
   reference (LTR) frames**: on loss you send a small LTR-P frame instead of a keyframe. It also
   supports **temporal scalability**: a base layer at 1/2 frame rate that you can send alone to a
   weak link without hurting decode. And it supports **`MaxAllowedFrameQP`**, which keeps screen
   text sharp and drops frames rather than quality
   ([WWDC21 10158](https://developer.apple.com/videos/play/wwdc2021/10158/)). We use none of
   these. Temporal scalability also fixes "Nepal drags Rinor's LAN view down": send all layers to
   the LAN and the base layer to Nepal.
6. **Tailscale is fine if it stays direct.** The MTU is 1280
   ([tailscale #8219](https://github.com/tailscale/tailscale/issues/8219)). Our packets are a
   1200-byte payload + RTP 12 + extension ~8 + SRTP tag 10 + UDP/IPv4 28 ≈ 1258 bytes, so they fit.
   **DERP relays are QoS-throttled.** In one South Asia to US test, DERP gave 2.2 Mbit/s against a
   30-40 Mbit/s line ([Tailscale peer relays blog](https://tailscale.com/blog/peer-relays-international-networks)).
   Check that `tailscale status` shows `direct` on both ends, and measure the real UDP capacity
   Nepal↔UK with `iperf3 -u -b 3M` over Tailscale before choosing the ceiling.

### Alternative video source (iOS 27 only): the phone's own stream
Xcode 27's **Device Hub** views and controls a real iPhone's screen remotely. It needs **iOS 27 or
later** and Developer Mode ([Michael Tsai](https://mjtsai.com/blog/2026/06/25/xcode-27s-device-hub/),
[Bitrise](https://bitrise.io/blog/post/wwdc-2026-device-hub-and-what-it-means-for-ci-cd),
[Apple support](https://support.apple.com/en-gb/guide/personal-safety/ips37dbab2a1/web)).
pymobiledevice3 has reverse-engineered it. The phone's AVConference (FaceTime engine) encoder
sends **HEVC over RTP/UDP**, with negotiated bitrate tiers, LTR off and FEC flags
(`remote/core_device/media_stream_offer.py`, `display_service.py`: `VIDEO_STREAM_MIN_VERSION = 27.0`).
It even ships a browser viewer (`display serve-web`) with WebCodecs and touch
([CLI recipes](https://doronz88.github.io/pymobiledevice3/latest/guides/cli-recipes/)).
It would skip the Mac's decode and re-encode, **but** its rate adaptation for a far receiver isn't
public. Our VideoToolbox stage is the part we control. **Keep phonecap for video.** Treat the
phone's stream as a later experiment. Its real value is that it unlocks HID touch (section 2).

---

## 2. Fast taps and swipes on iOS: why 1200 ms now, and the best method

### Why a tap takes ~1200 ms today (code + sources)
Path: the client sends the tap **on release** (`phones.js` ~L1613: a press that lifts within
500 ms is a tap). It then goes over `input-r`, through `Control.run` (one serial queue per
phone, `control.ts` L124), to `WdaManager.tap` and `POST /wda/tap` (`wda.ts` L534-539). The ack
comes back only when WDA answers. On the phone:
1. `handleTap`, then `targetWithXyCoordinatesFromRequest`, then `targetFromRequest`, which returns
   **`request.session.activeApplication`**
   ([FBElementCommands.m](https://github.com/appium/WebDriverAgent/blob/master/WebDriverAgentLib/Commands/FBElementCommands.m)).
   That getter recomputes on **every call**, with no cache
   ([FBSession.m](https://github.com/appium/WebDriverAgent/blob/master/WebDriverAgentLib/Routing/FBSession.m)).
   It asks accessibility for the active apps (`FBXCAXClientProxy activeApplications`), then the test
   daemon for each PID's bundle ID, waiting up to **1 s** per request
   ([XCUIApplication+FBHelpers.m](https://github.com/appium/WebDriverAgent/blob/master/WebDriverAgentLib/Categories/XCUIApplication%2BFBHelpers.m)).
   This lookup is slow when the app's UI updates all the time, like a video feed
   ([WDA PR #1306](https://github.com/appium/WebDriverAgent/pull/1306)).
2. `[XCUICoordinate tap]`: XCTest builds the event, synthesizes it, and **waits for the daemon's
   confirmation**, plus a pre-event quiescence check and snapshots. Measured on an iPhone 15 Plus
   running iOS 27 with WDA 16.14: **918 ms per `/wda/tap`** with defaults, **898 ms** with
   `animationCoolOffTimeout=0, waitForIdleTimeout=0`, a W3C `/actions` tap about 0.94 s, and a drag
   2.3-2.7 s ([appium-ios PR #87](https://github.com/appium/appium-ios/pull/87)). The author's
   conclusion: the wait is inside XCTest and can't be fixed from outside the runner. The older
   TesterHome analysis of the TikTok app shows XCTest "waiting up to 2s until … idle", then
   snapshots, then the event ([testerhome 29820](https://testerhome.com/topics/29820)).
3. Our session already sets those waits to 0 (`wda.ts` L55, L383), so **no client or server
   setting fixes this**. On top of it, the serial queue means a second quick tap waits for the
   first one's ~1 s. The repo's `docs/latency.md` estimate ("40-120 ms per tap") was wrong.

### The methods, ranked
| Method | How | Latency (tap) | Live drag / multi-touch | Needs | Verdict |
|---|---|---|---|---|---|
| **CoreDevice universal HID** (Device Hub's path) | RemoteXPC over USB to `dtuhidd`; 58-byte `mainTouchscreen` reports (`0xC2` contact at X/Y, `0x02` release, up to 5 fingers); backboardd delivers them as real `UIEventTypeTouches` | Not published. **(est.) a few ms to inject + the app's reaction**; the 0.5 s auth settle is paid once per session, not per tap | **Yes**: a stream of contact reports *is* a live drag | **iOS 27** on the phones (video stream min version; HID touch seen on iOS 27.0.1), Developer Mode, DDI mounted, an **active media stream** held open as the auth gate | **Best** |
| WDA patched fast tap | Custom route: build `XCPointerEventPath` / `XCSynthesizedEventRecord` at absolute coordinates, no `activeApplication`, answer before injection (queued) | **263 ms** tap / 466 ms drag (PR #87, with coordinate resolution); a few ms if resolution is skipped too | No (XCTest plays complete gestures only) | Our WDA build (we already build it from source, `scripts/build-wda.sh`); the patch isn't upstream yet (PR #87 open, #1306 closed) | **Best on iOS 18** |
| WDA `/wda/tap` or W3C `/actions` (today) | XCTest confirmed path | ~0.9-1.2 s | No | Nothing new | Replace |
| idb (fb-idb) HID | Full HID on simulators only; "a subset works on Devices" ([idb docs](https://fbidb.io/docs/idb/ui/)) | n/a | n/a | n/a | Not for real phones |
| go-ios / tidevice | Start WDA; no HID injection of their own | = WDA | No | n/a | Launchers only |
| ControlFloor CFA (WDA fork) | Faster `tapat`/`dragat` than WDA actions ([STF #35](https://github.com/DeviceFarmer/stf/issues/35)) | faster than WDA | No | Deprecated repo ([CFA](https://github.com/nanoscopic/ControlFloorAgent)) | Same idea as the WDA patch |
| macOS iPhone Mirroring | Real-time mouse to touch | low | Yes | One iPhone per Mac, same Apple Account | Not for a farm |

**CoreDevice HID details** (from pymobiledevice3 source, `remote/core_device/hid_service.py`, decoded
by sniffing Xcode mirror sessions):
- The **authentication gate** is the important part. Without a running media stream, backboardd
  drops every digitizer report as coming from an "unsupported service". `touch_session()` starts
  `mediastreamstart`, throws away the RTP, waits `TOUCH_AUTH_SETTLE_SECONDS = 0.5`, and then
  touches work ([pymobiledevice3 #2036](https://github.com/doronz88/pymobiledevice3/issues/2036)).
  So keep **one long-lived session per phone**. Don't pay 0.5 s, or the one-shot CLI's 2.3-2.8 s,
  per tap.
- **Camera and microphone conflict:** iOS won't start the mirroring session while a foreground app
  uses the camera or mic. While it's active, camera and mic apps record black video or silence
  ([CLI recipes](https://doronz88.github.io/pymobiledevice3/latest/guides/cli-recipes/)). The
  session must close when idle or when a camera app comes to the front, and WDA stays as the
  fallback for those moments.
- Keyboard: a virtual HID keyboard (`createService`, 39-byte report) types text without WDA.
  Buttons (home, lock, volume) go through `core-device hid button`.
- It's private and reverse-engineered, so it can break with an iOS update. pymobiledevice3
  releases almost daily (v11.55.0 on 2026-11-13) and its licence is GPL-3.0, which is fine for
  private use. A Rust port of the same layout exists in jkcoxson/idevice (`hid.rs`), and
  [device-hub-ios](https://github.com/JaviSoto/device-hub-ios) reimplements the whole thing
  (HEVC stream plus taps, drags and keys).
- Unverified, so test first: whether the HID gate stream and our QuickTime/CoreMediaIO capture can
  run at the same time, and how much heat and battery a second phone-side encode costs. The offer
  has `customVideoWidth/Height` fields that may allow a tiny gate stream.

---

## 3. Ranked plan

Numbers are **(est.)** from the stages above. The LAN is Rinor's; Nepal is a ~180 ms RTT direct
Tailscale link with 3+ Mbit/s of clean UDP. Another worker is already adding bitrate honouring,
adaptation and stale-frame dropping, which is assumed done below.

| # | Change | Where | Effort | LAN after | Nepal after |
|---|---|---|---|---|---|
| 1 | **Touch through CoreDevice HID**: a per-phone sidecar (pymobiledevice3 first, Rust/`idevice` later) holding one `touch_session` open while someone's viewing. It takes `touch` down/move/up straight from the `input`/`input-r` channels (already there) and sends 0xC2/0x02 reports; the HID keyboard does typing. WDA stays for `launch` and as the fallback (camera in use, iOS < 27). **Needs the phones on iOS 27** (test phone is on 18.5; iPhone 11 and later run iOS 27). Updating iOS can't be undone, so it's Rinor's/the owner's call | Server + phones; client: send **down at press** and moves at 60-120 Hz instead of waiting for release | M | tap visible **~60-100 ms**, live drags | tap/drag visible **~250-350 ms** after the finger (≈ RTT + capture/encode/decode) |
| 1b | (if staying on iOS 18) **WDA fast-tap patch**: new route, no `activeApplication`, absolute coordinates, answer after queueing; drags the same way. Drop the per-phone serial wait for taps | Server (WDA patch in `build-wda.sh`) | S | **~300 ms** | **~550-700 ms** |
| 2 | **Quick sender fixes in the current stack**: (a) remote viewers get `playout-delay` min=0/max≈100 ms, or the extension is dropped and `jitterBufferTarget=0` is used (rtc.ts L210-214); (b) add libdatachannel `PacingHandler` to the chain, its `setBitrate` following the target at ~1.2-1.5×, with a bounded queue that drops; (c) **no periodic IDR** for remote (`--key-seconds 10`, keyframes only on PLI); (d) remote defaults of 50 % scale, 30 fps and a 1.5 Mbit/s start, which UI content handles well | Server (+ phonecap flag) | S | unchanged (60 fps, ~50-80 ms) | **25-30 fps steady, ~200-300 ms**, no 4 fps collapse |
| 3 | **Replace the libdatachannel media sender with Pion (Go)**: a small `phonertc` sidecar that reads phonecap's Annex B and answers the same `rtc-offer` (signaling stays in Node). It brings TWCC + send-side GCC (`OnTargetBitrateChange` drives `bitrate <bps>` into phonecap), NACK/RTX, a pacer and FlexFEC or RED/ULPFEC | Server | M-L | same | **30-60 fps, ~150-250 ms**, smooth bitrate changes instead of collapses |
| 4 | **phonecap encoder for far links**: LTR (`EnableLTR`, `ForceLTRRefresh` on PLI instead of IDR), temporal scalability (`BaseLayerFrameRateFraction 0.5`) so Nepal gets the base layer while the LAN keeps 60 fps from **one** encoder (or one encoder per viewer tier), `MaxAllowedFrameQP` for sharp text | phonecap + server | M | LAN no longer degraded by a remote viewer | fewer freezes after loss, keyframe bursts gone |
| 5 | **Client**: WebRTC only for remote (no TCP fallback while WebRTC is up); draw a local touch ring right away; show glass-to-glass and inject-to-frame numbers; optional H.265 (Chrome 136+ supports HEVC in WebRTC, but Edge/WebView2 may need `--enable-features=WebRtcAllowH265Receive`; [Bitmovin](https://bitmovin.com/blog/google-adds-hevc-support-chrome/), [MS Q&A](https://learn.microsoft.com/en-in/answers/questions/5880331/h-265-hevc-not-published-sent-via-webrtc-chrome-su)) for ~30-50 % fewer bits | Lotus client | S | – | better picture at the same bitrate |
| 6 | **Network checks**: confirm `direct` in `tailscale status`, run `iperf3 -u` Nepal↔UK to find the clean UDP rate (set the ceiling below it), and use a Tailscale Peer Relay if direct ever fails | Ops | S | – | avoids DERP's 2 Mbit/s trap |

Order: do **2** now (cheap, and on top of the running worker's change), then **1** (or **1b** if the
phones stay on iOS 18), then **3** and **4** together, and **5** alongside. **1** is the only thing
that makes taps fast and drags live. **2 + 3** make Nepal smooth.

Glass-to-glass budget for Nepal after 1-4 **(est.)**: capture 16-35 ms + encode 2-6 + pacing 0-20 +
one-way network ~90 + jitter buffer 10-40 + decode/render 10-25 = **~130-215 ms**, plus ~180 ms on an
unrecovered loss (FEC removes most of those). For a touch, add the client-to-phone one-way (~90 ms)
and HID injection (a few ms, est.): **~250-330 ms** from finger to seeing the result. Physics sets the
floor at about the 180 ms RTT.

### Measure before and after (so nothing is guessed again)
- Server: log `t_recv` (message in), `t_inject_start` and `t_inject_end` per action, and the
  capture time of the **first frame that changed** after injection. That's tap to pixels, without
  the client.
- Client (already there): glass-to-glass via `ts` + ping/pong. Also read `getStats()`:
  `framesDropped`, `pliCount`, `nackCount`, `jitterBufferDelay`, `packetsLost`.

## Sources
- WDA source: [FBElementCommands.m](https://github.com/appium/WebDriverAgent/blob/master/WebDriverAgentLib/Commands/FBElementCommands.m), [FBSession.m](https://github.com/appium/WebDriverAgent/blob/master/WebDriverAgentLib/Routing/FBSession.m), [XCUIApplication+FBHelpers.m](https://github.com/appium/WebDriverAgent/blob/master/WebDriverAgentLib/Categories/XCUIApplication%2BFBHelpers.m)
- WDA tap latency: [appium-ios PR #87](https://github.com/appium/appium-ios/pull/87), [WDA PR #1306](https://github.com/appium/WebDriverAgent/pull/1306), [WDA PR #1270](https://github.com/appium/WebDriverAgent/pull/1270), [Appium WDA slowness](https://appium.github.io/appium-xcuitest-driver/10.43/troubleshooting/wda-slowness/), [TesterHome 29820](https://testerhome.com/topics/29820)
- CoreDevice HID / Device Hub: [pymobiledevice3 CLI recipes](https://doronz88.github.io/pymobiledevice3/latest/guides/cli-recipes/), [pymobiledevice3 #2036](https://github.com/doronz88/pymobiledevice3/issues/2036), [MobileBuildMCP #519](https://github.com/getsentry/MobileBuildMCP/issues/519), [device-hub-ios](https://github.com/JaviSoto/device-hub-ios), [Michael Tsai](https://mjtsai.com/blog/2026/06/25/xcode-27s-device-hub/), [Bitrise](https://bitrise.io/blog/post/wwdc-2026-device-hub-and-what-it-means-for-ci-cd), [Apple support](https://support.apple.com/en-gb/guide/personal-safety/ips37dbab2a1/web); pymobiledevice3 source `remote/core_device/{hid_service,display_service,media_stream_offer,screen_stream}.py`
- idb: [fbidb UI docs](https://fbidb.io/docs/idb/ui/); ControlFloor: [ControlFloorAgent](https://github.com/nanoscopic/ControlFloorAgent), [STF #35](https://github.com/DeviceFarmer/stf/issues/35)
- WebRTC: [libdatachannel #505](https://github.com/paullouisageneau/libdatachannel/discussions/505), libdatachannel `include/rtc/pacinghandler.hpp`, node-datachannel `src/cpp/media-pacinghandler-wrapper.cpp`, [pion/webrtc #2437](https://github.com/pion/webrtc/discussions/2437), [Pion TWCC](https://www.mintlify.com/pion/interceptor/interceptors/twcc), [Pion FEC](https://pion.ly/blog/fec-with-pion/), [pion flexfec](https://pkg.go.dev/github.com/pion/interceptor/pkg/flexfec), [GStreamer WebRTC (rtpgccbwe)](http://ystreet00.blogspot.com/2020/05/gstreamer-webrtc-in-2020.html), [playout-delay field report](https://github.com/spacedouut/moonlight-web-stream-simplified/pull/8), [playout-delay guide](https://lazyharu.com/en/webrtc-playout-delay/), [jitterBufferTarget intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/4W4orKqA3Rs)
- VideoToolbox: [WWDC21 10158 low-latency encoding](https://developer.apple.com/videos/play/wwdc2021/10158/)
- HEVC in WebRTC: [Bitmovin](https://bitmovin.com/blog/google-adds-hevc-support-chrome/), [Microsoft Q&A (Edge)](https://learn.microsoft.com/en-in/answers/questions/5880331/h-265-hevc-not-published-sent-via-webrtc-chrome-su)
- Tailscale: [MTU 1280 #8219](https://github.com/tailscale/tailscale/issues/8219), [Peer relays, international](https://tailscale.com/blog/peer-relays-international-networks)
