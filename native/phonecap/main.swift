// phonecap: capture an iPhone's screen over USB the way QuickTime does (CoreMediaIO screen-capture devices),
// encode it with VideoToolbox H.264 in real time, and write framed records to stdout for the phone-farm server.
//
// TCC: macOS counts iPhone screen capture as Camera. phonecap re-runs itself with "responsibility disclaimed" so it
// gets its own Camera entry (com.lotus.phonecap, inside build/PhoneCap.app) instead of inheriting node's under launchd.
// Grant it once at the Mac: `native/phonecap/build/PhoneCap.app/Contents/MacOS/phonecap --request-access` in Terminal, click Allow.
//
// stdout, one record after another (big-endian):
//   1 byte lane << 4 | kind | 8 bytes capture time (float64, ms since the epoch) | 4 bytes payload length | payload
//   kinds: 0 info JSON {width,height,fps,scale,lane}, 1 config (SPS+PPS, Annex B), 2 keyframe, 3 delta (Annex B),
//          4 stats JSON {encode_ms, capture_to_encoded_ms, fps},
//          5 audio frame (Opus, 20 ms at 48 kHz; G.711 u-law 8 kHz mono when this Mac has no Opus encoder), its time the
//            capture time of its first sample, 6 audio JSON ({codec, rate, channels, frame_ms, reason?} once, then
//            {level_db, peak_db} every 2 s while it runs). Audio records only with --audio (see "audio" below).
// Lanes: one capture feeds up to 8 encoders (lanes 0-7), each with its own size, fps and bitrate, so a far viewer gets a
//   small 30 fps stream while the LAN keeps full size at 60 fps. Lane 0 starts from the command line (--fps --scale
//   --bitrate --key-seconds); its records have the high nibble 0, exactly as before lanes.
// stdin: "key [lane]" forces an IDR now (re-encoding the current screen if nothing new arrived), "bitrate [lane] <bit/s>"
//   and "fps <lane> <fps>" change a running lane, "lane <id> <fps> <scale %> <bit/s> [<key seconds>]" adds or changes
//   a lane, "unlane <id>" stops one, "rotate <0|90|180|270>" turns the picture that many degrees clockwise before
//   encoding (every lane; a new info record and keyframe follow), "audio on|off" starts or stops sending the phone's
//   sound (with --audio; off at start), "quit" exits. A lane without the number is lane 0.
// Audio (--audio, 2026-11-16): the iPhone screen device is muxed (video and sound), so an AVCaptureAudioDataOutput is
//   added to the SAME session (never a second device). While the phone is captured, iOS plays its sound out to the Mac
//   (as with QuickTime's "iPhone" audio input) and its own speaker goes quiet; this must still be confirmed on the
//   phones (iOS 18.5 and 18.7.8). The sound has its own queue and never touches the video's; anything wrong with it
//   says so in a kind 6 record (codec "none", reason) and the video goes on.
// Rotation: the picture follows the phone as it turns (the buffers change size: each lane gets a new encoder, info
//   record and keyframe). If the buffers keep the size the session started with (the turned picture squashed into
//   it), the output is asked for the screen's own size; if that doesn't take, phonecap exits 8 and the server starts
//   it again (a new session takes the screen's size as it is).
// phonecap-caps: lanes rotate audio
//   (scripts/build-native.mjs copies the caps above to build/phonecap.caps, so the server knows what this build speaks)
// stderr: human-readable log lines. Exit codes: 2 no device, 3 camera access denied, 4 capture failed,
//          5 device disconnected, 6 encoder failed, 7 several iPhones share a name and can't be told apart,
//          8 the picture kept its old shape after the phone turned (the server starts the capture again),
//          9 the session ran but the iPhone screen device gave no frame at all within FIRST_FRAME_SECONDS (the
//            server starts the capture again: a new session on the device gets frames).
// --udid: macOS 27 gives iPhone screens random UUIDs, so phonecap links them to UDIDs itself (see "UDID -> screen
//          device mapping"); --list prints each capture device's uniqueID, name, UDID (or "unresolved") and how.
//
// Build: scripts/build-native.mjs (npm run build): swiftc, then wraps it in build/PhoneCap.app and signs the bundle.

import AudioToolbox
import AVFoundation
import CoreImage
import CoreMedia
import CoreMediaIO
import CoreVideo
import Foundation
import IOKit
import ImageIO
import VideoToolbox

signal(SIGPIPE, SIG_IGN)

func log(_ s: String) {
    FileHandle.standardError.write(("phonecap: " + s + "\n").data(using: .utf8)!)
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// 2026-11-23 (iPhone-2 stuck on "connecting" after a replug): a CoreMediaIO iPhone screen device opened right after
/// a replug, or before the phone is ready, can run its session without ever handing over a frame until it's opened
/// again. A session that gave no frame this long after startRunning exits 9 and the server starts a new one. Only the
/// first frame is watched: a still screen sends no frames at all, so a quiet running capture is not a stuck one.
let FIRST_FRAME_SECONDS = 5.0

// MARK: - options

struct Options {
    var udid = ""
    var name = ""
    var fps = 60
    var bitrate = 8_000_000
    var scale = 100
    var profile = "baseline"
    var keySeconds = 2.0
    var list = false
    var requestAccess = false
    var anyIfSingle = false
    var waitSeconds = 12.0
    var audio = false
    var audioBitrate = 80_000
}

func parseOptions() -> Options {
    var o = Options()
    var args = Array(CommandLine.arguments.dropFirst())
    func next() -> String { args.isEmpty ? "" : args.removeFirst() }
    while !args.isEmpty {
        switch args.removeFirst() {
        case "--udid": o.udid = next()
        case "--name": o.name = next()
        case "--fps": o.fps = max(1, min(60, Int(next()) ?? 60))
        case "--bitrate": o.bitrate = max(500_000, min(50_000_000, Int(next()) ?? 8_000_000))
        case "--scale": o.scale = max(10, min(100, Int(next()) ?? 100))
        case "--profile": o.profile = next()
        case "--key-seconds": o.keySeconds = max(0.5, min(10, Double(next()) ?? 2))
        case "--wait": o.waitSeconds = max(1, Double(next()) ?? 12)
        case "--any-if-single": o.anyIfSingle = true
        case "--audio": o.audio = true
        case "--audio-bitrate": o.audioBitrate = max(24_000, min(160_000, Int(next()) ?? 80_000))
        case "--list": o.list = true
        case "--request-access": o.requestAccess = true
        default: break
        }
    }
    return o
}

// MARK: - output

let outLock = NSLock()

func writeAll(_ data: Data) {
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let base = raw.baseAddress else { return }
        var off = 0
        while off < raw.count {
            let n = Darwin.write(1, base + off, raw.count - off)
            if n < 0 {
                if errno == EINTR { continue }
                exit(0) // the server went away
            }
            off += n
        }
    }
}

func emit(_ kind: UInt8, _ timeMs: Double, _ payload: Data) {
    var header = Data(capacity: 13)
    header.append(kind)
    var t = timeMs.bitPattern.bigEndian
    withUnsafeBytes(of: &t) { header.append(contentsOf: $0) }
    var len = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &len) { header.append(contentsOf: $0) }
    outLock.lock()
    writeAll(header)
    writeAll(payload)
    outLock.unlock()
}

func emitJSON(_ kind: UInt8, _ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj) { emit(kind, nowMs(), d) }
}

// MARK: - devices

func allowScreenCaptureDevices() {
    var prop = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(0)) // kCMIOObjectPropertyElementMain
    var allow: UInt32 = 1
    let st = CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil,
                                       UInt32(MemoryLayout<UInt32>.size), &allow)
    if st != 0 { log("could not enable screen capture devices (CMIO status \(st))") }
}

func captureDevices() -> [AVCaptureDevice] {
    var types: [AVCaptureDevice.DeviceType]
    if #available(macOS 14.0, *) {
        types = [.external]
    } else {
        types = [.externalUnknown]
    }
    var out: [AVCaptureDevice] = []
    var seen = Set<String>()
    for media in [AVMediaType.muxed, AVMediaType.video] {
        let found = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: media, position: .unspecified).devices
        for d in found where !seen.contains(d.uniqueID) {
            seen.insert(d.uniqueID)
            out.append(d)
        }
    }
    return out
}

func isPhoneScreen(_ d: AVCaptureDevice) -> Bool {
    d.modelID == "iOS Device" || d.hasMediaType(.muxed)
}

func hexOnly(_ s: String) -> String { s.lowercased().filter { $0.isHexDigit } }

var loggedOnce = Set<String>()
func logOnce(_ s: String) {
    if loggedOnce.insert(s).inserted { log(s) }
}

