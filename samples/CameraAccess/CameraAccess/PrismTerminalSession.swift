import SwiftUI
import CodexLensKit

struct PrismTerminalDescriptor: Codable, Identifiable {
    let id: String
    var title: String
    var state: String
    let model: String
    let updatedAt: String
}
struct PrismTerminalReply: Equatable {
    let requestID: String
    let text: String
    let status: String
    let sequence: Int
}
private struct PrismTerminalFailure: Decodable { let message: String? }
private struct PrismTerminalHTTPError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}
private struct PrismPendingCommand: Codable {
    let sessionID: String
    let gateway: String
    let requestID: String
    let text: String
    let attachments: [LensAttachment]
}
private struct PrismTerminalCache: Codable {
    var pending: PrismPendingCommand?
    var pendingPad: CommandPadPendingRequest?
    var images: [String: [LensAttachment]] = [:]
}

@MainActor
final class PrismTerminalSession: ObservableObject {
    @Published private(set) var descriptor: PrismTerminalDescriptor?
    @Published private(set) var history: [PrismTerminalDescriptor] = []
    @Published private(set) var transcript = TerminalTranscript()
    @Published private(set) var connecting = false
    @Published private(set) var streaming = false
    @Published private(set) var dispatching = false
    @Published private(set) var padRunning = false
    @Published private(set) var checkingPadReceipt = false
    @Published private(set) var pendingPadRequest: CommandPadPendingRequest?
    @Published private(set) var padReceiptState: CommandPadReceiptState?
    @Published private(set) var padRecoveryNotice = ""
    @Published private(set) var lastPadDurationMS: Int?
    @Published private(set) var lastPadSummary = ""
    @Published private(set) var pendingText: String?
    @Published private(set) var acceptedCommand: TerminalCommandReceipt?
    @Published private(set) var completedReply: PrismTerminalReply?
    var onReply: ((PrismTerminalReply) -> Void)?
    @Published private(set) var state = "disconnected"
    @Published var notice = ""
    @Published private(set) var connectionNotice = ""
    @Published private(set) var revision = 0
    @Published private(set) var restoringHistory = false
    @Published private(set) var hasEarlierHistory = false
    private var selectedID = ""
    private var activeGateway = ""
    private var generation = UUID()
    private var streamTask: Task<Void, Never>?
    private var cache = PrismTerminalCache()
    private let cacheURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("prism-terminal-cache.json")
    private let network: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 3600
        return URLSession(configuration: configuration)
    }()
    var busy: Bool { ["running", "stopping"].contains(state) || dispatching || padRunning }
    var canSend: Bool { state == "ready" && streaming && !dispatching && !padRunning && !hasPendingCommand }
    // Native commands use authenticated HTTP, not the Codex chat event stream.
    // Never bypass an active task or an unresolved terminal submission.
    var canUsePad: Bool { !busy && state != "uncertain" && !hasPendingCommand }
    var hasPendingCommand: Bool { cache.pending != nil || cache.pendingPad != nil }
    var hasPendingPadCommand: Bool { cache.pendingPad != nil }
    var canAcknowledgePadOutcome: Bool {
        hasPendingPadCommand && !padRunning && !checkingPadReceipt && padReceiptState != .running
    }
    var pendingRequestID: String? { cache.pending?.requestID }

    init() {
        if let data = try? Data(contentsOf: cacheURL),
           let saved = try? JSONDecoder().decode(PrismTerminalCache.self, from: data) { cache = saved }
        pendingText = cache.pending?.text
        pendingPadRequest = cache.pendingPad
        if cache.pendingPad != nil {
            padReceiptState = .unknown
            padRecoveryNotice = "The last Mac action needs checking. Nothing will be repeated automatically."
        }
    }
    func images(for id: String) -> [LensAttachment] { cache.images[id] ?? [] }
    @discardableResult private func persist() -> Bool {
        do {
            try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(cache).write(to: cacheURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return true
        } catch { notice = "Could not save the command locally. \(error.localizedDescription)"; return false }
    }
    func padCall(_ path: String, body: [String: Any]) async throws -> String {
        guard ["execute", "classify"].contains(path), canUsePad else { throw URLError(.resourceUnavailable) }
        padRunning = true
        let started = ProcessInfo.processInfo.systemUptime
        var receiptSaveMS: Double?
        var preparationMS: Double?
        var responseWaitMS: Double?
        if path == "execute" { lastPadSummary = ""; lastPadDurationMS = nil }
        defer {
            padRunning = false
            if path == "execute" {
                lastPadDurationMS = max(0, Int((ProcessInfo.processInfo.systemUptime - started) * 1000))
                // Timing-only diagnostics, written after the action path. No
                // speech, target, image, URL, or credential is retained here.
                let defaults = UserDefaults.standard
                defaults.set(Date().timeIntervalSince1970, forKey: "prismPadLastTimingAt")
                defaults.set(lastPadDurationMS, forKey: "prismPadLastTotalMs")
                for (suffix, value) in [("ReceiptSaveMs", receiptSaveMS),
                                        ("PreparationMs", preparationMS),
                                        ("ResponseWaitMs", responseWaitMS)] {
                    let key = "prismPadLast" + suffix
                    if let value { defaults.set(value, forKey: key) }
                    else { defaults.removeObject(forKey: key) }
                }
            }
        }
        var req = try request("/v1/command-pad/" + path, body: body)
        req.timeoutInterval = path == "classify" ? 125 : 25
        let pending: CommandPadPendingRequest?
        if path == "execute" {
            guard let id = body["requestId"] as? String, UUID(uuidString: id) != nil else { throw URLError(.badURL) }
            let marker = CommandPadPendingRequest(requestID: id, gateway: PrismCodexBridge.address)
            cache.pendingPad = marker
            // Persist the opaque receipt identity before any side effect. The
            // payload stays only in this request; recovery can only read a GET.
            let saveStarted = ProcessInfo.processInfo.systemUptime
            let saved = persist()
            receiptSaveMS = max(0, (ProcessInfo.processInfo.systemUptime - saveStarted) * 1000)
            guard saved else {
                cache.pendingPad = nil
                throw PrismTerminalHTTPError(status: 0, message: "Could not save action recovery. Nothing was sent.")
            }
            pendingPadRequest = marker; padReceiptState = .running
            padRecoveryNotice = "Waiting for the Mac action response."
            pending = marker
        } else { pending = nil }
        do {
            let requestStarted = ProcessInfo.processInfo.systemUptime
            preparationMS = max(0, (requestStarted - started) * 1000)
            let (data, response) = try await network.data(for: req)
            responseWaitMS = max(0, (ProcessInfo.processInfo.systemUptime - requestStarted) * 1000)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            guard (200..<300).contains(http.statusCode) else {
                if let pending, CommandPadReceipt.isDefinitiveExecutionRejection(http.statusCode) {
                    _ = clearPendingPad(pending)
                }
                let message = (try? JSONDecoder().decode(PrismTerminalFailure.self, from: data).message) ?? "Command pad unavailable."
                throw PrismTerminalHTTPError(status: http.statusCode, message: message)
            }
            struct PadResponse: Decodable { let action: String?; let summary: String? }
            let value = try JSONDecoder().decode(PadResponse.self, from: data)
            if let pending {
                guard let summary = value.summary, !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw URLError(.cannotParseResponse)
                }
                finishPadResponse(pending, summary: summary)
                return summary
            }
            guard let action = value.action else { throw URLError(.cannotParseResponse) }
            return action
        } catch {
            if let pending, cache.pendingPad == pending {
                // A timeout or malformed reply never authorizes another POST.
                // The receipt may already prove the first request completed.
                padReceiptState = .unknown
                if let summary = await readPadReceipt(pending) { return summary }
            }
            throw error
        }
    }
    @discardableResult private func clearPendingPad(_ expected: CommandPadPendingRequest) -> Bool {
        guard cache.pendingPad == expected else { return false }
        cache.pendingPad = nil
        guard persist() else {
            cache.pendingPad = expected
            padRecoveryNotice = "Could not save recovery. Check the last action again before sending more commands."
            return false
        }
        pendingPadRequest = nil; padReceiptState = nil; padRecoveryNotice = ""
        return true
    }
    private func finishPadResponse(_ pending: CommandPadPendingRequest, summary: String) {
        guard cache.pendingPad == pending else { return }
        // This acknowledges the stored operation response, not action success.
        // The summary may explicitly say that the action failed verification.
        lastPadSummary = summary; padReceiptState = .completed
        _ = clearPendingPad(pending)
        if acceptedCommand?.id != pending.requestID {
            acceptedCommand = TerminalCommandReceipt(id: pending.requestID)
        }
    }
    private func readPadReceipt(_ pending: CommandPadPendingRequest) async -> String? {
        guard !checkingPadReceipt, cache.pendingPad == pending else { return nil }
        guard pending.gateway == PrismCodexBridge.address else {
            padRecoveryNotice = "Restore the original Mac connection in Settings to check the last action."
            return nil
        }
        guard UUID(uuidString: pending.requestID) != nil else {
            padRecoveryNotice = "The saved receipt identifier is invalid. Check the Mac before clearing recovery."
            return nil
        }
        checkingPadReceipt = true
        defer { checkingPadReceipt = false }
        do {
            var req = try request("/v1/command-pad/receipts/" + pending.requestID)
            req.timeoutInterval = 5
            let (data, response) = try await network.data(for: req)
            guard cache.pendingPad == pending else { return nil }
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            if http.statusCode == 404 {
                padReceiptState = .unknown
                padRecoveryNotice = "No receipt was found. The outcome is still unknown; check the Mac. Nothing was repeated."
                return nil
            }
            guard http.statusCode == 200 else { throw URLError(.badServerResponse) }
            let receipt = try JSONDecoder().decode(CommandPadReceipt.self, from: data)
            if let summary = receipt.completedSummary {
                finishPadResponse(pending, summary: summary)
                return summary
            }
            padReceiptState = receipt.state == .running ? .running : .unknown
            padRecoveryNotice = receipt.state == .running
                ? "The Mac reports that action is still running. Check again; it will not be repeated."
                : "The outcome is unknown. Check your Mac before clearing recovery; nothing was repeated."
        } catch {
            guard cache.pendingPad == pending else { return nil }
            padReceiptState = .unknown
            padRecoveryNotice = "Couldn't read the last action receipt. Check the connection and Mac; nothing was repeated."
        }
        return nil
    }
    func checkLastPadAction() async {
        guard !padRunning, !checkingPadReceipt, let pending = cache.pendingPad else { return }
        if let summary = await readPadReceipt(pending) { notice = summary }
    }
    /// User explicitly checked the Mac. This clears only the local recovery
    /// block; it neither repeats the action nor claims the action succeeded.
    func acknowledgePadOutcome() -> String? {
        guard canAcknowledgePadOutcome, let pending = cache.pendingPad, clearPendingPad(pending) else { return nil }
        notice = "Recovery cleared. Nothing was repeated. Review any preserved command before sending it."
        return pending.requestID
    }
    private func request(_ path: String, body: [String: Any]? = nil) throws -> URLRequest {
        _ = try PrismCodexBridge.client() // Reuse the existing URL and credential validation.
        guard let base = URL(string: PrismCodexBridge.address),
              let url = URL(string: path, relativeTo: base)?.absoluteURL else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(PrismCodexBridge.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }
    private func call<T: Decodable>(_ path: String, body: [String: Any]? = nil, as type: T.Type) async throws -> T {
        let (data, response) = try await network.data(for: request(path, body: body))
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(response.statusCode) else {
            throw PrismTerminalHTTPError(status: response.statusCode,
                message: (try? JSONDecoder().decode(PrismTerminalFailure.self, from: data).message) ?? "Mac connection returned \(response.statusCode).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func refreshHistory() async {
        struct Response: Decodable { let sessions: [PrismTerminalDescriptor] }
        do { history = try await call("/v1/terminal/sessions", as: Response.self).sessions }
        catch { notice = error.localizedDescription }
    }
    func connect(id: String? = nil, new: Bool = false, acknowledge: Bool = false) async {
        guard !connecting, !dispatching else { return }
        connecting = true
        defer { connecting = false }
        notice = ""
        if let pending = cache.pending, pending.gateway != PrismCodexBridge.address {
            pause()
            notice = "Restore the original Mac connection in Settings to check the pending command."
            return
        }
        if activeGateway != PrismCodexBridge.address {
            pause(); selectedID = ""; transcript = TerminalTranscript()
            activeGateway = PrismCodexBridge.address
        }
        await refreshHistory()
        let saved = UserDefaults.standard.string(forKey: "prismTerminalSession:" + activeGateway)
        let target = id ?? cache.pending?.sessionID ?? (new ? UUID().uuidString : saved ?? history.first?.id ?? UUID().uuidString)
        if target != selectedID {
            pause()
            selectedID = target
            transcript = TerminalTranscript()
            revision += 1
        }
        do {
            descriptor = try await call("/v1/terminal/connect", body: ["sessionId": target, "acknowledgeUnknownOutcome": acknowledge], as: PrismTerminalDescriptor.self)
            state = descriptor?.state ?? "disconnected"
            UserDefaults.standard.set(target, forKey: "prismTerminalSession:" + activeGateway)
            startStream()
        } catch {
            descriptor = history.first { $0.id == target }
            state = descriptor?.state ?? "disconnected"
            notice = error.localizedDescription
            if descriptor != nil { startStream() }
        }
        // Reconnection never resubmits a native action. It can recover the
        // opaque receipt even when the Codex event stream is unavailable.
        if hasPendingPadCommand { await checkLastPadAction() }
    }
    func pause() {
        generation = UUID()
        streamTask?.cancel(); streamTask = nil
        streaming = false
    }
    private func startStream() {
        guard streamTask == nil else { return }
        let generation = self.generation, id = selectedID
        streamTask = Task {
            var delay = 1
            while !Task.isCancelled && generation == self.generation {
                do {
                    if transcript.cursor == 0 {
                        struct Snapshot: Decodable {
                            let entries: [TerminalEntry]
                            let cursor: Int
                            let state: String
                            let hasEarlier: Bool
                            let acceptedRequestIds: [String]
                        }
                        restoringHistory = true
                        defer { restoringHistory = false }
                        let snapshot = try await call("/v1/terminal/\(id)/snapshot", as: Snapshot.self)
                        guard !Task.isCancelled, generation == self.generation else { return }
                        transcript = TerminalTranscript(entries: snapshot.entries, cursor: snapshot.cursor, state: snapshot.state)
                        state = snapshot.state
                        hasEarlierHistory = snapshot.hasEarlier
                        // Recover acceptance without speaking old replies or replaying commands.
                        if let pending = cache.pending, pending.sessionID == id,
                           snapshot.acceptedRequestIds.contains(pending.requestID) { accept(pending) }
                        revision += 1
                    }
                    var request = try request("/v1/terminal/\(id)/events?after=\(transcript.cursor)")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await network.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    streaming = true; connectionNotice = ""; delay = 1
                    for try await line in bytes.lines {
                        guard !Task.isCancelled, generation == self.generation else { return }
                        guard line.hasPrefix("data: "), let data = line.dropFirst(6).data(using: .utf8) else { continue }
                        let event = try JSONDecoder().decode(TerminalEvent.self, from: data)
                        let isNew = event.sequence > transcript.cursor
                        transcript.apply(event)
                        if isNew && event.kind == "reply" {
                            let reply = PrismTerminalReply(requestID: event.itemId,
                                text: event.text ?? "", status: event.status ?? "failed", sequence: event.sequence)
                            completedReply = reply
                            onReply?(reply)
                        }
                        if event.kind == "state" {
                            state = transcript.state
                            if state == "disconnected" {
                                Task { if self.state == "disconnected" { await self.connect() } }
                            }
                        }
                        if event.kind == "input", let command = cache.pending,
                           event.itemId == command.requestID {
                            accept(command)
                        }
                        revision += 1
                    }
                    throw URLError(.networkConnectionLost)
                } catch {
                    guard !Task.isCancelled, generation == self.generation else { return }
                    streaming = false
                    connectionNotice = "Reconnecting to your Mac…"
                    try? await Task.sleep(for: .seconds(delay))
                    delay = min(delay * 2, 15)
                }
            }
        }
    }
    private func accept(_ command: PrismPendingCommand) {
        let receipt = TerminalCommandReceipt(id: command.requestID,
            attachmentIDs: command.attachments.map(\.id))
        if acceptedCommand?.id != receipt.id { acceptedCommand = receipt }
        if cache.pending?.requestID == command.requestID {
            cache.pending = nil; pendingText = nil; persist()
            notice = ""
        }
    }
    /// The durable request ID survives an unknown HTTP outcome. Reconnect only reads output.
    func send(_ text: String, attachments: [LensAttachment], requestID: String = UUID().uuidString, retry: Bool = false) async -> Bool {
        guard !dispatching, !padRunning, !hasPendingPadCommand else { return false }
        if !retry && !canSend { notice = "Wait for Codex to be ready, then send."; return false }
        let command = retry ? cache.pending : PrismPendingCommand(sessionID: selectedID, gateway: PrismCodexBridge.address, requestID: requestID, text: text, attachments: attachments)
        guard let command else { return false }
        guard command.gateway == PrismCodexBridge.address else {
            notice = "Restore the original Mac connection before retrying this command."
            return false
        }
        cache.pending = command; pendingText = command.text
        cache.images[command.requestID] = command.attachments
        guard persist() else { cache.pending = nil; pendingText = nil; return false }
        dispatching = true
        defer { dispatching = false }
        notice = ""
        do {
            var body: [String: Any] = ["requestId": command.requestID, "text": command.text]
            if !command.attachments.isEmpty {
                body["images"] = command.attachments.map { ["label": $0.label, "jpegBase64": $0.jpegData.base64EncodedString()] }
            }
            _ = try await call("/v1/terminal/\(command.sessionID)/turns", body: body, as: PrismTerminalDescriptor.self)
            accept(command)
            return true
        } catch {
            // The event stream may have delivered the acceptance before HTTP failed.
            if acceptedCommand?.id == command.requestID { return true }
            if let failure = error as? PrismTerminalHTTPError, [400, 401, 404, 409].contains(failure.status) {
                cache.pending = nil; pendingText = nil; persist()
                notice = failure.message
            } else {
                notice = "The send result is not confirmed. Reconnect to check it, or retry the same command safely."
            }
            return false
        }
    }
    func retryPending() async -> Bool {
        guard let pending = cache.pending else { return false }
        return await send(pending.text, attachments: pending.attachments, retry: true)
    }
    func stop() async {
        do { _ = try await call("/v1/terminal/\(selectedID)/interrupt", body: [:], as: PrismTerminalDescriptor.self) }
        catch { notice = error.localizedDescription }
    }
}
