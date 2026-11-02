//
//  MoALiveView.swift
//  VisionClaw-MoA
//
//  The "Live" screen: a hands-free realtime voice conversation (gpt-realtime-mini)
//  instead of tap-to-talk. Just talk — server-side turn detection handles turns,
//  and you can interrupt the reply by speaking. Real work is dispatched by the
//  model to the durable Mac runner (watch it land on the Agents tab).
//
//  Needs OPENAI_API_KEY set in the Mac's .env (see README) — the phone only ever
//  holds a short-lived token minted by the runner.
//

import SwiftUI
import Vision

@MainActor
final class MoAAirScrollController: ObservableObject {
    @Published private(set) var status = "Waiting for camera"
    @Published private(set) var handDetected = false
    @Published private(set) var pinchDetected = false
    @Published private(set) var isArmed = false
    @Published private(set) var analyzedFrames = 0
    @Published private(set) var recognizedFrames = 0
    @Published private(set) var triggeredScrolls = 0

    private var isAnalyzing = false
    private var lastSample = Date.distantPast
    private var anchor: CGPoint?
    private var smoothedPoint: CGPoint?
    private var lastSeen = Date.distantPast
    private var stableSamples = 0
    private var lastAction = Date.distantPast
    private var cameraSource = "unknown"
    private var pinchStarted: Date?
    private var armedUntil = Date.distantPast
    private let pinchHoldDuration: TimeInterval = 0.4
    private let armedDuration: TimeInterval = 4.0

    func process(_ jpeg: Data?, enabled: Bool, sensitivity: String,
                 directionMode: String, scrollAmount: Int, source: String,
                 pinchToArm: Bool) {
        cameraSource = source
        guard enabled else {
            handDetected = false
            pinchDetected = false
            isArmed = false
            pinchStarted = nil
            anchor = nil
            smoothedPoint = nil
            stableSamples = 0
            setStatus("Air Scroll off")
            return
        }
        guard let jpeg, !isAnalyzing,
              Date().timeIntervalSince(lastSample) > 0.18 else { return }
        lastSample = Date()
        isAnalyzing = true
        Task {
            let sample = await Task.detached(priority: .utility) {
                Self.handSample(in: jpeg)
            }.value
            self.isAnalyzing = false
            self.analyzedFrames += 1
            if sample != nil { self.recognizedFrames += 1 }
            if self.analyzedFrames.isMultiple(of: 20) { self.report() }
            self.handle(sample, sensitivity: sensitivity, directionMode: directionMode,
                        scrollAmount: scrollAmount, pinchToArm: pinchToArm)
        }
    }

