import XCTest
@testable import CodexLensKit

final class GptLiveProtocolTests: XCTestCase {
    private func frame(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testDecodesLifecycleTranscriptAndErrorEvents() throws {
        XCTAssertEqual(try GptLiveProtocol.decode(frame(["type": "session.started", "session": ["id": "live_1"]])), .started)
        XCTAssertEqual(try GptLiveProtocol.decode(frame(["type": "session.closed", "reason": "expired"])), .closed(reason: "expired"))
        XCTAssertEqual(
            try GptLiveProtocol.decode(frame(["type": "session.input_transcript.delta", "delta": "what time", "start_ms": 0, "end_ms": 400])),
            .inputTranscript("what time")
        )
        XCTAssertEqual(
            try GptLiveProtocol.decode(frame(["type": "session.output_transcript.delta", "delta": "It's two."])),
            .outputTranscript("It's two.")
        )
        XCTAssertEqual(
            try GptLiveProtocol.decode(frame(["type": "session.delegation.created",
                                              "delegation": ["id": "item_1", "type": "delegation", "target": "responses"]])),
            .delegationStarted(id: "item_1")
        )
        XCTAssertEqual(try GptLiveProtocol.decode(frame(["type": "session.usage.updated", "voice_seconds": 12])), .ignored)
        XCTAssertEqual(
            try GptLiveProtocol.decode(frame(["type": "error", "code": "rate_limited", "message": "Slow down"])),
            .error(code: "rate_limited", message: "Slow down")
        )
    }

    func testDecodesDelegatedFunctionCallInsideResponseEnvelope() throws {
        let call = try GptLiveProtocol.decode(frame([
            "type": "response.event",
            "delegation_id": "item_1",
            "event": [
                "type": "response.output_item.done",
                "item": ["type": "function_call", "call_id": "call_1", "name": "get_assistant_task_status",
                         "arguments": #"{"taskId":"task-7"}"#],
            ],
        ]))
        XCTAssertEqual(call, .toolCall(callID: "call_1", name: "get_assistant_task_status",
                                       arguments: .object(["taskId": .string("task-7")])))
        let text = try GptLiveProtocol.decode(frame([
            "type": "response.event",
            "delegation_id": "item_1",
            "event": ["type": "response.output_text.delta", "delta": "Checking"],
        ]))
        XCTAssertEqual(text, .ignored)
    }

    func testRejectsOnlyUnreadableFrames() throws {
        for data in [Data("not json".utf8), try frame(["delta": "no type"])] {
            XCTAssertThrowsError(try GptLiveProtocol.decode(data))
        }
    }

    func testIgnoresRecognizedEventsItCannotActuponRatherThanFailing() throws {
        // A provider shape this phone cannot read must never drop a working session.
        let ignored: [Data] = [
            try frame(["type": "session.output_transcript.delta"]),
            try frame(["type": "session.delegation.created", "delegation": [String: Any]()]),
            try frame(["type": "response.event", "delegation_id": "item_1"]),
            try frame(["type": "response.event", "event": ["type": "response.output_item.done",
                "item": ["type": "function_call", "call_id": "call_1", "name": "get_current_time", "arguments": "{"]]]),
            try frame(["type": "response.event", "event": ["type": "response.output_item.done",
                "item": ["type": "function_call", "call_id": "call_1", "name": "Bad Name", "arguments": "{}"]]]),
        ]
        for data in ignored {
            XCTAssertEqual(try GptLiveProtocol.decode(data), .ignored)
        }
    }

    func testAllowsOnlyBoundedPhoneTools() {
        XCTAssertTrue(GptLiveProtocol.supports(name: "get_current_time", arguments: .object([:])))
        XCTAssertFalse(GptLiveProtocol.supports(name: "get_current_time", arguments: .object(["zone": .string("UTC")])))
        XCTAssertTrue(GptLiveProtocol.supports(name: "get_assistant_task_status", arguments: .object([:])))
        XCTAssertTrue(GptLiveProtocol.supports(name: "get_assistant_task_status", arguments: .object(["taskId": .string("task-7")])))
        XCTAssertFalse(GptLiveProtocol.supports(name: "get_assistant_task_status", arguments: .object(["taskId": .bool(true)])))
        XCTAssertTrue(GptLiveProtocol.supports(name: "cancel_assistant_task", arguments: .object([:])))
        XCTAssertTrue(GptLiveProtocol.supports(name: "get_frontmost_mac_app", arguments: .object([:])))

        let question: [String: JSONValue] = ["question": .string("What does this function do?")]
        for name in ["research_web", "reason_question", "inspect_codex_project"] {
            XCTAssertTrue(GptLiveProtocol.supports(name: name, arguments: .object(question)), name)
            XCTAssertFalse(GptLiveProtocol.supports(name: name, arguments: .object(["question": .string("")])), name)
            XCTAssertFalse(GptLiveProtocol.supports(name: name, arguments: .object([:])), name)
        }
        XCTAssertTrue(GptLiveProtocol.supports(name: "inspect_mac_app",
                                               arguments: .object(["app": .string("Xcode"), "question": .string("What error is shown?")])))
        XCTAssertFalse(GptLiveProtocol.supports(name: "inspect_mac_app", arguments: .object(["app": .string("Xcode")])))

        XCTAssertTrue(GptLiveProtocol.supports(name: "capture_glasses_view", arguments: .object(["request": .string("Read this screen")])))
        XCTAssertTrue(GptLiveProtocol.supports(name: "capture_glasses_view",
                                               arguments: .object(["request": .string("Read this screen"), "mode": .string("read")])))
        XCTAssertFalse(GptLiveProtocol.supports(name: "capture_glasses_view",
                                                arguments: .object(["request": .string("Record this"), "mode": .string("video")])))
        XCTAssertFalse(GptLiveProtocol.supports(name: "capture_glasses_view", arguments: .object(["mode": .string("read")])))

        let task: [String: JSONValue] = ["instruction": .string("Open Safari"), "scope": .string("mac")]
        XCTAssertTrue(GptLiveProtocol.supports(name: "prepare_assistant_task", arguments: .object(task)))
        XCTAssertFalse(GptLiveProtocol.supports(name: "prepare_assistant_task", arguments: .object(["instruction": .string("Open Safari")])))
        XCTAssertFalse(GptLiveProtocol.supports(name: "prepare_assistant_task",
                                                arguments: .object(["instruction": .string("Open Safari"), "scope": .string("root")])))
        XCTAssertFalse(GptLiveProtocol.supports(name: "prepare_assistant_task",
                                                arguments: .object(task.merging(["projectId": .string("p")]) { $1 })))

        let digest = String(repeating: "a", count: 64)
        XCTAssertTrue(GptLiveProtocol.supports(name: "start_prepared_assistant_task",
                                               arguments: .object(["confirmationId": .string("c1"), "digest": .string(digest)])))
        XCTAssertFalse(GptLiveProtocol.supports(name: "start_prepared_assistant_task",
                                                arguments: .object(["confirmationId": .string("c1"), "digest": .string("not-a-digest")])))

        for name in ["prepare_text_message", "send_prepared_text", "use_mac_computer", "execute_prepared_mac_action",
                     "capture_glasses_view", "prepare_gmail_write"] {
            XCTAssertFalse(GptLiveProtocol.supports(name: name, arguments: .object([:])), name)
        }
    }

    func testCommentaryIsSessionWide() throws {
        let commentary = try object(GptLiveProtocol.encodeCommentary("Nothing was sent."))
        XCTAssertEqual(commentary["type"] as? String, "session.commentary.append")
        XCTAssertEqual(commentary["content"] as? String, "Nothing was sent.")
        XCTAssertTrue(commentary["delegation_id"] is NSNull)
    }

    func testToolResultSubmitsOutputThenContinuesBackend() throws {
        let frames = try GptLiveProtocol.encodeToolResult(callID: "call_1", output: .object(["time": .string("2:00 PM")]))
        XCTAssertEqual(frames.count, 2)
        let item = try object(frames[0])
        XCTAssertEqual(item["type"] as? String, "response.item.create")
        let payload = try XCTUnwrap(item["item"] as? [String: Any])
        XCTAssertEqual(payload["type"] as? String, "function_call_output")
        XCTAssertEqual(payload["call_id"] as? String, "call_1")
        let output = try XCTUnwrap(payload["output"] as? String)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: Data(output.utf8)), .object(["time": .string("2:00 PM")]))
        let create = try object(frames[1])
        XCTAssertEqual(create["type"] as? String, "response.create")
        XCTAssertNotEqual(item["event_id"] as? String, create["event_id"] as? String)
    }

