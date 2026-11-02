import AVFoundation
import Speech
import CodexLensKit

/// Local speech-to-text for the command composer. It never sends a command or
/// opens a Realtime connection. The wearer reviews the draft and taps Send.
@MainActor
final class PrismDictation: ObservableObject {
    @Published private(set) var isListening = false
    @Published private(set) var isStarting = false
    @Published private(set) var isFinishing = false
    @Published private(set) var transcript = ""
    @Published private(set) var transcriptUpdate: DictationTranscriptUpdate?
    @Published private(set) var notice = ""
    @Published private(set) var inputName = "Microphone"
    private let engine = AVAudioEngine()
    private let capture = DictationAudioHandoff<AVAudioPCMBuffer>()
    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var recognitionEvents: PrismDictationRecognitionDelegate?
    private var draft = DictationDraft()
    private var sessionID = UUID()
    private var dictationID: UUID?
    private var hasTap = false
    private var rotation: Task<Void, Never>?
    private var finishTimeout: Task<Void, Never>?
    private var retirement: Task<Void, Never>?
    private var retiringRecognition: SFSpeechRecognitionTask?
    private var retiringEvents: PrismDictationRecognitionDelegate?
    private var endingSegment = false
    private var retiringSegment = false
    private var captureStarts = 0
    private var captureStops = 0
    private var handoffs = 0
    private var unconfirmedSegments = 0
    private var utteranceCommits = 0
    private var ambiguousUtterances = 0
    private var captureSampleRate: Double = 0
    #if DEBUG
    private var isFixtureRun = false
    private var fixtureSnapshot: DictationAudioHandoffSnapshot?
    #endif
    private var observers: [NSObjectProtocol] = []
    private var inputUID: String?

