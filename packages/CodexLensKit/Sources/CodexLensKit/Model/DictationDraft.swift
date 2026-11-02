import Foundation

public enum DictationUtteranceUpdate: Equatable, Sendable {
    case committed
    case revised
    case ignored
    case ambiguous
}

/// Dictation edits a draft only. Untimed partials replace the current phrase,
/// never earlier finalized phrases. Explicit utterance boundaries come from the
/// recognizer delegate, not from metadata presence or matching text.
public struct DictationDraft: Equatable, Sendable {
    private struct AudioRange: Equatable, Sendable {
        let start: TimeInterval
        let end: TimeInterval

        func overlaps(_ other: AudioRange) -> Bool {
            start < other.end && other.start < end
        }

        func contains(_ other: AudioRange) -> Bool {
            start <= other.start && end >= other.end
        }
    }

    private struct Utterance: Equatable, Sendable {
        let text: String
        let range: AudioRange?
    }

    // Text preceding this recognizer task is never revised by its callbacks.
    private var committed: String
    private var utterances: [Utterance] = []
    private var partial = ""
    public private(set) var segmentID: UUID?

    public init(text: String = "") { committed = text }

    /// The number of retained phrase entries in the current task. A cumulative
    /// final can replace several fully covered entries with one entry.
    public var finalizedUtteranceCount: Int { utterances.count }

    public var text: String {
        var result = committed
        for utterance in utterances { Self.append(utterance.text, to: &result) }
        Self.append(partial, to: &result)
        return result
    }

    @discardableResult public mutating func beginSegment() -> UUID {
        committed = text; utterances = []; partial = ""
        let id = UUID(); segmentID = id
        return id
    }

    @discardableResult public mutating func update(_ transcript: String, segment: UUID) -> Bool {
        guard segmentID == segment, Self.hasText(transcript) else { return false }
        partial = transcript
        return true
    }

    /// Commits an explicit finalized utterance. The provider's absolute audio
    /// range identifies repetitions and revisions; text is never deduplicated.
    /// An ambiguous result leaves both known phrases and the active hypothesis
    /// intact so the caller can report that the final needs review.
    @discardableResult public mutating func finishUtterance(
        _ transcript: String,
        segment: UUID,
        start: TimeInterval? = nil,
        end: TimeInterval? = nil
    ) -> DictationUtteranceUpdate {
        guard segmentID == segment, Self.hasText(transcript) else { return .ignored }

        if start == nil, end == nil {
            // After any prior boundary, an untimed final may be a delayed or
            // repeated old final, even when a newer hypothesis is visible.
            // Without audio identity it must not erase that newer hypothesis.
            guard utterances.isEmpty else { return .ambiguous }
            utterances.append(Utterance(text: transcript, range: nil))
            partial = ""
            return .committed
        }

        guard let start, let end, start.isFinite, end.isFinite,
              start >= 0, end > start else { return .ambiguous }
        let incoming = AudioRange(start: start, end: end)

        // Timing cannot prove whether a cumulative final covers an earlier
        // untimed phrase. Preserve it instead of overwriting or duplicating it.
        guard utterances.allSatisfy({ $0.range != nil }) else { return .ambiguous }

        let overlapping = utterances.indices.filter {
            utterances[$0].range?.overlaps(incoming) == true
        }
        guard let first = overlapping.first, let last = overlapping.last else {
            if let previousEnd = utterances.last?.range?.end, start < previousEnd {
                return .ambiguous
            }
            utterances.append(Utterance(text: transcript, range: incoming))
            partial = ""
            return .committed
        }

        // Only whole phrase coverage is safe without word-level timestamps.
        // A partial overlap must not erase the uncovered part of a phrase.
        guard overlapping.allSatisfy({ index in
            utterances[index].range.map(incoming.contains) == true
        }) else { return .ambiguous }

        let priorEnd = utterances.last?.range?.end
        // A later endpoint could be a revised timestamp for old speech, not
        // evidence that this final includes the newer untimed hypothesis.
        if !partial.isEmpty, let priorEnd, end > priorEnd { return .ambiguous }
        utterances.replaceSubrange(first...last, with: [Utterance(text: transcript, range: incoming)])
        // Revisions to known audio never consume a newer untimed hypothesis.
        return .revised
    }

    public mutating func finishSegment() {
        committed = text; utterances = []; partial = ""; segmentID = nil
    }

    private static func hasText(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func append(_ text: String, to destination: inout String) {
        guard !text.isEmpty else { return }
        let needsSpace = !destination.isEmpty && destination.last?.isWhitespace != true
            && text.first?.isWhitespace != true
        if needsSpace { destination += " " }
        destination += text
    }
}
