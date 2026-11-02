import XCTest
@testable import CodexLensKit

final class ProductivityHistoryTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testOnlyExplicitLensHistoryRequestsUseTheNativeReadPath() {
        XCTAssertEqual(ProductivityHistoryScope.requested("Codex, what reminders have you saved?"), .reminder)
        XCTAssertEqual(ProductivityHistoryScope.requested("Show calendar events you created"), .calendarEvent)
        XCTAssertEqual(ProductivityHistoryScope.requested("List personal items you saved"), .all)
        XCTAssertEqual(ProductivityHistoryScope.requested("What reminders did you set?"), .reminder)
        XCTAssertFalse(TaskTakingSpeechPolicy.requiresAssistantTask("Codex, show reminders you created"))
        for text in ["What is on my calendar?", "He asked which reminders you saved", "Delete the reminders you created", "Show reminders you saved and delete them", "Create a reminder", "Show my files", "Show the calendar files you created"] {
            XCTAssertNil(ProductivityHistoryScope.requested(text), text)
        }
        XCTAssertTrue(TaskTakingSpeechPolicy.requiresAssistantTask("Codex, open Calendar on my Mac"))
    }

    @MainActor
    func testReadHistoryAfterRestartDistinguishesSaveFromUncertainty() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("history.json")
        let journal = try ProductivityActionJournal(url: url)
        let action = ProductivityAction(kind: .reminder, title: "Fixture", start: nil, end: nil, timeZone: "UTC")
        let saved = RealtimeUtteranceSource(itemID: "saved", transcript: "Remind me about the fixture", transcribedAt: now)!
        _ = try journal.perform(action: action, source: saved, now: now) { ProductivityReceipt(identifier: "native-private-id", action: $0) }
        let uncertain = RealtimeUtteranceSource(itemID: "uncertain", transcript: "Remind me about the fixture", transcribedAt: now.addingTimeInterval(1))!
        XCTAssertThrowsError(try journal.perform(action: action, source: uncertain, now: now.addingTimeInterval(1)) { _ in throw ProductivityError.uncertainOutcome })
        let before = try Data(contentsOf: url)
        let reopened = try ProductivityActionJournal(url: url)
        let result = reopened.history(scope: .reminder)
        XCTAssertEqual(result.totalMatching, 2)
        XCTAssertEqual(result.items.map(\.saveConfirmed), [false, true])
        XCTAssertEqual(result.items.first?.recordedAt, now.addingTimeInterval(1))
        XCTAssertEqual(try Data(contentsOf: url), before, "Reading must not rewrite the journal or invoke a native save")
        XCTAssertEqual(reopened.history(scope: .calendarEvent).totalMatching, 0)
        XCTAssertEqual(reopened.history(scope: .all, limit: 1).items.count, 1)
        XCTAssertTrue(reopened.history(scope: .all, limit: 1).truncated)
    }

    @MainActor
    func testLegacyJournalHasUnknownTimestampAndDoesNotInventOne() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appendingPathComponent("history.json")
        let action = ProductivityAction(kind: .reminder, title: "Legacy fixture", start: nil, end: nil, timeZone: "UTC")
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(action))
        try JSONSerialization.data(withJSONObject: ["old-key": ["action": encoded]]).write(to: url)
        let journal = try ProductivityActionJournal(url: url)
        let result = journal.history(scope: .all)
        XCTAssertEqual(result.items.count, 1)
        XCTAssertNil(result.items[0].recordedAt)
        XCTAssertFalse(result.items[0].saveConfirmed)
    }
}