    private func handle(_ sample: HandPoseSample?, sensitivity: String,
                        directionMode: String, scrollAmount: Int, pinchToArm: Bool) {
        let now = Date()
        if isArmed && now > armedUntil {
            disarm(status: "Arm timed out · pinch again")
        }
        guard let sample else {
            // One dropped Vision frame should not erase an in-progress swipe.
            if now.timeIntervalSince(lastSeen) > 0.7 {
                handDetected = false
                pinchDetected = false
                anchor = nil
                smoothedPoint = nil
                stableSamples = 0
                setStatus(isArmed ? "Armed · show your hand" : "Hand not detected")
            }
            return
        }
        handDetected = true
        pinchDetected = sample.isPinching
        lastSeen = now

        if pinchToArm && !isArmed {
            anchor = nil
            smoothedPoint = nil
            stableSamples = 0
            guard sample.isPinching else {
                pinchStarted = nil
                setStatus("Pinch thumb + index to arm")
                return
            }
            if pinchStarted == nil {
                pinchStarted = now
                setStatus("Hold pinch…")
                return
            }
            let held = now.timeIntervalSince(pinchStarted ?? now)
            guard held >= pinchHoldDuration else {
                let percent = min(99, Int((held / pinchHoldDuration) * 100))
                setStatus("Hold pinch… \(percent)%")
                return
            }
            isArmed = true
            armedUntil = now.addingTimeInterval(armedDuration)
            pinchStarted = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            setStatus("Armed · release and show open hand")
            return
        }

        if pinchToArm && sample.isPinching {
            anchor = nil
            smoothedPoint = nil
            stableSamples = 0
            setStatus("Armed · release and show open hand")
            return
        }
        guard sample.isOpenHand else {
            anchor = nil
            smoothedPoint = nil
            stableSamples = 0
            setStatus(isArmed ? "Armed · show open hand" : "Finding open hand…")
            return
        }

        let point = sample.palmCenter
        stableSamples += 1
        let smooth = CGPoint(
            x: (smoothedPoint?.x ?? point.x) * 0.6 + point.x * 0.4,
            y: (smoothedPoint?.y ?? point.y) * 0.6 + point.y * 0.4)
        smoothedPoint = smooth

        guard stableSamples >= 2 else {
            setStatus("Finding open hand…")
            return
        }
        guard let anchor else {
            self.anchor = smooth
            setStatus(isArmed ? "Armed · swipe up or down" : "Hand ready · swipe up or down")
            return
        }

        // Measure total travel from a stable anchor, not just frame-to-frame
        // movement. Natural slower swipes now accumulate instead of disappearing.
        let deltaY = smooth.y - anchor.y
        let threshold = sensitivity == "high" ? 0.055 : sensitivity == "low" ? 0.13 : 0.085
        guard abs(deltaY) > threshold else { return }
        guard now.timeIntervalSince(lastAction) > 0.75 else { return }
        lastAction = now
        self.anchor = nil
        smoothedPoint = nil
        stableSamples = 0
        let naturalDirection = deltaY > 0 ? "down" : "up"
        let direction = directionMode == "reversed"
            ? (naturalDirection == "down" ? "up" : "down") : naturalDirection
        triggeredScrolls += 1
        if pinchToArm {
            isArmed = false
            armedUntil = .distantPast
        }
        setStatus("Scrolling \(direction)…")
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            do {
                let result = try await JobClient.shared.macAction(
                    action: "scroll",
                    parameters: ["direction": direction, "by": "line",
                                 "amount": min(max(scrollAmount, 1), 10)])
                let app = result["app"] as? String ?? "Mac"
                self.setStatus("Scrolled \(app) \(direction)")
            } catch {
                self.setStatus("Mac scroll failed · \(error.localizedDescription)")
            }
        }
    }

    private func disarm(status value: String) {
        isArmed = false
        pinchDetected = false
        pinchStarted = nil
        armedUntil = .distantPast
        anchor = nil
        smoothedPoint = nil
        stableSamples = 0
        setStatus(value)
    }

    private func setStatus(_ value: String) {
        guard status != value else { return }
        status = value
        report()
    }

    private func report() {
        Task {
            await JobClient.shared.reportGesture(
                state: status, source: cameraSource, analyzed: analyzedFrames,
                recognized: recognizedFrames, triggered: triggeredScrolls)
        }
    }

    private struct HandPoseSample: Sendable {
        let palmCenter: CGPoint
        let isOpenHand: Bool
        let isPinching: Bool
    }

    nonisolated private static func handSample(in jpeg: Data) -> HandPoseSample? {
        let request = VNDetectHumanHandPoseRequest()
        request.maximumHandCount = 1
        let handler = VNImageRequestHandler(data: jpeg, options: [:])
        guard (try? handler.perform([request])) != nil,
              let observation = request.results?.first,
              let points = try? observation.recognizedPoints(.all),
              let wrist = points[.wrist], wrist.confidence > 0.18 else { return nil }

        let palmNames: [VNHumanHandPoseObservation.JointName] = [
            .wrist, .indexMCP, .middleMCP, .ringMCP, .littleMCP,
        ]
        let palm = palmNames.compactMap { name -> CGPoint? in
            guard let p = points[name], p.confidence > 0.18 else { return nil }
            return p.location
        }
        guard palm.count >= 3 else { return nil }
        let palmCenter = CGPoint(x: palm.map(\.x).reduce(0, +) / CGFloat(palm.count),
                                 y: palm.map(\.y).reduce(0, +) / CGFloat(palm.count))

        // The thumb is frequently occluded in a glasses view. Three extended
        // fingers are a much more tolerant open-hand signal than requiring four
        // of five landmarks on every frame.
        let fingers: [(VNHumanHandPoseObservation.JointName, VNHumanHandPoseObservation.JointName)] = [
            (.indexTip, .indexPIP), (.middleTip, .middlePIP),
            (.ringTip, .ringPIP), (.littleTip, .littlePIP),
        ]
        var extended = 0
        for (tipName, jointName) in fingers {
            guard let tip = points[tipName], let joint = points[jointName],
                  tip.confidence > 0.18, joint.confidence > 0.18 else { continue }
            let tipDistance = hypot(tip.location.x - wrist.location.x,
                                    tip.location.y - wrist.location.y)
            let jointDistance = hypot(joint.location.x - wrist.location.x,
                                      joint.location.y - wrist.location.y)
            if tipDistance > jointDistance * 1.06 { extended += 1 }
        }
        var isPinching = false
        if let thumb = points[.thumbTip], let index = points[.indexTip],
           let indexMCP = points[.indexMCP], let littleMCP = points[.littleMCP],
           thumb.confidence > 0.2, index.confidence > 0.2,
           indexMCP.confidence > 0.18, littleMCP.confidence > 0.18 {
            let fingertipDistance = hypot(thumb.location.x - index.location.x,
                                          thumb.location.y - index.location.y)
            let palmWidth = hypot(indexMCP.location.x - littleMCP.location.x,
                                  indexMCP.location.y - littleMCP.location.y)
            if palmWidth > 0.025 {
                isPinching = fingertipDistance / palmWidth < 0.48
            }
        }
        return HandPoseSample(palmCenter: palmCenter,
                              isOpenHand: extended >= 3,
                              isPinching: isPinching)
    }
}

