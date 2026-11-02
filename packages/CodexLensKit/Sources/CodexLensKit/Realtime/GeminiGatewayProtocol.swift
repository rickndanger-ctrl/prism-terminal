import Foundation

/// Native Gemini gateway events. Audio remains on the existing WebRTC track.
/// Transcript messages are fragments, not final/authoritative utterances.
public enum GeminiGatewayEvent: Equatable, Sendable {
    case ready
    case clearAudio
    case activityStarted(UUID)
    case activityEnded(turnID: UUID, reason: GeminiActivityEndReason)
    case inputTranscript(turnID: UUID, text: String)
    /// Completed captured-audio decision from the trusted gateway, not a provider fragment.
    case acceptedUtterance(turnID: UUID, text: String)
    case outputTranscript(turnID: UUID, text: String)
    case turnComplete(UUID)
    case responseSuppressed(UUID)
}

public enum GeminiActivityEndReason: String, Equatable, Sendable {
    case manual, silence, limit
}

public enum GeminiPhoneControl: Equatable, Sendable {
    case responseDecision(turnID: UUID, allow: Bool)
    case stop

    public func encoded() throws -> Data {
        let object: [String: Any]
        switch self {
        case let .responseDecision(turnID, allow):
            object = ["type": "gemini.decideResponse", "turnId": turnID.uuidString.lowercased(), "allow": allow]
        case .stop:
            object = ["type": "gemini.stop"]
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

public enum GeminiGatewayProtocolError: Error, Equatable {
    case invalidFrame
    case unsupportedEvent
}

public enum GeminiGatewayProtocol {
    public static let model = "gemini-3.1-flash-live-preview"

    public static func decode(_ data: Data) throws -> GeminiGatewayEvent {
        guard data.count <= 65_536,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else {
            throw GeminiGatewayProtocolError.invalidFrame
        }
        let keys = Set(object.keys)
        if type == "gemini.ready" || type == "gemini.clearAudio" {
            guard keys == ["type"] else { throw GeminiGatewayProtocolError.invalidFrame }
            return type == "gemini.ready" ? .ready : .clearAudio
        }
        let textEvent = type == "gemini.inputTranscript" || type == "gemini.outputTranscript" || type == "gemini.acceptedUtterance"
        let endedEvent = type == "gemini.activityEnded"
        let turnEvent = ["gemini.activityStarted", "gemini.activityEnded", "gemini.turnComplete", "gemini.responseSuppressed"].contains(type)
        guard textEvent || turnEvent else { throw GeminiGatewayProtocolError.unsupportedEvent }
        let expected: Set<String> = textEvent ? ["type", "turnId", "text"] : endedEvent ? ["type", "turnId", "reason"] : ["type", "turnId"]
        guard keys == expected,
              let rawID = object["turnId"] as? String,
              let id = UUID(uuidString: rawID) else {
            throw GeminiGatewayProtocolError.invalidFrame
        }
        if endedEvent {
            guard let rawReason = object["reason"] as? String,
                  let reason = GeminiActivityEndReason(rawValue: rawReason) else {
                throw GeminiGatewayProtocolError.invalidFrame
            }
            return .activityEnded(turnID: id, reason: reason)
        }
        if textEvent {
            guard let text = object["text"] as? String, text.utf8.count <= 32_768 else {
                throw GeminiGatewayProtocolError.invalidFrame
            }
            if type == "gemini.acceptedUtterance" {
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      text.utf8.count <= 32000 else { throw GeminiGatewayProtocolError.invalidFrame }
                return .acceptedUtterance(turnID: id, text: text)
            }
            return type == "gemini.inputTranscript" ? .inputTranscript(turnID: id, text: text)
                : .outputTranscript(turnID: id, text: text)
        }
        switch type {
        case "gemini.activityStarted": return .activityStarted(id)
        case "gemini.turnComplete": return .turnComplete(id)
        default: return .responseSuppressed(id)
        }
    }
}
