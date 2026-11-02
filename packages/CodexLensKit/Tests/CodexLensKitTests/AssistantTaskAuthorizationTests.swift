import XCTest
@testable import CodexLensKit

final class AssistantTaskAuthorizationTests: XCTestCase {
    private let instruction = "Run the existing unit tests and report failures."
    private let projectId = "codex-lens"
    private let projectName = "Codex Lens"

    private func projectAuthorization(
        preparedAt: Date,
        expiresAt: Date
    ) -> AssistantTaskConfirmationAuthorization {
        AssistantTaskConfirmationAuthorization(
            preparedAt: preparedAt,
            expiresAt: expiresAt,
            instruction: instruction,
            scope: .project,
            projectId: projectId,
            projectDisplayName: projectName
        )
    }

    private func reconciliationAuthorization(
        armedAt: Date,
        expiresAt: Date,
        summary: String,
        failureCode: String
    ) -> AssistantTaskReconciliationAuthorization {
        AssistantTaskReconciliationAuthorization(
            armedAt: armedAt,
            expiresAt: expiresAt,
            taskId: "assistant-42",
            instruction: instruction,
            scope: .project,
            projectId: projectId,
            projectDisplayName: projectName,
            state: .failed,
            summary: summary,
            failureCode: failureCode
        )
    }

    func testCodexConfirmRequiresACompletedLaterReadback() {
        let preparedAt = Date(timeIntervalSince1970: 1_000)
        var authorization = projectAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )

