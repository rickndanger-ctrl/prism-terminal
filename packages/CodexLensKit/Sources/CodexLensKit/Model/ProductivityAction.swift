import Foundation
import CryptoKit

public enum ProductivityKind: String, Codable, Sendable { case reminder, calendarEvent }

public struct ProductivityAction: Codable, Equatable, Sendable {
    public let kind: ProductivityKind
    public let title: String
    public let start: Date?
    public let end: Date?
    public let timeZone: String

    public init(kind: ProductivityKind, title: String, start: Date?, end: Date?, timeZone: String) {
        self.kind = kind; self.title = title; self.start = start; self.end = end; self.timeZone = timeZone
    }

    public init(arguments: JSONValue) throws {
        guard case .object(let values) = arguments,
              Set(values.keys) == Set(["kind", "title", "start", "end", "timeZone"]),
              case .string(let rawKind) = values["kind"], let kind = ProductivityKind(rawValue: rawKind),
              case .string(let title) = values["title"], case .string(let zone) = values["timeZone"] else {
            throw ProductivityError.invalidRequest
        }
        func date(_ field: String) throws -> Date? {
            if values[field] == .null { return nil }
            guard case .string(let text) = values[field] else { throw ProductivityError.invalidDate }
            let formatter = ISO8601DateFormatter()
            if let parsed = formatter.date(from: text) { return parsed }
            formatter.formatOptions.insert(.withFractionalSeconds)
            guard let parsed = formatter.date(from: text) else { throw ProductivityError.invalidDate }
            return parsed
        }
        self.init(kind: kind, title: title, start: try date("start"), end: try date("end"), timeZone: zone)
    }

    public func validate(now: Date = Date()) throws {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              title.count <= 180, !title.contains("\n"), TimeZone(identifier: timeZone) != nil else {
            throw ProductivityError.invalidRequest
        }
        if let start {
            guard start > now, start.timeIntervalSince(now) <= 5 * 366 * 86400 else { throw ProductivityError.invalidDate }
        }
        switch kind {
        case .reminder:
            guard end == nil else { throw ProductivityError.invalidRequest }
        case .calendarEvent:
            guard let start, let end, end > start, end.timeIntervalSince(start) <= 7 * 86400 else {
                throw ProductivityError.invalidDate
            }
        }
    }

    /// Explicit wearer commands only; screen text and ambient observations are
    /// not sufficient authority to create a personal record.
    public static func requestedKind(_ transcript: String) -> ProductivityKind? {
        guard let text = TaskTakingSpeechPolicy.authoritativeTaskText(from: transcript)?.lowercased() else { return nil }
        let prefix = #"^(?:(?:please|can you|could you|would you|will you)\s+)*(?:please\s+)?"#
        if text.range(of: prefix + #"(?:remind me\b|(?:add|create|set|make)\s+(?:a\s+|an\s+)?reminder\b)"#, options: .regularExpression) != nil {
            return .reminder
        }
        if text.range(of: prefix + #"(?:(?:add|create|schedule|make|book)\s+(?:a\s+|an\s+)?(?:calendar\s+)?(?:event|appointment|meeting)\b|(?:add|put|schedule)\b.+\b(?:on|in|to)\s+my calendar\b)"#, options: .regularExpression) != nil {
            return .calendarEvent
        }
        return nil
    }
}

public enum ProductivityError: LocalizedError {
    case invalidRequest, invalidDate, notAuthorized, permissionRequired, noCalendar, uncertainOutcome, changedReplay, journalUnavailable
    public var errorDescription: String? {
        switch self {
        case .invalidRequest: return "A clear title and valid time zone are required."
        case .invalidDate: return "Use a future date; calendar events need an end after their start. Ask for the missing time instead of guessing."
        case .notAuthorized: return "Ask me directly to create that reminder or calendar entry. Nothing was saved."
        case .permissionRequired: return "Enable Calendar or Reminders access in Codex Lens Settings while the phone is unlocked, then ask again."
        case .noCalendar: return "There is no writable default calendar or reminder list configured on this phone."
        case .uncertainOutcome: return "The previous save has an uncertain outcome. Check Calendar or Reminders before asking again; I will not create a duplicate automatically."
        case .changedReplay: return "That spoken request was already used for a different entry. Make a new explicit request."
        case .journalUnavailable: return "The save-protection record could not be stored. No new save was started."
        }
    }
}

