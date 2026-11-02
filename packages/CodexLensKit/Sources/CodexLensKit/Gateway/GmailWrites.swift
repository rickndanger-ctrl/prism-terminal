import Foundation

public struct GmailOutgoingMessage: Codable, Sendable {
    public let to: [String]
    public let cc: [String]
    public let bcc: [String]
    public let subject: String
    public let body: String
    public init(to: [String], cc: [String] = [], bcc: [String] = [], subject: String, body: String) {
        self.to = to; self.cc = cc; self.bcc = bcc; self.subject = subject; self.body = body
    }
}
public struct GmailPreparedWrite: Decodable, Sendable {
    public struct Content: Decodable, Sendable {
        public let from: String
        public let to: [String]
        public let cc: [String]
        public let bcc: [String]
        public let subject: String
        public let body: String
    }
    public let id: String
    public let digest: String
    public let operation: EmailWriteOperation
    public let expiresAt: Double // Gateway milliseconds since Unix epoch.
    public let content: Content

    public func authorization(preparedAt: Date) -> EmailConfirmationAuthorization {
        EmailConfirmationAuthorization(id: id, digest: digest, operation: operation, preparedAt: preparedAt,
            expiresAt: Date(timeIntervalSince1970: expiresAt / 1000), from: content.from,
            to: content.to, cc: content.cc, bcc: content.bcc, subject: content.subject, body: content.body)
    }
}
// Encodable only: model JSON cannot be decoded into a phone confirmation.
public struct GmailPhoneConfirmation: Encodable, Sendable {
    public let kind = "phone-email-confirmation"
    public let id: String
    public let digest: String
    public let operation: EmailWriteOperation
    public let sourceItemId: String
    public let readbackCompletedAt: Double
    public let confirmedAt: Double
}
public enum GmailWriteState: String, Decodable, Sendable { case prepared, submitting, accepted, uncertain, rejected, expired }
public struct GmailWriteStatus: Decodable, Sendable {
    public let id: String
    public let state: GmailWriteState
    public let receiptId: String?
}
public enum GmailWriteResolution: Sendable {
    case status(GmailWriteStatus)
    case uncertain(id: String)
}
