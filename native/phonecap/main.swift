// phonecap: capture an iPhone's screen over USB the way QuickTime does (CoreMediaIO screen-capture devices),
// encode it with VideoToolbox H.264 in real time, and write framed records to stdout for the phone-farm server.
//
// TCC: macOS counts iPhone screen capture as Camera. phonecap re-runs itself with "responsibility disclaimed" so it
// gets its own Camera entry (com.lotus.phonecap, inside build/PhoneCap.app) instead of inheriting node's under launchd.
// Grant it once at the Mac: `native/phonecap/build/PhoneCap.app/Contents/MacOS/phonecap --request-access` in Terminal, click Allow.
//
// stdout, one record after another (big-endian):
//   1 byte kind | 8 bytes capture time (float64, ms since the epoch) | 4 bytes payload length | payload
//   kinds: 0 info JSON {width,height,fps,scale}, 1 config (SPS+PPS, Annex B), 2 keyframe, 3 delta (Annex B),
//          4 stats JSON {encode_ms, capture_to_encoded_ms, fps}
// stdin: "key" forces an IDR now (re-encoding the current screen if nothing new arrived), "quit" exits.
// stderr: human-readable log lines. Exit codes: 2 no device, 3 camera access denied, 4 capture failed,
//          5 device disconnected, 6 encoder failed, 7 several iPhones share a name and can't be told apart.
// --udid: macOS 27 gives iPhone screens random UUIDs, so phonecap links them to UDIDs itself (see "UDID -> screen
//          device mapping"); --list prints each capture device's uniqueID, name, UDID (or "unresolved") and how.
//
// Build: scripts/build-native.mjs (npm run build): swiftc, then wraps it in build/PhoneCap.app and signs the bundle.

import AVFoundation
import CoreMedia
import CoreMediaIO
import CoreVideo
import Foundation
import IOKit
import VideoToolbox

signal(SIGPIPE, SIG_IGN)

func log(_ s: String) {
    FileHandle.standardError.write(("phonecap: " + s + "\n").data(using: .utf8)!)
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

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
    private let fps: Int
    private let lowLatency: Bool
    private let statsLock = NSLock()
    private var frames = 0
    private var encSum = 0.0
    private var capSum = 0.0
    private var lastStats = nowMs()
    private static let startCode = Data([0, 0, 0, 1])

    init?(width: Int, height: Int, o: Options) {
        self.width = width
        self.height = height
        self.fps = o.fps
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
        var profile: CFString = kVTProfileLevel_H264_Baseline_AutoLevel
        if o.profile == "main" {
            profile = kVTProfileLevel_H264_Main_AutoLevel
        } else if #available(macOS 12.0, *) {
            profile = kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel
        }
        set(kVTCompressionPropertyKey_ProfileLevel, profile)
        set(kVTCompressionPropertyKey_AverageBitRate, o.bitrate as CFNumber)
        if !lowLatency {
            // cap bursts: 1.5x the average over any second
            set(kVTCompressionPropertyKey_DataRateLimits, [Double(o.bitrate) * 1.5 / 8, 1.0] as CFArray)
        }
        set(kVTCompressionPropertyKey_ExpectedFrameRate, o.fps as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, Int(Double(o.fps) * o.keySeconds) as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, o.keySeconds as CFNumber)
        if #available(macOS 13.0, *) {
            set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue, optional: true)
        }
        VTCompressionSessionPrepareToEncodeFrames(session)
        log("encoder \(width)x\(height) @\(o.fps) fps, \(o.bitrate / 1000) kbps, low-latency rate control \(lowLatency ? "on" : "off")")
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
            emit(1, captureMs, cfg)
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
        emit(isKey ? 2 : 3, captureMs, annexB)

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
            emitJSON(4, obj)
        } else {
            statsLock.unlock()
        }
    }
}

// MARK: - capture

final class Capturer: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "phonecap.capture", qos: .userInteractive)
    let output = AVCaptureVideoDataOutput()
    var o: Options
    private var encoder: Encoder?
    private var keyWanted = true
    private var lastBuffer: CVPixelBuffer?
    private var lastFrameAt = 0.0
    private var scaledApplied = false

    init(_ o: Options) { self.o = o }

    func start(_ device: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        guard session.canAddInput(input) else { throw NSError(domain: "phonecap", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot add the device input"]) }
        session.addInput(input)
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { throw NSError(domain: "phonecap", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot add the video output"]) }
        session.addOutput(output)
        session.commitConfiguration()

        do {
            try device.lockForConfiguration()
            let want = Double(o.fps)
            if device.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= want && want <= $0.maxFrameRate }) {
                device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: CMTimeScale(o.fps))
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
        session.startRunning()
        log("capturing \(device.localizedName) [\(device.uniqueID)]")
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let wall = nowMs()
        var captured = wall
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if pts.isValid {
            // capture timestamps are on the host clock: turn the age of the frame into wall-clock time
            let age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts)) * 1000
            if age >= 0 && age < 1000 { captured = wall - age }
        }
        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)
        if o.scale < 100 && !scaledApplied {
            // downscale in the capture output (done by the capture pipeline, cheap), once the native size is known
            scaledApplied = true
            let tw = max(16, Int(Double(w) * Double(o.scale) / 100) & ~1)
            let th = max(16, Int(Double(h) * Double(o.scale) / 100) & ~1)
            self.output.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey as String: tw,
                kCVPixelBufferHeightKey as String: th,
            ]
            if w != tw || h != th { return } // the next frames come scaled
        }
        encode(pb, captured: captured, width: w, height: h)
    }

    private func encode(_ pb: CVPixelBuffer, captured: Double, width w: Int, height h: Int) {
        if encoder == nil || encoder!.width != w || encoder!.height != h {
            encoder?.invalidate()
            guard let e = Encoder(width: w, height: h, o: o) else {
                log("could not create the H.264 encoder")
                exit(6)
            }
            encoder = e
            emitJSON(0, ["width": w, "height": h, "fps": o.fps, "scale": o.scale])
            keyWanted = true
        }
        lastBuffer = pb
        lastFrameAt = nowMs()
        let force = keyWanted
        keyWanted = false
        encoder!.encode(pb, captureMs: captured, forceKey: force)
    }

    /// Called on `queue`. Force an IDR; if the screen is still (no new frames), re-encode the last one now.
    func requestKey() {
        keyWanted = true
        if let pb = lastBuffer, nowMs() - lastFrameAt > 30 {
            encode(pb, captured: nowMs(), width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb))
        }
    }

    /// Called on `queue`. A new target bitrate from the server; kept for an encoder made later (a new size) too.
    func setBitrate(_ bps: Int) {
        let b = max(200_000, min(50_000_000, bps))
        if b == o.bitrate { return }
        o.bitrate = b
        encoder?.setBitrate(b)
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
        let cmd = line.trimmingCharacters(in: .whitespaces)
        switch cmd {
        case "key": capturer.queue.async { capturer.requestKey() }
        case "quit": exit(0)
        default:
            // "bitrate <bit/s>": the server's congestion control
            let parts = cmd.split(separator: " ")
            if parts.count == 2, parts[0] == "bitrate", let bps = Int(String(parts[1])) {
                capturer.queue.async { capturer.setBitrate(bps) }
            }
        }
    }
    exit(0) // stdin closed: the server is gone
}

dispatchMain()
