//
//  WalkieView.swift
//  VisionClaw-MoA
//
//  The primary voice screen — ALWAYS LISTENING, no tap. Speak; when you go quiet it
//  submits a durable job to the Mac, streams the reply back, and speaks it (muting the
//  mic while it talks so it doesn't hear itself). Because the job runs on the Mac, you
//  can lock the phone / drop Wi-Fi and the reply keeps streaming when you return.
//

import SwiftUI

struct WalkieView: View {
    /// Latest camera frame from the glasses stream (JPEG), shown + optionally sent as context.
    var latestFrameJPEG: Data?

    @StateObject private var speech = SpeechInput()
    @StateObject private var speaker = Speaker()

    @State private var reply = ""
    @State private var status = "idle"
    @State private var selectedAgent: String? = nil   // nil = let the Mac auto-route
    @State private var review = false
    @State private var useVision = false
    @State private var watchTask: Task<Void, Never>?

    private var jobRunning: Bool { ["queued", "running", "review_running"].contains(status) }

    var body: some View {
        VStack(spacing: 18) {
            header
            framePreview
            transcriptPane
            controls
            listeningIndicator
        }
        .padding()
        .onAppear {
            BackgroundAudioSession.shared.begin()          // view owns the session lifecycle
            speech.onFinal = { text in submit(text) }
            if speech.authorized { speech.startContinuous() } else { speech.requestAuth() }
        }
        .onChange(of: speech.authorized) { _, ok in if ok { speech.startContinuous() } }
        .onChange(of: speaker.isSpeaking) { _, speaking in
            speaking ? speech.pause() : speech.resume()   // don't transcribe our own voice
        }
        .onDisappear {
            speech.stopContinuous()
            BackgroundAudioSession.shared.end()
        }
    }

    private var header: some View {
        HStack {
            Text("VisionClaw · MoA").font(.headline)
            Spacer()
            MoAStatusPill(status: status)
        }
    }

    @ViewBuilder private var framePreview: some View {
        if let data = latestFrameJPEG, let img = UIImage(data: data) {
            Image(uiImage: img)
                .resizable().scaledToFill()
                .frame(height: 140).clipped()
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(alignment: .bottomLeading) {
                    Text("what you see").font(.caption2).padding(6)
                        .background(.ultraThinMaterial).clipShape(Capsule()).padding(8)
                }
        }
    }

    private var transcriptPane: some View {
        ScrollView {
            Text(displayText)
                .font(.system(.body, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .foregroundStyle(speech.isListening && !speech.transcript.isEmpty ? .primary : .primary)
                .padding()
        }
        .frame(maxHeight: .infinity)
        .background(Color.primary.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private var displayText: String {
        if !speech.transcript.isEmpty { return speech.transcript }
        if !reply.isEmpty { return reply }
        return "Listening — just talk."
    }

    private var controls: some View {
        HStack(spacing: 12) {
            Picker("Agent", selection: $selectedAgent) {
                Text("Auto").tag(String?.none)
                ForEach(MoAConfig.agents, id: \.self) { Text($0.capitalized).tag(String?.some($0)) }
            }
            .pickerStyle(.menu)
            Spacer()
            Button { useVision.toggle() } label: {
                Label("See", systemImage: useVision ? "eye.fill" : "eye.slash").font(.caption)
            }
            .tint(useVision ? .accentColor : .secondary)
            .disabled(latestFrameJPEG == nil)
            Toggle("Opus", isOn: $review).labelsHidden()
            Text("Opus").font(.caption)
        }
    }

    // MARK: always-listening indicator (no button)

    private var listeningIndicator: some View {
        VStack(spacing: 10) {
            if speech.permissionDenied {
                Label("Microphone & speech access needed — enable them in Settings",
                      systemImage: "mic.slash")
                    .font(.caption).foregroundStyle(.orange).multilineTextAlignment(.center)
            } else {
                Orb(state: voiceState)
                Text(voiceLabel).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(voiceLabel)
    }

    enum VoiceState { case listening, speaking, working, idle }
    private var voiceState: VoiceState {
        if speaker.isSpeaking { return .speaking }
        if jobRunning { return .working }
        if speech.isListening { return .listening }
        return .idle
    }
    private var voiceLabel: String {
        switch voiceState {
        case .listening: return "Listening — just talk"
        case .speaking:  return "Speaking…"
        case .working:   return "Working on it…"
        case .idle:      return "Starting up…"
        }
    }

    private func submit(_ text: String) {
        watchTask?.cancel()
        reply = ""
        status = "queued"
        speaker.stop()                                 // barge-in: cut any current speech
        watchTask = Task {
            do {
                let img = useVision ? latestFrameJPEG : nil
                let jobId = try await JobClient.shared.submit(text: text,
                                                              agent: selectedAgent,
                                                              review: review,
                                                              imageJPEG: img)
                await JobClient.shared.watch(jobId: jobId) { chunk, st in
                    reply += chunk
                    let becameTerminal = status != st && st == "done"
                    status = st
                    if becameTerminal { speaker.speak(reply) }
                }
            } catch {
                status = "failed"
                reply = "Could not reach the Mac brain.\n\(error.localizedDescription)"
            }
        }
    }
}

// MARK: - Voice orb (state-colored, gently pulsing while listening)

private struct Orb: View {
    let state: WalkieView.VoiceState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle().fill(tint.opacity(0.16)).frame(width: 96, height: 96)
                .scaleEffect(pulse && state == .listening && !reduceMotion ? 1.12 : 1.0)
                .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: pulse)
            Circle().fill(tint).frame(width: 66, height: 66)
            Image(systemName: icon).font(.system(size: 28, weight: .semibold)).foregroundStyle(.white)
        }
        .onAppear { pulse = true }
    }

    private var tint: Color {
        switch state {
        case .listening: return .accentColor
        case .speaking:  return .green
        case .working:   return .purple
        case .idle:      return .secondary
        }
    }
    private var icon: String {
        switch state {
        case .listening: return "waveform"
        case .speaking:  return "speaker.wave.2.fill"
        case .working:   return "gearshape.2.fill"
        case .idle:      return "mic.fill"
        }
    }
}
