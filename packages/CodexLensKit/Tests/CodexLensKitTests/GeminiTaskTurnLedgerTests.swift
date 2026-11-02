import XCTest
@testable import CodexLensKit

final class GeminiTaskTurnLedgerTests: XCTestCase {
    func testDuplicateTurnNeverDispatchesAgainEvenWithAnotherCallID() {
        var ledger = GeminiTaskTurnLedger()
        let first = UUID(), second = UUID()
        XCTAssertTrue(ledger.claim(first))
        XCTAssertFalse(ledger.claim(first))
        XCTAssertTrue(ledger.claim(second))
        XCTAssertFalse(ledger.claim(first))
        XCTAssertFalse(ledger.claim(second))
    }

    func testCapacityFailsClosedWithoutEvictingOldTombstones() {
        var ledger = GeminiTaskTurnLedger(capacity: 2)
        let first = UUID()
        XCTAssertTrue(ledger.claim(first))
        XCTAssertTrue(ledger.claim(UUID()))
        XCTAssertFalse(ledger.claim(UUID()))
        XCTAssertFalse(ledger.claim(first))
    }

    func testInvalidCapacityCannotAllowUnboundedDispatch() {
        for capacity in [-1, 0] {
            var ledger = GeminiTaskTurnLedger(capacity: capacity)
            XCTAssertFalse(ledger.claim(UUID()))
        }
    }
}
