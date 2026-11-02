import Foundation

public enum AssistantTaskReconciliationTurnDecision: Equatable, Sendable {
    case authorize
    case invalidate
}

/// Phone-owned authorization for clearing one durable unknown-outcome lock.
/// The model can request an inspection, but it cannot turn its own tool call
/// into permission: a bound readback must finish and the wearer must then say
/// exactly "Codex, clear task lock" in a later, fresh transcript.
public struct AssistantTaskReconciliationAuthorization: Equatable, Sendable {
    public static let confirmationPhrase = "Codex, clear task lock"
    public static let inspectionWarning =
        "Inspect the task target before clearing this lock because the final outcome is unknown."

    public let armedAt: Date
    public let expiresAt: Date
    public let taskId: String
    public let instruction: String
    public let scope: AssistantTaskScope
    public let projectId: String?
    public let projectDisplayName: String?
    public let state: AssistantTaskState
    public let summary: String
    public let failureCode: String
    public private(set) var readbackCompletedAt: Date?

    public init(
        armedAt: Date,
        expiresAt: Date,
        taskId: String,
        instruction: String,
        scope: AssistantTaskScope,
        projectId: String? = nil,
        projectDisplayName: String? = nil,
        state: AssistantTaskState,
        summary: String,
        failureCode: String
    ) {
        self.armedAt = armedAt
        self.expiresAt = expiresAt
        self.taskId = taskId
        self.instruction = instruction
        self.scope = scope
        self.projectId = projectId
        self.projectDisplayName = projectDisplayName
        self.state = state
        self.summary = summary
        self.failureCode = failureCode
    }

    public var requiredReadback: String {
        Self.requiredReadback(
            taskId: taskId,
            instruction: instruction,
            scope: scope,
            projectId: projectId,
            projectDisplayName: projectDisplayName,
            state: state,
            summary: summary,
            failureCode: failureCode
        )
    }

    public mutating func noteReadbackCompleted(
        responseTranscript: String,
        at date: Date
    ) {
        guard
            date >= armedAt,
            date < expiresAt,
            Self.responseContainsBoundReadback(
                responseTranscript,
                taskId: taskId,
                instruction: instruction,
                scope: scope,
                projectId: projectId,
                projectDisplayName: projectDisplayName,
                state: state,
                summary: summary,
                failureCode: failureCode
            )
        else { return }
        readbackCompletedAt = date
    }

    public static func responseContainsBoundReadback(
        _ responseTranscript: String,
        taskId: String,
        instruction: String,
        scope: AssistantTaskScope,
        projectId: String? = nil,
        projectDisplayName: String? = nil,
        state: AssistantTaskState,
        summary: String,
        failureCode: String
    ) -> Bool {
        let required = requiredReadback(
            taskId: taskId,
            instruction: instruction,
            scope: scope,
            projectId: projectId,
            projectDisplayName: projectDisplayName,
            state: state,
            summary: summary,
            failureCode: failureCode
        )
        return BoundSpokenReadback.matches(responseTranscript, requiredReadback: required)
    }

    public static func requiredReadback(
        taskId: String,
        instruction: String,
        scope: AssistantTaskScope,
        projectId: String? = nil,
        projectDisplayName: String? = nil,
        state: AssistantTaskState,
        summary: String,
        failureCode: String
    ) -> String {
        let normalizedTaskId = taskId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSummary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedFailureCode = failureCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !BoundSpokenReadback.normalize(normalizedTaskId).isEmpty,
            !BoundSpokenReadback.normalize(normalizedSummary).isEmpty,
            !BoundSpokenReadback.normalize(normalizedFailureCode).isEmpty
        else { return "" }

        let taskReadback = AssistantTaskConfirmationAuthorization.requiredReadback(
            instruction: instruction,
            scope: scope,
            projectId: projectId,
            projectDisplayName: projectDisplayName
        )
        guard !taskReadback.isEmpty else { return "" }
        let confirmationSuffix = " Say exactly: \(AssistantTaskConfirmationAuthorization.confirmationPhrase)."
        let taskWithoutConfirmation: String
        if taskReadback.hasSuffix(confirmationSuffix) {
            taskWithoutConfirmation = String(taskReadback.dropLast(confirmationSuffix.count))
        } else {
            return ""
        }
        return "Task ID: \(normalizedTaskId). \(taskWithoutConfirmation) State: \(state.rawValue). Summary: \(normalizedSummary). Failure code: \(normalizedFailureCode). Warning: \(inspectionWarning) Say exactly: \(confirmationPhrase)."
    }

    public func decision(
        transcript: String,
        transcribedAt: Date,
        now: Date,
        maximumTranscriptAge: TimeInterval = 30,
        minimumPostReadbackDelay: TimeInterval = BoundSpokenReadback.minimumConfirmationDelay
    ) -> AssistantTaskReconciliationTurnDecision {
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
            Self.acceptsConfirmation(transcript)
        else { return .invalidate }
        return .authorize
    }

    private static func acceptsConfirmation(_ transcript: String) -> Bool {
        let normalized = BoundSpokenReadback.normalize(transcript)
        return normalized == BoundSpokenReadback.normalize(confirmationPhrase)
            || normalized == "codec clear task lock"
            || normalized == "code x clear task lock"
    }
}
