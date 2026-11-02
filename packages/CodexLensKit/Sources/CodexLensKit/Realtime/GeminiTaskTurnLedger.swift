import Foundation

/// Session-local task dispatch tombstones. Losing a reply never releases a turn
/// for retry; durable outcome recovery belongs to the existing phone task store.
public struct GeminiTaskTurnLedger: Sendable {
    private var claimed: Set<UUID> = []
    private let capacity: Int

    public init(capacity: Int = 4096) {
        self.capacity = min(max(capacity, 0), 4096)
    }

    public mutating func claim(_ turnID: UUID) -> Bool {
        guard claimed.count < capacity else { return false }
        return claimed.insert(turnID).inserted
    }
}
