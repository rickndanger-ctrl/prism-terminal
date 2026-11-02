import XCTest
@testable import CodexLensKit

final class RealtimeSessionMachineTests: XCTestCase {
    func testConnectThenEstablished() {
        var machine = RealtimeSessionMachine()
        XCTAssertEqual(machine.state, .idle)
        XCTAssertEqual(machine.handle(.connect), .connecting)
        XCTAssertEqual(machine.handle(.connectionEstablished), .connected)
    }

    func testConnectionLossSchedulesBackoffThenReconnects() {
        var machine = RealtimeSessionMachine(policy: ReconnectPolicy(base: 1, maximum: 30, maxAttempts: 6))
        machine.handle(.connect)
        machine.handle(.connectionEstablished)

        XCTAssertEqual(machine.handle(.connectionLost(reason: "drop")), .reconnecting(attempt: 1, retryAfter: 1))
        // Still down → attempt 2, delay doubles.
        XCTAssertEqual(machine.handle(.connectionLost(reason: "drop")), .reconnecting(attempt: 2, retryAfter: 2))
        // A success clears the attempt counter.
        XCTAssertEqual(machine.handle(.connectionEstablished), .connected)
        XCTAssertEqual(machine.handle(.connectionLost(reason: "drop")), .reconnecting(attempt: 1, retryAfter: 1))
    }

    func testBackoffIsCappedAndGivesUp() {
        let policy = ReconnectPolicy(base: 1, maximum: 4, maxAttempts: 3)
        XCTAssertEqual(policy.delay(forAttempt: 1), 1)
        XCTAssertEqual(policy.delay(forAttempt: 2), 2)
        XCTAssertEqual(policy.delay(forAttempt: 3), 4)
        XCTAssertEqual(policy.delay(forAttempt: 4), 4, "capped at maximum")

        var machine = RealtimeSessionMachine(policy: policy)
        machine.handle(.connect)
        machine.handle(.connectionEstablished)
        machine.handle(.connectionLost(reason: "1"))
        machine.handle(.connectionLost(reason: "2"))
        machine.handle(.connectionLost(reason: "3"))
        // 4th loss exceeds maxAttempts → failed.
        if case .failed = machine.handle(.connectionLost(reason: "4")) {
            // expected
        } else {
            XCTFail("expected .failed after exhausting attempts")
        }
    }

    func testDisconnectAndFail() {
        var machine = RealtimeSessionMachine()
        machine.handle(.connect)
        machine.handle(.connectionEstablished)
        XCTAssertEqual(machine.handle(.disconnect), .disconnected)
        XCTAssertEqual(machine.handle(.fail(reason: "fatal")), .failed(reason: "fatal"))
    }

    func testCredentialRenewalTiming() {
        let credential = RealtimeCredential(
            value: "ek", expiresAt: "2026-07-16T12:00:00.000Z", model: "gpt-realtime"
        )
        let expiry = credential.expiresAtDate!
        // 5 minutes before expiry, with a 60s lead → not yet.
        XCTAssertFalse(RealtimeCredentialClock.needsRenewal(credential, now: expiry.addingTimeInterval(-300), lead: 60))
        // 30s before expiry, with a 60s lead → renew now.
        XCTAssertTrue(RealtimeCredentialClock.needsRenewal(credential, now: expiry.addingTimeInterval(-30), lead: 60))
    }

    func testUnparseableExpiryIsTreatedAsStale() {
        let credential = RealtimeCredential(value: "ek", expiresAt: "not-a-date", model: "m")
        XCTAssertTrue(RealtimeCredentialClock.needsRenewal(credential, now: Date(), lead: 60))
    }
}

// MARK: - Coordinator (gateway + machine + transport tied together)