    func testGlassesPhotosAreSentAsImageItemsThenOneContinuation() throws {
        let frames = try GptLiveProtocol.encodeUserImages(
            [Data("first".utf8), Data("second".utf8)],
            instruction: "Read this screen.",
            detail: "high"
        )
        XCTAssertEqual(frames.count, 3)
        let first = try object(frames[0])
        XCTAssertEqual(first["type"] as? String, "response.item.create")
        let content = try XCTUnwrap((first["item"] as? [String: Any])?["content"] as? [[String: Any]])
        XCTAssertEqual(content.first?["text"] as? String, "Read this screen.")
        XCTAssertEqual(content.last?["type"] as? String, "input_image")
        XCTAssertEqual(content.last?["detail"] as? String, "high")
        XCTAssertEqual(content.last?["image_url"] as? String, "data:image/jpeg;base64,\(Data("first".utf8).base64EncodedString())")

        // Only the first item carries the instruction; the last frame asks for the answer.
        let second = try XCTUnwrap((try object(frames[1])["item"] as? [String: Any])?["content"] as? [[String: Any]])
        XCTAssertEqual(second.count, 1)
        XCTAssertEqual(try object(frames[2])["type"] as? String, "response.create")
        XCTAssertEqual(try GptLiveProtocol.encodeUserImages([], instruction: "x", detail: "low").count, 0)
    }

    func testTypedTextAndGracefulClose() throws {
        let frames = try GptLiveProtocol.encodeUserText("What's the weather?")
        let payload = try XCTUnwrap(try object(frames[0])["item"] as? [String: Any])
        XCTAssertEqual(payload["role"] as? String, "user")
        let content = try XCTUnwrap(payload["content"] as? [[String: Any]])
        XCTAssertEqual(content.first?["text"] as? String, "What's the weather?")
        XCTAssertEqual(try object(frames[1])["type"] as? String, "response.create")
        XCTAssertEqual(try object(GptLiveProtocol.encodeClose())["type"] as? String, "session.close")
    }
}
