import Foundation

/// Reconstructs bounded streaming transcription segments only for the local
/// hard-stop phrase. Segment revisions replace their prior text, while split
/// segments are joined in audio order.
public struct StreamingAssistantStopCommand: Sendable {
    private struct Fragment: Sendable {
        let id: String
        let text: String
        let start: Double
    }

    private var fragmentsByItemID: [String: [String: Fragment]] = [:]
    private let maximumFragmentsPerItem = 8

    public init() {}

    public mutating func accepts(
        itemID: String,
        segmentID: String?,
        text: String,
        start: Double
    ) -> Bool {
        let itemID = itemID.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !itemID.isEmpty, !text.isEmpty else { return false }

        let normalizedSegmentID = segmentID?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let stableSegmentID = normalizedSegmentID.flatMap { $0.isEmpty ? nil : $0 }
        var fragments = fragmentsByItemID[itemID] ?? [:]
        let baseID = stableSegmentID ?? "start:\(start)"
        let fragmentID: String
        if stableSegmentID == nil,
           let existing = fragments[baseID],
           !text.hasPrefix(existing.text),
           !existing.text.hasPrefix(text) {
            fragmentID = "\(baseID):\(fragments.count)"
        } else {
            fragmentID = baseID
        }
        fragments[fragmentID] = Fragment(id: fragmentID, text: text, start: start)

        while fragments.count > maximumFragmentsPerItem,
              let oldest = fragments.values.min(by: {
                  if $0.start == $1.start { return $0.id < $1.id }
                  return $0.start < $1.start
              }) {
            fragments.removeValue(forKey: oldest.id)
        }
        fragmentsByItemID[itemID] = fragments

        let transcript = fragments.values
            .sorted {
                if $0.start == $1.start { return $0.id < $1.id }
                return $0.start < $1.start
            }
            .map(\.text)
            .joined(separator: " ")
        return ExplicitAssistantStopCommand.accepts(transcript)
    }

    public mutating func remove(itemID: String) {
        fragmentsByItemID.removeValue(forKey: itemID)
    }

    public mutating func reset() {
        fragmentsByItemID.removeAll(keepingCapacity: true)
    }
}
