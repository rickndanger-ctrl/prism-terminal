//
//  AgentBoardView.swift
//  Prism Terminal
//
//  Prism Crew mission dashboard. The Realtime commander deploys bounded
//  specialists while one exclusive Mac Hands lane owns visible interaction.
//

import SwiftUI

// MARK: - Status pill (shared)

struct MoAStatusPill: View {
    let status: String

    private var color: Color {
        switch status {
        case "queued": return .gray
        case "running": return .blue
        case "review_running": return .purple
        case "done", "live": return .green
        case "failed": return .red
        case "interrupted", "needs_attention": return .orange
        case "connecting": return .yellow
        default: return .secondary
        }
    }

    var body: some View {
        Text(status.replacingOccurrences(of: "_", with: " "))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.18))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }
}

// MARK: - Crew board

struct AgentBoardView: View {
    @State private var missions: [PrismMission] = []
    @State private var jobs: [MoAJob] = []
    @State private var hands = PrismMacHands(busy: false, holder: "Ready")
    @State private var poll: Task<Void, Never>?
    @State private var newMission = ""
    @State private var isDeploying = false
    @State private var message = ""

    var body: some View {
        NavigationStack {
            List {
                Section { crewHeader }

                Section("New mission") {
                    TextField("Tell the crew what to accomplish…", text: $newMission, axis: .vertical)
                        .lineLimit(2...5)
                    Button {
                        deploy()
                    } label: {
                        Label(isDeploying ? "Deploying…" : "Deploy Prism Crew",
                              systemImage: "sparkles.rectangle.stack.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.indigo)
                    .disabled(isDeploying || newMission.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    if !message.isEmpty {
                        Text(message).font(.footnote).foregroundStyle(.secondary)
                    }
                }

                Section("Missions") {
                    if missions.isEmpty {
                        ContentUnavailableView("No missions yet",
                                               systemImage: "sparkles",
                                               description: Text("Ask Prism Terminal to handle a multi-step Mac task."))
                    } else {
                        ForEach(missions) { mission in
                            NavigationLink {
                                MissionDetailView(mission: mission)
                            } label: {
                                missionRow(mission)
                            }
                        }
                    }
                }

                Section("Specialist activity") {
                    ForEach(jobs.prefix(20)) { job in
                        NavigationLink { JobDetailView(job: job) } label: { jobRow(job) }
                    }
                }
            }
            .navigationTitle("Prism Crew")
            .refreshable { await refresh() }
            .onAppear { startPolling() }
            .onDisappear { poll?.cancel() }
        }
    }

    private var crewHeader: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(.white.opacity(0.16)).frame(width: 48, height: 48)
                    Image(systemName: "triangle.inset.filled")
                        .font(.title2.bold())
                        .foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("PRISM CREW").font(.headline).foregroundStyle(.white)
                    Text(activeMissionText).font(.caption).foregroundStyle(.white.opacity(0.8))
                }
                Spacer()
                Circle()
                    .fill(hands.busy ? Color.orange : Color.green)
                    .frame(width: 10, height: 10)
                    .shadow(color: hands.busy ? .orange : .green, radius: 5)
            }

            HStack {
                Label(hands.busy ? hands.holder : "Mac Hands ready",
                      systemImage: hands.busy ? "hand.tap.fill" : "hand.raised.fill")
                    .font(.caption.weight(.semibold))
                Spacer()
                Text("\(activeCrewCount) active")
                    .font(.caption.monospacedDigit())
            }
            .foregroundStyle(.white.opacity(0.92))
        }
        .padding(16)
        .background(
            LinearGradient(colors: [.indigo, .purple, .cyan.opacity(0.85)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
    }

    private var activeCrewCount: Int {
        missions.flatMap(\.crew).filter { ["queued", "running", "review_running"].contains($0.status) }.count
    }

    private var activeMissionText: String {
        missions.first(where: { ["queued", "running"].contains($0.status) })?.stage
            ?? "Specialists standing by"
    }

    private func missionRow(_ mission: PrismMission) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top) {
                Text(mission.text).font(.subheadline.weight(.semibold)).lineLimit(2)
                Spacer(minLength: 8)
                MoAStatusPill(status: mission.status)
            }
            Text(mission.stage).font(.caption).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    ForEach(mission.crew) { member in
                        CrewChip(member: member)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func jobRow(_ job: MoAJob) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(job.agent.capitalized).font(.subheadline.weight(.semibold))
                Spacer()
                MoAStatusPill(status: job.status)
            }
            Text(job.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
    }

    private func deploy() {
        let text = newMission.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        isDeploying = true
        message = "Assembling the best crew…"
        Task {
            do {
                let mission = try await JobClient.shared.deployMission(text: text)
                newMission = ""
                missions.insert(mission, at: 0)
                message = "Crew deployed"
            } catch {
                message = "Couldn’t reach the Mac crew"
            }
            isDeploying = false
        }
    }

    private func startPolling() {
        poll?.cancel()
        poll = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: 1_300_000_000)
            }
        }
    }

    private func refresh() async {
        if let board = try? await JobClient.shared.missionBoard() {
            missions = board.missions
            hands = board.hands
        }
        if let freshJobs = try? await JobClient.shared.board() { jobs = freshJobs }
    }
}

