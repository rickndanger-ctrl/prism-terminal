import Foundation

public enum ComputerActionConfirmationTurnDecision: Equatable, Sendable {
    case authorize
    case invalidate
}

/// Phone-owned authorization for one consequential Computer Use action.
/// A later generic phrase cannot run anything unless the assistant first
/// completed the exact canonical action-and-surface readback.
public struct ComputerActionConfirmationAuthorization: Equatable, Sendable {
    public let preparedAt: Date
    public let expiresAt: Date
    public let instruction: String
    public let surface: String
    public private(set) var readbackCompletedAt: Date?

    public init(
        preparedAt: Date,
        expiresAt: Date,
        instruction: String,
        surface: String
    ) {
        self.preparedAt = preparedAt
        self.expiresAt = expiresAt
        self.instruction = instruction
        self.surface = surface
    }

    public var requiredReadback: String {
        let action = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        let targetSurface = surface.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !BoundSpokenReadback.normalize(action).isEmpty,
            !BoundSpokenReadback.normalize(targetSurface).isEmpty
        else { return "" }
        return "Action: \(action) Surface: \(targetSurface). Say exactly: Codex, confirm."
    }

    public mutating func noteReadbackCompleted(
        responseTranscript: String,
        at date: Date
    ) {
        guard
            date >= preparedAt,
            date < expiresAt,
            BoundSpokenReadback.matches(
                responseTranscript,
                requiredReadback: requiredReadback
            )
        else { return }
        readbackCompletedAt = date
    }

    public func decision(
        transcript: String,
        transcribedAt: Date,
        now: Date,
        maximumTranscriptAge: TimeInterval = 30,
        minimumPostReadbackDelay: TimeInterval = BoundSpokenReadback.minimumConfirmationDelay
    ) -> ComputerActionConfirmationTurnDecision {
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
            ExplicitComputerConfirmation.accepts(transcript)
        else { return .invalidate }
        return .authorize
    }
}