        XCTAssertEqual(
            authorization.decision(
                transcript: "Codex, confirm",
                transcribedAt: preparedAt.addingTimeInterval(1),
                now: preparedAt.addingTimeInterval(1)
            ),
            .invalidate
        )

        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback.uppercased(),
            at: preparedAt.addingTimeInterval(2)
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "CODEX — CONFIRM!!!",
                transcribedAt: preparedAt.addingTimeInterval(3),
                now: preparedAt.addingTimeInterval(3)
            ),
            .authorize
        )
    }

    func testInterveningSpeechAndExpiryInvalidateAuthorization() {
        let preparedAt = Date(timeIntervalSince1970: 2_000)
        var authorization = projectAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(60)
        )
        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback,
            at: preparedAt.addingTimeInterval(2)
        )

        XCTAssertEqual(
            authorization.decision(
                transcript: "Let me think about that",
                transcribedAt: preparedAt.addingTimeInterval(3),
                now: preparedAt.addingTimeInterval(3)
            ),
            .invalidate
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "Codex, confirm",
                transcribedAt: preparedAt.addingTimeInterval(61),
                now: preparedAt.addingTimeInterval(61)
            ),
            .invalidate
        )
    }

    func testRejectsStaleTranscriptAndInvalidReadbackTime() {
        let preparedAt = Date(timeIntervalSince1970: 3_000)
        var authorization = projectAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )
        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback,
            at: preparedAt.addingTimeInterval(-1)
        )
        XCTAssertNil(authorization.readbackCompletedAt)

        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback,
            at: preparedAt.addingTimeInterval(1)
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "Codex, confirm",
                transcribedAt: preparedAt.addingTimeInterval(2),
                now: preparedAt.addingTimeInterval(33)
            ),
            .invalidate
        )
    }

    func testUnrelatedAssistantResponseDoesNotArmConfirmation() {
        let preparedAt = Date(timeIntervalSince1970: 4_000)
        var authorization = projectAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )

        authorization.noteReadbackCompleted(
            responseTranscript: "The weather is clear. Say Codex confirm when you are ready.",
            at: preparedAt.addingTimeInterval(1)
        )

        XCTAssertNil(authorization.readbackCompletedAt)
    }

    func testAlteredTaskReadbackDoesNotArmConfirmation() {
        let preparedAt = Date(timeIntervalSince1970: 5_000)
        var authorization = projectAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300)
        )

        authorization.noteReadbackCompleted(
            responseTranscript: "Run the existing unit tests and automatically fix failures. Scope: project.",
            at: preparedAt.addingTimeInterval(1)
        )

        XCTAssertNil(authorization.readbackCompletedAt)
    }

    func testWrongOrAmbiguousScopeDoesNotArmConfirmation() {
        let preparedAt = Date(timeIntervalSince1970: 6_000)
        for response in [
            "\(instruction) Scope: mac.",
            "\(instruction) Scope: project or Mac.",
            "\(instruction)",
        ] {
            var authorization = projectAuthorization(
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

    func testGenericComputerConfirmationsDoNotAuthorizeAssistantTask() {
        let preparedAt = Date(timeIntervalSince1970: 6_500)
        for transcript in [
            "Run it",
            "Do it now",
            "Yes, run it",
            "Please run it",
            "Go ahead and run it",
            "Proceed with that action",
            "Codex, do it now",
            "Confirm",
            "Yes, Codex confirm",
            "Codex confirm the task",
        ] {
            var authorization = projectAuthorization(
                preparedAt: preparedAt,
                expiresAt: preparedAt.addingTimeInterval(300)
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
                .invalidate,
                transcript
            )
        }
    }

    func testExactMacScopeReadbackArmsConfirmation() {
        let preparedAt = Date(timeIntervalSince1970: 7_000)
        var authorization = AssistantTaskConfirmationAuthorization(
            preparedAt: preparedAt,
            expiresAt: preparedAt.addingTimeInterval(300),
            instruction: "Open Finder and show the Downloads folder.",
            scope: .mac
        )

        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback,
            at: preparedAt.addingTimeInterval(1)
        )

        XCTAssertEqual(authorization.readbackCompletedAt, preparedAt.addingTimeInterval(1))
    }

    func testTaskIDPersistsAuthoritativeAndPendingPointersSeparately() {
        let suiteName = "AssistantTaskIDStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AssistantTaskIDStore(defaults: defaults)
        store.remember("  assistant-42  ")
        store.rememberPendingStart(" assistant-99 ")
        XCTAssertEqual(
            AssistantTaskIDStore(defaults: defaults).lastTaskID,
            "assistant-42"
        )
        XCTAssertEqual(
            AssistantTaskIDStore(defaults: defaults).pendingStartTaskID,
            "assistant-99"
        )

        AssistantTaskIDStore(defaults: defaults).clear()
        XCTAssertNil(AssistantTaskIDStore(defaults: defaults).lastTaskID)
        XCTAssertNil(AssistantTaskIDStore(defaults: defaults).pendingStartTaskID)
    }

    func testUnknownNewStartCannotHideOlderAuthoritativeTask() {
        let suiteName = "AssistantTaskIDStoreRecoveryTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AssistantTaskIDStore(defaults: defaults)
        store.remember("assistant-old-lock")
        store.rememberPendingStart("assistant-new-unknown")

        let relaunched = AssistantTaskIDStore(defaults: defaults)
        XCTAssertEqual(relaunched.lastTaskID, "assistant-old-lock")
        XCTAssertEqual(relaunched.pendingStartTaskID, "assistant-new-unknown")
        XCTAssertEqual(
            AssistantTaskIDAuthorization.resolve(
                requested: nil,
                authoritative: relaunched.lastTaskID,
                pendingStart: relaunched.pendingStartTaskID
            ),
            "assistant-new-unknown"
        )
        XCTAssertEqual(
            AssistantTaskIDAuthorization.resolve(
                requested: "assistant-old-lock",
                authoritative: relaunched.lastTaskID,
                pendingStart: relaunched.pendingStartTaskID
            ),
            "assistant-old-lock"
        )
    }

    func testPendingStartPromotionAndDiscardAreBoundToExactID() {
        let suiteName = "AssistantTaskIDStoreTransitionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AssistantTaskIDStore(defaults: defaults)
        store.remember("assistant-old")
        store.rememberPendingStart("assistant-new")

        XCTAssertFalse(store.promotePendingStart("assistant-stale"))
        XCTAssertEqual(store.lastTaskID, "assistant-old")
        XCTAssertEqual(store.pendingStartTaskID, "assistant-new")

        XCTAssertTrue(store.promotePendingStart("assistant-new"))
        XCTAssertEqual(store.lastTaskID, "assistant-new")
        XCTAssertNil(store.pendingStartTaskID)

        store.rememberPendingStart("assistant-never-started")
        XCTAssertFalse(store.clearPendingStart("assistant-stale"))
        XCTAssertEqual(store.pendingStartTaskID, "assistant-never-started")
        XCTAssertTrue(store.clearPendingStart("assistant-never-started"))
        XCTAssertEqual(store.lastTaskID, "assistant-new")
        XCTAssertNil(store.pendingStartTaskID)

        XCTAssertNil(AssistantTaskIDAuthorization.resolve(
            requested: "assistant-attacker",
            authoritative: store.lastTaskID,
            pendingStart: store.pendingStartTaskID
        ))
    }

    func testConcurrentPreparedStatusCannotDiscardAnInFlightStartPointer() {
        XCTAssertEqual(
            AssistantTaskIDAuthorization.pendingStatusAction(
                state: .prepared,
                hasStartedAt: false,
                startRequestInFlight: true,
                isStartAttemptRecovery: false
            ),
            .preserve
        )
        XCTAssertEqual(
            AssistantTaskIDAuthorization.pendingStatusAction(
                state: .prepared,
                hasStartedAt: false,
                startRequestInFlight: true,
                isStartAttemptRecovery: true
            ),
            .clear
        )
    }

    func testRunningStatusAlwaysPromotesThePendingStartPointer() {
        XCTAssertEqual(
            AssistantTaskIDAuthorization.pendingStatusAction(
                state: .running,
                hasStartedAt: true,
                startRequestInFlight: true,
                isStartAttemptRecovery: false
            ),
            .promote
        )
        XCTAssertEqual(
            AssistantTaskIDAuthorization.pendingStatusAction(
                state: .cancelled,
                hasStartedAt: true,
                startRequestInFlight: false,
                isStartAttemptRecovery: false
            ),
            .promote
        )
    }

    func testTaskLockClearRequiresBoundReadbackAndLaterExactPhrase() {
        let armedAt = Date(timeIntervalSince1970: 8_000)
        let summary = "Codex did not confirm cancellation, so the final task state is uncertain."
        var authorization = reconciliationAuthorization(
            armedAt: armedAt,
            expiresAt: armedAt.addingTimeInterval(300),
            summary: summary,
            failureCode: "ASSISTANT_TASK_CANCEL_UNCONFIRMED"
        )

        XCTAssertEqual(
            authorization.decision(
                transcript: "Codex, clear task lock",
                transcribedAt: armedAt.addingTimeInterval(1),
                now: armedAt.addingTimeInterval(1)
            ),
            .invalidate
        )

        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback,
            at: armedAt.addingTimeInterval(2)
        )

        XCTAssertEqual(authorization.readbackCompletedAt, armedAt.addingTimeInterval(2))
        XCTAssertEqual(
            authorization.decision(
                transcript: "CODEX — CLEAR TASK LOCK!",
                transcribedAt: armedAt.addingTimeInterval(3),
                now: armedAt.addingTimeInterval(3)
            ),
            .authorize
        )
    }

    func testTaskLockReadbackRejectsWrongTaskStateSummaryOrMissingWarning() {
        let armedAt = Date(timeIntervalSince1970: 9_000)
        let summary = "The task outcome is uncertain."
        for response in [
            "Task ID assistant-99. Task: \(instruction). Scope: project. State failed. Summary: \(summary) Warning: \(AssistantTaskReconciliationAuthorization.inspectionWarning)",
            "Task ID assistant-42. Task: \(instruction). Scope: project. State completed. Summary: \(summary) Warning: \(AssistantTaskReconciliationAuthorization.inspectionWarning)",
            "Task ID assistant-42. Task: \(instruction). Scope: project. State failed. Summary: The task was cancelled. Warning: \(AssistantTaskReconciliationAuthorization.inspectionWarning)",
            "Task ID assistant-42. Task: \(instruction). Scope: project. State failed. Summary: \(summary)",
            "Task ID assistant-42. Task: Inspect another build. Scope: project. State failed. Summary: \(summary) Warning: \(AssistantTaskReconciliationAuthorization.inspectionWarning)",
            "Task ID assistant-42. Task: \(instruction). Scope: mac. State failed. Summary: \(summary) Warning: \(AssistantTaskReconciliationAuthorization.inspectionWarning)",
        ] {
            var authorization = reconciliationAuthorization(
                armedAt: armedAt,
                expiresAt: armedAt.addingTimeInterval(300),
                summary: summary,
                failureCode: "ASSISTANT_TASK_TIMEOUT_UNCONFIRMED"
            )
            authorization.noteReadbackCompleted(
                responseTranscript: response,
                at: armedAt.addingTimeInterval(1)
            )
            XCTAssertNil(authorization.readbackCompletedAt, response)
        }
    }

    func testGenericPhrasesCannotClearTaskLock() {
        let armedAt = Date(timeIntervalSince1970: 10_000)
        let summary = "The gateway restarted before the task outcome was recorded."
        for transcript in [
            "Clear it",
            "Clear task lock",
            "Codex, clear it",
            "Yes",
            "Codex, run it",
            "Please clear the task lock",
        ] {
            var authorization = reconciliationAuthorization(
                armedAt: armedAt,
                expiresAt: armedAt.addingTimeInterval(300),
                summary: summary,
                failureCode: "GATEWAY_RESTART_OUTCOME_UNCERTAIN"
            )
            authorization.noteReadbackCompleted(
                responseTranscript: authorization.requiredReadback,
                at: armedAt.addingTimeInterval(1)
            )

            XCTAssertEqual(
                authorization.decision(
                    transcript: transcript,
                    transcribedAt: armedAt.addingTimeInterval(2),
                    now: armedAt.addingTimeInterval(2)
                ),
                .invalidate,
                transcript
            )
        }
    }

    func testTaskLockAuthorizationExpiresAndRejectsStaleTranscript() {
        let armedAt = Date(timeIntervalSince1970: 11_000)
        let summary = "The final task state is uncertain."
        var authorization = reconciliationAuthorization(
            armedAt: armedAt,
            expiresAt: armedAt.addingTimeInterval(60),
            summary: summary,
            failureCode: "ASSISTANT_TASK_CANCEL_UNCONFIRMED"
        )
        authorization.noteReadbackCompleted(
            responseTranscript: authorization.requiredReadback,
            at: armedAt.addingTimeInterval(1)
        )

        XCTAssertEqual(
            authorization.decision(
                transcript: "Codex, clear task lock",
                transcribedAt: armedAt.addingTimeInterval(2),
                now: armedAt.addingTimeInterval(33)
            ),
            .invalidate
        )
        XCTAssertEqual(
            authorization.decision(
                transcript: "Codex, clear task lock",
                transcribedAt: armedAt.addingTimeInterval(61),
                now: armedAt.addingTimeInterval(61)
            ),
            .invalidate
        )
    }
}
