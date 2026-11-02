import XCTest
@testable import CodexLensKit

final class RealtimeProviderIdentityTests: XCTestCase {
    func testGeminiRequiresBothExplicitModelAndGatewaySignaling() {
        let endpoint = URL(string: "https://gateway.test/v1/realtime/gemini/calls")!
        XCTAssertTrue(RealtimeCredential(value: "test", expiresAt: "", model: GeminiGatewayProtocol.model, signalingURL: endpoint).usesGeminiGatewayProtocol)
        XCTAssertFalse(RealtimeCredential(value: "test", expiresAt: "", model: GeminiGatewayProtocol.model).usesGeminiGatewayProtocol)
        for model in ["huggingface", "gpt-realtime-2.1", "unknown"] {
            XCTAssertFalse(RealtimeCredential(value: "test", expiresAt: "", model: model, signalingURL: endpoint).usesGeminiGatewayProtocol)
        }
    }
    func testGatewayEndpointDoesNotImplyHuggingFace() {
        let endpoint = URL(string: "https://gateway.test/v1/realtime/gemini/calls")!
        for model in ["gemini-3.1-flash-live-preview", "gpt-realtime-2.1", "unknown"] {
            let credential = RealtimeCredential(value: "test", expiresAt: "", model: model, signalingURL: endpoint)
            XCTAssertFalse(credential.usesHuggingFaceProtocol)
        }
    }

    func testExistingHuggingFaceRouteKeepsItsProtocol() {
        let endpoint = URL(string: "https://gateway.test/v1/realtime/huggingface/calls")!
        XCTAssertTrue(RealtimeCredential(value: "test", expiresAt: "", model: "huggingface", signalingURL: endpoint).usesHuggingFaceProtocol)
        XCTAssertFalse(RealtimeCredential(value: "test", expiresAt: "", model: "huggingface").usesHuggingFaceProtocol)
    }
}
