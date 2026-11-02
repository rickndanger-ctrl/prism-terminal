import XCTest
@testable import CodexLensKit

final class GlassesAudioRoutePolicyTests: XCTestCase {
    func testConnectedSessionPausesWhenGlassesRouteDisappears() {
        XCTAssertEqual(
            GlassesAudioRoutePolicy.action(
                assistantArmed: true,
                sessionPhase: .connected,
                glassesInputAvailable: false,
                glassesInputRouted: false
            ),
            .pauseRealtime
        )
    }

    func testConnectedSessionDoesNotFallBackToAvailableButUnroutedInput() {
        XCTAssertEqual(
            GlassesAudioRoutePolicy.action(
                assistantArmed: true,
                sessionPhase: .connected,
                glassesInputAvailable: true,
                glassesInputRouted: false
            ),
            .pauseRealtime
        )
    }

    func testStoppedSessionResumesOnlyWhenGlassesInputIsAvailable() {
        XCTAssertEqual(
            GlassesAudioRoutePolicy.action(
                assistantArmed: true,
                sessionPhase: .stopped,
                glassesInputAvailable: false,
                glassesInputRouted: false
            ),
            .none
        )
        XCTAssertEqual(
            GlassesAudioRoutePolicy.action(
                assistantArmed: true,
                sessionPhase: .stopped,
                glassesInputAvailable: true,
                glassesInputRouted: false
            ),
            .resumeRealtime
        )
    }

    func testConnectingSessionMaySettleOnlyWhileGlassesRemainAvailable() {
        XCTAssertEqual(
            GlassesAudioRoutePolicy.action(
                assistantArmed: true,
                sessionPhase: .connecting,
                glassesInputAvailable: true,
                glassesInputRouted: false
            ),
            .none
        )
        XCTAssertEqual(
            GlassesAudioRoutePolicy.action(
                assistantArmed: true,
                sessionPhase: .connecting,
                glassesInputAvailable: false,
                glassesInputRouted: false
            ),
            .pauseRealtime
        )
    }

    func testDisarmedAssistantNeverRestartsOrPauses() {
        for phase in [
            GlassesAudioSessionPhase.stopped,
            .connecting,
            .connected,
        ] {
            XCTAssertEqual(
                GlassesAudioRoutePolicy.action(
                    assistantArmed: false,
                    sessionPhase: phase,
                    glassesInputAvailable: true,
                    glassesInputRouted: false
                ),
                .none
            )
        }
    }
}
