//
//  MoACore.swift
//  VisionClaw-MoA — config + job model + durable-brain client.
//
//  The phone is a thin, reconnectable client. All real work runs on the Mac's
//  durable job runner. This file talks to it: submit a job, watch its output
//  stream (resumable by byte offset, so a dropped connection loses nothing).
//

import Foundation

// MARK: - Config (persisted in UserDefaults, editable in Settings)

enum MoAConfig {
    static var jobRunnerURL: String {
        UserDefaults.standard.string(forKey: "jobRunnerURL")
            ?? "https://your-mac.example.invalid:8443"
    }
    static var secret: String {
        UserDefaults.standard.string(forKey: "bridgeSecret") ?? ""
    }
    static var isConfigured: Bool { !secret.isEmpty && URL(string: jobRunnerURL) != nil }

    /// The agents the runner knows about. `nil` selection = let the Mac auto-route.
    static let agents = ["codex", "claude", "ornith", "opus", "computer"]
}

// MARK: - Job model (matches the runner's meta.json)

struct MoAJob: Identifiable, Decodable, Equatable {
    let id: String
    let agent: String
    let text: String
    let status: String
    let review: Bool?
    let created: Double?
    let elapsed: Double?
}

struct StreamChunk: Decodable {
    let from: Int
    let next: Int
    let chunk: String
    let status: String
    let agent: String?
}

// MARK: - Prism Crew mission models

struct PrismCrewMember: Identifiable, Decodable, Equatable {
    let id: String
    let role: String
    let label: String
    let agent: String
    let phase: String
    let exclusive: Bool
    let status: String
    let jobId: String?
    let summary: String?
    let elapsed: Double?

    enum CodingKeys: String, CodingKey {
        case id, role, label, agent, phase, exclusive, status, summary, elapsed
        case jobId = "job_id"
    }
}

struct PrismMission: Identifiable, Decodable, Equatable {
    let id: String
    let text: String
    let status: String
    let stage: String
    let summary: String?
    let result: String?
    let created: Double
    let updated: Double
    let elapsed: Double?
    let crew: [PrismCrewMember]
}

struct PrismMacHands: Decodable, Equatable {
    let busy: Bool
    let holder: String
}

struct PrismMissionBoard: Decodable, Equatable {
    let missions: [PrismMission]
    let hands: PrismMacHands
}

private struct PrismMissionEnvelope: Decodable {
    let mission: PrismMission
    let hands: PrismMacHands
}

// MARK: - Durable-brain client

@MainActor
final class JobClient {
    static let shared = JobClient()

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL? {
        guard var comps = URLComponents(string: MoAConfig.jobRunnerURL + path) else { return nil }
        if !query.isEmpty { comps.queryItems = query }
        return comps.url
    }

    /// Fire-and-forget submit. Returns the new job id. Attach `imageJPEG` (the current
    /// glasses frame) to make it a vision job — the Mac routes it to Claude, which sees it.
    func submit(text: String, agent: String?, review: Bool, imageJPEG: Data? = nil) async throws -> String {
        guard let url = url("/jobs") else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["secret": MoAConfig.secret, "text": text, "review": review]
        if let agent { body["agent"] = agent }
        if let imageJPEG { body["image"] = imageJPEG.base64EncodedString() }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let jobId = obj["job_id"] as? String else {
            throw URLError(.cannotParseResponse)
        }
        return jobId
    }

