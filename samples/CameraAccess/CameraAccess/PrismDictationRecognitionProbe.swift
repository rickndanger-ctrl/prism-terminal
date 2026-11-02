import AVFoundation
import Foundation
import Speech
import CodexLensKit

/// Debug-only, on-device recognition diagnostics using a known synthetic file.
/// Never activates an audio session, creates an engine, records, or plays audio.
enum PrismDictationRecognitionProbe {
    @MainActor private static var didRun = false
    @MainActor private static var runningProbe: Task<Void, Never>?

    @MainActor static func runIfRequested() async {
        #if DEBUG
        guard ProcessInfo.processInfo.arguments.contains("--prism-dictation-probe"), !didRun else { return }
        didRun = true
        // The app's startup view can be replaced while wearables initialize.
        // Keep this explicit debug fixture independent of SwiftUI task lifetime.
        runningProbe = Task {
            await runFixture()
            if ProcessInfo.processInfo.arguments.contains("--prism-dictation-continuity-probe"),
               let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
               let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
                let dictation = PrismDictation()
                let result = await dictation.verifySyntheticFixture(documents.appendingPathComponent("prism-dictation-fixture.wav"), repetitions: 5)
                if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
                    try? data.write(to: caches.appendingPathComponent("prism-dictation-continuity-probe.json"), options: .atomic)
                }
            }
        }
        #endif
    }

    @MainActor private static func runFixture() async {
        #if DEBUG
        let files = FileManager.default
        guard let documents = files.urls(for: .documentDirectory, in: .userDomainMask).first,
              let caches = files.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        let journal = Journal(url: caches.appendingPathComponent("prism-dictation-probe.json"))
        journal.record(type: 0, code: SFSpeechRecognizer.authorizationStatus().rawValue)
        // Do not display permission prompts or fall back to network recognition.
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            journal.record(type: 9, code: 1); journal.close(); return
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.supportsOnDeviceRecognition else {
            journal.record(type: 9, code: 2); journal.close(); return
        }
        guard recognizer.isAvailable else {
            journal.record(type: 9, code: 3); journal.close(); return
        }
        let fixture = documents.appendingPathComponent("prism-dictation-fixture.wav")
        guard files.fileExists(atPath: fixture.path) else {
            journal.record(type: 9, code: 4); journal.close(); return
        }
        let file: AVAudioFile
        do { file = try AVAudioFile(forReading: fixture, commonFormat: .pcmFormatFloat32, interleaved: false) }
        catch { journal.record(type: 10, code: (error as NSError).code); journal.close(); return }
        let format = file.processingFormat
        let duration = Double(file.length) / format.sampleRate
        guard duration.isFinite, duration > 0, duration <= 20, format.channelCount == 1,
              format.sampleRate >= 8_000, format.sampleRate <= 48_000 else {
            journal.record(type: 9, code: 5); journal.close(); return
        }
        journal.configure(frames: file.length, rate: format.sampleRate)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if #available(iOS 16, macOS 13, *) { request.addsPunctuation = true }
        let observer = Observer(journal: journal)
        // Deliver and journal callbacks synchronously on the serial main queue;
        // launching per-callback Tasks here could reorder partial hypotheses.
        recognizer.queue = .main
        let task = recognizer.recognitionTask(with: request, delegate: observer)
        let start = ProcessInfo.processInfo.systemUptime
        let deadline = journal.started + 28
        var fedFrames: AVAudioFramePosition = 0
        var nextProgress = 1.0
        var ended = false
        defer {
            if !ended { request.endAudio() }
            if !journal.isComplete { task.cancel() }
            journal.record(type: 12, task: task, audioFrames: fedFrames)
            journal.close()
            withExtendedLifetime(observer) {}
            withExtendedLifetime(recognizer) {}
        }
        do {
            while file.framePosition < file.length, !journal.isComplete,
                  ProcessInfo.processInfo.systemUptime < deadline {
                try Task.checkCancellation()
                let frames = AVAudioFrameCount(min(1_024, file.length - file.framePosition))
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
                    journal.record(type: 9, task: task, code: 6); return
                }
                try file.read(into: buffer, frameCount: frames)
                guard buffer.frameLength > 0 else { break }
                request.append(buffer)
                fedFrames += AVAudioFramePosition(buffer.frameLength)
                let fedSeconds = Double(fedFrames) / format.sampleRate
                if fedSeconds >= nextProgress {
                    journal.record(type: 11, task: task, audioFrames: fedFrames)
                    nextProgress += 1
                }
                let delay = min(deadline, start + fedSeconds) - ProcessInfo.processInfo.systemUptime
                if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            }
            request.endAudio(); ended = true
            journal.record(type: 7, task: task, audioFrames: fedFrames)
            while !journal.isComplete, ProcessInfo.processInfo.systemUptime < deadline {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            if !journal.isComplete {
                journal.record(type: 8, task: task, audioFrames: fedFrames)
                task.cancel()
            }
        } catch is CancellationError {
            journal.record(type: 9, task: task, code: 8, audioFrames: fedFrames)
        } catch {
            journal.record(type: 10, task: task, code: (error as NSError).code, audioFrames: fedFrames)
        }
        #endif
    }

    #if DEBUG
    /// Event types: start=0, partial=1, utteranceFinal=2, finishedReading=3,
    /// finishedSuccessfully=4, detectedSpeech=5, cancelled=6, endAudio=7,
    /// timeout=8, blocked=9, error=10, audioProgress=11, probeEnd=12.
    /// Blocked codes: authorization=1, unsupportedOnDevice=2, unavailable=3,
    /// missingFixture=4, invalidFixture=5, allocation=6, callerCancelled=8.
    private struct Event: Encodable {
        let seq: Int
        let type: Int
        let elapsed: Double
        let textChars: Int?
        let draftChars: Int
        let finalizedUtterances: Int
        /// committed=1, revised=2, ignored=3, ambiguous=4; absent for other events.
        let utteranceOutcome: Int?
        let callbackOnMain: Bool
        let words: Int?
        let firstTimestamp: Double?
        let lastEnd: Double?
        let metadataStart: Double?
        let metadataDuration: Double?
        let isFinal: Bool?
        let taskState: Int?
        let code: Int?
        let audioFrames: Int64?
    }

    private struct Report: Encodable {
        let schema = 2
        let fixtureFrames: Int64
        let sampleRate: Double
        let complete: Bool
        let successful: Bool?
        let reportClosed: Bool
        let events: [Event]
    }

    private final class Journal: @unchecked Sendable {
        let started = ProcessInfo.processInfo.systemUptime
        private let lock = NSLock()
        private let url: URL
        private var events: [Event] = []
        private var complete = false
        private var successful: Bool?
        private var closed = false
        private var frames: Int64 = 0
        private var sampleRate: Double = 0
        private var draft = DictationDraft(text: "")
        private var segment: UUID?
        init(url: URL) {
            self.url = url
            // One request/segment, using the same draft model as production.
            segment = draft.beginSegment()
        }
        var isComplete: Bool { lock.lock(); defer { lock.unlock() }; return complete }

        func configure(frames: Int64, rate: Double) {
            lock.lock(); defer { lock.unlock() }
            self.frames = frames; sampleRate = rate; persist()
        }

        func record(type: Int, task: SFSpeechRecognitionTask? = nil,
                    transcription: SFTranscription? = nil, result: SFSpeechRecognitionResult? = nil,
                    code: Int? = nil, audioFrames: Int64? = nil, success: Bool? = nil) {
            // Persist no transcription, substrings, user audio, or raw errors.
            let text = transcription?.formattedString
            let first = transcription?.segments.first
            let last = transcription?.segments.last
            let metadata = result?.speechRecognitionMetadata
            lock.lock(); defer { lock.unlock() }
            guard !closed, events.count < 512 else { return }
            if let success { complete = true; successful = success }
            var utteranceOutcome: Int?
            if let text, let segment {
                if type == 2 {
                    // Partial timestamps can all be zero. Only a completed
                    // utterance with a positive last duration supplies a range.
                    let hasRange = first != nil && (last?.duration ?? 0) > 0
                    let start = hasRange ? finite(first?.timestamp) : nil
                    let end = hasRange ? last.map { $0.timestamp + $0.duration }.flatMap { finite($0) } : nil
                    switch draft.finishUtterance(text, segment: segment, start: start, end: end) {
                    case .committed: utteranceOutcome = 1
                    case .revised: utteranceOutcome = 2
                    case .ignored: utteranceOutcome = 3
                    case .ambiguous: utteranceOutcome = 4
                    }
                } else if type == 1 {
                    draft.update(text, segment: segment)
                }
            }
            events.append(Event(seq: events.count, type: type,
                                elapsed: ProcessInfo.processInfo.systemUptime - started,
                                textChars: text?.count, draftChars: draft.text.count,
                                finalizedUtterances: draft.finalizedUtteranceCount, utteranceOutcome: utteranceOutcome,
                                callbackOnMain: Thread.isMainThread,
                                words: text?.split(whereSeparator: { $0.isWhitespace }).count,
                                firstTimestamp: finite(first?.timestamp),
                                lastEnd: last.map { $0.timestamp + $0.duration }.flatMap { finite($0) },
                                metadataStart: finite(metadata?.speechStartTimestamp),
                                metadataDuration: finite(metadata?.speechDuration),
                                isFinal: result?.isFinal, taskState: task?.state.rawValue,
                                code: code, audioFrames: audioFrames))
            persist()
        }

        func close() { lock.lock(); defer { lock.unlock() }; closed = true; persist() }
        private func finite(_ value: Double?) -> Double? { value.flatMap { $0.isFinite ? $0 : nil } }
        private func persist() {
            let report = Report(fixtureFrames: frames, sampleRate: sampleRate, complete: complete,
                                successful: successful, reportClosed: closed, events: events)
            // Numeric diagnostics only. Atomic snapshots preserve partial evidence.
            guard let data = try? JSONEncoder().encode(report) else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    private final class Observer: NSObject, SFSpeechRecognitionTaskDelegate {
        let journal: Journal
        init(journal: Journal) { self.journal = journal }
        func speechRecognitionDidDetectSpeech(_ task: SFSpeechRecognitionTask) {
            journal.record(type: 5, task: task)
        }
        func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didHypothesizeTranscription transcription: SFTranscription) {
            journal.record(type: 1, task: task, transcription: transcription)
        }
        func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishRecognition result: SFSpeechRecognitionResult) {
            journal.record(type: 2, task: task, transcription: result.bestTranscription, result: result)
        }
        func speechRecognitionTaskFinishedReadingAudio(_ task: SFSpeechRecognitionTask) {
            journal.record(type: 3, task: task)
        }
        func speechRecognitionTaskWasCancelled(_ task: SFSpeechRecognitionTask) {
            journal.record(type: 6, task: task)
        }
        func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishSuccessfully successfully: Bool) {
            journal.record(type: 4, task: task, code: task.error.map { ($0 as NSError).code }, success: successfully)
        }
    }
    #endif
}
