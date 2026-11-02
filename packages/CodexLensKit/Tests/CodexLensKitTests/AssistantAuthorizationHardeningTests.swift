import XCTest
@testable import CodexLensKit

final class AssistantAuthorizationHardeningTests: XCTestCase {
    func testTaskReadbackRejectsNegationExpansionAndWrongProject() {
        let preparedAt = Date(timeIntervalSince1970: 20_000)
        let makeAuthorization = {
            AssistantTaskConfirmationAuthorization(
                preparedAt: preparedAt,
                expiresAt: preparedAt.addingTimeInterval(300),
                instruction: "Run the tests and report failures.",
                scope: .project,
                projectId: "codex-lens",
                projectDisplayName: "Codex Lens"
            )
        }
        let canonical = makeAuthorization().requiredReadback

        for response in [
            "Do not \(canonical)",
            "\(canonical) Then delete the build folder.",
            canonical.replacingOccurrences(of: "Codex Lens", with: "Kitchen Capture"),
            canonical.replacingOccurrences(of: "codex-lens", with: "other-project"),
        ] {
            var authorization = makeAuthorization()
            authorization.noteReadbackCompleted(
                responseTranscript: response,
                at: preparedAt.addingTimeInterval(1)
            )
            XCTAssertNil(authorization.readbackCompletedAt, response)
        }
    }

