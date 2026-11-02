import Foundation

public enum RealtimeConnectionFailure {
    /// Funding failures need account action. Retrying the socket cannot repair
    /// them and would overwrite the useful server error with a transport error.
    public static func accountActionMessage(code: String?, message: String) -> String? {
        if ["insufficient_quota", "billing_hard_limit_reached"].contains(code ?? "")
            || message.lowercased().contains("no credits remaining") {
            return "OpenAI API credits are empty. Add credits to the connected account, then try chat or voice again."
        }
        return nil
    }
}
