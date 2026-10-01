import Foundation
import Speech
import ScreenCaptureKit
import CoreMedia
import AppKit
import CoreGraphics

// ---------------------------------------------------------------------------
// apple-stt: macOS CLI for real-time speech recognition.
//
// Two modes:
//   (default)        Read raw PCM float32 16 kHz mono from stdin.
//   --system-audio   Capture system audio via ScreenCaptureKit — works with
//                    any output device (speakers, AirPods, HDMI, etc.) and
//                    does not require a virtual audio driver.
//
// Output: JSON lines on stdout matching the Python sidecar event protocol.
// ---------------------------------------------------------------------------

let kSampleRate: Double = 16_000
let kRestartInterval: TimeInterval = 55  // restart before Apple's ~60 s limit

// MARK: - JSON helpers

func emitJSON(_ dict: [String: Any], to handle: FileHandle = .standardOutput) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let str = String(data: data, encoding: .utf8) else { return }
    handle.write((str + "\n").data(using: .utf8)!)
}

func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

// MARK: - Speech engine

class SpeechEngine {
    private let recognizer: SFSpeechRecognizer
    private let audioFormat: AVAudioFormat
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var restartTimer: DispatchSourceTimer?
    private var segmentCounter = 0
    private var taskGeneration = 0
    private var taskStartMs = 0
    private var lastPartialText = ""
    private var running = false
    private var stopping = false
    private var restarting = false
    private var stopCompletion: (() -> Void)?
    private var stopFallbackTimer: DispatchSourceTimer?
    private var restartFallbackTimer: DispatchSourceTimer?

