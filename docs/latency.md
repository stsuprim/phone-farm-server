# Live view latency: where the time goes

**Everything here is an estimate** from the code, Apple's and WDA's documented behaviour and typical figures for this
hardware. None of it was measured on the real Mac mini + iPhones: this was written on Windows. Use the new measurements
(`GET /phones` -> `stats`, the `ping`/`pong` clock sync and the capture timestamps on every frame) to replace these numbers.

Setup assumed: Mac mini (Apple silicon), iPhone on USB, viewer on the same gigabit/Wi-Fi LAN (Rinor's case), 60 Hz display.

## Before: WDA MJPEG (the old and still the fallback path)

| Stage | What happens | Latency (est.) | FPS ceiling (est.) |
|---|---|---|---|
| Screenshot on the phone | WDA's MJPEG server asks XCTest for a screenshot (`XCUIScreen` / testmanagerd round trip inside the phone). Synchronous: the next one only starts when this ends | 40-150 ms (worse on iOS 17+ and older phones) | 7-20 fps |
| JPEG encode on the phone | scale (`mjpegScalingFactor` 50) + JPEG at quality 50, on the CPU | 10-40 ms | (inside the above) |
| Phone -> Mac | MJPEG over TCP through usbmuxd and `iproxy` (USB 2 class throughput); 60-150 KB per frame | 3-10 ms, more if WDA's socket backs up (WDA never drops frames, so a slow reader builds a queue on the phone) | - |
| Parse on the Mac | multipart parser in Node | < 1 ms | - |
| Mac -> viewer (WS) | latest-only send, 60-150 KB per frame | 1-10 ms LAN, 20-80 ms Tailscale/Internet | bandwidth bound |
| Client decode + paint | JPEG decode in the WebView, then composite on the next vsync | 5-15 ms + 0-17 ms | - |
| **Total** | | **~150-300 ms typical, 500 ms+ when frames queue** (matches the reported ~500 ms) | **10-20 fps** |

The two killers: the screenshot API is slow and serial (that's the fps), and any queueing between WDA and the server adds
whole frames of delay (that's the 500 ms). No WDA setting fixes the first one; `mjpegServerFramerate` 60 only raises the
ceiling.

## After: CoreMediaIO capture + VideoToolbox + WebRTC

| Stage | What happens | Latency (est.) | FPS (est.) |
|---|---|---|---|
| Screen capture | iOS mirrors its display to the Mac over USB (the QuickTime path: the phone hardware-encodes its screen, AVFoundation decodes it into a CVPixelBuffer). Timestamped on the host clock | **~16-35 ms** (about one frame on the phone plus the hardware decode on the Mac; we can't remove this) | 60 when the screen changes (iOS sends fewer frames when it's still) |
| Encode on the Mac | VideoToolbox H.264, hardware, low-latency rate control, Constrained Baseline, no B-frames, no frame delay | 2-6 ms at full resolution | 60 |
| Helper -> server | pipe, framed records | < 1 ms | - |
| Server -> network | RTP packetization (libdatachannel), SRTP, UDP; deltas 5-40 KB at 8 Mbps | < 1 ms in the server; keyframes (100-300 KB) take 1-3 ms on gigabit, 10-30 ms on busy Wi-Fi | - |
| Network (LAN) | one hop | 1-5 ms (Wi-Fi up to ~10 ms) | - |
| Client jitter buffer | `playout-delay` min=max=0 tells Chrome/WebView2 to render on decode | ~0-10 ms (instead of the default 30-100 ms) | - |
| Client decode + paint | hardware H.264 decode, composite on vsync | 3-8 ms + 0-17 ms | 60 |
| **Total** | | **~35-80 ms on the LAN** (target < 100 ms) | **up to 60 fps** |

The H.264 WebSocket fallback is the same pipeline over TCP: about the same on a clean LAN, worse under loss (TCP
retransmits stall every later frame; latest-only then drops to the next keyframe).

Input, separately (unchanged by the video work):

| Action | Path | Latency (est.) |
|---|---|---|
| Tap | data channel -> server -> WDA `/wda/tap` over a kept-alive connection -> XCTest synthesizes it | ~40-120 ms until the phone reacts (mostly XCTest's event synthesis); previously + a few ms of new usbmux connection whenever the last request was > 4 s ago |
| Drag / swipe | buffered until `up`, then replayed as one W3C action with its real timing | the whole drag duration + ~50-120 ms after release |

## Targets that can't be reached, and why

- **The capture stage can't go below about one frame.** The phone composites, encodes and sends its screen over USB before
  the Mac sees anything, then the Mac decodes it; that's ~16-35 ms that no setting removes. Re-encoding on the Mac adds
  2-6 ms (forwarding the phone's own H.264 without decode/re-encode is what the private QuickTime protocol tools do; it's
  not reachable through AVFoundation).
- **A still screen doesn't produce frames** (iOS only sends changes), so `fps` in the stats drops when nothing moves. That's
  not latency; a forced keyframe re-encodes the last frame immediately.
- **Live drags can't be shown while the finger moves.** iOS automation (XCTest/WDA) only plays a complete gesture, so a drag
  appears on the phone after release. Taps are immediate. There is no supported streaming-touch channel on a stock iPhone.
- **Over Tailscale or the Internet** add the network round trip; the path is still direct (host candidates only, no relay).
- **< 100 ms glass-to-glass at 60 fps on the LAN is expected for video**, from these estimates; to be confirmed with the
  client's measurement (`ts` messages + ping/pong offset).
