import XCTest
@testable import CodexLensKit

final class GmailWriteClientTests: XCTestCase {
    func testCancellationOnlyDeletesExactGatewayPreview() async throws {
        let id = UUID().uuidString
        let transport = StubTransport { _ in .init(status: 200, body: Data(#"{"cancelled":true}"#.utf8)) }
        let client = GatewayClient(configuration: .init(baseURL: URL(string: "https://gateway.example")!, tokenProvider: { "fixture" }), transport: transport)
        let cancelled = try await client.cancelGmailPreview(id: id)
        XCTAssertTrue(cancelled)
        XCTAssertEqual(transport.lastRequest?.httpMethod, "DELETE")
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/gmail/writes/\(id)")
        XCTAssertNil(transport.lastRequest?.httpBody)
        XCTAssertEqual(transport.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture")
    }

    func testInvalidCancellationIDNeverReachesGateway() async {
        let transport = StubTransport { _ in XCTFail("Must not dispatch"); return .init(status: 500, body: Data()) }
        let client = GatewayClient(configuration: .init(baseURL: URL(string: "https://gateway.example")!, tokenProvider: { "fixture" }), transport: transport)
        do { _ = try await client.cancelGmailPreview(id: "../execute"); XCTFail("Must reject invalid ID") }
        catch { XCTAssertNil(transport.lastRequest) }
    }

    private func confirmation() throws -> GmailPhoneConfirmation {
        let start = Date(timeIntervalSince1970: 1000)
        var authorization = EmailConfirmationAuthorization(id: UUID().uuidString, digest: String(repeating: "a", count: 64), operation: .send,
            preparedAt: start, expiresAt: start.addingTimeInterval(300), from: "me@example.com", to: ["friend@example.com"], subject: "Fixture", body: "Fixture")
        XCTAssertNil(authorization.confirmationRecord(sourceItemId: "turn", transcript: "Confirm email", transcribedAt: start.addingTimeInterval(10), now: start.addingTimeInterval(11)))
        authorization.noteReadbackCompleted(authorization.requiredReadback, at: start.addingTimeInterval(3))
        return try XCTUnwrap(authorization.confirmationRecord(sourceItemId: "turn", transcript: "Confirm email", transcribedAt: start.addingTimeInterval(10), now: start.addingTimeInterval(11)))
    }
    func testLostSendUsesOnePostThenStatusGet() async throws {
        let record = try confirmation()
        let body = Data("{\"id\":\"\(record.id)\",\"state\":\"accepted\",\"receiptId\":\"receipt\"}".utf8)
        let transport = AssistantTaskRecoveryTransport(statusResponse: .init(status: 200, body: body))
        let client = GatewayClient(configuration: .init(baseURL: URL(string: "https://gateway.example")!, tokenProvider: { "fixture" }), transport: transport)
        let result = await client.executeGmailWriteRecoveringStatus(record)
        guard case .status(let status) = result else { return XCTFail("Expected recovered status") }
        XCTAssertEqual(status.state, .accepted)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET"])
        XCTAssertEqual(requests.last?.url?.path, "/v1/gmail/writes/\(record.id)")
    }
    func testUnavailableStatusReturnsUncertaintyNotRetry() async throws {
        let record = try confirmation()
        let transport = AssistantTaskRecoveryTransport(statusResponse: nil)
        let client = GatewayClient(configuration: .init(baseURL: URL(string: "https://gateway.example")!, tokenProvider: { "fixture" }), transport: transport)
        let result = await client.executeGmailWriteRecoveringStatus(record)
        guard case .uncertain(let id) = result else { return XCTFail("Expected uncertainty") }
        XCTAssertEqual(id, record.id)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET"])
    }
    func testRecordUsesPhoneTimestampsInMilliseconds() throws {
        let record = try confirmation()
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as! [String: Any]
        XCTAssertEqual(encoded["kind"] as? String, "phone-email-confirmation")
        XCTAssertEqual(encoded["readbackCompletedAt"] as? Double, 1003000)
        XCTAssertEqual(encoded["confirmedAt"] as? Double, 1010000)
    }
}
