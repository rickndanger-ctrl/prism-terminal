import Foundation

/// Session-local at-most-once admission. Completed IDs remain remembered until
/// the connection is replaced; a full ledger fails closed instead of evicting.
public struct LiveToolCallLedger: Sendable {
    private var seen: Set<String> = []
    private var pending: Set<String> = []
    public init() {}
    public func contains(_ id: String) -> Bool { seen.contains(id) }
    public mutating func begin(_ id: String) -> Bool {
        guard !seen.contains(id), seen.count < 4096, pending.count < 64 else { return false }
        seen.insert(id)
        pending.insert(id)
        return true
    }
    public mutating func finish(_ id: String) -> Bool {
        pending.remove(id) != nil
    }
    public mutating func reset() {
        seen.removeAll()
        pending.removeAll()
    }
}
