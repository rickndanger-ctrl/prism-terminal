import Foundation

/// Persisted choices retain their provider; unknown old values use the existing
/// OpenAI rollback route rather than silently selecting an experimental backend.
public enum VoiceBackend: String, CaseIterable, Sendable {
    case openai
    case gptLive = "gpt-live"
    case huggingface

    public init(savedValue: String) {
        self = Self(rawValue: savedValue) ?? .openai
    }

    public var realtimeModel: String {
        switch self {
        case .openai: "gpt-realtime-2.1"
        case .gptLive: GptLiveProtocol.model
        case .huggingface: "huggingface"
        }
    }

    /// The provider a failed session start retries on instead of going offline.
    public var startupFallback: VoiceBackend? {
        self == .gptLive ? .openai : nil
    }
}
