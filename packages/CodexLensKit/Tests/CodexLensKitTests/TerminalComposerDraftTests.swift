import XCTest
@testable import CodexLensKit

final class TerminalComposerDraftTests: XCTestCase {
    func testQueuedDictationStartMustStillOwnTheDraft() {
        var draft = TerminalComposerDraft()
        let first = UUID(), second = UUID()
        XCTAssertFalse(draft.ownsDictation(id: first))
        draft.beginDictation(id: first)
        XCTAssertTrue(draft.ownsDictation(id: first))
        XCTAssertFalse(draft.ownsDictation(id: second))
        draft.applyDictation(.init(id: first, text: "Recognized words"))
        XCTAssertTrue(draft.ownsDictation(id: first))
        draft.edit("Manual correction before queued start")
        XCTAssertFalse(draft.ownsDictation(id: first))
        draft.beginDictation(id: second)
        XCTAssertFalse(draft.ownsDictation(id: first))
        XCTAssertTrue(draft.ownsDictation(id: second))
        draft.endDictation(id: first)
        XCTAssertTrue(draft.ownsDictation(id: second))
        draft.endDictation(id: second)
        XCTAssertFalse(draft.ownsDictation(id: second))
    }

    func testSubmittingCancelsQueuedDictationStartOwnership() {
        var draft = TerminalComposerDraft()
        let id = UUID()
        draft.beginDictation(id: id)
        XCTAssertTrue(draft.ownsDictation(id: id))
        draft.submitted(id: "explicit-send")
        XCTAssertFalse(draft.ownsDictation(id: id))
    }

