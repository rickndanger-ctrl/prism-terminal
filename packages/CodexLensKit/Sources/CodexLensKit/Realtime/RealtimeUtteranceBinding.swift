import Foundation

/// One immutable completed wearer utterance. Its Realtime item id is the
/// authority that links speech to the response and function call it caused.
public struct RealtimeUtteranceSource: Equatable, Sendable {
    public let itemID: String
    public let transcript: String
    public let transcribedAt: Date

    public init?(
        itemID: String,
        transcript: String,
        transcribedAt: Date = Date()
    ) {
        let normalizedItemID = itemID.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedItemID.isEmpty, !normalizedTranscript.isEmpty else { return nil }
        self.itemID = normalizedItemID
        self.transcript = normalizedTranscript
        self.transcribedAt = transcribedAt
    }
}

/// Carries an accepted wearer utterance across Realtime's asynchronous
/// transcript -> response -> function-call sequence. Every binding stores a
/// value snapshot, so later ambient speech cannot replace the source command.
public struct RealtimeUtteranceBinding: Sendable {
    private var utterancesByItemID: [String: RealtimeUtteranceSource] = [:]
    private var utteranceOrder: [String] = []
    private var sourcesByResponseID: [String: RealtimeUtteranceSource] = [:]
    private var responseOrder: [String] = []
    private var sourcesByCallID: [String: RealtimeUtteranceSource] = [:]
    private var callOrder: [String] = []

    public init() {}

    @discardableResult
    public mutating func record(
        itemID: String,
        transcript: String,
        transcribedAt: Date = Date()
    ) -> RealtimeUtteranceSource? {
        guard let source = RealtimeUtteranceSource(
            itemID: itemID,
            transcript: transcript,
            transcribedAt: transcribedAt
        ) else { return nil }
        if utterancesByItemID[itemID] == nil {
            utteranceOrder.append(itemID)
        }
        utterancesByItemID[itemID] = source
        if utteranceOrder.count > 64 {
            let expired = Array(utteranceOrder.prefix(utteranceOrder.count - 64))
            utteranceOrder.removeFirst(expired.count)
            for key in expired { utterancesByItemID.removeValue(forKey: key) }
        }
        return source
    }

    public func source(itemID: String) -> RealtimeUtteranceSource? {
        utterancesByItemID[itemID]
    }

    @discardableResult
    public mutating func bindResponse(
        responseID: String,
        source: RealtimeUtteranceSource
    ) -> Bool {
        guard !responseID.isEmpty else { return false }
        if sourcesByResponseID[responseID] == nil {
            responseOrder.append(responseID)
        }
        sourcesByResponseID[responseID] = source
        if responseOrder.count > 256 {
            let expired = Array(responseOrder.prefix(responseOrder.count - 256))
            responseOrder.removeFirst(expired.count)
            for key in expired { sourcesByResponseID.removeValue(forKey: key) }
        }
        return true
    }

    @discardableResult
    public mutating func bindToolCall(
        callID: String,
        responseID: String
    ) -> RealtimeUtteranceSource? {
        guard
            !callID.isEmpty,
            let source = sourcesByResponseID[responseID]
        else { return nil }
        if sourcesByCallID[callID] == nil {
            callOrder.append(callID)
        }
        sourcesByCallID[callID] = source
        if callOrder.count > 256 {
            let expired = Array(callOrder.prefix(callOrder.count - 256))
            callOrder.removeFirst(expired.count)
            for key in expired { sourcesByCallID.removeValue(forKey: key) }
        }
        return source
    }

    public func source(callID: String) -> RealtimeUtteranceSource? {
        sourcesByCallID[callID]
    }

    public mutating func removeResponse(_ responseID: String) {
        sourcesByResponseID.removeValue(forKey: responseID)
        responseOrder.removeAll { $0 == responseID }
    }

    public mutating func reset() {
        utterancesByItemID.removeAll()
        utteranceOrder.removeAll()
        sourcesByResponseID.removeAll()
        responseOrder.removeAll()
        sourcesByCallID.removeAll()
        callOrder.removeAll()
    }
}
