import Foundation

public struct TerminalEvent: Codable, Sendable {
    public var sequence: Int
    public var kind: String
    public var itemId: String
    public var text: String?
    public var operation: String?
    public var status: String?
    public var title: String?
    public var imageCount: Int?
}
public struct TerminalEntry: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var kind: String
    public var text: String
    public var title: String
    public var status: String
    public var imageCount: Int
}
public struct TerminalTranscript: Sendable {
    public private(set) var entries: [TerminalEntry] = []
    public private(set) var cursor = 0
    public private(set) var state = "disconnected"
    public init() {}
    public init(entries: [TerminalEntry], cursor: Int, state: String) {
        self.entries = entries
        self.cursor = max(0, cursor)
        self.state = state
    }
    /// Cursor replay may repeat events. Completed text replaces its streamed draft.
    public mutating func apply(_ event: TerminalEvent) {
        guard event.sequence > cursor else { return }
        cursor = event.sequence
        if event.kind == "state" { state = event.status ?? state; return }
        guard ["input", "assistant", "tool", "notice"].contains(event.kind) else { return }
        let index: Int
        if let existing = entries.firstIndex(where: { $0.id == event.itemId }) {
            index = existing
        } else {
            entries.append(.init(id: event.itemId, kind: event.kind, text: "", title: "", status: "", imageCount: 0))
            index = entries.count - 1
        }
        if let text = event.text {
            entries[index].text = event.operation == "append"
                ? String((entries[index].text + text).prefix(64_000)) : text
        }
        if let title = event.title { entries[index].title = title }
        if let status = event.status { entries[index].status = status }
        if let count = event.imageCount { entries[index].imageCount = count }
    }
}
