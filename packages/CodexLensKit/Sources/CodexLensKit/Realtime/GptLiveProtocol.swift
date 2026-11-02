import Foundation

/// Events from a GPT-Live session's `oai-events` data channel that the phone acts
/// on. Audio stays on the WebRTC media track. Transcript deltas are fragments
/// that can arrive late or overlap speech; they never authorize an action.
public enum GptLiveEvent: Equatable, Sendable {
    case started
    case closed(reason: String)
    case inputTranscript(String)
    case outputTranscript(String)
    case delegationStarted(id: String)
    /// A function call from the gateway-configured Responses backend.
    case toolCall(callID: String, name: String, arguments: JSONValue)
    case error(code: String?, message: String)
    /// Valid provider events this phone does not act on (usage, acknowledgements).
    case ignored
}

public enum GptLiveProtocolError: Error, Equatable {
    case invalidFrame
}

/// Wire format for `gpt-live-1`, which OpenAI serves only through
/// `POST /v1/live/sessions`. The gateway creates the session, so the phone never
/// holds a provider credential. Realtime-only events such as `session.update`
/// and `response.cancel` do not exist here.
public enum GptLiveProtocol {
    public static let model = "gpt-live-1"

    /// Phone handlers the delegation backend may call. GPT-Live never gives the
    /// phone a bound wearer utterance, so a Codex task start additionally needs the
    /// wearer's "Codex, confirm", verified on the phone. Texts, email, and the
    /// camera stay on OpenAI Realtime.
    public static let phoneToolNames: Set<String> = [
        "get_current_time", "get_frontmost_mac_app", "research_web", "reason_question",
        "inspect_codex_project", "inspect_mac_app", "capture_glasses_view",
        "get_assistant_task_status", "prepare_assistant_task",
        "start_prepared_assistant_task", "cancel_assistant_task",
    ]

