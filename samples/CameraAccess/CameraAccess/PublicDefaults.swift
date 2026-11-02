import Foundation

// Public-build defaults for optional legacy integrations. No credentials belong
// in source control. Configure integrations in the app's Settings instead.
// The type name is retained for compatibility with the upstream sample.
enum Secrets {
    static let geminiAPIKey = ""
    static let openClawHost = ""
    static let openClawPort = 18789
    static let openClawHookToken = ""
    static let openClawGatewayToken = ""
    static let webrtcSignalingURL = ""
}
