import XCTest
@testable import CodexLensKit

final class ExplicitSendConfirmationTests: XCTestCase {
    private let recipientDisplay = "Alex Example"
    private let maskedDestination = "••••0123"
    private let message = "I am on my way."

    private var exactReadback: String {
        "SERVICE — IMESSAGE! Recipient: ALEX EXAMPLE; destination: 0123. Message: I AM ON MY WAY! Say exactly: Confirm text."
    }

    private func authorization(
        preparedAt: Date,
        expiresAt: Date,
        maskedDestination: String = "••••0123"
    ) -> TextConfirmationAuthorization {
        TextConfirmationAuthorization(
            preparedAt: preparedAt,
            expiresAt: expiresAt,
            serviceType: .iMessage,
            recipientDisplay: recipientDisplay,
            maskedDestination: maskedDestination,
            message: message
        )
    }

    func testAcceptsOnlyConsequenceSpecificTextConfirmation() {
        XCTAssertTrue(ExplicitSendConfirmation.accepts("Confirm text."))
        XCTAssertTrue(ExplicitSendConfirmation.accepts("  CONFIRM   TEXT  "))
    }

    func testRejectsGenericOrdinaryOrEmbeddedAgreement() {
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Yes"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Okay"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Send it"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Yes, send it"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Please confirm text"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("He said send it yesterday"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Do not send it"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Confirm text tomorrow"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Confirm text to Alex"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Confirm text and send it"))
        XCTAssertFalse(ExplicitSendConfirmation.accepts("Confirmed text"))
    }

    func testAuthorizationRequiresCompletedLaterReadback() {
        let preparedAt = Date(timeIntervalSince1970: 1_000)
        var authorization = authorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )

        XCTAssertEqual(
            authorization.decision(
                transcript: "Confirm text",
                transcribedAt: preparedAt.addingTimeInterval(1),
                now: preparedAt.addingTimeInterval(1)
            ),
            .invalidate
        )

