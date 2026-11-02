import Foundation

/// Consumes the task event stream without ever re-reading. Holds the cursor,
/// hands each page to `ingest`, and returns only the events it hasn't seen —
/// honoring the contract in docs/M4.md: the cursor only advances, never rewinds,
/// and a terminal event ends the stream.
public struct TaskEventStreamCursor: Sendable {
    /// The seq to pass as `after` on the next poll. Starts at -1 (whole log).
    public private(set) var cursor: Int
    /// Set once a terminal event (complete/failed) has been seen.
    public private(set) var isComplete: Bool

    public init() {
        self.cursor = -1
        self.isComplete = false
    }

    /// Absorbs a page, advancing the cursor and reporting the genuinely-new
    /// events (guarding against a page that overlaps what we already have).
    @discardableResult
    public mutating func ingest(_ page: TaskEventsPage) -> [TaskEvent] {
        let fresh = page.events.filter { $0.seq > cursor }
        // The cursor never moves backward, even if a page reports a lower
        // nextCursor than we already hold.
        cursor = max(cursor, page.nextCursor)
        if let highestSeen = fresh.map(\.seq).max() {
            cursor = max(cursor, highestSeen)
        }
        if fresh.contains(where: { $0.type.isTerminal }) {
            isComplete = true
        }
        return fresh
    }

    /// The `after` value for the next request, or nil to fetch the whole log.
    public var nextAfter: Int? {
        cursor < 0 ? nil : cursor
    }
}