// MARK: - UDID -> screen device mapping
//
// Since macOS 27 the iPhone screen devices' uniqueIDs are random UUIDs, not the UDID, so phonecap links each screen
// device to a UDID itself, strongest first:
//   1. a direct link: the UDID (or the USB serial, which is the UDID without its dash) is in the device's uniqueID or
//      in one of its CoreMediaIO strings (model UID, linked CoreAudio device UIDs, name, manufacturer); or the
//      iPhone's IOKit USB entry (found by that serial) or anything under it names the screen's uniqueID or USB location;
//   2. the name: `ideviceinfo -u <udid> -k DeviceName` against the screen device's name, only when exactly one
//      unlinked screen and exactly one unlinked connected iPhone (`idevice_id -l`) carry that name (so a phone whose
//      twin is linked another way is still found, by elimination); without libimobiledevice, the server's --name;
//   3. --any-if-single: the only iPhone screen, if nothing links it to another iPhone.
// Several iPhones with the same name and no link: an `error:` line asking for unique names (exit 7), never a guess.

struct UDIDLink {
    let udid: String
    let how: String
}

struct ScreenMap {
    var byUDID: [String: AVCaptureDevice] = [:]    // hexOnly(UDID) -> screen device
    var byDevice: [String: UDIDLink] = [:]             // screen uniqueID -> UDID and how it was linked
    var ambiguous: [String: (message: String, settled: Bool)] = [:] // hexOnly(UDID) -> why it can't be told apart
    var names: [String: String] = [:]              // UDID -> DeviceName (ideviceinfo)
    var udids: [String] = []                       // iPhones connected over USB
    var listed = false                             // udids came from idevice_id -l
}

/// The path of a command-line tool, looked up in PATH and Homebrew's folders (launchd's PATH is short).
func findTool(_ name: String) -> String? {
    let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
    let dirs = path.split(separator: ":").map(String.init) + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    for d in dirs where !d.isEmpty {
        let p = d.hasSuffix("/") ? d + name : d + "/" + name
        if FileManager.default.isExecutableFile(atPath: p) { return p }
    }
    return nil
}

/// Runs a tool (stdin closed, stderr dropped, killed after `timeout` seconds); its trimmed stdout, or nil if it failed.
func runTool(_ name: String, _ args: [String], timeout: Double = 5) -> String? {
    guard let path = findTool(name) else { return nil }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    let exited = DispatchSemaphore(value: 0)
    p.terminationHandler = { _ in exited.signal() }
    do { try p.run() } catch { return nil }
    let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
    let data = out.fileHandleForReading.readDataToEndOfFile()
    killer.cancel()
    guard exited.wait(timeout: .now() + 2) == .success, p.terminationReason == .exit, p.terminationStatus == 0 else {
        return nil
    }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

/// iPhones' DeviceNames from ideviceinfo, asked in parallel, kept for this run (a failed one is asked again after 3 s).
final class NameBook: @unchecked Sendable {
    private let lock = NSLock()
    private var known: [String: String] = [:]
    private var failedAt: [String: Date] = [:]

    func names(for udids: [String]) -> [String: String] {
        lock.lock()
        let todo = udids.filter { u in
            known[u] == nil && (failedAt[u].map { Date().timeIntervalSince($0) > 3 } ?? true)
        }
        lock.unlock()
        if !todo.isEmpty {
            DispatchQueue.concurrentPerform(iterations: todo.count) { i in
                let u = todo[i]
                let name = runTool("ideviceinfo", ["-u", u, "-k", "DeviceName"]) ?? ""
                self.lock.lock()
                if name.isEmpty { self.failedAt[u] = Date() } else { self.known[u] = name }
                self.lock.unlock()
            }
        }
        lock.lock()
        defer { lock.unlock() }
        var out: [String: String] = [:]
        for u in udids { if let n = known[u] { out[u] = n } }
        return out
    }
}

let nameBook = NameBook()
var udidListAt = Date.distantPast
var udidListCache: [String]?

/// UDIDs of the iPhones connected over USB (`idevice_id -l`, refreshed every 2 s), or nil without libimobiledevice.
func connectedUDIDs() -> [String]? {
    if Date().timeIntervalSince(udidListAt) < 2 { return udidListCache }
    var list: [String]?
    if let out = runTool("idevice_id", ["-l"]) {
        var seen = Set<String>()
        list = out.components(separatedBy: .whitespacesAndNewlines)
            .filter { hexOnly($0).count >= 24 && seen.insert(hexOnly($0)).inserted }
    }
    udidListAt = Date()
    udidListCache = list
    return list
}

// CoreMediaIO, by FourCC (the raw codes, so no SDK rename can break the build)

func fourcc(_ s: String) -> UInt32 { s.utf8.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) } }

func cmioAddress(_ selector: UInt32) -> CMIOObjectPropertyAddress {
    CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(selector),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(0)) // kCMIOObjectPropertyElementMain
}

func cmioDeviceIDs() -> [CMIOObjectID] {
    let system = CMIOObjectID(kCMIOObjectSystemObject)
    var addr = cmioAddress(fourcc("dev#")) // kCMIOHardwarePropertyDevices
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == 0 else { return [] }
    let count = Int(size) / MemoryLayout<CMIOObjectID>.size
    guard count > 0 else { return [] }
    var ids = [CMIOObjectID](repeating: 0, count: count)
    var used: UInt32 = 0
    let st = ids.withUnsafeMutableBytes { buf in
        CMIOObjectGetPropertyData(system, &addr, 0, nil, UInt32(buf.count), &used, buf.baseAddress)
    }
    guard st == 0 else { return [] }
    return Array(ids.prefix(Int(used) / MemoryLayout<CMIOObjectID>.size))
}

/// A CFString property of a CoreMediaIO object (only call it with selectors whose data is a CFString).
func cmioString(_ obj: CMIOObjectID, _ selector: UInt32) -> String? {
    var addr = cmioAddress(selector)
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(obj, &addr, 0, nil, &size) == 0,
          Int(size) == MemoryLayout<Unmanaged<CFString>>.size else { return nil }
    var value: Unmanaged<CFString>?
    var used: UInt32 = 0
    let st = withUnsafeMutablePointer(to: &value) { p in
        CMIOObjectGetPropertyData(obj, &addr, 0, nil, size, &used, p)
    }
    guard st == 0, let v = value else { return nil }
    return v.takeRetainedValue() as String
}

let cmioStringProps: [(code: String, label: String)] = [
    ("uid ", "device UID"), ("muid", "model UID"), ("plud", "linked CoreAudio UID"),
    ("plsd", "linked synced CoreAudio UID"), ("lnam", "name"), ("lmak", "manufacturer"),
]

/// Each CoreMediaIO device's strings, by its device UID (the same as AVCaptureDevice.uniqueID).
func cmioStrings() -> [String: [String: String]] {
    var out: [String: [String: String]] = [:]
    for id in cmioDeviceIDs() {
        var props: [String: String] = [:]
        for p in cmioStringProps {
            if let v = cmioString(id, fourcc(p.code)), !v.isEmpty { props[p.label] = v }
        }
        if let uid = props["device UID"] { out[uid] = props }
    }
    return out
}

// IOKit: Apple's USB devices (iPhones), their serial (the UDID) and every string in their registry subtree

struct USBPhone {
    let serial: String
    let location: UInt32
    let strings: [String]
}

func collectStrings(_ v: Any, into out: inout [String]) {
    if let s = v as? String {
        out.append(s)
    } else if let a = v as? [Any] {
        for x in a { collectStrings(x, into: &out) }
    } else if let d = v as? [String: Any] {
        for x in d.values { collectStrings(x, into: &out) }
    }
}

