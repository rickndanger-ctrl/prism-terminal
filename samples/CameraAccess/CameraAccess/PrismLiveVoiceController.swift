import AVFoundation
import Speech
import Foundation
import Combine
import CodexLensKit

struct PrismVoiceUtterance: Identifiable, Equatable, Sendable {
    let id: UUID
    let text: String
}

/// The audio callback may only append to the current recognizer. Clearing this
/// bridge before ending recognition prevents late buffers crossing turn boundaries.
private final class PrismVoiceCaptureBridge: @unchecked Sendable {
    struct Activity: Sendable { let segment: UUID; let rms: Float; let time: TimeInterval }
    struct Diagnostics: Sendable {
        let audioAt: TimeInterval
        let rms: Float
        let peakRMS: Float
        let peak: Float
        let buffers: Int
        let appendedBuffers: Int
        let appendedFrames: Int
        let requestActive: Bool
        let sampleRate: Double
        let channels: Int
    }
    struct Report: Sendable { let activity: Activity?; let diagnostics: Diagnostics? }
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var segment: UUID?
    private var lastMeterAt: TimeInterval = 0
    private var peak: Float = 0
    private var lastDiagnosticAt: TimeInterval = 0
    private var debugBuffers = 0
    private var debugAppendedBuffers = 0
    private var debugAppendedFrames = 0
    private var debugPeak: Float = 0
    private var debugPeakRMS: Float = 0

    func resetDiagnostics() {
        lock.lock(); defer { lock.unlock() }
        lastDiagnosticAt = 0
        debugBuffers = 0; debugAppendedBuffers = 0; debugAppendedFrames = 0
        debugPeak = 0; debugPeakRMS = 0
    }

    func use(_ request: SFSpeechAudioBufferRecognitionRequest?, segment: UUID? = nil) {
        lock.lock(); defer { lock.unlock() }
        self.request = request; self.segment = segment
        lastMeterAt = 0; peak = 0
    }

    func append(_ buffer: AVAudioPCMBuffer) -> Report? {
        lock.lock(); defer { lock.unlock() }
        let now = ProcessInfo.processInfo.systemUptime
        let bound = request != nil && segment != nil
        if bound { request?.append(buffer) }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return nil }
        var sum: Float = 0
        var amplitude: Float = 0
        if let channel = buffer.floatChannelData?[0] {
            for index in 0..<count {
                sum += channel[index] * channel[index]
                amplitude = max(amplitude, abs(channel[index]))
            }
        } else if let channel = buffer.int16ChannelData?[0] {
            for index in 0..<count {
                let value = Float(channel[index]) / 32768
                sum += value * value; amplitude = max(amplitude, abs(value))
            }
        }
        let rms = sqrt(sum / Float(count))
        var diagnostics: Diagnostics?
        #if DEBUG
        debugBuffers += 1
        if bound { debugAppendedBuffers += 1; debugAppendedFrames += count }
        debugPeak = max(debugPeak, amplitude); debugPeakRMS = max(debugPeakRMS, rms)
        if now - lastDiagnosticAt >= 5 {
            lastDiagnosticAt = now
            diagnostics = Diagnostics(audioAt: Date().timeIntervalSince1970, rms: rms,
                peakRMS: debugPeakRMS, peak: debugPeak, buffers: debugBuffers,
                appendedBuffers: debugAppendedBuffers, appendedFrames: debugAppendedFrames,
                requestActive: bound, sampleRate: buffer.format.sampleRate, channels: Int(buffer.format.channelCount))
            debugPeak = 0; debugPeakRMS = 0
        }
        #endif
        let heartbeat = diagnostics.map { Report(activity: nil, diagnostics: $0) }
        guard bound, let segment else { return heartbeat } // Discard while thinking/speaking.
        peak = max(peak, rms)
        guard now - lastMeterAt >= 0.1 else { return heartbeat }
        lastMeterAt = now
        let activity = Activity(segment: segment, rms: peak, time: now)
        peak = 0
        return Report(activity: activity, diagnostics: diagnostics)
    }
}

private final class PrismVoiceHTTPDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Keep gateway credentials on the configured origin.
    }
}

