import Foundation

/// Connection-local event ordering, not transcription attribution or attention.
/// A host turn tag alone does not establish which audio produced a transcript.
public struct GeminiPhoneSessionState: Sendable {
    public private(set) var isReady = false
    public private(set) var currentTurnID: UUID?
    public private(set) var hasEnded = false
    private var decided = false
    private var acceptedUtteranceReceived = false

    public init() {}

    @discardableResult
    public mutating func receive(_ event: GeminiGatewayEvent) -> Bool {
        switch event {
        case .ready:
            guard !isReady else { return false }
            isReady = true
            return true
        case .clearAudio:
            return isReady
        case .activityStarted(let id):
            guard isReady, id != currentTurnID else { return false }
            currentTurnID = id
            hasEnded = false
            decided = false
            acceptedUtteranceReceived = false
            return true
        case .activityEnded(let id, let reason):
            guard isReady, id == currentTurnID, !hasEnded else { return false }
            hasEnded = true
            if reason == .limit { decided = true }
            return true
        case .acceptedUtterance(let id, _):
            guard isReady, id == currentTurnID, hasEnded, !decided, !acceptedUtteranceReceived else { return false }
            acceptedUtteranceReceived = true
            return true
        case .inputTranscript(let id, _), .outputTranscript(let id, _), .turnComplete(let id):
            return isReady && id == currentTurnID
        case .responseSuppressed(let id):
            guard isReady, id == currentTurnID else { return false }
            decided = true
            return true
        }
    }

    public func canDecide(turnID: UUID) -> Bool {
        isReady && hasEnded && currentTurnID == turnID && !decided
    }

    public mutating func noteDecisionSent(turnID: UUID) {
        if canDecide(turnID: turnID) { decided = true }
    }
}
