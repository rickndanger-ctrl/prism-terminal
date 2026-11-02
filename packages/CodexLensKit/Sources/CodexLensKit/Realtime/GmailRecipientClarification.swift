import Foundation

/// One recipient answer, bound to a fixed operation, subject and body. Nothing
/// is prepared on the gateway or sent while this question is pending.
public struct GmailRecipientClarification: Sendable {
    public let original: RealtimeUtteranceSource
    public let operation: EmailWriteOperation
    public let subject: String
    public let body: String
    public let expiresAt: Date
    public let preparedAt: Date
    public let question = "What is the recipient's full email address?"
    public private(set) var askedAt: Date?
    public private(set) var answer: RealtimeUtteranceSource?
    private var invalidated = false

    public init(source: RealtimeUtteranceSource, operation: EmailWriteOperation,
                subject: String, body: String, now: Date = Date()) throws {
        guard GmailVoiceWriteRequest.requestedOperation(source.transcript) == operation,
              now >= source.transcribedAt, now.timeIntervalSince(source.transcribedAt) < 120,
              subject.count <= 500, body.count <= 8_000 else {
            throw GatewayError.transport("A current email request with a bounded subject and body is required.")
        }
        original = source; self.operation = operation; self.subject = subject; self.body = body
        preparedAt = now; expiresAt = source.transcribedAt.addingTimeInterval(120)
    }

    public mutating func noteQuestionCompleted(_ text: String, at now: Date) {
        guard !invalidated, askedAt == nil, now >= preparedAt, now < expiresAt,
              BoundSpokenReadback.matches(text, requiredReadback: question) else { return }
        askedAt = now
    }

    public mutating func acceptAnswer(_ source: RealtimeUtteranceSource, now: Date = Date()) -> Bool {
        guard !invalidated, answer == nil, let askedAt, now < expiresAt,
              source.itemID != original.itemID,
              BoundSpokenReadback.confirmationIsFresh(transcribedAt: source.transcribedAt,
                readbackCompletedAt: askedAt, now: now, maximumTranscriptAge: 30,
                minimumPostReadbackDelay: BoundSpokenReadback.minimumConfirmationDelay),
              Self.address(from: source.transcript) != nil else { invalidated = true; return false }
        answer = source; return true
    }

    public func request(arguments: JSONValue, answering source: RealtimeUtteranceSource, now: Date = Date()) throws -> GmailVoiceWriteRequest {
        guard !invalidated, now < expiresAt, source == answer,
              let address = Self.address(from: source.transcript) else {
            throw GatewayError.transport("That address answer is no longer bound to the email request.")
        }
        let request = try GmailVoiceWriteRequest(arguments: arguments, source: original)
        guard request.operation == operation, request.message.subject == subject,
              request.message.body == body, request.message.to.count == 1,
              request.message.to[0].lowercased() == address.lowercased(),
              request.message.cc.isEmpty, request.message.bcc.isEmpty else {
            throw GatewayError.transport("Only the requested recipient may change during address clarification.")
        }
        // Preserve the address exactly as resolved from the wearer, even if
        // the model changed capitalization when constructing its arguments.
        guard case .object(var fields) = arguments else { throw GatewayError.decoding("Invalid email fields.") }
        fields["to"] = .array([.string(address)])
        return try GmailVoiceWriteRequest(arguments: .object(fields), source: original)
    }

    /// Narrow literal or spoken address syntax, not arbitrary conversation.
    public static func address(from transcript: String) -> String? {
        guard var text = TaskTakingSpeechPolicy.authoritativeTaskText(from: transcript), text.count <= 320 else { return nil }
        text = text.replacingOccurrences(of: #"^(?:it['’]s|the address is|use)\s+"#, with: "", options: [.regularExpression, .caseInsensitive])
        for (word, symbol) in [("at", "@"), ("dot", "."), ("plus", "+"), ("hyphen", "-"), ("underscore", "_")] {
            text = text.replacingOccurrences(of: "\\s+\(word)\\s+", with: symbol, options: [.regularExpression, .caseInsensitive])
        }
        text = text.replacingOccurrences(of: #"\s*([@.+_-])\s*"#, with: "$1", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " .,!\n\t"))
        guard text.range(of: #"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$"#, options: .regularExpression) != nil else { return nil }
        return text
    }
}
