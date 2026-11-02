import XCTest
@testable import CodexLensKit

final class PrismTranscriptTests: XCTestCase {
    func testLateTranscriptKeepsUserBeforeAssistant() {
        var chat = LensConversation()
        chat.append(.init(id: "speech", role: .user, text: "", state: .sending))
        chat.appendAssistant(delta: "Here is what I see.", responseID: "reply")
        chat.finishUserTranscript("What is this?", id: "speech")
        XCTAssertEqual(chat.messages.map(\.id), ["speech", "reply"])
        XCTAssertEqual(chat.messages[0].text, "What is this?")
        XCTAssertEqual(chat.messages[0].state, .sent)
        chat.finishUserTranscript("What is this?", id: "speech")
        XCTAssertEqual(chat.messages.count, 2)
    }
}
