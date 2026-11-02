import SwiftUI
import Security
import CodexLensKit

enum PrismCodexBridge {
    static var address: String { UserDefaults.standard.string(forKey: "prismCodexURL") ?? "" }
    private static let service = "org.example.PrismTerminal.codex-gateway"
    static var token: String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "gateway",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
    static func saveToken(_ value: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "gateway"]
        if value.isEmpty { SecItemDelete(query as CFDictionary); return }
        let update = [kSecValueData as String: Data(value.utf8)]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var create = query.merging(update) { _, new in new }
            create[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(create as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
    static var isConfigured: Bool { (try? client()) != nil }
    static func client() throws -> GatewayClient {
        guard let url = URL(string: address), let host = url.host,
              url.user == nil, url.password == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host)),
              !token.isEmpty else {
            throw NSError(domain: "PrismCore", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Connect your Codex Mac in Settings."])
        }
        let savedToken = token
        return GatewayClient(configuration: .init(baseURL: url, tokenProvider: { savedToken }))
    }
}

struct PrismTaskReceipt: Codable, Identifiable {
    let id: String
    let conversationID: UUID
    let gateway: String
    var instruction: String? = nil
}

struct PrismTrackedTask: Identifiable {
    let receipt: PrismTaskReceipt
    var progress: AssistantTaskProgress
    var id: String { receipt.id }
    var mac: String { URL(string: receipt.gateway)?.host ?? "Codex Mac" }
    var instruction: String { progress.status?.instruction ?? receipt.instruction ?? "Mac task" }
}

@MainActor
final class PrismChatStore: ObservableObject {
    @Published private(set) var conversation = LensConversation()
    @Published private(set) var history: [LensConversation] = []
    @Published var error = ""
    private let writer = LensConversationArchiveWriter()
    private var revision: UInt64 = 0
    private var saveTask: Task<Void, Never>?
    private var canSave = true
    private let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("PrismCore/chat-history.json")

    init() {
        do {
            history = try LensConversationArchive.load(from: url)
            conversation = history.last ?? LensConversation()
        } catch {
            canSave = false
            self.error = "Saved chats could not be read. The original file has been preserved."
        }
    }

    func append(_ message: LensChatMessage, to id: UUID? = nil) {
        if let id, id != conversation.id {
            if let i = history.firstIndex(where: { $0.id == id }) { history[i].append(message) }
            else { history.append(LensConversation(id: id, messages: [message])) }
        } else { conversation.append(message) }
        persist()
    }
    func delta(_ text: String, responseID: String) {
        conversation.appendAssistant(delta: text, responseID: responseID)
        persist()
    }
    func state(_ state: LensChatMessage.State, id: String) {
        conversation.setState(state, for: id)
        persist()
    }
    func transcript(_ text: String, id: String) {
        conversation.finishUserTranscript(text, id: id)
        persist()
    }
    func interrupt() { conversation.interruptPending(); persist() }
    func select(_ saved: LensConversation) {
        updateCurrent()
        conversation = saved
        persist()
    }
    func newConversation() {
        updateCurrent()
        conversation = LensConversation()
        persist()
    }
    /// A terminal task receipt is removed only once its result is durable.
    func flush() async -> Bool {
        guard canSave else { return false }
        do {
            try await writer.save(history, to: url, revision: revision)
            return true
        } catch {
            self.error = "Could not save this chat: \(error.localizedDescription)"
            return false
        }
    }
    private func updateCurrent() {
        if let i = history.firstIndex(where: { $0.id == conversation.id }) { history[i] = conversation }
        else if !conversation.messages.isEmpty { history.append(conversation) }
        history = Array(history.suffix(20))
    }
    private func persist() {
        guard canSave else { return }
        updateCurrent()
        revision += 1
        let snapshot = history, revision = revision, url = url, writer = writer
        saveTask?.cancel()
        saveTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(250))
                try await writer.save(snapshot, to: url, revision: revision)
            } catch is CancellationError { }
            catch { self.error = "Could not save this chat: \(error.localizedDescription)" }
        }
    }
}

enum PrismMedia {
    static func attachment(_ image: UIImage, label: String) -> LensAttachment? {
        let scale = min(1, 1200 / max(image.size.width, image.size.height))
        guard scale.isFinite, image.size.width > 0, image.size.height > 0 else { return nil }
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        for quality in [0.7, 0.5, 0.3, 0.15] {
            if let data = resized.jpegData(compressionQuality: quality), data.count <= 150_000 {
                return LensAttachment(jpegData: data, label: label)
            }
        }
        return nil
    }
}
