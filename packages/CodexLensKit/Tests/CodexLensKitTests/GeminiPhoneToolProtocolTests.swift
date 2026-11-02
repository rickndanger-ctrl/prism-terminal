import XCTest
@testable import CodexLensKit

final class GeminiPhoneToolProtocolTests: XCTestCase {
    func testTaskPreparationCannotSupplyTextAndIsNotAbandonedLikeARead() {
        for scope in ["mac", "project"] {
            XCTAssertTrue(GeminiPhoneToolProtocol.supports(name: "prepare_assistant_task", arguments: .object(["scope": .string(scope)])))
        }
        XCTAssertFalse(GeminiPhoneToolProtocol.supports(name: "prepare_assistant_task", arguments: .object(["scope": .string("all")])))
        XCTAssertFalse(GeminiPhoneToolProtocol.supports(name: "prepare_assistant_task", arguments: .object(["scope": .string("mac"), "instruction": .string("invented")])))
        XCTAssertFalse(GeminiPhoneToolProtocol.abandonsOnInterruption(name: "prepare_assistant_task"))
        XCTAssertTrue(GeminiPhoneToolProtocol.abandonsOnInterruption(name: "get_assistant_task_status"))
        XCTAssertFalse(GeminiPhoneToolProtocol.supports(name: "start_prepared_assistant_task", arguments: .object([:])))
    }
    func testTaskStatusUsesOnlyPhoneOwnedIdentity() {
        XCTAssertTrue(GeminiPhoneToolProtocol.supports(name: "get_assistant_task_status", arguments: .object([:])))
        XCTAssertFalse(GeminiPhoneToolProtocol.supports(name: "get_assistant_task_status", arguments: .object(["taskId": .string("another-job")])))
        XCTAssertFalse(GeminiPhoneToolProtocol.supports(name: "get_assistant_task_status", arguments: .object(["start": .bool(true)])))
    }
    func testOnlySupportedInformationalToolsPassStrictArguments() {
        XCTAssertTrue(GeminiPhoneToolProtocol.supports(name: "get_current_time", arguments: .object([:])))
        XCTAssertFalse(GeminiPhoneToolProtocol.supports(name: "get_current_time", arguments: .object(["question": .string("time") ])))
        for name in ["research_web", "reason_question"] {
            XCTAssertTrue(GeminiPhoneToolProtocol.supports(name: name, arguments: .object(["question": .string("What is seven times eight?")])))
            for question in [" ", "a", String(repeating: "x", count: 1001)] {
                XCTAssertFalse(GeminiPhoneToolProtocol.supports(name: name, arguments: .object(["question": .string(question)])))
            }
            XCTAssertFalse(GeminiPhoneToolProtocol.supports(name: name, arguments: .object(["question": .string("test"), "command": .string("run") ])))
        }
        for name in ["prepare_assistant_task", "capture_glasses_view", "send_text_message", "unknown"] {
            XCTAssertFalse(GeminiPhoneToolProtocol.supports(name: name, arguments: .object([:])))
        }
    }

    func testDecodesGatewayRequestWithBoundSourceAndEncodesCorrelatedResult() throws {
        let requestID = UUID(), turnID = UUID()
        let data = try JSONSerialization.data(withJSONObject: ["type": "gemini.toolCall",
            "requestId": requestID.uuidString, "turnId": turnID.uuidString,
            "name": "get_current_time", "arguments": [:], "transcript": "What time is it?"] as [String: Any])
        guard case .request(let request) = try GeminiPhoneToolProtocol.decode(data) else { return XCTFail("Missing request") }
        XCTAssertEqual(request.requestID, requestID)
        XCTAssertEqual(request.turnID, turnID)
        XCTAssertEqual(request.arguments, .object([:]))
        let reply = try GeminiPhoneToolProtocol.encodeResult(requestID: requestID, turnID: turnID, output: .object(["localDateTime": .string("12:30")]))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: reply) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "gemini.toolResult")
        XCTAssertEqual(object["requestId"] as? String, requestID.uuidString.lowercased())
        XCTAssertEqual(object["turnId"] as? String, turnID.uuidString.lowercased())
    }

    func testCancellationCannotSmuggleArguments() throws {
        let requestID = UUID(), turnID = UUID()
        var object: [String: Any] = ["type": "gemini.toolCancelled", "requestId": requestID.uuidString, "turnId": turnID.uuidString]
        XCTAssertEqual(try GeminiPhoneToolProtocol.decode(JSONSerialization.data(withJSONObject: object)), .cancelled(requestID: requestID, turnID: turnID))
        object["arguments"] = ["run": "anything"]
        XCTAssertThrowsError(try GeminiPhoneToolProtocol.decode(JSONSerialization.data(withJSONObject: object)))
    }

    func testRejectsUnboundMalformedAndOversizedMessages() throws {
        for data in [Data("{}".utf8), Data("[]".utf8), Data(repeating: 0, count: 32769)] {
            XCTAssertThrowsError(try GeminiPhoneToolProtocol.decode(data))
        }
        XCTAssertThrowsError(try GeminiPhoneToolProtocol.encodeResult(requestID: UUID(), turnID: UUID(), output: .string(String(repeating: "x", count: 65536))))
    }
}
