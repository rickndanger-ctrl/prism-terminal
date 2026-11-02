import XCTest
@testable import CodexLensKit

final class GmailVoiceWriteRequestTests: XCTestCase {
    private func arguments(operation: String = "draft") -> JSONValue {
        .object(["operation": .string(operation), "to": .array([.string("person@example.com")]),
                 "cc": .array([]), "bcc": .array([]), "subject": .string("Test"), "body": .string("Hello")])
    }
    private func source(_ text: String) -> RealtimeUtteranceSource {
        RealtimeUtteranceSource(itemID: "wearer-1", transcript: text, transcribedAt: Date())!
    }

    func testExplicitDraftCannotBePromotedToSend() throws {
        let wearer = source("Codex, draft an email to person@example.com")
        XCTAssertEqual(try GmailVoiceWriteRequest(arguments: arguments(), source: wearer).operation, .draft)
        XCTAssertThrowsError(try GmailVoiceWriteRequest(arguments: arguments(operation: "send"), source: wearer))
    }

    func testExplicitSendAndAddressVariants() throws {
        for text in ["Send an email to person@example.com", "Hey Code X, please send an email to person@example.com", "Email person@example.com"] {
            XCTAssertEqual(try GmailVoiceWriteRequest(arguments: arguments(operation: "send"), source: source(text)).operation, .send)
        }
    }

    func testAmbientSpeechAndEmailDataCannotAuthorizePreparation() {
        for text in ["He said send an email", "Read my email", "What is an email?", "Confirm email"] {
            XCTAssertThrowsError(try GmailVoiceWriteRequest(arguments: arguments(operation: "send"), source: source(text)))
        }
    }

    func testModelCannotSupplyConfirmationOrSender() {
        guard case .object(var fields) = arguments() else { return XCTFail() }
        fields["confirmation"] = .string("confirm email")
        XCTAssertThrowsError(try GmailVoiceWriteRequest(arguments: .object(fields), source: source("Draft an email")))
        fields.removeValue(forKey: "confirmation")
        fields["from"] = .string("someone@example.com")
        XCTAssertThrowsError(try GmailVoiceWriteRequest(arguments: .object(fields), source: source("Draft an email")))
    }

    func testUnresolvedRecipientAndOverlongReadbackAreRejected() {
        guard case .object(var fields) = arguments() else { return XCTFail() }
        fields["to"] = .array([.string("Sam")])
        XCTAssertThrowsError(try GmailVoiceWriteRequest(arguments: .object(fields), source: source("Draft an email")))
        fields["to"] = .array([.string("sam@example.com")])
        fields["body"] = .string(String(repeating: "a", count: 8_001))
        XCTAssertThrowsError(try GmailVoiceWriteRequest(arguments: .object(fields), source: source("Draft an email")))
    }

    func testNoModelCallableExecuteToolAndDefaultOff() {
        XCTAssertEqual(CodexLensTools.gmailWrites.map(\.name), ["clarify_gmail_recipient", "prepare_gmail_write", "get_last_gmail_write_status"])
        XCTAssertTrue(Set(CodexLensTools.all.map(\.name)).isDisjoint(with: Set(CodexLensTools.gmailWrites.map(\.name))))
        XCTAssertTrue(GmailVoiceWriteRequest.isConfirmation("Confirm email."))
        XCTAssertTrue(GmailVoiceWriteRequest.isConfirmation("Confirm draft"))
        XCTAssertFalse(GmailVoiceWriteRequest.isConfirmation("He said confirm email"))
        XCTAssertFalse(GmailVoiceWriteRequest.isConfirmation("Yes"))
    }

    func testPhoneConfirmationSlotIsSingleUseAndInterveningSpeechClearsIt() {
        let start = Date(timeIntervalSince1970: 1_000)
        var authorization = EmailConfirmationAuthorization(id: UUID().uuidString,
            digest: String(repeating: "a", count: 64), operation: .send,
            preparedAt: start, expiresAt: start.addingTimeInterval(300),
            from: "owner@example.com", to: ["person@example.com"], subject: "Test", body: "Hello")
        authorization.noteReadbackCompleted(authorization.requiredReadback, at: start.addingTimeInterval(5))
        let confirmation = RealtimeUtteranceSource(itemID: "confirmation", transcript: "Confirm email", transcribedAt: start.addingTimeInterval(7))!
        var pending: EmailConfirmationAuthorization? = authorization
        XCTAssertNotNil(EmailConfirmationAuthorization.consumeConfirmation(from: &pending, source: confirmation, enabled: true, now: start.addingTimeInterval(7)))
        XCTAssertNil(pending)
        XCTAssertNil(EmailConfirmationAuthorization.consumeConfirmation(from: &pending, source: confirmation, enabled: true, now: start.addingTimeInterval(7)))
        for text in ["Wait", "Confirm draft", "What time is it?"] {
            pending = authorization
            let speech = RealtimeUtteranceSource(itemID: "other", transcript: text, transcribedAt: start.addingTimeInterval(7))!
            XCTAssertNil(EmailConfirmationAuthorization.consumeConfirmation(from: &pending, source: speech, enabled: true, now: start.addingTimeInterval(7)))
            XCTAssertNil(pending)
        }
        pending = authorization
        XCTAssertNil(EmailConfirmationAuthorization.consumeConfirmation(from: &pending, source: confirmation, enabled: false, now: start.addingTimeInterval(7)))
        XCTAssertNil(pending)
    }
}
