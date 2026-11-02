import Foundation

public enum DirectCommandIntent {
    /// This selects visual context; the exact user's words still go to Codex.
    public static func requestsCamera(_ text: String) -> Bool {
        let normalized = text.lowercased().replacingOccurrences(of: "’", with: "'")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let namesGlasses = ["glasses", "ray-ban", "ray ban"].contains { normalized.contains($0) }
        let namesDesktop = ["my screen", "the screen", "my desktop", "my computer screen", "my mac screen", "browser tab", "what do you see on my mac"]
            .contains { normalized.contains($0) }
        if namesDesktop && !namesGlasses { return false }
        return ["what am i looking at", "what do you see", "look at this", "look at these",
                "what is this", "what's this", "what are these", "model of this", "what i see",
                "what i'm seeing", "what i am seeing", "what i'm looking at", "what i am looking at",
                "through my glasses", "through the glasses", "glasses view"]
            .contains { normalized.contains($0) }
    }
}
