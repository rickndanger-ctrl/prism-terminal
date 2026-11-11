import SwiftUI
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers
import CodexLensKit

private struct PrismPadControl: Identifiable {
    let id: String
    let title: String
}

private struct PrismCommandPad: View {
    @ObservedObject var terminal: PrismTerminalSession
    @Environment(\.dismiss) private var dismiss
    @State private var action = "open"
    @State private var app = "Calculator"
    @State private var text = ""
    @State private var instruction = ""
    @State private var result = ""
    @State private var working = false
    private let apps = ["Visual Studio Code", "Claude", "System Settings", "ChatGPT", "Cursor", "Google Chrome", "Safari", "Messages", "FaceTime", "Notes", "Finder", "Calculator", "TextEdit"]
    private let windowControls = [
        PrismPadControl(id: "minimize", title: "Minimize this window"),
        PrismPadControl(id: "maximize", title: "Maximize this window"),
        PrismPadControl(id: "left", title: "Move this window left"),
        PrismPadControl(id: "right", title: "Move this window right")
    ]
    private let browserControls = [
        PrismPadControl(id: "back", title: "Go back in the browser"),
        PrismPadControl(id: "forward", title: "Go forward in the browser"),
        PrismPadControl(id: "reload", title: "Reload this page"),
        PrismPadControl(id: "newTab", title: "Open a new tab"),
        PrismPadControl(id: "nextTab", title: "Next tab"),
        PrismPadControl(id: "previousTab", title: "Previous tab"),
        PrismPadControl(id: "closeTab", title: "Close this tab"),
        PrismPadControl(id: "focusAddress", title: "Focus the address bar")
    ]
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Say these commands through your glasses, or dictate and send them. No button tap or decision model is needed.")
                    Text("Native actions skip Codex reasoning. They still check the target and report what could actually be verified.").font(.caption)
                }
                controlsSection("Window controls", action: "window", controls: windowControls)
                controlsSection("Chrome / Safari · current browser", action: "browser", controls: browserControls)
                Section("Local Clef · suggests only") {
                    TextField("Describe the command", text: $instruction, axis: .vertical)
                    Button("Suggest a button") {
                        perform {
                            let chosen = try await terminal.padCall("classify", body: ["text": instruction])
                            guard ["open", "close", "type", "search", "ask"].contains(chosen) else { return "Invalid suggestion; nothing ran." }
                            action = chosen
                            return "Clef selected \(chosen). Check the target below. Nothing has run."
                        }
                    }.disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Text("First use loads Clef on Mini 1. Direct buttons below skip the model.").font(.caption)
                }
                Section("Command pad") {
                    Picker("Action", selection: $action) {
                        ForEach(["open", "close", "type", "search", "ask"], id: \.self) { Text($0.capitalized).tag($0) }
                    }.pickerStyle(.segmented)
                    if action == "open" {
                        Picker("App", selection: $app) {
                            ForEach(apps, id: \.self) { Text($0 == "ChatGPT" ? "Codex (ChatGPT.app)" : $0).tag($0) }
                        }
                    } else if action == "close" {
                        Text("Closes the current Mac window. Save dialogs are left for you; nothing is force-quit.")
                    } else if action == "type" || action == "search" {
                        TextField(action == "type" ? "Exact text for the focused Mac field" : "Web search query", text: $text, axis: .vertical)
                        Text(action == "type" ? "Place the cursor in an editable field with nothing selected. Inserts one line; never presses Enter or Send. Unsafe or unsupported fields are blocked." : "Sends the query to Google in your default browser.").font(.caption)
                    } else {
                        Text("Clarify in the terminal. Clef does not have enough information to run an action.")
                    }
                    if action != "ask" {
                        Button(action == "close" ? "Close current window" : "Run \(action)") {
                            let selectedAction = action == "type" ? "typeFocused" : action
                            let value = action == "open" ? app : action == "close" ? "" : text
                            let id = UUID().uuidString
                            perform { try await terminal.padCall("execute", body: ["requestId": id, "action": selectedAction, "value": value]) }
                        }.disabled((action == "type" || action == "search") && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                if working { ProgressView("Working…") }
                if !result.isEmpty { Section("Result") { Text(result).textSelection(.enabled) } }
                if let milliseconds = terminal.lastPadDurationMS {
                    Text("Last Mac round trip: \(milliseconds) ms. Excludes listening and spoken playback.").font(.caption)
                }
                Text("Local voice is unchanged. No cloud decision model is used. Messages and FaceTime buttons open the apps only.").font(.caption)
            }
            .disabled(working || terminal.busy || terminal.hasPendingCommand)
            .navigationTitle("Command pad")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(working) } }
            .interactiveDismissDisabled(working)
        }
    }
    private func controlsSection(_ title: String, action: String, controls: [PrismPadControl]) -> some View {
        Section(title) {
            ForEach(controls) { control in
                Button(control.title) {
                    let id = UUID().uuidString
                    perform {
                        try await terminal.padCall("execute", body: [
                            "requestId": id, "action": action, "value": control.id
                        ])
                    }
                }
            }
        }
    }
    private func perform(_ operation: @escaping @MainActor () async throws -> String) {
        guard !working else { return }
        working = true; result = ""
        Task { @MainActor in
            defer { working = false }
            do { result = try await operation() }
            catch { result = "\(error.localizedDescription) No automatic retry. If an action was submitted, inspect the Mac before retrying." }
        }
    }
}

private struct TerminalImportedVideo: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return Self(url: copy)
        }
    }
}

enum PrismTerminalStyle {
    static let background = Color(red: 0.08, green: 0.085, blue: 0.095)
    static let panel = Color(red: 0.13, green: 0.14, blue: 0.15)
    static let line = Color.white.opacity(0.17)
    static let ink = Color(red: 0.9, green: 0.91, blue: 0.91)
    static let accent = Color(red: 0.65, green: 0.84, blue: 0.72)
}

/// Owns sampling independently of SwiftUI rendering, which can stop while locked.
@MainActor final class PrismLiveViewSession: ObservableObject {
    @Published private(set) var active = false
    @Published private(set) var latestJPEG: Data?
    @Published private(set) var stopReason = ""
    private var buffer = LiveViewBuffer()
    private var samplingTask: Task<Void, Never>?
    private var releaseCamera: (() -> Void)?
    private(set) var cameraSource = ""
    var sharingSessionID: UUID? { buffer.sessionID }

