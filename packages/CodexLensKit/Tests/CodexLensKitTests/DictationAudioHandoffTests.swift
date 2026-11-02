import Foundation
import XCTest
@testable import CodexLensKit

private final class HandoffValues: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int] = []
    func append(_ value: Int) { lock.lock(); defer { lock.unlock() }; values.append(value) }
    var snapshot: [Int] { lock.lock(); defer { lock.unlock() }; return values }
}

final class DictationAudioHandoffTests: XCTestCase {
    @discardableResult
    private func append(_ bridge: DictationAudioHandoff<Int>, _ value: Int, session: UUID,
                        frames: Int = 1600, rate: Double = 16000, bytes: Int? = nil,
                        format: String = "f32-16k-mono", rms: Float = 0.1,
                        time: TimeInterval? = nil,
                        copy: (Int) -> Int? = { $0 }) -> DictationAudioAppendResult {
        bridge.append(value, session: session, frameCount: frames, sampleRate: rate,
                      byteCount: bytes ?? frames * 4, formatID: format, rms: rms,
                      at: time ?? Double(value) / 10, copy: copy)
    }

    func test155SecondsAndThreeHandoffsDeliverEveryBlockOnceInOrder() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        let delivered = HandoffValues()
        var segment = UUID()
        bridge.start(session: session)
        XCTAssertTrue(bridge.attach(session: session, segment: segment, sink: delivered.append))
        var copies = 0
        for block in 0..<1550 { // 155 seconds at 16kHz, not a wall-clock sleep.
            if [500, 1000, 1500].contains(block) {
                XCTAssertTrue(bridge.beginHandoff(session: session, segment: segment))
            }
            if [512, 1012, 1512].contains(block) {
                segment = UUID()
                XCTAssertEqual(bridge.snapshot.bufferedBlocks, 12)
                XCTAssertTrue(bridge.attach(session: session, segment: segment, sink: delivered.append))
            }
            XCTAssertEqual(append(bridge, block, session: session, copy: { copies += 1; return $0 }), .accepted)
        }
        XCTAssertEqual(delivered.snapshot, Array(0..<1550))
        XCTAssertEqual(copies, 36, "Only the three 1.2s handoff backlogs are copied")
        XCTAssertEqual(bridge.snapshot.totalCapturedFrames, 1550 * 1600)
        XCTAssertEqual(bridge.snapshot.totalDeliveredFrames, 1550 * 1600)
        XCTAssertEqual(bridge.snapshot.bufferedBlocks, 0)
        XCTAssertEqual(bridge.snapshot.bufferedBytes, 0)
        XCTAssertEqual(bridge.snapshot.deliveredSecondsForSegment, 5, accuracy: 0.000001)
    }

    func testDirectForwardDoesNotInvokeCopy() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        let values = HandoffValues()
        bridge.start(session: session)
        bridge.attach(session: session, segment: UUID(), sink: values.append)
        XCTAssertEqual(append(bridge, 1, session: session, copy: { _ in XCTFail("Copy while bound"); return nil }), .accepted)
        XCTAssertEqual(values.snapshot, [1])
    }

    func testHandoffIsIdempotentAndOldSegmentCannotDetachNewSink() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID(), first = UUID(), second = UUID()
        let values = HandoffValues()
        bridge.start(session: session)
        bridge.attach(session: session, segment: first, sink: values.append)
        XCTAssertFalse(bridge.beginHandoff(session: UUID(), segment: first))
        XCTAssertFalse(bridge.beginHandoff(session: session, segment: UUID()))
        XCTAssertTrue(bridge.beginHandoff(session: session, segment: first))
        XCTAssertTrue(bridge.beginHandoff(session: session, segment: first))
        XCTAssertFalse(bridge.attach(session: session, segment: first, sink: values.append))
        append(bridge, 1, session: session)
        XCTAssertTrue(bridge.attach(session: session, segment: second, sink: values.append))
        XCTAssertFalse(bridge.beginHandoff(session: session, segment: first))
        XCTAssertFalse(bridge.attach(session: session, segment: UUID(), sink: values.append))
        append(bridge, 2, session: session)
        XCTAssertEqual(values.snapshot, [1, 2])
    }

    func testStopDuringHandoffPreservesAndDrainsTailWithoutResumingCapture() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID(), old = UUID()
        let values = HandoffValues()
        bridge.start(session: session)
        bridge.attach(session: session, segment: old, sink: values.append)
        append(bridge, 0, session: session)
        bridge.beginHandoff(session: session, segment: old)
        append(bridge, 1, session: session)
        append(bridge, 2, session: session)
        bridge.freeze(session: session)
        XCTAssertFalse(bridge.snapshot.accepting)
        XCTAssertEqual(bridge.snapshot.bufferedBlocks, 2)
        XCTAssertEqual(append(bridge, 3, session: session), .ignored)
        XCTAssertTrue(bridge.attach(session: session, segment: UUID(), sink: values.append))
        XCTAssertEqual(values.snapshot, [0, 1, 2])
        XCTAssertFalse(bridge.snapshot.accepting)
        XCTAssertEqual(append(bridge, 4, session: session), .ignored)
        XCTAssertEqual(bridge.snapshot.totalCapturedFrames, 4800)
        XCTAssertEqual(bridge.snapshot.totalDeliveredFrames, 4800)
        XCTAssertEqual(bridge.snapshot.bufferedBlocks, 0)
    }

    func testStopWhileBoundDetachesAndDoesNotReplayDeliveredAudio() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        let values = HandoffValues()
        bridge.start(session: session)
        bridge.attach(session: session, segment: UUID(), sink: values.append)
        append(bridge, 0, session: session)
        bridge.freeze(session: session)
        XCTAssertEqual(append(bridge, 1, session: session), .ignored)
        bridge.attach(session: session, segment: UUID(), sink: values.append)
        XCTAssertEqual(values.snapshot, [0])
    }

    func testConcurrentAppendCannotOvertakeHeldFIFOWhileAttachDrains() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        let values = HandoffValues()
        let drainEntered = DispatchSemaphore(value: 0)
        let releaseDrain = DispatchSemaphore(value: 0)
        let appendEntered = DispatchSemaphore(value: 0)
        let appendFinished = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        bridge.start(session: session)
        append(bridge, 1, session: session)
        append(bridge, 2, session: session)
        group.enter()
        DispatchQueue.global().async {
            _ = bridge.attach(session: session, segment: UUID()) { value in
                if value == 1 {
                    drainEntered.signal()
                    _ = releaseDrain.wait(timeout: .now() + 3)
                }
                values.append(value)
            }
            group.leave()
        }
        XCTAssertEqual(drainEntered.wait(timeout: .now() + 2), .success)
        group.enter()
        DispatchQueue.global().async {
            appendEntered.signal()
            _ = bridge.append(3, session: session, frameCount: 1600, sampleRate: 16000,
                              byteCount: 6400, formatID: "f32-16k-mono", rms: 0.1, at: 0.3, copy: { $0 })
            appendFinished.signal()
            group.leave()
        }
        XCTAssertEqual(appendEntered.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(appendFinished.wait(timeout: .now() + 0.05), .timedOut)
        releaseDrain.signal()
        XCTAssertEqual(group.wait(timeout: .now() + 3), .success)
        XCTAssertEqual(values.snapshot, [1, 2, 3])
        XCTAssertEqual(bridge.snapshot.totalCapturedFrames, bridge.snapshot.totalDeliveredFrames)
    }

    func testHeldPayloadUsesIndependentCopyAndCancelReleasesIt() {
        final class MutablePayload { var value: Int; init(_ value: Int) { self.value = value } }
        let bridge = DictationAudioHandoff<MutablePayload>(), session = UUID()
        let original = MutablePayload(17)
        weak var heldCopy: MutablePayload?
        bridge.start(session: session)
        XCTAssertEqual(bridge.append(original, session: session, frameCount: 1600, sampleRate: 16000,
            byteCount: 6400, formatID: "f32", rms: 0.1, at: 0, copy: {
                let copy = MutablePayload($0.value); heldCopy = copy; return copy
            }), .accepted)
        original.value = 999
        XCTAssertEqual(heldCopy?.value, 17)
        bridge.cancel(session: session)
        XCTAssertNil(heldCopy)
        XCTAssertEqual(bridge.snapshot.bufferedBytes, 0)
        XCTAssertNil(bridge.snapshot.sessionID)
    }

    func testCancelAndStaleSessionsCannotReplayOrCancelNewAudio() {
        let bridge = DictationAudioHandoff<Int>(), old = UUID(), current = UUID()
        let values = HandoffValues()
        bridge.start(session: old)
        append(bridge, 0, session: old)
        bridge.cancel(session: old)
        XCTAssertFalse(bridge.attach(session: old, segment: UUID(), sink: values.append))
        XCTAssertEqual(append(bridge, 1, session: old), .ignored)
        bridge.start(session: current)
        append(bridge, 2, session: current)
        bridge.freeze(session: old)
        bridge.cancel(session: old)
        XCTAssertFalse(bridge.attach(session: old, segment: UUID(), sink: values.append))
        XCTAssertTrue(bridge.snapshot.accepting)
        XCTAssertTrue(bridge.attach(session: current, segment: UUID(), sink: values.append))
        XCTAssertEqual(values.snapshot, [2])
    }

    func testStartingNewSessionClearsOldHeldAudioAndCounters() {
        let bridge = DictationAudioHandoff<Int>(), first = UUID(), second = UUID()
        bridge.start(session: first)
        append(bridge, 0, session: first)
        bridge.start(session: second)
        let state = bridge.snapshot
        XCTAssertEqual(state.sessionID, second)
        XCTAssertEqual(state.bufferedBlocks, 0)
        XCTAssertEqual(state.totalCapturedFrames, 0)
        XCTAssertEqual(state.totalDeliveredFrames, 0)
        XCTAssertNil(state.lastAudioAt)
        XCTAssertNil(state.lastSpeechAt)
    }

    func testFourSecondBoundAcceptsExactlyLimitThenFailsWithoutSilentEviction() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        bridge.start(session: session)
        for i in 0..<40 { XCTAssertEqual(append(bridge, i, session: session), .accepted) }
        XCTAssertEqual(bridge.snapshot.bufferedSeconds, 4)
        XCTAssertEqual(append(bridge, 40, session: session), .failed(.overflow))
        assertFailedAndEmpty(bridge, session: session, reason: .overflow)
    }

    func testByteBoundIsIndependentOfDuration() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        bridge.start(session: session)
        XCTAssertEqual(append(bridge, 0, session: session, frames: 1, bytes: 2 * 1024 * 1024), .accepted)
        XCTAssertEqual(append(bridge, 1, session: session, frames: 1, bytes: 1), .failed(.overflow))
        assertFailedAndEmpty(bridge, session: session, reason: .overflow)
    }

    func testBlockBoundIsIndependentOfDurationAndBytes() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        bridge.start(session: session)
        for i in 0..<256 {
            XCTAssertEqual(append(bridge, i, session: session, frames: 1, bytes: 4), .accepted)
        }
        XCTAssertEqual(append(bridge, 256, session: session, frames: 1, bytes: 4), .failed(.overflow))
        assertFailedAndEmpty(bridge, session: session, reason: .overflow)
    }

    func testOversizedBlockIsRejectedBeforeCopy() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        bridge.start(session: session)
        XCTAssertEqual(append(bridge, 0, session: session, frames: 64001, copy: { _ in
            XCTFail("An oversized block must not be copied"); return nil
        }), .failed(.overflow))
    }

    func testCopyFailureIsVisibleAndReleasesEarlierHeldBlocks() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        bridge.start(session: session)
        append(bridge, 0, session: session)
        XCTAssertEqual(append(bridge, 1, session: session, copy: { _ in nil }), .failed(.copyFailed))
        assertFailedAndEmpty(bridge, session: session, reason: .copyFailed)
    }

    func testFormatAndSampleRateChangeFailClosed() {
        for changeRate in [false, true] {
            let bridge = DictationAudioHandoff<Int>(), session = UUID()
            bridge.start(session: session)
            append(bridge, 0, session: session)
            XCTAssertEqual(append(bridge, 1, session: session, rate: changeRate ? 48000 : 16000,
                                  format: changeRate ? "f32-16k-mono" : "i16-stereo"), .failed(.formatChanged))
            assertFailedAndEmpty(bridge, session: session, reason: .formatChanged)
        }
    }

    func testDurationAccountingSupportsDifferentStablePCMFormats() {
        for (rate, channels, bytesPerSample, name) in [(16000.0, 1, 2, "i16-mono"), (48000.0, 2, 4, "f32-stereo")] {
            let bridge = DictationAudioHandoff<Int>(), session = UUID()
            bridge.start(session: session)
            let frames = Int(rate / 10)
            XCTAssertEqual(append(bridge, 0, session: session, frames: frames, rate: rate,
                                  bytes: frames * channels * bytesPerSample, format: name), .accepted)
            XCTAssertEqual(bridge.snapshot.bufferedSeconds, 0.1, accuracy: 0.000001)
            bridge.attach(session: session, segment: UUID(), sink: { _ in })
            XCTAssertEqual(bridge.snapshot.deliveredSecondsForSegment, 0.1, accuracy: 0.000001)
        }
    }

    func testInvalidAudioMetadataFailsInsteadOfPoisoningTiming() {
        let cases: [(Int, Double, Int, String, Float, Double)] = [
            (0, 16000, 4, "f32", 0.1, 0), (-1, 16000, 4, "f32", 0.1, 0),
            (1, 0, 4, "f32", 0.1, 0), (1, .infinity, 4, "f32", 0.1, 0),
            (1, .nan, 4, "f32", 0.1, 0), (1, 16000, 0, "f32", 0.1, 0),
            (1, 16000, 4, "", 0.1, 0), (1, 16000, 4, "f32", .nan, 0),
            (1, 16000, 4, "f32", -1, 0), (1, 16000, 4, "f32", 0.1, .nan),
            (1, 16000, 4, "f32", 0.1, -1)
        ]
        for input in cases {
            let bridge = DictationAudioHandoff<Int>(), session = UUID()
            bridge.start(session: session)
            XCTAssertEqual(bridge.append(0, session: session, frameCount: input.0, sampleRate: input.1,
                                         byteCount: input.2, formatID: input.3, rms: input.4, at: input.5,
                                         copy: { $0 }), .failed(.invalidAudio))
            assertFailedAndEmpty(bridge, session: session, reason: .invalidAudio)
        }
    }

    func testOutOfOrderTimestampFailsClosed() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        bridge.start(session: session)
        append(bridge, 1, session: session, time: 10)
        XCTAssertEqual(append(bridge, 2, session: session, time: 9), .failed(.invalidAudio))
    }

    func testRotationPrefersObservedQuietAfterFiftySeconds() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        bridge.start(session: session)
        bridge.attach(session: session, segment: UUID(), sink: { _ in })
        append(bridge, 1, session: session, frames: 49 * 16000, time: 49)
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 49))
        append(bridge, 2, session: session, frames: 16000, time: 50)
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 50))
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 51), "Timer delay is not observed silence")
        append(bridge, 3, session: session, frames: 3200, rms: 0, time: 50.2)
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 50.2))
        append(bridge, 4, session: session, frames: 3200, rms: 0, time: 50.4)
        XCTAssertTrue(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 50.4))
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 51), "Stalled input is not a quiet boundary")
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 49))
    }

    func testRotationHasHardFiftyFiveSecondBoundaryForContinuousSpeech() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID(), segment = UUID()
        bridge.start(session: session)
        bridge.attach(session: session, segment: segment, sink: { _ in })
        append(bridge, 1, session: session, frames: 54 * 16000, time: 54)
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 54))
        append(bridge, 2, session: session, frames: 16000, time: 55)
        XCTAssertTrue(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 55))
        bridge.beginHandoff(session: session, segment: segment)
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 56))
        append(bridge, 3, session: session, frames: 16000, time: 56)
        bridge.attach(session: session, segment: UUID(), sink: { _ in })
        XCTAssertEqual(bridge.snapshot.deliveredSecondsForSegment, 1)
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 56))
        bridge.freeze(session: session)
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 56))
    }

    func testQuietBoundaryDoesNotMistakeSoftSpeechForSilence() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        bridge.start(session: session)
        bridge.attach(session: session, segment: UUID(), sink: { _ in })
        append(bridge, 1, session: session, frames: 50 * 16000, rms: 0.006, time: 50)
        append(bridge, 2, session: session, frames: 6400, rms: 0.006, time: 50.4)
        XCTAssertEqual(bridge.snapshot.lastSpeechAt, 50.4)
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 50.4))
    }

    func testAllQuietAudioCanRotateButOnlyAfterFiftySecondsDelivered() {
        let bridge = DictationAudioHandoff<Int>(), session = UUID()
        bridge.start(session: session)
        bridge.attach(session: session, segment: UUID(), sink: { _ in })
        append(bridge, 1, session: session, frames: 50 * 16000, rms: 0, time: 50)
        XCTAssertNil(bridge.snapshot.lastSpeechAt)
        XCTAssertTrue(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: 50))
        XCTAssertFalse(DictationRotationPolicy.shouldRotate(bridge.snapshot, at: .nan))
    }

    private func assertFailedAndEmpty(_ bridge: DictationAudioHandoff<Int>, session: UUID,
                                      reason: DictationAudioHandoffFailure,
                                      file: StaticString = #filePath, line: UInt = #line) {
        let state = bridge.snapshot
        XCTAssertEqual(state.failure, reason, file: file, line: line)
        XCTAssertFalse(state.accepting, file: file, line: line)
        XCTAssertNil(state.segmentID, file: file, line: line)
        XCTAssertEqual(state.bufferedBlocks, 0, file: file, line: line)
        XCTAssertEqual(state.bufferedBytes, 0, file: file, line: line)
        XCTAssertEqual(state.bufferedSeconds, 0, file: file, line: line)
        XCTAssertFalse(bridge.attach(session: session, segment: UUID(), sink: { _ in
            XCTFail("Failed audio cannot replay", file: file, line: line)
        }), file: file, line: line)
        XCTAssertEqual(append(bridge, 999, session: session), .ignored, file: file, line: line)
    }
}
