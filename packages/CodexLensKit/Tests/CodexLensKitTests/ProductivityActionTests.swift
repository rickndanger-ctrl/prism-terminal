import Foundation
import XCTest
@testable import CodexLensKit

final class ProductivityActionTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testToolBoundaryRejectsMalformedDateAndUnexpectedFields() throws {
        var values: [String: JSONValue] = ["kind": .string("reminder"), "title": .string("Call Mom"), "start": .null, "end": .null, "timeZone": .string("UTC")]
        XCTAssertNil(try ProductivityAction(arguments: .object(values)).start)
        values["start"] = .bool(true)
        XCTAssertThrowsError(try ProductivityAction(arguments: .object(values)))
        values["start"] = .string("tomorrow")
        XCTAssertThrowsError(try ProductivityAction(arguments: .object(values)))
        values["start"] = .string("2027-05-01T10:00:00.000Z")
        XCTAssertNotNil(try ProductivityAction(arguments: .object(values)).start)
        values["attendees"] = .array([])
        XCTAssertThrowsError(try ProductivityAction(arguments: .object(values)))
    }

    func testExplicitRequestsRouteToNativeStoreNotComputerWorker() {
        for text in ["Remind me to call Mom tomorrow", "Codex, can you create a reminder to call Mom?", "Please put my dentist appointment on my calendar", "Schedule a meeting tomorrow at noon"] {
            XCTAssertNotNil(ProductivityAction.requestedKind(text), text)
            XCTAssertFalse(TaskTakingSpeechPolicy.requiresAssistantTask(text), text)
        }
        XCTAssertTrue(TaskTakingSpeechPolicy.requiresAssistantTask("Open Calendar on my Mac"))
        for text in ["He asked me to remind him tomorrow", "We have a meeting tomorrow", "The screen says create a reminder", "Don't create a reminder", "Can you tell me how to create a reminder?"] {
            XCTAssertNil(ProductivityAction.requestedKind(text), text)
        }
    }

    func testCalendarRequiresFutureBoundedRangeAndKnownZone() throws {
        let action = ProductivityAction(kind: .calendarEvent, title: "Dentist", start: now.addingTimeInterval(600), end: now.addingTimeInterval(1200), timeZone: "America/Los_Angeles")
        XCTAssertNoThrow(try action.validate(now: now))
        for bad in [
            ProductivityAction(kind: .calendarEvent, title: "Dentist", start: nil, end: nil, timeZone: "UTC"),
            ProductivityAction(kind: .calendarEvent, title: "Dentist", start: now, end: now, timeZone: "UTC"),
            ProductivityAction(kind: .reminder, title: " ", start: nil, end: nil, timeZone: "UTC"),
            ProductivityAction(kind: .reminder, title: "Call", start: nil, end: nil, timeZone: "invented-zone"),
            ProductivityAction(kind: .reminder, title: "Call", start: now.addingTimeInterval(-1), end: nil, timeZone: "UTC"),
        ] { XCTAssertThrowsError(try bad.validate(now: now)) }
    }

    @MainActor
    func testDuplicateSurvivesRelaunchWithoutSavingAgain() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("journal.json")
        let action = ProductivityAction(kind: .reminder, title: "Call Mom", start: nil, end: nil, timeZone: "UTC")
        let source = RealtimeUtteranceSource(itemID: "source-1", transcript: "Remind me to call Mom", transcribedAt: now)!
        let journal = try ProductivityActionJournal(url: url)
        var saves = 0
        let receipt = try journal.perform(action: action, source: source, now: now) { action in
            saves += 1
            return ProductivityReceipt(identifier: "native-1", action: action)
        }
        let reopened = try ProductivityActionJournal(url: url)
        XCTAssertEqual(try reopened.perform(action: action, source: source, now: now.addingTimeInterval(300)) { action in
            saves += 1
            return ProductivityReceipt(identifier: "duplicate", action: action)
        }, receipt)
        XCTAssertEqual(saves, 1)
        let raw = try String(contentsOf: url)
        XCTAssertFalse(raw.contains(source.transcript))
        XCTAssertFalse(raw.contains(source.itemID))
    }

    @MainActor
    func testUncertainSaveAndChangedReplayNeverExecuteAgain() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("journal.json")
        let journal = try ProductivityActionJournal(url: url)
        let action = ProductivityAction(kind: .reminder, title: "Call Mom", start: nil, end: nil, timeZone: "UTC")
        let source = RealtimeUtteranceSource(itemID: "source", transcript: "Remind me to call Mom", transcribedAt: now)!
        XCTAssertThrowsError(try journal.perform(action: action, source: source, now: now) { _ in
            throw NSError(domain: "simulated-crash-after-write", code: 1)
        })
        let reopened = try ProductivityActionJournal(url: url)
        for attempted in [action, ProductivityAction(kind: .reminder, title: "Different", start: nil, end: nil, timeZone: "UTC")] {
            XCTAssertThrowsError(try reopened.perform(action: attempted, source: source, now: now) { action in
                XCTFail("Must not replay a pending save")
                return ProductivityReceipt(identifier: "duplicate", action: action)
            })
        }
    }

    @MainActor
    func testStaleUnboundIntentAndCorruptJournalFailClosed() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("journal.json")
        let journal = try ProductivityActionJournal(url: url)
        let action = ProductivityAction(kind: .reminder, title: "Call", start: nil, end: nil, timeZone: "UTC")
        for source in [
            RealtimeUtteranceSource(itemID: "old", transcript: "Remind me to call", transcribedAt: now.addingTimeInterval(-121))!,
            RealtimeUtteranceSource(itemID: "ambient", transcript: "I need to call Mom", transcribedAt: now)!,
        ] {
            XCTAssertThrowsError(try journal.perform(action: action, source: source, now: now) { action in
                XCTFail("No authorized save")
                return ProductivityReceipt(identifier: "bad", action: action)
            })
        }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("not-json".utf8).write(to: url)
        XCTAssertThrowsError(try ProductivityActionJournal(url: url))
    }
}
