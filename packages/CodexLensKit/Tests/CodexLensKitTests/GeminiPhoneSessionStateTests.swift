import XCTest
@testable import CodexLensKit

final class GeminiPhoneSessionStateTests: XCTestCase {
    func testAcceptedUtteranceRequiresEndedCurrentTurnAndCannotReplay() {
        var state = GeminiPhoneSessionState()
        let id = UUID()
        let event = GeminiGatewayEvent.acceptedUtterance(turnID: id, text: "Codex, stop")
        XCTAssertFalse(state.receive(event))
        state.receive(.ready)
        state.receive(.activityStarted(id))
        XCTAssertFalse(state.receive(event))
        state.receive(.activityEnded(turnID: id, reason: .silence))
        XCTAssertTrue(state.receive(event))
        XCTAssertFalse(state.receive(event))
        state.receive(.activityStarted(UUID()))
        XCTAssertFalse(state.receive(event))
    }

    func testSuppressedUtteranceCannotBecomeAccepted() {
        var state = GeminiPhoneSessionState()
        let id = UUID()
        state.receive(.ready)
        state.receive(.activityStarted(id))
        state.receive(.activityEnded(turnID: id, reason: .silence))
        state.receive(.responseSuppressed(id))
        XCTAssertFalse(state.receive(.acceptedUtterance(turnID: id, text: "Codex, stop")))
    }
    func testRequiresReadinessAndEndedCurrentTurnBeforeDecision() {
        var state = GeminiPhoneSessionState()
        let id = UUID()
        XCTAssertFalse(state.receive(.activityStarted(id)))
        XCTAssertTrue(state.receive(.ready))
        XCTAssertFalse(state.receive(.ready))
        XCTAssertTrue(state.receive(.activityStarted(id)))
        XCTAssertFalse(state.canDecide(turnID: id))
        XCTAssertTrue(state.receive(.activityEnded(turnID: id, reason: .silence)))
        XCTAssertTrue(state.canDecide(turnID: id))
        state.noteDecisionSent(turnID: id)
        XCTAssertFalse(state.canDecide(turnID: id))
    }

    func testLatePriorTurnEventsCannotChangeNewTurn() {
        var state = GeminiPhoneSessionState()
        let old = UUID(), current = UUID()
        state.receive(.ready)
        state.receive(.activityStarted(old))
        state.receive(.activityStarted(current))
        XCTAssertFalse(state.receive(.activityEnded(turnID: old, reason: .silence)))
        XCTAssertFalse(state.receive(.responseSuppressed(old)))
        XCTAssertFalse(state.receive(.inputTranscript(turnID: old, text: "old")))
        XCTAssertFalse(state.receive(.turnComplete(old)))
        XCTAssertFalse(state.canDecide(turnID: old))
        XCTAssertEqual(state.currentTurnID, current)
        XCTAssertFalse(state.hasEnded)
    }

    func testLimitAndSuppressionCannotBeReapproved() {
        for limited in [true, false] {
            var state = GeminiPhoneSessionState()
            let id = UUID()
            state.receive(.ready)
            state.receive(.activityStarted(id))
            state.receive(.activityEnded(turnID: id, reason: limited ? .limit : .silence))
            if !limited { state.receive(.responseSuppressed(id)) }
            XCTAssertFalse(state.canDecide(turnID: id))
        }
    }
}
