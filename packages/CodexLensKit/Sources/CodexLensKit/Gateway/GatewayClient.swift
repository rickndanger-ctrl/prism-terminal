import Foundation

/// How to reach the Mac gateway. The token here is the GATEWAY bearer token —
/// it grants gateway access only. There is deliberately no field for an OpenAI
/// key: the phone never holds one, and this type makes that structural.
public struct GatewayConfiguration: Sendable {
    public let baseURL: URL
    /// Provides the current gateway bearer token. A closure so a rotated token
    /// is picked up without rebuilding the client.
    public let tokenProvider: @Sendable () -> String

    public init(baseURL: URL, tokenProvider: @escaping @Sendable () -> String) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
    }
}

/// Calls the Codex Lens gateway: mints short-lived Realtime credentials, creates
/// and polls tasks, and pages the event stream. Foundation-only and fully
/// testable through an injected `Transport`.
public struct GatewayClient: Sendable {
    private let configuration: GatewayConfiguration
    private let transport: Transport
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(configuration: GatewayConfiguration, transport: Transport = URLSessionTransport()) {
        self.configuration = configuration
        self.transport = transport
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    // MARK: - Realtime credential

    public func beginGmailConnection(features: [String]) async throws -> GmailConnectionStart {
        let request = try makeRequest(method: "POST", path: "/v1/gmail/connection", jsonBody: ["features": features])
        let result = try await perform(request, as: GmailConnectionStart.self)
        guard result.openOn == "gateway-mac", result.authorizationURL.scheme == "https",
              result.authorizationURL.host == "accounts.google.com",
              result.authorizationURL.user == nil, result.authorizationURL.password == nil,
              result.authorizationURL.port == nil else {
            throw GatewayError.decoding("Invalid Gmail sign-in destination.")
        }
        return result
    }

    public func gmailConnectionStatus() async throws -> GmailConnectionStatus {
        try await perform(makeRequest(method: "GET", path: "/v1/gmail/connection"), as: GmailConnectionStatus.self)
    }
    public func gmailAccount() async throws -> GmailAccountIdentity {
        try await perform(makeRequest(method: "GET", path: "/v1/gmail/account"), as: GmailAccountIdentity.self)
    }
    public func searchGmail(query: String) async throws -> JSONValue {
        try await perform(makeRequest(method: "POST", path: "/v1/gmail/search", jsonBody: ["query": query]), as: JSONValue.self)
    }
    public func readGmail(messageId: String) async throws -> JSONValue {
        try await perform(makeRequest(method: "POST", path: "/v1/gmail/read", jsonBody: ["messageId": messageId]), as: JSONValue.self)
    }

    public func disconnectGmail() async throws -> GmailDisconnectResult {
        try await perform(makeRequest(method: "DELETE", path: "/v1/gmail/connection"), as: GmailDisconnectResult.self)
    }

    public func prepareGmailWrite(requestKey: UUID, operation: EmailWriteOperation, message: GmailOutgoingMessage) async throws -> GmailPreparedWrite {
        struct Body: Encodable { let requestKey: String; let operation: EmailWriteOperation; let message: GmailOutgoingMessage }
        let request = try makeRequest(method: "POST", path: "/v1/gmail/writes/prepare",
            jsonBody: Body(requestKey: requestKey.uuidString, operation: operation, message: message))
        let prepared = try await perform(request, as: GmailPreparedWrite.self)
        guard prepared.operation == operation, UUID(uuidString: prepared.id) != nil,
              prepared.digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              prepared.expiresAt.isFinite else { throw GatewayError.decoding("Invalid Gmail preparation.") }
        return prepared
    }

    public func gmailWriteStatus(id: String) async throws -> GmailWriteStatus {
        guard UUID(uuidString: id) != nil else { throw GatewayError.decoding("Invalid Gmail intent ID.") }
        let result = try await perform(makeRequest(method: "GET", path: "/v1/gmail/writes/\(escape(id))"), as: GmailWriteStatus.self)
        guard result.id == id, result.state != .accepted || !(result.receiptId ?? "").isEmpty else {
            throw GatewayError.decoding("Gmail status did not match the attempted operation.")
        }
        return result
    }

    /// Removes only an unsubmitted gateway preview. It cannot retract mail.
    public func cancelGmailPreview(id: String) async throws -> Bool {
        guard UUID(uuidString: id) != nil else { throw GatewayError.decoding("Invalid Gmail intent ID.") }
        struct Result: Decodable { let cancelled: Bool }
        let result = try await perform(makeRequest(method: "DELETE", path: "/v1/gmail/writes/\(escape(id))"), as: Result.self)
        return result.cancelled
    }

    /// One POST only. Lost/malformed responses are recovered with a GET, never
    /// another execute. Persist confirmation.id on the phone before calling.
    public func executeGmailWriteRecoveringStatus(_ confirmation: GmailPhoneConfirmation) async -> GmailWriteResolution {
        struct Body: Encodable { let confirmation: GmailPhoneConfirmation }
        do {
            let request = try makeRequest(method: "POST", path: "/v1/gmail/writes/execute", jsonBody: Body(confirmation: confirmation))
            let result = try await perform(request, as: GmailWriteStatus.self)
            guard result.id == confirmation.id, result.state == .accepted, !(result.receiptId ?? "").isEmpty else {
                throw GatewayError.decoding("Gmail write receipt was not confirmed.")
            }
            return .status(result)
        } catch {
            do { return .status(try await gmailWriteStatus(id: confirmation.id)) }
            catch { return .uncertain(id: confirmation.id) }
        }
    }

    /// Gets an ephemeral direct-provider credential or a fixed gateway route.
    /// Long-lived provider keys stay on the Mac.
    public func realtimeCredential(model: String? = nil) async throws -> RealtimeCredential {
        var body: [String: String] = [:]
        if let model { body["model"] = model }
        let request = try makeRequest(method: "POST", path: "/v1/realtime/credentials", jsonBody: body)
        let issued = try await perform(request, as: RealtimeCredential.self)
        if model == "huggingface" || model == GeminiGatewayProtocol.model || model == GptLiveProtocol.model {
            guard issued.model == model else { throw GatewayError.decoding("Wrong voice backend returned.") }
            let route = model == "huggingface" ? "huggingface" : model == GeminiGatewayProtocol.model ? "gemini" : "gpt-live"
            return RealtimeCredential(value: configuration.tokenProvider(), expiresAt: issued.expiresAt,
                model: issued.model, signalingURL: configuration.baseURL.appendingPathComponent("v1/realtime/\(route)/calls"))
        }
        guard issued.model != "huggingface", issued.model != GeminiGatewayProtocol.model,
              issued.model != GptLiveProtocol.model else {
            throw GatewayError.decoding("Unexpected gateway voice backend returned.")
        }
        // Never accept an arbitrary signaling destination from a credential response.
        return RealtimeCredential(value: issued.value, expiresAt: issued.expiresAt, model: issued.model, sessionId: issued.sessionId)
    }

    // MARK: - Live public web research

    public func researchWeb(question: String) async throws -> WebResearchResult {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/web/research",
            jsonBody: ["question": question]
        )
        return try await perform(request, as: WebResearchResult.self)
    }