func registryProperty(_ e: io_registry_entry_t, _ key: String) -> AnyObject? {
    IORegistryEntryCreateCFProperty(e, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
}

func registryStrings(_ e: io_registry_entry_t, into out: inout [String]) {
    var props: Unmanaged<CFMutableDictionary>?
    guard IORegistryEntryCreateCFProperties(e, &props, kCFAllocatorDefault, 0) == KERN_SUCCESS,
          let cf = props?.takeRetainedValue() else { return }
    let obj: AnyObject = cf
    if let dict = obj as? [String: Any] { collectStrings(dict, into: &out) }
}

func usbApplePhones() -> [USBPhone] {
    var out: [USBPhone] = []
    var iter: io_iterator_t = 0
    // 0 is MACH_PORT_NULL: the default main port on every macOS version
    guard IOServiceGetMatchingServices(0, IOServiceMatching("IOUSBHostDevice"), &iter) == KERN_SUCCESS else { return [] }
    defer { IOObjectRelease(iter) }
    while true {
        let dev = IOIteratorNext(iter)
        if dev == 0 { break }
        defer { IOObjectRelease(dev) }
        guard (registryProperty(dev, "idVendor") as? NSNumber)?.intValue == 0x05AC else { continue }
        let serial = (registryProperty(dev, "USB Serial Number") as? String)
            ?? (registryProperty(dev, "kUSBSerialNumberString") as? String) ?? ""
        guard hexOnly(serial).count >= 24 else { continue }
        let location = (registryProperty(dev, "locationID") as? NSNumber)?.uint32Value ?? 0
        var strings: [String] = []
        registryStrings(dev, into: &strings)
        var children: io_iterator_t = 0
        if IORegistryEntryCreateIterator(dev, kIOServicePlane, IOOptionBits(kIORegistryIterateRecursively), &children) == KERN_SUCCESS {
            while true {
                let c = IOIteratorNext(children)
                if c == 0 { break }
                registryStrings(c, into: &strings)
                IOObjectRelease(c)
            }
            IOObjectRelease(children)
        }
        out.append(USBPhone(serial: serial, location: location, strings: strings))
    }
    return out
}

/// A UDID from a USB serial: 24 hex digits are a newer iPhone's UDID without its dash (00008110-001A...), 40 an older one's.
func udidFromSerial(_ serial: String) -> String {
    let h = hexOnly(serial)
    if h.count == 24 { return (String(h.prefix(8)) + "-" + String(h.dropFirst(8))).uppercased() }
    return h
}

struct NameGroup {
    var phones: [AVCaptureDevice] = []
    var udids: [String] = []
}

/// Links the iPhone screen devices to the connected iPhones' UDIDs. `want` (a UDID, may be empty) is always counted as
/// connected; `wantName` is its name if ideviceinfo can't say; `allNames` asks every iPhone's name (for --list).
func resolve(_ devices: [AVCaptureDevice], want: String, wantName: String, allNames: Bool = false) -> ScreenMap {
    var r = ScreenMap()
    let phones = devices.filter(isPhoneScreen)
    let listed = connectedUDIDs()
    r.listed = listed != nil
    var udids = listed ?? []
    if !want.isEmpty && !udids.contains(where: { hexOnly($0) == hexOnly(want) }) { udids.append(want) }

    // 1. direct links
    let cmio = cmioStrings()
    let usb = usbApplePhones()
    if !r.listed {
        // no idevice_id: every Apple USB device with a UDID-like serial counts as connected
        for p in usb where !udids.contains(where: { hexOnly($0) == hexOnly(p.serial) }) { udids.append(udidFromSerial(p.serial)) }
    }
    r.udids = udids
    var linkOf: [String: UDIDLink] = [:]
    var screensOf: [String: [AVCaptureDevice]] = [:]
    for d in phones {
        let id = hexOnly(d.uniqueID)
        let uidLower = d.uniqueID.lowercased()
        let strings = (cmio[d.uniqueID] ?? [:]).filter { $0.key != "device UID" }
        var found: [UDIDLink] = []
        for u in udids {
            let key = hexOnly(u)
            guard key.count >= 24 else { continue }
            if id.count >= 8 && (id == key || id.contains(key) || key.contains(id)) {
                found.append(UDIDLink(udid: u, how: "uniqueID"))
            } else if let hit = strings.first(where: { hexOnly($0.value).contains(key) }) {
                found.append(UDIDLink(udid: u, how: "CoreMediaIO \(hit.key)"))
            } else if let p = usb.first(where: { hexOnly($0.serial) == key }) {
                if p.strings.contains(where: { $0.lowercased().contains(uidLower) }) {
                    found.append(UDIDLink(udid: u, how: "IOKit USB entry"))
                } else if p.location != 0 && id.contains(String(p.location, radix: 16) + "05ac") {
                    found.append(UDIDLink(udid: u, how: "USB location"))
                }
            }
        }
        let distinct = Set(found.map { hexOnly($0.udid) })
        if distinct.count == 1 {
            linkOf[d.uniqueID] = found[0]
            screensOf[hexOnly(found[0].udid), default: []].append(d)
        } else if distinct.count > 1 {
            logOnce("screen \(d.uniqueID) links to several iPhones (\(found.map { $0.udid }.joined(separator: ", "))); not using those links")
        }
    }
    for (key, ds) in screensOf {
        if ds.count == 1 {
            r.byUDID[key] = ds[0]
            r.byDevice[ds[0].uniqueID] = linkOf[ds[0].uniqueID]
        } else {
            logOnce("several screens link to the same iPhone (\(ds.map { $0.uniqueID }.joined(separator: ", "))); not using those links")
        }
    }

    // 2. names, among what is still unlinked
    let openUDIDs = udids.filter { r.byUDID[hexOnly($0)] == nil }
    let openPhones = phones.filter { r.byDevice[$0.uniqueID] == nil }
    guard !openUDIDs.isEmpty && !openPhones.isEmpty else {
        if allNames { r.names = nameBook.names(for: udids) }
        return r
    }
    var names = nameBook.names(for: allNames ? udids : openUDIDs)
    if !want.isEmpty && !wantName.isEmpty, let w = udids.first(where: { hexOnly($0) == hexOnly(want) }), names[w] == nil {
        names[w] = wantName
    }
    r.names = names
    var groups: [String: NameGroup] = [:]
    for d in openPhones { groups[d.localizedName, default: NameGroup()].phones.append(d) }
    for u in openUDIDs { if let n = names[u] { groups[n, default: NameGroup()].udids.append(u) } }
    for (name, g) in groups where !g.udids.isEmpty && !g.phones.isEmpty {
        if g.phones.count == 1 && g.udids.count == 1 {
            let u = g.udids[0]
            let d = g.phones[0]
            r.byUDID[hexOnly(u)] = d
            r.byDevice[d.uniqueID] = UDIDLink(udid: u, how: r.listed ? "name (ideviceinfo)" : "name (no idevice_id)")
        } else {
            let n = max(g.phones.count, g.udids.count)
            let message = "\(n) iPhones are named \"\(name)\" (\(g.udids.joined(separator: ", "))) and macOS gives their "
                + "screen devices random IDs, so phonecap can't tell which screen is which. Give each iPhone a unique name "
                + "(on the iPhone: Settings > General > About > Name), then unplug and replug it"
            for u in g.udids { r.ambiguous[hexOnly(u)] = (message: message, settled: g.phones.count >= g.udids.count) }
        }
    }
    return r
}

enum Pick {
    case found(AVCaptureDevice, String)
    case ambiguous(String, settled: Bool)
    case notYet
}

func pickDevice(_ o: Options) -> Pick {
    let all = captureDevices()
    let phones = all.filter(isPhoneScreen)
    var linkedElsewhere = Set<String>()
    if !o.udid.isEmpty {
        let r = resolve(all, want: o.udid, wantName: o.name)
        let key = hexOnly(o.udid)
        if let d = r.byUDID[key] { return .found(d, r.byDevice[d.uniqueID]?.how ?? "link") }
        if let a = r.ambiguous[key] { return .ambiguous(a.message, settled: a.settled) }
        linkedElsewhere = Set(r.byDevice.keys)
    } else if !o.name.isEmpty {
        let same = phones.filter { $0.localizedName == o.name }
        if same.count == 1 { return .found(same[0], "--name") }
        if same.count > 1 {
            return .ambiguous("\(same.count) iPhone screens are named \"\(o.name)\", so phonecap can't tell which one to "
                + "use. Give each iPhone a unique name (on the iPhone: Settings > General > About > Name), then unplug and "
                + "replug it", settled: true)
        }
    }
    if o.anyIfSingle && phones.count == 1 && !linkedElsewhere.contains(phones[0].uniqueID) {
        return .found(phones[0], "the only iPhone screen (--any-if-single)")
    }
    return .notYet
}

func spin(_ seconds: Double) {
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
}

let deniedHint = "grant Camera to phonecap (com.lotus.phonecap): at the Mac, in Terminal, run native/phonecap/build/PhoneCap.app/Contents/MacOS/phonecap --request-access and click Allow (or turn phonecap on in System Settings > Privacy & Security > Camera)"

/// Exits 3 with a clear reason unless macOS allows this helper to use the camera (iPhone screen capture counts as one).
func ensureCameraAccess() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        return
    case .notDetermined:
        var answer: Bool?
        AVCaptureDevice.requestAccess(for: .video) { answer = $0 }
        let until = Date().addingTimeInterval(60)
        while answer == nil && Date() < until { spin(0.1) }
        if answer == true { return }
        log("camera access denied (no answer to the Camera prompt): \(deniedHint)")
        exit(3)
    case .denied:
        log("camera access denied: run tccutil reset Camera com.lotus.phonecap, then \(deniedHint)")
        exit(3)
    default:
        log("camera access denied (restricted by a profile or parental controls): \(deniedHint)")
        exit(3)
    }
}