    func start(cameraSource: String, readFrame: @escaping () -> (Data, Date)?,
               canContinue: @escaping () -> Bool, releaseCamera: @escaping () -> Void) {
        stop(reason: "Restarted sharing")
        buffer.start(now: Date()); active = true; latestJPEG = nil; stopReason = ""
        self.cameraSource = cameraSource
        self.releaseCamera = releaseCamera
        UserDefaults.standard.set(true, forKey: "prismLiveViewActive")
        UserDefaults.standard.set(0, forKey: "prismLiveViewSampleCount")
        UserDefaults.standard.set(0, forKey: "prismLiveViewBackgroundSampleCount")
        samplingTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.active else { return }
                if ProcessInfo.processInfo.thermalState == .critical {
                    self.stop(reason: "Phone is too warm; sharing stopped"); return
                }
                guard canContinue() else { self.stop(reason: "Background sharing unavailable; open Prism to share again"); return }
                if self.buffer.shouldStop(now: Date()) {
                    self.stop(reason: "No fresh camera frames for 15 seconds"); return
                }
                if let (data, timestamp) = readFrame() {
                    let now = Date()
                    if self.buffer.canSample(capturedAt: timestamp, now: now),
                       let image = UIImage(data: data),
                       let frame = PrismMedia.attachment(image, label: LiveViewPolicy.frameLabel(source: cameraSource, availableAt: timestamp)),
                       self.buffer.append(frame, capturedAt: timestamp, now: now) {
                        self.latestJPEG = frame.jpegData
                        let defaults = UserDefaults.standard
                        defaults.set(timestamp.timeIntervalSince1970, forKey: "prismLiveViewLastFrameAt")
                        defaults.set(defaults.integer(forKey: "prismLiveViewSampleCount") + 1, forKey: "prismLiveViewSampleCount")
                        if UIApplication.shared.applicationState == .background {
                            defaults.set(defaults.integer(forKey: "prismLiveViewBackgroundSampleCount") + 1, forKey: "prismLiveViewBackgroundSampleCount")
                        }
                    }
                }
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            }
        }
    }
    func freshImages(now: Date) -> [LensAttachment] { buffer.freshImages(now: now) }
    /// Waiting only reads the existing stream. It never starts the camera or
    /// uploads a frame. A stopped/replaced session cannot satisfy an old send.
    func imagesForQuestion(cameraSource: String, readFrame: @escaping () -> (Data, Date)?) async -> [LensAttachment] {
        guard active, self.cameraSource == cameraSource, let sessionID = buffer.sessionID else { return [] }
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        repeat {
            guard active, buffer.sessionID == sessionID, !Task.isCancelled else { return [] }
            if let (data, timestamp) = readFrame() {
                let now = Date()
                if buffer.canUseQuestionFrame(capturedAt: timestamp, now: now),
                   let image = UIImage(data: data),
                   let frame = PrismMedia.attachment(image, label: LiveViewPolicy.frameLabel(source: cameraSource, availableAt: timestamp)) {
                    return buffer.imagesForQuestion(latest: frame, capturedAt: timestamp, now: now)
                }
            }
            guard ProcessInfo.processInfo.systemUptime < deadline else { return [] }
            do { try await Task.sleep(for: .milliseconds(50)) } catch { return [] }
        } while true
    }
    func clearStopNotice() { stopReason = "" }
    func stop(reason: String = "Stopped sharing") {
        guard active else { return }
        active = false; buffer.stop(); latestJPEG = nil; stopReason = reason
        samplingTask?.cancel(); samplingTask = nil
        let release = releaseCamera; releaseCamera = nil; release?()
        UserDefaults.standard.set(false, forKey: "prismLiveViewActive")
        UserDefaults.standard.set(reason, forKey: "prismLiveViewStopReason")
    }
}

