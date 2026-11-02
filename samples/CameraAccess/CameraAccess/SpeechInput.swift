//
//  SpeechInput.swift
//  VisionClaw-MoA
//
//  ALWAYS-LISTENING on-device speech-to-text (Apple Speech framework). No tap, no
//  button — the mic stays open, transcribes as you speak, and submits the moment you
//  go quiet, then immediately listens again. Free, on-device, no Gemini / no API cost.
//
//  Handling the hard parts:
//   • Apple caps a single recognition session (~1 min) — we transparently cycle to a
//     fresh session on finalize/cap so listening never stops.
//   • pause()/resume() mute hearing while we SPEAK a reply, so it never transcribes
//     its own TTS (the cheap stand-in for the original's echo-cancelled barge-in).
//   • Requests BOTH speech + microphone permission and guards the mic format, closing
//     two real-device failure modes (dead mic on first launch, format-0 crash).
//

import Foundation
import Speech
import AVFoundation

@MainActor
final class SpeechInput: ObservableObject {
    @Published var transcript = ""
    @Published var isListening = false      // a recognition session is live and hearing
    @Published var authorized = false
    @Published var permissionDenied = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let engine = AVAudioEngine()

    private var running = false             // continuous mode desired
    private var paused = false              // temporarily not hearing (e.g. while speaking)
    private var silenceTimer: Timer?
    private let silenceWindow: TimeInterval = 1.4   // quiet this long after speech -> submit
    private var lastPartial = ""

    /// Called with the final transcript each time the user finishes an utterance.
    var onFinal: ((String) -> Void)?

    // MARK: permissions (speech AND mic — both are required to actually hear)

    func requestAuth() {
        SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
            AVAudioApplication.requestRecordPermission { micGranted in
                Task { @MainActor in
                    let ok = (speechStatus == .authorized) && micGranted
                    self?.authorized = ok
                    self?.permissionDenied = !ok
                }
            }
        }
    }

    // MARK: lifecycle

    /// Start always-listening. Idempotent; no-op until authorized.
    func startContinuous() {
        guard authorized, !running else { return }
        running = true
        paused = false
        beginEngine()
        beginRecognition()
    }

    func stopContinuous() {
        running = false
        endRecognition()
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        isListening = false
    }

    /// Stop hearing while we speak a reply, then pick right back up.
    func pause() {
        guard running, !paused else { return }
        paused = true
        endRecognition()
        isListening = false
    }

    func resume() {
        guard running, paused else { return }
        paused = false
        beginRecognition()
    }

    // MARK: audio engine (installed once; recognition sessions swap underneath)

    private func beginEngine() {
        // The audio session is owned by the view (begin on appear / end on disappear).
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            NSLog("[MoA] mic format invalid (%.0f Hz) — cannot listen", format.sampleRate)
            return                                   // guard the format-0 AVFoundation crash
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)            // nil while paused -> buffers dropped
        }
        engine.prepare()
        do { try engine.start() } catch {
            NSLog("[MoA] audio engine start failed: %@", error.localizedDescription)
        }
    }

    // MARK: recognition session (cycled on cap/finalize)

    private func beginRecognition() {
        endRecognition()
        transcript = ""; lastPartial = ""
        guard running, !paused, let recognizer, recognizer.isAvailable else { return }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        isListening = true

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            Task { @MainActor in
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if self.transcript != self.lastPartial {   // genuinely new speech
                        self.lastPartial = self.transcript
                        self.armSilence()                        // restart the quiet countdown
                    }
                }
                if error != nil || (result?.isFinal ?? false) {  // hit the cap / finalized
                    self.cycle()
                }
            }
        }
    }

    private func endRecognition() {
        silenceTimer?.invalidate(); silenceTimer = nil
        request?.endAudio()
        task?.cancel()
        request = nil; task = nil
    }

    private func armSilence() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: silenceWindow, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.submitUtterance() }
        }
    }

    /// Went quiet after speaking -> submit this utterance and immediately listen again.
    private func submitUtterance() {
        let final = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        endRecognition()
        transcript = ""; lastPartial = ""
        if !final.isEmpty { onFinal?(final) }
        if running && !paused { beginRecognition() }
    }

    /// Session finalized or hit Apple's cap: flush any pending words, else just restart.
    private func cycle() {
        if !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            submitUtterance()
        } else {
            endRecognition()
            if running && !paused { beginRecognition() }
        }
    }
}
