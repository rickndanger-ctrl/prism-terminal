import Foundation

/// Ties the pieces together: fetches a short-lived credential from the gateway,
/// drives the connection state machine, and runs the reconnect-with-backoff
/// loop against an injected `RealtimeTransport`. The sleeper is injected so the
/// backoff is exercised in tests without real delay. No audio here — the
/// transport owns that.
public actor RealtimeSessionCoordinator {
    private let gateway: GatewayClient
    private let transport: RealtimeTransport
    private let policy: ReconnectPolicy
    private let model: String?
    private let sleeper: @Sendable (TimeInterval) async -> Void

    private var machine: RealtimeSessionMachine
    private var credential: RealtimeCredential?
    private var shouldRun = false
    private var runGeneration: UInt = 0
    private var recoveryGeneration: UInt?
    private var isTransportConnectInProgress = false
    private var transportConnectWaiters: [CheckedContinuation<Void, Never>] = []

    public init(
        gateway: GatewayClient,
        transport: RealtimeTransport,
        policy: ReconnectPolicy = ReconnectPolicy(),
        model: String? = nil,
        sleeper: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) {
        self.gateway = gateway
        self.transport = transport
        self.policy = policy
        self.model = model
        self.sleeper = sleeper
        self.machine = RealtimeSessionMachine(policy: policy)
    }

    public var state: RealtimeState { machine.state }

    /// Establish the session: mint a credential and open the transport.
    @discardableResult
    public func start() async -> RealtimeState {
        runGeneration &+= 1
        let generation = runGeneration
        shouldRun = true
        machine = RealtimeSessionMachine(policy: policy)
        machine.handle(.connect)
        do {
            let credential = try await mintCredential()
            guard isCurrentRun(generation) else { return machine.state }
            guard try await establishTransport(using: credential, generation: generation) else {
                return machine.state
            }
            machine.handle(.connectionEstablished)
        } catch {
            guard isCurrentRun(generation) else { return machine.state }
            machine.handle(.fail(reason: reason(from: error)))
        }
        return machine.state
    }

    /// Run the full reconnect sequence after a drop: back off, refresh the
    /// credential when needed, and retry until connected or the policy gives up.
    @discardableResult
    public func connectionLost(reason: String) async -> RealtimeState {
        guard shouldRun else { return machine.state }
        let generation = runGeneration
        // Actor methods can overlap at every await. One recovery loop owns
        // each run; duplicate disconnect callbacks must not replace its peer.
        guard recoveryGeneration != generation else { return machine.state }
        recoveryGeneration = generation
        defer {
            if recoveryGeneration == generation { recoveryGeneration = nil }
        }
        machine.handle(.connectionLost(reason: reason))
        while case .reconnecting(_, let retryAfter) = machine.state {
            await sleeper(retryAfter)
            guard isCurrentRun(generation), !Task.isCancelled else { return machine.state }
            do {
                // Realtime WebRTC client secrets are single-use. Any new SDP
                // connection attempt must mint a fresh credential even when
                // the previous secret has not reached its expiry timestamp.
                let credential = try await mintCredential(forceRefresh: true)
                guard isCurrentRun(generation), !Task.isCancelled else { return machine.state }
                guard try await establishTransport(using: credential, generation: generation) else {
                    return machine.state
                }
                machine.handle(.connectionEstablished)
            } catch {
                guard isCurrentRun(generation), !Task.isCancelled else { return machine.state }
                machine.handle(.connectionLost(reason: self.reason(from: error)))
            }
        }
        return machine.state
    }

    public func stop() async {
        shouldRun = false
        runGeneration &+= 1
        machine.handle(.disconnect)
        await transport.disconnect()
    }

    // MARK: - Internals

    private func mintCredential(forceRefresh: Bool = true) async throws -> RealtimeCredential {
        if !forceRefresh,
           let existing = credential,
           !RealtimeCredentialClock.needsRenewal(existing, now: Date()) {
            return existing
        }
        let fresh = try await gateway.realtimeCredential(model: model)
        credential = fresh
        return fresh
    }

    /// `actor` isolation is reentrant across `await`, so two calls to `start()`
    /// can otherwise enter `transport.connect` at the same time. A stale first
    /// attempt can then disconnect the newer peer. Serialize the entire
    /// connect-and-stale-cleanup operation so replacement sessions cannot tear
    /// each other down.
    private func establishTransport(
        using credential: RealtimeCredential,
        generation: UInt
    ) async throws -> Bool {
        await acquireTransportConnectSlot()
        defer { releaseTransportConnectSlot() }

        guard isCurrentRun(generation), !Task.isCancelled else { return false }
        try await transport.connect(using: credential)
        guard isCurrentRun(generation), !Task.isCancelled else {
            await transport.disconnect()
            return false
        }
        return true
    }

    private func acquireTransportConnectSlot() async {
        if !isTransportConnectInProgress {
            isTransportConnectInProgress = true
            return
        }
        await withCheckedContinuation { continuation in
            transportConnectWaiters.append(continuation)
        }
    }

    private func releaseTransportConnectSlot() {
        guard !transportConnectWaiters.isEmpty else {
            isTransportConnectInProgress = false
            return
        }
        transportConnectWaiters.removeFirst().resume()
    }

    private func reason(from error: Error) -> String {
        if let gatewayError = error as? GatewayError {
            return String(describing: gatewayError)
        }
        return error.localizedDescription
    }

    private func isCurrentRun(_ generation: UInt) -> Bool {
        shouldRun && generation == runGeneration
    }
}
