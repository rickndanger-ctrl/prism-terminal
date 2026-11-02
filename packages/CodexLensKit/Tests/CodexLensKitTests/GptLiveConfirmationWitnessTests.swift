import XCTest
@testable import CodexLensKit

final class GptLiveConfirmationWitnessTests: XCTestCase {
    private let prepared = Date(timeIntervalSince1970: 1_000)

    private func at(_ seconds: TimeInterval) -> Date {
        prepared.addingTimeInterval(seconds)
    }

    func testAcceptsConfirmationSpokenAfterPreparationAcrossFragments() {
        var witness = GptLiveConfirmationWitness()
        witness.record("Yes. Codex,", at: at(4))
        witness.record(" confirm.", at: at(4.3))
        XCTAssertTrue(witness.heardConfirmation(since: prepared, now: at(5)))
    }

    func testAcceptsCommonMistranscriptions() {
        for phrase in ["Code X, confirm", "codec confirm"] {
            var witness = GptLiveConfirmationWitness()
            witness.record(phrase, at: at(3))
            XCTAssertTrue(witness.heardConfirmation(since: prepared, now: at(4)), phrase)
        }
    }

    func testRejectsConfirmationBeforeOrImmediatelyAtPreparation() {
        var witness = GptLiveConfirmationWitness()
        witness.record("Codex, confirm", at: at(-1))
        XCTAssertFalse(witness.heardConfirmation(since: prepared, now: at(2)))
        witness.record("Codex, confirm", at: at(0.2))
        XCTAssertFalse(witness.heardConfirmation(since: prepared, now: at(2)))
    }

    func testRejectsStaleConfirmation() {
        var witness = GptLiveConfirmationWitness()
        witness.record("Codex, confirm", at: at(2))
        XCTAssertFalse(witness.heardConfirmation(since: prepared, now: at(40)))
    }

    func testLaterSpeechWithdrawsConfirmation() {
        var witness = GptLiveConfirmationWitness()
        witness.record("Codex, confirm", at: at(2))
        witness.record(" actually wait", at: at(3))
        XCTAssertFalse(witness.heardConfirmation(since: prepared, now: at(4)))
    }

    func testRejectsOtherSpeech() {
        for phrase in ["confirm the codex task later", "Codex confirmation", "don't confirm"] {
            var witness = GptLiveConfirmationWitness()
            witness.record(phrase, at: at(2))
            XCTAssertFalse(witness.heardConfirmation(since: prepared, now: at(3)), phrase)
        }
    }

    func testResetForgetsConfirmation() {
        var witness = GptLiveConfirmationWitness()
        witness.record("Codex, confirm", at: at(2))
        witness.reset()
        XCTAssertFalse(witness.heardConfirmation(since: prepared, now: at(3)))
    }
}
