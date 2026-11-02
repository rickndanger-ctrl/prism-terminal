import XCTest
@testable import CodexLensKit

final class VisualFrameSelectionTests: XCTestCase {
    func testOrdinaryPhotoOrLookUsesOneFastFrameWithoutWakeWord() {
        let requests = [
            "Take a pic",
            "Look at this",
            "Can you inspect what I'm looking at?",
        ]

        for request in requests {
            XCTAssertEqual(
                VisualCapturePlanner.plan(request: request, requestedMode: nil),
                VisualCapturePlan(mode: .fast, frameCount: 1),
                request
            )
        }
    }

    func testExplicitTextReadingUsesTwoHighQualityCandidates() {
        let requests = [
            "Read this screen",
            "What does this text say?",
            "Inspect this code",
            "Read this document",
        ]

        for request in requests {
            XCTAssertEqual(
                VisualCapturePlanner.plan(request: request, requestedMode: nil),
                VisualCapturePlan(mode: .read, frameCount: 2),
                request
            )
        }
    }

    func testOrdinaryRequestStaysFastEvenWhenModelAsksForRead() {
        XCTAssertEqual(
            VisualCapturePlanner.plan(request: "Take a pic", requestedMode: "read"),
            VisualCapturePlan(mode: .fast, frameCount: 1)
        )
    }

    func testNaturalReadingPhrasesUseOCRWithoutLiteralReadKeyword() {
        for request in [
            "Codex, what does this say?",
            "What does that say?",
            "What do these say?",
            "What do those say?",
            "What does it say?",
            "What's written here?",
            "What’s printed on this?",
            "What is written there?",
        ] {
            for mode: String? in [nil, "read", "fast"] {
                XCTAssertEqual(
                    VisualCapturePlanner.plan(request: request, requestedMode: mode),
                    VisualCapturePlan(mode: .read, frameCount: 2),
                    "\(request), mode=\(mode ?? "nil")"
                )
            }
        }
    }

    func testConversationAndOrdinaryLooksDoNotTriggerReadingProfile() {
        for request in [
            "What did he say?",
            "What does she say?",
            "Tell me what you see",
            "Codex, take a pic",
            "What is this?",
        ] {
            XCTAssertEqual(
                VisualCapturePlanner.plan(request: request, requestedMode: "read"),
                VisualCapturePlan(mode: .fast, frameCount: 1),
                request
            )
        }
    }

    func testNaturalReadingPhrasePreservesExplicitSpeedAndCarefulChoices() {
        XCTAssertEqual(
            VisualCapturePlanner.plan(request: "Quickly, what does this say?", requestedMode: "fast"),
            VisualCapturePlan(mode: .fast, frameCount: 1)
        )
        XCTAssertEqual(
            VisualCapturePlanner.plan(request: "What does this say?", requestedMode: "careful"),
            VisualCapturePlan(mode: .careful, frameCount: 3)
        )
    }

    func testOrdinaryPictureAndDescribeRequestStaysOnSingleFastFrame() {
        XCTAssertEqual(
            VisualCapturePlanner.plan(
                request: "Codex, take a picture and tell me what you see.",
                requestedMode: "read"
            ),
            VisualCapturePlan(mode: .fast, frameCount: 1)
        )
    }

    func testExplicitQuickTextRequestMayTradeQualityForSpeed() {
        XCTAssertEqual(
            VisualCapturePlanner.plan(request: "Quickly read this sign", requestedMode: "fast"),
            VisualCapturePlan(mode: .fast, frameCount: 1)
        )
    }

    func testCarefulModeIsBoundedToThreeFrames() {
        XCTAssertEqual(
            VisualCapturePlanner.plan(request: "Take several photos", requestedMode: "careful"),
            VisualCapturePlan(mode: .careful, frameCount: 3)
        )
    }

    func testCredibleOCRBeatsAByteHeavierNonTextFrame() throws {
        let noisyLargeFrame = VisualFrameQuality(
            recognizedCharacterCount: 0,
            recognizedLineCount: 0,
            averageTextConfidence: 0,
            normalizedSharpness: 0.20,
            pixelCount: 1_555_200,
            encodedByteCount: 150_000
        )
        let readableFrame = VisualFrameQuality(
            recognizedCharacterCount: 96,
            recognizedLineCount: 7,
            averageTextConfidence: 0.82,
            normalizedSharpness: 0.08,
            pixelCount: 1_555_200,
            encodedByteCount: 112_000
        )

        XCTAssertEqual(
            try XCTUnwrap(VisualFrameSelector.bestIndex(in: [noisyLargeFrame, readableFrame])),
            1
        )
    }

    func testMoreReliableTextWinsInsteadOfRawSharpnessAlone() throws {
        let sharperButBarelyReadable = VisualFrameQuality(
            recognizedCharacterCount: 8,
            recognizedLineCount: 1,
            averageTextConfidence: 0.43,
            normalizedSharpness: 0.19,
            pixelCount: 1_555_200,
            encodedByteCount: 145_000
        )
        let textRichFrame = VisualFrameQuality(
            recognizedCharacterCount: 180,
            recognizedLineCount: 11,
            averageTextConfidence: 0.78,
            normalizedSharpness: 0.07,
            pixelCount: 1_555_200,
            encodedByteCount: 118_000
        )

        XCTAssertEqual(
            try XCTUnwrap(VisualFrameSelector.bestIndex(in: [sharperButBarelyReadable, textRichFrame])),
            1
        )
    }

    func testSharpnessSelectsTheBestFrameWhenNoTextIsRecognized() throws {
        let blurred = VisualFrameQuality(
            recognizedCharacterCount: 0,
            recognizedLineCount: 0,
            averageTextConfidence: 0,
            normalizedSharpness: 0.02,
            pixelCount: 1_555_200,
            encodedByteCount: 80_000
        )
        let clear = VisualFrameQuality(
            recognizedCharacterCount: 0,
            recognizedLineCount: 0,
            averageTextConfidence: 0,
            normalizedSharpness: 0.11,
            pixelCount: 1_555_200,
            encodedByteCount: 72_000
        )

        XCTAssertEqual(
            try XCTUnwrap(VisualFrameSelector.bestIndex(in: [blurred, clear])),
            1
        )
    }

    func testSelectionIsStableForAnExactTie() throws {
        let quality = VisualFrameQuality(
            recognizedCharacterCount: 40,
            recognizedLineCount: 3,
            averageTextConfidence: 0.75,
            normalizedSharpness: 0.08,
            pixelCount: 1_555_200,
            encodedByteCount: 100_000
        )

        XCTAssertEqual(
            try XCTUnwrap(VisualFrameSelector.bestIndex(in: [quality, quality])),
            0
        )
        XCTAssertNil(VisualFrameSelector.bestIndex(in: []))
    }
}
