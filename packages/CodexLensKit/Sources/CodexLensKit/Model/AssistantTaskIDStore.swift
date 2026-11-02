import Foundation

/// Durable phone-owned pointers for assistant-task recovery.
///
/// `lastTaskID` is authoritative: it identifies the most recent task known to
/// have crossed the start boundary. `pendingStartTaskID` is separate and exists
/// only while a one-shot start POST has an unknown response. Keeping both means
/// a newer uncertain attempt cannot hide an older unreconciled safety lock.
public struct AssistantTaskIDStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let authoritativeKey: String
    private let pendingStartKey: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = "lastAssistantTaskID",
        pendingStartKey: String = "pendingAssistantTaskStartID"
    ) {
        self.defaults = defaults
        authoritativeKey = key
        self.pendingStartKey = pendingStartKey
    }

    public var lastTaskID: String? {
        storedTaskID(forKey: authoritativeKey)
    }

    public var pendingStartTaskID: String? {
        storedTaskID(forKey: pendingStartKey)
    }

    /// Records a task only after status proves that its start boundary was
    /// crossed. Write the authoritative pointer before clearing pending state
    /// so an app termination between writes remains recoverable.
    public func remember(_ taskID: String) {
        store(taskID, forKey: authoritativeKey)
    }

    /// Persists the gateway-issued id before the one permitted start POST.
    public func rememberPendingStart(_ taskID: String) {
        store(taskID, forKey: pendingStartKey)
    }

    /// Promotes only the currently pending id to authoritative started state.
    /// A stale async response cannot consume a newer pending start.
    @discardableResult
    public func promotePendingStart(_ taskID: String) -> Bool {
        let candidate = taskID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty, pendingStartTaskID == candidate else { return false }
        defaults.set(candidate, forKey: authoritativeKey)
        defaults.removeObject(forKey: pendingStartKey)
        return true
    }

    /// Clears only the matching pending id after status proves that the start
    /// never crossed the consequential boundary.
    @discardableResult
    public func clearPendingStart(_ taskID: String) -> Bool {
        let candidate = taskID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty, pendingStartTaskID == candidate else { return false }
        defaults.removeObject(forKey: pendingStartKey)
        return true
    }

    public func clear() {
        defaults.removeObject(forKey: authoritativeKey)
        defaults.removeObject(forKey: pendingStartKey)
    }

    private func storedTaskID(forKey key: String) -> String? {
        guard
            let value = defaults.string(forKey: key)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        else { return nil }
        return value
    }

    private func store(_ taskID: String, forKey key: String) {
        let value = taskID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(value, forKey: key)
    }
}

/// Resolves a task id from phone-owned state. A model may repeat the id it was
/// shown, but it cannot replace the durable pointer with another task id.
public enum AssistantTaskIDAuthorization {
    public enum PendingStatusAction: Equatable, Sendable {
        case preserve
        case promote
        case clear
    }

    public static func resolve(requested: String?, remembered: String?) -> String? {
        guard
            let remembered = remembered?.trimmingCharacters(in: .whitespacesAndNewlines),
            !remembered.isEmpty
        else { return nil }
        guard let requested else { return remembered }
        let candidate = requested.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty, candidate == remembered else { return nil }
        return remembered
    }

    public static func responseMatches(_ responseTaskID: String, expectedTaskID: String) -> Bool {
        let response = responseTaskID.trimmingCharacters(in: .whitespacesAndNewlines)
        let expected = expectedTaskID.trimmingCharacters(in: .whitespacesAndNewlines)
        return !response.isEmpty && !expected.isEmpty && response == expected
    }

    /// Decides how a status response may change the durable pending-start
    /// pointer. A separate status GET can briefly observe `prepared` while the
    /// one permitted start POST is still in flight. Only the start call's own
    /// recovery result may clear that pointer during this window; otherwise a
    /// later successful start could become untracked.
    public static func pendingStatusAction(
        state: AssistantTaskState,
        hasStartedAt: Bool,
        startRequestInFlight: Bool,
        isStartAttemptRecovery: Bool
    ) -> PendingStatusAction {
        if hasStartedAt || state == .running || state == .completed
            || state == .blocked || state == .failed {
            return .promote
        }
        if state == .prepared, startRequestInFlight, !isStartAttemptRecovery {
            return .preserve
        }
        return .clear
    }

    /// Resolves status/cancel access against the two phone-owned pointers.
    /// With no explicit id, the uncertain pending start is inspected first so
    /// the app can learn whether to promote or discard it. An explicit id may
    /// address either phone-owned task, preserving access to an older safety
    /// lock while a newer start response is unresolved.
    public static func resolve(
        requested: String?,
        authoritative: String?,
        pendingStart: String?
    ) -> String? {
        let authoritative = normalized(authoritative)
        let pendingStart = normalized(pendingStart)
        guard let requested else { return pendingStart ?? authoritative }
        guard let candidate = normalized(requested) else { return nil }
        return candidate == pendingStart || candidate == authoritative ? candidate : nil
    }

    private static func normalized(_ taskID: String?) -> String? {
        guard let taskID else { return nil }
        let normalized = taskID.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }
}
