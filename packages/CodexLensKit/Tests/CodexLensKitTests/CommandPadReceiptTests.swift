import XCTest
@testable import CodexLensKit

final class CommandPadReceiptTests: XCTestCase {
    func testPendingMetadataContainsNoExecutablePayload() throws {
        let pending = CommandPadPendingRequest(requestID: UUID().uuidString, gateway: "http://test.invalid:8787")
        let data = try JSONEncoder().encode(pending)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(Set(object.keys), ["requestID", "gateway"])
        XCTAssertEqual(try JSONDecoder().decode(CommandPadPendingRequest.self, from: data), pending)
    }

    func testReceiptCompletionDoesNotClaimActionSuccess() throws {
        let summary = "Action could not be verified. Inspect the Mac before trying again."
        let receipt = CommandPadReceipt(summary: summary, state: .completed)
        XCTAssertEqual(receipt.completedSummary, summary)
        XCTAssertEqual(try JSONDecoder().decode(CommandPadReceipt.self, from: JSONEncoder().encode(receipt)), receipt)
    }

    func testUnknownAndRunningReceiptsNeverClearRecovery() {
        for state in [CommandPadReceiptState.unknown, .running] {
            XCTAssertNil(CommandPadReceipt(summary: nil, state: state).completedSummary)
            XCTAssertNil(CommandPadReceipt(summary: "Unexpected summary", state: state).completedSummary)
        }
    }

    func testMissingOrEmptyCompletedSummaryRemainsUnresolved() {
        for summary in [nil, "", " \n\t"] as [String?] {
            XCTAssertNil(CommandPadReceipt(summary: summary, state: .completed).completedSummary)
        }
    }

    func testUnexpectedReceiptStateFailsDecoding() {
        XCTAssertThrowsError(try JSONDecoder().decode(CommandPadReceipt.self,
            from: Data(#"{"summary":"done","state":"executed"}"#.utf8)))
    }

    func testOnlyKnownPreExecutionStatusesAreDefinitive() {
        for status in [400, 401, 404, 409] {
            XCTAssertTrue(CommandPadReceipt.isDefinitiveExecutionRejection(status))
        }
        for status in [200, 202, 403, 408, 429, 500, 502, 503, 504] {
            XCTAssertFalse(CommandPadReceipt.isDefinitiveExecutionRejection(status))
        }
    }

    func testRecoveredReceiptClearsOnlyItsSubmittedEditingRevision() {
        let id = UUID().uuidString
        var draft = TerminalComposerDraft()
        draft.edit("Type original words")
        draft.submitted(id: id)
        draft.edit("Type newer words")
        XCTAssertTrue(draft.acknowledge(TerminalCommandReceipt(id: id)))
        XCTAssertEqual(draft.text, "Type newer words")
        XCTAssertFalse(draft.acknowledge(TerminalCommandReceipt(id: id)))
    }
}
