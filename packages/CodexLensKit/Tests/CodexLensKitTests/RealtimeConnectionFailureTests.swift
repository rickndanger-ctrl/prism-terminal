import XCTest
@testable import CodexLensKit

final class RealtimeConnectionFailureTests: XCTestCase {
    func testAccountFailureStopsReconnectEvenWithoutAnErrorCode() {
        XCTAssertNotNil(RealtimeConnectionFailure.accountActionMessage(code: nil, message: "You have no credits remaining. Add credits to continue using the API."))
        XCTAssertNotNil(RealtimeConnectionFailure.accountActionMessage(code: "insufficient_quota", message: "Quota exceeded"))
    }
    func testTransientRateLimitsAndSocketFailuresRemainRetryable() {
        XCTAssertNil(RealtimeConnectionFailure.accountActionMessage(code: "rate_limit_exceeded", message: "Please try again later"))
        XCTAssertNil(RealtimeConnectionFailure.accountActionMessage(code: nil, message: "Socket is not connected"))
    }
}