    private static func text(_ value: JSONValue?, _ length: ClosedRange<Int>) -> Bool {
        guard case .string(let value)? = value else { return false }
        return length.contains(value.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
    }

    public static func supports(name: String, arguments: JSONValue) -> Bool {
        guard phoneToolNames.contains(name), case .object(let fields) = arguments else { return false }
        let keys = Set(fields.keys)
        switch name {
        case "get_current_time", "get_frontmost_mac_app":
            return fields.isEmpty
        case "research_web", "reason_question", "inspect_codex_project":
            return keys == ["question"] && text(fields["question"], 2...1000)
        case "inspect_mac_app":
            return keys == ["app", "question"] && text(fields["app"], 1...200) && text(fields["question"], 2...1000)
        case "capture_glasses_view":
            guard keys.isSubset(of: ["request", "mode"]), text(fields["request"], 1...1000) else { return false }
            guard let mode = fields["mode"] else { return true }
            guard case .string(let mode) = mode else { return false }
            return ["fast", "read", "careful"].contains(mode)
        case "prepare_assistant_task":
            guard keys == ["instruction", "scope"], text(fields["instruction"], 2...2000),
                  case .string(let scope)? = fields["scope"] else { return false }
            return ["mac", "project"].contains(scope)
        case "start_prepared_assistant_task":
            guard keys == ["confirmationId", "digest"],
                  case .string(let confirmationID)? = fields["confirmationId"],
                  case .string(let digest)? = fields["digest"] else { return false }
            return (1...120).contains(confirmationID.utf16.count)
                && digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        default: // get_assistant_task_status, cancel_assistant_task
            guard keys.isSubset(of: ["taskId"]) else { return false }
            guard let taskID = fields["taskId"] else { return true }
            guard case .string(let value) = taskID else { return false }
            return (1...128).contains(value.utf16.count)
        }
    }

    public static func decode(_ data: Data) throws -> GptLiveEvent {
        guard data.count <= 262_144,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else {
            throw GptLiveProtocolError.invalidFrame
        }
        switch type {
        case "session.started":
            return .started
        case "session.closed":
            return .closed(reason: object["reason"] as? String ?? "unknown")
        case "session.input_transcript.delta", "session.output_transcript.delta":
            // A provider event this phone cannot read is never fatal: ignore it and
            // keep the session, rather than dropping a working conversation.
            guard let delta = object["delta"] as? String, delta.utf8.count <= 32_768 else {
                return .ignored
            }
            return type == "session.input_transcript.delta" ? .inputTranscript(delta) : .outputTranscript(delta)
        case "session.delegation.created":
            guard let delegation = object["delegation"] as? [String: Any],
                  let id = delegation["id"] as? String, !id.isEmpty else {
                return .ignored
            }
            return .delegationStarted(id: id)
        case "response.event":
            return decodeResponseEvent(object)
        case "error":
            let detail = object["error"] as? [String: Any] ?? object
            return .error(code: detail["code"] as? String,
                          message: detail["message"] as? String ?? "GPT Live reported an error.")
        default:
            return .ignored
        }
    }

    /// One function output, then `response.create` so the backend continues.
    /// The gateway disables parallel tool calls, so each call resumes on its own.
    public static func encodeToolResult(callID: String, output: JSONValue) throws -> [Data] {
        let outputString = String(decoding: try JSONEncoder().encode(output), as: UTF8.self)
        return try frames([
            ["type": "response.item.create", "event_id": eventID(),
             "item": ["type": "function_call_output", "call_id": callID, "output": outputString]],
            ["type": "response.create", "event_id": eventID()],
        ])
    }

    /// Glasses photos for the delegation backend to look at, then one continuation.
    /// The last frame is `response.create`; drop it to add context without an answer.
    public static func encodeUserImages(
        _ jpegData: [Data],
        instruction: String,
        detail: String
    ) throws -> [Data] {
        guard !jpegData.isEmpty else { return [] }
        var frames: [[String: Any]] = []
        for (index, data) in jpegData.enumerated() {
            var content: [[String: Any]] = []
            if index == 0 {
                content.append(["type": "input_text", "text": instruction])
            }
            content.append([
                "type": "input_image",
                "image_url": "data:image/jpeg;base64,\(data.base64EncodedString())",
                "detail": detail,
            ])
            frames.append([
                "type": "response.item.create", "event_id": eventID(),
                "item": ["type": "message", "role": "user", "content": content],
            ])
        }
        frames.append(["type": "response.create", "event_id": eventID()])
        return try self.frames(frames)
    }

    public static func encodeUserText(_ text: String) throws -> [Data] {
        try frames([
            ["type": "response.item.create", "event_id": eventID(),
             "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": text]]]],
            ["type": "response.create", "event_id": eventID()],
        ])
    }

    /// Information GPT-Live says aloud, possibly paraphrased; not tied to a delegation.
    public static func encodeCommentary(_ text: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "type": "session.commentary.append", "event_id": eventID(), "delegation_id": NSNull(), "content": text,
        ], options: [.sortedKeys])
    }

    public static func encodeClose() throws -> Data {
        try JSONSerialization.data(withJSONObject: ["type": "session.close", "event_id": eventID()], options: [.sortedKeys])
    }

    /// The nested envelope is only acted on for a finished function call; anything
    /// else, including a shape this phone does not recognize, is ignored.
    private static func decodeResponseEvent(_ object: [String: Any]) -> GptLiveEvent {
        guard let inner = object["event"] as? [String: Any] else { return .ignored }
        guard inner["type"] as? String == "response.output_item.done",
              let item = inner["item"] as? [String: Any],
              item["type"] as? String == "function_call" else {
            return .ignored
        }
        guard let callID = item["call_id"] as? String, (1...128).contains(callID.utf8.count),
              let name = item["name"] as? String,
              name.range(of: "^[a-z][a-z0-9_]{0,63}$", options: .regularExpression) != nil,
              let argumentsString = item["arguments"] as? String,
              argumentsString.utf8.count <= 32_768,
              let arguments = try? JSONDecoder().decode(JSONValue.self, from: Data(argumentsString.utf8)) else {
            return .ignored
        }
        return .toolCall(callID: callID, name: name, arguments: arguments)
    }

    private static func frames(_ objects: [[String: Any]]) throws -> [Data] {
        try objects.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
    }

    private static func eventID() -> String {
        "codexlens_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}