    func testDictationPartialsAndFinalOwnTheirSuccessiveRevisions() {
        var draft = TerminalComposerDraft()
        draft.edit("Please")
        let id = UUID()
        XCTAssertEqual(draft.beginDictation(id: id), "Please")
        XCTAssertTrue(draft.applyDictation(.init(id: id, text: "Please open")))
        XCTAssertTrue(draft.applyDictation(.init(id: id, text: "Please open Notes.")))
        XCTAssertEqual(draft.text, "Please open Notes.")
        draft.endDictation(id: id)
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: "Late replacement")))
        XCTAssertEqual(draft.text, "Please open Notes.")
    }

    func testManualCorrectionWinsOverLatePartialAndFinal() {
        var draft = TerminalComposerDraft()
        let id = UUID()
        draft.beginDictation(id: id)
        draft.applyDictation(.init(id: id, text: "Open nodes"))
        draft.edit("Open Notes")
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: "Open nodes please")))
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: "Open nodes.")))
        XCTAssertEqual(draft.text, "Open Notes")
    }

    func testManualEditDuringDictationStartupRejectsOldSeedAndFirstResult() {
        var draft = TerminalComposerDraft()
        draft.edit("Original")
        let id = UUID()
        let seed = draft.beginDictation(id: id)
        // Permission/route startup is asynchronous; typing retains ownership.
        draft.edit("My correction")
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: seed)))
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: seed + " new words")))
        XCTAssertEqual(draft.text, "My correction")
    }

    func testEditingAwayAndBackDoesNotRestoreDictationOwnership() {
        var draft = TerminalComposerDraft()
        let id = UUID()
        draft.beginDictation(id: id)
        draft.applyDictation(.init(id: id, text: "Keep this"))
        draft.edit("Different")
        draft.edit("Keep this")
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: "Overwrite this")))
        XCTAssertEqual(draft.text, "Keep this")
    }

    func testExplicitSameTextEditAlsoEndsDictationOwnership() {
        var draft = TerminalComposerDraft()
        let id = UUID()
        draft.beginDictation(id: id)
        draft.applyDictation(.init(id: id, text: "Keep this"))
        draft.edit("Keep this")
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: "Late words")))
        XCTAssertEqual(draft.text, "Keep this")
    }

    func testOldDictationTokenAndEndCannotClaimOrStopNewDictation() {
        var draft = TerminalComposerDraft()
        let first = UUID(), second = UUID()
        draft.beginDictation(id: first)
        draft.applyDictation(.init(id: first, text: "First"))
        draft.endDictation(id: first)
        XCTAssertEqual(draft.beginDictation(id: second), "First")
        XCTAssertFalse(draft.applyDictation(.init(id: first, text: "Old queued final")))
        draft.endDictation(id: first)
        XCTAssertTrue(draft.applyDictation(.init(id: second, text: "First and second")))
        XCTAssertEqual(draft.text, "First and second")
    }

    func testUnknownDictationTokenDoesNotInvalidateCurrentOwner() {
        var draft = TerminalComposerDraft()
        let id = UUID()
        draft.beginDictation(id: id)
        XCTAssertFalse(draft.applyDictation(.init(id: UUID(), text: "Wrong owner")))
        XCTAssertTrue(draft.applyDictation(.init(id: id, text: "Current owner")))
        XCTAssertEqual(draft.text, "Current owner")
    }

    func testSendAcceptanceCannotBeRepopulatedByQueuedDictation() {
        var draft = TerminalComposerDraft()
        let id = UUID()
        draft.beginDictation(id: id)
        draft.applyDictation(.init(id: id, text: "Open Notes"))
        draft.submitted(id: "send")
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: "Late before receipt")))
        XCTAssertTrue(draft.acknowledge(.init(id: "send")))
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: "Late after receipt")))
        XCTAssertEqual(draft.text, "")
    }

    func testOldSendAcceptancePreservesNewDictationWhileItStarts() {
        var draft = TerminalComposerDraft()
        draft.edit("Seed text")
        draft.submitted(id: "older-send")
        let id = UUID()
        draft.beginDictation(id: id)
        XCTAssertTrue(draft.acknowledge(.init(id: "older-send")))
        XCTAssertEqual(draft.text, "Seed text")
        XCTAssertTrue(draft.applyDictation(.init(id: id, text: "Seed text continued")))
        XCTAssertEqual(draft.text, "Seed text continued")
    }

    func testRejectedSendDoesNotRestoreOldDictationOwnership() {
        var draft = TerminalComposerDraft()
        let id = UUID()
        draft.beginDictation(id: id)
        draft.applyDictation(.init(id: id, text: "Preserve this"))
        draft.submitted(id: "send")
        draft.rejected(id: "send")
        XCTAssertFalse(draft.applyDictation(.init(id: id, text: "Old final")))
        XCTAssertEqual(draft.text, "Preserve this")
    }

    func testAtomicDictationUpdateEqualityIncludesItsOwner() {
        let first = UUID(), second = UUID()
        XCTAssertNotEqual(DictationTranscriptUpdate(id: first, text: "Same words"),
                          DictationTranscriptUpdate(id: second, text: "Same words"))
        XCTAssertEqual(DictationTranscriptUpdate(id: first, text: "Same words"),
                       DictationTranscriptUpdate(id: first, text: "Same words"))
    }

    func testAcceptanceClearsTheSubmittedDraft() {
        var draft = TerminalComposerDraft()
        draft.edit("Remember amber")
        draft.submitted(id: "first")
        XCTAssertTrue(draft.acknowledge(.init(id: "first")))
        XCTAssertEqual(draft.text, "")
    }
    func testLateStreamAcceptanceAfterAnUncertainSendClearsTheDraft() {
        var draft = TerminalComposerDraft()
        draft.edit("Describe this")
        draft.submitted(id: "uncertain")
        // A timeout is not a rejection. Keep the original submission for SSE recovery.
        XCTAssertEqual(draft.text, "Describe this")
        draft.submitted(id: "uncertain")
        XCTAssertTrue(draft.acknowledge(.init(id: "uncertain")))
        XCTAssertEqual(draft.text, "")
    }
    func testRejectionPreservesTextAndCannotBeMistakenForAcceptance() {
        var draft = TerminalComposerDraft()
        draft.edit("Open Calculator")
        draft.submitted(id: "rejected")
        draft.rejected(id: "rejected")
        XCTAssertEqual(draft.text, "Open Calculator")
        XCTAssertFalse(draft.acknowledge(.init(id: "rejected")))
        XCTAssertEqual(draft.text, "Open Calculator")
    }
    func testTypingDuringSendSurvivesAcceptance() {
        var draft = TerminalComposerDraft()
        draft.edit("First")
        draft.submitted(id: "first")
        draft.edit("My next command")
        XCTAssertTrue(draft.acknowledge(.init(id: "first")))
        XCTAssertEqual(draft.text, "My next command")
    }
    func testEditingAwayAndBackToIdenticalTextStillPreservesTheNewRevision() {
        var draft = TerminalComposerDraft()
        draft.edit("Again")
        draft.submitted(id: "first")
        draft.edit("")
        draft.edit("Again")
        draft.submitted(id: "first") // Explicit retry does not reset ownership.
        draft.acknowledge(.init(id: "first"))
        XCTAssertEqual(draft.text, "Again")
    }
    func testDuplicateAndOlderReceiptsDoNotClearAnotherDraft() {
        var draft = TerminalComposerDraft()
        draft.edit("First")
        draft.submitted(id: "first")
        draft.acknowledge(.init(id: "first"))
        draft.edit("Next")
        draft.submitted(id: "second")
        XCTAssertFalse(draft.acknowledge(.init(id: "first")))
        XCTAssertEqual(draft.text, "Next")
        XCTAssertTrue(draft.acknowledge(.init(id: "second")))
        XCTAssertEqual(draft.text, "")
    }
    func testOnlyAcknowledgedAttachmentsAreRemoved() {
        var draft = TerminalComposerDraft()
        let sent = UUID(), addedLater = UUID()
        var attachments = [sent, addedLater]
        draft.edit("Photo")
        draft.submitted(id: "photo")
        draft.edit("Next photo")
        let receipt = TerminalCommandReceipt(id: "photo", attachmentIDs: [sent])
        if draft.acknowledge(receipt) {
            attachments.removeAll { receipt.attachmentIDs.contains($0) }
        }
        XCTAssertEqual(attachments, [addedLater])
        XCTAssertEqual(draft.text, "Next photo")
    }
}