        authorization.noteReadbackCompleted(
            responseTranscript: exactReadback,
            at: preparedAt.addingTimeInterval(2)
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "Confirm text",
                transcribedAt: preparedAt.addingTimeInterval(3),
                now: preparedAt.addingTimeInterval(3)
            ),
            .authorize
        )
    }

    func testAuthorizationInvalidatesInterveningOrExpiredSpeech() {
        let preparedAt = Date(timeIntervalSince1970: 2_000)
        var authorization = authorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(60)
        )
        authorization.noteReadbackCompleted(
            responseTranscript: exactReadback,
            at: preparedAt.addingTimeInterval(2)
        )

        XCTAssertEqual(
            authorization.decision(
                transcript: "Send it",
                transcribedAt: preparedAt.addingTimeInterval(3),
                now: preparedAt.addingTimeInterval(3)
            ),
            .invalidate
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "Confirm text",
                transcribedAt: preparedAt.addingTimeInterval(61),
                now: preparedAt.addingTimeInterval(61)
            ),
            .invalidate
        )
    }

    func testAuthorizationRejectsStaleTranscriptAndInvalidReadbackTime() {
        let preparedAt = Date(timeIntervalSince1970: 3_000)
        var authorization = authorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )
        authorization.noteReadbackCompleted(
            responseTranscript: exactReadback,
            at: preparedAt.addingTimeInterval(-1)
        )
        XCTAssertNil(authorization.readbackCompletedAt)

        authorization.noteReadbackCompleted(
            responseTranscript: exactReadback,
            at: preparedAt.addingTimeInterval(1)
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "Confirm text",
                transcribedAt: preparedAt.addingTimeInterval(2),
                now: preparedAt.addingTimeInterval(33)
            ),
            .invalidate
        )
    }

    func testUnrelatedAssistantResponseDoesNotArmConfirmation() {
        let preparedAt = Date(timeIntervalSince1970: 4_000)
        var authorization = authorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )

        authorization.noteReadbackCompleted(
            responseTranscript: "The weather is clear. Say Confirm text if you want.",
            at: preparedAt.addingTimeInterval(1)
        )

        XCTAssertNil(authorization.readbackCompletedAt)
    }

    func testAlteredMessageBodyDoesNotArmConfirmation() {
        let preparedAt = Date(timeIntervalSince1970: 5_000)
        var authorization = authorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )

        authorization.noteReadbackCompleted(
            responseTranscript: "Service: iMessage. Recipient: Alex Example. Destination: 0123. Message: I am already home.",
            at: preparedAt.addingTimeInterval(1)
        )

        XCTAssertNil(authorization.readbackCompletedAt)
    }

    func testWrongRecipientOrServiceDoesNotArmConfirmation() {
        let preparedAt = Date(timeIntervalSince1970: 6_000)
        for response in [
            "Service: iMessage. Recipient: Jordan Example. Destination: 0123. Message: I am on my way.",
            "Service: SMS, not iMessage. Recipient: Alex Example. Destination: 0123. Message: I am on my way.",
        ] {
            var authorization = authorization(
                preparedAt: preparedAt,
                expiresAt: preparedAt.addingTimeInterval(300)
            )
            authorization.noteReadbackCompleted(
                responseTranscript: response,
                at: preparedAt.addingTimeInterval(1)
            )
            XCTAssertNil(authorization.readbackCompletedAt, response)
        }
    }

    func testMissingMaskedDestinationDoesNotArmConfirmation() {
        let preparedAt = Date(timeIntervalSince1970: 7_000)
        var authorization = authorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )

        authorization.noteReadbackCompleted(
            responseTranscript: "Service: iMessage. Recipient: Alex Example. Message: I am on my way. Say exactly: Confirm text.",
            at: preparedAt.addingTimeInterval(1)
        )

        XCTAssertNil(authorization.readbackCompletedAt)
    }

    func testMessageBodyCannotSubstituteForMissingMetadata() {
        let preparedAt = Date(timeIntervalSince1970: 7_500)
        let message = "Tell Alex Example to use iMessage and mention 0123."
        var authorization = TextConfirmationAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300),
            serviceType: .iMessage,
            recipientDisplay: recipientDisplay,
            maskedDestination: maskedDestination,
            message: message
        )

        authorization.noteReadbackCompleted(
            responseTranscript: "Message: \(message)",
            at: preparedAt.addingTimeInterval(1)
        )

        XCTAssertNil(authorization.readbackCompletedAt)
    }

    func testEmptyMaskedDestinationDoesNotRequireASuffix() {
        let preparedAt = Date(timeIntervalSince1970: 8_000)
        var authorization = authorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300),
            maskedDestination: ""
        )

        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback,
            at: preparedAt.addingTimeInterval(1)
        )

        XCTAssertEqual(authorization.readbackCompletedAt, preparedAt.addingTimeInterval(1))
    }

    func testNegatedOrExpandedCanonicalReadbackCannotArmSend() {
        let preparedAt = Date(timeIntervalSince1970: 9_000)
        let canonical = exactReadback
        for response in [
            "Do not \(canonical)",
            "\(canonical) Add that I will be ten minutes late.",
            canonical.replacingOccurrences(of: "I AM ON MY WAY", with: "I AM ON MY WAY TO THE STORE"),
        ] {
            var authorization = authorization(
                preparedAt: preparedAt,
                expiresAt: preparedAt.addingTimeInterval(300)
            )
            authorization.noteReadbackCompleted(
                responseTranscript: response,
                at: preparedAt.addingTimeInterval(1)
            )
            XCTAssertNil(authorization.readbackCompletedAt, response)
        }
    }

    func testPostPlaybackDelayRejectsImmediateEcho() {
        let preparedAt = Date(timeIntervalSince1970: 10_000)
        var authorization = authorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )
        authorization.noteReadbackCompleted(
            responseTranscript: exactReadback,
            at: preparedAt.addingTimeInterval(1)
        )

        XCTAssertEqual(
            authorization.decision(
                transcript: "Confirm text",
                transcribedAt: preparedAt.addingTimeInterval(1.2),
                now: preparedAt.addingTimeInterval(1.2)
            ),
            .invalidate
        )
    }
}