    init() {
        UserDefaults.standard.set(recognizer?.supportsOnDeviceRecognition == true, forKey: "prismOnDeviceDictationAvailable")
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            let began = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            if began { Task { @MainActor in self?.interrupt("Dictation paused by another audio session. Your text is preserved.") } }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isListening, let previous = self.inputUID,
                      AVAudioSession.sharedInstance().currentRoute.inputs.first?.uid != previous else { return }
                self.interrupt("The microphone connection changed. Your text is preserved; tap the mic to continue.")
            }
        })
    }

    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    func start(text: String, dictationID: UUID = UUID()) async {
        guard !isListening, !isStarting, !isFinishing else { return }
        let attempt = UUID(); sessionID = attempt
        isStarting = true; notice = ""
        self.dictationID = dictationID
        draft = DictationDraft(text: text)
        publishDraft()
        defer { if sessionID == attempt { isStarting = false } }
        guard retiringRecognition == nil || retiringEvents?.taskFinished == true else {
            notice = "The previous recognizer is still closing. Your text is safe; try the mic again shortly."
            return
        }
        retiringRecognition = nil
        retiringEvents = nil
        guard let recognizer, recognizer.supportsOnDeviceRecognition else {
            notice = "On-device dictation isn't available for this language. You can still use the keyboard microphone."
            return
        }
        let permission = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard sessionID == attempt else { return }
        guard permission == .authorized else {
            notice = "Allow Speech Recognition for Prism Terminal in iPhone Settings to use dictation."
            return
        }
        let mic = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard sessionID == attempt else { return }
        guard mic else { notice = "Allow Microphone access for Prism Terminal in iPhone Settings."; return }
        do {
            let audio = AVAudioSession.sharedInstance()
            var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker]
            if #available(iOS 26.0, *) { options.insert(.allowBluetoothHFP) }
            else { options.insert(.allowBluetooth) }
            try audio.setCategory(.playAndRecord, mode: .measurement, options: options)
            try audio.setActive(true)
            let bluetooth = audio.availableInputs?.filter { $0.portType == .bluetoothHFP } ?? []
            let glasses = bluetooth.first { port in
                ["ray", "meta", "wayfarer", "headliner"].contains { port.portName.lowercased().contains($0) }
            } ?? bluetooth.first
            if let glasses {
                try audio.setPreferredInput(glasses)
                let deadline = Date().addingTimeInterval(1.5)
                while audio.currentRoute.inputs.first?.uid != glasses.uid && Date() < deadline {
                    try await Task.sleep(for: .milliseconds(50))
                    guard sessionID == attempt else { return }
                }
                guard audio.currentRoute.inputs.first?.uid == glasses.uid else {
                    throw NSError(domain: "PrismDictation", code: 2, userInfo: [NSLocalizedDescriptionKey: "The glasses microphone isn't ready. Check the Bluetooth connection and try again."])
                }
            }
            inputName = audio.currentRoute.inputs.first?.portName ?? "iPhone microphone"
            inputUID = audio.currentRoute.inputs.first?.uid
            UserDefaults.standard.set(inputName, forKey: "prismDictationInput")
            capture.start(session: attempt)
            captureStarts = 0; captureStops = 0; handoffs = 0; unconfirmedSegments = 0
            utteranceCommits = 0; ambiguousUtterances = 0; captureSampleRate = 0
            isListening = true
            try beginSegment()
            try startCapture(attempt: attempt)
        } catch {
            guard sessionID == attempt else { return }
            interrupt("Dictation couldn't start: \(error.localizedDescription)")
        }
    }

    func stop() {
        if isStarting { sessionID = UUID(); isStarting = false }
        guard isListening else { return }
        isListening = false
        isFinishing = true
        capture.freeze(session: sessionID)
        stopCapture()
        // A handoff may already own queued audio. Finish it, then transcribe
        // that tail without reopening the microphone before enabling Send.
        guard !endingSegment, !retiringSegment else { return }
        endSegmentInput()
    }

    private func endSegmentInput() {
        guard let segment = draft.segmentID, !endingSegment, !retiringSegment else { return }
        endingSegment = true
        rotation?.cancel()
        _ = capture.beginHandoff(session: sessionID, segment: segment)
        // On rotation the engine/tap stay live; new audio is held in RAM.
        // Only explicit Stop or failure releases microphone capture.
        request?.endAudio()
        let attempt = sessionID
        let waitMilliseconds = isListening ? 2000 : 1200
        finishTimeout = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(waitMilliseconds))
            guard !Task.isCancelled, let self, self.sessionID == attempt else { return }
            self.finishSegment(segment: segment, unconfirmed: true)
        }
    }

    private func beginSegment() throws {
        guard let recognizer, !retiringSegment else { return }
        let attempt = sessionID
        let segment = draft.beginSegment()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        self.request = request
        // Apple may finalize several utterances inside one recognition task.
        // Result-handler isFinal alone misses these phrase boundaries. The
        // delegate is retained, and callbacks stay ordered on the main queue.
        let events = PrismDictationRecognitionDelegate { [weak self, capture] event in
            guard let self, self.sessionID == attempt, self.draft.segmentID == segment else { return }
            switch event {
            case .hypothesis(let text):
                self.draft.update(text, segment: segment)
                self.publishDraft()
            case .utterance(let text, let start, let end):
                let result = self.draft.finishUtterance(text, segment: segment, start: start, end: end)
                if result == .committed { self.utteranceCommits += 1 }
                if result == .ambiguous {
                    self.ambiguousUtterances += 1
                    self.interrupt("Dictation paused to protect your text because a phrase could not be matched safely. Review the draft; the unfinished tail may need repeating.")
                    return
                }
                self.publishDraft()
                self.recordContinuity()
            case .inputClosed:
                _ = capture.beginHandoff(session: attempt, segment: segment)
                self.endSegmentInput()
            case .completed(let success, let message):
                _ = capture.beginHandoff(session: attempt, segment: segment)
                if success || self.endingSegment {
                    self.finishSegment(segment: segment, unconfirmed: !success)
                } else {
                    self.interrupt("Dictation paused. Your text is preserved. \(message ?? "Recognition ended unexpectedly.")")
                }
            case .cancelled:
                self.interrupt("Dictation paused because recognition was cancelled. Your text is preserved.")
            }
        }
        recognitionEvents = events
        recognizer.queue = .main
        recognition = recognizer.recognitionTask(with: request, delegate: events)
        guard capture.attach(session: attempt, segment: segment, sink: { request.append($0) }) else {
            throw NSError(domain: "PrismDictation", code: 3, userInfo: [NSLocalizedDescriptionKey: "Audio handoff could not resume. Your recognized text is preserved."])
        }
        recordContinuity()
        rotation = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                guard let self, self.sessionID == attempt, self.isListening,
                      self.draft.segmentID == segment else { return }
                if DictationRotationPolicy.shouldRotate(self.capture.snapshot, at: ProcessInfo.processInfo.systemUptime) {
                    self.endSegmentInput(); return
                }
            }
        }
    }

    private func startCapture(attempt: UUID) throws {
        guard !hasTap else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "PrismDictation", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone input is available."])
        }
        captureSampleRate = format.sampleRate
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self, capture] buffer, _ in
            let metadata = PrismDictationPCM.describe(buffer)
            let result = capture.append(buffer, session: attempt,
                frameCount: metadata?.frameCount ?? 0, sampleRate: metadata?.sampleRate ?? 0,
                byteCount: metadata?.byteCount ?? 0, formatID: metadata?.formatID ?? "invalid",
                rms: metadata?.rms ?? 0, at: ProcessInfo.processInfo.systemUptime,
                copy: PrismDictationPCM.copy)
            if case .failed = result {
                Task { @MainActor in
                    guard let self, self.sessionID == attempt else { return }
                    self.interrupt("Dictation paused because the audio changed or its handoff could not keep up. Recognized text is preserved; the unfinished tail may need repeating.")
                }
            }
        }
        hasTap = true
        engine.prepare(); try engine.start()
        captureStarts += 1; recordContinuity()
    }

    private func stopCapture() {
        let wasCapturing = hasTap || engine.isRunning
        engine.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        if wasCapturing { captureStops += 1; recordContinuity() }
    }

    private func finishSegment(segment: UUID, unconfirmed: Bool = false) {
        guard draft.segmentID == segment, !retiringSegment else { return }
        _ = capture.beginHandoff(session: sessionID, segment: segment)
        rotation?.cancel(); finishTimeout?.cancel()
        endingSegment = false; retiringSegment = true
        if unconfirmed {
            unconfirmedSegments += 1
            notice = "Recognition could not confirm one segment. Review the last few words before sending."
        }
        draft.finishSegment(); publishDraft()
        request?.endAudio()
        let old = recognition
        let oldEvents = recognitionEvents
        retiringRecognition = old
        retiringEvents = oldEvents
        request = nil; recognition = nil
        recognitionEvents = nil
        let attempt = sessionID
        retirement = Task { [weak self] in
            // On this device task.state becomes .completed after an utterance,
            // even while the same task keeps recognizing later phrases. Only
            // the delegate's all-task completion/cancellation retires it.
            if oldEvents?.taskFinished != true { old?.cancel() }
            let deadline = ProcessInfo.processInfo.systemUptime + 0.75
            while old != nil, oldEvents?.taskFinished != true {
                guard !Task.isCancelled, ProcessInfo.processInfo.systemUptime < deadline else { break }
                do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
            }
            guard !Task.isCancelled, let self, self.sessionID == attempt else { return }
            guard old == nil || oldEvents?.taskFinished == true else {
                self.interrupt("Dictation paused while the previous recognizer closed. Your text is preserved; the unfinished tail may need repeating.")
                return
            }
            self.retiringRecognition = nil; self.retiringEvents = nil; self.retiringSegment = false
            self.recordContinuity()
            if self.isListening || self.capture.snapshot.bufferedBlocks > 0 {
                do {
                    self.handoffs += 1
                    try self.beginSegment()
                    if !self.isListening { self.endSegmentInput() }
                } catch {
                    self.interrupt("Dictation paused during handoff. Your text is preserved; the unfinished tail may need repeating.")
                }
            } else {
                self.capture.cancel(session: attempt)
                self.isFinishing = false
            }
        }
    }

    private func recordContinuity() {
        let snapshot = capture.snapshot
        #if DEBUG
        if isFixtureRun { fixtureSnapshot = snapshot; return }
        #endif
        let defaults = UserDefaults.standard
        defaults.set(captureStarts, forKey: "prismDictationCaptureStarts")
        defaults.set(captureStops, forKey: "prismDictationCaptureStops")
        defaults.set(handoffs, forKey: "prismDictationHandoffs")
        defaults.set(unconfirmedSegments, forKey: "prismDictationUnconfirmedSegments")
        defaults.set(utteranceCommits, forKey: "prismDictationUtteranceCommits")
        defaults.set(ambiguousUtterances, forKey: "prismDictationAmbiguousUtterances")
        defaults.set(draft.text.count, forKey: "prismDictationPublishedCharacters")
        defaults.set(captureSampleRate > 0 ? Double(snapshot.totalCapturedFrames) / captureSampleRate : 0, forKey: "prismDictationCapturedSeconds")
        defaults.set(snapshot.failure?.rawValue, forKey: "prismDictationAudioHandoffFailure")
        defaults.set(snapshot.totalCapturedFrames, forKey: "prismDictationCapturedFrames")
        defaults.set(snapshot.totalDeliveredFrames, forKey: "prismDictationDeliveredFrames")
        defaults.set(snapshot.bufferedBlocks, forKey: "prismDictationHeldBlocks")
        defaults.set(Date().timeIntervalSince1970, forKey: "prismDictationContinuityAt")
    }

    private func publishDraft() {
        let text = draft.text
        transcript = text // Kept for the legacy chat composer.
        if let dictationID {
            transcriptUpdate = DictationTranscriptUpdate(id: dictationID, text: text)
        }
    }

    private func interrupt(_ message: String) {
        guard isListening || isStarting || isFinishing else { return }
        let stoppedSession = sessionID
        isListening = false; isStarting = false
        sessionID = UUID()
        rotation?.cancel(); finishTimeout?.cancel(); retirement?.cancel()
        capture.freeze(session: stoppedSession)
        stopCapture()
        recordContinuity()
        capture.cancel(session: stoppedSession)
        request?.endAudio(); recognition?.cancel(); retiringRecognition?.cancel()
        if let recognition { retiringRecognition = recognition; retiringEvents = recognitionEvents }
        request = nil; recognition = nil
        recognitionEvents = nil
        endingSegment = false; retiringSegment = false
        draft.finishSegment(); publishDraft()
        isFinishing = false
        notice = message
    }

    #if DEBUG
    /// Exercises the production delegate, phrase ledger, rotation and FIFO
    /// using a synthetic file. Never opens the microphone or changes its route.
    func verifySyntheticFixture(_ url: URL, repetitions: Int) async -> [String: Double] {
        guard ProcessInfo.processInfo.arguments.contains("--prism-dictation-continuity-probe"),
              repetitions == 5, SFSpeechRecognizer.authorizationStatus() == .authorized,
              recognizer?.supportsOnDeviceRecognition == true else { return ["blocked": 1] }
        isFixtureRun = true
        let attempt = UUID(); sessionID = attempt; dictationID = UUID()
        draft = DictationDraft(); capture.start(session: attempt)
        isListening = true
        var fedFrames = 0
        var expectedFrames = 0
        do {
            let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
            let format = file.processingFormat
            let seconds = Double(file.length) / format.sampleRate
            guard seconds.isFinite, seconds > 0, seconds <= 20 else {
                interrupt("Invalid synthetic fixture."); return ["blocked": 2]
            }
            captureSampleRate = format.sampleRate
            expectedFrames = Int(file.length) * repetitions
            try beginSegment()
            let started = ProcessInfo.processInfo.systemUptime
            for _ in 0..<repetitions {
                file.framePosition = 0
                while file.framePosition < file.length, isListening {
                    try Task.checkCancellation()
                    let frames = AVAudioFrameCount(min(1024, file.length - file.framePosition))
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
                        interrupt("Synthetic buffer allocation failed."); break
                    }
                    try file.read(into: buffer, frameCount: frames)
                    guard let m = PrismDictationPCM.describe(buffer) else {
                        interrupt("Invalid synthetic PCM."); break
                    }
                    let outcome = capture.append(buffer, session: attempt, frameCount: m.frameCount,
                        sampleRate: m.sampleRate, byteCount: m.byteCount, formatID: m.formatID,
                        rms: m.rms, at: ProcessInfo.processInfo.systemUptime, copy: PrismDictationPCM.copy)
                    guard outcome == .accepted else { interrupt("Synthetic handoff failed."); break }
                    fedFrames += m.frameCount
                    let delay = started + Double(fedFrames) / format.sampleRate - ProcessInfo.processInfo.systemUptime
                    if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
                }
                if !isListening { break }
            }
            stop()
            let deadline = ProcessInfo.processInfo.systemUptime + 4
            while isFinishing, ProcessInfo.processInfo.systemUptime < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            if isFinishing { interrupt("Synthetic finalization timed out.") }
        } catch {
            interrupt("Synthetic fixture failed.")
        }
        let snapshot = fixtureSnapshot ?? capture.snapshot
        return ["fedFrames": Double(fedFrames), "expectedFrames": Double(expectedFrames),
            "capturedFrames": Double(snapshot.totalCapturedFrames), "deliveredFrames": Double(snapshot.totalDeliveredFrames),
            "heldBlocks": Double(snapshot.bufferedBlocks), "handoffs": Double(handoffs),
            "utteranceCommits": Double(utteranceCommits), "ambiguousUtterances": Double(ambiguousUtterances),
            "unconfirmedSegments": Double(unconfirmedSegments), "draftChars": Double(draft.text.count),
            "captureStarts": Double(captureStarts), "captureStops": Double(captureStops),
            "hasNotice": notice.isEmpty ? 0 : 1, "audioFailure": snapshot.failure == nil ? 0 : 1]
    }
    #endif
}

