import Foundation

public enum DictationAudioHandoffFailure: String, Equatable, Sendable {
    case invalidAudio, copyFailed, formatChanged, overflow
}

public enum DictationAudioAppendResult: Equatable, Sendable {
    case accepted, ignored
    case failed(DictationAudioHandoffFailure)
}

public enum DictationAudioHandoffLimits {
    public static let seconds: TimeInterval = 4
    public static let bytes = 2 * 1024 * 1024
    public static let blocks = 256
}

public struct DictationAudioHandoffSnapshot: Equatable, Sendable {
    public let sessionID: UUID?
    public let segmentID: UUID?
    public let accepting: Bool
    public let bufferedBlocks: Int
    public let bufferedBytes: Int
    public let bufferedSeconds: TimeInterval
    public let deliveredSecondsForSegment: TimeInterval
    public let lastSpeechAt: TimeInterval?
    public let lastAudioAt: TimeInterval?
    public let totalCapturedFrames: Int
    public let totalDeliveredFrames: Int
    public let failure: DictationAudioHandoffFailure?
}

/// A synchronized, memory-only handoff between consecutive recognition requests.
/// The microphone may keep appending while the previous request finalizes.
///
/// Every accepted block is either delivered directly or copied into the bounded
/// FIFO, never both. attach drains that FIFO before another live append can run.
/// No audio is overlapped, deduplicated, written to disk, or sent to a network.
///
/// Both sink and copy execute under this object's lock. They must be short,
/// synchronous, and MUST NOT call back into this object (including snapshot).
/// The caller's copy must produce independent storage for reusable PCM buffers.
public final class DictationAudioHandoff<Payload>: @unchecked Sendable {
    private struct Block {
        let payload: Payload
        let frames: Int
        let bytes: Int
    }
    private let lock = NSLock()
    private var sessionID: UUID?
    private var segmentID: UUID?
    private var detachedSegmentID: UUID?
    private var accepting = false
    private var sink: ((Payload) -> Void)?
    private var held: [Block] = []
    private var heldFrames = 0
    private var heldBytes = 0
    private var sampleRate: Double?
    private var formatID: String?
    private var segmentDeliveredFrames = 0
    private var lastSpeechAt: TimeInterval?
    private var lastAudioAt: TimeInterval?
    private var capturedFrames = 0
    private var deliveredFrames = 0
    private var failure: DictationAudioHandoffFailure?

    public init() {}

    public func start(session: UUID) {
        lock.lock(); defer { lock.unlock() }
        reset()
        sessionID = session
        accepting = true
    }

    @discardableResult
    public func append(_ payload: Payload, session: UUID, frameCount: Int,
                       sampleRate: Double, byteCount: Int, formatID: String,
                       rms: Float, at time: TimeInterval,
                       copy: (Payload) -> Payload?) -> DictationAudioAppendResult {
        lock.lock(); defer { lock.unlock() }
        guard sessionID == session, accepting, failure == nil else { return .ignored }
        guard frameCount > 0, byteCount > 0, sampleRate.isFinite, sampleRate > 0,
              (Double(frameCount) / sampleRate).isFinite,
              !formatID.isEmpty, rms.isFinite, rms >= 0, time.isFinite, time >= 0,
              lastAudioAt.map({ time >= $0 }) ?? true,
              !capturedFrames.addingReportingOverflow(frameCount).overflow else {
            return fail(.invalidAudio)
        }
        capturedFrames += frameCount
        lastAudioAt = time
        if rms >= DictationRotationPolicy.speechRMSThreshold { lastSpeechAt = time }
        if let previous = self.formatID,
           previous != formatID || self.sampleRate != sampleRate { return fail(.formatChanged) }
        self.formatID = formatID
        self.sampleRate = sampleRate

        if let sink {
            sink(payload)
            segmentDeliveredFrames += frameCount
            deliveredFrames += frameCount
            return .accepted
        }

        let frames = heldFrames.addingReportingOverflow(frameCount)
        let bytes = heldBytes.addingReportingOverflow(byteCount)
        guard !frames.overflow, !bytes.overflow,
              held.count < DictationAudioHandoffLimits.blocks,
              bytes.partialValue <= DictationAudioHandoffLimits.bytes,
              Double(frames.partialValue) / sampleRate <= DictationAudioHandoffLimits.seconds else {
            return fail(.overflow)
        }
        guard let copied = copy(payload) else { return fail(.copyFailed) }
        held.append(Block(payload: copied, frames: frameCount, bytes: byteCount))
        heldFrames = frames.partialValue
        heldBytes = bytes.partialValue
        return .accepted
    }

