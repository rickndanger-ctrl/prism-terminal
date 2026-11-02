import Foundation

/// Phone-side evidence that the wearer said "Codex, confirm" during a GPT Live
/// session. GPT-Live transcript deltas have no turn boundary, so this never
/// triggers anything: it only lets an already-requested task start proceed.
public struct GptLiveConfirmationWitness: Equatable, Sendable {
    private struct Fragment: Equatable, Sendable {
        let text: String
        let receivedAt: Date
    }

    private static let retention: TimeInterval = 120
    private static let maximumFragments = 256
    private static let acceptedPhrases = ["codex confirm", "codec confirm", "code x confirm"]

    private var fragments: [Fragment] = []

    public init() {}

    public mutating func record(_ delta: String, at receivedAt: Date) {
        guard !delta.isEmpty else { return }
        fragments.append(Fragment(text: delta, receivedAt: receivedAt))
        fragments.removeAll { receivedAt.timeIntervalSince($0.receivedAt) > Self.retention }
        if fragments.count > Self.maximumFragments {
            fragments.removeFirst(fragments.count - Self.maximumFragments)
        }
    }

    /// True only when the wearer's most recent words, received after `since` and
    /// no older than `maximumAge`, end with the confirmation phrase. Anything said
    /// after the phrase withdraws it.
    public func heardConfirmation(
        since: Date,
        now: Date,
        maximumAge: TimeInterval = 30,
        minimumDelay: TimeInterval = BoundSpokenReadback.minimumConfirmationDelay
    ) -> Bool {
        let recent = fragments.filter {
            $0.receivedAt >= since.addingTimeInterval(minimumDelay)
                && $0.receivedAt <= now
                && now.timeIntervalSince($0.receivedAt) <= maximumAge
        }
        let words = " " + BoundSpokenReadback.normalize(recent.map(\.text).joined())
        return Self.acceptedPhrases.contains { words.hasSuffix(" \($0)") }
    }

    public mutating func reset() {
        fragments.removeAll()
    }
}
