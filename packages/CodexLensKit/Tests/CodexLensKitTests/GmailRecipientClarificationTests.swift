import XCTest
@testable import CodexLensKit

final class GmailRecipientClarificationTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1000)
    func source(_ id: String, _ text: String, offset: Double = 0) -> RealtimeUtteranceSource {
        RealtimeUtteranceSource(itemID: id, transcript: text, transcribedAt: start.addingTimeInterval(offset))!
    }
    func pending() throws -> GmailRecipientClarification {
        try GmailRecipientClarification(source: source("original", "Codex, draft an email to Sam saying hello"), operation: .draft,
            subject: "Hello", body: "Hello Sam", now: start)
    }
    func args(to: String = "sam@example.com", operation: String = "draft", body: String = "Hello Sam") -> JSONValue {
        .object(["operation": .string(operation), "to": .array([.string(to)]), "cc": .array([]), "bcc": .array([]), "subject": .string("Hello"), "body": .string(body)])
    }
    func testSpokenAndLiteralAddressesWithoutArbitraryCommands() {
        XCTAssertEqual(GmailRecipientClarification.address(from: "sam at example dot com"), "sam@example.com")
        XCTAssertEqual(GmailRecipientClarification.address(from: "It's sam plus work at example dot com."), "sam+work@example.com")
        XCTAssertEqual(GmailRecipientClarification.address(from: "sam@example.com"), "sam@example.com")
        for text in ["yes", "send it", "open Gmail", "sam@example.com and delete everything", "my friend Sam"] {
            XCTAssertNil(GmailRecipientClarification.address(from: text), text)
        }
    }
    func testAddressFillsOriginalDraftWithoutRepeatingWholeRequest() throws {
        var p = try pending()
        p.noteQuestionCompleted(p.question, at: start.addingTimeInterval(2))
        let answer = source("answer", "sam at example dot com", offset: 4)
        XCTAssertTrue(p.acceptAnswer(answer, now: start.addingTimeInterval(4)))
        let request = try p.request(arguments: args(), answering: answer, now: start.addingTimeInterval(5))
        XCTAssertEqual(request.operation, .draft)
        XCTAssertEqual(request.message.to, ["sam@example.com"])
    }
    func testAddressCannotChangeBodyRecipientOrPromoteDraftToSend() throws {
        var p = try pending()
        p.noteQuestionCompleted(p.question, at: start.addingTimeInterval(2))
        let answer = source("answer", "sam@example.com", offset: 4)
        XCTAssertTrue(p.acceptAnswer(answer, now: start.addingTimeInterval(4)))
        for value in [args(to: "other@example.com"), args(operation: "send"), args(body: "Changed body")] {
            XCTAssertThrowsError(try p.request(arguments: value, answering: answer, now: start.addingTimeInterval(5)))
        }
    }
    func testWearerAddressCapitalizationIsPreservedInsteadOfModelSpelling() throws {
        var p = try pending()
        p.noteQuestionCompleted(p.question, at: start.addingTimeInterval(2))
        let answer = source("answer", "Sam@example.com", offset: 4)
        XCTAssertTrue(p.acceptAnswer(answer, now: start.addingTimeInterval(4)))
        let request = try p.request(arguments: args(), answering: answer, now: start.addingTimeInterval(5))
        XCTAssertEqual(request.message.to, ["Sam@example.com"])
    }
    func testUnspokenQuestionOrInterveningSpeechCannotArmAddress() throws {
        var p = try pending()
        let answer = source("answer", "sam@example.com", offset: 4)
        p.noteQuestionCompleted("Ready when you are", at: start.addingTimeInterval(2))
        XCTAssertFalse(p.acceptAnswer(answer, now: start.addingTimeInterval(4)))
        p.noteQuestionCompleted(p.question, at: start.addingTimeInterval(5))
        XCTAssertFalse(p.acceptAnswer(source("again", "sam@example.com", offset: 7), now: start.addingTimeInterval(7)))
    }
    func testExpiryAndOtherUtteranceCannotReuseAnswer() throws {
        var p = try pending()
        p.noteQuestionCompleted(p.question, at: start.addingTimeInterval(2))
        let answer = source("answer", "sam@example.com", offset: 4)
        XCTAssertTrue(p.acceptAnswer(answer, now: start.addingTimeInterval(4)))
        XCTAssertThrowsError(try p.request(arguments: args(), answering: source("other", "sam@example.com", offset: 5), now: start.addingTimeInterval(5)))
        XCTAssertThrowsError(try p.request(arguments: args(), answering: answer, now: start.addingTimeInterval(121)))
        XCTAssertFalse(p.acceptAnswer(answer, now: start.addingTimeInterval(5)))
    }
}