/// Hands-free turns use local recognition, the existing Codex terminal, and
/// gateway speech. Recognition and playback never run at the same time.
@MainActor
final class PrismLiveVoiceController: NSObject, ObservableObject {
    @Published private(set) var active = false { didSet { publishDiagnostics() } }
    @Published private(set) var phase: LiveVoicePhase = .off { didSet { publishDiagnostics() } }
    @Published private(set) var transcript = ""
    @Published private(set) var notice = ""
    @Published private(set) var utterance: PrismVoiceUtterance?
    @Published private(set) var waitingRequestID: String?
    @Published private(set) var inputName = "Microphone" { didSet { publishDiagnostics() } }
    var status: String { phase.title }

    private let engine = AVAudioEngine()
    private let capture = PrismVoiceCaptureBridge()
    private let recognizer = SFSpeechRecognizer(locale: .current)
    private var recognition: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var draft = DictationDraft()
    private var silence = LiveVoiceSilenceGate()
    private var replies = LiveVoiceReplyGate()
    private var idleRecovery = LiveVoiceRecognitionRecovery()
    private var segmentStartedAt: TimeInterval = 0
    private var segmentHasText = false
    private var debugSegmentNumber = 0
    private var debugASRCallbacks = 0
    private var debugASRResults = 0
    private var debugASRErrors = 0
    private var debugASRStaleCallbacks = 0
    private var generation = UUID()
    private var segmentID: UUID?
    private var hasTap = false
    private var ownsAudioSession = false
    private var keepInBackground = true
    private var voice = "af_heart"
    private var gateway = ""
    private var inputUID: String?
    private var startupTask: Task<Void, Never>?
    private var speechTask: Task<Void, Never>?
    private var speechPrefetchTask: Task<Data, Error>?
    private var replyWaitStartedAt: TimeInterval = 0
    private var finalizationStartedAt: TimeInterval = 0
    private var silenceTask: Task<Void, Never>?
    private var rotationTask: Task<Void, Never>?
    private var finishTask: Task<Void, Never>?
    private var player: AVAudioPlayer?
    private var utteranceHandler: ((PrismVoiceUtterance) -> Void)?
    private var observers: [NSObjectProtocol] = []
    private enum FinishReason: Equatable { case submit, rotate }
    private var finishReason: FinishReason?
    private let network: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 90
        configuration.timeoutIntervalForResource = 120
        return URLSession(configuration: configuration, delegate: PrismVoiceHTTPDelegate(), delegateQueue: nil)
    }()

    override init() {
        super.init()
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] event in
            let began = (event.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            if began { Task { @MainActor in self?.pause(message: "Audio was interrupted. Tap Start when you're ready.") } }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.checkRoute() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.pause(message: "The microphone was reset. Tap Start to reconnect.") }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.active, self.hasTap, self.phase != .starting,
                      !self.engine.isRunning else { return }
                self.pause(message: "The audio connection changed. Tap Start to reconnect.")
            }
        })
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        network.invalidateAndCancel()
    }

    func start(keepInBackground: Bool, voice: String,
               onUtterance: @escaping (PrismVoiceUtterance) -> Void) async {
        stop()
        resetDiagnostics()
        utteranceHandler = onUtterance
        active = true; phase = .warming; notice = ""; transcript = ""
        self.keepInBackground = keepInBackground
        self.voice = ["af_heart", "am_michael"].contains(voice) ? voice : "af_heart"
        let attempt = generation
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                _ = try PrismCodexBridge.client()
                self.gateway = PrismCodexBridge.address
                try await self.waitForVoice(attempt: attempt)
                guard self.isCurrent(attempt) else { return }
                self.phase = .starting
                guard let recognizer = self.recognizer, recognizer.supportsOnDeviceRecognition else {
                    throw self.failure("On-device dictation isn't available for this language.")
                }
                let speech = await withCheckedContinuation { continuation in
                    SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
                }
                guard self.isCurrent(attempt) else { return }
                guard speech == .authorized else { throw self.failure("Allow Speech Recognition for Prism Terminal in iPhone Settings.") }
                let microphone = await withCheckedContinuation { continuation in
                    AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
                }
                guard self.isCurrent(attempt) else { return }
                guard microphone else { throw self.failure("Allow Microphone access for Prism Terminal in iPhone Settings.") }
                try await self.configureAudio(attempt: attempt)
                guard self.isCurrent(attempt) else { return }
                try self.beginListening()
            } catch {
                guard self.isCurrent(attempt) else { return }
                self.pause(message: error.localizedDescription)
            }
        }
        startupTask = task
        await task.value
        if generation == attempt { startupTask = nil }
    }

    func stop(reason: String = "Stopped by an app control") {
        if active {
            UserDefaults.standard.set(reason, forKey: "prismLiveVoiceLastStopReason")
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "prismLiveVoiceLastStopAt")
        }
        generation = UUID()
        active = false
        startupTask?.cancel(); startupTask = nil
        speechTask?.cancel(); speechTask = nil
        speechPrefetchTask?.cancel(); speechPrefetchTask = nil
        stopRecognition()
        stopEngine()
        player?.stop(); player = nil
        if ownsAudioSession {
            ownsAudioSession = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        replies.reset(); waitingRequestID = nil; utterance = nil
        utteranceHandler = nil
        inputUID = nil
        phase = .off
    }

    func pause(message: String) {
        guard active else { return }
        stop(reason: message)
        phase = .paused; notice = message
    }

    func awaitReply(requestID: String) {
        guard active, waitingRequestID == nil || waitingRequestID == requestID else { return }
        if waitingRequestID == nil {
            replyWaitStartedAt = ProcessInfo.processInfo.systemUptime
            let defaults = UserDefaults.standard
            defaults.set(requestID, forKey: "prismLiveVoiceLastTimingRequestID")
            for key in ["ReplyWaitMs", "FirstSpeechMs", "SpeechChunks"] {
                defaults.removeObject(forKey: "prismLiveVoiceLast" + key)
            }
        }
        stopRecognition()
        if !keepInBackground { stopEngine() }
        replies.awaitReply(requestID: requestID)
        waitingRequestID = requestID
        phase = .waiting
    }

    func receiveReply(requestID: String, text: String, status: String) async {
        guard active, waitingRequestID == requestID else { return }
        recordLatency("ReplyWaitMs", since: replyWaitStartedAt)
        let final = replies.consume(requestID: requestID, text: text, status: status)
        waitingRequestID = nil; utterance = nil
        guard let final else {
            if status != "completed" { notice = status == "interrupted" ? "Codex was interrupted. You can speak again." : "Codex couldn't finish. Check the terminal for details." }
            await resumeAfterPlayback(attempt: generation)
            return
        }
        let spoken = LiveVoiceReadback.text(from: final)
        guard !spoken.isEmpty else { await resumeAfterPlayback(attempt: generation); return }
        phase = .preparingSpeech
        let attempt = generation
        let task = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.synthesizeAndPlay(spoken, attempt: attempt)
        }
        speechTask = task
        await withTaskCancellationHandler(operation: { await task.value }, onCancel: { task.cancel() })
        if generation == attempt { speechTask = nil }
    }

    /// This only skips speech. It never sends an interrupt to the Codex worker.
    func speakNow() {
        guard active else { return }
        guard waitingRequestID == nil else {
            notice = "Codex is still working. Its Stop control is in the terminal."
            return
        }
        guard phase == .speaking || phase == .preparingSpeech else { return }
        generation = UUID()
        speechTask?.cancel(); speechTask = nil
        speechPrefetchTask?.cancel(); speechPrefetchTask = nil
        player?.stop(); player = nil
        let attempt = generation
        speechTask = Task { [weak self] in
            guard let self else { return }
            await self.resumeAfterPlayback(attempt: attempt)
        }
    }

    private func isCurrent(_ attempt: UUID) -> Bool { active && generation == attempt && !Task.isCancelled }
    private func failure(_ message: String) -> NSError { NSError(domain: "PrismVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }

    private func publishDiagnostics() {
        #if DEBUG
        let defaults = UserDefaults.standard
        defaults.set(active, forKey: "prismLiveVoiceActive")
        defaults.set(phase.rawValue, forKey: "prismLiveVoicePhase")
        defaults.set(inputName, forKey: "prismLiveVoiceInput")
        defaults.set(engine.isRunning, forKey: "prismLiveVoiceEngineRunning")
        defaults.set(ownsAudioSession, forKey: "prismLiveVoiceOwnsAudioSession")
        defaults.set(request != nil, forKey: "prismLiveVoiceControllerRequestActive")
        defaults.set(segmentID != nil, forKey: "prismLiveVoiceSegmentActive")
        defaults.set(debugSegmentNumber, forKey: "prismLiveVoiceSegmentNumber")
        defaults.set(debugASRCallbacks, forKey: "prismLiveVoiceASRCallbacks")
        defaults.set(debugASRResults, forKey: "prismLiveVoiceASRResults")
        defaults.set(debugASRErrors, forKey: "prismLiveVoiceASRErrors")
        defaults.set(debugASRStaleCallbacks, forKey: "prismLiveVoiceASRStaleCallbacks")
        defaults.set(transcript.count, forKey: "prismLiveVoiceASRTextLength")
        defaults.set(recognition?.state.rawValue ?? -1, forKey: "prismLiveVoiceASRTaskState")
        defaults.set(recognizer?.isAvailable ?? false, forKey: "prismLiveVoiceRecognizerAvailable")
        #endif
    }

    private func resetDiagnostics() {
        for suffix in ["TimingRequestID", "SilenceWaitMs", "FinalizationMs", "FinalizationTimedOut", "ReplyWaitMs", "FirstSpeechMs", "SpeechChunks"] {
            UserDefaults.standard.removeObject(forKey: "prismLiveVoiceLast" + suffix)
        }
        #if DEBUG
        capture.resetDiagnostics()
        debugSegmentNumber = 0; debugASRCallbacks = 0; debugASRResults = 0
        debugASRErrors = 0; debugASRStaleCallbacks = 0
        let defaults = UserDefaults.standard
        for key in ["AudioAt", "RMS", "PeakRMS", "Peak", "Buffers", "AppendedBuffers", "AppendedFrames", "ASRLastErrorCode"] {
            defaults.set(0, forKey: "prismLiveVoice" + key)
        }
        defaults.set("", forKey: "prismLiveVoiceASRLastErrorDomain")
        #endif
    }

    private func gatewayRequest(_ path: String) throws -> URLRequest {
        _ = try PrismCodexBridge.client()
        guard gateway == PrismCodexBridge.address, let base = URL(string: gateway),
              let url = URL(string: path, relativeTo: base)?.absoluteURL else {
            throw failure("The Mac connection changed. Restart Live voice.")
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(PrismCodexBridge.token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private struct VoiceStatus: Decodable { let ready: Bool; let voices: [String]; let state: String; let message: String? }
    private struct VoiceFailure: Decodable { let message: String? }
    private func checkedResponse(_ response: URLResponse, data: Data) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(VoiceFailure.self, from: data))?.message
            throw failure(message ?? "Voice connection returned \(http.statusCode). Try again shortly.")
        }
        return http
    }

    private func waitForVoice(attempt: UUID) async throws {
        let deadline = Date().addingTimeInterval(30)
        while isCurrent(attempt) {
            var request = try gatewayRequest("/v1/voice/status")
            request.timeoutInterval = min(8, max(1, deadline.timeIntervalSinceNow))
            let (data, response) = try await network.data(for: request)
            guard isCurrent(attempt) else { throw CancellationError() }
            _ = try checkedResponse(response, data: data)
            let status = try JSONDecoder().decode(VoiceStatus.self, from: data)
            if status.ready {
                guard status.voices.contains(voice) else { throw failure("That voice isn't available on the Mac.") }
                notice = ""; return
            }
            guard status.state == "warming" else { throw failure(status.message ?? "The Mac voice service isn't available.") }
            guard Date() < deadline else { throw failure("Voice is still warming up. Tap Start again shortly.") }
            notice = status.message ?? "Loading the voice on your Mac…"
            try await Task.sleep(for: .milliseconds(800))
        }
        throw CancellationError()
    }

    private func configureAudio(attempt: UUID) async throws {
        let audio = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker]
        if #available(iOS 26.0, *) { options.insert(.allowBluetoothHFP) }
        else { options.insert(.allowBluetooth) }
        try audio.setCategory(.playAndRecord, mode: .measurement, options: options)
        try audio.setActive(true)
        ownsAudioSession = true
        let bluetooth = audio.availableInputs?.filter { $0.portType == .bluetoothHFP } ?? []
        let glasses = bluetooth.first { port in
            ["ray", "meta", "wayfarer", "headliner"].contains { port.portName.lowercased().contains($0) }
        } ?? bluetooth.first
        if let glasses {
            try audio.setPreferredInput(glasses)
            let deadline = Date().addingTimeInterval(1.5)
            while audio.currentRoute.inputs.first?.uid != glasses.uid && Date() < deadline {
                try await Task.sleep(for: .milliseconds(50))
                guard isCurrent(attempt) else { throw CancellationError() }
            }
            guard audio.currentRoute.inputs.first?.uid == glasses.uid else {
                throw failure("The glasses microphone isn't ready. Check Bluetooth and tap Start again.")
            }
        }
        guard let input = audio.currentRoute.inputs.first else { throw failure("No microphone is available.") }
        inputUID = input.uid; inputName = input.portName
    }

    private func checkRoute() {
        guard active, phase != .starting, phase != .warming, let inputUID else { return }
        if AVAudioSession.sharedInstance().currentRoute.inputs.first?.uid != inputUID {
            pause(message: "The microphone connection changed. Tap Start to reconnect.")
        }
    }

    private func ensureEngine() throws {
        if engine.isRunning && hasTap { return }
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw failure("No microphone input is available.") }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self, capture] buffer, _ in
            guard let report = capture.append(buffer) else { return }
            Task { @MainActor in
                guard let self, self.active else { return }
                #if DEBUG
                if let diagnostic = report.diagnostics, self.hasTap, self.engine.isRunning {
                    let defaults = UserDefaults.standard
                    defaults.set(diagnostic.audioAt, forKey: "prismLiveVoiceAudioAt")
                    defaults.set(diagnostic.rms, forKey: "prismLiveVoiceRMS")
                    defaults.set(diagnostic.peakRMS, forKey: "prismLiveVoicePeakRMS")
                    defaults.set(diagnostic.peak, forKey: "prismLiveVoicePeak")
                    defaults.set(diagnostic.buffers, forKey: "prismLiveVoiceBuffers")
                    defaults.set(diagnostic.appendedBuffers, forKey: "prismLiveVoiceAppendedBuffers")
                    defaults.set(diagnostic.appendedFrames, forKey: "prismLiveVoiceAppendedFrames")
                    defaults.set(diagnostic.requestActive, forKey: "prismLiveVoiceRequestActive")
                    defaults.set(diagnostic.sampleRate, forKey: "prismLiveVoiceSampleRate")
                    defaults.set(diagnostic.channels, forKey: "prismLiveVoiceChannels")
                    self.publishDiagnostics()
                }
                #endif
                guard let activity = report.activity, self.phase == .listening, self.segmentID == activity.segment else { return }
                self.silence.observe(rms: activity.rms, at: activity.time)
            }
        }
        hasTap = true
        do { engine.prepare(); try engine.start(); publishDiagnostics() }
        catch { stopEngine(); throw error }
    }

    private func stopEngine() {
        capture.use(nil)
        engine.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        publishDiagnostics()
    }

    private func beginListening() throws {
        guard active else { return }
        draft = DictationDraft(); transcript = ""; utterance = nil
        silence = LiveVoiceSilenceGate()
        idleRecovery = LiveVoiceRecognitionRecovery()
        try beginSegment()
    }

    private func beginSegment() throws {
        guard active, let recognizer else { return }
        let attempt = generation
        let segment = draft.beginSegment()
        segmentID = segment
        #if DEBUG
        debugSegmentNumber += 1
        #endif
        segmentStartedAt = ProcessInfo.processInfo.systemUptime
        segmentHasText = false
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true; request.taskHint = .dictation
        self.request = request
        recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal == true
            Task { @MainActor in
                guard let self else { return }
                #if DEBUG
                self.debugASRCallbacks += 1
                #endif
                guard self.active, self.generation == attempt, self.segmentID == segment else {
                    #if DEBUG
                    self.debugASRStaleCallbacks += 1
                    self.publishDiagnostics()
                    #endif
                    return
                }
                #if DEBUG
                if text != nil { self.debugASRResults += 1 }
                if let error {
                    self.debugASRErrors += 1
                    let failure = error as NSError
                    UserDefaults.standard.set(failure.code, forKey: "prismLiveVoiceASRLastErrorCode")
                    UserDefaults.standard.set(failure.domain, forKey: "prismLiveVoiceASRLastErrorDomain")
                }
                #endif
                if let text {
                    self.segmentHasText = self.segmentHasText || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    self.draft.update(text, segment: segment); self.transcript = self.draft.text
                }
                self.publishDiagnostics()
                if final {
                    if self.finishReason == nil { self.finishReason = .rotate }
                    self.finishSegment(segment: segment)
                } else if let error {
                    if self.finishReason != nil { self.finishSegment(segment: segment) }
                    else if !self.recoverIdleRecognition(error) {
                        self.pause(message: "Dictation paused. \(error.localizedDescription)")
                    }
                }
            }
        }
        capture.use(request, segment: segment)
        do { try ensureEngine() }
        catch { stopRecognition(); throw error }
        phase = .listening
        silenceTask?.cancel()
        silenceTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled, let self, self.active, self.generation == attempt,
                      self.segmentID == segment, self.phase == .listening else { return }
                if self.silence.shouldFinalize(at: ProcessInfo.processInfo.systemUptime, transcript: self.transcript) {
                    self.endSegment(reason: .submit); return
                }
            }
        }
        rotationTask?.cancel()
        rotationTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(45))
            guard !Task.isCancelled, let self, self.active, self.generation == attempt, self.segmentID == segment else { return }
            self.endSegment(reason: .rotate)
        }
    }

    private func recoverIdleRecognition(_ error: Error) -> Bool {
        let error = error as NSError
        guard active, phase == .listening, engine.isRunning, hasTap,
              SFSpeechRecognizer.authorizationStatus() == .authorized,
              AVAudioApplication.shared.recordPermission == .granted,
              let inputUID, AVAudioSession.sharedInstance().currentRoute.inputs.first?.uid == inputUID,
              let delay = idleRecovery.delay(errorDomain: error.domain, code: error.code,
                  segmentDuration: ProcessInfo.processInfo.systemUptime - segmentStartedAt,
                  segmentHasText: segmentHasText) else { return false }
        stopRecognition()
        let attempt = generation
        finishTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, self.isCurrent(attempt), self.phase == .listening, self.segmentID == nil else { return }
            guard self.engine.isRunning, self.hasTap,
                  SFSpeechRecognizer.authorizationStatus() == .authorized,
                  AVAudioApplication.shared.recordPermission == .granted,
                  AVAudioSession.sharedInstance().currentRoute.inputs.first?.uid == inputUID else {
                self.pause(message: "The microphone connection changed. Tap Start to reconnect.")
                return
            }
            do { try self.beginSegment() }
            catch { self.pause(message: "Dictation couldn't resume. \(error.localizedDescription)") }
        }
        return true
    }

    private func endSegment(reason: FinishReason) {
        guard let segment = segmentID, finishReason == nil else { return }
        finalizationStartedAt = ProcessInfo.processInfo.systemUptime
        if reason == .submit, let lastSpeech = silence.lastSpeechAt {
            recordLatency("SilenceWaitMs", since: lastSpeech)
        }
        finishReason = reason; phase = .finalizing
        silenceTask?.cancel(); rotationTask?.cancel()
        capture.use(nil)
        request?.endAudio()
        let attempt = generation
        finishTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1200))
            guard !Task.isCancelled, let self, self.active, self.generation == attempt else { return }
            self.finishSegment(segment: segment, timedOut: true)
        }
    }

    private func finishSegment(segment: UUID, timedOut: Bool = false) {
        guard segmentID == segment, let reason = finishReason else { return }
        if reason == .submit {
            recordLatency("FinalizationMs", since: finalizationStartedAt)
            UserDefaults.standard.set(timedOut, forKey: "prismLiveVoiceLastFinalizationTimedOut")
        }
        finishTask?.cancel(); finishTask = nil
        silenceTask?.cancel(); rotationTask?.cancel()
        capture.use(nil)
        draft.finishSegment(); transcript = draft.text
        segmentID = nil; finishReason = nil
        request?.endAudio(); recognition?.cancel()
        request = nil; recognition = nil
        if reason == .rotate {
            do { try beginSegment() }
            catch { pause(message: "Dictation couldn't resume. \(error.localizedDescription)") }
            return
        }
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            do { try beginListening() } catch { pause(message: error.localizedDescription) }
            return
        }
        let turn = PrismVoiceUtterance(id: UUID(), text: text)
        awaitReply(requestID: turn.id.uuidString)
        utterance = turn
        utteranceHandler?(turn)
    }

    private func stopRecognition() {
        silenceTask?.cancel(); silenceTask = nil
        rotationTask?.cancel(); rotationTask = nil
        finishTask?.cancel(); finishTask = nil
        segmentID = nil; finishReason = nil
        capture.use(nil)
        request?.endAudio(); recognition?.cancel()
        request = nil; recognition = nil
        draft.finishSegment()
    }

    private func recordLatency(_ name: String, since start: TimeInterval) {
        guard start > 0 else { return }
        UserDefaults.standard.set(max(0, (ProcessInfo.processInfo.systemUptime - start) * 1000),
                                  forKey: "prismLiveVoiceLast" + name)
    }

    private func speechAudio(_ text: String, attempt: UUID) async throws -> Data {
        guard isCurrent(attempt) else { throw CancellationError() }
        var request = try gatewayRequest("/v1/voice/speech")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text, "voice": voice, "speed": 1.0])
        let (data, response) = try await network.data(for: request)
        guard isCurrent(attempt) else { throw CancellationError() }
        let http = try checkedResponse(response, data: data)
        guard data.count >= 44, data.count <= 20 * 1024 * 1024,
              ["audio/wav", "audio/x-wav", "audio/wave"].contains(http.mimeType ?? ""),
              String(data: data.prefix(4), encoding: .ascii) == "RIFF",
              String(data: data.subdata(in: 8..<12), encoding: .ascii) == "WAVE" else {
            throw failure("The Mac didn't return a valid voice recording.")
        }
        return data
    }

    private func synthesizeAndPlay(_ text: String, attempt: UUID) async {
        var pending: Task<Data, Error>?
        defer {
            pending?.cancel()
            if generation == attempt { speechPrefetchTask = nil }
        }
        do {
            let chunks = LiveVoiceReadback.chunks(from: text)
            guard let first = chunks.first else { await resumeAfterPlayback(attempt: attempt); return }
            UserDefaults.standard.set(chunks.count, forKey: "prismLiveVoiceLastSpeechChunks")
            let synthesisStarted = ProcessInfo.processInfo.systemUptime
            var data = try await speechAudio(first, attempt: attempt)
            for index in chunks.indices {
                guard isCurrent(attempt) else { return }
                let player = try AVAudioPlayer(data: data)
                self.player = player
                guard player.prepareToPlay(), player.play() else { throw failure("The spoken reply couldn't play.") }
                if index == 0 { recordLatency("FirstSpeechMs", since: synthesisStarted) }
                phase = .speaking
                // Only one future chunk is synthesized, while this one plays.
                if index + 1 < chunks.count {
                    let next = chunks[index + 1]
                    pending = Task { try await self.speechAudio(next, attempt: attempt) }
                    speechPrefetchTask = pending
                } else { pending = nil; speechPrefetchTask = nil }
                while isCurrent(attempt), player.isPlaying { try await Task.sleep(for: .milliseconds(100)) }
                guard isCurrent(attempt) else { return }
                self.player = nil
                if let nextAudio = pending {
                    phase = .preparingSpeech
                    data = try await withTaskCancellationHandler(operation: { try await nextAudio.value },
                                                                onCancel: { nextAudio.cancel() })
                }
            }
            await resumeAfterPlayback(attempt: attempt)
        } catch {
            guard isCurrent(attempt) else { return }
            player?.stop(); player = nil
            notice = "The reply is in the terminal. Voice: \(error.localizedDescription)"
            await resumeAfterPlayback(attempt: attempt)
        }
    }

    private func resumeAfterPlayback(attempt: UUID) async {
        // Let speaker/Bluetooth buffers drain before accepting any microphone input.
        do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
        guard isCurrent(attempt) else { return }
        do { try beginListening() }
        catch { pause(message: "Dictation couldn't resume. \(error.localizedDescription)") }
    }
}
