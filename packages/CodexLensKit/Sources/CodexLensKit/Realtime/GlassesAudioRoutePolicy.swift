import Foundation

/// Pure policy for the app's glasses-only voice lifecycle. The iOS shell maps
/// AVAudioSession state into these inputs and performs the returned action.
/// Keeping this policy outside AVFoundation makes the privacy boundary
/// headlessly testable.
public enum GlassesAudioSessionPhase: Equatable, Sendable {
    case stopped
    case connecting
    case connected
}

public enum GlassesAudioRouteAction: Equatable, Sendable {
    case none
    case pauseRealtime
    case resumeRealtime
}

public enum GlassesAudioRoutePolicy {
    public static func action(
        assistantArmed: Bool,
        sessionPhase: GlassesAudioSessionPhase,
        glassesInputAvailable: Bool,
        glassesInputRouted: Bool
    ) -> GlassesAudioRouteAction {
        guard assistantArmed else { return .none }

        switch sessionPhase {
        case .stopped:
            return glassesInputAvailable ? .resumeRealtime : .none
        case .connecting:
            // An inactive session cannot expose a current HFP route. Availability
            // is enough to begin/continue setup; the connected state below then
            // requires proof that audio actually moved onto the glasses.
            return glassesInputAvailable ? .none : .pauseRealtime
        case .connected:
            return glassesInputRouted ? .none : .pauseRealtime
        }
    }
}
