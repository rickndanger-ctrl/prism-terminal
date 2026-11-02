import Foundation

/// Local routing for clear computer-task utterances. Matching turns enter a
/// text-only forced tool response first, so Realtime cannot speak filler before
/// the task is accepted or classified by the gateway.
public enum TaskTakingSpeechPolicy {
    public static let forcedToolName = "prepare_assistant_task"
    public static let immediateAcknowledgment = "Got it, I'm doing that now."

    /// Removes only the locally recognized address word. The remaining text is
    /// still a byte-for-byte wearer-authored task; no model paraphrase enters
    /// the gateway policy boundary.
    public static func authoritativeTaskText(from transcript: String) -> String? {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
        let pattern = #"^(?:codex|codec|code\s+x)\b[\s,.:;!—-]*"#
        guard let expression = try? NSRegularExpression(
            pattern: pattern,
            options: [.caseInsensitive]
        ) else { return trimmed }
        let task = expression.stringByReplacingMatches(
            in: trimmed,
            range: range,
            withTemplate: ""
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        return task.isEmpty ? nil : task
    }

    public static func requiresAssistantTask(
        _ transcript: String,
        gmailReadsEnabled: Bool = false
    ) -> Bool {
        // Only opted-in mailbox reads bypass desktop dispatch. This does not
        // bypass the attention gate or authorize a tool call by itself.
        if gmailReadsEnabled && isGmailReadRequest(transcript) { return false }
        if ProductivityAction.requestedKind(transcript) != nil { return false }
        if ProductivityHistoryScope.requested(transcript) != nil { return false }
        let explicitlyAddressed = isExplicitlyAddressed(transcript)
        let words = normalizedWords(transcript)
        guard !words.isEmpty else { return false }
        let text = words.joined(separator: " ")

        // Texting has its own immutable prepare/Confirm text path.
        if text.hasPrefix("text ") || text.hasPrefix("message ") ||
            text.hasPrefix("send a text ") || text.hasPrefix("send an imessage ") {
            return false
        }

        let strongComputerVerbs: Set<String> = [
            "attach", "click", "code", "commit", "compile", "debug", "deploy",
            "download", "enter", "export", "import", "install", "navigate", "paste",
            "press", "push", "pull", "scroll", "select", "type", "uninstall", "upload",
        ]
        if words.contains(where: strongComputerVerbs.contains) {
            return true
        }

        let actionVerbs: Set<String> = [
            "arrange", "build", "bring", "change", "close", "complete", "copy",
            "create", "delete", "do", "edit", "find", "finish", "fix", "focus", "go",
            "handle", "launch", "make", "maximize", "minimize", "move", "open", "organize",
            "put", "quit", "remove", "rename", "restore", "run", "save", "show",
            "start", "switch", "update",
        ]
        let computerContext: Set<String> = [
            "app", "application", "browser", "build", "calculator", "calendar", "chatgpt",
            "chrome", "code", "computer", "desktop", "discord", "document", "excel",
            "file", "files", "finder", "folder", "github", "mail", "mac", "messages",
            "notes", "photos", "powerpoint", "preview", "project", "repo", "repository",
            "safari", "screen", "settings", "slack", "spotify", "tab", "telegram",
            "terminal", "test", "task", "tasks", "tests", "thread", "window", "word",
            "xcode", "vscode",
        ]
        let isQuestionOpening = words.count >= 2 && words[0] == "do" && words[1] == "you"
        return !isQuestionOpening && words.contains(where: actionVerbs.contains) &&
            (explicitlyAddressed || words.contains(where: computerContext.contains))
    }

    public static func safeStartedReadback(task: String) -> String? {
        let task = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return nil }
        return immediateAcknowledgment
    }

