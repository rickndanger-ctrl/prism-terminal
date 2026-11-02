import Foundation

/// Accepts only a consequence-specific text confirmation. Ordinary phrases
/// such as "yes" or "send it" are unsafe in an ambient conversation.
public enum ExplicitSendConfirmation {
    public static func accepts(_ transcript: String) -> Bool {
        let normalized = normalize(transcript)
        return normalized == "confirm text"
    }

    private static func normalize(_ value: String) -> String {
        value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9 ]", with: " ", options: .regularExpression)
            .split(whereSeparator: \Character.isWhitespace)
            .joined(separator: " ")
    }
}

public enum TextConfirmationTurnDecision: Equatable, Sendable {
    case authorize
    case invalidate
}

/// Phone-owned state for one prepared text. A model prompt is not authority:
/// confirmation is valid only after a completed spoken response contains the
/// exact bound preview, followed by a later confirmation before expiry.
public struct TextConfirmationAuthorization: Equatable, Sendable {
    public let preparedAt: Date
    public let expiresAt: Date
    public let serviceType: MessageServiceType
    public let recipientDisplay: String
    public let maskedDestination: String
    public let message: String
    public private(set) var readbackCompletedAt: Date?

    public init(
        preparedAt: Date,
        expiresAt: Date,
        serviceType: MessageServiceType,
        recipientDisplay: String,
        maskedDestination: String,
        message: String
    ) {
        self.preparedAt = preparedAt
        self.expiresAt = expiresAt
        self.serviceType = serviceType
        self.recipientDisplay = recipientDisplay
        self.maskedDestination = maskedDestination
        self.message = message
    }

    public var requiredReadback: String {
        Self.requiredReadback(
            serviceType: serviceType,
            recipientDisplay: recipientDisplay,
            maskedDestination: maskedDestination,
            message: message
        )
    }

    public mutating func noteReadbackCompleted(
        responseTranscript: String,
        at date: Date
    ) {
        guard
            date >= preparedAt,
            date < expiresAt,
            Self.responseContainsBoundReadback(
                responseTranscript,
                serviceType: serviceType,
                recipientDisplay: recipientDisplay,
                maskedDestination: maskedDestination,
                message: message
            )
        else { return }
        readbackCompletedAt = date
    }

    public static func responseContainsBoundReadback(
        _ responseTranscript: String,
        serviceType: MessageServiceType,
        recipientDisplay: String,
        maskedDestination: String,
        message: String
    ) -> Bool {
        let required = requiredReadback(
            serviceType: serviceType,
            recipientDisplay: recipientDisplay,
            maskedDestination: maskedDestination,
            message: message
        )
        return BoundSpokenReadback.matches(responseTranscript, requiredReadback: required)
    }

    public static func requiredReadback(
        serviceType: MessageServiceType,
        recipientDisplay: String,
        maskedDestination: String,
        message: String
    ) -> String {
        let recipient = recipientDisplay.trimmingCharacters(in: .whitespacesAndNewlines)
        let destination = maskedDestination.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !BoundSpokenReadback.normalize(serviceType.rawValue).isEmpty,
            !BoundSpokenReadback.normalize(recipient).isEmpty,
            !BoundSpokenReadback.normalize(body).isEmpty
        else { return "" }
        let destinationClause = destination.isEmpty ? "" : " Destination: \(destination)."
        return "Service: \(serviceType.rawValue). Recipient: \(recipient).\(destinationClause) Message: \(body) Say exactly: Confirm text."
    }

    public func decision(
        transcript: String,
        transcribedAt: Date,
        now: Date,
        maximumTranscriptAge: TimeInterval = 30,
        minimumPostReadbackDelay: TimeInterval = BoundSpokenReadback.minimumConfirmationDelay
    ) -> TextConfirmationTurnDecision {
        guard
            now < expiresAt,
            let readbackCompletedAt,
            BoundSpokenReadback.confirmationIsFresh(
                transcribedAt: transcribedAt,
                readbackCompletedAt: readbackCompletedAt,
                now: now,
                maximumTranscriptAge: maximumTranscriptAge,
                minimumPostReadbackDelay: minimumPostReadbackDelay
            ),
            ExplicitSendConfirmation.accepts(transcript)
        else { return .invalidate }
        return .authorize
    }
}
