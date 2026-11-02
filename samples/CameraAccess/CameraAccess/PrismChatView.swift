import SwiftUI
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers
import CodexLensKit

private struct PrismImportedVideo: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return Self(url: copy)
        }
    }
}

struct PrismChatView: View {
    @ObservedObject var session: MoARealtimeSession
    @ObservedObject var store: PrismChatStore
    var latestFrameJPEG: Data?
    var cameraConnected: Bool
    var cameraSource: String
    var onConnectGlasses: (() -> Void)?
    var cameraStatus: String
    var cameraActionLabel: String
    var captureSnapshot: (() async -> Data?)?
    @AppStorage("prismShowCameraPreview") private var showPreview = true
    @State private var draft = ""
    @State private var attachments: [LensAttachment] = []
    @State private var picker: PhotosPickerItem?
    @State private var showHistory = false
    @State private var importing = false
    @State private var sending = false
    @State private var notice = ""
    @State private var visualChat = false
    @State private var cameraSnapshot: Data?
    @State private var capturing = false
    @State private var expandedTask: String?
    @StateObject private var dictation = PrismDictation()
    @State private var dictationConversationID: UUID?
    @FocusState private var composing: Bool
    private let accent = Color(red: 0.68, green: 0.29, blue: 0.19)

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        if store.conversation.messages.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                Image(systemName: "eyeglasses").font(.system(size: 34)).foregroundStyle(accent)
                                Text("What are we working on?").font(.title2.weight(.semibold))
                                Text("Tell Codex what to do. Type, dictate, or share a photo.")
                                    .foregroundStyle(.secondary)
                            }.padding(.vertical, 40)
                        }
                        ForEach(store.conversation.messages.filter { !($0.role == .event && $0.text.hasPrefix("Codex task:")) }) { message in
                            messageView(message)
                        }
                        if let task = session.approval {
                            approvalPreview(task)
                        }
                        ForEach(session.codexTasks) { task in
                            taskProgress(task)
                        }
                        if session.approving { ProgressView("Starting Codex…") }
                        if !store.error.isEmpty { Text(store.error).font(.footnote).foregroundStyle(.red) }
                        Color.clear.frame(height: 1).id("latest")
                    }.padding(.horizontal, 20).padding(.vertical, 16)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: store.conversation.messages) { _, _ in
                    proxy.scrollTo("latest", anchor: .bottom)
                }
                .onChange(of: session.approval?.taskId) { _, _ in
                    withAnimation { proxy.scrollTo("latest", anchor: .bottom) }
                }
            }
            .navigationTitle("Prism Terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showHistory = true } label: { Image(systemName: "clock.arrow.circlepath") }
                        .accessibilityLabel("Chat history")
                        .disabled(sending || capturing || dictation.isListening || dictation.isStarting || dictation.isFinishing)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dictation.stop()
                        session.selectConversation(nil); draft = ""; attachments = []
                    } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New chat").disabled(sending || capturing || importing || dictation.isListening || dictation.isStarting || dictation.isFinishing)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .sheet(isPresented: $showHistory) {
                NavigationStack {
                    List(store.history.reversed()) { saved in
                        Button {
                            dictation.stop()
                            session.selectConversation(saved); draft = ""; attachments = []; showHistory = false
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(saved.title).foregroundStyle(.primary).lineLimit(2)
                                Text(saved.createdAt, style: .date).font(.caption).foregroundStyle(.secondary)
                            }
                        }.disabled(sending || importing)
                    }
                    .overlay { if store.history.isEmpty { ContentUnavailableView("No saved chats", systemImage: "bubble.left.and.bubble.right") } }
                    .navigationTitle("Chats").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showHistory = false } } }
                }
            }
            .task(id: picker) { if let picker { await importMedia(picker) } }
            .onChange(of: dictation.transcript) { _, text in
                if dictationConversationID == store.conversation.id { draft = text }
            }
            .onChange(of: store.conversation.id) { _, _ in visualChat = false; cameraSnapshot = nil }
            .onAppear { session.useDirectCommands() }
            .onDisappear { dictation.stop() }
        }.tint(.primary)
    }

    private func approvalPreview(_ task: PreparedAssistantTask) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Image(systemName: "desktopcomputer").foregroundStyle(.secondary)
                Text("Ready to run").font(.subheadline.weight(.semibold))
            }
            Text(task.instruction).font(.body).textSelection(.enabled)
            DisclosureGroup("Mac details") {
                Text(session.approvalMac).font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Not now") { session.dismissApproval() }.foregroundStyle(.secondary)
                    .frame(minHeight: 44)
                Spacer()
                Button("Run with Codex", systemImage: "arrow.right") { Task { await session.approveCodex() } }
                    .font(.subheadline.weight(.semibold)).buttonStyle(.borderedProminent).tint(.primary)
                    .buttonBorderShape(.capsule).frame(minHeight: 44)
            }
        }.padding(18)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.primary.opacity(0.12), lineWidth: 1))
    }

    private func taskProgress(_ task: PrismTrackedTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text(task.progress.title).font(.subheadline).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button { expandedTask = expandedTask == task.id ? nil : task.id } label: {
                    Image(systemName: expandedTask == task.id ? "chevron.up" : "ellipsis").frame(width: 40, height: 44)
                }.accessibilityLabel("Task details")
                Button { Task { await session.stopCodexTask(task.id) } } label: {
                    Image(systemName: "stop.circle").font(.title3).frame(width: 40, height: 44)
                }.accessibilityLabel("Stop task").disabled(!session.canStopCodexTask(task))
            }
            if let warning = task.progress.connectionNotice { Text(warning).font(.caption).foregroundStyle(.secondary) }
            if task.receipt.conversationID != store.conversation.id {
                Text("Started in another chat").font(.caption).foregroundStyle(.secondary)
            }
            if expandedTask == task.id {
                VStack(alignment: .leading, spacing: 8) {
                    Text(task.instruction).font(.subheadline).textSelection(.enabled)
                    Text(task.mac).font(.caption).foregroundStyle(.secondary)
                    if let summary = task.progress.status?.summary { Text(summary).font(.caption).foregroundStyle(.secondary) }
                    Button("Refresh status") { session.resumeCodexTasks(refresh: true) }.font(.caption)
                }
            }
        }
    }

    @ViewBuilder private func messageView(_ message: LensChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if message.role == .event && !message.text.hasPrefix("Codex · completed\n") {
                Label("Codex on Mac", systemImage: "desktopcomputer").font(.caption.weight(.medium)).foregroundStyle(.secondary)
            }
            if !message.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(message.attachments) { item in
                            if let image = UIImage(data: item.jpegData) {
                                Image(uiImage: image).resizable().scaledToFit().frame(height: 150)
                                    .clipShape(RoundedRectangle(cornerRadius: 12)).accessibilityLabel(item.label)
                            }
                        }
                    }
                }
            }
            if !message.text.isEmpty {
                Text(message.text.hasPrefix("Codex · completed\n") ? String(message.text.dropFirst("Codex · completed\n".count)) : message.text)
                    .textSelection(.enabled)
            }
            if [.sending, .streaming, .interrupted, .failed].contains(message.state) {
                Text(message.state == .failed ? "Delivery not confirmed" : message.state.rawValue.capitalized)
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(message.role == .user ? 14 : 0)
        .background(message.role == .user ? Color(.secondarySystemBackground) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 18))
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if visualChat, showPreview {
                snapshotPreview
            }
            if !cameraConnected && !["Camera disconnected", "Camera ready", "Camera stopped"].contains(cameraStatus) {
                Text(cameraStatus).font(.caption).foregroundStyle(.secondary)
            }
            if !notice.isEmpty { Text(notice).font(.caption).foregroundStyle(.secondary) }
            if !session.note.isEmpty { Text(session.note).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
            if !dictation.notice.isEmpty { Text(dictation.notice).font(.caption).foregroundStyle(.secondary) }
            if importing { ProgressView("Adding media…").font(.caption) }
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(attachments) { item in
                            if let image = UIImage(data: item.jpegData) {
                                Image(uiImage: image).resizable().scaledToFill().frame(width: 64, height: 64).clipped()
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                    .overlay(alignment: .topTrailing) {
                                        Button { attachments.removeAll { $0.id == item.id } } label: {
                                            Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                                                .foregroundStyle(.white, .black)
                                        }.accessibilityLabel("Remove \(item.label)")
                                    }
                            }
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 12) {
                Menu {
                    Button(cameraSource == "iphone" ? "Camera photo" : "Glasses photo", systemImage: "eyeglasses", action: openCamera)
                        .disabled(capturing || sending)
                    PhotosPicker(selection: $picker, matching: .any(of: [.images, .videos])) {
                        Label("Photo or video", systemImage: "photo.on.rectangle")
                    }.disabled(attachments.count >= (visualChat ? 2 : 3))
                    Toggle("Camera preview", isOn: $showPreview)
                } label: { Image(systemName: "plus").font(.title3).frame(width: 28, height: 36) }
                TextField("Message Codex", text: $draft, axis: .vertical)
                    .lineLimit(1...5).focused($composing).padding(.vertical, 8)
                    .disabled(sending || dictation.isListening || dictation.isFinishing)
                Button {
                    composing = false
                    if dictation.isListening || dictation.isStarting { dictation.stop() }
                    else {
                        session.useDirectCommands()
                        dictationConversationID = store.conversation.id
                        Task { await dictation.start(text: draft) }
                    }
                } label: {
                    Image(systemName: dictation.isListening ? "stop.circle.fill" : "mic.circle")
                        .font(.title).foregroundStyle(dictation.isListening ? accent : .primary)
                }.accessibilityLabel(dictation.isListening ? "Stop dictation" : "Start dictation")
                    .disabled(sending || dictation.isFinishing)
                if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty || visualChat {
                    Button(action: sendDraft) { Image(systemName: "arrow.up.circle.fill").font(.title).foregroundStyle(accent) }
                        .accessibilityLabel("Send command").disabled(!canSend)
                }
            }.padding(.horizontal, 12).padding(.vertical, 6)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 24))
            HStack(spacing: 6) {
                Circle().fill(dictation.isListening ? Color.red : Color.secondary).frame(width: 5, height: 5)
                Text(dictation.isStarting ? "Starting dictation…" : dictation.isFinishing ? "Finishing dictation…" : dictation.isListening ? "Dictating · \(dictation.inputName)" : "Direct to Codex")
                Spacer()
                if captureSnapshot != nil || onConnectGlasses != nil {
                    Button(visualChat ? "Retake" : cameraActionLabel, systemImage: "camera", action: openCamera)
                        .disabled(capturing || sending)
                } else {
                    Label(cameraStatus, systemImage: "eyeglasses")
                }
            }.font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 6)
        }.padding(.horizontal, 16).padding(.vertical, 10).background(.regularMaterial)
    }

    private var canSend: Bool {
        !sending && !capturing && !importing && !dictation.isListening && !dictation.isFinishing && !dictation.isStarting
        && session.approval == nil
        && !session.codexTasks.contains { $0.receipt.gateway == PrismCodexBridge.address && $0.progress.status?.state.isTerminal != true }
    }

    private var snapshotPreview: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(capturing ? "Taking a snapshot…" : "Camera snapshot", systemImage: "camera")
                Spacer()
                Button {
                    visualChat = false; cameraSnapshot = nil
                } label: { Image(systemName: "xmark").frame(width: 32, height: 32) }
                    .accessibilityLabel("Stop adding camera snapshots").disabled(capturing || sending)
            }.font(.caption).foregroundStyle(.secondary)
            if let data = cameraSnapshot, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity).frame(height: composing ? 80 : 112)
                    .background(Color.black.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                    .clipShape(RoundedRectangle(cornerRadius: 12)).accessibilityLabel("Last camera snapshot")
            } else if capturing {
                ProgressView().frame(maxWidth: .infinity).frame(height: 64)
            }
            Text("A fresh snapshot with each message.").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func openCamera() {
        guard !capturing, !sending else { return }
        guard let captureSnapshot else { onConnectGlasses?(); return }
        visualChat = true; showPreview = true; capturing = true; notice = ""
        let conversationID = store.conversation.id
        Task {
            let frame = await captureSnapshot()
            if conversationID == store.conversation.id {
                if let frame { cameraSnapshot = frame }
                else { notice = "Couldn't capture a fresh view. Check your glasses and tap Retake." }
            }
            capturing = false
        }
    }

    private func sendDraft() {
        let text = draft, images = attachments
        draft = ""; attachments = []; composing = false; sending = true; notice = ""
        Task {
            var references = images
            let needsCamera = visualChat || (images.isEmpty && session.autoVisionEnabled && DirectCommandIntent.requestsCamera(text))
            if needsCamera {
                visualChat = true; showPreview = true; capturing = true
                let data = await captureSnapshot?()
                capturing = false
                guard let data, let image = UIImage(data: data), let frame = PrismMedia.attachment(image, label: "Current camera view") else {
                    draft = text; attachments = images; sending = false
                    notice = "No fresh camera view was captured. Check your glasses and send again."
                    return
                }
                cameraSnapshot = data
                references = [frame] + Array(images.prefix(2))
            }
            let accepted = await session.sendDirectCommand(text, attachments: references)
            if !accepted, draft.isEmpty { draft = text; if attachments.isEmpty { attachments = images } }
            sending = false
        }
    }

    @MainActor private func importMedia(_ item: PhotosPickerItem) async {
        importing = true
        defer { importing = false }
        let conversationID = store.conversation.id
        do {
            var added: [LensAttachment] = []
            if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                guard let video = try await item.loadTransferable(type: PrismImportedVideo.self) else { return }
                defer { try? FileManager.default.removeItem(at: video.url) }
                let asset = AVURLAsset(url: video.url)
                let duration = try await asset.load(.duration).seconds
                guard duration.isFinite, duration > 0 else { throw URLError(.cannotDecodeContentData) }
                let generator = AVAssetImageGenerator(asset: asset)
                generator.appliesPreferredTrackTransform = true
                generator.maximumSize = CGSize(width: 1200, height: 1200)
                for index in 0..<3 {
                    try Task.checkCancellation()
                    let seconds = max(0, duration - 0.001) * Double(index) / 2
                    let (image, _) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
                    if let attachment = PrismMedia.attachment(UIImage(cgImage: image), label: "Video frame at \(Int(seconds))s") { added.append(attachment) }
                }
                notice = "Video added as \(added.count) sampled frames."
            } else if let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data),
                      let attachment = PrismMedia.attachment(image, label: "Photo") {
                added = [attachment]
            }
            guard !Task.isCancelled, conversationID == store.conversation.id else { return }
            attachments = Array((attachments + added).prefix(visualChat ? 2 : 3))
        } catch is CancellationError { }
        catch { notice = "Could not add that media: \(error.localizedDescription)" }
    }
}
