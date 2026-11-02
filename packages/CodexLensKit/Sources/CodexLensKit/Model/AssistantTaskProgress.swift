import Foundation

/// Presentation state for a durable task. Network loss and a stop request are
/// never evidence that the worker stopped. Late reads cannot undo completion.
public struct AssistantTaskProgress: Equatable, Sendable {
    public let taskID: String
    public private(set) var status: AssistantTaskStatus?
    public private(set) var connectionNotice: String?
    public private(set) var isStopping = false

    public init(taskID: String) { self.taskID = taskID }

    public var canStop: Bool { status?.state.isTerminal != true && !isStopping }

    @discardableResult public mutating func observe(_ next: AssistantTaskStatus) -> Bool {
        guard next.taskId == taskID else { return false }
        if let previous = status {
            guard !previous.state.isTerminal || next.state.isTerminal else { return false }
            if let before = Self.date(previous.updatedAt), let after = Self.date(next.updatedAt), after < before {
                return false
            }
        }
        status = next
        connectionNotice = nil
        if next.state.isTerminal { isStopping = false }
        return true
    }

    public mutating func connectionFailed(_ message: String) { connectionNotice = message }

    @discardableResult public mutating func requestStop() -> Bool {
        guard canStop else { return false }
        isStopping = true
        return true
    }

    public mutating func stopUnconfirmed() {
        isStopping = false
        connectionNotice = "Stopping has not been confirmed. Checking the Mac again."
    }

    public var title: String {
        if isStopping { return "Stopping Codex…" }
        if connectionNotice != nil { return "Checking the Mac…" }
        switch status?.state {
        case .running: return "Codex is working"
        case .prepared: return "Waiting for Mac confirmation"
        case .completed: return "Codex finished"
        case .cancelled: return "Codex stopped"
        case .failed, .blocked: return "Codex needs attention"
        case .expired: return "Task preview expired"
        case nil: return "Checking task status…"
        }
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
