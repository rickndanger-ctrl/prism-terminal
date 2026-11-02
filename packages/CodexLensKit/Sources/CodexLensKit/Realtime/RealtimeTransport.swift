import Foundation

/// The seam between the pure session logic (testable, here) and the live audio
/// stack (WebRTC + AVFoundation, on-device only). CodexLensKit defines this
/// protocol and drives it from `RealtimeSessionMachine`; the app supplies a
/// concrete `WebRTCRealtimeTransport` that actually opens the peer connection.
///
/// Deliberately NO stub/fake "live" implementation ships here — a fake that
/// pretended to carry audio would be worse than an honest gap. The only
/// conformances are (1) the on-device WebRTC transport (TODO, in CodexLensApp)
/// and (2) test doubles under Tests/.
public protocol RealtimeTransport: AnyObject, Sendable {
    /// Open the Realtime connection using a short-lived credential.
    func connect(using credential: RealtimeCredential) async throws
    /// Tear the connection down.
    func disconnect() async
    /// Send a tool/response event up to the model.
    func send(_ message: RealtimeOutboundMessage) async throws
}
