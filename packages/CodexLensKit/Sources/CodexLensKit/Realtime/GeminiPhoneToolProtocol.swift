import Foundation

public struct GeminiPhoneToolRequest: Equatable, Sendable {
    public let requestID: UUID
    public let turnID: UUID
    public let name: String
    public let arguments: JSONValue
    public let transcript: String
}

public enum GeminiPhoneToolEvent: Equatable, Sendable {
    case request(GeminiPhoneToolRequest)
    case cancelled(requestID: UUID, turnID: UUID)
}

public enum GeminiPhoneToolProtocol {
    /// Exact existing-handler allowlist; task text always comes from bound audio.
    public static func supports(name: String, arguments: JSONValue) -> Bool {
        guard case .object(let fields) = arguments else { return false }
        if ["get_current_time", "get_assistant_task_status"].contains(name) { return fields.isEmpty }
        if name == "prepare_assistant_task" {
            guard Set(fields.keys) == ["scope"], case .string(let scope) = fields["scope"] else { return false }
            return ["mac", "project"].contains(scope)
        }
        guard ["research_web", "reason_question"].contains(name), Set(fields.keys) == ["question"],
              case .string(let question) = fields["question"] else { return false }
        let length = question.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
        return (2...1000).contains(length)
    }

    public static func abandonsOnInterruption(name: String) -> Bool {
        ["get_current_time", "get_assistant_task_status", "research_web", "reason_question"].contains(name)
    }

    public static func decode(_ data: Data) throws -> GeminiPhoneToolEvent {
        guard data.count <= 32768,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String,
              let requestString = object["requestId"] as? String, let requestID = UUID(uuidString: requestString),
              let turnString = object["turnId"] as? String, let turnID = UUID(uuidString: turnString) else {
            throw GeminiGatewayProtocolError.invalidFrame
        }
        if type == "gemini.toolCancelled" {
            guard Set(object.keys) == ["type", "requestId", "turnId"] else { throw GeminiGatewayProtocolError.invalidFrame }
            return .cancelled(requestID: requestID, turnID: turnID)
        }
        guard type == "gemini.toolCall",
              Set(object.keys) == ["type", "requestId", "turnId", "name", "arguments", "transcript"],
              let name = object["name"] as? String,
              name.range(of: "^[a-z][a-z0-9_]{0,63}$", options: .regularExpression) != nil,
              let transcript = object["transcript"] as? String,
              !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              transcript.utf8.count <= 32000,
              let arguments = object["arguments"] as? [String: Any] else {
            throw GeminiGatewayProtocolError.invalidFrame
        }
        let decoded = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: arguments))
        return .request(.init(requestID: requestID, turnID: turnID, name: name, arguments: decoded, transcript: transcript))
    }

    public static func encodeResult(requestID: UUID, turnID: UUID, output: JSONValue) throws -> Data {
        let result: JSONValue = .object(["type": .string("gemini.toolResult"),
            "requestId": .string(requestID.uuidString.lowercased()), "turnId": .string(turnID.uuidString.lowercased()), "output": output])
        let data = try JSONEncoder().encode(result)
        guard data.count <= 65536 else { throw GeminiGatewayProtocolError.invalidFrame }
        return data
    }
}
