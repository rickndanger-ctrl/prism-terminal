import XCTest
@testable import CodexLensKit

/// A deterministic transport that records the request it was given and returns
/// a canned response — no network under test.
final class StubTransport: Transport, @unchecked Sendable {
    struct Response: Sendable { let status: Int; let body: Data }
    private let handler: @Sendable (URLRequest) -> Response
    private let requestLock = NSLock()
    private var recordedRequest: URLRequest?
    var lastRequest: URLRequest? {
        requestLock.withLock { recordedRequest }
    }

    init(_ handler: @escaping @Sendable (URLRequest) -> Response) {
        self.handler = handler
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requestLock.withLock { recordedRequest = request }
        let response = handler(request)
        let http = HTTPURLResponse(
            url: request.url!, statusCode: response.status, httpVersion: nil, headerFields: nil
        )!
        return (response.body, http)
    }
}

actor AssistantTaskRecoveryTransport: Transport {
    private var requests: [URLRequest] = []
    private let statusResponse: StubTransport.Response?
    private var busyResponses: Int

    init(statusResponse: StubTransport.Response?, busyResponses: Int = 0) {
        self.statusResponse = statusResponse
        self.busyResponses = busyResponses
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if request.httpMethod == "POST" {
            if busyResponses > 0 {
                busyResponses -= 1
                return (Data("{\"statusCode\":409,\"error\":\"Conflict\",\"message\":\"Another full Codex task is already running.\"}".utf8),
                        HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!)
            }
            throw URLError(.timedOut)
        }
        guard let statusResponse else {
            throw URLError(.cannotConnectToHost)
        }
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: statusResponse.status,
            httpVersion: nil,
            headerFields: nil
        )!
        return (statusResponse.body, http)
    }

    func recordedRequests() -> [URLRequest] {
        requests
    }
}

