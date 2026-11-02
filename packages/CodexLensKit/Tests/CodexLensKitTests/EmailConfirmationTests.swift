import XCTest
@testable import CodexLensKit

final class EmailConfirmationTests: XCTestCase {
    private let id = UUID().uuidString
    private let digest = String(repeating: "a", count: 64)
    private let start = Date(timeIntervalSince1970: 1000)
    private func confirmation(_ operation: EmailWriteOperation = .send, recipient: String = "a+b@example.com") -> EmailConfirmationAuthorization {
        EmailConfirmationAuthorization(id: id, digest: digest, operation: operation, preparedAt: start,
            expiresAt: start.addingTimeInterval(300), from: "owner@example.com", to: [recipient], subject: "Hello", body: "Exact body")
    }
    private func accepts(_ value: EmailConfirmationAuthorization, _ phrase: String, operation: EmailWriteOperation = .send, digest: String? = nil) -> Bool {
        value.authorizes(id: id, digest: digest ?? self.digest, operation: operation, transcript: phrase,
            transcribedAt: start.addingTimeInterval(10), now: start.addingTimeInterval(11))
    }
    func testRequiresCompletedReadbackAndSpecificLaterConfirmation() {
        var value = confirmation()
        XCTAssertFalse(accepts(value, "Confirm email"))
        value.noteReadbackCompleted(value.requiredReadback, at: start.addingTimeInterval(3))
        XCTAssertTrue(accepts(value, "Confirm email"))
        for phrase in ["yes", "send it", "run it", "confirm draft", "don't confirm email"] {
            XCTAssertFalse(accepts(value, phrase))
        }
        XCTAssertFalse(accepts(value, "Confirm email", digest: String(repeating: "b", count: 64)))
    }
    func testDraftApprovalCannotAuthorizeSending() {
        var value = confirmation(.draft)
        value.noteReadbackCompleted(value.requiredReadback, at: start.addingTimeInterval(3))
        XCTAssertTrue(accepts(value, "Confirm draft", operation: .draft))
        XCTAssertFalse(accepts(value, "Confirm email"))
    }
    func testRecipientPunctuationAndOmittedBodyCannotMatch() {
        var value = confirmation()
        value.noteReadbackCompleted(confirmation(recipient: "a.b@example.com").requiredReadback, at: start.addingTimeInterval(3))
        XCTAssertFalse(accepts(value, "Confirm email"))
        value.noteReadbackCompleted("Ready to send. Confirm email.", at: start.addingTimeInterval(3))
        XCTAssertFalse(accepts(value, "Confirm email"))
    }
    func testExpiredApprovalIsRejected() {
        var value = confirmation()
        value.noteReadbackCompleted(value.requiredReadback, at: start.addingTimeInterval(3))
        XCTAssertFalse(value.authorizes(id: id, digest: digest, operation: .send, transcript: "Confirm email",
            transcribedAt: start.addingTimeInterval(299), now: start.addingTimeInterval(301)))
    }
}