    func testProjectTaskCannotArmWithoutProjectIdentity() {
        let preparedAt = Date(timeIntervalSince1970: 21_000)
        var authorization = AssistantTaskConfirmationAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300),
            instruction: "Run the tests.",
            scope: .project
        )
        XCTAssertTrue(authorization.requiredReadback.isEmpty)
        authorization.noteReadbackCompleted(
            responseTranscript: "Task: Run the tests. Scope: project. Say exactly: Codex, confirm.",
            at: preparedAt.addingTimeInterval(1)
        )
        XCTAssertNil(authorization.readbackCompletedAt)
    }

    func testTaskConfirmationAcceptsNarrowCodexTranscriptionAliasesAfterDelay() {
        let preparedAt = Date(timeIntervalSince1970: 22_000)
        for transcript in ["Codex, confirm", "Codec confirm", "Code X, confirm"] {
            var authorization = AssistantTaskConfirmationAuthorization(
                preparedAt: preparedAt,
                expiresAt: preparedAt.addingTimeInterval(300),
                instruction: "Open Finder.",
                scope: .mac
            )
            authorization.noteReadbackCompleted(
                responseTranscript: authorization.requiredReadback,
                at: preparedAt.addingTimeInterval(1)
            )
            XCTAssertEqual(
                authorization.decision(
                    transcript: transcript,
                    transcribedAt: preparedAt.addingTimeInterval(2),
                    now: preparedAt.addingTimeInterval(2)
                ),
                .authorize,
                transcript
            )
        }
    }

    func testTaskConfirmationRejectsImmediatePostReadbackEcho() {
        let preparedAt = Date(timeIntervalSince1970: 23_000)
        var authorization = AssistantTaskConfirmationAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300),
            instruction: "Open Finder.",
            scope: .mac
        )
        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback,
            at: preparedAt.addingTimeInterval(1)
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "Codex, confirm",
                transcribedAt: preparedAt.addingTimeInterval(1.2),
                now: preparedAt.addingTimeInterval(1.2)
            ),
            .invalidate
        )
    }

    func testComputerActionRequiresCanonicalReadbackAndFreshConfirmation() {
        let preparedAt = Date(timeIntervalSince1970: 24_000)
        var authorization = ComputerActionConfirmationAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300),
            instruction: "Install Example App.",
            surface: "computer"
        )

        authorization.noteReadbackCompleted(
            responseTranscript: "Do not \(authorization.requiredReadback)",
            at: preparedAt.addingTimeInterval(1)
        )
        XCTAssertNil(authorization.readbackCompletedAt)

        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback,
            at: preparedAt.addingTimeInterval(2)
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "Codex, confirm",
                transcribedAt: preparedAt.addingTimeInterval(3),
                now: preparedAt.addingTimeInterval(3)
            ),
            .authorize
        )
    }

    func testComputerActionReadbackRejectsExpansionAndWrongSurface() {
        let preparedAt = Date(timeIntervalSince1970: 24_500)
        let makeAuthorization: () -> ComputerActionConfirmationAuthorization = {
            ComputerActionConfirmationAuthorization(
                preparedAt: preparedAt,
                expiresAt: preparedAt.addingTimeInterval(300),
                instruction: "Install Example App.",
                surface: "computer"
            )
        }
        let canonical = makeAuthorization().requiredReadback

        for response in [
            "\(canonical) Then approve every security prompt.",
            canonical.replacingOccurrences(of: "Surface: computer", with: "Surface: chrome"),
        ] {
            var authorization = makeAuthorization()
            authorization.noteReadbackCompleted(
                responseTranscript: response,
                at: preparedAt.addingTimeInterval(1)
            )
            XCTAssertNil(authorization.readbackCompletedAt, response)
        }
    }

    func testReconciliationReadbackRejectsNegationExpansionAndChangedIdentity() {
        let armedAt = Date(timeIntervalSince1970: 24_750)
        let makeAuthorization: () -> AssistantTaskReconciliationAuthorization = {
            AssistantTaskReconciliationAuthorization(
                armedAt: armedAt,
                expiresAt: armedAt.addingTimeInterval(300),
                taskId: "assistant-42",
                instruction: "Run the unit tests.",
                scope: .project,
                projectId: "codex-lens",
                projectDisplayName: "Codex Lens",
                state: .failed,
                summary: "The final process outcome is unknown.",
                failureCode: "ASSISTANT_TASK_CANCEL_UNCONFIRMED"
            )
        }
        let canonical = makeAuthorization().requiredReadback

        for response in [
            "Do not \(canonical)",
            "\(canonical) The task actually succeeded.",
            canonical.replacingOccurrences(of: "assistant-42", with: "assistant-99"),
            canonical.replacingOccurrences(of: "codex-lens", with: "other-project"),
        ] {
            var authorization = makeAuthorization()
            authorization.noteReadbackCompleted(
                responseTranscript: response,
                at: armedAt.addingTimeInterval(1)
            )
            XCTAssertNil(authorization.readbackCompletedAt, response)
        }

        var authorization = makeAuthorization()
        authorization.noteReadbackCompleted(
            responseTranscript: canonical,
            at: armedAt.addingTimeInterval(1)
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "Codex, clear task lock",
                transcribedAt: armedAt.addingTimeInterval(1.2),
                now: armedAt.addingTimeInterval(1.2)
            ),
            .invalidate
        )
    }

    func testPhoneOwnedTaskIDRejectsMissingOrDifferentModelID() {
        XCTAssertEqual(
            AssistantTaskIDAuthorization.resolve(requested: nil, remembered: "assistant-42"),
            "assistant-42"
        )
        XCTAssertEqual(
            AssistantTaskIDAuthorization.resolve(requested: " assistant-42 ", remembered: "assistant-42"),
            "assistant-42"
        )
        XCTAssertNil(AssistantTaskIDAuthorization.resolve(
            requested: "assistant-99",
            remembered: "assistant-42"
        ))
        XCTAssertNil(AssistantTaskIDAuthorization.resolve(
            requested: "",
            remembered: "assistant-42"
        ))
        XCTAssertNil(AssistantTaskIDAuthorization.resolve(
            requested: "assistant-42",
            remembered: nil
        ))
        XCTAssertFalse(AssistantTaskIDAuthorization.responseMatches(
            "assistant-99",
            expectedTaskID: "assistant-42"
        ))
        XCTAssertFalse(AssistantTaskIDAuthorization.responseMatches(
            "",
            expectedTaskID: ""
        ))
    }

    func testMessageIntentIDPersistsAcrossStoreInstances() {
        let suiteName = "MessageIntentIDStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        MessageIntentIDStore(defaults: defaults).remember(" confirm-42 ")
        XCTAssertEqual(
            MessageIntentIDStore(defaults: defaults).lastConfirmationID,
            "confirm-42"
        )
        MessageIntentIDStore(defaults: defaults).clear()
        XCTAssertNil(MessageIntentIDStore(defaults: defaults).lastConfirmationID)
    }

    func testOnlyAudioTranscriptDeltaCountsAsSpokenReadback() {
        XCTAssertTrue(RealtimeReadbackEventPolicy.isAssistantTranscriptDelta(
            "response.output_audio_transcript.delta"
        ))
        XCTAssertTrue(RealtimeReadbackEventPolicy.isAssistantTranscriptDelta(
            "response.output_text.delta"
        ))
        XCTAssertTrue(RealtimeReadbackEventPolicy.isSpokenTranscriptDelta(
            "response.output_audio_transcript.delta"
        ))
        XCTAssertFalse(RealtimeReadbackEventPolicy.isSpokenTranscriptDelta(
            "response.output_text.delta"
        ))
        XCTAssertTrue(RealtimeReadbackEventPolicy.isEligibleCompletedSpokenResponse(
            status: "completed",
            hadSpokenOutput: true,
            containedToolCall: false
        ))
        for status in ["cancelled", "failed", "incomplete"] {
            XCTAssertFalse(RealtimeReadbackEventPolicy.isEligibleCompletedSpokenResponse(
                status: status,
                hadSpokenOutput: true,
                containedToolCall: false
            ))
        }
        XCTAssertFalse(RealtimeReadbackEventPolicy.isEligibleCompletedSpokenResponse(
            status: "completed",
            hadSpokenOutput: true,
            containedToolCall: true
        ))
        XCTAssertFalse(RealtimeReadbackEventPolicy.isEligibleCompletedSpokenResponse(
            status: "completed",
            hadSpokenOutput: false,
            containedToolCall: false
        ))
    }
}
