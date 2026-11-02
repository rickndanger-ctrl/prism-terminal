import Foundation

/// Exact, bounded shortcuts only. Unmatched speech retains the existing Codex
/// path; neither Clef nor an LLM can turn a category guess into authorization.
public struct SpokenPadCommand: Equatable, Sendable {
    public let action: String
    public let value: String

    public static func parse(_ speech: String) -> Self? {
        guard speech.count <= 8000, !speech.contains("\0") else { return nil }
        var text = speech.trimmingCharacters(in: .whitespacesAndNewlines)
        // Keep a separate literal view for explicit colon-delimited typing.
        // Command normalization must not trim the payload's trailing spaces/newlines.
        var literalText = String(speech.drop(while: { $0.isWhitespace }))
        for prefix in ["hey, codex, ", "hey, codex. ", "hey, codex: ", "hey, codex! ", "hey, codex ",
                       "hey codex, ", "hey codex. ", "hey codex: ", "hey codex! ", "hey codex ",
                       "codex, ", "codex. ", "codex: ", "codex! ", "codex "] {
            if text.lowercased().hasPrefix(prefix) {
                text = String(text.dropFirst(prefix.count))
                literalText = String(literalText.dropFirst(prefix.count))
                break
            }
        }
        for prefix in ["can you please, ", "could you please, ", "would you please, ",
                       "can you please ", "could you please ", "would you please ",
                       "can you ", "could you ", "would you ", "please, ", "please "] {
            if text.lowercased().hasPrefix(prefix) {
                text = String(text.dropFirst(prefix.count))
                literalText = String(literalText.dropFirst(prefix.count))
                break
            }
        }
        let trimmed = text.trimmingCharacters(in: CharacterSet(charactersIn: ".?! "))
        var normalized = trimmed.lowercased()
        // Courtesy suffixes belong only to fixed, exact app/window/browser commands.
        // The original text below remains untouched for literal typing/search.
        for suffix in [" for me, please", " for me please", " for me", ", please", " please"] {
            if normalized.hasSuffix(suffix) { normalized = String(normalized.dropLast(suffix.count)); break }
        }
        let apps = ["calculator": "Calculator", "notes": "Notes", "finder": "Finder",
            "vs code": "Visual Studio Code", "visual studio code": "Visual Studio Code",
            "claude": "Claude", "settings": "System Settings", "system settings": "System Settings",
            "chatgpt": "ChatGPT", "chat gpt": "ChatGPT", "codex": "ChatGPT", "cursor": "Cursor",
            "chrome": "Google Chrome", "google chrome": "Google Chrome", "safari": "Safari", "messages": "Messages",
            "texts": "Messages", "facetime": "FaceTime", "face time": "FaceTime", "textedit": "TextEdit", "text edit": "TextEdit"]
        func exactApp(_ target: String) -> String? {
            var target = target
            // Only these finite wrappers are optional. The whole remaining
            // target must equal an allowlisted app, never a command substring.
            if target.hasPrefix("the ") { target = String(target.dropFirst(4)) }
            if target.hasSuffix(" app") { target = String(target.dropLast(4)) }
            return apps[target]
        }
        for prefix in ["open up ", "open ", "launch ", "switch to ", "bring up ", "go to ", "focus "] where normalized.hasPrefix(prefix) {
            if let app = exactApp(String(normalized.dropFirst(prefix.count))) { return Self(action: "open", value: app) }
        }
        let frontPrefix = "bring ", frontSuffix = " to the front"
        if normalized.hasPrefix(frontPrefix), normalized.hasSuffix(frontSuffix),
           let app = exactApp(String(normalized.dropFirst(frontPrefix.count).dropLast(frontSuffix.count))) {
            return Self(action: "open", value: app)
        }
        if ["close the current window", "close current window", "close the front window", "close this window",
            "close the window", "close window", "close the frontmost window"].contains(normalized) {
            return Self(action: "close", value: "")
        }
        if let value = windowCommands[normalized] { return Self(action: "window", value: value) }
        if let value = browserCommands[normalized] { return Self(action: "browser", value: value) }
        // URL contents, including path/query case and punctuation, are literal.
        // Do not apply courtesy/punctuation stripping intended for fixed commands.
        for prefix in ["open the website ", "open website ", "open the url ", "open url ",
                       "navigate to ", "go to ", "visit ", "open "] where text.lowercased().hasPrefix(prefix) {
            if let value = navigationURL(String(text.dropFirst(prefix.count))) {
                return Self(action: "navigate", value: value)
            }
        }
        // A colon explicitly delimits focused-field text. Consume at most one
        // conventional separator space; every remaining payload byte is literal.
        // These forms insert only text, including words such as "and send it".
        for prefix in ["type into the focused field:", "type in the focused field:",
                       "type into the current app:", "type in the current app:", "type:"] where literalText.lowercased().hasPrefix(prefix) {
            var value = String(literalText.dropFirst(prefix.count))
            if value.hasPrefix(" ") { value = String(value.dropFirst()) }
            guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return Self(action: "typeFocused", value: value)
        }
        // Payload is literal; do not strip punctuation from dictated text/search.
        for prefix in ["type in a new textedit document: ", "type in a new text edit document: ",
                       "type in a new textedit document ", "type in a new text edit document ",
                       "type in textedit ", "type in text edit "] where text.lowercased().hasPrefix(prefix) {
            let value = String(text.dropFirst(prefix.count))
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return Self(action: "type", value: value) }
        }
        for prefix in ["search the web for ", "search google for "] where text.lowercased().hasPrefix(prefix) {
            let value = String(text.dropFirst(prefix.count))
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.count <= 1000 {
                return Self(action: "search", value: value)
            }
        }
        if text.lowercased().hasPrefix("type ") {
            let value = String(text.dropFirst(5))
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return Self(action: "typeFocused", value: value)
            }
        }
        return nil
    }

    private static let windowCommands: [String: String] = {
        var commands: [String: String] = [:]
        for object in ["window", "the window", "this window", "current window", "the current window", "the front window"] {
            commands["minimize \(object)"] = "minimize"
            commands["maximize \(object)"] = "maximize"
            for side in ["left", "right"] {
                commands["move \(object) \(side)"] = side
                commands["move \(object) to the \(side)"] = side
                commands["move \(object) to the \(side) half"] = side
                commands["put \(object) on the \(side) half"] = side
                commands["snap \(object) \(side)"] = side
                commands["tile \(object) \(side)"] = side
            }
        }
        return commands
    }()

    private static let browserCommands: [String: String] = {
        let aliases: [String: [String]] = [
            "back": ["browser back", "go back in the browser", "go back a page", "go back one page", "back one page"],
            "forward": ["browser forward", "go forward in the browser", "go forward a page", "go forward one page", "forward one page"],
            "reload": ["reload the page", "reload this page", "reload page", "refresh the page", "refresh this page", "refresh page"],
            "newTab": ["new tab", "open a new tab", "open new tab", "create a new tab"],
            "nextTab": ["next tab", "switch to the next tab", "switch to next tab", "go to the next tab"],
            "previousTab": ["previous tab", "switch to the previous tab", "switch to previous tab", "go to the previous tab"],
            "closeTab": ["close this tab", "close the current tab", "close current tab", "close the tab"],
            "focusAddress": ["focus the address bar", "select the address bar", "go to the address bar"]
        ]
        return aliases.reduce(into: [:]) { result, entry in
            for phrase in entry.value { result[phrase] = entry.key }
        }
    }()

    private static func navigationURL(_ target: String) -> String? {
        guard !target.isEmpty, target.utf8.count <= 2048,
              target.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              target.rangeOfCharacter(from: .controlCharacters) == nil,
              target.rangeOfCharacter(from: CharacterSet(charactersIn: "\\\"'`<>")) == nil,
              let decoded = target.removingPercentEncoding,
              decoded.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        let candidate = target.contains("://") ? target : "https://" + target
        guard let components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              components.user == nil, components.password == nil,
              let host = components.host?.lowercased(),
              let url = components.url else { return nil }
        // Foundation returns nil for a present port that overflows Int, not
        // only for an absent port. Reject that form before opening anything.
        guard let schemeEnd = candidate.range(of: "://")?.upperBound else { return nil }
        let authority = candidate[schemeEnd...].prefix { !"/?#".contains($0) }
        if authority.contains(":"), components.port == nil { return nil }
        if let port = components.port, !(1...65535).contains(port) { return nil }
        // Deliberately bounded to an ASCII qualified hostname or localhost.
        // Other URL forms fall through to Codex rather than guessing a target.
        let domain = host.hasSuffix(".") ? String(host.dropLast()) : host
        let labels = domain.split(separator: ".", omittingEmptySubsequences: false)
        guard domain.utf8.count <= 253, domain == "localhost" || labels.count >= 2,
              labels.allSatisfy({ label in
                  !label.isEmpty && label.utf8.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-") &&
                  label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
              }) else { return nil }
        if labels.allSatisfy({ $0.utf8.allSatisfy { (48...57).contains($0) } }) {
            guard labels.count == 4, labels.allSatisfy({ Int($0).map { (0...255).contains($0) } == true }) else { return nil }
        }
        guard url.absoluteString.utf8.count <= 2048 else { return nil }
        return url.absoluteString
    }
}