    init(locale: String) {
        let loc = Locale(identifier: locale)
        guard let rec = SFSpeechRecognizer(locale: loc) else {
            emitJSON(["type": "error", "code": "no_recognizer",
                      "message": "SFSpeechRecognizer unavailable for \(locale)",
                      "recoverable": false])
            exit(1)
        }
        recognizer = rec
        audioFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                   sampleRate: kSampleRate,
                                   channels: 1,
                                   interleaved: false)!
    }

    func start() {
        running = true
        stopping = false
        startTask()
    }

    func stop(completion: (() -> Void)? = nil) {
        running = false
        stopping = true
        stopCompletion = completion
        cancelRestartTimer()
        request?.endAudio()
        task?.finish()
        scheduleStopFallback()
    }

    private var totalSamplesFed = 0
    private var lastFeedLog = 0

    func feedAudio(_ samples: [Float]) {
        guard let request = request, !samples.isEmpty else { return }
        let count = AVAudioFrameCount(samples.count)
        guard let buf = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: count) else { return }
        buf.frameLength = count
        samples.withUnsafeBufferPointer { src in
            buf.floatChannelData![0].update(from: src.baseAddress!, count: samples.count)
        }
        request.append(buf)

        totalSamplesFed += samples.count
        let secondsFed = totalSamplesFed / Int(kSampleRate)
        if secondsFed > lastFeedLog {
            lastFeedLog = secondsFed
            let rms = samples.map { $0 * $0 }.reduce(0, +) / Float(samples.count)
            emitJSON(["type": "debug", "message": "fed \(secondsFed)s of audio, rms=\(String(format: "%.4f", sqrt(rms)))"])
        }
    }

    // MARK: - Task lifecycle

    private func startTask() {
        task?.cancel()
        request?.endAudio()

        // Increment generation so callbacks from the cancelled task are ignored.
        taskGeneration += 1
        let gen = taskGeneration

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if #available(macOS 13, *) {
            req.addsPunctuation = false
        }
        req.taskHint = .dictation

        request = req
        taskStartMs = nowMs()
        lastPartialText = ""

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self, self.taskGeneration == gen else { return }

            if let result = result {
                let text = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)

                if result.isFinal {
                    self.emitFinal(text, result: result)
                    if self.stopping {
                        self.finishStop()
                    } else if self.restarting {
                        self.finishRestart()
                    } else if self.running {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                            self.startTask()
                        }
                    }
                } else if !text.isEmpty && text != self.lastPartialText {
                    self.lastPartialText = text
                    emitJSON(["type": "partial", "text": text])
                }
            } else if error != nil {
                if self.stopping {
                    self.finishStop()
                } else if self.restarting {
                    self.finishRestart()
                } else if self.running {
                    // Only restart on genuine errors, not cancellation
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        guard self.taskGeneration == gen else { return }
                        self.startTask()
                    }
                }
            }
        }

        scheduleRestart()
    }

    private func emitFinal(_ text: String, result: SFSpeechRecognitionResult?) {
        guard !text.isEmpty, text.count >= 2 else { return }
        segmentCounter += 1
        let confidence = result?.bestTranscription.segments.last
            .map { Double($0.confidence) } ?? 0.0
        emitJSON([
            "type": "final",
            "text": text,
            "confidence": confidence,
            "segmentId": segmentCounter,
        ])
    }

    private func scheduleRestart() {
        cancelRestartTimer()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + kRestartInterval)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.running, !self.stopping, !self.restarting else { return }
            self.beginRestart()
        }
        timer.resume()
        restartTimer = timer
    }

    private func cancelRestartTimer() {
        restartTimer?.cancel()
        restartTimer = nil
    }

    private func scheduleStopFallback() {
        stopFallbackTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1.2)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.stopping else { return }
            if !self.lastPartialText.isEmpty {
                self.emitFinal(self.lastPartialText, result: nil)
                self.lastPartialText = ""
            }
            self.finishStop()
        }
        timer.resume()
        stopFallbackTimer = timer
    }

    private func beginRestart() {
        restarting = true
        cancelRestartTimer()
        request?.endAudio()
        task?.finish()
        scheduleRestartFallback()
    }

    private func scheduleRestartFallback() {
        restartFallbackTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 0.8)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.restarting else { return }
            if !self.lastPartialText.isEmpty {
                self.emitFinal(self.lastPartialText, result: nil)
                self.lastPartialText = ""
            }
            self.finishRestart()
        }
        timer.resume()
        restartFallbackTimer = timer
    }

    private func finishRestart() {
        restartFallbackTimer?.cancel()
        restartFallbackTimer = nil
        restarting = false
        guard running else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            self.startTask()
        }
    }

    private func finishStop() {
        stopFallbackTimer?.cancel()
        stopFallbackTimer = nil
        restartFallbackTimer?.cancel()
        restartFallbackTimer = nil
        restarting = false
        stopping = false
        task = nil
        request = nil
        let completion = stopCompletion
        stopCompletion = nil
        completion?()
    }
}

// MARK: - System audio capture via ScreenCaptureKit

class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let onSamples: ([Float]) -> Void
    var errorOutput: FileHandle = .standardOutput  // overridden to stderr in audio-tap mode

    init(onSamples: @escaping ([Float]) -> Void) {
        self.onSamples = onSamples
        super.init()
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "AppleSTT", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        let filter = SCContentFilter(display: display,
                                     excludingApplications: [],
                                     exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Int(kSampleRate)
        config.channelCount = 1
        // Minimize video overhead — audio-only capture
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let scStream = SCStream(filter: filter, configuration: config, delegate: self)
        try scStream.addStreamOutput(self,
                                     type: .audio,
                                     sampleHandlerQueue: .global(qos: .userInteractive))
        try await scStream.startCapture()
        stream = scStream
    }

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &length, dataPointerOut: &dataPointer)
        guard status == kCMBlockBufferNoErr, let raw = dataPointer, length > 0 else { return }

        let sampleCount = length / MemoryLayout<Float>.size
        guard sampleCount > 0 else { return }

        var samples = [Float](repeating: 0, count: sampleCount)
        raw.withMemoryRebound(to: Float.self, capacity: sampleCount) { ptr in
            for i in 0..<sampleCount { samples[i] = ptr[i] }
        }
        onSamples(samples)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitJSON(["type": "error", "code": "system_audio_stopped",
                  "message": error.localizedDescription, "recoverable": true],
                 to: errorOutput)
    }

    func stop() {
        Task { try? await stream?.stopCapture() }
        stream = nil
    }
}