struct PrismTerminalView: View {
    @ObservedObject var terminal: PrismTerminalSession
    var captureSnapshot: (() async -> Data?)?
    var latestFrameJPEG: Data? = nil
    var latestFrameAt: Date = .distantPast
    var onShareViewChanged: ((Bool) -> Void)? = nil
    var readCameraFrame: (() -> (Data, Date)?)? = nil
    var cameraSource: String = "glasses"
    var onConnectGlasses: (() -> Void)?
    var cameraStatus: String
    var cameraActionLabel: String
    var panelActive: Int
    var onPanel: (Int) -> Void
    @StateObject private var dictation = PrismDictation()
    @StateObject private var liveVoice = PrismLiveVoiceController()
    @AppStorage("prismLocalVoiceID") private var localVoiceID = "af_heart"
    @AppStorage("prismLocalVoiceBackground") private var keepVoiceInBackground = true
    @State private var showVoicePanel = false
    @State private var voiceSubmissionID: String?
    @State private var composerDraft = TerminalComposerDraft()
    @State private var dictationSessionID: UUID?
    private var draft: String {
        get { composerDraft.text }
        nonmutating set { composerDraft.edit(newValue) }
    }
    @State private var attachments: [LensAttachment] = []
    @State private var picker: PhotosPickerItem?
    @State private var showPicker = false
    @State private var showCommands = false
    @State private var showCommandPad = false
    @State private var showSessions = false
    @State private var cameraOpen = false
    @State private var cameraSnapshot: Data?
    @State private var cameraGeneration = UUID()
    @StateObject private var liveView = PrismLiveViewSession()
    @State private var capturing = false
    @State private var sending = false
    @State private var importing = false
    @State private var notice = ""
    @State private var expandedTools: Set<String> = []
    @State private var cameraOffset = CGSize.zero
    @State private var cameraDrag = CGSize.zero
    @State private var followOutput = true
    @FocusState private var composing: Bool
    @Environment(\.scenePhase) private var scenePhase
    private let commands: [(String, String)] = [
        ("/connect", "Connect to your Mac"), ("/camera", "Glasses view"), ("/photos", "Photo or video"), ("/dictate", "Voice to text"),
        ("/new", "New Codex session"), ("/sessions", "Resume a session"),
        ("/live", "Hands-free Codex"), ("/realtime", "OpenAI Live · API"), ("/crew", "Crew & gestures"),
        ("/settings", "Connections & preferences"), ("/history", "Earlier chats"), ("/stop", "Interrupt Codex")
    ]
    private var inputReady: Bool {
        !sending && !capturing && !importing && dictationSessionID == nil && !dictation.isStarting && !dictation.isListening && !dictation.isFinishing
    }
    private var canStartDictation: Bool {
        !sending && !capturing && !importing && !terminal.hasPendingCommand && !liveVoice.active && panelActive == 0
    }
    private var canSend: Bool {
        inputReady && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (draft.hasPrefix("/") || LiveViewCommand.parse(draft) != nil ||
                (attachments.isEmpty && SpokenPadCommand.parse(draft) != nil ? terminal.canUsePad : terminal.canSend))
    }
    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack(alignment: .topTrailing) {
                transcript
                if cameraOpen { cameraPanel }
                if showSessions { sessionsPanel }
            }.frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
        }
        .background(PrismTerminalStyle.background)
        .foregroundStyle(PrismTerminalStyle.ink)
        .font(.system(size: 13, design: .monospaced))
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .sheet(isPresented: $showCommandPad) { PrismCommandPad(terminal: terminal) }
        .photosPicker(isPresented: $showPicker, selection: $picker, matching: .any(of: [.images, .videos]))
        .task(id: picker) { if let picker { await importMedia(picker) } }
        .onChange(of: liveView.stopReason) { _, reason in if !reason.isEmpty { notice = reason } }
        .task {
            if draft.isEmpty, let text = terminal.pendingText, let id = terminal.pendingRequestID {
                draft = text
                composerDraft.submitted(id: id)
            }
            await terminal.connect()
        }
        .onChange(of: terminal.acceptedCommand) { _, receipt in
            if let receipt { acknowledge(receipt) }
        }
        .onChange(of: terminal.descriptor?.id) { _, _ in stopLiveView() }
        .onChange(of: cameraSource) { _, _ in
            stopLiveView(); cameraSnapshot = nil; cameraOpen = false
        }
        .onChange(of: composerDraft.text) { _, text in
            if liveVoice.active && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                liveVoice.pause(message: "Voice paused while you type. Your draft is preserved.")
            }
        }
        .onChange(of: liveVoice.active) { _, active in
            if !active && scenePhase == .background { terminal.pause() }
        }
        .onChange(of: dictation.transcriptUpdate) { _, update in
            guard let update, update.id == dictationSessionID else { return }
            if !composerDraft.applyDictation(update) { stopDictation() }
        }
        .onChange(of: dictation.isStarting || dictation.isListening || dictation.isFinishing) { _, busy in
            if !busy { finishDictationIfIdle() }
        }
        .onChange(of: panelActive) { _, panel in
            if panel != 0 { stopLiveView() }
            if panel != 0 { liveVoice.stop(reason: "Switched away from local voice panel"); stopDictation(); composing = false; showCommands = false }
            else { Task { await terminal.connect() } }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await terminal.connect() } }
            if phase == .background {
                if cameraSource != "glasses" || !liveVoice.active || !keepVoiceInBackground { stopLiveView() }
                stopDictation()
                if !liveVoice.active || !keepVoiceInBackground {
                    liveVoice.stop(reason: "Background listening disabled or voice already stopped"); terminal.pause()
                }
            }
        }
        .onDisappear {
            if cameraSource != "glasses" || !liveVoice.active || !keepVoiceInBackground { stopLiveView() }
            stopDictation()
            if !liveVoice.active || !keepVoiceInBackground {
                liveVoice.stop(reason: "Voice view disappeared without background listening"); terminal.pause()
            }
        }
        .preferredColorScheme(.dark)
    }
    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Text(">_").font(.system(size: 20, weight: .semibold, design: .monospaced))
            VStack(alignment: .leading, spacing: 4) {
                Text("Prism Terminal").fontWeight(.semibold)
                HStack(spacing: 5) {
                    Circle().fill(terminal.streaming ? PrismTerminalStyle.accent : Color.gray).frame(width: 5, height: 5)
                    Text(terminal.connecting ? "connecting…" : terminal.streaming ? "Codex on your Mac" : "disconnected")
                        .foregroundStyle(.secondary).font(.system(size: 10, design: .monospaced))
                }
            }
            Spacer(minLength: 4)
            Button { showCommandPad = true } label: {
                Image(systemName: "square.grid.2x2").frame(width: 40, height: 40)
            }.accessibilityLabel("Local command pad")
            Button { Task { await terminal.refreshHistory(); showSessions.toggle() }; composing = false } label: {
                Image(systemName: "rectangle.stack").frame(width: 40, height: 40)
            }.accessibilityLabel("Terminal sessions")
            Button { showCommands.toggle() } label: {
                Text("/").font(.system(size: 23, design: .monospaced)).frame(width: 40, height: 40)
            }.accessibilityLabel("Terminal commands")
        }.padding(.horizontal, 18).padding(.vertical, 10)
            .background(PrismTerminalStyle.background)
            .overlay(alignment: .bottom) { Divider().overlay(PrismTerminalStyle.line) }
    }
    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    welcome
                    if terminal.hasEarlierHistory {
                        Text("Showing the latest 100 items. Earlier history is preserved on your Mac.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(terminal.transcript.entries) { entry in entryView(entry) }
                    if terminal.busy {
                        HStack(spacing: 9) {
                            ProgressView().controlSize(.mini)
                            Text(terminal.state == "stopping" ? "Interrupting…" : "Working…").foregroundStyle(.secondary)
                            Spacer()
                            Button("esc · stop") { Task { await terminal.stop() } }
                                .disabled(terminal.state == "stopping")
                        }.font(.system(size: 12, design: .monospaced))
                    }
                    if terminal.state == "uncertain" {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("This session stopped during a command. Check the result on your Mac before continuing.")
                            Button("Continue this session →") { Task { await terminal.connect(acknowledge: true) } }
                        }.foregroundStyle(.orange)
                    }
                    Color.clear.frame(height: 1).id("terminal-bottom")
                }.padding(18)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .opacity(terminal.restoringHistory ? 0 : 1)
            .overlay { if terminal.restoringHistory { ProgressView("Restoring conversation…") } }
            .simultaneousGesture(DragGesture().onChanged { _ in followOutput = false })
            .onChange(of: terminal.revision) { _, _ in
                if followOutput { proxy.scrollTo("terminal-bottom", anchor: .bottom) }
            }
            .overlay(alignment: .bottomTrailing) {
                if !followOutput {
                    Button { followOutput = true; proxy.scrollTo("terminal-bottom", anchor: .bottom) } label: {
                        Image(systemName: "arrow.down").padding(12).background(PrismTerminalStyle.panel, in: Circle())
                    }.accessibilityLabel("Latest output").padding(14)
                }
            }
        }
    }
    private var welcome: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(">_ Codex").font(.system(size: 16, weight: .semibold, design: .monospaced))
            HStack(alignment: .top) {
                Text("model:").foregroundStyle(.secondary)
                Text(terminal.descriptor?.model ?? "connecting…")
            }
            HStack { Text("access:").foregroundStyle(.secondary); Text("full access · this Mac") }
            Text("Type a command or dictate.\nUse / for camera, sessions, and options.")
                .foregroundStyle(.secondary).lineSpacing(5).padding(.top, 3)
            if terminal.state == "disconnected" {
                Button(terminal.connecting ? "Connecting…" : "Connect to Mac →") {
                    Task { await terminal.connect() }
                }.disabled(terminal.connecting)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(15)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(PrismTerminalStyle.line))
            .padding(.bottom, 5)
    }
    @ViewBuilder private func entryView(_ entry: TerminalEntry) -> some View {
        if entry.kind == "tool" {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    if expandedTools.contains(entry.id) { expandedTools.remove(entry.id) }
                    else { expandedTools.insert(entry.id) }
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Text(entry.status == "running" ? "•" : ["failed", "declined", "interrupted"].contains(entry.status) ? "×" : "✓")
                            .foregroundStyle(["failed", "declined", "interrupted"].contains(entry.status) ? Color.orange : PrismTerminalStyle.accent)
                        Text(entry.title.isEmpty ? "Running command" : entry.title).lineLimit(2).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Image(systemName: expandedTools.contains(entry.id) ? "chevron.up" : "chevron.down").font(.system(size: 9))
                    }
                }.buttonStyle(.plain)
                if expandedTools.contains(entry.id), !entry.text.isEmpty {
                    Text(entry.text).textSelection(.enabled).foregroundStyle(.secondary)
                        .padding(.leading, 17).font(.system(size: 11, design: .monospaced))
                }
            }.foregroundStyle(.secondary)
        } else {
            HStack(alignment: .top, spacing: 10) {
                Text(entry.kind == "input" ? "›" : entry.kind == "notice" ? "!" : "•")
                    .foregroundStyle(entry.kind == "notice" ? Color.orange : entry.kind == "input" ? .white : PrismTerminalStyle.accent)
                VStack(alignment: .leading, spacing: 10) {
                    if entry.imageCount > 0 {
                        let images = terminal.images(for: entry.id)
                        if images.isEmpty { Label("\(entry.imageCount) attached image\(entry.imageCount == 1 ? "" : "s")", systemImage: "photo").foregroundStyle(.secondary) }
                        else { mediaStrip(images, removable: false) }
                    }
                    Text(entry.text).textSelection(.enabled).lineSpacing(4)
                        .foregroundStyle(entry.kind == "notice" ? Color.orange : PrismTerminalStyle.ink)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
    private var composer: some View {
        VStack(spacing: 0) {
            if showVoicePanel { voicePanel }
            if showCommands || draft.hasPrefix("/") { commandPalette }
            VStack(alignment: .leading, spacing: 10) {
                if !attachments.isEmpty { mediaStrip(attachments, removable: true) }
                if !notice.isEmpty || !terminal.notice.isEmpty || !dictation.notice.isEmpty {
                    Text([notice, terminal.notice, dictation.notice].filter { !$0.isEmpty }.joined(separator: "\n"))
                        .foregroundStyle(.orange).font(.system(size: 11, design: .monospaced)).lineLimit(3)
                }
                if terminal.hasPendingPadCommand {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(terminal.padRecoveryNotice).foregroundStyle(.orange)
                        HStack {
                            Button(terminal.checkingPadReceipt ? "Checking…" : "Check last action") {
                                notice = ""
                                Task { await terminal.checkLastPadAction() }
                            }.disabled(sending || terminal.padRunning || terminal.checkingPadReceipt)
                            Spacer()
                            Button("I checked the Mac") {
                                notice = ""
                                if let id = terminal.acknowledgePadOutcome() { composerDraft.rejected(id: id) }
                            }.disabled(sending || !terminal.canAcknowledgePadOutcome)
                        }
                        Text("Checking only reads the receipt. Clearing recovery never repeats or undoes an action.")
                            .foregroundStyle(.secondary)
                    }.font(.system(size: 11, design: .monospaced))
                } else if terminal.hasPendingCommand {
                    HStack {
                        Button("Check connection") { Task { await terminal.connect() } }
                        Spacer()
                        Button("Retry same command") {
                            Task {
                                _ = await terminal.retryPending()
                                if let receipt = terminal.acceptedCommand { acknowledge(receipt) }
                            }
                        }
                    }.font(.system(size: 11, design: .monospaced)).disabled(sending || terminal.dispatching)
                }
                HStack(alignment: .top, spacing: 10) {
                    Text("›").font(.system(size: 22, design: .monospaced)).foregroundStyle(.secondary)
                    TextField("Tell Codex what to do", text: Binding(get: { draft }, set: { editComposer($0) }), axis: .vertical)
                        .lineLimit(1...6).focused($composing)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .font(.system(size: 15, design: .monospaced))
                        .padding(.vertical, 3).accessibilityIdentifier("terminal-prompt")
                }
                HStack(spacing: 2) {
                    icon("plus", label: "Add photo or video") { showPicker = true }
                        .disabled(sending || importing || capturing)
                    icon("camera", label: "Open glasses camera") { openCamera() }
                        .foregroundStyle(cameraOpen ? PrismTerminalStyle.accent : .secondary)
                        .disabled(capturing || sending)
                    icon(dictation.isListening ? "stop.circle.fill" : "mic", label: dictation.isListening ? "Stop dictation" : "Start dictation") { toggleDictation() }
                        .foregroundStyle(dictation.isListening ? PrismTerminalStyle.accent : .secondary)
                        .disabled(dictation.isFinishing || (!dictation.isListening && !dictation.isStarting && !canStartDictation))
                    icon("waveform", label: "Hands-free voice") {
                        showVoicePanel.toggle(); showCommands = false; composing = false
                    }.foregroundStyle(liveVoice.active ? PrismTerminalStyle.accent : .secondary)
                    Spacer(minLength: 0)
                    if dictation.isListening { Text("listening").font(.system(size: 10, design: .monospaced)).foregroundStyle(PrismTerminalStyle.accent) }
                    if capturing || importing || sending { ProgressView().controlSize(.small).padding(.trailing, 8) }
                    Button { sendDraft() } label: {
                        Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold))
                            .frame(width: 38, height: 36)
                            .background(canSend ? PrismTerminalStyle.ink : Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
                            .foregroundStyle(canSend ? PrismTerminalStyle.background : Color.gray)
                    }.disabled(!canSend).accessibilityLabel("Send command").accessibilityIdentifier("terminal-send")
                }.foregroundStyle(.secondary)
            }.padding(.horizontal, 14).padding(.top, 13).padding(.bottom, 5)
                .background(PrismTerminalStyle.panel, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(PrismTerminalStyle.line))
            HStack {
                Text(!terminal.connectionNotice.isEmpty ? terminal.connectionNotice : dictation.isListening ? dictation.inputName : liveVoice.active ? liveVoice.status : "/ commands")
                Spacer(minLength: 5)
                Text(terminal.busy ? "esc to interrupt" : "Codex · medium")
            }.font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).padding(.vertical, 8)
        }.padding(.horizontal, 12).padding(.top, 6).background(PrismTerminalStyle.background)
    }
    private var voicePanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Codex voice", systemImage: "waveform")
                    .fontWeight(.semibold)
                Spacer()
                Text("LOCAL SPEECH").font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                Button { showVoicePanel = false } label: { Image(systemName: "chevron.down").padding(6) }
                    .accessibilityLabel("Collapse voice panel")
            }
            if liveVoice.active {
                HStack(spacing: 8) {
                    Circle().fill(PrismTerminalStyle.accent).frame(width: 6, height: 6)
                    Text(liveVoice.status).foregroundStyle(PrismTerminalStyle.accent)
                    Spacer()
                    if liveVoice.phase == .speaking || liveVoice.phase == .preparingSpeech {
                        Button("Speak now") { liveVoice.speakNow() }
                    }
                    Button("Stop voice") { liveVoice.stop() }.foregroundStyle(.orange)
                }
                if liveVoice.inputName != "Microphone" {
                    Text(liveVoice.inputName).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                }
                if !liveVoice.transcript.isEmpty {
                    Text(liveVoice.transcript).foregroundStyle(.secondary).lineLimit(2)
                }
            } else {
                Text("Speak, pause to send, hear Codex, then keep talking.")
                    .foregroundStyle(.secondary).font(.system(size: 11, design: .monospaced))
                HStack {
                    Picker("Voice", selection: $localVoiceID) {
                        Text("Heart · warm").tag("af_heart")
                        Text("Michael · calm").tag("am_michael")
                    }.pickerStyle(.menu).tint(PrismTerminalStyle.ink)
                    Spacer()
                    Button("Start voice") { startLiveVoice() }
                        .buttonStyle(.borderedProminent).tint(PrismTerminalStyle.ink)
                        .foregroundStyle(PrismTerminalStyle.background)
                        .disabled(!inputReady || !terminal.canSend || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Toggle("Keep listening when locked", isOn: $keepVoiceInBackground)
                    .font(.system(size: 11, design: .monospaced)).tint(PrismTerminalStyle.accent)
            }
            if !liveVoice.notice.isEmpty {
                Text(liveVoice.notice).foregroundStyle(.orange)
                    .font(.system(size: 11, design: .monospaced)).lineLimit(3)
            }
        }.font(.system(size: 12, design: .monospaced)).padding(14)
            .background(PrismTerminalStyle.panel, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(PrismTerminalStyle.line))
            .padding(.bottom, 8)
    }
    private func startLiveVoice() {
        guard inputReady, !terminal.busy, !terminal.hasPendingCommand,
              draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            notice = "Finish your current command or draft before starting voice."
            return
        }
        guard terminal.canSend else { notice = "Connect to your Mac before starting voice."; return }
        notice = ""; composing = false
        let controller = liveVoice
        terminal.onReply = { [weak controller] reply in
            Task { await controller?.receiveReply(requestID: reply.requestID, text: reply.text, status: reply.status) }
        }
        Task {
            await controller.start(keepInBackground: keepVoiceInBackground, voice: localVoiceID,
                onUtterance: { sendVoiceUtterance($0) })
        }
    }
    private func sendVoiceUtterance(_ utterance: PrismVoiceUtterance, waitForConnection: Bool = true) {
        guard liveVoice.active else { return }
        let shortcut = attachments.isEmpty ? SpokenPadCommand.parse(utterance.text) : nil
        // Local camera controls do not depend on the gateway connection.
        if let sharing = LiveViewCommand.parse(utterance.text) {
            let requestID = utterance.id.uuidString
            voiceSubmissionID = nil
            liveVoice.awaitReply(requestID: requestID)
            let summary = handleSharingCommand(sharing)
            notice = summary
            Task { await liveVoice.receiveReply(requestID: requestID, text: summary, status: "completed") }
            return
        }
        // A transient event-stream reconnect must not immediately shut voice off.
        // No command has been sent yet; preserve this exact utterance ID and wait
        // briefly. Stopping voice invalidates the waiting ID, preventing replay.
        if shortcut == nil, waitForConnection, !terminal.canSend, !terminal.busy, !terminal.hasPendingCommand,
           inputReady, draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            notice = "Reconnecting before sending your command…"
            Task {
                for _ in 0..<32 {
                    guard liveVoice.active, liveVoice.waitingRequestID == utterance.id.uuidString else { return }
                    if terminal.canSend { break }
                    do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                }
                guard liveVoice.active, liveVoice.waitingRequestID == utterance.id.uuidString else { return }
                sendVoiceUtterance(utterance, waitForConnection: false)
            }
            return
        }
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            liveVoice.pause(message: "Voice paused to protect your typed draft.")
            return
        }
        guard (shortcut != nil ? terminal.canUsePad : terminal.canSend), inputReady else {
            draft = utterance.text
            liveVoice.pause(message: "Voice paused. Reconnect, then send the preserved command.")
            return
        }
        let requestID = utterance.id.uuidString
        let text = utterance.text
        let images = attachments
        liveVoice.awaitReply(requestID: requestID)
        voiceSubmissionID = requestID
        sending = true; notice = ""; followOutput = true
        Task {
            defer { sending = false }
            // Same authenticated/deduplicated pad executor as a button tap.
            // No microphone, VAD, audio routing, or speech synthesis changes.
            if let command = shortcut {
                guard liveVoice.active, liveVoice.waitingRequestID == requestID else { return }
                voiceSubmissionID = nil // This request has a pad receipt, not a terminal receipt.
                do {
                    let summary = try await terminal.padCall("execute", body: ["requestId": requestID,
                        "action": command.action, "value": command.value])
                    notice = summary
                    await liveVoice.receiveReply(requestID: requestID, text: summary, status: "completed")
                } catch {
                    // Never fall back to Codex after a possibly delivered action.
                    let summary = "I couldn't verify that command. Check your Mac before asking me to repeat it."
                    notice = summary
                    await liveVoice.receiveReply(requestID: requestID, text: summary, status: "completed")
                }
                return
            }
            var references = images
            let autoVision = UserDefaults.standard.object(forKey: "prismAutoVision") as? Bool ?? true
            if !liveView.active && !liveView.stopReason.isEmpty { cameraOpen = false }
            if images.isEmpty, liveView.active {
                let sharingID = liveView.sharingSessionID
                references = await liveView.imagesForQuestion(cameraSource: cameraSource, readFrame: readCameraFrame ?? { nil })
                guard liveView.sharingSessionID == sharingID, !references.isEmpty else {
                    voiceSubmissionID = nil
                    await liveVoice.receiveReply(requestID: requestID, text: "No fresh view yet. Please wait for the preview, then ask again.", status: "completed")
                    return
                }
            } else if images.isEmpty && (cameraOpen || (autoVision && DirectCommandIntent.requestsCamera(text))) {
                guard UIApplication.shared.applicationState == .active else {
                    voiceSubmissionID = nil
                    await liveVoice.receiveReply(requestID: requestID, text: "No live view is running. Unlock Prism to start sharing again.", status: "completed")
                    return
                }
                cameraOpen = true; capturing = true
                let captureID = cameraGeneration
                let frame = await captureSnapshot?()
                capturing = false
                guard liveVoice.active, liveVoice.waitingRequestID == requestID else { return }
                guard cameraGeneration == captureID, scenePhase == .active, panelActive == 0 else {
                    voiceSubmissionID = nil
                    await liveVoice.receiveReply(requestID: requestID, text: "The camera changed or closed. No image was sent.", status: "completed")
                    return
                }
                guard let frame, let image = UIImage(data: frame),
                      let reference = PrismMedia.attachment(image, label: "Current \(LiveViewPolicy.sourceName(cameraSource)) view") else {
                    voiceSubmissionID = nil
                    await liveVoice.receiveReply(requestID: requestID, text: "No fresh camera view. Check the camera connection and try again.", status: "completed")
                    return
                }
                cameraSnapshot = frame
                references = [reference] + Array(images.prefix(2))
            }
            guard liveVoice.active, liveVoice.waitingRequestID == requestID else { return }
            let accepted = await terminal.send(text, attachments: references, requestID: requestID)
            if let receipt = terminal.acceptedCommand { acknowledge(receipt) }
            if !accepted && !terminal.hasPendingCommand {
                liveVoice.pause(message: "The command was not sent. Your words are preserved below.")
                if draft.isEmpty { draft = text }
            }
        }
    }
    private func icon(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).frame(width: 39, height: 39) }
            .accessibilityLabel(label)
    }
    private var commandPalette: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(commands.filter { !draft.hasPrefix("/") || $0.0.hasPrefix(draft.lowercased()) }, id: \.0) { command in
                    Button { runCommand(command.0) } label: {
                        HStack { Text(command.0).foregroundStyle(PrismTerminalStyle.ink); Spacer(); Text(command.1).foregroundStyle(.secondary) }
                            .padding(.horizontal, 14).padding(.vertical, 11)
                    }.buttonStyle(.plain)
                }
            }
        }.frame(maxHeight: 250).background(PrismTerminalStyle.panel, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(PrismTerminalStyle.line)).padding(.bottom, 8)
    }
    private var cameraPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("camera").foregroundStyle(.secondary)
                Spacer()
                Button { stopLiveView(); cameraOpen = false; cameraSnapshot = nil } label: { Image(systemName: "xmark").frame(width: 30, height: 30) }
                    .accessibilityLabel("Close camera").disabled(!liveView.active && (capturing || sending))
            }
            if let data = liveView.active ? liveView.latestJPEG : cameraSnapshot, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity).frame(maxHeight: composing ? 100 : 160)
                    .clipShape(RoundedRectangle(cornerRadius: 5)).accessibilityLabel("Latest \(LiveViewPolicy.sourceName(cameraSource)) snapshot")
            } else {
                ZStack {
                    Color.black.opacity(0.2)
                    if capturing { ProgressView() } else { Image(systemName: "eyeglasses").font(.system(size: 26)).foregroundStyle(.secondary) }
                }.frame(height: 90)
            }
            Text(liveView.active ? (liveView.latestJPEG == nil ? "Waiting for fresh camera frames…" : "Sharing \(LiveViewPolicy.sourceName(cameraSource)) · fresh frames with each question. Not continuous video analysis.") : capturing ? "capturing…" : "Fresh frame with each send").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
            HStack {
                if liveView.active { Button("stop sharing") { stopLiveView() } }
                else {
                    Button("share") { notice = handleSharingCommand(.start) }.disabled(capturing || sending)
                    Button("retake") { openCamera() }.disabled(capturing || sending)
                }
                Spacer()
                Button("connect") { onConnectGlasses?() }.disabled(capturing)
            }.font(.system(size: 11, design: .monospaced))
        }.padding(12).frame(width: composing ? 205 : 235)
            .background(PrismTerminalStyle.panel, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(PrismTerminalStyle.line))
            .shadow(color: .black.opacity(0.3), radius: 15, y: 7)
            .padding(12).offset(x: cameraOffset.width + cameraDrag.width, y: composing ? 0 : cameraOffset.height + cameraDrag.height)
            .gesture(DragGesture().onChanged { cameraDrag = $0.translation }.onEnded {
                cameraOffset.width = min(0, max(-90, cameraOffset.width + $0.translation.width))
                cameraOffset.height = min(130, max(0, cameraOffset.height + $0.translation.height))
                cameraDrag = .zero
            })
    }
    private var sessionsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("sessions").fontWeight(.semibold); Spacer(); Button { showSessions = false } label: { Image(systemName: "xmark").frame(width: 32, height: 32) } }
            Button("+ new session") { runCommand("/new") }.disabled(terminal.busy || terminal.hasPendingCommand)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(terminal.history) { session in
                        Button {
                            guard !sending, !capturing, !importing, !terminal.dispatching else { return }
                            liveVoice.stop(); stopDictation(); showSessions = false; followOutput = true
                            Task { await terminal.connect(id: session.id) }
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(session.title).lineLimit(2).foregroundStyle(PrismTerminalStyle.ink)
                                Text(session.state).foregroundStyle(.secondary).font(.system(size: 10, design: .monospaced))
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                        }.buttonStyle(.plain)
                        Divider()
                    }
                }
            }
        }.padding(16).frame(maxWidth: 310).frame(maxHeight: 360)
            .background(PrismTerminalStyle.panel, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(PrismTerminalStyle.line)).padding(12)
    }
    private func mediaStrip(_ media: [LensAttachment], removable: Bool) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 9) {
                ForEach(media) { attachment in
                    if let image = UIImage(data: attachment.jpegData) {
                        Image(uiImage: image).resizable().scaledToFill().frame(width: 84, height: 68).clipped()
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                            .overlay(alignment: .topTrailing) {
                                if removable {
                                    Button { attachments.removeAll { $0.id == attachment.id } } label: {
                                        Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black).padding(3)
                                    }.disabled(sending)
                                }
                            }.accessibilityLabel(attachment.label)
                    }
                }
            }
        }.scrollIndicators(.hidden)
    }
    private func toggleDictation() {
        if dictationSessionID != nil || dictation.isListening || dictation.isStarting { stopDictation() }
        else {
            guard canStartDictation else {
                notice = "Wait for the pending send or capture to finish before dictating."
                return
            }
            let id = UUID()
            let seed = composerDraft.beginDictation(id: id)
            dictationSessionID = id
            Task {
                // A tap schedules work; a newer edit, Send, or panel change
                // before this task runs must prevent microphone startup.
                guard dictationSessionID == id, composerDraft.ownsDictation(id: id),
                      canStartDictation, scenePhase == .active,
                      !dictation.isStarting, !dictation.isListening, !dictation.isFinishing else {
                    composerDraft.endDictation(id: id)
                    if dictationSessionID == id { dictationSessionID = nil }
                    return
                }
                await dictation.start(text: seed, dictationID: id)
                guard dictationSessionID == id else { return }
                finishDictationIfIdle()
            }
        }
    }
    private func editComposer(_ text: String) {
        let wasDictating = dictationSessionID != nil || dictation.isStarting || dictation.isListening || dictation.isFinishing
        composerDraft.edit(text) // Manual edits revoke pending ASR ownership.
        if let id = dictationSessionID { composerDraft.endDictation(id: id) }
        dictationSessionID = nil
        if wasDictating {
            dictation.stop()
            notice = "Dictation stopped to keep your edit. Tap the mic to continue."
        }
    }
    private func stopDictation() {
        dictation.stop()
        // Explicit Stop can cancel a queued tap before start() publishes its
        // tagged seed. An old idle notification may not cancel that new tap.
        if let id = dictationSessionID, dictation.transcriptUpdate?.id != id {
            composerDraft.endDictation(id: id); dictationSessionID = nil
            return
        }
        finishDictationIfIdle()
    }
    private func finishDictationIfIdle() {
        guard !dictation.isStarting, !dictation.isListening, !dictation.isFinishing,
              let id = dictationSessionID, let update = dictation.transcriptUpdate,
              update.id == id else { return }
        // SwiftUI can coalesce the final text and idle notifications. Drain
        // the tagged final result before ending ownership, in either order.
        _ = composerDraft.applyDictation(update)
        composerDraft.endDictation(id: id)
        dictationSessionID = nil
    }
    private func openCamera() {
        guard !capturing, !sending else { return }
        if liveView.active { cameraOpen = true; return }
        liveView.clearStopNotice()
        cameraOpen = true; showSessions = false; notice = ""; capturing = true
        let captureID = cameraGeneration
        Task {
            let frame = await captureSnapshot?()
            guard cameraGeneration == captureID, scenePhase == .active, panelActive == 0 else {
                capturing = false; return
            }
            cameraSnapshot = frame
            if cameraSnapshot == nil { notice = "No fresh frame. \(cameraStatus). Use \(cameraActionLabel.lowercased())." }
            capturing = false
        }
    }
    private func runCommand(_ command: String) {
        if (sending || capturing || importing), ["/camera", "/photos", "/dictate", "/new", "/sessions", "/live", "/realtime"].contains(command) {
            notice = "Wait for the current capture or send to finish."
            return
        }
        showCommands = false
        if draft.hasPrefix("/") { draft = "" }
        switch command {
        case "/connect": Task { await terminal.connect() }
        case "/camera": openCamera()
        case "/photos": showPicker = true
        case "/dictate": toggleDictation()
        case "/sessions": Task { await terminal.refreshHistory(); showSessions = true }
        case "/stop": Task { await terminal.stop() }
        case "/new":
            guard !terminal.busy, !sending, !capturing, !importing, !terminal.hasPendingCommand else { notice = "Finish or stop the current command first."; return }
            stopLiveView(); liveVoice.stop(); stopDictation(); showSessions = false; cameraOpen = false; attachments = []; followOutput = true
            Task { await terminal.connect(new: true) }
        case "/live": showVoicePanel = true; composing = false
        case "/realtime":
            guard !terminal.busy else { notice = "Finish or stop Codex before starting Live."; return }
            liveVoice.stop(); onPanel(1)
        case "/crew": onPanel(2)
        case "/settings": onPanel(3)
        case "/history": onPanel(4)
        default: notice = "Unknown command. Use / to see available commands."
        }
    }
    private func acknowledge(_ receipt: TerminalCommandReceipt) {
        let ownsVoiceSubmission = voiceSubmissionID == receipt.id
        guard composerDraft.acknowledge(receipt) || ownsVoiceSubmission else { return }
        attachments.removeAll { receipt.attachmentIDs.contains($0.id) }
        if ownsVoiceSubmission { voiceSubmissionID = nil }
    }
    private func sendDraft() {
        guard canSend else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("/") { runCommand(text.lowercased()); return }
        // Local sharing controls never become a model turn or a Mac action.
        // Keep explicitly attached photos in the composer for the next question.
        if let sharing = LiveViewCommand.parse(text) {
            let requestID = UUID().uuidString
            composerDraft.submitted(id: requestID)
            notice = handleSharingCommand(sharing)
            acknowledge(TerminalCommandReceipt(id: requestID))
            return
        }
        liveVoice.stop(reason: "Typed command submitted from the composer")
        let images = attachments
        let requestID = UUID().uuidString
        composerDraft.submitted(id: requestID)
        sending = true; notice = ""; followOutput = true
        Task {
            // The same bounded executor handles explicit Send and hands-free
            // speech. Explicit attachments retain the normal contextual route.
            if images.isEmpty, let command = SpokenPadCommand.parse(text) {
                defer { sending = false }
                do {
                    notice = try await terminal.padCall("execute", body: [
                        "requestId": requestID, "action": command.action, "value": command.value
                    ])
                    acknowledge(TerminalCommandReceipt(id: requestID))
                } catch {
                    if terminal.pendingPadRequest?.requestID == requestID {
                        // Preserve revision ownership until receipt recovery or
                        // the user's explicit checked-the-Mac acknowledgment.
                        notice = "The action response is unknown. Use Check last action; new commands are blocked to prevent repetition."
                    } else {
                        composerDraft.rejected(id: requestID)
                        notice = "The command wasn't accepted. \(error.localizedDescription)"
                    }
                }
                return
            }
            var references = images
            let autoVision = UserDefaults.standard.object(forKey: "prismAutoVision") as? Bool ?? true
            if images.isEmpty, liveView.active {
                let sharingID = liveView.sharingSessionID
                references = await liveView.imagesForQuestion(cameraSource: cameraSource, readFrame: readCameraFrame ?? { nil })
                guard liveView.sharingSessionID == sharingID, !references.isEmpty else {
                    notice = "No fresh shared view yet. Wait for the preview."
                    composerDraft.rejected(id: requestID); sending = false; return
                }
            } else if images.isEmpty && (cameraOpen || (autoVision && DirectCommandIntent.requestsCamera(text))) {
                cameraOpen = true; capturing = true
                let captureID = cameraGeneration
                let frame = await captureSnapshot?()
                capturing = false
                guard cameraGeneration == captureID, scenePhase == .active, panelActive == 0 else {
                    notice = "The camera changed or closed. Your question was not sent."
                    composerDraft.rejected(id: requestID); sending = false; return
                }
                guard let frame, let image = UIImage(data: frame), let reference = PrismMedia.attachment(image, label: "Current \(LiveViewPolicy.sourceName(cameraSource)) view") else {
                    notice = "No fresh camera view was captured. Check your camera connection and send again."
                    composerDraft.rejected(id: requestID)
                    sending = false; return
                }
                cameraSnapshot = frame
                references = [reference] + Array(images.prefix(2))
            }
            let accepted = await terminal.send(text, attachments: references, requestID: requestID)
            if let receipt = terminal.acceptedCommand { acknowledge(receipt) }
            if !accepted && !terminal.hasPendingCommand { composerDraft.rejected(id: requestID) }
            sending = false
        }
    }
    private func handleSharingCommand(_ command: LiveViewCommand) -> String {
        if command == .stop {
            stopLiveView(); cameraSnapshot = nil; cameraOpen = false
            return "Stopped sharing."
        }
        guard scenePhase == .active else { return "Open Prism to start sharing your view." }
        guard ["glasses", "iphone"].contains(cameraSource),
              let readCameraFrame, let onShareViewChanged else { return "Camera sharing is unavailable. Check the camera connection." }
        if liveView.active, liveView.cameraSource == cameraSource { return "View sharing is already on. Frames are sent with your questions." }
        let voice = liveVoice
        let source = cameraSource
        let backgroundEnabled = keepVoiceInBackground
        liveView.start(cameraSource: source, readFrame: readCameraFrame, canContinue: {
            LiveViewPolicy.canContinue(isInBackground: UIApplication.shared.applicationState == .background,
                                       cameraSource: source, voiceActive: voice.active,
                                       backgroundVoiceEnabled: backgroundEnabled)
        }, releaseCamera: { onShareViewChanged(false) })
        cameraSnapshot = nil; cameraOpen = true
        onShareViewChanged(true)
        return "Starting view sharing. Wait for the preview, then dictate or type a question and Send. Sent frames stay in chat history. Keep Prism open when voice is off."
    }
    private func stopLiveView() {
        cameraGeneration = UUID() // Invalidates a still capture awaiting its frame, too.
        guard liveView.active else { return }
        liveView.stop(); cameraSnapshot = nil; cameraOpen = false
    }
    private func importMedia(_ item: PhotosPickerItem) async {
        guard !importing else { return }
        let sessionID = terminal.descriptor?.id
        importing = true
        defer { importing = false }
        do {
            var added: [LensAttachment] = []
            if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                guard let video = try await item.loadTransferable(type: TerminalImportedVideo.self) else { return }
                defer { try? FileManager.default.removeItem(at: video.url) }
                let asset = AVURLAsset(url: video.url)
                let duration = try await asset.load(.duration).seconds
                guard duration.isFinite, duration > 0 else { throw URLError(.cannotDecodeContentData) }
                let generator = AVAssetImageGenerator(asset: asset)
                generator.appliesPreferredTrackTransform = true
                generator.maximumSize = CGSize(width: 1200, height: 1200)
                for index in 0..<3 {
                    let seconds = max(0, duration - 0.001) * Double(index) / 2
                    let (image, _) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
                    if let frame = PrismMedia.attachment(UIImage(cgImage: image), label: "Video frame at \(Int(seconds))s") { added.append(frame) }
                }
                notice = "Video added as \(added.count) sampled frames."
            } else if let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data),
                      let frame = PrismMedia.attachment(image, label: "Photo") { added = [frame] }
            try Task.checkCancellation()
            guard sessionID == terminal.descriptor?.id else { return }
            attachments = Array((attachments + added).prefix(cameraOpen ? 2 : 3))
        } catch { notice = "Could not add media. \(error.localizedDescription)" }
    }
}