/// --request-access: run once from Terminal at the Mac to get the Camera prompt and say what happened.
func requestAccessAndExit() {
    let before = AVCaptureDevice.authorizationStatus(for: .video)
    if before == .denied {
        log("Camera was denied before for phonecap. Run: tccutil reset Camera com.lotus.phonecap   then run --request-access again")
        exit(3)
    }
    if before == .notDetermined { log("asking macOS for Camera access: click Allow on the prompt (waits up to 2 minutes)") }
    var answer: Bool? = before == .authorized ? true : nil
    if answer == nil {
        AVCaptureDevice.requestAccess(for: .video) { answer = $0 }
        let until = Date().addingTimeInterval(120)
        while answer == nil && Date() < until { spin(0.1) }
    }
    if answer == true {
        log("camera access OK: the server can capture the iPhones now")
        // the phone's sound comes over the same capture; macOS may count it as Microphone
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            log("asking macOS for Microphone access (the iPhones' sound): click Allow (waits up to 2 minutes)")
            var mic: Bool?
            AVCaptureDevice.requestAccess(for: .audio) { mic = $0 }
            let until = Date().addingTimeInterval(120)
            while mic == nil && Date() < until { spin(0.1) }
        }
        let micOK = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        log(micOK ? "microphone access OK: the iPhones' sound can reach the live view"
                  : "microphone access NOT granted: the live view has no sound (System Settings > Privacy & Security > Microphone: turn phonecap on)")
        print("authorized")
        exit(0)
    }
    log("camera access NOT granted: \(deniedHint)")
    print("denied")
    exit(3)
}

// MARK: - own TCC identity

/// macOS asks the *responsible* process for Camera: under launchd that is node, which has no Camera usage string and
/// can't be added to the Camera list, so access is silently denied. Re-run ourselves with responsibility disclaimed
/// (as Chromium, LLDB and iTerm2 do): the child is then judged as phonecap itself (com.lotus.phonecap, with its own
/// usage string and its own entry in System Settings > Camera). stdin/stdout/stderr are inherited, so nothing changes
/// for the server. Set PHONECAP_NO_DISCLAIM=1 to skip.
typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
var disclaimedChild: pid_t = 0

func runDisclaimedIfNeeded() {
    let env = ProcessInfo.processInfo.environment
    if env["PHONECAP_DISCLAIMED"] == "1" || env["PHONECAP_NO_DISCLAIM"] == "1" { return }
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { return }
    let disclaim = unsafeBitCast(sym, to: DisclaimFn.self)
    guard let exe = Bundle.main.executablePath ?? CommandLine.arguments.first else { return }

    var attr: posix_spawnattr_t?
    guard posix_spawnattr_init(&attr) == 0 else { return }
    defer { posix_spawnattr_destroy(&attr) }
    guard disclaim(&attr, 1) == 0 else { return }

    var envList = env.filter { $0.key != "PHONECAP_DISCLAIMED" }.map { "\($0.key)=\($0.value)" }
    envList.append("PHONECAP_DISCLAIMED=1")
    var cenv: [UnsafeMutablePointer<CChar>?] = envList.map { strdup($0) }
    cenv.append(nil)
    var cargs: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
    cargs[0] = strdup(exe)
    cargs.append(nil)
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, exe, nil, &attr, cargs, cenv)
    for p in cargs { free(p) }
    for p in cenv { free(p) }
    if rc != 0 {
        log("could not re-run with its own Camera identity (\(rc)); trying in-process")
        return
    }
    disclaimedChild = pid
    for s in [SIGTERM, SIGINT, SIGHUP, SIGQUIT] {
        signal(s) { sig in
            if disclaimedChild > 0 { kill(disclaimedChild, sig) }
        }
    }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0 {
        if errno != EINTR { exit(4) }
    }
    let sig = status & 0x7f
    if sig == 0 { exit((status >> 8) & 0xff) }
    exit(128 + sig)
}

/// In the disclaimed child: exit if the wrapper (our parent) goes away, so a SIGKILLed wrapper never leaves us running.
func watchParent() {
    guard ProcessInfo.processInfo.environment["PHONECAP_DISCLAIMED"] == "1" else { return }
    let parent = getppid()
    Thread.detachNewThread {
        while true {
            Thread.sleep(forTimeInterval: 0.5)
            if getppid() != parent { exit(0) }
        }
    }
}

// MARK: - encoder

final class Encoder {
    let session: VTCompressionSession
    let width: Int
    let height: Int
    private let tag: UInt8 // the lane in the record's high nibble
    private let lowLatency: Bool
    private let statsLock = NSLock()
    private var frames = 0
    private var encSum = 0.0
    private var capSum = 0.0
    private var lastStats = nowMs()
    private static let startCode = Data([0, 0, 0, 1])

    init?(width: Int, height: Int, fps: Int, bitrate: Int, keySeconds: Double, profile profileName: String, lane: Int) {
        self.width = width
        self.height = height
        self.tag = UInt8((lane & 0x0f) << 4)
        func make(_ spec: [CFString: Any]?) -> VTCompressionSession? {
            var s: VTCompressionSession?
            let st = VTCompressionSessionCreate(
                allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
                encoderSpecification: spec as CFDictionary?, imageBufferAttributes: nil, compressedDataAllocator: nil,
                outputCallback: nil, refcon: nil, compressionSessionOut: &s)
            if st != noErr { log("VTCompressionSessionCreate failed (\(st))") }
            return st == noErr ? s : nil
        }
        var lowLatency = false
        var s: VTCompressionSession?
        if #available(macOS 11.3, *) {
            s = make([kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue as Any,
                      kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue as Any])
            lowLatency = s != nil
        }
        if s == nil { s = make([kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue as Any]) }
        if s == nil { s = make(nil) }
        guard let session = s else { return nil }
        self.session = session
        self.lowLatency = lowLatency

        func set(_ key: CFString, _ value: CFTypeRef, optional: Bool = false) {
            let st = VTSessionSetProperty(session, key: key, value: value)
            if st != noErr && !optional { log("encoder property \(key) not set (\(st))") } // optional: unsupported is expected, stay quiet
        }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse) // no B-frames
        // each frame comes out before the next one goes in (no look-ahead queue in the encoder): one less frame of delay
        set(kVTCompressionPropertyKey_MaxFrameDelayCount, 0 as CFNumber, optional: true)
        var profile: CFString = kVTProfileLevel_H264_Baseline_AutoLevel
        if profileName == "main" {
            profile = kVTProfileLevel_H264_Main_AutoLevel
        } else if #available(macOS 12.0, *) {
            profile = kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel
        }
        set(kVTCompressionPropertyKey_ProfileLevel, profile)
        set(kVTCompressionPropertyKey_AverageBitRate, bitrate as CFNumber)
        if !lowLatency {
            // cap bursts: 1.5x the average over any second
            set(kVTCompressionPropertyKey_DataRateLimits, [Double(bitrate) * 1.5 / 8, 1.0] as CFArray)
        }
        set(kVTCompressionPropertyKey_ExpectedFrameRate, fps as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, max(1, Int(Double(fps) * keySeconds)) as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, keySeconds as CFNumber)
        if #available(macOS 13.0, *) {
            set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue, optional: true)
        }
        VTCompressionSessionPrepareToEncodeFrames(session)
        log("lane \(lane) encoder \(width)x\(height) @\(fps) fps, \(bitrate / 1000) kbps, low-latency rate control \(lowLatency ? "on" : "off")")
    }

    /// A new frame rate while running (the lane drops frames itself; this keeps the rate control's budget per frame right).
    func setFps(_ fps: Int, keySeconds: Double) {
        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: max(1, Int(Double(fps) * keySeconds)) as CFNumber)
    }

    func invalidate() {
        VTCompressionSessionInvalidate(session)
    }

    /// A new target bitrate while running (the server's congestion control for a slow viewer's link).
    func setBitrate(_ bps: Int) {
        let st = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bps as CFNumber)
        if st != noErr { log("bitrate \(bps / 1000) kbps not set (\(st))") }
        if !lowLatency {
            _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: [Double(bps) * 1.5 / 8, 1.0] as CFArray)
        }
    }

    func encode(_ pb: CVPixelBuffer, captureMs: Double, forceKey: Bool) {
        let pts = CMClockGetTime(CMClockGetHostTimeClock())
        let props: CFDictionary? = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
        let started = DispatchTime.now().uptimeNanoseconds
        let st = VTCompressionSessionEncodeFrame(session, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid,
                                                 frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sbuf in
            guard status == noErr, let sbuf = sbuf, let self = self else { return }
            let encMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6
            self.output(sbuf, captureMs: captureMs, encMs: encMs)
        }
        if st != noErr {
            log("encode failed (\(st))")
            if st == kVTInvalidSessionErr { exit(6) }
        }
    }

    private func output(_ sb: CMSampleBuffer, captureMs: Double, encMs: Double) {
        var isKey = true
        if let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[String: Any]],
           let first = atts.first, let notSync = first[kCMSampleAttachmentKey_NotSync as String] as? Bool, notSync {
            isKey = false
        }
        guard let fmt = CMSampleBufferGetFormatDescription(sb), let block = CMSampleBufferGetDataBuffer(sb) else { return }
        var count = 0
        var nalLen: Int32 = 4
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                           parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                           nalUnitHeaderLengthOut: &nalLen)
        if isKey {
            var cfg = Data()
            for i in 0..<count {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                      parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                                      nalUnitHeaderLengthOut: nil) == noErr, let p = ptr {
                    cfg.append(Encoder.startCode)
                    cfg.append(p, count: size)
                }
            }
            emit(tag | 1, captureMs, cfg)
        }
        let total = CMBlockBufferGetDataLength(block)
        var avcc = Data(count: total)
        let copied = avcc.withUnsafeMutableBytes { (b: UnsafeMutableRawBufferPointer) -> OSStatus in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: total, destination: b.baseAddress!)
        }
        guard copied == noErr else { return }
        let L = Int(nalLen)
        var annexB = Data(capacity: total + 16)
        avcc.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
            var off = 0
            while off + L <= total {
                var n = 0
                for i in 0..<L { n = (n << 8) | Int(b[off + i]) }
                off += L
                if n <= 0 || off + n > total { break }
                annexB.append(Encoder.startCode)
                annexB.append(b.baseAddress!.advanced(by: off).assumingMemoryBound(to: UInt8.self), count: n)
                off += n
            }
        }
        let kind: UInt8 = isKey ? 2 : 3
        emit(tag | kind, captureMs, annexB)

        statsLock.lock()
        frames += 1
        encSum += encMs
        capSum += max(0, nowMs() - captureMs)
        let now = nowMs()
        if now - lastStats >= 1000 {
            let f = Double(frames)
            let obj: [String: Any] = ["encode_ms": encSum / f, "capture_to_encoded_ms": capSum / f, "fps": f * 1000 / (now - lastStats)]
            frames = 0
            encSum = 0
            capSum = 0
            lastStats = now
            statsLock.unlock()
            emitJSON(tag | 4, obj)
        } else {
            statsLock.unlock()
        }
    }
}