    /// Deploy a coordinated Prism Crew mission. The Mac planner chooses specialists,
    /// runs safe preparation in parallel, serializes visible Mac control, and verifies.
    func deployMission(text: String) async throws -> PrismMission {
        guard let url = url("/missions") else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "secret": MoAConfig.secret, "text": text,
        ])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(PrismMissionEnvelope.self, from: data).mission
    }

    /// Perform a low-latency, allowlisted action on the Mac. The runner validates
    /// every parameter and does not expose arbitrary shell or AppleScript.
    func macAction(action: String, app: String? = nil,
                   parameters: [String: Any] = [:]) async throws -> [String: Any] {
        guard let url = url("/mac/action") else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body = parameters
        body["secret"] = MoAConfig.secret
        body["action"] = action
        if let app, !app.isEmpty { body["app"] = app }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            let message = obj["error"] as? String ?? "Mac action failed"
            throw NSError(domain: "VisionClaw.MacAction", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: message])
        }
        return obj
    }

    /// Send privacy-safe gesture diagnostics. Only state names and counters are
    /// included; camera frames never leave the phone through this endpoint.
    func reportGesture(state: String, source: String, analyzed: Int,
                       recognized: Int, triggered: Int) async {
        guard let url = url("/gesture/event") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "secret": MoAConfig.secret, "state": state, "source": source,
            "analyzed": analyzed, "recognized": recognized, "triggered": triggered,
        ])
        _ = try? await URLSession.shared.data(for: req)
    }

    /// The board: all jobs, newest first.
    func board() async throws -> [MoAJob] {
        guard let url = url("/jobs", query: [.init(name: "secret", value: MoAConfig.secret)]) else {
            throw URLError(.badURL)
        }
        let (data, _) = try await URLSession.shared.data(from: url)
        struct Board: Decodable { let jobs: [MoAJob] }
        return try JSONDecoder().decode(Board.self, from: data).jobs
    }

    func missionBoard() async throws -> PrismMissionBoard {
        guard let url = url("/missions", query: [
            .init(name: "secret", value: MoAConfig.secret),
        ]) else { throw URLError(.badURL) }
        let (data, resp) = try await URLSession.shared.data(from: url)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(PrismMissionBoard.self, from: data)
    }

    func mission(id: String) async throws -> PrismMissionEnvelopeResult {
        guard let url = url("/missions/\(id)", query: [
            .init(name: "secret", value: MoAConfig.secret),
        ]) else { throw URLError(.badURL) }
        let (data, resp) = try await URLSession.shared.data(from: url)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let envelope = try JSONDecoder().decode(PrismMissionEnvelope.self, from: data)
        return PrismMissionEnvelopeResult(mission: envelope.mission, hands: envelope.hands)
    }

    func watchMission(id: String,
                      onUpdate: @escaping @MainActor (PrismMission, PrismMacHands) -> Void) async {
        while !Task.isCancelled {
            if let fresh = try? await mission(id: id) {
                onUpdate(fresh.mission, fresh.hands)
                if ["done", "needs_attention", "failed", "interrupted"].contains(fresh.mission.status) {
                    return
                }
            }
            try? await Task.sleep(nanoseconds: 1_200_000_000)
        }
    }

    /// Watch a job's output, resuming from `start`. `onUpdate(fullChunkAppended, status)`
    /// is called on the main actor. Reconnect-safe: on any transient error it keeps the
    /// last byte offset and retries, so backgrounding / Wi-Fi drops don't lose or dup output.
    func watch(jobId: String, from start: Int = 0,
               onUpdate: @escaping @MainActor (String, String) -> Void) async {
        var from = start
        while !Task.isCancelled {
            if let url = url("/jobs/\(jobId)/stream",
                             query: [.init(name: "from", value: String(from)),
                                     .init(name: "secret", value: MoAConfig.secret)]) {
                do {
                    let (data, _) = try await URLSession.shared.data(from: url)
                    let sc = try JSONDecoder().decode(StreamChunk.self, from: data)
                    if !sc.chunk.isEmpty { from = sc.next }
                    onUpdate(sc.chunk, sc.status)
                    if ["done", "failed", "interrupted"].contains(sc.status) { return }
                } catch {
                    // transient — keep `from`, retry below
                }
            }
            try? await Task.sleep(nanoseconds: 1_200_000_000) // 1.2s poll
        }
    }
}

struct PrismMissionEnvelopeResult {
    let mission: PrismMission
    let hands: PrismMacHands
}
