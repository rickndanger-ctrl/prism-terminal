import XCTest
@testable import CodexLensKit

/// Decodes the exact JSON the gateway emits (see docs/M4.md) into the wire
/// types, so a drift between gateway and phone fails here.
final class ModelTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testDecodesRealtimeCredential() throws {
        let json = Data("""
        {
          "value": "ek_abc",
          "expiresAt": "2026-07-16T12:00:00.000Z",
          "model": "gpt-realtime",
          "sessionId": "sess_1"
        }
        """.utf8)

        let credential = try decoder.decode(RealtimeCredential.self, from: json)
        XCTAssertEqual(credential.value, "ek_abc")
        XCTAssertEqual(credential.model, "gpt-realtime")
        XCTAssertEqual(credential.sessionId, "sess_1")
        XCTAssertNotNil(credential.expiresAtDate)
    }

    func testDecodesRealtimeCredentialWithoutSessionId() throws {
        let json = Data("""
        { "value": "ek_x", "expiresAt": "2026-07-16T12:00:00.000Z", "model": "gpt-realtime" }
        """.utf8)
        let credential = try decoder.decode(RealtimeCredential.self, from: json)
        XCTAssertNil(credential.sessionId)
    }

    func testDecodesTaskEventsPageWithNestedPayload() throws {
        let json = Data("""
        {
          "events": [
            {
              "id": "evt_0",
              "taskId": "task_1",
              "seq": 0,
              "type": "queued",
              "payload": {},
              "createdAt": "2026-07-16T00:00:00.000Z"
            },
            {
              "id": "evt_1",
              "taskId": "task_1",
              "seq": 1,
              "type": "log",
              "payload": { "line": "running tests", "count": 2 },
              "createdAt": "2026-07-16T00:00:01.000Z"
            }
          ],
          "nextCursor": 1
        }
        """.utf8)

        let page = try decoder.decode(TaskEventsPage.self, from: json)
        XCTAssertEqual(page.nextCursor, 1)
        XCTAssertEqual(page.events.count, 2)
        XCTAssertEqual(page.events[0].type, .queued)
        XCTAssertEqual(page.events[1].payload.string("line"), "running tests")
        XCTAssertFalse(page.events[0].type.isTerminal)
    }

    func testTaskTerminalStates() {
        XCTAssertTrue(TaskState.complete.isTerminal)
        XCTAssertTrue(TaskState.failed.isTerminal)
        XCTAssertFalse(TaskState.running.isTerminal)
        XCTAssertTrue(TaskEventType.complete.isTerminal)
        XCTAssertFalse(TaskEventType.running.isTerminal)
    }

    func testJSONValueRoundTrips() throws {
        let value: JSONValue = .object([
            "s": .string("x"),
            "n": .number(3),
            "b": .bool(true),
            "z": .null,
            "arr": .array([.number(1), .string("two")]),
        ])
        let data = try JSONEncoder().encode(value)
        let back = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(value, back)
    }

    func testOutboundMessageRoundTrips() throws {
        let messages: [RealtimeOutboundMessage] = [
            .userText("approved"),
            .toolResult(callId: "call_1", output: .object(["ok": .bool(true)])),
            .speakExact("Got it, I'm doing that now."),
        ]
        for message in messages {
            let data = try JSONEncoder().encode(message)
            let back = try JSONDecoder().decode(RealtimeOutboundMessage.self, from: data)
            XCTAssertEqual(message, back)
        }
    }

    func testToolDefinitionsEncodeAsFunctions() throws {
        let data = try JSONEncoder().encode(CodexLensTools.inspectMacApp)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["type"] as? String, "function")
        XCTAssertEqual(object?["name"] as? String, "inspect_mac_app")
        XCTAssertEqual(CodexLensTools.all.count, 18)
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "list_lens_personal_items" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "clarify_personal_item" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "save_personal_item" })
        XCTAssertEqual(CodexLensTools.researchWeb.name, "research_web")
        XCTAssertEqual(CodexLensTools.reasonQuestion.name, "reason_question")
        XCTAssertEqual(CodexLensTools.getFrontmostMacApp.name, "get_frontmost_mac_app")
        XCTAssertEqual(CodexLensTools.focusMacApp.name, "focus_mac_app")
        XCTAssertEqual(CodexLensTools.closeFrontmostMacWindow.name, "close_frontmost_mac_window")
        XCTAssertEqual(CodexLensTools.setFrontmostMacWindowState.name, "set_frontmost_mac_window_state")
        XCTAssertEqual(CodexLensTools.inspectMacApp.name, "inspect_mac_app")
        XCTAssertEqual(CodexLensTools.inspectCodexProject.name, "inspect_codex_project")
        XCTAssertEqual(CodexLensTools.useMacComputer.name, "use_mac_computer")
        XCTAssertEqual(CodexLensTools.prepareMacComputerAction.name, "prepare_mac_computer_action")
        XCTAssertFalse(CodexLensTools.all.contains { $0.name == "use_mac_computer" })
        XCTAssertFalse(CodexLensTools.all.contains { $0.name == "prepare_mac_computer_action" })
        XCTAssertFalse(CodexLensTools.all.contains { $0.name == "execute_prepared_mac_action" })
        XCTAssertTrue(CodexLensTools.useMacComputer.description.contains("Never call this tool"))
        XCTAssertFalse(CodexLensTools.focusMacApp.description.contains("use_mac_computer"))
        XCTAssertTrue(CodexLensTools.prepareMacComputerAction.description.contains("Legacy preparation tool"))
        XCTAssertEqual(CodexLensTools.executePreparedMacAction.name, "execute_prepared_mac_action")
        XCTAssertEqual(CodexLensTools.prepareAssistantTask.name, "prepare_assistant_task")
        XCTAssertEqual(CodexLensTools.startPreparedAssistantTask.name, "start_prepared_assistant_task")
        XCTAssertTrue(CodexLensTools.prepareAssistantTask.description.contains("phone ignores any model-authored task text"))
        XCTAssertTrue(CodexLensTools.prepareAssistantTask.description.contains("Ordinary tasks start immediately"))
        XCTAssertTrue(CodexLensTools.prepareAssistantTask.description.contains("Codex, confirm"))
        XCTAssertTrue(CodexLensTools.startPreparedAssistantTask.description.contains("Codex, confirm"))
        XCTAssertEqual(CodexLensTools.getAssistantTaskStatus.name, "get_assistant_task_status")
        XCTAssertEqual(CodexLensTools.cancelAssistantTask.name, "cancel_assistant_task")
        XCTAssertEqual(CodexLensTools.reconcileLastAssistantTask.name, "reconcile_last_assistant_task")
        XCTAssertTrue(CodexLensTools.reconcileLastAssistantTask.description.contains("Codex, clear task lock"))
        XCTAssertEqual(CodexLensTools.captureGlassesView.name, "capture_glasses_view")
        XCTAssertEqual(CodexLensTools.prepareTextMessage.name, "prepare_text_message")
        XCTAssertEqual(CodexLensTools.sendPreparedText.name, "send_prepared_text")
        XCTAssertEqual(CodexLensTools.getLastTextMessageStatus.name, "get_last_text_message_status")
        XCTAssertEqual(CodexLensTools.getCurrentTime.name, "get_current_time")
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "get_current_time" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "research_web" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "reason_question" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "get_frontmost_mac_app" })
        XCTAssertFalse(CodexLensTools.all.contains { $0.name == "focus_mac_app" })
        XCTAssertFalse(CodexLensTools.all.contains { $0.name == "close_frontmost_mac_window" })
        XCTAssertFalse(CodexLensTools.all.contains { $0.name == "set_frontmost_mac_window_state" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "inspect_codex_project" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "prepare_assistant_task" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "start_prepared_assistant_task" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "get_assistant_task_status" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "cancel_assistant_task" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "reconcile_last_assistant_task" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "prepare_text_message" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "send_prepared_text" })
        XCTAssertTrue(CodexLensTools.all.contains { $0.name == "get_last_text_message_status" })
    }

    func testAssistantTaskReconciliationEligibilityIsLimitedToUnknownOutcomeFailures() throws {
        let uncertainCodes = [
            "GATEWAY_RESTART_OUTCOME_UNCERTAIN",
            "ASSISTANT_TASK_CANCEL_UNCONFIRMED",
            "ASSISTANT_TASK_TIMEOUT_UNCONFIRMED",
            "ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED",
        ]
        for failureCode in uncertainCodes {
            let status = try decodeAssistantTaskStatus(
                state: "failed",
                failureCode: failureCode
            )
            XCTAssertTrue(status.requiresOutcomeReconciliation, failureCode)
        }

        XCTAssertFalse(try decodeAssistantTaskStatus(
            state: "failed",
            failureCode: "ASSISTANT_TASK_OUTCOME_RECONCILED"
        ).requiresOutcomeReconciliation)
        XCTAssertFalse(try decodeAssistantTaskStatus(
            state: "completed",
            failureCode: "ASSISTANT_TASK_CANCEL_UNCONFIRMED"
        ).requiresOutcomeReconciliation)
        XCTAssertFalse(try decodeAssistantTaskStatus(
            state: "failed",
            failureCode: "ASSISTANT_TASK_CANCEL_UNCONFIRMED",
            reconciled: true
        ).requiresOutcomeReconciliation)
    }

    private func decodeAssistantTaskStatus(
        state: String,
        failureCode: String,
        reconciled: Bool = false
    ) throws -> AssistantTaskStatus {
        try decoder.decode(AssistantTaskStatus.self, from: Data("""
        {
          "taskId": "assistant-1", "instruction": "Inspect the build.",
          "scope": "mac", "state": "\(state)",
          "model": "gpt-5.6-sol", "reasoningEffort": "medium",
          "preparedAt": "2026-09-02T20:00:00.000Z",
          "expiresAt": "2026-09-02T20:05:00.000Z",
          "updatedAt": "2026-09-02T20:01:00.000Z",
          "summary": "Unknown outcome.", "failureCode": "\(failureCode)",
          "reconciledAt": \(reconciled ? "\"2026-09-02T20:02:00.000Z\"" : "null")
        }
        """.utf8))
    }
}