// MARK: - audio
//
// The phone's sound from the same capture session (the screen device is muxed). Samples come as 32-bit float,
// interleaved, asked for at 48 kHz stereo (resampled here if macOS gives another rate), cut into 20 ms frames and
// encoded with AudioToolbox's Opus encoder; a Mac without one gets G.711 u-law (8 kHz mono), which every browser
// plays too. Runs on its own queue; nothing here can stop the video: a failure only says so (kind 6, codec "none").
// Each frame's time is the capture time of its first sample (the host clock turned into wall-clock ms, as the video's).

let audioNoMore: OSStatus = 0x6e6f6d72 // "nomr": the converter's input proc has nothing more for this call

private let audioInputProc: AudioConverterComplexInputDataProc = { _, ioPackets, ioData, _, user in
    guard let user = user else {
        ioPackets.pointee = 0
        return audioNoMore
    }
    return Unmanaged<AudioTap>.fromOpaque(user).takeUnretainedValue().supply(ioPackets, ioData)
}

/// G.711 u-law of one sample (-1...1).
func ulaw(_ x: Float) -> UInt8 {
    var s = Int32(max(-1, min(1, x)) * 32767)
    let sign: Int32 = s < 0 ? 0x80 : 0
    if s < 0 { s = -s }
    s = min(s + 132, 32635)
    var exp: Int32 = 7
    var mask: Int32 = 0x4000
    while exp > 0 && (s & mask) == 0 {
        exp -= 1
        mask >>= 1
    }
    let mant = (s >> (exp + 3)) & 0x0f
    return UInt8(truncatingIfNeeded: ~(sign | (exp << 4) | mant))
}

final class AudioTap: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let output = AVCaptureAudioDataOutput()
    let queue = DispatchQueue(label: "phonecap.audio", qos: .userInitiated)
    static let rate = 48000.0
    static let frame = 960 // 20 ms at 48 kHz
    let channels = 2
    private let bitrate: Int
    private var converter: AudioConverterRef?
    private(set) var codec = "none"
    private var fifo: [Float] = [] // interleaved stereo at 48 kHz
    private var fifoTime = 0.0 // capture time (ms) of fifo's first sample
    private var feed: UnsafeMutablePointer<Float>?
    private var feedFrames: UInt32 = 0
    private var peak: Float = 0
    private var sumSq: Double = 0
    private var nSq = 0
    private var lastLevel = 0.0
    private var warned = Set<String>()
    private var on = false // "audio on" from the server: frames are sent only while someone listens

    init(bitrate: Int) {
        self.bitrate = bitrate
        super.init()
    }

    /// Adds the audio output to the session (between its begin/commitConfiguration); false (and why, in a kind 6
    /// record) when it can't be.
    func attach(to session: AVCaptureSession) -> Bool {
        let mic = AVCaptureDevice.authorizationStatus(for: .audio)
        if mic == .denied || mic == .restricted {
            say(reason: "macOS denies Microphone to phonecap, so the phone's sound can't be captured (System Settings > Privacy & Security > Microphone: turn phonecap on)")
            return false
        }
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false,
            AVSampleRateKey: AudioTap.rate,
            AVNumberOfChannelsKey: channels,
        ]
        guard session.canAddOutput(output) else {
            say(reason: "the phone's capture device takes no audio output")
            return false
        }
        output.setSampleBufferDelegate(self, queue: queue)
        session.addOutput(output)
        makeEncoder()
        var info: [String: Any] = ["codec": codec, "rate": codec == "pcmu" ? 8000 : 48000, "channels": codec == "pcmu" ? 1 : channels, "frame_ms": 20]
        if mic == .notDetermined { info["note"] = "Microphone access for phonecap was never asked (phonecap --request-access asks it)" }
        emitJSON(6, info)
        log("audio: \(codec) from the same capture session")
        return true
    }

    private func say(reason: String) {
        log("audio off: \(reason)")
        emitJSON(6, ["codec": "none", "reason": reason])
    }

    private func makeEncoder() {
        var inFmt = AudioStreamBasicDescription(
            mSampleRate: AudioTap.rate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(4 * channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(4 * channels),
            mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
        var outFmt = AudioStreamBasicDescription(
            mSampleRate: AudioTap.rate, mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
            mFramesPerPacket: UInt32(AudioTap.frame), mBytesPerFrame: 0, mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 0, mReserved: 0)
        var conv: AudioConverterRef?
        let st = AudioConverterNew(&inFmt, &outFmt, &conv)
        if st == noErr, let c = conv {
            var br = UInt32(bitrate)
            let bst = AudioConverterSetProperty(c, kAudioConverterEncodeBitRate, UInt32(MemoryLayout<UInt32>.size), &br)
            if bst != noErr { log("audio: Opus bitrate not set (\(bst)); the encoder's own") }
            converter = c
            codec = "opus"
        } else {
            log("audio: no Opus encoder on this Mac (AudioConverterNew \(st)); G.711 u-law instead")
            codec = "pcmu"
        }
    }

    /// From the server's stdin: send frames (someone listens) or not. Called on any thread.
    func set(_ wanted: Bool) {
        queue.async {
            if self.on == wanted { return }
            self.on = wanted
            self.fifo.removeAll(keepingCapacity: true)
            log("audio \(wanted ? "on" : "off")")
        }
    }

    private func warnOnce(_ s: String) {
        if warned.insert(s).inserted { log("audio: \(s)") }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard on, codec != "none" else { return }
        guard let fmt = CMSampleBufferGetFormatDescription(sb),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmt) else { return }
        let asbd = asbdPtr.pointee
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0, let block = CMSampleBufferGetDataBuffer(sb) else { return }
        let ch = max(1, Int(asbd.mChannelsPerFrame))
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let usable = asbd.mFormatID == kAudioFormatLinearPCM && !nonInterleaved
            && ((isFloat && asbd.mBitsPerChannel == 32) || (!isFloat && asbd.mBitsPerChannel == 16))
        if !usable {
            warnOnce("unexpected sample format (id \(asbd.mFormatID), flags \(asbd.mFormatFlags), \(asbd.mBitsPerChannel) bits); no sound")
            return
        }
        let total = CMBlockBufferGetDataLength(block)
        var raw = Data(count: total)
        let ok = raw.withUnsafeMutableBytes { (b: UnsafeMutableRawBufferPointer) -> OSStatus in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: total, destination: b.baseAddress!)
        }
        guard ok == noErr else { return }
        // to stereo float
        let n = min(frames, total / (ch * (isFloat ? 4 : 2)))
        guard n > 0 else { return }
        var stereo = [Float](repeating: 0, count: n * 2)
        raw.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
            for i in 0..<n {
                var l: Float
                var r: Float
                if isFloat {
                    let f = b.baseAddress!.assumingMemoryBound(to: Float.self)
                    l = f[i * ch]
                    r = ch > 1 ? f[i * ch + 1] : l
                } else {
                    let s16 = b.baseAddress!.assumingMemoryBound(to: Int16.self)
                    l = Float(s16[i * ch]) / 32768
                    r = ch > 1 ? Float(s16[i * ch + 1]) / 32768 : l
                }
                stereo[i * 2] = l
                stereo[i * 2 + 1] = r
            }
        }
        // another rate than asked: resampled to 48 kHz (linear; plenty for watching a phone)
        let srcRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : AudioTap.rate
        if abs(srcRate - AudioTap.rate) > 1 {
            warnOnce("the phone's sound comes at \(Int(srcRate)) Hz; resampled to 48 kHz")
            let outN = Int(Double(n) * AudioTap.rate / srcRate)
            var res = [Float](repeating: 0, count: outN * 2)
            for j in 0..<outN {
                let pos = Double(j) * srcRate / AudioTap.rate
                let i0 = min(n - 1, Int(pos))
                let i1 = min(n - 1, i0 + 1)
                let t = Float(pos - Double(i0))
                res[j * 2] = stereo[i0 * 2] * (1 - t) + stereo[i1 * 2] * t
                res[j * 2 + 1] = stereo[i0 * 2 + 1] * (1 - t) + stereo[i1 * 2 + 1] * t
            }
            stereo = res
        }
        // the buffer's capture time on the wall clock (its age from the host clock, as the video's)
        let wall = nowMs()
        var captured = wall
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if pts.isValid {
            let age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts)) * 1000
            if age >= 0 && age < 2000 { captured = wall - age }
        }
        let have = fifo.count / 2
        let expected = fifoTime + Double(have) * 1000 / AudioTap.rate
        // a gap or a jump (the sound stopped and started again): the queue's time follows the capture
        if have == 0 || abs(captured - expected) > 80 { fifoTime = captured - Double(have) * 1000 / AudioTap.rate }
        fifo.append(contentsOf: stereo)
        // at most 200 ms waiting: the sound never drifts behind the picture
        let most = AudioTap.frame * 10 * 2
        if fifo.count > most {
            let drop = (fifo.count - most) / 2
            fifo.removeFirst(drop * 2)
            fifoTime += Double(drop) * 1000 / AudioTap.rate
        }
        let step = AudioTap.frame * 2
        while fifo.count >= step {
            let chunk = Array(fifo[0..<step])
            fifo.removeFirst(step)
            let t = fifoTime
            fifoTime += 20
            meter(chunk)
            encode(chunk, time: t)
        }
    }

    private func meter(_ chunk: [Float]) {
        for v in chunk {
            let a = abs(v)
            if a > peak { peak = a }
            sumSq += Double(v * v)
        }
        nSq += chunk.count
        let now = nowMs()
        if now - lastLevel >= 2000 {
            let rms = nSq > 0 ? (sumSq / Double(nSq)).squareRoot() : 0
            func db(_ x: Double) -> Double { x > 0 ? (20 * log10(x) * 10).rounded() / 10 : -120 }
            emitJSON(6, ["level_db": db(rms), "peak_db": db(Double(peak))])
            peak = 0
            sumSq = 0
            nSq = 0
            lastLevel = now
        }
    }

    /// The converter's input: the 20 ms frame being encoded, then nothing more for this call.
    func supply(_ n: UnsafeMutablePointer<UInt32>, _ data: UnsafeMutablePointer<AudioBufferList>) -> OSStatus {
        guard let p = feed, feedFrames > 0 else {
            n.pointee = 0
            return audioNoMore
        }
        let give = min(n.pointee, feedFrames)
        data.pointee.mNumberBuffers = 1
        data.pointee.mBuffers.mNumberChannels = UInt32(channels)
        data.pointee.mBuffers.mDataByteSize = give * UInt32(4 * channels)
        data.pointee.mBuffers.mData = UnsafeMutableRawPointer(p)
        feed = p + Int(give) * channels
        feedFrames -= give
        n.pointee = give
        return noErr
    }

    private func encode(_ chunk: [Float], time: Double) {
        if codec == "pcmu" {
            // 48 kHz stereo -> 8 kHz mono: each output sample the mean of six input frames
            let outN = AudioTap.frame / 6
            var out = [UInt8](repeating: 0, count: outN)
            for j in 0..<outN {
                var s: Float = 0
                for k in 0..<6 {
                    let i = (j * 6 + k) * 2
                    s += chunk[i] + chunk[i + 1]
                }
                out[j] = ulaw(s / 12)
            }
            emit(5, time, Data(out))
            return
        }
        guard let conv = converter else { return }
        var input = chunk
        var bytes = [UInt8](repeating: 0, count: 1500)
        var desc = AudioStreamPacketDescription()
        var packets: UInt32 = 1
        var size: UInt32 = 0
        let st: OSStatus = input.withUnsafeMutableBufferPointer { ib in
            bytes.withUnsafeMutableBytes { ob in
                feed = ib.baseAddress
                feedFrames = UInt32(AudioTap.frame)
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: UInt32(channels), mDataByteSize: 1500, mData: ob.baseAddress))
                let r = AudioConverterFillComplexBuffer(conv, audioInputProc, Unmanaged.passUnretained(self).toOpaque(), &packets, &list, &desc)
                size = desc.mDataByteSize > 0 ? desc.mDataByteSize : list.mBuffers.mDataByteSize
                feed = nil
                feedFrames = 0
                return r
            }
        }
        if st != noErr && st != audioNoMore {
            warnOnce("Opus encode failed (\(st))")
            return
        }
        if packets > 0 && size > 0 && size <= 1500 {
            emit(5, time, Data(bytes[0..<Int(size)]))
        }
    }
}

