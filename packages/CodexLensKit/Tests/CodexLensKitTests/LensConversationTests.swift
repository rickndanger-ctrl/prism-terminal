import XCTest
@testable import CodexLensKit

final class LensConversationTests: XCTestCase {
    func testDelayedOldSnapshotCannotUndoHistoryDeletion() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = LensConversationArchiveWriter()
        let old = LensConversation(messages: [.init(role: .user, text: "Deleted conversation")])
        try await writer.save([], to: url, revision: 2)
        try await writer.save([old], to: url, revision: 1)
        XCTAssertTrue(try LensConversationArchive.load(from: url).isEmpty)
    }

    func testRestorationKeepsSentContextWithoutRetryingUnconfirmedMessages() throws {
        var chat = LensConversation()
        chat.append(.init(role: .user, text: "Do not retry me", state: .failed))
        chat.append(.init(role: .user, text: "Still sending", state: .sending))
        chat.append(.init(role: .assistant, text: "Incomplete", state: .interrupted))
        chat.append(.init(role: .user, text: "What is this?", state: .sent))
        chat.append(.init(role: .assistant, text: "A vase.", state: .complete))
        let text = try XCTUnwrap(chat.restorationText())
        XCTAssertTrue(text.contains("What is this?"))
        XCTAssertTrue(text.contains("A vase."))
        XCTAssertTrue(text.contains("not repeat actions"))
        XCTAssertFalse(text.contains("Do not retry me"))
        XCTAssertFalse(text.contains("Still sending"))
        XCTAssertFalse(text.contains("Incomplete"))
    }

    func testStreamingResponsesStaySeparateAndUserEchoIsDeduplicated() {
        var chat = LensConversation()
        let request = LensChatMessage(id: "user-1", role: .user, text: "What is this?")
        chat.append(request)
        chat.append(request)
        chat.appendAssistant(delta: "A ceramic ", responseID: "response-1")
        chat.appendAssistant(delta: "vase.", responseID: "response-1")
        chat.setState(.complete, for: "response-1")
        chat.appendAssistant(delta: "Another answer", responseID: "response-2")
        XCTAssertEqual(chat.messages.count, 3)
        XCTAssertEqual(chat.messages[1].text, "A ceramic vase.")
        XCTAssertEqual(chat.messages[1].state, .complete)
        XCTAssertEqual(chat.messages[2].state, .streaming)
    }

    func testHistoryRoundTripPreservesPhotosAndMarksUnfinishedWork() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("history.json")
        var chat = LensConversation()
        let image = LensAttachment(jpegData: Data([1, 2, 3]), label: "Glasses photo")
        chat.append(.init(role: .user, text: "Build a model", attachments: [image], state: .sending))
        chat.appendAssistant(delta: "Working", responseID: "response")
        try LensConversationArchive.save([chat], to: url)
        let loaded = try XCTUnwrap(LensConversationArchive.load(from: url).first)
        XCTAssertEqual(loaded.messages[0].attachments, [image])
        XCTAssertEqual(loaded.messages[0].state, .failed)
        XCTAssertEqual(loaded.messages[1].state, .interrupted)
        XCTAssertEqual(loaded.title, "Build a model")
    }

    func testCorruptArchiveIsReportedWithoutOverwritingIt() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let original = Data("broken history".utf8)
        try original.write(to: url)
        XCTAssertThrowsError(try LensConversationArchive.load(from: url))
        XCTAssertEqual(try Data(contentsOf: url), original)
    }

    func testBoundedHistoryRetainsMostRecentWholeMessages() {
        var chat = LensConversation()
        for i in 0..<220 { chat.append(.init(role: .user, text: "Message \(i)")) }
        XCTAssertEqual(chat.messages.count, 200)
        XCTAssertEqual(chat.messages.first?.text, "Message 20")
        XCTAssertEqual(chat.messages.last?.text, "Message 219")
    }
}