/// A transport double that fails its first `failuresBeforeSuccess` connects,
/// then succeeds — to exercise the reconnect loop deterministically.
final class FakeRealtimeTransport: RealtimeTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var remainingFailures: Int
    private(set) var connectCount = 0
    private(set) var credentialValues: [String] = []
    private(set) var disconnected = false

    init(failuresBeforeSuccess: Int = 0) {
        self.remainingFailures = failuresBeforeSuccess
    }

    func connect(using credential: RealtimeCredential) async throws {
        let shouldFail = lock.withLock {
            connectCount += 1
            credentialValues.append(credential.value)
            guard remainingFailures > 0 else { return false }
            remainingFailures -= 1
            return true
        }
        if shouldFail {
            throw GatewayError.transport("connect failed")
        }
    }

    func disconnect() async {
        lock.withLock { disconnected = true }
    }

    func send(_ message: RealtimeOutboundMessage) async throws {}
}

final class CredentialSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var issued = 0

    func nextResponse() -> StubTransport.Response {
        lock.lock(); defer { lock.unlock() }
        issued += 1
        return .init(status: 200, body: Data("""
        { "value": "ek_\(issued)", "expiresAt": "2999-01-01T00:00:00.000Z", "model": "gpt-realtime" }
        """.utf8))
    }
}

actor BlockingRealtimeTransport: RealtimeTransport {
    struct Snapshot: Sendable {
        let connectCount: Int
        let disconnectCount: Int
        let maximumConcurrentConnects: Int
    }

    private var connectCount = 0
    private var disconnectCount = 0
    private var activeConnects = 0
    private var maximumConcurrentConnects = 0
    private var firstConnectContinuation: CheckedContinuation<Void, Never>?

    func connect(using credential: RealtimeCredential) async throws {
        connectCount += 1
        activeConnects += 1
        maximumConcurrentConnects = max(maximumConcurrentConnects, activeConnects)
        if connectCount == 1 {
            await withCheckedContinuation { continuation in
                firstConnectContinuation = continuation
            }
        }
        activeConnects -= 1
    }

    func disconnect() async {
        disconnectCount += 1
    }

    func send(_ message: RealtimeOutboundMessage) async throws {}

    func releaseFirstConnect() {
        firstConnectContinuation?.resume()
        firstConnectContinuation = nil
    }

    func snapshot() -> Snapshot {
        Snapshot(
            connectCount: connectCount,
            disconnectCount: disconnectCount,
            maximumConcurrentConnects: maximumConcurrentConnects
        )
    }
}

final class RealtimeSessionCoordinatorTests: XCTestCase {
    func testDuplicateDisconnectDoesNotStartAnotherRecoveryLoop() async {
        let transport = BlockingRealtimeTransport()
        let coordinator = RealtimeSessionCoordinator(
            gateway: makeGateway(), transport: transport, sleeper: { _ in }
        )
        // Hold the initial connect, then use recovery to queue behind it.
        let startup = Task { await coordinator.start() }
        for _ in 0..<1000 {
            if await transport.snapshot().connectCount == 1 { break }
            await Task.yield()
        }
        let recovery = Task { await coordinator.connectionLost(reason: "drop") }
        for _ in 0..<100 { await Task.yield() }
        _ = await coordinator.connectionLost(reason: "duplicate drop")
        await transport.releaseFirstConnect()
        _ = await startup.value
        _ = await recovery.value
        let snapshot = await transport.snapshot()
        XCTAssertEqual(snapshot.connectCount, 2)
        XCTAssertEqual(snapshot.maximumConcurrentConnects, 1)
        await coordinator.stop()
    }

