import Foundation

/// Every way a gateway call can fail, mapped from HTTP status + error body.
public enum GatewayError: Error, Equatable, Sendable {
    /// 401 — the gateway bearer token is missing or wrong.
    case unauthorized(String)
    /// 400 — the request was malformed.
    case badRequest(String)
    /// 404 — no such task.
    case notFound(String)
    /// 422 — the request could not be processed (e.g. an out-of-scope path).
    case unprocessable(String)
    /// 503 — the Realtime credential issuer is unconfigured or the upstream
    /// failed. Deliberately carries no upstream detail; retry with backoff.
    case realtimeUnavailable(String)
    /// Any other non-2xx.
    case unexpectedStatus(Int, String)
    /// The response body did not match the expected schema.
    case decoding(String)
    /// The request never completed (offline, DNS, etc.).
    case transport(String)

    /// True when a retry with backoff is reasonable rather than surfacing a
    /// hard error to the user.
    public var isRetryable: Bool {
        switch self {
        case .realtimeUnavailable, .transport: return true
        default: return false
        }
    }
}

extension GatewayError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unauthorized(let message),
             .badRequest(let message),
             .notFound(let message),
             .unprocessable(let message),
             .realtimeUnavailable(let message),
             .decoding(let message),
             .transport(let message):
            return message
        case .unexpectedStatus(let status, let message):
            return "Gateway returned HTTP \(status): \(message)"
        }
    }
}
