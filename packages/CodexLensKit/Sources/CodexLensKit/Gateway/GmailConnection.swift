import Foundation

public struct GmailAccountIdentity: Decodable, Sendable {
    public let emailAddress: String
}

public struct GmailConnectionAttempt: Decodable, Sendable {
    public let id: String
    public let status: String
}

public struct GmailConnectionStatus: Decodable, Sendable {
    public let attempt: GmailConnectionAttempt?
}

public struct GmailConnectionStart: Decodable, Sendable {
    public let id: String
    public let status: String
    public let authorizationURL: URL
    public let openOn: String
}

public struct GmailDisconnectResult: Decodable, Sendable {
    public let status: String
    public let googleAccessRevoked: Bool
}
