//
//  MoARootView.swift
//  VisionClaw-MoA
//
//  App root: hands-free Live voice, the Agent Board, and Settings. Make this the
//  app's initial screen (replaces VisionClaw's Gemini-Live
//  root). Pass the glasses' latest camera frame into MoALiveView.
//

import SwiftUI

struct MoARootView: View {
    /// Wire this to VisionClaw's existing camera frame source (JPEG Data).
    var latestFrameJPEG: Data?
    var latestFrameAt: Date
    var readCameraFrame: (() -> (Data, Date)?)?
    @State private var terminalSharing = false
    var cameraSource: String
    var cameraConnected: Bool
    var onConnectGlasses: (() -> Void)?
    var cameraStatus: String
    var cameraActionLabel: String
    var captureSnapshot: (() async -> Data?)?
    var onContinuousCameraChanged: ((Bool) -> Void)?

    // Chat is the default; Live is an optional separate mode.
    // `moaShowBoard` (launch arg or Settings) still opens
    // straight to the Agent Board — handy for demos and UI tests.
    @State private var tab: Int
    @StateObject private var session = MoARealtimeSession()
    @StateObject private var terminal = PrismTerminalSession()
    @StateObject private var gestures = MoAAirScrollController()
    @State private var ranDebugProbe = false
    @AppStorage("moaAirScrollEnabled") private var airScrollEnabled = false
    @Environment(\.scenePhase) private var scenePhase

