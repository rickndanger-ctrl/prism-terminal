import Foundation

public enum AssistantTaskConfirmationTurnDecision: Equatable, Sendable {
    case authorize
    case invalidate
}

/// Phone-owned authorization state for one prepared assistant task. The
/// Realtime model cannot authorize work by merely emitting a start tool call:
/// its spoken readback must finish first, and the exact later phrase
/// "Codex, confirm" must arrive before the gateway-bound preview expires.
public struct AssistantTaskConfirmationAuthorization: Equatable, Sendable {
    public static let confirmationPhrase = "Codex, confirm"

    public let preparedAt: Date
    public let expiresAt: Date
    public let instruction: String
    public let scope: AssistantTaskScope
    public let projectId: String?
    public let projectDisplayName: String?
    public private(set) var readbackCompletedAt: Date?

    public init(
        preparedAt: Date,
        expiresAt: Date,
        instruction: String,
        scope: AssistantTaskScope,
        projectId: String? = nil,
        projectDisplayName: String? = nil
    ) {
        self.preparedAt = preparedAt
        self.expiresAt = expiresAt
        self.instruction = instruction
        self.scope = scope
        self.projectId = projectId
        self.projectDisplayName = projectDisplayName
    }

    /// The only assistant utterance that can arm this task. It deliberately
    /// includes the approved repository identity for project-scoped work.
    public var requiredReadback: String {
        Self.requiredReadback(
            instruction: instruction,
            scope: scope,
            projectId: projectId,
            projectDisplayName: projectDisplayName
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
                instruction: instruction,
                scope: scope,
                projectId: projectId,
                projectDisplayName: projectDisplayName
            )
        else { return }
        readbackCompletedAt = date
    }

    public static func responseContainsBoundReadback(
        _ responseTranscript: String,
        instruction: String,
        scope: AssistantTaskScope,
        projectId: String? = nil,
        projectDisplayName: String? = nil
    ) -> Bool {
        let required = requiredReadback(
            instruction: instruction,
            scope: scope,
            projectId: projectId,
            projectDisplayName: projectDisplayName
        )
        return BoundSpokenReadback.matches(responseTranscript, requiredReadback: required)
    }

    public static func requiredReadback(
        instruction: String,
        scope: AssistantTaskScope,
        projectId: String? = nil,
        projectDisplayName: String? = nil
    ) -> String {
        let task = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !BoundSpokenReadback.normalize(task).isEmpty else { return "" }
        switch scope {
        case .project:
            guard
                let projectId = projectId?.trimmingCharacters(in: .whitespacesAndNewlines),
                !BoundSpokenReadback.normalize(projectId).isEmpty,
                let projectDisplayName = projectDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
                !BoundSpokenReadback.normalize(projectDisplayName).isEmpty
            else { return "" }
            return "Task: \(task) Scope: project. Project: \(projectDisplayName). Project ID: \(projectId). Say exactly: \(confirmationPhrase)."
        case .mac:
            return "Task: \(task) Scope: mac. Say exactly: \(confirmationPhrase)."
        }
    }

    public func decision(
        transcript: String,
        transcribedAt: Date,
        now: Date,
        maximumTranscriptAge: TimeInterval = 30,
        minimumPostReadbackDelay: TimeInterval = BoundSpokenReadback.minimumConfirmationDelay
    ) -> AssistantTaskConfirmationTurnDecision {
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
            Self.acceptsTaskConfirmation(transcript)
        else { return .invalidate }
        return .authorize
    }

    private static func acceptsTaskConfirmation(_ transcript: String) -> Bool {
        ExplicitComputerConfirmation.accepts(transcript)
    }
}
