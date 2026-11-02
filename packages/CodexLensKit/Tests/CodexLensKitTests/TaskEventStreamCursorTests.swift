import XCTest
@testable import CodexLensKit

final class TaskEventStreamCursorTests: XCTestCase {
    private func event(_ seq: Int, _ type: TaskEventType = .log) -> TaskEvent {
        TaskEvent(
            id: "evt_\(seq)", taskId: "task_1", seq: seq, type: type,
            payload: .object([:]), createdAt: "2026-07-16T00:00:00.000Z"
        )
    }

    func testStartsWantingTheWholeLog() {
        let cursor = TaskEventStreamCursor()
        XCTAssertEqual(cursor.cursor, -1)
        XCTAssertNil(cursor.nextAfter, "no cursor yet → fetch the backlog")
    }

    func testIngestReturnsAllOnFirstPageAndAdvances() {
        var cursor = TaskEventStreamCursor()
        let fresh = cursor.ingest(TaskEventsPage(events: [event(0, .queued), event(1)], nextCursor: 1))
        XCTAssertEqual(fresh.map(\.seq), [0, 1])
        XCTAssertEqual(cursor.cursor, 1)
        XCTAssertEqual(cursor.nextAfter, 1)
    }

    func testOnlyReturnsStrictlyNewerEvents() {
        var cursor = TaskEventStreamCursor()
        _ = cursor.ingest(TaskEventsPage(events: [event(0, .queued), event(1)], nextCursor: 1))
        // A page that redundantly includes seq 1 plus new 2,3.
        let fresh = cursor.ingest(TaskEventsPage(events: [event(1), event(2), event(3)], nextCursor: 3))
        XCTAssertEqual(fresh.map(\.seq), [2, 3], "already-seen seq 1 is filtered out")
        XCTAssertEqual(cursor.cursor, 3)
    }

    func testCursorNeverRewinds() {
        var cursor = TaskEventStreamCursor()
        _ = cursor.ingest(TaskEventsPage(events: [event(0), event(1), event(2)], nextCursor: 2))
        // An empty page reporting a lower nextCursor must not move us backward.
        let fresh = cursor.ingest(TaskEventsPage(events: [], nextCursor: 0))
        XCTAssertTrue(fresh.isEmpty)
        XCTAssertEqual(cursor.cursor, 2, "cursor holds at its high-water mark")
    }

    func testDetectsTerminalEvent() {
        var cursor = TaskEventStreamCursor()
        XCTAssertFalse(cursor.isComplete)
        _ = cursor.ingest(TaskEventsPage(events: [event(0, .queued), event(1, .running)], nextCursor: 1))
        XCTAssertFalse(cursor.isComplete)
        _ = cursor.ingest(TaskEventsPage(events: [event(2, .complete)], nextCursor: 2))
        XCTAssertTrue(cursor.isComplete)
    }
}
