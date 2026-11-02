//
//  Speaker.swift
//  VisionClaw-MoA
//
//  Text-to-speech for the reply, spoken back through the glasses/phone.
//  Uses Apple's on-device AVSpeechSynthesizer — free, offline, no API cost.
//

import AVFoundation
import Foundation

@MainActor
final class Speaker: NSObject, ObservableObject {
    @Published var isSpeaking = false
    private let synth = AVSpeechSynthesizer()

    override init() {
        super.init()
        synth.delegate = self
    }

    /// Speak text. Strips the runner's "$ command" echo lines so only the agent's
    /// actual answer is voiced.
    func speak(_ text: String) {
        let spoken = text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.hasPrefix("$ ") && !$0.hasPrefix("-----") }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return }
        let u = AVSpeechUtterance(string: spoken)
        u.voice = AVSpeechSynthesisVoice(language: "en-US")
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }
}

extension Speaker: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = true }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
}
