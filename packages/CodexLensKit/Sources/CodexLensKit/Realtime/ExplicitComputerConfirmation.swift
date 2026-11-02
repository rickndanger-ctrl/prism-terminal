import Foundation

/// Accepts only the hard-addressed confirmation phrase while an exact digest
/// is armed by the phone. Generic assent is unsafe in ambient conversation.
public enum ExplicitComputerConfirmation {
    public static func accepts(_ transcript: String) -> Bool {
        let normalized = transcript
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9' ]", with: " ", options: .regularExpression)
            .split(whereSeparator: \Character.isWhitespace)
            .joined(separator: " ")

        return [
            "codex confirm",
            "codec confirm",
            "code x confirm",
        ].contains(normalized)
    }
}
