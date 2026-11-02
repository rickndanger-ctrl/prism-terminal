import Foundation

/// Memory-only sampled context. Adding a frame never sends a model request.
public struct LiveViewBuffer: Sendable {
    public private(set) var sessionID: UUID?
    private var startedAt: Date?
    private var frames: [(date: Date, image: LensAttachment)] = []
    public init() {}
    public var active: Bool { sessionID != nil }
    public mutating func start(now: Date) {
        sessionID = UUID(); startedAt = now; frames.removeAll()
    }
    public mutating func stop() {
        sessionID = nil; startedAt = nil; frames.removeAll()
    }
    public func canSample(capturedAt: Date, now: Date) -> Bool {
        guard let startedAt, !shouldStop(now: now), capturedAt > startedAt,
              capturedAt <= now, now.timeIntervalSince(capturedAt) <= 8 else { return false }
        return frames.last.map { capturedAt.timeIntervalSince($0.date) >= 3 } ?? true
    }
    @discardableResult public mutating func append(_ image: LensAttachment, capturedAt: Date, now: Date) -> Bool {
        guard canSample(capturedAt: capturedAt, now: now), !image.jpegData.isEmpty,
              image.jpegData.count <= 2_000_000 else { return false }
        frames.append((capturedAt, image))
        frames = Array(frames.suffix(3))
        return true
    }
    public func freshImages(now: Date) -> [LensAttachment] {
        guard active, !shouldStop(now: now) else { return [] }
        return frames.filter { $0.date <= now && now.timeIntervalSince($0.date) <= 8 }.map(\.image)
    }
    /// A question gets the newest camera frame, not merely the last 3-second
    /// sample. It must belong to this sharing session and be at most 2s old.
    public func canUseQuestionFrame(capturedAt: Date, now: Date) -> Bool {
        guard let startedAt, !shouldStop(now: now), capturedAt > startedAt,
              capturedAt <= now, now.timeIntervalSince(capturedAt) <= 2 else { return false }
        return frames.last.map { capturedAt >= $0.date } ?? true
    }
    public func imagesForQuestion(latest: LensAttachment, capturedAt: Date, now: Date) -> [LensAttachment] {
        guard canUseQuestionFrame(capturedAt: capturedAt, now: now),
              !latest.jpegData.isEmpty, latest.jpegData.count <= 2_000_000 else { return [] }
        // Keep at most two earlier samples, then the current view. An equal
        // timestamp is the same camera frame, not an additional perspective.
        let context = frames.filter { $0.date < capturedAt && now.timeIntervalSince($0.date) <= 8 }
        return context.suffix(2).map(\.image) + [latest]
    }
    public func shouldStop(now: Date) -> Bool {
        guard let startedAt else { return true }
        return now.timeIntervalSince(frames.last?.date ?? startedAt) >= 15
    }
}

public enum LiveViewPolicy {
    public static func canContinue(isInBackground: Bool, cameraSource: String,
                                   voiceActive: Bool, backgroundVoiceEnabled: Bool) -> Bool {
        guard ["glasses", "iphone"].contains(cameraSource) else { return false }
        if !isInBackground { return true }
        return cameraSource == "glasses" && voiceActive && backgroundVoiceEnabled
    }
    public static func sourceName(_ source: String) -> String {
        source == "iphone" ? "iPhone camera" : source == "glasses" ? "Glasses camera" : "Camera"
    }
    public static func frameLabel(source: String, availableAt: Date) -> String {
        "\(sourceName(source)) frame available at \(availableAt.ISO8601Format())"
    }
}

public enum LiveViewCommand: Equatable, Sendable {
    case start, stop
    public static func parse(_ text: String) -> Self? {
        guard text.count <= 120, !text.contains("\0") else { return nil }
        var command = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // Do not turn quoted examples into camera authorization by stripping
        // every punctuation character. Only known prefixes/end marks normalize.
        for prefix in ["codex, ", "codex "] where command.hasPrefix(prefix) {
            command = String(command.dropFirst(prefix.count)); break
        }
        if command.hasPrefix("please ") { command = String(command.dropFirst(7)) }
        command = command.trimmingCharacters(in: CharacterSet(charactersIn: ".!? "))
        switch command {
        case "share my view", "start sharing my view": return .start
        case "stop sharing", "stop sharing my view": return .stop
        default: return nil
        }
    }
}
