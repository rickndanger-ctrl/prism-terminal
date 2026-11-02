import XCTest
@testable import CodexLensKit

final class VoiceBackendTests: XCTestCase {
    func testEachSavedChoiceSelectsItsOwnProviderModel() {
        XCTAssertEqual(VoiceBackend(savedValue: "openai").realtimeModel, "gpt-realtime-2.1")
        XCTAssertEqual(VoiceBackend(savedValue: "huggingface").realtimeModel, "huggingface")
        XCTAssertEqual(VoiceBackend(savedValue: "gpt-live").realtimeModel, "gpt-live-1")
        XCTAssertEqual(VoiceBackend(savedValue: "gemini"), .openai)
        XCTAssertEqual(VoiceBackend(savedValue: "unknown"), .openai)
    }

    func testOnlyGptLiveFallsBackToRealtimeAtStartup() {
        XCTAssertEqual(VoiceBackend.gptLive.startupFallback, .openai)
        XCTAssertEqual(VoiceBackend.gptLive.startupFallback?.realtimeModel, "gpt-realtime-2.1")
        XCTAssertNil(VoiceBackend.openai.startupFallback)
        XCTAssertNil(VoiceBackend.huggingface.startupFallback)
    }
}
