import XCTest
@testable import CodexLensKit

final class RealtimeUtteranceBindingTests: XCTestCase {
    func testToolCallKeepsExactInitiatingUtteranceAfterAmbientOverwriteRace() throws {
        var binding = RealtimeUtteranceBinding()
        let directed = try XCTUnwrap(binding.record(
            itemID: "wearer-command",
            transcript: "Codex, open Calculator"
        ))
        XCTAssertTrue(binding.bindResponse(responseID: "response-1", source: directed))

        _ = binding.record(
            itemID: "later-ambient",
            transcript: "That game was great last night"
        )

        let source = binding.bindToolCall(callID: "call-1", responseID: "response-1")
        XCTAssertEqual(source?.itemID, "wearer-command")
        XCTAssertEqual(source?.transcript, "Codex, open Calculator")
        XCTAssertEqual(binding.source(callID: "call-1"), directed)
    }

    func testToolCallWithoutBoundSourceFailsClosed() {
        var binding = RealtimeUtteranceBinding()
        _ = binding.record(itemID: "ambient", transcript: "Open the door")

        XCTAssertNil(binding.bindToolCall(
            callID: "unbound-call",
            responseID: "unknown-response"
        ))
        XCTAssertNil(binding.source(callID: "unbound-call"))
    }

    func testBoundResponseStoresValueSnapshotAcrossLaterItemRevision() throws {
        var binding = RealtimeUtteranceBinding()
        let original = try XCTUnwrap(binding.record(
            itemID: "item-1",
            transcript: "Run the project tests"
        ))
        XCTAssertTrue(binding.bindResponse(responseID: "response-1", source: original))
        _ = binding.record(itemID: "item-1", transcript: "Delete the project")

        let source = binding.bindToolCall(callID: "call-1", responseID: "response-1")
        XCTAssertEqual(source?.transcript, "Run the project tests")
    }
}

final class TaskTakingSpeechPolicyTests: XCTestCase {
    func testAcknowledgmentRequiresRunningTask() {
        XCTAssertEqual(TaskTakingSpeechPolicy.taskStatusSpeech(state: .running), TaskTakingSpeechPolicy.immediateAcknowledgment)
        for state: AssistantTaskState in [.failed, .blocked, .prepared, .expired, .cancelled, .completed] {
            XCTAssertNotEqual(TaskTakingSpeechPolicy.taskStatusSpeech(state: state), TaskTakingSpeechPolicy.immediateAcknowledgment)
        }
    }
    func testAddressWordIsRemovedWithoutModelParaphrase() {
        XCTAssertEqual(
            TaskTakingSpeechPolicy.authoritativeTaskText(
                from: "  Codex, open Calculator please.  "
            ),
            "open Calculator please."
        )
        XCTAssertEqual(
            TaskTakingSpeechPolicy.authoritativeTaskText(
                from: "Code X — Run the project tests"
            ),
            "Run the project tests"
        )
        XCTAssertEqual(
            TaskTakingSpeechPolicy.authoritativeTaskText(
                from: "Open Calculator"
            ),
            "Open Calculator"
        )
        XCTAssertNil(TaskTakingSpeechPolicy.authoritativeTaskText(from: "Codex"))
    }

    func testClearComputerMutationsUseTextOnlyAssistantTaskRoute() {
        for transcript in [
            "Codex, open Calculator",
            "Code X, run the project tests",
            "Please close the current window",
            "Install Firefox",
            "Type hello in the browser",
            "Move those files into the project folder",
            "Complete the targeted task",
            "Start a new Codex thread",
            "Codex, put that in the other window",
            "Hey Codex, bring Telegram forward",
            "Codex, maximize it",
            "Codex, handle that task",
            "Codex, do that on my computer",
            "Paste that into Word",
        ] {
            XCTAssertTrue(
                TaskTakingSpeechPolicy.requiresAssistantTask(transcript),
                transcript
            )
        }
    }

    func testAmbientPhysicalAndTextingSpeechDoNotUseAssistantTaskRoute() {
        for transcript in [
            "Open the door",
            "Start the car",
            "That game was great last night",
            "Text Alex that I am home",
            "Send a text to Alex",
            "Bring the groceries inside",
            "Put that on the table",
            "Codex, do you know the time?",
        ] {
            XCTAssertFalse(
                TaskTakingSpeechPolicy.requiresAssistantTask(transcript),
                transcript
            )
        }
    }

    func testSafeStartedReadbackIsOneExactShortSentence() {
        XCTAssertEqual(
            TaskTakingSpeechPolicy.safeStartedReadback(task: "Open Calculator"),
            "Got it, I'm doing that now."
        )
        XCTAssertEqual(
            TaskTakingSpeechPolicy.safeStartedReadback(task: "Run the tests."),
            "Got it, I'm doing that now."
        )
        XCTAssertTrue(TaskTakingSpeechPolicy.acceptsExactSpeech(
            "Got it, I'm doing that now.",
            expected: "Got it, I'm doing that now."
        ))
        XCTAssertFalse(TaskTakingSpeechPolicy.acceptsExactSpeech(
            "Sure. Got it, I'm doing that now.",
            expected: "Got it, I'm doing that now."
        ))
    }

    func testPhoneSelectsProjectScopeOnlyForUnmistakableRepositoryWork() {
        XCTAssertTrue(TaskTakingSpeechPolicy.prefersProjectScope("Codex, run the project tests"))
        XCTAssertTrue(TaskTakingSpeechPolicy.prefersProjectScope("debug this Xcode build"))
        XCTAssertFalse(TaskTakingSpeechPolicy.prefersProjectScope("open Settings"))
        XCTAssertFalse(TaskTakingSpeechPolicy.prefersProjectScope("type this into the Codex app"))
    }

    func testDictatedTextAndDesktopAppNamesCannotSelectProjectScope() {
        for request in [
            "Can you open a new text edit document and type Glasses Test 1?",
            "Could open a new TextEdit document and type Glasses test 1.",
            "Go to open a new text edit document and type glasses test 1.",
            "Codex, type run the project tests into TextEdit",
            "Add a new line that says build code test",
            "Open Xcode",
            "Click the Build button in Xcode",
        ] {
            XCTAssertFalse(TaskTakingSpeechPolicy.prefersProjectScope(request), request)
        }
        for request in ["Please run the tests", "Can you fix the failing tests", "Review this repository", "Compile this project"] {
            XCTAssertTrue(TaskTakingSpeechPolicy.prefersProjectScope(request), request)
        }
    }

    func testStreamingSpeechGuardRejectsElaborateFillerImmediately() {
        let expected = "Got it, I'm doing that now."
        XCTAssertTrue(TaskTakingSpeechPolicy.isValidSpeechPrefix(
            "Got",
            expected: expected
        ))
        XCTAssertTrue(TaskTakingSpeechPolicy.isValidSpeechPrefix(
            "Got it, I'm doing",
            expected: expected
        ))
        XCTAssertFalse(TaskTakingSpeechPolicy.isValidSpeechPrefix(
            "Sure, I can do that",
            expected: expected
        ))
        XCTAssertFalse(TaskTakingSpeechPolicy.isValidSpeechPrefix(
            "Got it, I'm doing that now. Let me know when you need anything else.",
            expected: expected
        ))
    }
}
