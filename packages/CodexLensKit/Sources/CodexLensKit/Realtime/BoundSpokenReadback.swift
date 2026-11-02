import Foundation

/// Shared fail-closed rules for a spoken authorization readback.
///
/// The expected sentence is generated from gateway-bound fields. The completed
/// assistant transcript must match that entire sentence after only harmless
/// speech normalization. Merely containing the task or message is not enough:
/// prefixes such as "do not", appended objectives, and altered metadata fail.
public enum BoundSpokenReadback {
    public static let minimumConfirmationDelay: TimeInterval = 0.75

    public static func matches(_ responseTranscript: String, requiredReadback: String) -> Bool {
        let response = normalize(responseTranscript)
        let required = normalize(requiredReadback)
        return !response.isEmpty && !required.isEmpty && response == required
    }

    public static func confirmationIsFresh(
        transcribedAt: Date,
        readbackCompletedAt: Date,
        now: Date,
        maximumTranscriptAge: TimeInterval,
        minimumPostReadbackDelay: TimeInterval = minimumConfirmationDelay
    ) -> Bool {
        transcribedAt >= readbackCompletedAt.addingTimeInterval(minimumPostReadbackDelay)
            && transcribedAt <= now
            && now.timeIntervalSince(transcribedAt) <= maximumTranscriptAge
    }

    public static func normalize(_ value: String) -> String {
        value
            .folding(
                options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                locale: Locale(identifier: "en_US_POSIX")
            )
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