final class GatewayClientTests: XCTestCase {
    func testGeminiUsesConfiguredGatewayAndNeverProviderSuppliedDestinationOrSecret() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data("""
            {"value":"provider-secret-must-not-reach-phone-signaling","model":"gemini-3.1-flash-live-preview","expiresAt":"2026-09-05T00:00:00Z","signalingURL":"https://untrusted.test/calls"}
            """.utf8))
        }
        let client = GatewayClient(configuration: GatewayConfiguration(
            baseURL: URL(string: "https://gateway.test")!, tokenProvider: { "gateway-token" }
        ), transport: transport)
        let credential = try await client.realtimeCredential(model: GeminiGatewayProtocol.model)
        XCTAssertEqual(credential.value, "gateway-token")
        XCTAssertEqual(credential.signalingURL?.absoluteString, "https://gateway.test/v1/realtime/gemini/calls")
        XCTAssertTrue(credential.usesGeminiGatewayProtocol)
        XCTAssertFalse(credential.usesHuggingFaceProtocol)
    }

    func testGptLiveUsesConfiguredGatewayAndNeverProviderSuppliedDestinationOrSecret() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data("""
            {"value":"provider-secret-must-not-reach-phone-signaling","model":"gpt-live-1","expiresAt":"2026-09-05T00:00:00Z","signalingURL":"https://untrusted.test/calls"}
            """.utf8))
        }
        let client = GatewayClient(configuration: GatewayConfiguration(
            baseURL: URL(string: "https://gateway.test")!, tokenProvider: { "gateway-token" }
        ), transport: transport)
        let credential = try await client.realtimeCredential(model: GptLiveProtocol.model)
        XCTAssertEqual(credential.value, "gateway-token")
        XCTAssertEqual(credential.signalingURL?.absoluteString, "https://gateway.test/v1/realtime/gpt-live/calls")
        XCTAssertTrue(credential.usesGptLiveProtocol)
        XCTAssertFalse(credential.usesGeminiGatewayProtocol)
        XCTAssertFalse(credential.usesHuggingFaceProtocol)
    }

    func testRejectsMismatchedVoiceBackendInsteadOfSilentlySwitchingProviders() async throws {
        for (requested, returned) in [
            (GeminiGatewayProtocol.model, "huggingface"),
            (GeminiGatewayProtocol.model, "gpt-realtime-2.1"),
            ("gpt-realtime-2.1", GeminiGatewayProtocol.model),
            ("gpt-realtime-2.1", "huggingface"),
            (GptLiveProtocol.model, "gpt-realtime-2.1"),
            ("gpt-realtime-2.1", GptLiveProtocol.model),
        ] {
            let body = try JSONSerialization.data(withJSONObject: [
                "value": "placeholder", "model": returned, "expiresAt": "2026-09-05T00:00:00Z"
            ])
            let transport = StubTransport { _ in
                .init(status: 200, body: body)
            }
            let client = GatewayClient(configuration: GatewayConfiguration(
                baseURL: URL(string: "https://gateway.test")!, tokenProvider: { "gateway-token" }
            ), transport: transport)
            do {
                _ = try await client.realtimeCredential(model: requested)
                XCTFail("Mismatched provider was accepted")
            } catch GatewayError.decoding { /* Expected provider isolation. */ }
        }
    }
    func testHFSignalingUsesOnlyConfiguredGatewayAndItsToken() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data("""
            {"value":"placeholder","model":"huggingface","expiresAt":"2026-09-05T00:00:00Z","signalingURL":"https://untrusted.test/calls"}
            """.utf8))
        }
        let client = GatewayClient(configuration: GatewayConfiguration(
            baseURL: URL(string: "https://gateway.test")!, tokenProvider: { "gateway-token" }
        ), transport: transport)
        let result = try await client.realtimeCredential(model: "huggingface")
        XCTAssertEqual(result.value, "gateway-token")
        XCTAssertEqual(result.signalingURL?.absoluteString, "https://gateway.test/v1/realtime/huggingface/calls")
    }

    func testOpenAICredentialCannotRedirectSignaling() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data("""
            {"value":"ephemeral","model":"gpt-realtime-2.1","expiresAt":"2026-09-05T00:00:00Z","signalingURL":"https://untrusted.test/calls"}
            """.utf8))
        }
        let client = GatewayClient(configuration: GatewayConfiguration(
            baseURL: URL(string: "https://gateway.test")!, tokenProvider: { "gateway-token" }
        ), transport: transport)
        let result = try await client.realtimeCredential(model: "gpt-realtime-2.1")
        XCTAssertNil(result.signalingURL)
        XCTAssertEqual(result.value, "ephemeral")
    }

    func testResearchWebUsesReadOnlyGatewayEndpoint() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data("""
            {"answer":"A current answer.","sources":[{"title":"Official source","url":"https://example.com/source"}],"searched":true}
            """.utf8))
        }
        let client = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "https://gateway.test")!,
                tokenProvider: { "gateway-token" }
            ),
            transport: transport
        )

        let result = try await client.researchWeb(question: "What happened today?")
        XCTAssertEqual(result.answer, "A current answer.")
        XCTAssertEqual(result.sources.first?.title, "Official source")
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/web/research")
        XCTAssertEqual(transport.lastRequest?.httpMethod, "POST")
    }

    func testReasoningUsesLunaReadOnlyGatewayEndpoint() async throws {
        let transport = StubTransport { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/reasoning/answer")
            let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
            XCTAssertEqual(body?["question"], "Compare these two approaches.")
            return .init(status: 200, body: Data("""
            {"answer":"Use the durable broker.","model":"gpt-5.6-luna","reasoningEffort":"medium"}
            """.utf8))
        }
        let client = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "https://gateway.test")!,
                tokenProvider: { "gateway-token" }
            ),
            transport: transport
        )

        let result = try await client.reason(question: "Compare these two approaches.")
        XCTAssertEqual(result.answer, "Use the durable broker.")
        XCTAssertEqual(result.model, "gpt-5.6-luna")
        XCTAssertEqual(result.reasoningEffort, "medium")
    }

    func testApprovedProjectsUsesProtectedReadOnlyRoute() async throws {
        let transport = StubTransport { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/projects")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer t")
            return .init(status: 200, body: Data("""
            {
              "projects": [{
                "id": "sample-project",
                "displayName": "Sample Project",
                "path": "/tmp/sample-project",
                "allowedCommands": ["npm test"],
                "allowWorkspaceWrite": true,
                "allowDependencyInstall": false,
                "allowCommit": false,
                "allowPush": false,
                "allowDeploy": false
              }]
            }
            """.utf8))
        }
        let client = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "http://127.0.0.1:8787")!,
                tokenProvider: { "t" }
            ),
            transport: transport
        )

        let response = try await client.approvedProjects()
        XCTAssertEqual(response.projects.map(\.id), ["sample-project"])
        XCTAssertTrue(response.projects[0].allowWorkspaceWrite)
        XCTAssertFalse(response.projects[0].allowDeploy)
    }

    func testInspectCodexProjectBindsSelectedProjectAndQuestion() async throws {
        let transport = StubTransport { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/codex/inspect")
            let body = try! JSONDecoder().decode([String: String].self, from: request.httpBody!)
            XCTAssertEqual(body, ["projectId": "sample-project", "question": "What is unfinished?"])
            return .init(status: 200, body: Data("""
            {
              "projectId": "sample-project",
              "projectName": "Sample Project",
              "summary": "One verified item remains.",
              "files": ["src/calculator.js"],
              "readOnly": true
            }
            """.utf8))
        }
        let client = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "http://127.0.0.1:8787")!,
                tokenProvider: { "t" }
            ),
            transport: transport
        )
        let result = try await client.inspectCodexProject(
            projectId: "sample-project",
            question: "What is unfinished?"
        )
        XCTAssertTrue(result.readOnly)
        XCTAssertEqual(result.files, ["src/calculator.js"])
    }

    private func makeClient(_ transport: StubTransport) -> GatewayClient {
        let config = GatewayConfiguration(
            baseURL: URL(string: "http://127.0.0.1:8787")!,
            tokenProvider: { "gateway-token-123" }
        )
        return GatewayClient(configuration: config, transport: transport)
    }

    func testRealtimeCredentialSendsGatewayTokenAndNeverAnOpenAIKey() async throws {
        let transport = StubTransport { _ in
            return .init(status: 200, body: Data("""
            { "value": "ek_1", "expiresAt": "2026-07-16T12:00:00.000Z", "model": "gpt-realtime" }
            """.utf8))
        }
        let client = makeClient(transport)

        let credential = try await client.realtimeCredential(model: "gpt-realtime")

        XCTAssertEqual(credential.value, "ek_1")
        let auth = transport.lastRequest?.value(forHTTPHeaderField: "Authorization")
        XCTAssertEqual(auth, "Bearer gateway-token-123")
        // The request body carries only the model — never a key.
        let body = String(data: transport.lastRequest?.httpBody ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("gpt-realtime"))
        XCTAssertFalse(body.lowercased().contains("apikey"))
        XCTAssertFalse(body.lowercased().contains("sk-"))
    }

    func testCredentialUnavailableMapsTo503Retryable() async throws {
        let transport = StubTransport { _ in
            .init(status: 503, body: Data("""
            { "statusCode": 503, "error": "Service Unavailable", "message": "not configured" }
            """.utf8))
        }
        let client = makeClient(transport)

        do {
            _ = try await client.realtimeCredential()
            XCTFail("expected an error")
        } catch let error as GatewayError {
            XCTAssertEqual(error, .realtimeUnavailable("not configured"))
            XCTAssertTrue(error.isRetryable)
        }
    }

    func testUnauthorizedMaps() async throws {
        let transport = StubTransport { _ in
            .init(status: 401, body: Data("""
            { "statusCode": 401, "error": "Unauthorized", "message": "bad token" }
            """.utf8))
        }
        do {
            _ = try await makeClient(transport).task(id: "task_1")
            XCTFail("expected an error")
        } catch let error as GatewayError {
            XCTAssertEqual(error, .unauthorized("bad token"))
            XCTAssertFalse(error.isRetryable)
        }
    }

    func testEventsSendsCursorInQuery() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data(#"{ "events": [], "nextCursor": 4 }"#.utf8))
        }
        let client = makeClient(transport)

        let page = try await client.events(taskId: "task 1", after: 4)

        XCTAssertEqual(page.nextCursor, 4)
        let url = transport.lastRequest?.url?.absoluteString ?? ""
        XCTAssertTrue(url.contains("/v1/tasks/task%201/events"), "task id is percent-encoded: \(url)")
        XCTAssertTrue(url.contains("after=4"))
    }

    func testEventsWithoutCursorOmitsQuery() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data(#"{ "events": [], "nextCursor": -1 }"#.utf8))
        }
        _ = try await makeClient(transport).events(taskId: "task_1")
        XCTAssertFalse((transport.lastRequest?.url?.absoluteString ?? "").contains("after="))
    }

    func testCreateTaskPostsIdempotencyKey() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data("""
            { "id": "task_1", "projectId": "p", "state": "queued", "idempotencyKey": "k1",
              "createdAt": "2026-07-16T00:00:00.000Z", "updatedAt": "2026-07-16T00:00:00.000Z" }
            """.utf8))
        }
        let client = makeClient(transport)
        let task = try await client.createTask(projectId: "p", idempotencyKey: "k1")
        XCTAssertEqual(task.state, .queued)
        let body = String(data: transport.lastRequest?.httpBody ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("k1"))
    }

    func testPrepareTextMessageUsesNonSendingEndpoint() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data("""
            { "confirmationId": "confirm-1", "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "recipientDisplay": "Alex Example", "maskedDestination": "••••0123",
              "message": "I am on my way.", "serviceType": "iMessage",
              "expiresAt": "2026-08-26T19:05:00.000Z",
              "requiresExplicitConfirmation": true }
            """.utf8))
        }
        let prepared = try await makeClient(transport).prepareTextMessage(
            recipient: "Alex Example",
            message: "I am on my way.",
            serviceType: .iMessage
        )
        XCTAssertEqual(prepared.recipientDisplay, "Alex Example")
        XCTAssertEqual(prepared.serviceType, .iMessage)
        XCTAssertTrue(prepared.requiresExplicitConfirmation)
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/messages/prepare")
        let body = String(data: transport.lastRequest?.httpBody ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("\"serviceType\":\"iMessage\""))
    }

    func testPrepareAndExecuteComputerActionUseBoundEndpoints() async throws {
        let transport = StubTransport { request in
            if request.url?.path == "/v1/computer/prepare" {
                return .init(status: 200, body: Data("""
                { "confirmationId": "computer-1",
                  "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  "instruction": "Open the current project page in Chrome.",
                  "surface": "chrome", "expiresAt": "2026-08-26T19:05:00.000Z",
                  "requiresExplicitConfirmation": true }
                """.utf8))
            }
            return .init(status: 200, body: Data("""
            { "completed": true, "confirmationRequired": false,
              "summary": "Opened the requested page.", "surface": "chrome" }
            """.utf8))
        }
        let client = makeClient(transport)
        let prepared = try await client.prepareComputerAction(
            instruction: "Open the current project page in Chrome.",
            surface: "chrome"
        )
        XCTAssertTrue(prepared.requiresExplicitConfirmation)
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/computer/prepare")

        let result = try await client.executePreparedComputerAction(
            confirmationId: prepared.confirmationId,
            digest: prepared.digest,
            authorization: "explicit_confirmation"
        )
        XCTAssertTrue(result.completed)
        XCTAssertFalse(result.confirmationRequired)
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/computer/execute")
        let body = try JSONDecoder().decode(
            [String: String].self,
            from: transport.lastRequest?.httpBody ?? Data()
        )
        XCTAssertEqual(body, [
            "confirmationId": "computer-1",
            "digest": String(repeating: "a", count: 64),
            "authorization": "explicit_confirmation",
        ])
        XCTAssertNil(body["instruction"])
    }

    func testCancelComputerActionUsesExactPreparedActionEndpoint() async throws {
        let transport = StubTransport { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.httpBody)
            return .init(status: 200, body: Data("""
            {
              "confirmationId": "computer 1", "cancelled": true,
              "outcomeUncertain": false, "summary": "The in-flight computer action stopped."
            }
            """.utf8))
        }

        let result = try await makeClient(transport).cancelComputerAction(
            confirmationId: "computer 1"
        )

        XCTAssertTrue(result.cancelled)
        XCTAssertFalse(result.outcomeUncertain)
        XCTAssertEqual(
            transport.lastRequest?.url?.path,
            "/v1/computer/actions/computer 1/cancel"
        )
    }

    func testPrepareAssistantTaskBindsProjectInstructionWithoutStartingWork() async throws {
        let transport = StubTransport { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/assistant-tasks/prepare")
            let body = try! JSONDecoder().decode([String: String].self, from: request.httpBody!)
            XCTAssertEqual(body, [
                "instruction": "Fix the failing tests and verify the build.",
                "scope": "project",
                "projectId": "codex-lens",
            ])
            return .init(status: 200, body: Data("""
            {
              "taskId": "assistant-1", "confirmationId": "confirm-1",
              "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "instruction": "Fix the failing tests and verify the build.",
              "scope": "project", "projectId": "codex-lens",
              "model": "gpt-5.6-sol", "reasoningEffort": "medium",
              "expiresAt": "2026-09-02T20:05:00.000Z",
              "requiresExplicitConfirmation": true
            }
            """.utf8))
        }
        let prepared = try await makeClient(transport).prepareAssistantTask(
            instruction: "Fix the failing tests and verify the build.",
            scope: .project,
            projectId: "codex-lens"
        )
        XCTAssertEqual(prepared.taskId, "assistant-1")
        XCTAssertEqual(prepared.scope, .project)
        XCTAssertEqual(prepared.projectId, "codex-lens")
        XCTAssertEqual(prepared.model, "gpt-5.6-sol")
        XCTAssertEqual(prepared.reasoningEffort, "medium")
        XCTAssertTrue(prepared.requiresExplicitConfirmation)
        XCTAssertNotNil(prepared.expiresAtDate)
    }

    func testPrepareMacAssistantTaskOmitsProjectId() async throws {
        let transport = StubTransport { request in
            let body = try! JSONDecoder().decode([String: String].self, from: request.httpBody!)
            XCTAssertEqual(body, ["instruction": "Organize the Downloads folder.", "scope": "mac"])
            return .init(status: 200, body: Data("""
            {
              "taskId": "assistant-2", "confirmationId": "confirm-2",
              "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "instruction": "Organize the Downloads folder.", "scope": "mac",
              "model": "gpt-5.6-sol", "reasoningEffort": "medium",
              "expiresAt": "2026-09-02T20:05:00.000Z",
              "requiresExplicitConfirmation": true
            }
            """.utf8))
        }
        let prepared = try await makeClient(transport).prepareAssistantTask(
            instruction: "Organize the Downloads folder.",
            scope: .mac
        )
        XCTAssertEqual(prepared.scope, .mac)
        XCTAssertNil(prepared.projectId)
    }

    func testPrepareAssistantTaskSendsBoundedVisualReferences() async throws {
        let refs = (0..<5).map { LensAttachment(jpegData: Data([UInt8($0)]), label: "Photo \($0)") }
        let transport = StubTransport { request in
            let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            let images = body["visualReferences"] as! [[String: String]]
            XCTAssertEqual(images.count, 3)
            XCTAssertEqual(images.map { $0["label"]! }, ["Photo 2", "Photo 3", "Photo 4"])
            XCTAssertEqual(images[0]["jpegBase64"], Data([2]).base64EncodedString())
            XCTAssertEqual(body["instruction"] as? String, "Build a Blender model from this reference.")
            return .init(status: 200, body: Data("""
            {"taskId":"visual-1","confirmationId":"confirm-1","digest":"digest",
             "instruction":"Build a Blender model from this reference.","scope":"mac",
             "model":"gpt-5.6-sol","reasoningEffort":"medium",
             "expiresAt":"2026-11-01T20:05:00.000Z","requiresExplicitConfirmation":false}
            """.utf8))
        }
        _ = try await makeClient(transport).prepareAssistantTask(
            instruction: "Build a Blender model from this reference.", scope: .mac, visualReferences: refs)
    }

    func testStartPreparedAssistantTaskSendsOnlyBoundConfirmation() async throws {
        let transport = StubTransport { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/assistant-tasks/start")
            let body = try! JSONDecoder().decode([String: String].self, from: request.httpBody!)
            XCTAssertEqual(body, [
                "confirmationId": "confirm-1",
                "digest": String(repeating: "a", count: 64),
                "authorization": "explicit_confirmation",
            ])
            XCTAssertNil(body["instruction"])
            return .init(status: 200, body: Data(Self.runningAssistantTaskJSON.utf8))
        }
        let status = try await makeClient(transport).startPreparedAssistantTask(
            confirmationId: "confirm-1",
            digest: String(repeating: "a", count: 64),
            authorization: "explicit_confirmation"
        )
        XCTAssertEqual(status.state, .running)
        XCTAssertEqual(status.threadId, "thread-1")
        XCTAssertFalse(status.state.isTerminal)
    }

    func testTimedOutAssistantTaskStartRecoversByStatusWithoutReplayingPost() async throws {
        let transport = AssistantTaskRecoveryTransport(statusResponse: .init(
            status: 200,
            body: Data(Self.runningAssistantTaskJSON.utf8)
        ))
        let config = GatewayConfiguration(
            baseURL: URL(string: "http://127.0.0.1:8787")!,
            tokenProvider: { "gateway-token-123" }
        )
        let client = GatewayClient(configuration: config, transport: transport)

        let status = try await client.startPreparedAssistantTaskRecoveringStatus(
            taskId: "assistant-1",
            confirmationId: "confirm-1",
            digest: String(repeating: "a", count: 64),
            authorization: "explicit_confirmation"
        )

        XCTAssertEqual(status.state, .running)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET"])
        XCTAssertEqual(requests[0].url?.path, "/v1/assistant-tasks/start")
        XCTAssertEqual(requests[1].url?.path, "/v1/assistant-tasks/assistant-1")
    }

    func testBusyRetriesButTimeoutStopsPostRetriesEvenIfStillPrepared() async throws {
        let preparedJSON = Self.runningAssistantTaskJSON.replacingOccurrences(of: "\"running\"", with: "\"prepared\"")
        let transport = AssistantTaskRecoveryTransport(
            statusResponse: .init(status: 200, body: Data(preparedJSON.utf8)), busyResponses: 1
        )
        let client = GatewayClient(configuration: GatewayConfiguration(
            baseURL: URL(string: "http://127.0.0.1:8787")!, tokenProvider: { "test" }
        ), transport: transport)
        let status = try await client.startPreparedAssistantTaskRecoveringStatus(
            taskId: "assistant-1", confirmationId: "confirm-1",
            digest: String(repeating: "a", count: 64), authorization: "single_utterance",
            retryBusyUntil: Date().addingTimeInterval(10)
        )
        XCTAssertEqual(status.state, .prepared)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "POST", "GET"])
    }

    func testFailedStartAndStatusReportsKnownTaskWithoutReplayingPost() async {
        let transport = AssistantTaskRecoveryTransport(statusResponse: nil)
        let config = GatewayConfiguration(
            baseURL: URL(string: "http://127.0.0.1:8787")!,
            tokenProvider: { "gateway-token-123" }
        )
        let client = GatewayClient(configuration: config, transport: transport)

        do {
            _ = try await client.startPreparedAssistantTaskRecoveringStatus(
                taskId: "assistant-uncertain",
                confirmationId: "confirm-1",
                digest: String(repeating: "a", count: 64),
                authorization: "explicit_confirmation"
            )
            XCTFail("Expected recovery failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("assistant-uncertain"))
            XCTAssertTrue(error.localizedDescription.contains("was not retried"))
        }

        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET"])
    }

    func testAssistantTaskStatusUsesEscapedReadOnlyEndpoint() async throws {
        let transport = StubTransport { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.httpBody)
            return .init(status: 200, body: Data(Self.runningAssistantTaskJSON.utf8))
        }
        let status = try await makeClient(transport).assistantTask(id: "assistant 1")
        XCTAssertTrue((transport.lastRequest?.url?.absoluteString ?? "").contains("/v1/assistant-tasks/assistant%201"))
        XCTAssertEqual(status.summary, "Codex accepted the task and is starting work.")
    }

    func testCancelAssistantTaskUsesTaskSpecificEndpointAndDecodesTerminalState() async throws {
        let transport = StubTransport { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.httpBody)
            return .init(status: 200, body: Data("""
            {
              "taskId": "assistant-1", "instruction": "Fix the failing tests and verify the build.",
              "scope": "project", "projectId": "codex-lens",
              "state": "cancelled", "model": "gpt-5.6-sol", "reasoningEffort": "medium",
              "preparedAt": "2026-09-02T20:00:00.000Z",
              "expiresAt": "2026-09-02T20:05:00.000Z",
              "updatedAt": "2026-09-02T20:02:00.000Z",
              "startedAt": "2026-09-02T20:01:00.000Z",
              "finishedAt": "2026-09-02T20:02:00.000Z",
              "threadId": "thread-1", "summary": "The task was cancelled."
            }
            """.utf8))
        }
        let status = try await makeClient(transport).cancelAssistantTask(id: "assistant 1")
        XCTAssertTrue((transport.lastRequest?.url?.absoluteString ?? "").contains("/v1/assistant-tasks/assistant%201/cancel"))
        XCTAssertEqual(status.state, .cancelled)
        XCTAssertTrue(status.state.isTerminal)
        XCTAssertEqual(status.finishedAt, "2026-09-02T20:02:00.000Z")
    }

    func testReconcileAssistantTaskUsesExplicitBooleanAcknowledgement() async throws {
        let transport = StubTransport { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertTrue((request.url?.absoluteString ?? "").contains("/v1/assistant-tasks/assistant%201/reconcile"))
            let body = try! JSONDecoder().decode([String: Bool].self, from: request.httpBody!)
            XCTAssertEqual(body, ["acknowledgeUnknownOutcome": true])
            return .init(status: 200, body: Data(Self.reconciledAssistantTaskJSON.utf8))
        }

        let status = try await makeClient(transport).reconcileAssistantTask(id: "assistant 1")

        XCTAssertEqual(status.state, .failed)
        XCTAssertEqual(status.failureCode, "ASSISTANT_TASK_CANCEL_UNCONFIRMED")
        XCTAssertEqual(status.reconciledAt, "2026-09-02T20:03:00.000Z")
        XCTAssertFalse(status.requiresOutcomeReconciliation)
    }

    func testTimedOutReconciliationRecoversByStatusWithoutReplayingPost() async throws {
        let transport = AssistantTaskRecoveryTransport(statusResponse: .init(
            status: 200,
            body: Data(Self.reconciledAssistantTaskJSON.utf8)
        ))
        let config = GatewayConfiguration(
            baseURL: URL(string: "http://127.0.0.1:8787")!,
            tokenProvider: { "gateway-token-123" }
        )
        let client = GatewayClient(configuration: config, transport: transport)

        let status = try await client.reconcileAssistantTaskRecoveringStatus(id: "assistant-1")

        XCTAssertEqual(status.failureCode, "ASSISTANT_TASK_CANCEL_UNCONFIRMED")
        XCTAssertEqual(status.reconciledAt, "2026-09-02T20:03:00.000Z")
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET"])
        XCTAssertEqual(requests[0].url?.path, "/v1/assistant-tasks/assistant-1/reconcile")
        XCTAssertEqual(requests[1].url?.path, "/v1/assistant-tasks/assistant-1")
    }

    private static let runningAssistantTaskJSON = """
    {
      "taskId": "assistant-1", "instruction": "Fix the failing tests and verify the build.",
      "scope": "project", "projectId": "codex-lens",
      "state": "running", "model": "gpt-5.6-sol", "reasoningEffort": "medium",
      "preparedAt": "2026-09-02T20:00:00.000Z",
      "expiresAt": "2026-09-02T20:05:00.000Z",
      "updatedAt": "2026-09-02T20:01:00.000Z",
      "startedAt": "2026-09-02T20:01:00.000Z", "threadId": "thread-1",
      "summary": "Codex accepted the task and is starting work."
    }
    """

    private static let reconciledAssistantTaskJSON = """
    {
      "taskId": "assistant-1", "instruction": "Fix the failing tests and verify the build.",
      "scope": "project", "projectId": "codex-lens",
      "state": "failed", "model": "gpt-5.6-sol", "reasoningEffort": "medium",
      "preparedAt": "2026-09-02T20:00:00.000Z",
      "expiresAt": "2026-09-02T20:05:00.000Z",
      "updatedAt": "2026-09-02T20:03:00.000Z",
      "startedAt": "2026-09-02T20:01:00.000Z",
      "finishedAt": "2026-09-02T20:02:00.000Z",
      "threadId": "thread-1",
      "summary": "Codex did not confirm cancellation, so the final task state is uncertain.",
      "failureCode": "ASSISTANT_TASK_CANCEL_UNCONFIRMED",
      "reconciledAt": "2026-09-02T20:03:00.000Z"
    }
    """

    func testFrontmostComputerAppUsesReadOnlyFastEndpoint() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data(#"{ "app": "Visual Studio Code", "windowTitle": "Welcome — KitchenCapture", "readOnly": true }"#.utf8))
        }
        let result = try await makeClient(transport).frontmostComputerApp()
        XCTAssertEqual(result.app, "Visual Studio Code")
        XCTAssertEqual(result.windowTitle, "Welcome — KitchenCapture")
        XCTAssertTrue(result.readOnly)
        XCTAssertEqual(transport.lastRequest?.httpMethod, "GET")
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/computer/frontmost")
        XCTAssertNil(transport.lastRequest?.httpBody)
    }

    func testFocusComputerAppUsesDeterministicFastEndpoint() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data(#"{ "app": "Visual Studio Code", "frontmost": true }"#.utf8))
        }
        let result = try await makeClient(transport).focusComputerApp(app: "VS Code")
        XCTAssertEqual(result.app, "Visual Studio Code")
        XCTAssertTrue(result.frontmost)
        XCTAssertEqual(transport.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/computer/focus")
        let body = String(data: transport.lastRequest?.httpBody ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("VS Code"))
    }

    func testCloseFrontmostComputerWindowNeverIncludesAConfirmationChoice() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data(#"{ "app": "Xcode", "windowTitle": "CodexLensApp", "closed": true, "needsUserDecision": false }"#.utf8))
        }
        let result = try await makeClient(transport).closeFrontmostComputerWindow()
        XCTAssertTrue(result.closed)
        XCTAssertFalse(result.needsUserDecision)
        XCTAssertEqual(transport.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/computer/close-window")
        XCTAssertNil(transport.lastRequest?.httpBody)
    }

    func testSetFrontmostComputerWindowStateUsesDeterministicEndpoint() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data(#"{ "app": "Xcode", "windowTitle": "CodexLensApp", "action": "minimize", "applied": true, "minimized": true }"#.utf8))
        }
        let result = try await makeClient(transport).setFrontmostComputerWindowState(action: "minimize")
        XCTAssertEqual(result.action, "minimize")
        XCTAssertTrue(result.applied)
        XCTAssertTrue(result.minimized)
        XCTAssertEqual(transport.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/computer/window-state")
        let body = String(data: transport.lastRequest?.httpBody ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("minimize"))
    }

    func testSendPreparedTextUsesBoundConfirmationOnly() async throws {
        let transport = StubTransport { _ in
            .init(status: 200, body: Data("""
            { "sent": true, "recipientDisplay": "Alex Example", "serviceType": "iMessage",
              "sentAt": "2026-08-26T19:01:00.000Z" }
            """.utf8))
        }
        let sent = try await makeClient(transport).sendPreparedText(
            confirmationId: "confirm-1",
            digest: String(repeating: "a", count: 64)
        )
        XCTAssertTrue(sent.sent)
        XCTAssertEqual(sent.serviceType, .iMessage)
        XCTAssertEqual(transport.lastRequest?.url?.path, "/v1/messages/send")
        let body = String(data: transport.lastRequest?.httpBody ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("confirm-1"))
        XCTAssertFalse(body.contains("I am on my way"), "the send endpoint cannot alter the prepared body")
    }

    func testTimedOutTextSendRecoversByStatusWithoutReplayingPost() async throws {
        let transport = AssistantTaskRecoveryTransport(statusResponse: .init(
            status: 200,
            body: Data(Self.acceptedMessageIntentStatusJSON.utf8)
        ))
        let client = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "http://127.0.0.1:8787")!,
                tokenProvider: { "gateway-token-123" }
            ),
            transport: transport
        )

        let result = try await client.sendPreparedTextRecoveringStatus(
            confirmationId: "confirm-1",
            digest: String(repeating: "a", count: 64)
        )

        guard case .recovered(let status) = result else {
            return XCTFail("Expected durable status recovery")
        }
        XCTAssertEqual(status.confirmationId, "confirm-1")
        XCTAssertEqual(status.state, .accepted)
        XCTAssertEqual(status.recipientDisplay, "Alex Example")
        XCTAssertEqual(status.maskedDestination, "••••0123")
        XCTAssertEqual(status.serviceType, .iMessage)
        XCTAssertEqual(status.acceptedAt, "2026-08-26T19:01:00.000Z")
        XCTAssertNil(status.failureCode)

        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET"])
        XCTAssertEqual(requests[0].url?.path, "/v1/messages/send")
        XCTAssertEqual(requests[1].url?.path, "/v1/messages/confirm-1/status")
    }

    func testFailedTextSendAndStatusNeverReplaysPost() async {
        let transport = AssistantTaskRecoveryTransport(statusResponse: nil)
        let client = GatewayClient(
            configuration: GatewayConfiguration(
                baseURL: URL(string: "http://127.0.0.1:8787")!,
                tokenProvider: { "gateway-token-123" }
            ),
            transport: transport
        )

        do {
            _ = try await client.sendPreparedTextRecoveringStatus(
                confirmationId: "confirm-uncertain",
                digest: String(repeating: "a", count: 64)
            )
            XCTFail("Expected recovery failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("confirm-uncertain"))
            XCTAssertTrue(error.localizedDescription.contains("was not retried"))
        }

        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET"])
        XCTAssertEqual(requests[0].url?.path, "/v1/messages/send")
        XCTAssertEqual(requests[1].url?.path, "/v1/messages/confirm-uncertain/status")
    }

    private static let acceptedMessageIntentStatusJSON = """
    {
      "confirmationId": "confirm-1",
      "recipientDisplay": "Alex Example",
      "maskedDestination": "••••0123",
      "serviceType": "iMessage",
      "state": "accepted",
      "preparedAt": "2026-08-26T19:00:00.000Z",
      "expiresAt": "2026-08-26T19:05:00.000Z",
      "updatedAt": "2026-08-26T19:01:00.000Z",
      "acceptedAt": "2026-08-26T19:01:00.000Z"
    }
    """
}
