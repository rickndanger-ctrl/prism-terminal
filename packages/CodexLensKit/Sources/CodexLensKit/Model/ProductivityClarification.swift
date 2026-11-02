import Foundation

/// One short timing clarification, armed only after the exact question was
/// spoken. It cannot authorize a new title/kind or survive unrelated speech.
public struct ProductivityClarification: Sendable {
    public let original: RealtimeUtteranceSource
    public let kind: ProductivityKind
    public let title: String
    public let expiresAt: Date
    public let question: String
    public let preparedAt: Date
    public private(set) var askedAt: Date?
    public private(set) var answer: RealtimeUtteranceSource?
    private var invalidated = false

    public init(source: RealtimeUtteranceSource, kind: ProductivityKind, title: String, now: Date = Date()) throws {
        guard ProductivityAction.requestedKind(source.transcript) == kind,
              now.timeIntervalSince(source.transcribedAt) >= -5,
              now.timeIntervalSince(source.transcribedAt) < 120,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              title.count <= 180, !title.contains("\n") else { throw ProductivityError.notAuthorized }
        self.original = source; self.kind = kind; self.title = title
        preparedAt = now
        expiresAt = source.transcribedAt.addingTimeInterval(120)
        question = kind == .reminder
            ? "When should I remind you about \(title)?"
            : "What date, start time, and end time should I use for \(title)?"
    }

    public mutating func noteQuestionCompleted(_ transcript: String, at now: Date) {
        guard !invalidated, now >= preparedAt, now < expiresAt,
              BoundSpokenReadback.matches(transcript, requiredReadback: question) else { return }
        askedAt = now
    }

    public mutating func acceptAnswer(_ source: RealtimeUtteranceSource, now: Date = Date()) -> Bool {
        guard !invalidated, let askedAt, answer == nil, now < expiresAt,
              source.transcribedAt >= askedAt, source.transcribedAt <= now.addingTimeInterval(5),
              source.itemID != original.itemID, Self.isTimingAnswer(source.transcript) else { invalidated = true; return false }
        answer = source
        return true
    }

    public func authorizedSource(for action: ProductivityAction, answering source: RealtimeUtteranceSource, now: Date = Date()) throws -> RealtimeUtteranceSource {
        guard !invalidated, now < expiresAt, let answer, source == answer,
              action.kind == kind, action.title == title,
              let combined = RealtimeUtteranceSource(itemID: original.itemID,
                transcript: original.transcript + "\nTiming clarification: " + answer.transcript,
                transcribedAt: original.transcribedAt) else { throw ProductivityError.notAuthorized }
        return combined
    }

    /// Narrow vocabulary for a timing answer, not a general follow-up bypass.
    /// Unknown words go through ordinary attention handling and clear the draft.
    public static func isTimingAnswer(_ transcript: String) -> Bool {
        guard let text = TaskTakingSpeechPolicy.authoritativeTaskText(from: transcript)?.lowercased() else { return false }
        let words = text.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
        guard !words.isEmpty, words.count <= 24 else { return false }
        let allowed: Set<String> = [
            "at", "on", "in", "for", "from", "to", "until", "and", "the", "this", "next", "of", "a", "an", "yes", "yeah", "okay", "make", "it",
            "today", "tomorrow", "tonight", "morning", "afternoon", "evening", "noon", "midnight",
            "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
            "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
            "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
            "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty",
            "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
            "half", "quarter", "hour", "hours", "minute", "minutes", "day", "days", "week", "weeks",
            "am", "pm", "a", "p", "m", "o", "clock", "pacific", "eastern", "central", "mountain", "utc", "gmt", "local", "time",
        ]
        return words.allSatisfy { allowed.contains($0) || $0.range(of: #"^\d{1,4}(?:st|nd|rd|th)?$"#, options: .regularExpression) != nil }
            && words.contains { !["at", "on", "in", "for", "from", "to", "until", "and", "the", "this", "next", "of", "a", "an", "time", "yes", "yeah", "okay", "make", "it"].contains($0) }
    }
}