struct CrewChip: View {
    let member: PrismCrewMember

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
            Text(member.label)
            Circle().fill(color).frame(width: 6, height: 6)
        }
        .font(.caption2.weight(.medium))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
    }

    private var color: Color {
        switch member.status {
        case "done": return .green
        case "running", "review_running": return .blue
        case "failed": return .red
        case "interrupted", "needs_attention": return .orange
        default: return .secondary
        }
    }

    private var icon: String {
        switch member.role {
        case "researcher": return "magnifyingglass"
        case "builder": return "hammer.fill"
        case "files": return "folder.fill"
        case "navigator": return "cursorarrow.rays"
        case "verifier", "visual_verifier": return "checkmark.seal.fill"
        default: return "sparkles"
        }
    }
}

// MARK: - Mission detail

struct MissionDetailView: View {
    @State private var current: PrismMission
    @State private var hands = PrismMacHands(busy: false, holder: "Ready")
    @State private var watch: Task<Void, Never>?

    init(mission: PrismMission) {
        _current = State(initialValue: mission)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        MoAStatusPill(status: current.status)
                        Spacer()
                        if let elapsed = current.elapsed {
                            Text("\(elapsed, specifier: "%.1f")s")
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    Text(current.text).font(.title3.bold())
                    Label(current.stage,
                          systemImage: hands.busy ? "hand.tap.fill" : "sparkles")
                        .font(.subheadline).foregroundStyle(hands.busy ? .orange : .indigo)
                }
                .padding()
                .background(.thinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

                VStack(alignment: .leading, spacing: 12) {
                    Text("Crew timeline").font(.headline)
                    ForEach(current.crew) { member in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                CrewChip(member: member)
                                Text(member.agent.capitalized)
                                    .font(.caption).foregroundStyle(.secondary)
                                if member.exclusive {
                                    Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.orange)
                                }
                                Spacer()
                                MoAStatusPill(status: member.status)
                            }
                            if let summary = member.summary, !summary.isEmpty {
                                Text(summary)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(8)
                                    .textSelection(.enabled)
                            }
                        }
                        .padding()
                        .background(Color.secondary.opacity(0.07))
                        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                    }
                }

                if let result = current.result, !result.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Mission result").font(.headline)
                        Text(result).font(.footnote).textSelection(.enabled)
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Mission")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            watch = Task {
                await JobClient.shared.watchMission(id: current.id) { mission, macHands in
                    current = mission
                    hands = macHands
                }
            }
        }
        .onDisappear { watch?.cancel() }
    }
}

// MARK: - Job detail (live stream)

struct JobDetailView: View {
    let job: MoAJob
    @State private var output = ""
    @State private var status = ""
    @State private var watch: Task<Void, Never>?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(output.isEmpty ? "…" : output)
                    .font(.system(.footnote, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding()
                    .id("bottom")
            }
            .onChange(of: output) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
        .navigationTitle(job.agent.capitalized)
        .toolbar { MoAStatusPill(status: status.isEmpty ? job.status : status) }
        .onAppear {
            watch = Task {
                await JobClient.shared.watch(jobId: job.id) { chunk, newStatus in
                    output += chunk
                    status = newStatus
                }
            }
        }
        .onDisappear { watch?.cancel() }
    }
}
