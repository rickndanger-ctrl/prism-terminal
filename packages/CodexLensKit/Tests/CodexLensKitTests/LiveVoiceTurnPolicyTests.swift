import XCTest
@testable import CodexLensKit

final class LiveVoiceTurnPolicyTests: XCTestCase {
    func testStableTranscriptDoesNotEndWhileMicrophoneStillHearsSpeech() {
        var gate = LiveVoiceSilenceGate()
        for tick in 0...30 {
            gate.observe(rms: 0.04, at: Double(tick) / 10)
            XCTAssertFalse(gate.shouldFinalize(at: Double(tick) / 10, transcript: "Open Calculator"))
        }
        gate.observe(rms: 0.001, at: 4.2)
        XCTAssertFalse(gate.shouldFinalize(at: 4.2, transcript: "Open Calculator"))
        XCTAssertTrue(gate.shouldFinalize(at: 4.31, transcript: "Open Calculator"))
    }

    func testAmbientSilenceAndEmptyRecognitionCannotSendACommand() {
        var gate = LiveVoiceSilenceGate()
        for tick in 0...30 { gate.observe(rms: 0.001, at: Double(tick) / 10) }
        XCTAssertFalse(gate.shouldFinalize(at: 10, transcript: "stale transcript"))
        for tick in 31...36 { gate.observe(rms: 0.04, at: Double(tick) / 10) }
        XCTAssertFalse(gate.shouldFinalize(at: 10, transcript: " \n"))
    }

    func testBriefClickIsNotEnoughAcousticSpeechToCommit() {
        var gate = LiveVoiceSilenceGate()
        gate.observe(rms: 0.001, at: 0)
        gate.observe(rms: 0.1, at: 0.05)
        gate.observe(rms: 0.001, at: 0.1)
        XCTAssertFalse(gate.shouldFinalize(at: 2, transcript: "noise"))
    }

    func testOnlyCurrentCompletedReplyIsConsumedOnce() {
        var gate = LiveVoiceReplyGate()
        gate.awaitReply(requestID: "new")
        XCTAssertNil(gate.consume(requestID: "old", text: "Old answer", status: "completed"))
        XCTAssertEqual(gate.waitingRequestID, "new")
        XCTAssertEqual(gate.consume(requestID: "new", text: "  New answer\n", status: "completed"), "New answer")
        XCTAssertNil(gate.consume(requestID: "new", text: "duplicate", status: "completed"))
    }

    func testFailedInterruptedAndStoppedRepliesAreNotSpoken() {
        for status in ["failed", "interrupted"] {
            var gate = LiveVoiceReplyGate()
            gate.awaitReply(requestID: "turn")
            XCTAssertNil(gate.consume(requestID: "turn", text: "Unfinished response", status: status))
            XCTAssertNil(gate.waitingRequestID)
        }
        var stopped = LiveVoiceReplyGate()
        stopped.awaitReply(requestID: "turn")
        stopped.reset()
        XCTAssertNil(stopped.consume(requestID: "turn", text: "Late response", status: "completed"))
    }

    func testReadbackKeepsCodeOnScreenAndBoundsUnicodePayload() {
        XCTAssertEqual(LiveVoiceReadback.text(from: "# Done\n[Result](https://example.test)\n```swift\nprint(1)\n```"),
                       "Done\nResult\n Code is available in the terminal.")
        let result = LiveVoiceReadback.text(from: String(repeating: "🙂", count: 2000))
        XCTAssertLessThanOrEqual(result.utf16.count, 2000)
        XCTAssertTrue(result.hasSuffix("The rest is in the terminal."))
    }

    func testExpectedSilentRecognitionCanRemainArmedAcrossManyIdleSegments() {
        var recovery = LiveVoiceRecognitionRecovery()
        for _ in 0..<100 {
            XCTAssertEqual(recovery.delay(errorDomain: "kAFAssistantErrorDomain", code: 1110,
                                          segmentDuration: 20, segmentHasText: false), 0.25)
        }
    }

    func testSpeechChunksKeepShortAnswersUnchangedAndIgnoreEmptyText() {
        XCTAssertEqual(LiveVoiceReadback.chunks(from: "  The time is 3:14.  "), ["The time is 3:14."])
        XCTAssertEqual(LiveVoiceReadback.chunks(from: " \n\t"), [])
    }

    func testSpeechChunksPreferSentenceBoundaryAndPreserveEveryWord() {
        let first = "The first result is complete."
        let response = first + " " + String(repeating: "Another useful detail follows without punctuation ", count: 20)
        let chunks = LiveVoiceReadback.chunks(from: response)
        XCTAssertEqual(chunks.first, first)
        XCTAssertLessThanOrEqual(chunks[0].utf16.count, 180)
        XCTAssertTrue(chunks.dropFirst().allSatisfy { $0.utf16.count <= 400 })
        XCTAssertEqual(words(chunks.joined(separator: " ")), words(LiveVoiceReadback.text(from: response)))
    }

