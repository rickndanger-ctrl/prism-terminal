import XCTest
@testable import CodexLensKit

final class DirectCommandIntentTests: XCTestCase {
    func testVisualQuestionsAndModelRequestsUseCamera() {
        for text in ["What am I looking at?", "What’s this?", "Build a 3D model of this in Blender."] {
            XCTAssertTrue(DirectCommandIntent.requestsCamera(text))
        }
    }
    func testOrdinaryCommandsDoNotShareUnrelatedCameraContext() {
        for text in ["Open Calculator", "Type hello", "Search for cafes", "What is the time?"] {
            XCTAssertFalse(DirectCommandIntent.requestsCamera(text))
        }
    }
    func testNaturalDictationRequestsTheWearersView() {
        for text in ["Can you can you describe what I see?", "Tell me about what I’m looking at", "Describe what I am seeing"] {
            XCTAssertTrue(DirectCommandIntent.requestsCamera(text))
        }
    }
    func testExplicitDesktopRequestsStayOnTheDesktop() {
        XCTAssertFalse(DirectCommandIntent.requestsCamera("What do you see on my Mac?"))
        XCTAssertFalse(DirectCommandIntent.requestsCamera("Describe what I see on my screen"))
        XCTAssertTrue(DirectCommandIntent.requestsCamera("Use my Mac to model what I see through my glasses"))
        XCTAssertTrue(DirectCommandIntent.requestsCamera("Build a 3D model of this on my Mac"))
    }
}