// MARK: - capture

/// One encoder fed by the capture: its own size (scale of the native screen), frame rate and bitrate. Used on the
/// capture queue only.
final class EncodeLane {
    let id: Int
    var fps: Int
    var scale: Int
    var bitrate: Int
    var keySeconds: Double
    var encoder: Encoder?
    var keyWanted = true
    var lastEncodedAt = -1_000_000.0
    var pending: CVPixelBuffer? // the newest frame skipped by the frame rate, sent at the lane's next slot
    var pendingCaptured = 0.0
    var trailScheduled = false

    init(id: Int, fps: Int, scale: Int, bitrate: Int, keySeconds: Double) {
        self.id = id
        self.fps = max(1, min(60, fps))
        self.scale = max(10, min(100, scale))
        self.bitrate = max(200_000, min(50_000_000, bitrate))
        self.keySeconds = max(0.5, min(10, keySeconds))
    }
}

final class Capturer: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "phonecap.capture", qos: .userInteractive)
    let output = AVCaptureVideoDataOutput()
    var o: Options
    private var lanes: [Int: EncodeLane] = [:]
    private var transfer: VTPixelTransferSession?
    private var lastBuffer: CVPixelBuffer?
    private var lastRaw: CVPixelBuffer? // the last frame as captured (before any turn)
    private var lastFrameAt = 0.0
    private var gotFrame = false // a video frame came from the device (used on the capture queue only)
    private var input: AVCaptureDeviceInput?
    var audio: AudioTap?
    // the buffers' shape against the screen's own (see followSource); used on the capture queue only
    private var frameCount = 0
    private var disagreed = 0
    private var agreedOnce = false
    private var agreedSourceWidth = 0
    private var agreedSourceHeight = 0
    private var agreedBufferWidth = 0
    private var agreedBufferHeight = 0
    private var pinnedWidth = 0
    private var pinnedHeight = 0
    private var warned = false
    // "rotate": degrees clockwise the picture is turned before encoding; used on the capture queue only
    private var rotation = 0
    private lazy var ciContext = CIContext(options: [.cacheIntermediates: false])
    private var turnPool: CVPixelBufferPool?
    private var turnPoolWidth = 0
    private var turnPoolHeight = 0

    init(_ o: Options) {
        self.o = o
        super.init()
        lanes[0] = EncodeLane(id: 0, fps: o.fps, scale: o.scale, bitrate: o.bitrate, keySeconds: o.keySeconds)
    }

    func start(_ device: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: device)
        self.input = input
        session.beginConfiguration()
        guard session.canAddInput(input) else { throw NSError(domain: "phonecap", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot add the device input"]) }
        session.addInput(input)
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { throw NSError(domain: "phonecap", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot add the video output"]) }
        session.addOutput(output)
        // the phone's sound, from the same (muxed) device and session; the video never depends on it
        if o.audio && (device.hasMediaType(.muxed) || device.hasMediaType(.audio)) {
            let tap = AudioTap(bitrate: o.audioBitrate)
            if tap.attach(to: session) { audio = tap }
        } else if o.audio {
            emitJSON(6, ["codec": "none", "reason": "the phone's capture device carries no sound"])
        }
        session.commitConfiguration()

        do {
            try device.lockForConfiguration()
            // the capture runs at 60 so any lane can; a slower lane drops frames itself
            let want = 60.0
            if device.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= want && want <= $0.maxFrameRate }) {
                device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 60)
            }
            device.unlockForConfiguration()
        } catch {
            log("frame rate not set: \(error.localizedDescription)")
        }

        NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { n in
            let err = n.userInfo?[AVCaptureSessionErrorKey] as? NSError
            log("capture error: \(err?.localizedDescription ?? "unknown")")
            exit(4)
        }
        NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil) { _ in
            log("iPhone screen device disconnected")
            exit(5)
        }
        // the phone turned (or changed its screen mode): its video port has a new format
        NotificationCenter.default.addObserver(forName: NSNotification.Name("AVCaptureInputPortFormatDescriptionDidChangeNotification"),
                                               object: nil, queue: nil) { [weak self] _ in
            if let self = self, let size = self.sourceSize() { log("screen is now \(size.width)x\(size.height)") }
        }
        session.startRunning()
        log("capturing \(device.localizedName) [\(device.uniqueID)]")
        // the first-frame watchdog (see FIRST_FRAME_SECONDS): checked on the capture queue, where frames arrive
        queue.asyncAfter(deadline: .now() + FIRST_FRAME_SECONDS) { [weak self] in
            guard let self = self, !self.gotFrame else { return }
            log("no frames from the iPhone screen device in \(Int(FIRST_FRAME_SECONDS)) s (running: \(self.session.isRunning)); starting over")
            exit(9)
        }
    }

    /// The screen's own picture size now (the device's video port format), or nil when it doesn't say.
    private func sourceSize() -> (width: Int, height: Int)? {
        guard let port = input?.ports.first(where: { $0.mediaType == .video }), let format = port.formatDescription else { return nil }
        let d = CMVideoFormatDescriptionGetDimensions(format)
        if d.width <= 0 || d.height <= 0 { return nil }
        return (Int(d.width), Int(d.height))
    }

    /// The buffers must have the screen's shape (wide or tall). A running session can keep handing out the size it
    /// started with after the phone turns, the turned picture squashed into it: then the output is asked for the
    /// screen's own size (and again whenever that changes), and if the buffers still don't follow, a session that
    /// did agree earlier is ended (exit 8) so the server starts a new one, which takes the screen as it is now.
    private func followSource(width w: Int, height h: Int) {
        frameCount += 1
        if frameCount % 15 != 0 { return }
        guard let src = sourceSize() else { return }
        if pinnedWidth != 0 && (pinnedWidth != src.width || pinnedHeight != src.height) {
            pin(src.width, src.height) // the screen changed size again: keep asking for its own
            disagreed = 0
            return
        }
        if (src.width > src.height) == (w > h) {
            agreedOnce = true
            agreedSourceWidth = src.width
            agreedSourceHeight = src.height
            agreedBufferWidth = w
            agreedBufferHeight = h
            disagreed = 0
            warned = false
            return
        }
        disagreed += 1
        if disagreed < 2 { return }
        // only buffers that stood still while the screen's format changed are stuck; when it's the format that
        // stood still (or they never agreed), the buffers are the truth and nothing is touched
        let sourceChanged = src.width != agreedSourceWidth || src.height != agreedSourceHeight
        let buffersChanged = w != agreedBufferWidth || h != agreedBufferHeight
        guard agreedOnce && sourceChanged && !buffersChanged else {
            if !warned {
                warned = true
                log("buffers are \(w)x\(h) though the screen's format says \(src.width)x\(src.height); keeping the buffers")
            }
            return
        }
        if pinnedWidth == 0 {
            log("buffers stayed \(w)x\(h) after the screen turned to \(src.width)x\(src.height): asking for the screen's own size")
            pin(src.width, src.height)
            disagreed = 0
            return
        }
        if disagreed >= 8 {
            log("the picture kept its old shape (\(w)x\(h)) after the phone turned to \(src.width)x\(src.height); starting the capture over")
            exit(8)
        }
    }

    /// Ask the output for buffers of this size (off the capture queue: AVFoundation reconfigures the session).
    private func pin(_ width: Int, _ height: Int) {
        pinnedWidth = width
        pinnedHeight = height
        let settings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ]
        let out = output
        DispatchQueue.main.async { out.videoSettings = settings }
    }

    /// The frame turned `rotation` degrees clockwise (Core Image), or nil if it can't be.
    private func turned(_ pb: CVPixelBuffer) -> CVPixelBuffer? {
        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)
        let ow = rotation == 180 ? w : h
        let oh = rotation == 180 ? h : w
        if turnPool == nil || turnPoolWidth != ow || turnPoolHeight != oh {
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey as String: ow,
                kCVPixelBufferHeightKey as String: oh,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            ]
            var made: CVPixelBufferPool?
            guard CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &made) == kCVReturnSuccess, made != nil else { return nil }
            turnPool = made
            turnPoolWidth = ow
            turnPoolHeight = oh
        }
        guard let pool = turnPool else { return nil }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out) == kCVReturnSuccess, let dst = out else { return nil }
        let how: CGImagePropertyOrientation = rotation == 90 ? .right : (rotation == 270 ? .left : .down)
        var image = CIImage(cvPixelBuffer: pb).oriented(how)
        image = image.transformed(by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y))
        ciContext.render(image, to: dst)
        return dst
    }

    /// Called on `queue`. Turn the picture this many degrees clockwise from now on (0 = as captured).
    func setRotation(_ degrees: Int) {
        let d = ((degrees / 90) * 90 % 360 + 360) % 360
        if d == rotation { return }
        rotation = d
        log("picture turned \(d) degrees clockwise")
        // a still screen sends no frames: the turned picture comes from the last one
        guard let raw = lastRaw else { return }
        let pb = d != 0 ? (turned(raw) ?? raw) : raw
        lastBuffer = pb
        lastFrameAt = nowMs()
        for id in lanes.keys.sorted() {
            if let lane = lanes[id] {
                lane.keyWanted = true
                encode(lane, pb, captured: nowMs())
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let raw = CMSampleBufferGetImageBuffer(sb) else { return }
        if !gotFrame {
            gotFrame = true
            log("first frame \(CVPixelBufferGetWidth(raw))x\(CVPixelBufferGetHeight(raw))")
        }
        followSource(width: CVPixelBufferGetWidth(raw), height: CVPixelBufferGetHeight(raw))
        lastRaw = raw
        let pb = rotation != 0 ? (turned(raw) ?? raw) : raw
        let wall = nowMs()
        var captured = wall
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if pts.isValid {
            // capture timestamps are on the host clock: turn the age of the frame into wall-clock time
            let age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts)) * 1000
            if age >= 0 && age < 1000 { captured = wall - age }
        }
        lastBuffer = pb
        lastFrameAt = nowMs()
        for id in lanes.keys.sorted() {
            if let lane = lanes[id] { offer(lane, pb, captured: captured) }
        }
    }

    /// A captured frame for one lane: encoded now, or (faster than the lane's frame rate) kept as its newest and sent
    /// at the lane's next slot unless a newer one comes first, so the last change of a still screen always shows.
    private func offer(_ lane: EncodeLane, _ pb: CVPixelBuffer, captured: Double) {
        let interval = 1000.0 / Double(lane.fps)
        if lane.keyWanted || nowMs() - lane.lastEncodedAt >= interval * 0.8 {
            encode(lane, pb, captured: captured)
            return
        }
        lane.pending = pb
        lane.pendingCaptured = captured
        scheduleTrail(lane)
    }

    private func scheduleTrail(_ lane: EncodeLane) {
        if lane.trailScheduled { return }
        lane.trailScheduled = true
        let interval = 1000.0 / Double(lane.fps)
        let wait = max(1.0, interval - (nowMs() - lane.lastEncodedAt))
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(wait.rounded(.up)))) { [weak self] in
            guard let self = self else { return }
            lane.trailScheduled = false
            guard self.lanes[lane.id] === lane, let p = lane.pending else { return }
            if nowMs() - lane.lastEncodedAt < interval * 0.8 {
                self.scheduleTrail(lane)
                return
            }
            self.encode(lane, p, captured: lane.pendingCaptured)
        }
    }

    /// The frame scaled to the lane encoder's size (VideoToolbox's pixel transfer: hardware, cheap), or nil.
    private func scaled(_ pb: CVPixelBuffer, for enc: Encoder) -> CVPixelBuffer? {
        if transfer == nil {
            var t: VTPixelTransferSession?
            guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &t) == noErr, let made = t else { return nil }
            transfer = made
        }
        guard let t = transfer, let pool = VTCompressionSessionGetPixelBufferPool(enc.session) else { return nil }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out) == kCVReturnSuccess, let dst = out else { return nil }
        guard VTPixelTransferSessionTransferImage(t, from: pb, to: dst) == noErr else { return nil }
        return dst
    }

    private func encode(_ lane: EncodeLane, _ pb: CVPixelBuffer, captured: Double) {
        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)
        var tw = w
        var th = h
        if lane.scale < 100 {
            tw = max(16, Int(Double(w) * Double(lane.scale) / 100) & ~1)
            th = max(16, Int(Double(h) * Double(lane.scale) / 100) & ~1)
        }
        if lane.encoder == nil || lane.encoder!.width != tw || lane.encoder!.height != th {
            lane.encoder?.invalidate()
            guard let e = Encoder(width: tw, height: th, fps: lane.fps, bitrate: lane.bitrate, keySeconds: lane.keySeconds,
                                  profile: o.profile, lane: lane.id) else {
                log("could not create the H.264 encoder")
                exit(6)
            }
            lane.encoder = e
            emitJSON(UInt8((lane.id & 0x0f) << 4), ["width": tw, "height": th, "fps": lane.fps, "scale": lane.scale, "lane": lane.id])
            lane.keyWanted = true
        }
        guard let enc = lane.encoder else { return }
        var frame = pb
        if tw != w || th != h, let small = scaled(pb, for: enc) {
            frame = small
        } // else VideoToolbox scales it itself
        let force = lane.keyWanted
        lane.keyWanted = false
        lane.pending = nil
        lane.lastEncodedAt = nowMs()
        enc.encode(frame, captureMs: captured, forceKey: force)
    }

    /// Called on `queue`. Force an IDR on a lane; if the screen is still (no new frames), re-encode the last one now.
    func requestKey(_ id: Int) {
        guard let lane = lanes[id] else { return }
        lane.keyWanted = true
        if let pb = lastBuffer, nowMs() - lastFrameAt > 30 {
            encode(lane, pb, captured: nowMs())
        }
    }

    /// Called on `queue`. A new target bitrate for a lane (the server's congestion control); kept for a later encoder.
    func setBitrate(_ id: Int, _ bps: Int) {
        guard let lane = lanes[id] else { return }
        let b = max(200_000, min(50_000_000, bps))
        if b == lane.bitrate { return }
        lane.bitrate = b
        lane.encoder?.setBitrate(b)
    }

    /// Called on `queue`. A new frame rate for a lane (the server lowers it for a slow link).
    func setFps(_ id: Int, _ fps: Int) {
        guard let lane = lanes[id] else { return }
        let f = max(1, min(60, fps))
        if f == lane.fps { return }
        lane.fps = f
        lane.encoder?.setFps(f, keySeconds: lane.keySeconds)
    }

    /// Called on `queue`. Adds a lane, or changes one (a new scale makes a new encoder, with a keyframe).
    func setLane(_ id: Int, fps: Int, scale: Int, bitrate: Int, keySeconds: Double) {
        guard id >= 0 && id <= 7 else { return }
        let lane: EncodeLane
        if let have = lanes[id] {
            lane = have
            let s = max(10, min(100, scale))
            if s != lane.scale {
                lane.scale = s
                lane.encoder?.invalidate()
                lane.encoder = nil
                lane.keyWanted = true
            }
            lane.keySeconds = max(0.5, min(10, keySeconds))
            setFps(id, fps)
            setBitrate(id, bitrate)
        } else {
            lane = EncodeLane(id: id, fps: fps, scale: scale, bitrate: bitrate, keySeconds: keySeconds)
            lanes[id] = lane
        }
        log("lane \(id): \(lane.fps) fps, \(lane.scale)%, \(lane.bitrate / 1000) kbps")
        // a still screen sends no frames: the lane's first picture comes from the last one
        if lane.encoder == nil, let pb = lastBuffer, nowMs() - lastFrameAt > 30 {
            encode(lane, pb, captured: nowMs())
        }
    }

    /// Called on `queue`. Stops a lane's encoder.
    func removeLane(_ id: Int) {
        guard let lane = lanes.removeValue(forKey: id) else { return }
        lane.encoder?.invalidate()
        lane.encoder = nil
        lane.pending = nil
        log("lane \(id) closed")
    }
}

