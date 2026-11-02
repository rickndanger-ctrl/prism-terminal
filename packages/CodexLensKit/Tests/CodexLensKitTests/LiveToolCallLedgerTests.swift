import XCTest
@testable import CodexLensKit

final class LiveToolCallLedgerTests: XCTestCase {
    func testCompletedAndPendingCallsCannotRepeat() {
        var ledger = LiveToolCallLedger()
        XCTAssertTrue(ledger.begin("one"))
        XCTAssertFalse(ledger.begin("one"))
        XCTAssertTrue(ledger.finish("one"))
        XCTAssertFalse(ledger.begin("one"))
        XCTAssertFalse(ledger.finish("one"))
        XCTAssertFalse(ledger.finish("unknown"))
        ledger.reset()
        XCTAssertTrue(ledger.begin("one"))
    }
    func testPendingLimitReleasesWithoutForgettingCompletedCalls() {
        var ledger = LiveToolCallLedger()
        for id in 0..<64 { XCTAssertTrue(ledger.begin(String(id))) }
        XCTAssertFalse(ledger.begin("overflow"))
        XCTAssertTrue(ledger.finish("0"))
        XCTAssertTrue(ledger.begin("overflow"))
        XCTAssertFalse(ledger.begin("0"))
    }
}
