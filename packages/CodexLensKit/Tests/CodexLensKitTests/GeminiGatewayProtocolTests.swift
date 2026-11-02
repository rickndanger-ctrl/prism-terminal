import XCTest
@testable import CodexLensKit

final class GeminiGatewayProtocolTests: XCTestCase {
    private let id = UUID(uuidString: "5d09a69d-908c-46d7-a626-cb494bdc10db")!

    func testNativeEventsHaveExplicitTurnIdentity() throws {
        let events: [(String, GeminiGatewayEvent)] = [
            ("gemini.activityStarted", .activityStarted(id)),
            ("gemini.turnComplete", .turnComplete(id)),
            ("gemini.responseSuppressed", .responseSuppressed(id)),
        ]
        for (type, expected) in events {
            let data = try JSONSerialization.data(withJSONObject: ["type": type, "turnId": id.uuidString])
            XCTAssertEqual(try GeminiGatewayProtocol.decode(data), expected)
        }
        for (type, expected) in [
            ("gemini.acceptedUtterance", GeminiGatewayEvent.acceptedUtterance(turnID: id, text: "Codex, what time is it?")),
            ("gemini.inputTranscript", GeminiGatewayEvent.inputTranscript(turnID: id, text: "Codex, what time is it?")),
            ("gemini.outputTranscript", GeminiGatewayEvent.outputTranscript(turnID: id, text: "Codex, what time is it?")),
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["type": type, "turnId": id.uuidString, "text": "Codex, what time is it?"])
            XCTAssertEqual(try GeminiGatewayProtocol.decode(data), expected)
        }
    }

    func testReadyAndPlaybackClearAreNotOpenAIEvents() throws {
        XCTAssertEqual(try GeminiGatewayProtocol.decode(Data(#"{"type":"gemini.ready"}"#.utf8)), .ready)
        XCTAssertEqual(try GeminiGatewayProtocol.decode(Data(#"{"type":"gemini.clearAudio"}"#.utf8)), .clearAudio)
        XCTAssertThrowsError(try GeminiGatewayProtocol.decode(Data(#"{"type":"session.updated"}"#.utf8)))
    }

    func testActivityEndRequiresKnownReasonAndTurnIdentity() throws {
        for reason in [GeminiActivityEndReason.manual, .silence, .limit] {
            let data = try JSONSerialization.data(withJSONObject: ["type": "gemini.activityEnded", "turnId": id.uuidString, "reason": reason.rawValue])
            XCTAssertEqual(try GeminiGatewayProtocol.decode(data), .activityEnded(turnID: id, reason: reason))
        }
        for reason in ["", "finished", "allow"] {
            let data = try JSONSerialization.data(withJSONObject: ["type": "gemini.activityEnded", "turnId": id.uuidString, "reason": reason])
            XCTAssertThrowsError(try GeminiGatewayProtocol.decode(data))
        }
    }

    func testRejectsUnboundTranscriptsExtraFieldsAndOversizedFrames() throws {
        for raw in [
            #"{"type":"gemini.inputTranscript","text":"missing ID"}"#,
            #"{"type":"gemini.ready","allow":true}"#,
            #"{"type":"gemini.activityStarted","turnId":"not-an-id"}"#,
            #"{"type":"gemini.turnComplete","turnId":23}"#,
            "[]", String(repeating: "x", count: 65_537),
        ] {
            XCTAssertThrowsError(try GeminiGatewayProtocol.decode(Data(raw.utf8)))
        }
    }

    func testControlEncodingHasOnlyHostPolicyDecisionOrStop() throws {
        let data = try GeminiPhoneControl.responseDecision(turnID: id, allow: false).encoded()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["type", "turnId", "allow"])
        XCTAssertEqual(object["type"] as? String, "gemini.decideResponse")
        XCTAssertEqual(object["turnId"] as? String, id.uuidString.lowercased())
        XCTAssertEqual(object["allow"] as? Bool, false)
        XCTAssertEqual(String(data: try GeminiPhoneControl.stop.encoded(), encoding: .utf8), #"{"type":"gemini.stop"}"#)
    }
}
