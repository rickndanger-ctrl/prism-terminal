import Foundation

public enum ProductivityHistoryScope: String, Sendable {
    case all, reminder, calendarEvent

    public static func requested(_ transcript: String) -> Self? {
        guard var text = TaskTakingSpeechPolicy.authoritativeTaskText(from: transcript)?.lowercased() else { return nil }
        text = text.replacingOccurrences(of: #"^(?:(?:please|can you|could you|would you|will you)\s+)+"#, with: "", options: .regularExpression)
        let words = text.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
        guard let first = words.first, ["what", "which", "list", "show", "read"].contains(first),
              !Set(words).isDisjoint(with: ["you", "lens"]),
              !Set(words).isDisjoint(with: ["saved", "created", "added", "made", "save", "create", "add", "make", "set"]),
              Set(words).isDisjoint(with: ["delete", "remove", "open", "click", "type", "paste", "download", "upload"]) else { return nil }
        let reminders = words.contains("reminder") || words.contains("reminders")
        let events = words.contains("event") || words.contains("events")
            || (words.contains("calendar") && (words.contains("items") || words.contains("entries")))
        if reminders && events { return .all }
        if reminders { return .reminder }
        if events { return .calendarEvent }
        if words.contains("personal") && words.contains("items") { return .all }
        return nil
    }
}

public struct ProductivityHistoryItem: Sendable {
    public let action: ProductivityAction
    public let saveConfirmed: Bool
    public let recordedAt: Date?
}

public struct ProductivityHistory: Sendable {
    public let items: [ProductivityHistoryItem]
    public let totalMatching: Int
    public var truncated: Bool { items.count < totalMatching }
}
