import XCTest
@testable import CodexLensKit

final class LiveViewBufferTests: XCTestCase {
    let zero = Date(timeIntervalSince1970: 1000)
    func image(_ count: Int = 20) -> LensAttachment { LensAttachment(jpegData: Data(repeating: 1, count: count), label: "test") }
    func testOffByDefaultAndNoCachedFrameAfterStart() {
        var b = LiveViewBuffer()
        XCTAssertFalse(b.append(image(), capturedAt: zero, now: zero))
        b.start(now: zero)
        XCTAssertFalse(b.append(image(), capturedAt: zero, now: zero.addingTimeInterval(1)))
    }
    func testCadenceAndOnlyLatestThree() {
        var b = LiveViewBuffer(); b.start(now: zero)
        for second in [1.0, 4, 7, 10] {
            let now = zero.addingTimeInterval(second)
            XCTAssertTrue(b.append(image(), capturedAt: now, now: now))
            XCTAssertFalse(b.append(image(), capturedAt: now.addingTimeInterval(1), now: now.addingTimeInterval(1)))
        }
        XCTAssertEqual(b.freshImages(now: zero.addingTimeInterval(10)).count, 3)
    }
    func testStaleFutureAndOversizeRejected() {
        var b = LiveViewBuffer(); b.start(now: zero)
        XCTAssertFalse(b.append(image(), capturedAt: zero.addingTimeInterval(1), now: zero.addingTimeInterval(10)))
        XCTAssertFalse(b.append(image(), capturedAt: zero.addingTimeInterval(2), now: zero.addingTimeInterval(1)))
        XCTAssertFalse(b.append(image(2_000_001), capturedAt: zero.addingTimeInterval(1), now: zero.addingTimeInterval(1)))
    }
    func testStopAndRestartClearAllFrames() {
        var b = LiveViewBuffer(); b.start(now: zero)
        let first = b.sessionID
        XCTAssertTrue(b.append(image(), capturedAt: zero.addingTimeInterval(1), now: zero.addingTimeInterval(1)))
        b.stop(); XCTAssertTrue(b.freshImages(now: zero.addingTimeInterval(2)).isEmpty)
        b.start(now: zero.addingTimeInterval(3))
        XCTAssertNotEqual(b.sessionID, first)
        XCTAssertTrue(b.freshImages(now: zero.addingTimeInterval(4)).isEmpty)
    }
    func testExpiryAndMissingStreamTimeout() {
        var b = LiveViewBuffer(); b.start(now: zero)
        XCTAssertTrue(b.shouldStop(now: zero.addingTimeInterval(15)))
        XCTAssertTrue(b.append(image(), capturedAt: zero.addingTimeInterval(1), now: zero.addingTimeInterval(1)))
        XCTAssertTrue(b.freshImages(now: zero.addingTimeInterval(10)).isEmpty)
        XCTAssertTrue(b.shouldStop(now: zero.addingTimeInterval(301)))
    }
    func testOnlyExplicitSharingCommands() {
        XCTAssertEqual(LiveViewCommand.parse("Codex, please share my view."), .start)
        XCTAssertEqual(LiveViewCommand.parse("stop sharing"), .stop)
        XCTAssertNil(LiveViewCommand.parse("Do not share my view"))
        XCTAssertNil(LiveViewCommand.parse("tell me how to share my view"))
    }
    func testFreshStreamHasNoFixedDurationLimit() {
        var b = LiveViewBuffer(); b.start(now: zero)
        for second in stride(from: 1, through: 7201, by: 3) {
            let now = zero.addingTimeInterval(Double(second))
            XCTAssertTrue(b.append(image(), capturedAt: now, now: now))
            XCTAssertFalse(b.shouldStop(now: now))
            XCTAssertLessThanOrEqual(b.freshImages(now: now).count, 3)
        }
        b.stop()
        XCTAssertTrue(b.shouldStop(now: zero.addingTimeInterval(7202)))
    }
    func testManualForegroundSharingDoesNotRequireVoice() {
        for source in ["glasses", "iphone"] {
            XCTAssertTrue(LiveViewPolicy.canContinue(isInBackground: false, cameraSource: source,
                                                    voiceActive: false, backgroundVoiceEnabled: false))
            XCTAssertTrue(LiveViewPolicy.canContinue(isInBackground: false, cameraSource: source,
                                                    voiceActive: false, backgroundVoiceEnabled: true))
        }
    }
    func testLockingWithVoiceOffStopsSharing() {
        for source in ["glasses", "iphone"] {
            for enabled in [false, true] {
                XCTAssertFalse(LiveViewPolicy.canContinue(isInBackground: true, cameraSource: source,
                                                         voiceActive: false, backgroundVoiceEnabled: enabled))
            }
        }
    }
    func testBackgroundRequiresGlassesActiveVoiceAndEnabledPreference() {
        XCTAssertTrue(LiveViewPolicy.canContinue(isInBackground: true, cameraSource: "glasses",
                                                voiceActive: true, backgroundVoiceEnabled: true))
        XCTAssertFalse(LiveViewPolicy.canContinue(isInBackground: true, cameraSource: "iphone",
                                                 voiceActive: true, backgroundVoiceEnabled: true))
        XCTAssertFalse(LiveViewPolicy.canContinue(isInBackground: true, cameraSource: "glasses",
                                                 voiceActive: true, backgroundVoiceEnabled: false))
        XCTAssertFalse(LiveViewPolicy.canContinue(isInBackground: false, cameraSource: "unknown",
                                                 voiceActive: true, backgroundVoiceEnabled: true))
    }
    func testQuotedNegatedCompoundOrInstructionalSharingRequestsAreNotCommands() {
        for text in ["\"share my view\"", "‘share my view’", "`share my view`", "Codex, \"share my view\"",
                     "do not share my view", "don't share my view", "share my view and open Chrome",
                     "tell me how to share my view", "share my view; stop sharing", "share\nmy view",
                     "please don't stop sharing", "share my view\0"] {
            XCTAssertNil(LiveViewCommand.parse(text), text)
        }
        XCTAssertEqual(LiveViewCommand.parse("Codex, please share my view."), .start)
        XCTAssertEqual(LiveViewCommand.parse("Please stop sharing my view!"), .stop)
    }
    func testQuestionUsesCurrentFrameAheadOfThreeSecondSamplingCadence() {
        var b = LiveViewBuffer(); b.start(now: zero)
        let sampled = image()
        XCTAssertTrue(b.append(sampled, capturedAt: zero.addingTimeInterval(1), now: zero.addingTimeInterval(1)))
        let current = image()
        let now = zero.addingTimeInterval(2)
        XCTAssertFalse(b.canSample(capturedAt: now, now: now))
        XCTAssertEqual(b.imagesForQuestion(latest: current, capturedAt: now, now: now).map(\.id), [sampled.id, current.id])
    }
    func testRepeatedQuestionsUseNewestFrameWithoutGrowingSamplingBuffer() {
        var b = LiveViewBuffer(); b.start(now: zero)
        var samples: [LensAttachment] = []
        for second in [1.0, 4, 7] {
            let frame = image(); samples.append(frame)
            XCTAssertTrue(b.append(frame, capturedAt: zero.addingTimeInterval(second), now: zero.addingTimeInterval(second)))
        }
        for second in [7.5, 8, 8.5] {
            let newest = image(), now = zero.addingTimeInterval(second)
            let selected = b.imagesForQuestion(latest: newest, capturedAt: now, now: now)
            XCTAssertEqual(selected.map(\.id), [samples[1].id, samples[2].id, newest.id])
            XCTAssertEqual(b.freshImages(now: now).count, 3)
        }
    }
    func testQuestionDoesNotDuplicateSameTimestampOrUseFramesFromFuture() {
        var b = LiveViewBuffer(); b.start(now: zero)
        let now = zero.addingTimeInterval(1), sampled = image(), newest = image()
        XCTAssertTrue(b.append(sampled, capturedAt: now, now: now))
        XCTAssertEqual(b.imagesForQuestion(latest: newest, capturedAt: now, now: now).map(\.id), [newest.id])
        XCTAssertTrue(b.imagesForQuestion(latest: newest, capturedAt: now.addingTimeInterval(1), now: now).isEmpty)
    }
    func testQuestionRejectsStaleBeforeStartOlderThanBufferAndStoppedFrames() {
        var b = LiveViewBuffer(); b.start(now: zero)
        XCTAssertFalse(b.canUseQuestionFrame(capturedAt: zero, now: zero))
        let captured = zero.addingTimeInterval(1)
        XCTAssertTrue(b.canUseQuestionFrame(capturedAt: captured, now: captured.addingTimeInterval(2)))
        XCTAssertFalse(b.canUseQuestionFrame(capturedAt: captured, now: captured.addingTimeInterval(2.01)))
        XCTAssertTrue(b.append(image(), capturedAt: zero.addingTimeInterval(3), now: zero.addingTimeInterval(3)))
        XCTAssertFalse(b.canUseQuestionFrame(capturedAt: zero.addingTimeInterval(2), now: zero.addingTimeInterval(3)))
        XCTAssertTrue(b.imagesForQuestion(latest: image(0), capturedAt: zero.addingTimeInterval(3), now: zero.addingTimeInterval(3)).isEmpty)
        XCTAssertTrue(b.imagesForQuestion(latest: image(2_000_001), capturedAt: zero.addingTimeInterval(3), now: zero.addingTimeInterval(3)).isEmpty)
        b.stop()
        XCTAssertTrue(b.imagesForQuestion(latest: image(), capturedAt: zero.addingTimeInterval(4), now: zero.addingTimeInterval(4)).isEmpty)
    }
    func testQuestionCannotReuseFrameFromPreviousSharingSession() {
        var b = LiveViewBuffer(); b.start(now: zero)
        let frameAt = zero.addingTimeInterval(1)
        XCTAssertTrue(b.append(image(), capturedAt: frameAt, now: frameAt))
        b.stop(); b.start(now: zero.addingTimeInterval(2))
        XCTAssertTrue(b.imagesForQuestion(latest: image(), capturedAt: frameAt, now: zero.addingTimeInterval(2)).isEmpty)
    }
    func testFrameLabelsIdentifyActualSourceAndAvailabilityTime() {
        let iphone = LiveViewPolicy.frameLabel(source: "iphone", availableAt: zero)
        XCTAssertTrue(iphone.hasPrefix("iPhone camera frame available at "))
        XCTAssertFalse(iphone.contains("Glasses"))
        XCTAssertTrue(iphone.contains(zero.ISO8601Format()))
        XCTAssertTrue(LiveViewPolicy.frameLabel(source: "glasses", availableAt: zero).hasPrefix("Glasses camera frame available at "))
    }
}