    private func makeGateway() -> GatewayClient {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data("""
            { "value": "ek_1", "expiresAt": "2999-01-01T00:00:00.000Z", "model": "gpt-realtime" }
            """.utf8))
        }
        let config = GatewayConfiguration(
            baseURL: URL(string: "http://127.0.0.1:8787")!, tokenProvider: { "t" }
        )
        return GatewayClient(configuration: config, transport: transport)
    }

    func testStartMintsCredentialAndConnects() async {
        let transport = FakeRealtimeTransport()
        let coordinator = RealtimeSessionCoordinator(
            gateway: makeGateway(), transport: transport, sleeper: { _ in }
        )
        let state = await coordinator.start()
        XCTAssertEqual(state, .connected)
        XCTAssertEqual(transport.connectCount, 1)
    }

    func testReconnectLoopRecoversAfterTransientFailures() async {
        let transport = FakeRealtimeTransport(failuresBeforeSuccess: 2)
        let coordinator = RealtimeSessionCoordinator(
            gateway: makeGateway(),
            transport: transport,
            policy: ReconnectPolicy(base: 1, maximum: 5, maxAttempts: 6),
            sleeper: { _ in }  // no real delay
        )
        // The initial connection fails, then the persistent reconnect loop
        // retries with backoff until it reconnects.
        let initial = await coordinator.start()
        if case .failed = initial {
            // expected
        } else {
            XCTFail("expected the injected initial connection failure")
        }
        let state = await coordinator.connectionLost(reason: "network blip")
        XCTAssertEqual(state, .connected)
        // 2 failed attempts + 1 success.
        XCTAssertEqual(transport.connectCount, 3)
    }

    func testReconnectMintsFreshSingleUseCredential() async {
        let sequence = CredentialSequence()
        let gatewayTransport = StubTransport { _ in sequence.nextResponse() }
        let gateway = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "http://127.0.0.1:8787")!,
                tokenProvider: { "t" }
            ),
            transport: gatewayTransport
        )
        let transport = FakeRealtimeTransport(failuresBeforeSuccess: 1)
        let coordinator = RealtimeSessionCoordinator(
            gateway: gateway,
            transport: transport,
            policy: ReconnectPolicy(base: 1, maximum: 5, maxAttempts: 3),
            sleeper: { _ in }
        )

        let initial = await coordinator.start()
        if case .failed = initial {} else { XCTFail("expected initial failure") }
        let recovered = await coordinator.connectionLost(reason: "retry")

        XCTAssertEqual(recovered, .connected)
        XCTAssertEqual(transport.credentialValues, ["ek_1", "ek_2"])
    }

    func testSequentialSuccessfulStartsMintDistinctCredentials() async {
        let sequence = CredentialSequence()
        let gatewayTransport = StubTransport { _ in sequence.nextResponse() }
        let gateway = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "http://127.0.0.1:8787")!,
                tokenProvider: { "t" }
            ),
            transport: gatewayTransport
        )
        let transport = FakeRealtimeTransport()
        let coordinator = RealtimeSessionCoordinator(
            gateway: gateway,
            transport: transport,
            sleeper: { _ in }
        )

        let first = await coordinator.start()
        let second = await coordinator.start()
        XCTAssertEqual(first, .connected)
        XCTAssertEqual(second, .connected)
        XCTAssertEqual(transport.credentialValues, ["ek_1", "ek_2"])
    }

    func testOverlappingStartsCannotDisconnectTheReplacementSession() async {
        let sequence = CredentialSequence()
        let gateway = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "http://127.0.0.1:8787")!,
                tokenProvider: { "t" }
            ),
            transport: StubTransport { _ in sequence.nextResponse() }
        )
        let transport = BlockingRealtimeTransport()
        let coordinator = RealtimeSessionCoordinator(
            gateway: gateway,
            transport: transport,
            sleeper: { _ in }
        )

        let firstStart = Task { await coordinator.start() }
        for _ in 0..<1_000 {
            if await transport.snapshot().connectCount == 1 { break }
            await Task.yield()
        }
        let firstSnapshot = await transport.snapshot()
        XCTAssertEqual(firstSnapshot.connectCount, 1)

        let replacementStart = Task { await coordinator.start() }
        for _ in 0..<200 { await Task.yield() }
        let waitingSnapshot = await transport.snapshot()
        XCTAssertEqual(
            waitingSnapshot.connectCount,
            1,
            "the replacement must wait until stale-peer cleanup is complete"
        )

        await transport.releaseFirstConnect()
        _ = await firstStart.value
        let replacementState = await replacementStart.value
        let snapshot = await transport.snapshot()

        XCTAssertEqual(replacementState, .connected)
        XCTAssertEqual(snapshot.connectCount, 2)
        XCTAssertEqual(snapshot.maximumConcurrentConnects, 1)
        XCTAssertEqual(snapshot.disconnectCount, 1, "only the stale first peer is disconnected")
    }

    func testStopWhileConnectIsBlockedPreventsQueuedStartFromRevivingSession() async {
        let sequence = CredentialSequence()
        let gateway = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "http://127.0.0.1:8787")!,
                tokenProvider: { "t" }
            ),
            transport: StubTransport { _ in sequence.nextResponse() }
        )
        let transport = BlockingRealtimeTransport()
        let coordinator = RealtimeSessionCoordinator(
            gateway: gateway,
            transport: transport,
            sleeper: { _ in }
        )

        let firstStart = Task { await coordinator.start() }
        for _ in 0..<1_000 {
            if await transport.snapshot().connectCount == 1 { break }
            await Task.yield()
        }
        let blockedSnapshot = await transport.snapshot()
        XCTAssertEqual(blockedSnapshot.connectCount, 1)

        let queuedStart = Task { await coordinator.start() }
        for _ in 0..<200 { await Task.yield() }
        await coordinator.stop()
        await transport.releaseFirstConnect()

        _ = await firstStart.value
        _ = await queuedStart.value
        let state = await coordinator.state
        let snapshot = await transport.snapshot()

        XCTAssertEqual(state, .disconnected)
        XCTAssertEqual(snapshot.connectCount, 1, "the queued start must not revive a stopped session")
        XCTAssertEqual(snapshot.maximumConcurrentConnects, 1)
        XCTAssertEqual(snapshot.disconnectCount, 2, "stop and stale-connect cleanup each disconnect once")
    }

    func testBurstOfOverlappingStartsConnectsOnlyTheFinalGeneration() async {
        let sequence = CredentialSequence()
        let gateway = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "http://127.0.0.1:8787")!,
                tokenProvider: { "t" }
            ),
            transport: StubTransport { _ in sequence.nextResponse() }
        )
        let transport = BlockingRealtimeTransport()
        let coordinator = RealtimeSessionCoordinator(
            gateway: gateway,
            transport: transport,
            sleeper: { _ in }
        )

        let firstStart = Task { await coordinator.start() }
        for _ in 0..<1_000 {
            if await transport.snapshot().connectCount == 1 { break }
            await Task.yield()
        }
        let blockedSnapshot = await transport.snapshot()
        XCTAssertEqual(blockedSnapshot.connectCount, 1)

        let replacements = (0..<20).map { _ in
            Task { await coordinator.start() }
        }
        for _ in 0..<500 { await Task.yield() }
        let burstWaitingSnapshot = await transport.snapshot()
        XCTAssertEqual(burstWaitingSnapshot.connectCount, 1)

        await transport.releaseFirstConnect()
        _ = await firstStart.value
        for replacement in replacements {
            _ = await replacement.value
        }
        let finalState = await coordinator.state
        let snapshot = await transport.snapshot()

        XCTAssertEqual(finalState, .connected)
        XCTAssertEqual(snapshot.connectCount, 2, "only the stale first and final replacement may connect")
        XCTAssertEqual(snapshot.maximumConcurrentConnects, 1)
        XCTAssertEqual(snapshot.disconnectCount, 1)
    }

    func testStopDisconnects() async {
        let transport = FakeRealtimeTransport()
        let coordinator = RealtimeSessionCoordinator(
            gateway: makeGateway(), transport: transport, sleeper: { _ in }
        )
        await coordinator.start()
        await coordinator.stop()
        let state = await coordinator.state
        XCTAssertEqual(state, .disconnected)
        XCTAssertTrue(transport.disconnected)
    }

    func testConnectionLossAfterStopDoesNotRestartTransport() async {
        let transport = FakeRealtimeTransport()
        let coordinator = RealtimeSessionCoordinator(
            gateway: makeGateway(), transport: transport, sleeper: { _ in }
        )
        await coordinator.start()
        await coordinator.stop()
        let state = await coordinator.connectionLost(reason: "late delegate callback")
        XCTAssertEqual(state, .disconnected)
        XCTAssertEqual(transport.connectCount, 1)
    }
}