    /// Uses the Mac-hosted Luna medium lane for deliberate reasoning without
    /// browsing, controlling the computer, or changing external state.
    public func reason(question: String) async throws -> ReasoningResult {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/reasoning/answer",
            jsonBody: ["question": question]
        )
        return try await perform(request, as: ReasoningResult.self)
    }

    // MARK: - Tasks

    /// Loads only the repositories and policy flags allowlisted by the Mac.
    public func approvedProjects() async throws -> ApprovedProjectsResponse {
        let request = try makeRequest(method: "GET", path: "/v1/projects")
        return try await perform(request, as: ApprovedProjectsResponse.self)
    }

    /// Asks Codex to inspect one gateway-approved repository without editing it.
    public func inspectCodexProject(projectId: String, question: String) async throws -> CodexProjectInspection {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/codex/inspect",
            jsonBody: ["projectId": projectId, "question": question]
        )
        return try await perform(request, as: CodexProjectInspection.self)
    }

    public func createTask(
        projectId: String,
        idempotencyKey: String,
        requestedPath: String? = nil
    ) async throws -> CodexTask {
        var body: [String: String] = ["projectId": projectId, "idempotencyKey": idempotencyKey]
        if let requestedPath { body["requestedPath"] = requestedPath }
        let request = try makeRequest(method: "POST", path: "/v1/tasks", jsonBody: body)
        return try await perform(request, as: CodexTask.self)
    }

    public func task(id: String) async throws -> CodexTask {
        let request = try makeRequest(method: "GET", path: "/v1/tasks/\(escape(id))")
        return try await perform(request, as: CodexTask.self)
    }

    /// One page of the event stream. Pass the last `nextCursor` you saw as
    /// `after`; you receive only events with `seq > after`. Omit for the backlog.
    public func events(taskId: String, after: Int? = nil) async throws -> TaskEventsPage {
        var path = "/v1/tasks/\(escape(taskId))/events"
        if let after { path += "?after=\(after)" }
        let request = try makeRequest(method: "GET", path: path)
        return try await perform(request, as: TaskEventsPage.self)
    }

    // MARK: - Computer inspection

    /// Reads only the frontmost Mac application name through the sub-second
    /// macOS fast path. It does not capture the screen or start Computer Use.
    public func frontmostComputerApp() async throws -> FrontmostComputerApp {
        let request = try makeRequest(method: "GET", path: "/v1/computer/frontmost")
        return try await perform(request, as: FrontmostComputerApp.self)
    }

    /// Opens or activates one named Mac app through the deterministic gateway
    /// fast path, then returns only after macOS confirms it is frontmost.
    public func focusComputerApp(app: String) async throws -> FocusedComputerApp {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/computer/focus",
            jsonBody: ["app": app]
        )
        return try await perform(request, as: FocusedComputerApp.self)
    }

    /// Closes only the current main Mac window. The target app keeps ownership
    /// of any unsaved-changes prompt; the gateway never chooses a response.
    public func closeFrontmostComputerWindow() async throws -> ClosedComputerWindow {
        let request = try makeRequest(method: "POST", path: "/v1/computer/close-window")
        return try await perform(request, as: ClosedComputerWindow.self)
    }

    /// Minimizes or restores only the current main Mac window and returns only
    /// after the gateway verifies the resulting accessibility state.
    public func setFrontmostComputerWindowState(action: String) async throws -> ComputerWindowStateResult {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/computer/window-state",
            jsonBody: ["action": action]
        )
        return try await perform(request, as: ComputerWindowStateResult.self)
    }

    /// Asks the Mac gateway for one read-only accessibility inspection.
    public func inspectComputer(app: String, question: String) async throws -> ComputerInspection {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/computer/inspect",
            jsonBody: ["app": app, "question": question]
        )
        return try await perform(request, as: ComputerInspection.self)
    }

    /// Binds one exact Mac/Chrome instruction. The gateway decides whether it
    /// can execute from the current utterance or needs a second confirmation.
    public func prepareComputerAction(
        instruction: String,
        surface: String = "auto"
    ) async throws -> PreparedComputerAction {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/computer/prepare",
            jsonBody: ["instruction": instruction, "surface": surface]
        )
        return try await perform(request, as: PreparedComputerAction.self)
    }

    /// Consumes one exact prepared action using the gateway-approved
    /// authorization mode. Never retry automatically after an uncertain call.
    public func executePreparedComputerAction(
        confirmationId: String,
        digest: String,
        authorization: String
    ) async throws -> ComputerActionResult {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/computer/execute",
            jsonBody: [
                "confirmationId": confirmationId,
                "digest": digest,
                "authorization": authorization,
            ]
        )
        return try await perform(request, as: ComputerActionResult.self)
    }

    /// Stops only the currently running one-off action with this phone-owned
    /// id. The gateway does not claim success until its process group exits.
    public func cancelComputerAction(confirmationId: String) async throws -> CancelledComputerAction {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/computer/actions/\(escape(confirmationId))/cancel"
        )
        return try await perform(request, as: CancelledComputerAction.self)
    }

    // MARK: - Policy-gated durable assistant tasks

    /// Binds one exact, durable Codex task. Ordinary work may start from the
    /// same utterance; consequential work remains pending. Project scope
    /// requires a gateway-approved writable project id; Mac scope must not
    /// include one.
    public func prepareAssistantTask(
        instruction: String,
        scope: AssistantTaskScope,
        projectId: String? = nil,
        requireExplicitConfirmation: Bool = false,
        visualReferences: [LensAttachment] = []
    ) async throws -> PreparedAssistantTask {
        var body: [String: JSONValue] = [
            "instruction": .string(instruction),
            "scope": .string(scope.rawValue),
        ]
        if let projectId { body["projectId"] = .string(projectId) }
        // Sent only when forcing, so the default request shape is unchanged.
        if requireExplicitConfirmation { body["requireExplicitConfirmation"] = .bool(true) }
        if !visualReferences.isEmpty {
            body["visualReferences"] = .array(visualReferences.suffix(3).map { reference in
                .object(["label": .string(reference.label), "jpegBase64": .string(reference.jpegData.base64EncodedString())])
            })
        }
        let request = try makeRequest(
            method: "POST",
            path: "/v1/assistant-tasks/prepare",
            jsonBody: body
        )
        return try await perform(request, as: PreparedAssistantTask.self)
    }

    /// Starts only the exact prepared task represented by this opaque bound
    /// pair. Callers must not retry automatically after an uncertain response.
    public func startPreparedAssistantTask(
        confirmationId: String,
        digest: String,
        authorization: String
    ) async throws -> AssistantTaskStatus {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/assistant-tasks/start",
            jsonBody: [
                "confirmationId": confirmationId,
                "digest": digest,
                "authorization": authorization,
            ]
        )
        return try await perform(request, as: AssistantTaskStatus.self)
    }

    /// Retries only explicit busy rejections for single-utterance tasks within
    /// the supplied deadline. An uncertain start is never replayed; recover it
    /// through the prepared task's read-only status endpoint instead.
    public func startPreparedAssistantTaskRecoveringStatus(
        taskId: String,
        confirmationId: String,
        digest: String,
        authorization: String,
        retryBusyUntil: Date? = nil
    ) async throws -> AssistantTaskStatus {
        var delay: Int64 = 500
        while true {
        do {
            return try await startPreparedAssistantTask(
                confirmationId: confirmationId,
                digest: digest,
                authorization: authorization
            )
        } catch let startError {
            // Only an explicit busy rejection proves the POST did not start.
            // A timeout followed by a prepared GET may race a delayed POST.
            if authorization == "single_utterance",
               case GatewayError.unexpectedStatus(409, let message) = startError,
               message == "Another full Codex task is already running.",
               let retryBusyUntil, Date() < retryBusyUntil {
                try await Task.sleep(for: .milliseconds(delay))
                try Task.checkCancellation()
                if Date() < retryBusyUntil {
                    delay = min(delay * 2, 3_000)
                    continue
                }
            }
            do {
                return try await assistantTask(id: taskId)
            } catch let statusError {
                throw GatewayError.transport(
                    "An uncertain start was not retried. Status for task \(taskId) " +
                    "also failed. Start error: \(startError.localizedDescription). " +
                    "Status error: \(statusError.localizedDescription)."
                )
            }
        }
        }
    }

    /// Reads durable progress for one assistant task. This is read-only and
    /// safe to poll after the phone disconnects or the voice session ends.
    public func assistantTask(id: String) async throws -> AssistantTaskStatus {
        let request = try makeRequest(
            method: "GET",
            path: "/v1/assistant-tasks/\(escape(id))"
        )
        return try await perform(request, as: AssistantTaskStatus.self)
    }

    /// Requests cancellation of one task. The returned status is the durable
    /// gateway result, including an already-terminal task when applicable.
    public func cancelAssistantTask(id: String) async throws -> AssistantTaskStatus {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/assistant-tasks/\(escape(id))/cancel"
        )
        return try await perform(request, as: AssistantTaskStatus.self)
    }

    /// Explicitly acknowledges one task whose final outcome is unknown. This
    /// clears only the gateway's safety lock; it does not change the historical
    /// task into a success and callers must never invoke it automatically.
    public func reconcileAssistantTask(id: String) async throws -> AssistantTaskStatus {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/assistant-tasks/\(escape(id))/reconcile",
            jsonBody: ["acknowledgeUnknownOutcome": true]
        )
        return try await perform(request, as: AssistantTaskStatus.self)
    }

    /// Attempts reconciliation once. If the response is lost, a read-only GET
    /// determines whether the lock cleared; the consequential POST is never
    /// replayed automatically.
    public func reconcileAssistantTaskRecoveringStatus(
        id: String
    ) async throws -> AssistantTaskStatus {
        do {
            return try await reconcileAssistantTask(id: id)
        } catch let reconcileError {
            do {
                return try await assistantTask(id: id)
            } catch let statusError {
                throw GatewayError.transport(
                    "Reconciliation was attempted once and was not retried. Status for task \(id) " +
                    "also failed. Reconciliation error: \(reconcileError.localizedDescription). " +
                    "Status error: \(statusError.localizedDescription)."
                )
            }
        }
    }

    // MARK: - Confirmation-gated Messages

    /// Resolves a contact and prepares an exact preview. This never sends.
    public func prepareTextMessage(
        recipient: String,
        message: String,
        serviceType: MessageServiceType
    ) async throws -> PreparedTextMessage {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/messages/prepare",
            jsonBody: [
                "recipient": recipient,
                "message": message,
                "serviceType": serviceType.rawValue,
            ]
        )
        return try await perform(request, as: PreparedTextMessage.self)
    }

    /// Sends only the exact, unexpired preview identified by this bound pair.
    public func sendPreparedText(confirmationId: String, digest: String) async throws -> SentTextMessage {
        let request = try makeRequest(
            method: "POST",
            path: "/v1/messages/send",
            jsonBody: ["confirmationId": confirmationId, "digest": digest]
        )
        return try await perform(request, as: SentTextMessage.self)
    }

    /// Attempts the external send exactly once. If the POST does not return a
    /// usable result, recover only through the durable read-only intent status;
    /// the send request is never replayed.
    public func sendPreparedTextRecoveringStatus(
        confirmationId: String,
        digest: String
    ) async throws -> TextSendRecoveryResult {
        do {
            return .accepted(try await sendPreparedText(
                confirmationId: confirmationId,
                digest: digest
            ))
        } catch let sendError {
            do {
                let status = try await textMessageStatus(confirmationId: confirmationId)
                guard status.confirmationId == confirmationId else {
                    throw GatewayError.decoding("The recovered text status did not match the attempted text intent.")
                }
                return .recovered(status)
            } catch let statusError {
                throw GatewayError.transport(
                    "The text send was attempted once and was not retried. Status for intent \(confirmationId) " +
                    "also failed. Send error: \(sendError.localizedDescription). " +
                    "Status error: \(statusError.localizedDescription)."
                )
            }
        }
    }

    /// Reads the durable, redacted outcome of one message intent. This never
    /// retries a send and never returns the message body.
    public func textMessageStatus(confirmationId: String) async throws -> MessageIntentStatus {
        let request = try makeRequest(
            method: "GET",
            path: "/v1/messages/\(escape(confirmationId))/status"
        )
        return try await perform(request, as: MessageIntentStatus.self)
    }

    /// Checks Contacts permission and enabled/connected Messages services.
    /// This is read-only and cannot send.
    public func textMessageReadiness() async throws -> MessageReadiness {
        let request = try makeRequest(method: "GET", path: "/v1/messages/readiness")
        return try await perform(request, as: MessageReadiness.self)
    }

    // MARK: - Internals

    private func makeRequest(
        method: String,
        path: String
    ) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: configuration.baseURL) else {
            throw GatewayError.transport("Bad URL for path \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        // The ONLY credential the phone presents is the gateway token.
        request.setValue("Bearer \(configuration.tokenProvider())", forHTTPHeaderField: "Authorization")
        return request
    }

    private func makeRequest<Body: Encodable>(
        method: String,
        path: String,
        jsonBody: Body
    ) throws -> URLRequest {
        var request = try makeRequest(method: method, path: path)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(jsonBody)
        return request
    }

    private func perform<Value: Decodable>(_ request: URLRequest, as _: Value.Type) async throws -> Value {
        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await transport.send(request)
        } catch let error as GatewayError {
            throw error
        } catch {
            throw GatewayError.transport(error.localizedDescription)
        }

        guard (200..<300).contains(response.statusCode) else {
            throw mapError(status: response.statusCode, data: data)
        }

        do {
            return try decoder.decode(Value.self, from: data)
        } catch {
            throw GatewayError.decoding("Could not decode \(Value.self): \(error.localizedDescription)")
        }
    }

    private func mapError(status: Int, data: Data) -> GatewayError {
        let message = (try? decoder.decode(GatewayErrorBody.self, from: data))?.message
            ?? "Request failed with status \(status)"
        switch status {
        case 400: return .badRequest(message)
        case 401: return .unauthorized(message)
        case 404: return .notFound(message)
        case 422: return .unprocessable(message)
        case 503: return .realtimeUnavailable(message)
        default: return .unexpectedStatus(status, message)
        }
    }

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }
}