// MARK: - main

let opts = parseOptions()
runDisclaimedIfNeeded()
watchParent()
if opts.requestAccess { requestAccessAndExit() }
allowScreenCaptureDevices()
ensureCameraAccess()

if opts.list {
    spin(3)
    let all = captureDevices()
    let map = resolve(all, want: opts.udid, wantName: opts.name, allNames: true)
    if !map.listed { log("idevice_id (libimobiledevice) not found or failed: UDIDs come from the USB serials only") }
    for u in map.udids {
        let screen = map.byUDID[hexOnly(u)].map { "screen \($0.uniqueID)" } ?? "no screen linked"
        log("iPhone \(u) named \"\(map.names[u] ?? "?")\": \(screen)")
    }
    let cmio = cmioStrings()
    for d in all where isPhoneScreen(d) {
        let props = (cmio[d.uniqueID] ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
        log("screen \(d.uniqueID) CoreMediaIO: \(props.isEmpty ? "none" : props.joined(separator: ", "))")
    }
    for p in usbApplePhones() {
        log("USB Apple device serial \(p.serial) locationID 0x\(String(p.location, radix: 16)) (\(p.strings.count) registry strings)")
    }
    print("uniqueID\tname\tudid\thow\tkind")
    for d in all {
        let hit = map.byDevice[d.uniqueID]
        let how = hit?.how ?? (isPhoneScreen(d) ? "no link" : "not an iPhone screen")
        let kind = isPhoneScreen(d) ? "iphone-screen" : d.modelID
        print("\(d.uniqueID)\t\(d.localizedName)\t\(hit?.udid ?? "unresolved")\t\(how)\t\(kind)")
    }
    var shown = Set<String>()
    for a in map.ambiguous.values where shown.insert(a.message).inserted { log("error: \(a.message)") }
    exit(0)
}

// screen-capture devices show up a moment after they're allowed
var device: AVCaptureDevice?
var linkedBy = ""
var sameName: String?
let deadline = Date().addingTimeInterval(opts.waitSeconds)
while device == nil && Date() < deadline {
    switch pickDevice(opts) {
    case .found(let d, let how):
        device = d
        linkedBy = how
    case .ambiguous(let message, let settled):
        if settled {
            log("error: \(message)")
            exit(7)
        }
        sameName = message // a same-named iPhone's screen may still show up: wait, then say so
        spin(0.25)
    case .notYet:
        spin(0.25)
    }
}
guard let phone = device else {
    if let message = sameName {
        log("error: \(message)")
        exit(7)
    }
    let names = captureDevices().map { "\($0.localizedName) [\($0.uniqueID)]" }.joined(separator: ", ")
    log("no screen capture device for this iPhone (is it unlocked and trusted? found: \(names.isEmpty ? "none" : names))")
    exit(2)
}
log("screen for \(opts.udid.isEmpty ? opts.name : opts.udid): \(phone.localizedName) [\(phone.uniqueID)], linked by \(linkedBy)")

let capturer = Capturer(opts)
do {
    try capturer.start(phone)
} catch {
    log("could not start capture: \(error.localizedDescription)")
    exit(4)
}

Thread.detachNewThread {
    while let line = readLine() {
        let parts = line.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ").map { String($0) }
        guard let cmd = parts.first else { continue }
        let n = parts.count
        switch cmd {
        case "quit":
            exit(0)
        case "key":
            // "key" (lane 0) or "key <lane>"
            let id = n >= 2 ? (Int(parts[1]) ?? 0) : 0
            capturer.queue.async { capturer.requestKey(id) }
        case "bitrate":
            // "bitrate <bit/s>" (lane 0) or "bitrate <lane> <bit/s>": the server's congestion control
            if n == 2, let bps = Int(parts[1]) {
                capturer.queue.async { capturer.setBitrate(0, bps) }
            } else if n >= 3, let id = Int(parts[1]), let bps = Int(parts[2]) {
                capturer.queue.async { capturer.setBitrate(id, bps) }
            }
        case "fps":
            if n >= 3, let id = Int(parts[1]), let f = Int(parts[2]) {
                capturer.queue.async { capturer.setFps(id, f) }
            }
        case "lane":
            // "lane <id> <fps> <scale %> <bit/s> [<key seconds>]"
            if n >= 5, let id = Int(parts[1]), let f = Int(parts[2]), let s = Int(parts[3]), let b = Int(parts[4]) {
                let ks = n >= 6 ? (Double(parts[5]) ?? opts.keySeconds) : opts.keySeconds
                capturer.queue.async { capturer.setLane(id, fps: f, scale: s, bitrate: b, keySeconds: ks) }
            }
        case "unlane":
            if n >= 2, let id = Int(parts[1]) {
                capturer.queue.async { capturer.removeLane(id) }
            }
        case "audio":
            // "audio on" / "audio off": send the phone's sound (someone listens) or not
            capturer.audio?.set(n >= 2 && parts[1] == "on")
        case "rotate":
            // "rotate <0|90|180|270>": degrees clockwise
            if n >= 2, let d = Int(parts[1]) {
                capturer.queue.async { capturer.setRotation(d) }
            }
        default:
            break
        }
    }
    exit(0) // stdin closed: the server is gone
}

dispatchMain()