/// SwiftUI must see callbacks in their original order. Apple's documented
/// recognizer.queue is explicitly set to .main above; no per-callback Tasks.
@MainActor
private final class PrismDictationRecognitionDelegate: NSObject, SFSpeechRecognitionTaskDelegate {
    enum Event: Sendable {
        case hypothesis(String)
        case utterance(String, start: TimeInterval?, end: TimeInterval?)
        case inputClosed
        case completed(Bool, String?)
        case cancelled
    }
    private let receive: (Event) -> Void
    private(set) var taskFinished = false
    init(receive: @escaping (Event) -> Void) { self.receive = receive }

    nonisolated func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didHypothesizeTranscription transcription: SFTranscription) {
        let text = transcription.formattedString
        MainActor.assumeIsolated { receive(.hypothesis(text)) }
    }
    nonisolated func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishRecognition result: SFSpeechRecognitionResult) {
        let transcription = result.bestTranscription
        let first = transcription.segments.first
        let last = transcription.segments.last
        let start = first?.timestamp
        let end = last.map { $0.timestamp + $0.duration }
        let hasTiming = (last?.duration ?? 0) > 0
        MainActor.assumeIsolated {
            receive(.utterance(transcription.formattedString, start: hasTiming ? start : nil, end: hasTiming ? end : nil))
        }
    }
    nonisolated func speechRecognitionTaskFinishedReadingAudio(_ task: SFSpeechRecognitionTask) {
        MainActor.assumeIsolated { receive(.inputClosed) }
    }
    nonisolated func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishSuccessfully successfully: Bool) {
        let message = task.error?.localizedDescription
        MainActor.assumeIsolated {
            taskFinished = true // Must precede callbacks that may reject old IDs.
            receive(.completed(successfully, message))
        }
    }
    nonisolated func speechRecognitionTaskWasCancelled(_ task: SFSpeechRecognitionTask) {
        MainActor.assumeIsolated {
            taskFinished = true
            receive(.cancelled)
        }
    }
}