    /// Idempotent only for the detached current segment. A stale segment cannot
    /// detach a newly attached recognition request.
    @discardableResult
    public func beginHandoff(session: UUID, segment: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard sessionID == session, accepting, failure == nil else { return false }
        guard segmentID == segment, sink != nil else {
            return sink == nil && segmentID == nil && detachedSegmentID == segment
        }
        sink = nil
        segmentID = nil
        detachedSegmentID = segment
        return true
    }

    /// May drain a frozen session after explicit Stop, but cannot resume capture.
    /// A different segment UUID is required after handoff; cancelled/failed
    /// sessions and an already bound request cannot be attached or replayed.
    @discardableResult
    public func attach(session: UUID, segment: UUID, sink: @escaping (Payload) -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard sessionID == session, failure == nil, self.sink == nil,
              segmentID == nil, detachedSegmentID != segment else { return false }
        segmentID = segment
        self.sink = sink
        segmentDeliveredFrames = 0
        for block in held {
            sink(block.payload)
            segmentDeliveredFrames += block.frames
            deliveredFrames += block.frames
        }
        clearHeld()
        return true
    }

    /// Stop accepting microphone buffers immediately, preserving only audio
    /// already held for the next request. This never reactivates capture.
    public func freeze(session: UUID) {
        lock.lock(); defer { lock.unlock() }
        guard sessionID == session else { return }
        accepting = false
        if let segmentID { detachedSegmentID = segmentID }
        segmentID = nil
        sink = nil
    }

    /// Cancel is destructive only to this session's unsent in-memory audio.
    /// Old callbacks cannot cancel a newer session.
    public func cancel(session: UUID) {
        lock.lock(); defer { lock.unlock() }
        guard sessionID == session else { return }
        reset()
    }

    public var snapshot: DictationAudioHandoffSnapshot {
        lock.lock(); defer { lock.unlock() }
        return DictationAudioHandoffSnapshot(sessionID: sessionID, segmentID: segmentID,
            accepting: accepting, bufferedBlocks: held.count, bufferedBytes: heldBytes,
            bufferedSeconds: sampleRate.map { Double(heldFrames) / $0 } ?? 0,
            deliveredSecondsForSegment: sampleRate.map { Double(segmentDeliveredFrames) / $0 } ?? 0,
            lastSpeechAt: lastSpeechAt, lastAudioAt: lastAudioAt,
            totalCapturedFrames: capturedFrames, totalDeliveredFrames: deliveredFrames, failure: failure)
    }

    private func fail(_ reason: DictationAudioHandoffFailure) -> DictationAudioAppendResult {
        failure = reason
        accepting = false
        sink = nil
        segmentID = nil
        clearHeld()
        return .failed(reason)
    }
    private func clearHeld() {
        held.removeAll(keepingCapacity: false)
        heldFrames = 0
        heldBytes = 0
    }
    private func reset() {
        sessionID = nil; segmentID = nil; detachedSegmentID = nil
        accepting = false; sink = nil; clearHeld()
        sampleRate = nil; formatID = nil; segmentDeliveredFrames = 0
        lastSpeechAt = nil; lastAudioAt = nil
        capturedFrames = 0; deliveredFrames = 0; failure = nil
    }
}

/// Prefer a short observed quiet boundary after 50s of delivered audio, but
/// never let uninterrupted speech extend a recognition request past 55s.
public enum DictationRotationPolicy {
    public static let speechRMSThreshold: Float = 0.001
    public static func shouldRotate(_ snapshot: DictationAudioHandoffSnapshot, at time: TimeInterval) -> Bool {
        guard snapshot.accepting, snapshot.segmentID != nil, snapshot.failure == nil,
              time.isFinite, let lastAudio = snapshot.lastAudioAt, time >= lastAudio,
              snapshot.deliveredSecondsForSegment >= 50 else { return false }
        if snapshot.deliveredSecondsForSegment >= 55 { return true }
        // Timer delay or a stalled microphone is not proof of actual silence.
        guard time - lastAudio <= 0.25 else { return false }
        return snapshot.lastSpeechAt.map { lastAudio - $0 >= 0.3 } ?? true
    }
}