    init(latestFrameJPEG: Data?, latestFrameAt: Date = .distantPast, readCameraFrame: (() -> (Data, Date)?)? = nil, cameraSource: String = "glasses",
         cameraConnected: Bool = false, onConnectGlasses: (() -> Void)? = nil, session: MoARealtimeSession? = nil, cameraStatus: String = "Camera disconnected", cameraActionLabel: String = "Connect glasses", captureSnapshot: (() async -> Data?)? = nil, onContinuousCameraChanged: ((Bool) -> Void)? = nil) {
        if let session { self._session = StateObject(wrappedValue: session) }
        self.latestFrameJPEG = latestFrameJPEG
        self.latestFrameAt = latestFrameAt
        self.readCameraFrame = readCameraFrame
        self.cameraSource = cameraSource
        self.cameraConnected = cameraConnected
        self.onConnectGlasses = onConnectGlasses
        self.cameraStatus = cameraStatus
        self.cameraActionLabel = cameraActionLabel
        self.captureSnapshot = captureSnapshot
        self.onContinuousCameraChanged = onContinuousCameraChanged
        if UserDefaults.standard.string(forKey: "prismCodexURL")?.isEmpty == false || UserDefaults.standard.string(forKey: "bridgeSecret")?.isEmpty == false {
            _tab = State(initialValue: UserDefaults.standard.bool(forKey: "moaShowBoard") ? 2 : 0)
        } else {
            // First launch needs the one-time runner pairing before Live can work.
            _tab = State(initialValue: 3)
        }
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            PrismTerminalView(terminal: terminal, captureSnapshot: captureSnapshot,
                latestFrameJPEG: latestFrameJPEG, latestFrameAt: latestFrameAt,
                onShareViewChanged: { enabled in
                    terminalSharing = enabled && tab == 0
                    onContinuousCameraChanged?(terminalSharing || tab == 1 || (tab == 2 && airScrollEnabled))
                },
                readCameraFrame: readCameraFrame, cameraSource: cameraSource,
                onConnectGlasses: onConnectGlasses, cameraStatus: cameraStatus,
                cameraActionLabel: cameraActionLabel, panelActive: tab, onPanel: { tab = $0 })
            if tab != 0 {
                VStack(spacing: 0) {
                    HStack {
                        Text(tab == 1 ? "/realtime · OpenAI" : tab == 2 ? "/crew" : tab == 3 ? "/settings" : "/history")
                        Spacer()
                        Button { tab = 0 } label: { Image(systemName: "xmark").frame(width: 40, height: 40) }
                            .accessibilityLabel("Close panel")
                    }.font(.system(size: 14, design: .monospaced)).padding(.horizontal, 14)
                    Divider()
                    Group {
                        if tab == 1 {
                            MoALiveView(latestFrameJPEG: latestFrameJPEG, cameraSource: cameraSource,
                                cameraConnected: cameraConnected, session: session, airScrollController: gestures)
                        } else if tab == 2 {
                            AgentBoardView()
                        } else if tab == 3 {
                            MoASettingsView { tab = 0 }
                        } else {
                            PrismChatView(session: session, store: session.chat, latestFrameJPEG: latestFrameJPEG,
                                cameraConnected: cameraConnected, cameraSource: cameraSource, onConnectGlasses: onConnectGlasses,
                                cameraStatus: cameraStatus, cameraActionLabel: cameraActionLabel, captureSnapshot: captureSnapshot)
                        }
                    }
                }.frame(maxWidth: 620)
                    .background(PrismTerminalStyle.background, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(PrismTerminalStyle.line))
                    .padding(.leading, 18).padding(.trailing, 6).padding(.top, 68).padding(.bottom, 14)
                    .shadow(color: .black.opacity(0.5), radius: 25, x: -10)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .font(.system(.body, design: .monospaced))
        .fontDesign(.monospaced)
        .tint(PrismTerminalStyle.accent)
        .preferredColorScheme(.dark)
        .animation(.easeOut(duration: 0.18), value: tab)
        .onAppear {
            updateCamera(); session.resumeCodexTasks()
            onContinuousCameraChanged?(terminalSharing || tab == 1 || (tab == 2 && airScrollEnabled))
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { session.resumeCodexTasks(refresh: true) }
        }
        .onChange(of: tab) { _, selected in
            if selected != 0 { terminalSharing = false }
            onContinuousCameraChanged?(selected == 1 || (selected == 2 && airScrollEnabled))
            updateCamera()
            if selected == 0 { session.useDirectCommands() }
        }
        .onChange(of: airScrollEnabled) { _, enabled in
            onContinuousCameraChanged?(terminalSharing || tab == 1 || (tab == 2 && enabled))
        }
        .task {
            #if DEBUG
            await PrismDictationRecognitionProbe.runIfRequested()
            if !ranDebugProbe, let instruction = ProcessInfo.processInfo.environment["PRISM_TEST_CODEX_INSTRUCTION"], !instruction.isEmpty {
                ranDebugProbe = true
                await session.prepareCodexProbe(instruction)
            } else if !ranDebugProbe, let text = ProcessInfo.processInfo.environment["PRISM_TEST_MESSAGE"], !text.isEmpty {
                ranDebugProbe = true
                await session.sendDirectCommand(text)
            }
            #endif
        }
        .onChange(of: latestFrameJPEG) { _, _ in updateCamera() }
        .onChange(of: cameraConnected) { _, _ in updateCamera() }
    }

    private func updateCamera() {
        session.latestFrame = cameraConnected ? latestFrameJPEG : nil
        let defaults = UserDefaults.standard
        session.autoVisionEnabled = defaults.object(forKey: "prismAutoVision") as? Bool ?? true
        let distance = defaults.string(forKey: "prismGestureDistance") ?? "medium"
        gestures.process(cameraConnected ? latestFrameJPEG : nil,
            enabled: tab == 2 && defaults.bool(forKey: "moaAirScrollEnabled"),
            sensitivity: defaults.string(forKey: "prismGestureSensitivity") ?? "normal",
            directionMode: defaults.string(forKey: "prismGestureDirection") ?? "natural",
            scrollAmount: distance == "large" ? 10 : distance == "small" ? 3 : 6,
            source: cameraSource, pinchToArm: defaults.object(forKey: "prismPinchToArm") as? Bool ?? true)
    }
}

struct MoASettingsView: View {
    let onBack: () -> Void

    @AppStorage("jobRunnerURL") private var jobRunnerURL =
        "https://your-mac.example.invalid:8443"
    @AppStorage("bridgeSecret") private var bridgeSecret = ""
    @AppStorage("prismCameraSource") private var cameraSource = "glasses"
    @AppStorage("prismGlassesQuality") private var glassesQuality = "medium"
    @AppStorage("prismAutoVision") private var autoVision = true
    @AppStorage("prismShowCameraPreview") private var showCameraPreview = true
    @AppStorage("moaAirScrollEnabled") private var airScrollEnabled = false
    @AppStorage("prismGestureSensitivity") private var gestureSensitivity = "normal"
    @AppStorage("prismGestureDirection") private var gestureDirection = "natural"
    @AppStorage("prismGestureDistance") private var gestureDistance = "medium"
    @AppStorage("prismPinchToArm") private var pinchToArm = true
    @AppStorage("prismAutoConnectLive") private var autoConnectLive = false
    @AppStorage("prismLocalVoiceID") private var localVoiceID = "af_heart"
    @AppStorage("prismLocalVoiceBackground") private var keepVoiceInBackground = true
    @AppStorage("prismCodexURL") private var codexURL = ""
    @State private var codexToken = ""
    @State private var codexStatus = UserDefaults.standard.string(forKey: "prismConnectionSetupError") ?? ""
    @State private var health = "unknown"
    @State private var gestureTest = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Codex Mac") {
                    TextField("Gateway URL", text: $codexURL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Connection token", text: $codexToken)
                        .onChange(of: codexToken) { _, value in
                            do { try PrismCodexBridge.saveToken(value) }
                            catch { codexStatus = "Could not save the connection token." }
                        }
                    Text("Commands and text replies use Codex on this Mac. Dictation runs on your iPhone. Live voice is optional.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("Test Codex connection") {
                        Task {
                            do { _ = try await PrismCodexBridge.client().approvedProjects(); codexStatus = "Connected" }
                            catch { codexStatus = error.localizedDescription }
                        }
                    }
                    if !codexStatus.isEmpty { Text(codexStatus).font(.caption) }
                }

