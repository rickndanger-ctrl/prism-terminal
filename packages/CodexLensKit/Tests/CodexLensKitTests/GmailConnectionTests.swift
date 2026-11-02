import XCTest
@testable import CodexLensKit

final class GmailConnectionTests: XCTestCase {
    func testOptedInMailboxReadsDoNotDispatchDesktopTasks() {
        for transcript in [
            "Codex, find my email from Sam",
            "Codex, please search my Gmail for the receipt",
            "Hey Code X, find my latest email",
            "Read my latest emails",
            "Check my inbox",
            "Summarize my unread mail",
        ] {
            XCTAssertTrue(TaskTakingSpeechPolicy.isGmailReadRequest(transcript), transcript)
            XCTAssertFalse(TaskTakingSpeechPolicy.requiresAssistantTask(transcript, gmailReadsEnabled: true), transcript)
        }
        // The existing routing is unchanged when private reads are disabled.
        XCTAssertTrue(TaskTakingSpeechPolicy.requiresAssistantTask("Codex, find my email from Sam"))
    }

    func testEmailRoutingDoesNotChangeAttentionBehavior() {
        var gate = AddressedSpeechGate()
        let request = "Codex, find my email from Sam"
        XCTAssertTrue(gate.decide(transcript: request, conversationCoachEnabled: true).shouldRespond)
        XCTAssertFalse(TaskTakingSpeechPolicy.requiresAssistantTask(request, gmailReadsEnabled: true))
        XCTAssertFalse(gate.decide(transcript: "I was telling him to check my email", conversationCoachEnabled: false).shouldRespond)
    }

    func testMailboxMentionDoesNotHijackComputerTasksOrWrites() {
        for transcript in [
            "Codex, open Gmail",
            "Codex, find a file about email",
            "Codex, read my email on the screen",
            "Codex, find my email and download the attachment",
            "Codex, search my mail and send a reply",
            "Codex, read my email then run the tests",
            "Can you explain how email works?",
            "I was telling him to check my email",
        ] {
            XCTAssertFalse(TaskTakingSpeechPolicy.isGmailReadRequest(transcript), transcript)
            XCTAssertEqual(
                TaskTakingSpeechPolicy.requiresAssistantTask(transcript, gmailReadsEnabled: true),
                TaskTakingSpeechPolicy.requiresAssistantTask(transcript), transcript
            )
        }
    }

    func testEmailToolsAreAbsentFromDefaultSurface() {
        XCTAssertFalse(CodexLensTools.all.contains { $0.name == "search_gmail" || $0.name == "read_gmail" })
        XCTAssertEqual(CodexLensTools.gmailReads.map(\.name), ["search_gmail", "read_gmail"])
        XCTAssertTrue(CodexLensTools.gmailReads.allSatisfy { !$0.name.contains("send") })
    }

    func testReadUsesAuthenticatedBodyAndPreservesPreviewLabel() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data(#"{"id":"one","text":"Short preview","contentKind":"preview-only","untrustedContent":true}"#.utf8))
        }
        let client = GatewayClient(configuration: .init(baseURL: URL(string: "https://gateway.example")!, tokenProvider: { "fixture-token" }), transport: transport)
        let result = try await client.readGmail(messageId: "one")
        XCTAssertEqual(result.string("contentKind"), "preview-only")
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/gmail/read")
        XCTAssertEqual(transport.lastRequest?.httpMethod, "POST")
        XCTAssertNil(transport.lastRequest?.url?.query)
        XCTAssertEqual(transport.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
    }
    func testStartsWithSelectedCapabilitiesAndGatewayAuth() async throws {
        let transport = StubTransport { _ in
            .init(status: 202, body: Data(#"{"id":"one","status":"authorizing","authorizationURL":"https://accounts.google.com/o/oauth2/v2/auth?state=fixture","openOn":"gateway-mac"}"#.utf8))
        }
        let client = GatewayClient(configuration: .init(baseURL: URL(string: "https://gateway.example")!, tokenProvider: { "fixture-token" }), transport: transport)
        let result = try await client.beginGmailConnection(features: ["read"])
        XCTAssertEqual(result.openOn, "gateway-mac")
        XCTAssertEqual(transport.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(transport.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
        let body = try JSONSerialization.jsonObject(with: transport.lastRequest!.httpBody!) as? [String: [String]]
        XCTAssertEqual(body, ["features": ["read"]])
    }

    func testRejectsUntrustedSignInDestination() async throws {
        let transport = StubTransport { _ in
            .init(status: 202, body: Data(#"{"id":"one","status":"authorizing","authorizationURL":"https://attacker.example/","openOn":"gateway-mac"}"#.utf8))
        }
        let client = GatewayClient(configuration: .init(baseURL: URL(string: "https://gateway.example")!, tokenProvider: { "fixture-token" }), transport: transport)
        do {
            _ = try await client.beginGmailConnection(features: ["read"])
            XCTFail("An arbitrary sign-in host must not be accepted")
        } catch { XCTAssertTrue(error is GatewayError) }
    }

    func testLocalDisconnectDoesNotClaimGoogleRevocation() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data(#"{"status":"disconnected","googleAccessRevoked":false}"#.utf8))
        }
        let client = GatewayClient(configuration: .init(baseURL: URL(string: "https://gateway.example")!, tokenProvider: { "fixture-token" }), transport: transport)
        let result = try await client.disconnectGmail()
        XCTAssertFalse(result.googleAccessRevoked)
        XCTAssertEqual(transport.lastRequest?.httpMethod, "DELETE")
    }
}
