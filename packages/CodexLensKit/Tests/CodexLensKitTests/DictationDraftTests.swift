import XCTest
@testable import CodexLensKit

final class DictationDraftTests: XCTestCase {
    func testPartialsReplaceWithoutDuplicatingWords() {
        var draft = DictationDraft(text: "Please")
        let id = draft.beginSegment()
        draft.update("open", segment: id)
        draft.update("open Calculator", segment: id)
        XCTAssertEqual(draft.text, "Please open Calculator")
    }
    func testLateResultCannotAlterStoppedDraft() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.update("Open Calculator", segment: id)
        draft.finishSegment()
        XCTAssertFalse(draft.update("Send something else", segment: id))
        XCTAssertEqual(draft.text, "Open Calculator")
    }
    func testRecognizerRestartPreservesEarlierTextAndIgnoresOldCallbacks() {
        var draft = DictationDraft(text: "Type:\n")
        let first = draft.beginSegment()
        draft.update("Hello", segment: first)
        let second = draft.beginSegment()
        XCTAssertFalse(draft.update("wrong", segment: first))
        draft.update("world", segment: second)
        XCTAssertEqual(draft.text, "Type:\nHello world")
    }

    func testObservedDeviceSequenceRetainsThreePhrasesAndRepeatedEOFFinalOnce() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        // The device emits untimed partials, timed utterance boundaries with
        // isFinal=false, then repeats the last timed boundary at task EOF.
        let phrases = ["First complete phrase.", "Second complete phrase.", "Third complete phrase."]
        let times = [(1.95, 4.02), (6.09, 8.28), (10.32, 12.78)]
        for index in phrases.indices {
            draft.update(String(phrases[index].prefix(1)), segment: id)
            if index > 0 { XCTAssertTrue(draft.text.hasPrefix(phrases[0])) }
            draft.update(phrases[index], segment: id)
            XCTAssertEqual(draft.finishUtterance(phrases[index], segment: id,
                                                start: times[index].0, end: times[index].1), .committed)
        }
        XCTAssertEqual(draft.finishUtterance(phrases[2], segment: id, start: 10.32, end: 12.78), .revised)
        XCTAssertEqual(draft.finalizedUtteranceCount, 3)
        XCTAssertEqual(draft.text, phrases.joined(separator: " "))
        draft.finishSegment()
        XCTAssertEqual(draft.text, phrases.joined(separator: " "))
        XCTAssertEqual(draft.finalizedUtteranceCount, 0)
    }

    func testCurrentPhraseHypothesesReviseWithoutErasingFinalizedWords() {
        var draft = DictationDraft(text: "Type:\n")
        let id = draft.beginSegment()
        draft.finishUtterance("Keep this sentence.", segment: id, start: 1, end: 2)
        draft.update("Open Calculator", segment: id)
        draft.update("Open Calendar", segment: id)
        XCTAssertEqual(draft.text, "Type:\nKeep this sentence. Open Calendar")
    }

    func testIdenticalWordsAtDifferentAudioRangesAreGenuineRepetitions() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("Very very good.", segment: id, start: 1, end: 2)
        draft.update("Very very good.", segment: id)
        draft.finishUtterance("Very very good.", segment: id, start: 3, end: 4)
        XCTAssertEqual(draft.text, "Very very good. Very very good.")
        XCTAssertEqual(draft.finalizedUtteranceCount, 2)
    }

    func testSameRangeFinalRevisesPunctuationWithoutDuplicatingUtterance() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("Hello world", segment: id, start: 1, end: 2)
        XCTAssertEqual(draft.finishUtterance("Hello, world!", segment: id, start: 1, end: 2), .revised)
        XCTAssertEqual(draft.text, "Hello, world!")
        XCTAssertEqual(draft.finalizedUtteranceCount, 1)
    }

    func testLatePriorFinalPreservesNewerUntimedHypothesis() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("First phrase", segment: id, start: 1, end: 2)
        draft.finishUtterance("Second phrase.", segment: id, start: 4, end: 5)
        draft.update("A third phrase is growing", segment: id)
        XCTAssertEqual(draft.finishUtterance("First phrase.", segment: id, start: 1, end: 2), .revised)
        XCTAssertEqual(draft.text, "First phrase. Second phrase. A third phrase is growing")
        XCTAssertEqual(draft.finishUtterance("Second phrase.", segment: id, start: 4, end: 5), .revised)
        XCTAssertEqual(draft.text, "First phrase. Second phrase. A third phrase is growing")
    }

    func testCumulativeFinalReplacesWholeCoveredPhrasesWithoutDuplication() {
        var draft = DictationDraft(text: "User prefix:")
        let id = draft.beginSegment()
        draft.finishUtterance("First phrase.", segment: id, start: 1, end: 2)
        draft.finishUtterance("Second phrase.", segment: id, start: 4, end: 5)
        XCTAssertEqual(draft.finishUtterance("First phrase. Second phrase!", segment: id,
                                            start: 1, end: 5), .revised)
        XCTAssertEqual(draft.text, "User prefix: First phrase. Second phrase!")
        XCTAssertEqual(draft.finalizedUtteranceCount, 1)
        XCTAssertEqual(draft.finishUtterance("First phrase. Second phrase!", segment: id,
                                            start: 1, end: 5), .revised)
        XCTAssertEqual(draft.text, "User prefix: First phrase. Second phrase!")
    }

    func testCumulativePriorFinalPreservesNewUntimedPartial() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("First.", segment: id, start: 1, end: 2)
        draft.finishUtterance("Second.", segment: id, start: 4, end: 5)
        draft.update("Third", segment: id)
        draft.finishUtterance("First! Second!", segment: id, start: 1, end: 5)
        XCTAssertEqual(draft.text, "First! Second! Third")
    }

    func testCumulativeExtensionCannotProveItCoversUntimedCurrentHypothesis() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("First.", segment: id, start: 1, end: 2)
        draft.update("Second", segment: id)
        let before = draft
        XCTAssertEqual(draft.finishUtterance("First. Second.", segment: id, start: 1, end: 5), .ambiguous)
        XCTAssertEqual(draft, before)
        XCTAssertEqual(draft.text, "First. Second")
    }

    func testCumulativeExtensionWithoutActiveHypothesisCanReplaceKnownCoverage() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("First.", segment: id, start: 1, end: 2)
        XCTAssertEqual(draft.finishUtterance("First. Second.", segment: id, start: 1, end: 5), .revised)
        XCTAssertEqual(draft.text, "First. Second.")
    }

    func testSmallTimestampExtensionCannotEraseNewerHypothesis() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("Old phrase.", segment: id, start: 1, end: 2)
        draft.update("New words", segment: id)
        let before = draft
        XCTAssertEqual(draft.finishUtterance("Old phrase!", segment: id, start: 1, end: 2.01), .ambiguous)
        XCTAssertEqual(draft, before)
        XCTAssertEqual(draft.text, "Old phrase. New words")
    }

    func testCumulativeFinalCanReplaceSubsetWithoutErasingLaterPhrase() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("First.", segment: id, start: 1, end: 2)
        draft.finishUtterance("Second.", segment: id, start: 4, end: 5)
        draft.finishUtterance("Third.", segment: id, start: 7, end: 8)
        draft.finishUtterance("First! Second!", segment: id, start: 1, end: 5)
        XCTAssertEqual(draft.text, "First! Second! Third.")
        XCTAssertEqual(draft.finalizedUtteranceCount, 2)
    }

    func testPartialOverlapPreservesAllKnownTextAndReportsAmbiguity() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("Keep this complete phrase.", segment: id, start: 1, end: 3)
        draft.update("And this hypothesis", segment: id)
        let before = draft
        XCTAssertEqual(draft.finishUtterance("Unsafe overlap", segment: id, start: 2, end: 5), .ambiguous)
        XCTAssertEqual(draft, before)
        XCTAssertEqual(draft.finishUtterance("Partial old phrase", segment: id, start: 1, end: 2), .ambiguous)
        XCTAssertEqual(draft, before)
    }

    func testEmptyPartialAndFinalDoNotEraseTextOrConsumeHypothesis() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("Keep this.", segment: id, start: 1, end: 2)
        draft.update("Keep this too", segment: id)
        let before = draft
        for empty in ["", " ", "\n\t"] {
            XCTAssertFalse(draft.update(empty, segment: id))
            XCTAssertEqual(draft.finishUtterance(empty, segment: id, start: 4, end: 5), .ignored)
            XCTAssertEqual(draft, before)
        }
    }

    func testUnknownBoundaryAfterEarlierPhrasePreservesNewRepeatedPartial() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.update("Again", segment: id)
        XCTAssertEqual(draft.finishUtterance("Again.", segment: id), .committed)
        draft.update("Again", segment: id)
        let before = draft
        XCTAssertEqual(draft.finishUtterance("Again.", segment: id), .ambiguous)
        XCTAssertEqual(draft, before)
        XCTAssertEqual(draft.text, "Again. Again")
    }

    func testUnknownLateFinalCannotEraseANewerPartialAfterTimedPhrase() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("Old phrase.", segment: id, start: 1, end: 2)
        draft.update("New words", segment: id)
        let before = draft
        XCTAssertEqual(draft.finishUtterance("Old phrase.", segment: id), .ambiguous)
        XCTAssertEqual(draft, before)
        XCTAssertEqual(draft.text, "Old phrase. New words")
    }

    func testUnknownFinalWithoutNewPartialIsAmbiguousRatherThanDuplicated() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        XCTAssertEqual(draft.finishUtterance("First final.", segment: id), .committed)
        let before = draft
        XCTAssertEqual(draft.finishUtterance("First final.", segment: id), .ambiguous)
        XCTAssertEqual(draft, before)
        XCTAssertEqual(draft.finishUtterance("A different possible phrase.", segment: id), .ambiguous)
        XCTAssertEqual(draft, before)
    }

    func testUnknownEarlierTimingPreventsUnsafeTimedCumulativeReplacement() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("Earlier unknown range.", segment: id)
        draft.update("Current hypothesis", segment: id)
        let before = draft
        XCTAssertEqual(draft.finishUtterance("Possibly cumulative", segment: id, start: 1, end: 5), .ambiguous)
        XCTAssertEqual(draft, before)
    }

    func testInvalidOrZeroDurationFinalTimingIsNotAnUtteranceIdentity() {
        let invalid: [(Double?, Double?)] = [
            (0, 0), (2, 1), (-1, 2), (.nan, 2), (1, .infinity), (nil, 2), (1, nil)
        ]
        for (start, end) in invalid {
            var draft = DictationDraft()
            let id = draft.beginSegment()
            draft.update("Keep this hypothesis", segment: id)
            let before = draft
            XCTAssertEqual(draft.finishUtterance("Unknown range", segment: id, start: start, end: end), .ambiguous)
            XCTAssertEqual(draft, before)
        }
    }

    func testDisjointButEarlierUnexpectedFinalDoesNotReorderKnownSpeech() {
        var draft = DictationDraft()
        let id = draft.beginSegment()
        draft.finishUtterance("Known later phrase.", segment: id, start: 4, end: 5)
        let before = draft
        XCTAssertEqual(draft.finishUtterance("Unidentified earlier phrase", segment: id, start: 1, end: 2), .ambiguous)
        XCTAssertEqual(draft, before)
    }

    func testTaskRotationPreservesFinalizedAndActivePhrasesAndRejectsOldFinals() {
        var draft = DictationDraft(text: "Typed prefix.")
        let old = draft.beginSegment()
        draft.finishUtterance("Finalized phrase.", segment: old, start: 1, end: 2)
        draft.update("Unfinished phrase", segment: old)
        let current = draft.beginSegment()
        let before = draft
        XCTAssertEqual(draft.finishUtterance("Late old final", segment: old, start: 1, end: 2), .ignored)
        XCTAssertFalse(draft.update("Late old partial", segment: old))
        XCTAssertEqual(draft, before)
        draft.finishUtterance("New task phrase.", segment: current, start: 0, end: 1)
        draft.finishSegment()
        XCTAssertEqual(draft.text, "Typed prefix. Finalized phrase. Unfinished phrase New task phrase.")
        XCTAssertEqual(draft.finishUtterance("Late stopped final", segment: current, start: 0, end: 1), .ignored)
    }
}
