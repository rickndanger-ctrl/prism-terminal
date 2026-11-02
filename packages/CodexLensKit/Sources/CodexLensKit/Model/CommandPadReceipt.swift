import Foundation

/// The only pad information persisted on the phone. Never store the dictated
/// payload here: recovery reads a server receipt and cannot execute an action.
public struct CommandPadPendingRequest: Codable, Equatable, Sendable {
    public let requestID: String
    public let gateway: String

    public init(requestID: String, gateway: String) {
        self.requestID = requestID
        self.gateway = gateway
    }
}

public enum CommandPadReceiptState: String, Codable, Sendable {
    case completed, running, unknown
}

/// "Completed" means the gateway stored its response, not that the requested
/// desktop action succeeded. Always preserve and present the actual summary.
public struct CommandPadReceipt: Codable, Equatable, Sendable {
    public let summary: String?
    public let state: CommandPadReceiptState

    public init(summary: String?, state: CommandPadReceiptState) {
        self.summary = summary
        self.state = state
    }

    public var completedSummary: String? {
        guard state == .completed, let summary,
              !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return summary
    }

    /// Applies only to the POST execute response. A 404 from GET receipt does
    /// not establish rejection: the original request might still be arriving.
    public static func isDefinitiveExecutionRejection(_ status: Int) -> Bool {
        [400, 401, 404, 409].contains(status)
    }
}
