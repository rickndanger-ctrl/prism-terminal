import Foundation

/// A model may fill a preview, but cannot supply the phone's send approval.
public struct GmailVoiceWriteRequest: Sendable {
    public let operation: EmailWriteOperation
    public let message: GmailOutgoingMessage

    public static func requestedOperation(_ transcript: String) -> EmailWriteOperation? {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^(?:hey\\s+)?(?:codex|codec|code\\s+x)\\b[\\s,.:;!-]*", with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "^(?:(?:please|can|could|would|will|you)\\s+)+", with: "", options: [.regularExpression, .caseInsensitive])
            .lowercased()
        if text.range(of: "^(?:draft|compose|write|prepare|save) (?:an? |my |the )?(?:gmail |email|e-mail)", options: .regularExpression) != nil { return .draft }
        if text.range(of: "^(?:send (?:an? |my |the )?(?:gmail |email|e-mail)|email )", options: .regularExpression) != nil { return .send }
        return nil
    }

    public static func isConfirmation(_ transcript: String) -> Bool {
        ["confirm email", "confirm draft"].contains(BoundSpokenReadback.normalize(transcript))
    }

    public init(arguments: JSONValue, source: RealtimeUtteranceSource) throws {
        guard case .object(let fields) = arguments,
              Set(fields.keys) == Set(["operation", "to", "cc", "bcc", "subject", "body"]),
              let raw = arguments.string("operation"), let operation = EmailWriteOperation(rawValue: raw),
              Self.requestedOperation(source.transcript) == operation,
              let subject = arguments.string("subject"), let body = arguments.string("body"),
              subject.count <= 500, body.count <= 8_000 else {
            throw GatewayError.transport("Ask explicitly to draft or send an email, with resolved recipients and a short message.")
        }
        func addresses(_ key: String) throws -> [String] {
            guard case .array(let values) = fields[key] else { throw GatewayError.transport("Email recipients must be explicit addresses.") }
            return try values.map {
                guard case .string(let value) = $0, !value.isEmpty,
                      value.contains("@"), !value.contains(where: { $0.isWhitespace || $0.isNewline })
                else { throw GatewayError.transport("Resolve the recipient's email address before preparing a message.") }
                return value
            }
        }
        let to = try addresses("to"), cc = try addresses("cc"), bcc = try addresses("bcc")
        guard !to.isEmpty, to.count + cc.count + bcc.count <= 20 else { throw GatewayError.transport("Provide between one and twenty email recipients.") }
        self.operation = operation
        self.message = .init(to: to, cc: cc, bcc: bcc, subject: subject, body: body)
    }
}
