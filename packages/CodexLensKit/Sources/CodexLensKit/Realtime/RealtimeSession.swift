import Foundation

/// The connection state of the Realtime voice session. This is pure logic —
/// the actual WebRTC/audio transport is injected (see RealtimeTransport) and
/// lives in the on-device app; this machine decides *what* should happen.
public enum RealtimeState: Equatable, Sendable {
    case idle
    case connecting
    case connected
    /// Lost the connection; waiting `retryAfter` seconds before attempt `attempt`.
    case reconnecting(attempt: Int, retryAfter: TimeInterval)
    case disconnected
    case failed(reason: String)

    public var isActive: Bool {
        switch self {
        case .connecting, .connected, .reconnecting: return true
        case .idle, .disconnected, .failed: return false
        }
    }
}

/// What can happen to a session. The machine is a pure reducer over these.
public enum RealtimeEvent: Equatable, Sendable {
    case connect
    case connectionEstablished
    case connectionLost(reason: String)
    case disconnect
    /// A give-up signal (e.g. reconnect attempts exhausted or a fatal error).
    case fail(reason: String)
}

/// Capped exponential backoff for reconnect attempts.
public struct ReconnectPolicy: Sendable {
    public let base: TimeInterval
    public let maximum: TimeInterval
    public let maxAttempts: Int

    public init(base: TimeInterval = 1, maximum: TimeInterval = 30, maxAttempts: Int = 6) {
        self.base = base
        self.maximum = maximum
        self.maxAttempts = maxAttempts
    }

    /// Delay before `attempt` (1-based). Deterministic (no jitter) so it is
    /// testable; add jitter at the call site if desired.
    public func delay(forAttempt attempt: Int) -> TimeInterval {
        guard attempt > 0 else { return 0 }
        let raw = base * pow(2, Double(attempt - 1))
        return min(raw, maximum)
    }

    public func shouldRetry(attempt: Int) -> Bool {
        attempt <= maxAttempts
    }
}

/// A pure state machine for the session lifecycle. Feed it events; read the new
/// state. It never performs I/O, so it is fully unit-tested. The app drives a
/// `RealtimeTransport` from the states this produces.
public struct RealtimeSessionMachine: Sendable {
    public private(set) var state: RealtimeState
    private let policy: ReconnectPolicy

    public init(policy: ReconnectPolicy = ReconnectPolicy()) {
        self.state = .idle
        self.policy = policy
    }

    private var currentAttempt: Int {
        if case .reconnecting(let attempt, _) = state { return attempt }
        return 0
    }

    @discardableResult
    public mutating func handle(_ event: RealtimeEvent) -> RealtimeState {
        switch event {
        case .connect:
            state = .connecting

        case .connectionEstablished:
            // A successful connection clears any prior reconnect count.
            state = .connected

        case .connectionLost(let reason):
            let nextAttempt = currentAttempt + 1
            if policy.shouldRetry(attempt: nextAttempt) {
                state = .reconnecting(
                    attempt: nextAttempt,
                    retryAfter: policy.delay(forAttempt: nextAttempt)
                )
            } else {
                state = .failed(reason: "Reconnect gave up after \(policy.maxAttempts) attempts: \(reason)")
            }

        case .disconnect:
            state = .disconnected

        case .fail(let reason):
            state = .failed(reason: reason)
        }
        return state
    }
}

/// Credential-renewal timing, kept separate from the connection machine because
/// task/conversation state must outlive any single Realtime credential.
public enum RealtimeCredentialClock {
    /// Whether `credential` should be renewed by `now`, refreshing `lead`
    /// seconds early so a renewal completes before the old one expires.
    public static func needsRenewal(
        _ credential: RealtimeCredential,
        now: Date,
        lead: TimeInterval = 60
    ) -> Bool {
        guard let expiry = credential.expiresAtDate else {
            // An unparseable expiry is treated as already stale — fail safe.
            return true
        }
        return now.addingTimeInterval(lead) >= expiry
    }
}
