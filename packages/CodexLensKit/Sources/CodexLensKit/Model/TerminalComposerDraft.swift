import Foundation

/// A request-specific acceptance, whether received by HTTP or the live stream.
public struct TerminalCommandReceipt: Equatable, Sendable {
    public let id: String
    public let attachmentIDs: [UUID]
    public init(id: String, attachmentIDs: [UUID] = []) {
        self.id = id
        self.attachmentIDs = attachmentIDs
    }
}

/// Recognition text and its owner travel together, including through deferred
/// UI notifications. An old callback cannot borrow a newer dictation's ID.
public struct DictationTranscriptUpdate: Equatable, Sendable {
    public let id: UUID
    public let text: String
    public init(id: UUID, text: String) {
        self.id = id
        self.text = text
    }
}

/// Clearing is tied to the submitted editing revision, not just matching text.
/// An acknowledgment may arrive after an uncertain HTTP result or a reconnect.
public struct TerminalComposerDraft: Equatable, Sendable {
    public private(set) var text = ""
    private var revision: UInt64 = 0
    private var submission: Submission?
    private var dictation: DictationOwnership?
    private struct Submission: Equatable, Sendable {
        let id: String
        let revision: UInt64
    }
    private struct DictationOwnership: Equatable, Sendable {
        let id: UUID
        let revision: UInt64
    }
    public init() {}
    public mutating func edit(_ value: String) {
        // A manual edit takes ownership even if it restores the same words.
        dictation = nil
        guard value != text else { return }
        text = value
        revision &+= 1
    }
    /// Call once with a fresh ID before awaiting microphone permission/startup.
    /// Starting dictation is a new editing intent, so an older send receipt
    /// cannot clear its seed text while recognition is still starting.
    @discardableResult
    public mutating func beginDictation(id: UUID) -> String {
        revision &+= 1
        dictation = DictationOwnership(id: id, revision: revision)
        return text
    }
    /// Queued startup must still own its draft before opening the microphone.
    public func ownsDictation(id: UUID) -> Bool {
        guard let owner = dictation else { return false }
        return owner.id == id && owner.revision == revision
    }
    /// Partial/final recognition may replace only the revision it still owns.
    @discardableResult
    public mutating func applyDictation(_ update: DictationTranscriptUpdate) -> Bool {
        guard let owner = dictation, owner.id == update.id, owner.revision == revision else { return false }
        if update.text != text {
            text = update.text
            revision &+= 1
        }
        dictation = DictationOwnership(id: owner.id, revision: revision)
        return true
    }
    public mutating func endDictation(id: UUID) {
        guard dictation?.id == id else { return }
        dictation = nil
    }
    public mutating func submitted(id: String) {
        // Explicit Send ends dictation ownership; queued recognition cannot
        // repopulate a draft after the corresponding acceptance clears it.
        dictation = nil
        // Retrying an uncertain request must not claim newly edited text.
        guard submission?.id != id else { return }
        submission = Submission(id: id, revision: revision)
    }
    public mutating func rejected(id: String) {
        guard submission?.id == id else { return }
        submission = nil
    }
    /// Returns true only once for the matching submission. Callers may then
    /// remove its acknowledged attachments while retaining newer ones.
    @discardableResult
    public mutating func acknowledge(_ receipt: TerminalCommandReceipt) -> Bool {
        guard let submitted = submission, submitted.id == receipt.id else { return false }
        submission = nil
        if revision == submitted.revision {
            text = ""
            revision &+= 1
        }
        return true
    }
}