    public static func isGmailReadRequest(_ transcript: String) -> Bool {
        let addressed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^hey\\s+", with: "", options: [.regularExpression, .caseInsensitive])
        let words = normalizedWords(addressed)
        guard let first = words.first,
              ["check", "find", "search", "read", "summarize"].contains(first)
        else { return false }
        // Keep explicit UI actions and compound requests on the existing
        // task path. A mailbox mention alone must not hijack computer use.
        let nonReadActions: Set<String> = [
            "open", "close", "click", "type", "paste", "download", "upload",
            "install", "delete", "move", "send", "reply", "forward", "draft",
            "screen", "browser", "window", "tab", "app", "application",
            "file", "folder", "and", "then",
        ]
        guard Set(words).isDisjoint(with: nonReadActions) else { return false }
        // Require the object near the command, not an email mention buried
        // inside a different instruction (e.g. find a file about email).
        var object = Array(words.dropFirst())
        while let word = object.first,
              ["through", "for", "in", "my", "the", "latest", "recent", "unread", "new"].contains(word) {
            object.removeFirst()
        }
        guard let noun = object.first else { return false }
        return ["gmail", "email", "emails", "mail", "inbox"].contains(noun)
    }

    public static func taskStatusSpeech(state: AssistantTaskState) -> String {
        switch state {
        case .running: return immediateAcknowledgment
        case .completed: return "Done."
        case .prepared: return "I couldn't confirm that task started. Ask for task status."
        case .blocked: return "Codex is blocked. Ask for task status for the details."
        case .failed: return "That Codex task failed."
        case .cancelled: return "That task was cancelled."
        case .expired: return "That request expired. Please ask again."
        }
    }

    /// The phone, not Realtime, selects the narrow project capability set for
    /// unmistakable repository work. Everything else remains a Mac task.
    public static func prefersProjectScope(_ transcript: String) -> Bool {
        // Select from the requested action, not words inside dictation. "Type
        // Glasses Test 1" must not become a repository task because of "test".
        let text = normalizedWords(transcript).joined(separator: " ")
            .replacingOccurrences(
                of: #"^(?:(?:please|can you|could you|would you|will you)\s+)+"#,
                with: "", options: .regularExpression
            )
        return text.range(
            of: #"^(?:(?:build|compile|debug|refactor)\b|(?:run|fix|repair|update|edit|inspect|review|test)\s+(?:(?:the|this|my|our|selected|approved|all|failing|unit|integration)\s+)*(?:project|repo|repository|source|code|tests?|build|xcode)\b)"#,
            options: .regularExpression
        ) != nil
    }

    public static func acceptsExactSpeech(
        _ transcript: String,
        expected: String
    ) -> Bool {
        BoundSpokenReadback.matches(transcript, requiredReadback: expected)
    }

    /// Streaming guard used to cut off model-added filler as soon as it
    /// diverges from the one permitted readback.
    public static func isValidSpeechPrefix(
        _ transcript: String,
        expected: String
    ) -> Bool {
        let spoken = BoundSpokenReadback.normalize(transcript)
        let target = BoundSpokenReadback.normalize(expected)
        guard !spoken.isEmpty, !target.isEmpty else { return spoken.isEmpty }
        // Realtime transcript deltas can split inside a word ("Do" +
        // "ing"), so character-prefix matching is required here. Any suffix
        // beyond the exact target still fails immediately.
        return target.hasPrefix(spoken)
    }

    private static func normalizedWords(_ transcript: String) -> [String] {
        var words = transcript
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9 ]", with: " ", options: .regularExpression)
            .split(whereSeparator: \Character.isWhitespace)
            .map(String.init)
        if words.first == "codex" || words.first == "codec" {
            words.removeFirst()
        } else if words.count >= 2, words[0] == "code", words[1] == "x" {
            words.removeFirst(2)
        }
        while let first = words.first,
              ["please", "can", "could", "would", "will", "you"].contains(first) {
            words.removeFirst()
        }
        return words
    }

    private static func isExplicitlyAddressed(_ transcript: String) -> Bool {
        let normalized = transcript
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9 ]", with: " ", options: .regularExpression)
            .split(whereSeparator: \Character.isWhitespace)
            .map(String.init)
        var words = normalized
        while let first = words.first, ["hey", "okay", "ok", "alright", "so"].contains(first) {
            words.removeFirst()
        }
        return words.first == "codex" || words.first == "codec" || Array(words.prefix(2)) == ["code", "x"]
    }
}
