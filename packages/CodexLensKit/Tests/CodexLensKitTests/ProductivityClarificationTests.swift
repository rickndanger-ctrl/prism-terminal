import Foundation
import XCTest
@testable import CodexLensKit

final class ProductivityClarificationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func source(_ id: String, _ text: String, after seconds: Double = 0) -> RealtimeUtteranceSource {
        RealtimeUtteranceSource(itemID: id, transcript: text, transcribedAt: now.addingTimeInterval(seconds))!
    }
    private func pending() throws -> ProductivityClarification {
        try ProductivityClarification(source: source("original", "Schedule a meeting for planning"), kind: .calendarEvent, title: "Planning", now: now)
    }
    private func action(title: String = "Planning", kind: ProductivityKind = .calendarEvent) -> ProductivityAction {
        ProductivityAction(kind: kind, title: title, start: now.addingTimeInterval(3600), end: now.addingTimeInterval(5400), timeZone: "UTC")
    }

    func testTimingGrammarAcceptsShortAnswersButNotConversationOrCancel() {
        for text in ["tomorrow at three", "half an hour", "September 21st from 3 PM to 4 PM", "yes, tomorrow at three", "make it next Tuesday at noon", "Codex, tomorrow at 3:30"] {
            XCTAssertTrue(ProductivityClarification.isTimingAnswer(text), text)
        }
        for text in ["cancel", "Codex stop", "never mind", "yes", "okay", "make it", "tomorrow I am seeing Bob", "open Calendar", "send the invite", "the screen says tomorrow at three"] {
            XCTAssertFalse(ProductivityClarification.isTimingAnswer(text), text)
        }
    }

    func testAnswerRequiresExactFinishedQuestionAndCannotChangeIdentity() throws {
        var clarification = try pending()
        clarification.noteQuestionCompleted("What do you need?", at: now.addingTimeInterval(1))
        XCTAssertNil(clarification.askedAt)
        clarification.noteQuestionCompleted(clarification.question, at: now.addingTimeInterval(2))
        let answer = source("answer", "Tomorrow from three to four", after: 3)
        XCTAssertTrue(clarification.acceptAnswer(answer, now: now.addingTimeInterval(3)))
        let bound = try clarification.authorizedSource(for: action(), answering: answer, now: now.addingTimeInterval(4))
        XCTAssertEqual(bound.itemID, "original")
        XCTAssertTrue(bound.transcript.contains(answer.transcript))
        XCTAssertThrowsError(try clarification.authorizedSource(for: action(title: "Different"), answering: answer, now: now.addingTimeInterval(4)))
        XCTAssertThrowsError(try clarification.authorizedSource(for: action(kind: .reminder), answering: answer, now: now.addingTimeInterval(4)))
        XCTAssertThrowsError(try clarification.authorizedSource(for: action(), answering: source("other", "Tomorrow from three to four", after: 3), now: now.addingTimeInterval(4)))
    }

    func testEarlyExpiredAndUnrelatedAnswersInvalidateTheDraft() throws {
        var early = try pending()
        XCTAssertFalse(early.acceptAnswer(source("early", "Tomorrow at three", after: 1), now: now.addingTimeInterval(1)))
        early.noteQuestionCompleted(early.question, at: now.addingTimeInterval(2))
        XCTAssertNil(early.askedAt)
        for text in ["Cancel", "I am talking to someone else"] {
            var clarification = try pending()
            clarification.noteQuestionCompleted(clarification.question, at: now.addingTimeInterval(1))
            XCTAssertFalse(clarification.acceptAnswer(source("unrelated", text, after: 2), now: now.addingTimeInterval(2)))
            XCTAssertFalse(clarification.acceptAnswer(source("late", "Tomorrow at three", after: 3), now: now.addingTimeInterval(3)))
        }
        var expired = try pending()
        expired.noteQuestionCompleted(expired.question, at: now.addingTimeInterval(1))
        XCTAssertFalse(expired.acceptAnswer(source("expired", "Tomorrow at three", after: 121), now: now.addingTimeInterval(121)))
    }

    @MainActor
    func testClarifiedSaveKeepsOriginalDurableIdentity() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let journal = try ProductivityActionJournal(url: root.appendingPathComponent("journal.json"))
        var clarification = try pending()
        clarification.noteQuestionCompleted(clarification.question, at: now.addingTimeInterval(1))
        let answer = source("answer", "Tomorrow at three for half an hour", after: 2)
        XCTAssertTrue(clarification.acceptAnswer(answer, now: now.addingTimeInterval(2)))
        let bound = try clarification.authorizedSource(for: action(), answering: answer, now: now.addingTimeInterval(3))
        var saves = 0
        for _ in 0..<2 {
            _ = try journal.perform(action: action(), source: bound, now: now.addingTimeInterval(4)) { request in
                saves += 1
                return ProductivityReceipt(identifier: "native-record", action: request)
            }
        }
        XCTAssertEqual(saves, 1)
    }
}
