import XCTest
@testable import CodexLensKit

final class ExplicitComputerConfirmationTests: XCTestCase {
    func testAcceptsOnlyAddressedConfirmationAndTightTranscriptionVariants() {
        XCTAssertTrue(ExplicitComputerConfirmation.accepts("Codex, confirm."))
        XCTAssertTrue(ExplicitComputerConfirmation.accepts("Codec confirm!"))
        XCTAssertTrue(ExplicitComputerConfirmation.accepts("Code X — confirm"))
    }

    func testRejectsGenericOrEmbeddedAgreement() {
        XCTAssertFalse(ExplicitComputerConfirmation.accepts("Yes"))
        XCTAssertFalse(ExplicitComputerConfirmation.accepts("Okay"))
        XCTAssertFalse(ExplicitComputerConfirmation.accepts("Confirm"))
        XCTAssertFalse(ExplicitComputerConfirmation.accepts("Run it"))
        XCTAssertFalse(ExplicitComputerConfirmation.accepts("Codex, yes"))
        XCTAssertFalse(ExplicitComputerConfirmation.accepts("Codex, confirm the install"))
        XCTAssertFalse(ExplicitComputerConfirmation.accepts("Please Codex confirm"))
        XCTAssertFalse(ExplicitComputerConfirmation.accepts("He said run it yesterday"))
        XCTAssertFalse(ExplicitComputerConfirmation.accepts("Do not run it"))
    }
}

final class ExplicitAssistantStopCommandTests: XCTestCase {
    func testAcceptsOnlyExactAddressedStopPhrases() {
        XCTAssertTrue(ExplicitAssistantStopCommand.accepts("Codex stop"))
        XCTAssertTrue(ExplicitAssistantStopCommand.accepts("Codex, stop!"))
        XCTAssertTrue(ExplicitAssistantStopCommand.accepts("Codec stop."))
        XCTAssertTrue(ExplicitAssistantStopCommand.accepts("Code X stop"))
        XCTAssertTrue(ExplicitAssistantStopCommand.accepts("Stop Codex."))
        XCTAssertTrue(ExplicitAssistantStopCommand.accepts("Stop codec"))
        XCTAssertTrue(ExplicitAssistantStopCommand.accepts("Stop code X"))
        XCTAssertTrue(ExplicitAssistantStopCommand.accepts("STOP — CODEX"))
    }

    func testRejectsAmbientOrExpandedStopPhrases() {
        for transcript in [
            "stop",
            "please stop",
            "Codex please stop",
            "Codex stop the music",
            "I said Codex stop",
            "do not stop Codex",
            "stop codes",
        ] {
            XCTAssertFalse(ExplicitAssistantStopCommand.accepts(transcript), transcript)
        }
    }

    func testStreamingSegmentsRecognizeSplitCommand() {
        var command = StreamingAssistantStopCommand()
        XCTAssertFalse(command.accepts(
            itemID: "item-1", segmentID: "segment-1", text: "Codex", start: 0
        ))
        XCTAssertTrue(command.accepts(
            itemID: "item-1", segmentID: "segment-2", text: "stop", start: 0.5
        ))
    }

    func testStreamingSegmentsRecognizeCodeXASRVariant() {
        var command = StreamingAssistantStopCommand()
        XCTAssertFalse(command.accepts(
            itemID: "item-variant", segmentID: "segment-1", text: "Code X", start: 0
        ))
        XCTAssertTrue(command.accepts(
            itemID: "item-variant", segmentID: "segment-2", text: "stop", start: 0.4
        ))
    }

    func testStreamingRevisionReplacesPriorPartialText() {
        var command = StreamingAssistantStopCommand()
        XCTAssertFalse(command.accepts(
            itemID: "item-1", segmentID: "segment-1", text: "Code", start: 0
        ))
        XCTAssertTrue(command.accepts(
            itemID: "item-1", segmentID: "segment-1", text: "Codex stop", start: 0
        ))
    }

    func testStreamingCommandIsBoundToOneTranscriptItem() {
        var command = StreamingAssistantStopCommand()
        XCTAssertFalse(command.accepts(
            itemID: "item-1", segmentID: "segment-1", text: "Codex", start: 0
        ))
        XCTAssertFalse(command.accepts(
            itemID: "item-2", segmentID: "segment-1", text: "stop", start: 0
        ))
        command.remove(itemID: "item-1")
        XCTAssertFalse(command.accepts(
            itemID: "item-1", segmentID: "segment-2", text: "stop", start: 0.5
        ))
    }
}