// MARK: - Stdin PCM reader

func runStdinReader(engine: SpeechEngine) {
    DispatchQueue.global(qos: .userInteractive).async {
        let chunkBytes = 6400  // 1600 samples (100 ms) * 4 bytes
        var rawBuf = [UInt8](repeating: 0, count: chunkBytes)

        while true {
            let n = fread(&rawBuf, 1, chunkBytes, stdin)
            if n <= 0 { break }

            let sampleCount = n / MemoryLayout<Float>.size
            var samples = [Float](repeating: 0, count: sampleCount)
            rawBuf.withUnsafeBufferPointer { ptr in
                ptr.baseAddress!.withMemoryRebound(to: Float.self, capacity: sampleCount) { fp in
                    for i in 0..<sampleCount { samples[i] = fp[i] }
                }
            }

            DispatchQueue.main.async { engine.feedAudio(samples) }
        }

        DispatchQueue.main.async {
            engine.stop {
                emitJSON(["type": "stopped"])
                exit(0)
            }
        }
    }
}

// MARK: - System audio mode

func runSystemAudioCapture(engine: SpeechEngine) {
    Task {
        let capture = SystemAudioCapture { samples in
            DispatchQueue.main.async { engine.feedAudio(samples) }
        }
        do {
            try await capture.start()
            emitJSON(["type": "system_audio_started"])
        } catch {
            emitJSON(["type": "error", "code": "system_audio_failed",
                      "message": error.localizedDescription, "recoverable": false])
            exit(1)
        }

        // Keep alive until SIGTERM / SIGINT
        let sigSources = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler {
                capture.stop()
                engine.stop()
                emitJSON(["type": "stopped"])
                exit(0)
            }
            src.resume()
            return src
        }
        _ = sigSources  // prevent deallocation
    }
}

// MARK: - Audio tap mode (PCM pipe, no STT)

// Global reference to keep the capture alive for the process lifetime.
private var globalCapture: SystemAudioCapture?

func runAudioTapMode(pipePath: String?) {
    // When launched via `open -a`, stderr is lost. Write a log file alongside the pipe.
    if let path = pipePath {
        let logPath = path + ".log"
        if FileManager.default.createFile(atPath: logPath, contents: nil),
           let logHandle = FileHandle(forWritingAtPath: logPath) {
            // Redirect stderr to the log file so we can diagnose issues.
            dup2(logHandle.fileDescriptor, STDERR_FILENO)
        }
    }

    // Determine output destination: named pipe or stdout.
    let outputHandle: FileHandle
    if let path = pipePath {
        // Write PID file so the launcher can find and signal us.
        let pidPath = path + ".pid"
        try? "\(ProcessInfo.processInfo.processIdentifier)".write(
            toFile: pidPath, atomically: true, encoding: .utf8)

        guard let fh = FileHandle(forWritingAtPath: path) else {
            emitJSON(["type": "error", "code": "pipe_open_failed",
                      "message": "Cannot open pipe at \(path)", "recoverable": false],
                     to: .standardError)
            exit(1)
        }
        outputHandle = fh
    } else {
        outputHandle = .standardOutput
    }

    let writeLock = NSLock()
    let capture = SystemAudioCapture { samples in
        samples.withUnsafeBufferPointer { ptr in
            let data = Data(bytes: ptr.baseAddress!, count: ptr.count * MemoryLayout<Float>.size)
            writeLock.lock()
            outputHandle.write(data)
            writeLock.unlock()
        }
    }
    capture.errorOutput = .standardError
    globalCapture = capture

    // Set up signal handlers on the main queue before starting capture.
    let sigSources = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler {
            globalCapture?.stop()
            emitJSON(["type": "stopped"], to: .standardError)
            if let path = pipePath {
                try? FileManager.default.removeItem(atPath: path + ".pid")
            }
            exit(0)
        }
        src.resume()
        return src
    }
    _ = sigSources

    // Start capture asynchronously — the run loop keeps the process alive.
    Task { @MainActor in
        do {
            try await capture.start()
            emitJSON(["type": "system_audio_started"], to: .standardError)
        } catch {
            emitJSON(["type": "error", "code": "system_audio_failed",
                      "message": error.localizedDescription, "recoverable": false],
                     to: .standardError)
            exit(1)
        }
    }
}

