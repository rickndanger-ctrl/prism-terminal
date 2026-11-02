import Foundation

/// Durable pointer to the one text intent whose send was most recently
/// attempted. It enables read-only recovery after timeout, rollover, lock, or
/// app termination without ever replaying a send.
public struct MessageIntentIDStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = "lastMessageIntentConfirmationID"
    ) {
        self.defaults = defaults
        self.key = key
    }

    public var lastConfirmationID: String? {
        guard
            let value = defaults.string(forKey: key)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        else { return nil }
        return value
    }

    public func remember(_ confirmationID: String) {
        let value = confirmationID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(value, forKey: key)
    }

    public func clear() {
        defaults.removeObject(forKey: key)
    }
}