                Section("Camera context") {
                    Picker("Camera source", selection: $cameraSource) {
                        Text("Meta glasses").tag("glasses")
                        Text("iPhone").tag("iphone")
                    }
                    Picker("Glasses quality", selection: $glassesQuality) {
                        Text("Low").tag("low")
                        Text("Medium").tag("medium")
                        Text("High").tag("high")
                    }
                    Toggle("Automatic camera context", isOn: $autoVision)
                    Toggle("Show camera preview", isOn: $showCameraPreview)
                    Text("Direct Codex commands include a fresh frame when you ask about what you see. Optional Live voice includes a frame when you speak.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section("Hand gestures") {
                    Text("Gestures control the Crew Mac and keep the camera active while Crew is open.").font(.footnote).foregroundStyle(.secondary)
                    Toggle("Air Scroll", isOn: $airScrollEnabled)
                    Toggle("Pinch to arm", isOn: $pinchToArm)
                    Picker("Sensitivity", selection: $gestureSensitivity) {
                        Text("Low").tag("low")
                        Text("Normal").tag("normal")
                        Text("High").tag("high")
                    }
                    Picker("Direction", selection: $gestureDirection) {
                        Text("Natural").tag("natural")
                        Text("Reversed").tag("reversed")
                    }
                    Picker("Scroll distance", selection: $gestureDistance) {
                        Text("Small").tag("small")
                        Text("Medium").tag("medium")
                        Text("Large").tag("large")
                    }
                    LabeledContent("Target", value: "Frontmost Mac app")
                    HStack {
                        Button("Test Mac scroll") { Task { await testGestureScroll() } }
                        Spacer()
                        Text(gestureTest).foregroundStyle(.secondary)
                    }
                    Text(pinchToArm
                         ? "Hold thumb and index together until Armed, release into an open hand, then swipe vertically. One swipe automatically disarms it."
                         : "Show an open hand to the selected camera and move it vertically.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section("Codex voice") {
                    Picker("Voice", selection: $localVoiceID) {
                        Text("Heart · warm female").tag("af_heart")
                        Text("Michael · calm male").tag("am_michael")
                    }
                    Toggle("Keep listening when locked", isOn: $keepVoiceInBackground)
                    Text("Start from /live in the terminal. Speech runs on your devices, with no separate voice API credits. Replies use your existing Codex connection.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("OpenAI Live · API") {
                    Toggle("Connect automatically", isOn: $autoConnectLive)
                    LabeledContent("Voice connection", value: codexURL.isEmpty ? "Prism runner" : "Codex Mac")
                }

                Section("Mac durable brain") {
                    TextField("Job runner URL", text: $jobRunnerURL)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    SecureField("Shared secret", text: $bridgeSecret)
                    HStack {
                        Button("Test connection") { Task { await test() } }
                        Spacer()
                        Text(health).foregroundStyle(health == "ok" ? .green : .secondary)
                    }
                }
                Section {
                    Text("The phone is a thin client. Jobs run durably on the Mac over Tailscale, "
                       + "so leaving the app or losing Wi-Fi never loses the work.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .onAppear { codexToken = PrismCodexBridge.token }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: onBack) {
                        Label("Back", systemImage: "chevron.left")
                    }
                }
            }
        }
    }

    private func test() async {
        health = "…"
        guard let url = URL(string: jobRunnerURL + "/health") else { health = "bad URL"; return }
        do {
            let (_, resp) = try await URLSession.shared.data(from: url)
            health = (resp as? HTTPURLResponse)?.statusCode == 200 ? "ok" : "unreachable"
        } catch { health = "unreachable" }
    }

    private func testGestureScroll() async {
        gestureTest = "…"
        do {
            let result = try await JobClient.shared.macAction(
                action: "scroll", parameters: ["direction": "down", "amount": 2])
            gestureTest = result["app"] as? String ?? "ok"
        } catch {
            gestureTest = "failed"
        }
    }
}
