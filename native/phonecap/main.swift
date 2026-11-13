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
//          5 device disconnected, 6 encoder failed.
//
// Build: scripts/build-native.mjs (npm run build): swiftc, then wraps it in build/PhoneCap.app and signs the bundle.

import AVFoundation
import CoreMedia
import CoreMediaIO
import CoreVideo
import Foundation
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

func pickDevice(_ o: Options) -> AVCaptureDevice? {
    let all = captureDevices()
    let want = hexOnly(o.udid)
    if want.count >= 8 {
        if let d = all.first(where: {
            let u = hexOnly($0.uniqueID)
            return u.count >= 8 && (u == want || u.contains(want) || want.contains(u))
        }) { return d }
    }
    if !o.name.isEmpty, let d = all.first(where: { isPhoneScreen($0) && $0.localizedName == o.name }) { return d }
    let phones = all.filter(isPhoneScreen)
    if o.anyIfSingle && phones.count == 1 {
        log("no device matched the UDID or name; using the only iPhone screen found (\(phones[0].localizedName))")
        return phones[0]
    }
    return nil
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

        func set(_ key: CFString, _ value: CFTypeRef) {
            let st = VTSessionSetProperty(session, key: key, value: value)
            if st != noErr { log("encoder property \(key) not set (\(st))") }
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
            set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue)
        }
        VTCompressionSessionPrepareToEncodeFrames(session)
        log("encoder \(width)x\(height) @\(o.fps) fps, \(o.bitrate / 1000) kbps, low-latency rate control \(lowLatency ? "on" : "off")")
    }

    func invalidate() {
        VTCompressionSessionInvalidate(session)
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
    let o: Options
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
    for d in captureDevices() {
        print("\(d.uniqueID)\t\(d.modelID)\t\(d.localizedName)\t\(isPhoneScreen(d) ? "iphone-screen" : "")")
    }
    exit(0)
}

// screen-capture devices show up a moment after they're allowed
var device: AVCaptureDevice?
let deadline = Date().addingTimeInterval(opts.waitSeconds)
while device == nil && Date() < deadline {
    device = pickDevice(opts)
    if device == nil { spin(0.25) }
}
guard let phone = device else {
    let names = captureDevices().map { "\($0.localizedName) [\($0.uniqueID)]" }.joined(separator: ", ")
    log("no screen capture device for this iPhone (is it unlocked and trusted? found: \(names.isEmpty ? "none" : names))")
    exit(2)
}

let capturer = Capturer(opts)
do {
    try capturer.start(phone)
} catch {
    log("could not start capture: \(error.localizedDescription)")
    exit(4)
}

Thread.detachNewThread {
    while let line = readLine() {
        switch line.trimmingCharacters(in: .whitespaces) {
        case "key": capturer.queue.async { capturer.requestKey() }
        case "quit": exit(0)
        default: break
        }
    }
    exit(0) // stdin closed: the server is gone
}

dispatchMain()
