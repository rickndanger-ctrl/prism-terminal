import Foundation

/// A local safety command, recognized before model attention classification.
/// Plain "stop" is intentionally excluded because nearby conversation is not
/// authority to stop a wearer-owned task.
public enum ExplicitAssistantStopCommand {
    public static func accepts(_ transcript: String) -> Bool {
        let normalized = transcript
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9 ]", with: " ", options: .regularExpression)
            .split(whereSeparator: \Character.isWhitespace)
            .joined(separator: " ")
        return [
            "codex stop",
            "codec stop",
            "code x stop",
            "stop codex",
            "stop codec",
            "stop code x",
        ].contains(normalized)
    }
}