struct MoALiveView: View {
    /// Latest camera frame from VisionClaw's glasses stream (JPEG).
    var latestFrameJPEG: Data?
    var cameraSource: String = "glasses"
    var cameraConnected: Bool = false

    @ObservedObject var session: MoARealtimeSession
    @ObservedObject var airScrollController: MoAAirScrollController
    @AppStorage("moaAirScrollEnabled") private var airScrollEnabled = false
    @AppStorage("prismGestureSensitivity") private var gestureSensitivity = "normal"
    @AppStorage("prismGestureDirection") private var gestureDirection = "natural"
    @AppStorage("prismGestureDistance") private var gestureDistance = "medium"
    @AppStorage("prismPinchToArm") private var pinchToArm = true
    @AppStorage("prismAutoVision") private var autoVision = true
    @AppStorage("prismShowCameraPreview") private var showCameraPreview = true
    @AppStorage("prismAutoConnectLive") private var autoConnectLive = false

    var body: some View {
        VStack(spacing: 18) {
            header

            if showCameraPreview { framePreview }

            ScrollViewReader { proxy in
                ScrollView {
                    Text(session.transcript.isEmpty
                         ? "Connect and just talk — no buttons, interrupt any time."
                         : session.transcript)
                        .font(.system(.body, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding()
                        .id("tail")
                }
                .onChange(of: session.transcript) { _, _ in
                    withAnimation { proxy.scrollTo("tail", anchor: .bottom) }
                }
            }
            .frame(maxHeight: .infinity)
            .background(Color.black.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 14))

            if !session.note.isEmpty {
                Text(session.note).font(.caption).foregroundStyle(.secondary)
            }
            if airScrollEnabled && !airScrollController.status.isEmpty {
                VStack(spacing: 2) {
                    Text("Hand · \(airScrollController.status)")
                    Text("analyzed \(airScrollController.analyzedFrames) · recognized "
                         + "\(airScrollController.recognizedFrames) · scrolls "
                         + "\(airScrollController.triggeredScrolls)")
                        .font(.caption2)
                }
                .font(.caption).foregroundStyle(.secondary)
            }

            controls
        }
        .padding()
        .onAppear {
            session.autoVisionEnabled = autoVision
            if autoConnectLive && !session.voiceEnabled { session.toggleVoice() }
        }
        .onChange(of: autoVision) { _, enabled in session.autoVisionEnabled = enabled }
        .onDisappear { } // stay live when switching tabs — that's the point
    }

    private var gestureScrollAmount: Int {
        gestureDistance == "large" ? 10 : gestureDistance == "small" ? 3 : 6
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Prism Terminal · Live").font(.headline)
                Text(session.modelName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\(cameraSource == "iphone" ? "iPhone" : "Glasses") camera · "
                     + (cameraConnected ? "live" : "waiting for frames"))
                    .font(.caption2)
                    .foregroundStyle(cameraConnected ? .green : .orange)
            }
            Spacer()
            MoAStatusPill(status: session.state)
        }
    }

    @ViewBuilder private var framePreview: some View {
        if let data = latestFrameJPEG, let img = UIImage(data: data) {
            Image(uiImage: img)
                .resizable().scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: 260)
                .background(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(alignment: .bottomLeading) {
                    Text("what you see").font(.caption2).padding(6)
                        .background(.ultraThinMaterial).clipShape(Capsule()).padding(8)
                }
                .overlay(alignment: .topTrailing) {
                    if airScrollEnabled {
                        Label(gestureOverlayLabel, systemImage: gestureOverlayIcon)
                            .font(.caption2).padding(6)
                            .foregroundStyle(gestureOverlayColor)
                            .background(.ultraThinMaterial).clipShape(Capsule()).padding(8)
                    }
                }
        }
    }

    private var controls: some View {
        HStack(spacing: 28) {
            // Push the current glasses frame into the conversation, then ask about it.
            Button { session.sendCurrentFrame() } label: {
                Image(systemName: "eye.fill").font(.title2)
                    .frame(width: 56, height: 56)
                    .background(Circle().fill(Color.black.opacity(0.06)))
            }
            .buttonStyle(.plain)
            .disabled(latestFrameJPEG == nil || session.state != "live")
            .accessibilityLabel("Send what I'm looking at")

            Button {
                session.toggleVoice()
            } label: {
                Circle()
                    .fill(session.voiceEnabled && session.state == "live" ? Color.red :
                          session.voiceEnabled && session.state == "connecting" ? Color.orange : Color.accentColor)
                    .frame(width: 96, height: 96)
                    .overlay(Image(systemName: session.voiceEnabled
                                   ? "waveform" : "phone.fill")
                        .font(.system(size: 34)).foregroundStyle(.white))
                    .scaleEffect(session.voiceEnabled ? 1.1 : 1.0)
                    .animation(.spring(duration: 0.2), value: session.state)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(session.voiceEnabled ? "Hang up" : "Go live")

            Button { airScrollEnabled.toggle() } label: {
                Image(systemName: airScrollEnabled ? "hand.raised.fill" : "hand.raised")
                    .font(.title2)
                    .frame(width: 56, height: 56)
                    .foregroundStyle(airScrollEnabled ? .white : .primary)
                    .background(Circle().fill(airScrollEnabled ? Color.green : Color.black.opacity(0.06)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(airScrollEnabled ? "Disable air scroll" : "Enable air scroll")
        }
    }

    private var gestureOverlayLabel: String {
        if airScrollController.isArmed { return "armed · swipe" }
        if airScrollController.pinchDetected { return "hold pinch" }
        return pinchToArm ? "pinch to arm" :
            (airScrollController.handDetected ? "hand tracked" : "show open hand")
    }

    private var gestureOverlayIcon: String {
        if airScrollController.isArmed { return "bolt.fill" }
        if pinchToArm { return "hand.pinch.fill" }
        return airScrollController.handDetected ? "hand.raised.fill" : "hand.raised"
    }

    private var gestureOverlayColor: Color {
        if airScrollController.isArmed { return .purple }
        if airScrollController.pinchDetected { return .blue }
        return airScrollController.handDetected ? .green : .orange
    }
}