public struct ProductivityReceipt: Codable, Equatable, Sendable {
    public let identifier: String
    public let action: ProductivityAction
    public init(identifier: String, action: ProductivityAction) { self.identifier = identifier; self.action = action }
}

/// Persist before invoking EventKit. An interrupted save remains uncertain;
/// neither reconnects nor a second tool call may silently replay it.
@MainActor
public final class ProductivityActionJournal {
    private struct Entry: Codable {
        let action: ProductivityAction
        var receipt: ProductivityReceipt?
        let recordedAt: Date? // Absent in earlier journals; never invent a timestamp.
    }
    private let url: URL
    private var entries: [String: Entry]
    public init(url: URL) throws {
        self.url = url
        if FileManager.default.fileExists(atPath: url.path) {
            entries = try JSONDecoder().decode([String: Entry].self, from: Data(contentsOf: url))
        } else { entries = [:] }
    }
    public func perform(action: ProductivityAction, source: RealtimeUtteranceSource, now: Date = Date(),
                        save: (ProductivityAction) throws -> ProductivityReceipt) throws -> ProductivityReceipt {
        let key = SHA256.hash(data: Data(source.itemID.utf8)).map { String(format: "%02x", $0) }.joined()
        if let existing = entries[key] {
            guard existing.action == action else { throw ProductivityError.changedReplay }
            guard let receipt = existing.receipt else { throw ProductivityError.uncertainOutcome }
            return receipt
        }
        guard now.timeIntervalSince(source.transcribedAt) >= -5,
              now.timeIntervalSince(source.transcribedAt) <= 120,
              ProductivityAction.requestedKind(source.transcript) == action.kind else { throw ProductivityError.notAuthorized }
        try action.validate(now: now)
        guard entries.count < 10_000 else { throw ProductivityError.journalUnavailable }
        entries[key] = Entry(action: action, receipt: nil, recordedAt: now)
        do { try persist() } catch { entries.removeValue(forKey: key); throw ProductivityError.journalUnavailable }
        let receipt = try save(action)
        guard !receipt.identifier.isEmpty, receipt.action == action else { throw ProductivityError.uncertainOutcome }
        entries[key]?.receipt = receipt
        do { try persist() } catch {
            entries[key]?.receipt = nil
            throw ProductivityError.uncertainOutcome
        }
        return receipt
    }

    /// Reads only Lens's own journal. A receipt proves its save completed at
    /// that time, not that the item still exists or a notification arrived.
    public func history(scope: ProductivityHistoryScope, limit: Int = 10) -> ProductivityHistory {
        let matching = entries.filter { _, entry in
            scope == .all || (scope == .reminder && entry.action.kind == .reminder)
                || (scope == .calendarEvent && entry.action.kind == .calendarEvent)
        }.sorted {
            let lhs = $0.value.recordedAt ?? .distantPast
            let rhs = $1.value.recordedAt ?? .distantPast
            return lhs == rhs ? $0.key < $1.key : lhs > rhs
        }
        let items = matching.prefix(max(0, min(limit, 20))).map { _, entry in
            ProductivityHistoryItem(action: entry.action,
                saveConfirmed: entry.receipt?.action == entry.action && !(entry.receipt?.identifier ?? "").isEmpty,
                recordedAt: entry.recordedAt)
        }
        return ProductivityHistory(items: items, totalMatching: matching.count)
    }
    private func persist() throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(entries).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
#if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
#endif
    }
}
