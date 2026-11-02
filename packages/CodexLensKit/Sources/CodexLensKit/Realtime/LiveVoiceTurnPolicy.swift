import Foundation

public enum LiveVoicePhase: String, Equatable, Sendable {
    case off, starting, warming, listening, finalizing, waiting, preparingSpeech, speaking, paused

    public var title: String {
        switch self {
        case .off: "Voice off"
        case .starting: "Starting microphone…"
        case .warming: "Warming voice…"
        case .listening: "Listening"
        case .finalizing: "Finishing your words…"
        case .waiting: "Codex is working"
        case .preparingSpeech: "Preparing reply…"
        case .speaking: "Speaking"
        case .paused: "Voice paused"
        }
    }
}

/// Acoustic activity, rather than recognition latency, determines a turn's end.
/// Times are monotonic seconds supplied by the audio shell.
public struct LiveVoiceSilenceGate: Sendable {
    public let silenceInterval: TimeInterval
    public private(set) var lastSpeechAt: TimeInterval?
    private var speechDuration: TimeInterval = 0
    private var previousSampleAt: TimeInterval?
    private var noiseFloor: Float = 0.002

    public init(silenceInterval: TimeInterval = 1.3) {
        self.silenceInterval = silenceInterval
    }

    public mutating func observe(rms: Float, at time: TimeInterval) {
        guard rms.isFinite, time.isFinite else { return }
        let duration = min(0.2, max(0, time - (previousSampleAt ?? time)))
        previousSampleAt = time
        let threshold = max(0.008, noiseFloor * 3)
        if rms >= threshold {
            lastSpeechAt = time
            speechDuration += duration
        } else {
            noiseFloor = max(0.0003, min(0.008, noiseFloor * 0.95 + max(0, rms) * 0.05))
        }
    }

    public func shouldFinalize(at time: TimeInterval, transcript: String) -> Bool {
        guard let lastSpeechAt, speechDuration >= 0.12,
              !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return time - lastSpeechAt >= silenceInterval
    }
}

/// Only a reply to the current voice request may be spoken. Replayed events,
/// interrupted turns, and a previous run's replies never enter playback.
public struct LiveVoiceReplyGate: Sendable {
    public private(set) var waitingRequestID: String?
    public init() {}
    public mutating func awaitReply(requestID: String) { waitingRequestID = requestID }
    public mutating func reset() { waitingRequestID = nil }
    public mutating func consume(requestID: String, text: String, status: String) -> String? {
        guard waitingRequestID == requestID else { return nil }
        waitingRequestID = nil
        guard status == "completed" else { return nil }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}

/// Apple's SFSpeechRecognitionTask documents 1110 as no recognized speech.
/// A healthy idle recognizer may end normally; repeated immediate failures must
/// not spin forever or conceal an unavailable microphone/service.
public struct LiveVoiceRecognitionRecovery: Sendable {
    private var rapidFailures = 0
    public init() {}

    public mutating func delay(errorDomain: String, code: Int, segmentDuration: TimeInterval,
                               segmentHasText: Bool) -> TimeInterval? {
        guard errorDomain == "kAFAssistantErrorDomain", code == 1110,
              !segmentHasText else { return nil }
        if segmentDuration >= 2 {
            rapidFailures = 0
            return 0.25
        }
        rapidFailures += 1
        guard rapidFailures <= 3 else { return nil }
        return 0.25 * pow(2, Double(rapidFailures - 1))
    }
}

public enum LiveVoiceReadback {
    /// Preserve the normalized readback while allowing its first audio to start
    /// before the rest has synthesized. Only whitespace between chunks changes.
    /// Limits are UTF-16 units: 180 first, then 400. An indivisible Character
    /// larger than a limit is kept whole in its own chunk; text(from:) still
    /// bounds the overall payload below the gateway's 2,000-unit limit.
    public static func chunks(from response: String) -> [String] {
        let characters = Array(text(from: response))
        var result: [String] = []
        var start = 0
        let sentenceMarks: Set<Character> = [".", "!", "?", "。", "！", "？"]
        let cjkSentenceMarks: Set<Character> = ["。", "！", "？"]
        let closingMarks: Set<Character> = ["\"", "'", "”", "’", ")", "]", "}"]
        while start < characters.count {
            while start < characters.count && characters[start].isWhitespace { start += 1 }
            guard start < characters.count else { break }
            let limit = result.isEmpty ? 180 : 400
            var hardEnd = start
            var units = 0
            while hardEnd < characters.count {
                let width = String(characters[hardEnd]).utf16.count
                guard units + width <= limit else { break }
                units += width; hardEnd += 1
            }
            // Never split a grapheme to enforce a byte-oriented target.
            if hardEnd == start { hardEnd += 1 }
            var end = hardEnd
            if hardEnd < characters.count {
                var sentenceEnd: Int?
                var whitespaceEnd: Int?
                for index in start..<hardEnd {
                    if characters[index].isWhitespace { whitespaceEnd = index }
                    guard sentenceMarks.contains(characters[index]) else { continue }
                    var candidate = index + 1
                    while candidate < hardEnd && closingMarks.contains(characters[candidate]) { candidate += 1 }
                    // A dot inside 3.14, a version, URL or abbreviation is not
                    // a sentence boundary merely because it is punctuation.
                    let cjk = cjkSentenceMarks.contains(characters[index])
                    if candidate == characters.count || characters[candidate].isWhitespace || cjk {
                        sentenceEnd = candidate
                    }
                }
                end = sentenceEnd ?? whitespaceEnd ?? hardEnd
            }
            var trimmedEnd = end
            while trimmedEnd > start && characters[trimmedEnd - 1].isWhitespace { trimmedEnd -= 1 }
            if trimmedEnd > start { result.append(String(characters[start..<trimmedEnd])) }
            start = end
        }
        return result
    }

    /// Keep code on screen and keep synthesis inside the gateway's 2,000 UTF-16
    /// unit limit (JavaScript string length), including non-BMP characters.
    public static func text(from response: String) -> String {
        var result = response.replacingOccurrences(of: "(?s)```.*?```", with: " Code is available in the terminal. ", options: .regularExpression)
        result = result.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
        result = result.replacingOccurrences(of: "(?m)^#{1,6}\\s+", with: "", options: .regularExpression)
        result = result.replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: "**", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.utf16.count > 1900 else { return result }
        var prefix = "", count = 0
        for character in result {
            let width = String(character).utf16.count
            guard count + width <= 1850 else { break }
            prefix.append(character); count += width
        }
        return prefix.trimmingCharacters(in: .whitespacesAndNewlines) + " The rest is in the terminal."
    }
}
