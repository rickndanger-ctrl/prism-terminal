import XCTest
@testable import CodexLensKit

final class TerminalTranscriptTests: XCTestCase {
    func testReplayIsIdempotentAndFinalTextReplacesStream() throws {
        var transcript = TerminalTranscript()
        let delta = TerminalEvent(sequence: 1, kind: "assistant", itemId: "answer", text: "Hello", operation: "append", status: "running")
        transcript.apply(delta); transcript.apply(delta)
        transcript.apply(.init(sequence: 2, kind: "assistant", itemId: "answer", text: "Hello there", operation: "replace", status: "completed"))
        XCTAssertEqual(transcript.entries.count, 1)
        XCTAssertEqual(transcript.entries.first?.text, "Hello there")
        XCTAssertEqual(transcript.cursor, 2)
    }
    func testToolCompletionRetainsOutputAndUpdatesStatus() {
        var transcript = TerminalTranscript()
        transcript.apply(.init(sequence: 10, kind: "tool", itemId: "cmd", text: "96\n", operation: "append"))
        transcript.apply(.init(sequence: 11, kind: "tool", itemId: "cmd", status: "completed", title: "Calculate"))
        XCTAssertEqual(transcript.entries.first?.text, "96\n")
        XCTAssertEqual(transcript.entries.first?.status, "completed")
        XCTAssertEqual(transcript.entries.first?.title, "Calculate")
    }
    func testStateAndUnsupportedEventsNeverBecomeMessages() {
        var transcript = TerminalTranscript()
        transcript.apply(.init(sequence: 1, kind: "state", itemId: "state", status: "stopping"))
        transcript.apply(.init(sequence: 2, kind: "reasoning", itemId: "hidden", text: "private"))
        XCTAssertEqual(transcript.state, "stopping")
        XCTAssertTrue(transcript.entries.isEmpty)
        XCTAssertEqual(transcript.cursor, 2)
    }
}
