import Foundation

public enum EmailWriteOperation: String, Codable, Sendable { case draft, send }

/// One phone-owned approval, independent of model-generated tool arguments.
/// The caller consumes the pending instance
/// before dispatch, just as for the existing text-message confirmation flow.
public struct EmailConfirmationAuthorization: Sendable {
    public let id: String
    public let digest: String
    public let operation: EmailWriteOperation
    public let preparedAt: Date
    public let expiresAt: Date
    public let requiredReadback: String
    public private(set) var readbackCompletedAt: Date?

    public init(id: String, digest: String, operation: EmailWriteOperation,
                preparedAt: Date, expiresAt: Date, from: String, to: [String],
                cc: [String] = [], bcc: [String] = [], subject: String, body: String) {
        self.id = id
        self.digest = digest
        self.operation = operation
        self.preparedAt = preparedAt
        self.expiresAt = expiresAt
        let valid = UUID(uuidString: id) != nil
            && digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
            && expiresAt > preparedAt && expiresAt.timeIntervalSince(preparedAt) <= 600
            && !from.isEmpty && !to.isEmpty && to.count + cc.count + bcc.count <= 20
            && (to + cc + bcc).allSatisfy { !$0.isEmpty }
        if valid {
            let action = operation == .send ? "Send email" : "Save Gmail draft without sending"
            let recipients = ["From: \(Self.spokenAddress(from)).", "To: \(to.map(Self.spokenAddress).joined(separator: "; ")).",
                              "Cc: \(cc.isEmpty ? "none" : cc.map(Self.spokenAddress).joined(separator: "; ")).",
                              "Bcc: \(bcc.isEmpty ? "none" : bcc.map(Self.spokenAddress).joined(separator: "; "))."]
            let phrase = operation == .send ? "Confirm email" : "Confirm draft"
            requiredReadback = "\(action). \(recipients.joined(separator: " ")) Subject: \(subject.isEmpty ? "empty subject" : subject). Body: \(body.isEmpty ? "empty body" : body) Say exactly: \(phrase)."
        } else { requiredReadback = "" }
    }

    // Make punctuation significant before the shared spoken-text normalizer.
    // Otherwise a+b and a.b can collapse to the same normalized address.
    private static func spokenAddress(_ address: String) -> String {
        let names: [Character: String] = ["@": " at ", ".": " dot ", "+": " plus ", "-": " hyphen ", "_": " underscore ",
            "!": " exclamation ", "#": " hash ", "$": " dollar ", "%": " percent ", "&": " ampersand ", "'": " apostrophe ",
            "*": " asterisk ", "/": " slash ", "=": " equals ", "?": " question mark ", "^": " caret ", "`": " backtick ",
            "{": " left brace ", "|": " pipe ", "}": " right brace ", "~": " tilde "]
        return address.map { names[$0] ?? String($0) }.joined()
    }

    public mutating func noteReadbackCompleted(_ transcript: String, at date: Date) {
        guard !requiredReadback.isEmpty, date >= preparedAt, date < expiresAt,
              BoundSpokenReadback.matches(transcript, requiredReadback: requiredReadback) else { return }
        readbackCompletedAt = date
    }

    public func authorizes(id: String, digest: String, operation: EmailWriteOperation,
                           transcript: String, transcribedAt: Date, now: Date) -> Bool {
        guard id == self.id, digest == self.digest, operation == self.operation,
              !requiredReadback.isEmpty, now < expiresAt, let readbackCompletedAt,
              BoundSpokenReadback.confirmationIsFresh(transcribedAt: transcribedAt,
                readbackCompletedAt: readbackCompletedAt, now: now, maximumTranscriptAge: 30,
                minimumPostReadbackDelay: BoundSpokenReadback.minimumConfirmationDelay) else { return false }
        let normalized = BoundSpokenReadback.normalize(transcript)
        return normalized == (operation == .send ? "confirm email" : "confirm draft")
    }

    public func confirmationRecord(sourceItemId: String, transcript: String, transcribedAt: Date, now: Date) -> GmailPhoneConfirmation? {
        guard !sourceItemId.isEmpty, sourceItemId.count <= 256,
              authorizes(id: id, digest: digest, operation: operation, transcript: transcript,
                         transcribedAt: transcribedAt, now: now), let readbackCompletedAt else { return nil }
        return GmailPhoneConfirmation(id: id, digest: digest, operation: operation, sourceItemId: sourceItemId,
            readbackCompletedAt: readbackCompletedAt.timeIntervalSince1970 * 1000,
            confirmedAt: transcribedAt.timeIntervalSince1970 * 1000)
    }

    /// Any intervening speech consumes the slot, including early, unrelated,
    /// stale, or repeated confirmations. Used directly by the phone event path.
    public static func consumeConfirmation(
        from pending: inout EmailConfirmationAuthorization?,
        source: RealtimeUtteranceSource, enabled: Bool, now: Date
    ) -> GmailPhoneConfirmation? {
        defer { pending = nil }
        guard enabled else { return nil }
        return pending?.confirmationRecord(sourceItemId: source.itemID,
            transcript: source.transcript, transcribedAt: source.transcribedAt, now: now)
    }
}
