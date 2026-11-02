import Foundation
import XCTest
@testable import CodexLensKit

final class AssistantTaskProgressTests: XCTestCase {
    private func status(_ state: String, id: String = "task-1", at: String = "2026-11-01T17:00:00.000Z", failure: String? = nil) throws -> AssistantTaskStatus {
        var json = ["taskId": id, "instruction": "Open Calculator", "scope": "mac",
                    "state": state, "model": "test", "reasoningEffort": "medium",
                    "preparedAt": "2026-11-01T16:59:00.000Z", "expiresAt": "2026-11-01T17:09:00.000Z", "updatedAt": at]
        json["failureCode"] = failure
        return try JSONDecoder().decode(AssistantTaskStatus.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testStopRequestWaitsForWorkerConfirmation() throws {
        var progress = AssistantTaskProgress(taskID: "task-1")
        progress.observe(try status("running"))
        XCTAssertTrue(progress.requestStop())
        XCTAssertFalse(progress.requestStop())
        progress.observe(try status("running", at: "2026-11-01T17:00:01.000Z"))
        XCTAssertTrue(progress.isStopping)
        XCTAssertEqual(progress.title, "Stopping Codex…")
        progress.observe(try status("cancelled", at: "2026-11-01T17:00:02.000Z"))
        XCTAssertFalse(progress.isStopping)
        XCTAssertFalse(progress.canStop)
        XCTAssertEqual(progress.title, "Codex stopped")
    }

    func testDisconnectedMacDoesNotBecomeStoppedOrFailed() throws {
        var progress = AssistantTaskProgress(taskID: "task-1")
        progress.observe(try status("running"))
        progress.connectionFailed("Connection interrupted")
        XCTAssertEqual(progress.status?.state, .running)
        XCTAssertEqual(progress.title, "Checking the Mac…")
        XCTAssertTrue(progress.canStop)
        progress.observe(try status("running", at: "2026-11-01T17:00:01.000Z"))
        XCTAssertNil(progress.connectionNotice)
    }

    func testLatePollCannotUndoCompletedCancellationResponse() throws {
        var progress = AssistantTaskProgress(taskID: "task-1")
        progress.observe(try status("completed"))
        XCTAssertFalse(progress.observe(try status("running", at: "2026-11-01T17:00:01.000Z")))
        XCTAssertEqual(progress.status?.state, .completed)
    }

    func testWrongTaskAndOlderReadAreIgnored() throws {
        var progress = AssistantTaskProgress(taskID: "task-1")
        progress.observe(try status("running", at: "2026-11-01T17:00:00.500Z"))
        XCTAssertFalse(progress.observe(try status("completed", id: "different-task")))
        XCTAssertFalse(progress.observe(try status("prepared", at: "2026-11-01T17:00:00Z")))
        XCTAssertEqual(progress.status?.state, .running)
    }

    func testFailedStopDoesNotClaimCancellation() throws {
        var progress = AssistantTaskProgress(taskID: "task-1")
        progress.observe(try status("running"))
        progress.requestStop()
        progress.stopUnconfirmed()
        XCTAssertEqual(progress.status?.state, .running)
        XCTAssertTrue(progress.canStop)
        XCTAssertNotNil(progress.connectionNotice)
    }

    func testUnconfirmedStartRequiresOutcomeReconciliation() throws {
        XCTAssertTrue(try status("failed", failure: "ASSISTANT_TASK_START_OUTCOME_UNCONFIRMED").requiresOutcomeReconciliation)
    }
}