    func testSpeechChunksDoNotTreatDecimalDotAsSentenceEnd() {
        let response = "The number is 3.14159 and " + String(repeating: "additional information ", count: 30)
        let chunks = LiveVoiceReadback.chunks(from: response)
        XCTAssertTrue(chunks[0].contains("3.14159 and"))
        XCTAssertEqual(words(chunks.joined(separator: " ")), words(response))
    }

    func testSpeechChunksIncludeClosingQuoteWithSentence() {
        let first = "It answered, \"The task is finished.\""
        let response = first + " " + String(repeating: "Additional details are on the screen ", count: 20)
        XCTAssertEqual(LiveVoiceReadback.chunks(from: response).first, first)
    }

    func testSpeechChunksSplitUnbrokenTokensWithoutLosingCharacters() {
        let response = String(repeating: "x", count: 1100)
        let chunks = LiveVoiceReadback.chunks(from: response)
        XCTAssertEqual(chunks.map { $0.utf16.count }, [180, 400, 400, 120])
        XCTAssertEqual(chunks.joined(), response)
    }

    func testSpeechChunksNeverSplitEmojiGraphemes() {
        let emoji = "👨‍👩‍👧‍👦"
        let response = String(repeating: emoji, count: 100)
        let chunks = LiveVoiceReadback.chunks(from: response)
        XCTAssertLessThanOrEqual(chunks[0].utf16.count, 180)
        XCTAssertTrue(chunks.dropFirst().allSatisfy { $0.utf16.count <= 400 })
        XCTAssertTrue(chunks.allSatisfy { $0.allSatisfy { String($0) == emoji } })
        XCTAssertEqual(chunks.joined(), response)
    }

    func testSpeechChunksKeepAnOversizedIndivisibleGraphemeIntact() {
        let grapheme = "a" + String(repeating: "\u{0301}", count: 450)
        XCTAssertEqual(grapheme.count, 1)
        let chunks = LiveVoiceReadback.chunks(from: grapheme + " finished")
        XCTAssertEqual(chunks, [grapheme, "finished"])
        XCTAssertTrue(chunks.allSatisfy { $0.utf16.count < 2000 })
    }

    func testSpeechChunksApplyExistingNormalizationAndTotalReadbackBound() {
        let response = "# Details\n[Result](https://example.test)\n```swift\nprint(1)\n```\n" + String(repeating: "useful detail ", count: 250)
        let chunks = LiveVoiceReadback.chunks(from: response)
        XCTAssertEqual(words(chunks.joined(separator: " ")), words(LiveVoiceReadback.text(from: response)))
        XCTAssertLessThanOrEqual(chunks.joined(separator: " ").utf16.count, 1900)
        XCTAssertFalse(chunks.joined().contains("print(1)"))
        XCTAssertTrue(chunks.joined(separator: " ").hasSuffix("The rest is in the terminal."))
    }

    func testSpeechChunksHandleLongWhitespaceWithoutEmptyRequests() {
        let response = "First" + String(repeating: " \n", count: 250) + "last"
        let chunks = LiveVoiceReadback.chunks(from: response)
        XCTAssertEqual(words(chunks.joined(separator: " ")), ["First", "last"])
        XCTAssertTrue(chunks.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
    }

    func testSpeechChunksPreserveUnspacedCJKSentences() {
        let response = String(repeating: "这是完整的一句话。", count: 70)
        let chunks = LiveVoiceReadback.chunks(from: response)
        XCTAssertTrue(chunks.dropLast().allSatisfy { $0.hasSuffix("。") })
        XCTAssertEqual(chunks.joined(), response)
        XCTAssertLessThanOrEqual(chunks[0].utf16.count, 180)
        XCTAssertTrue(chunks.dropFirst().allSatisfy { $0.utf16.count <= 400 })
    }

    private func words(_ text: String) -> [String] { text.split(whereSeparator: \.isWhitespace).map(String.init) }

    func testImmediateNoSpeechFailuresBackOffAndStopRatherThanSpin() {
        var recovery = LiveVoiceRecognitionRecovery()
        for expected in [0.25, 0.5, 1.0] {
            XCTAssertEqual(recovery.delay(errorDomain: "kAFAssistantErrorDomain", code: 1110,
                                          segmentDuration: 0.1, segmentHasText: false), expected)
        }
        XCTAssertNil(recovery.delay(errorDomain: "kAFAssistantErrorDomain", code: 1110,
                                     segmentDuration: 0.1, segmentHasText: false))
    }

    func testPermissionRouteServiceAndPartialRecognitionFailuresAreNotSilentlyRetried() {
        var recovery = LiveVoiceRecognitionRecovery()
        for code in [203, 1100, 1101, 1107, 1700] {
            XCTAssertNil(recovery.delay(errorDomain: "kAFAssistantErrorDomain", code: code,
                                         segmentDuration: 20, segmentHasText: false))
        }
        XCTAssertNil(recovery.delay(errorDomain: "AVAudioSessionErrorDomain", code: 1110,
                                     segmentDuration: 20, segmentHasText: false))
        XCTAssertNil(recovery.delay(errorDomain: "kAFAssistantErrorDomain", code: 1110,
                                     segmentDuration: 20, segmentHasText: true))
    }
}