// MARK: - Entry point

let useSystemAudio = CommandLine.arguments.contains("--system-audio")
let useAudioTap = CommandLine.arguments.contains("--audio-tap")
let checkScreenCapture = CommandLine.arguments.contains("--check-screen-capture")
let requestScreenCapture = CommandLine.arguments.contains("--request-screen-capture")

// Setup-only actions: never start audio capture or the recognition pipeline.
if CommandLine.arguments.contains("--check-speech-permission") {
    emitJSON(["granted": SFSpeechRecognizer.authorizationStatus() == .authorized])
    exit(0)
}
if CommandLine.arguments.contains("--request-speech-permission") {
    let semaphore = DispatchSemaphore(value: 0)
    SFSpeechRecognizer.requestAuthorization { status in
        emitJSON(["granted": status == .authorized])
        semaphore.signal()
    }
    semaphore.wait()
    exit(0)
}

// Quick permission check: output JSON with granted status and exit.
if checkScreenCapture {
    let bundle = Bundle.main
    emitJSON([
        "type": "screen_capture_status",
        "granted": CGPreflightScreenCaptureAccess(),
        "identifier": bundle.bundleIdentifier ?? "unknown",
        "executablePath": bundle.executablePath ?? CommandLine.arguments.first ?? ""
    ])
    exit(0)
}

if requestScreenCapture {
    let bundle = Bundle.main
    emitJSON([
        "type": "screen_capture_status",
        "granted": CGRequestScreenCaptureAccess(),
        "identifier": bundle.bundleIdentifier ?? "unknown",
        "executablePath": bundle.executablePath ?? CommandLine.arguments.first ?? ""
    ])
    exit(0)
}

// Parse --locale <id> (default: en-US)
var localeId = "en-US"
if let idx = CommandLine.arguments.firstIndex(of: "--locale"),
   idx + 1 < CommandLine.arguments.count {
    localeId = CommandLine.arguments[idx + 1]
}

// Parse --pipe <path> (optional: write PCM to named pipe instead of stdout)
var pipePath: String? = nil
if let idx = CommandLine.arguments.firstIndex(of: "--pipe"),
   idx + 1 < CommandLine.arguments.count {
    pipePath = CommandLine.arguments[idx + 1]
}

// Audio-tap mode: capture system audio via ScreenCaptureKit and write raw
// PCM float32 16 kHz mono to a named pipe (or stdout).
// Requires NSApplication for stable ScreenCaptureKit XPC connection.
if useAudioTap {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)  // no dock icon, no menu bar
    runAudioTapMode(pipePath: pipePath)
    app.run()
    // not reached
}

// 1. Request speech recognition authorization
let authSem = DispatchSemaphore(value: 0)
SFSpeechRecognizer.requestAuthorization { status in
    if status != .authorized {
        emitJSON([
            "type": "error",
            "code": "auth_denied",
            "message": "Speech recognition not authorized. "
                + "Enable in System Settings > Privacy & Security > Speech Recognition.",
            "recoverable": false,
        ])
        exit(1)
    }
    authSem.signal()
}
authSem.wait()

// 2. Start engine
emitJSON(["type": "ready"])

let engine = SpeechEngine(locale: localeId)
engine.start()

// 3. Audio source
if useSystemAudio {
    runSystemAudioCapture(engine: engine)
} else {
    runStdinReader(engine: engine)
}

RunLoop.current.run()
