import XCTest
@testable import CodexLensKit

final class AddressedSpeechGateTests: XCTestCase {
    func testCodexIsOptionalGuaranteedAttentionWhileLensIsNeverRequired() {
        var gate = AddressedSpeechGate()
        XCTAssertTrue(gate.decide(transcript: "Lens, look at this", conversationCoachEnabled: false).shouldRespond)
        XCTAssertFalse(gate.decide(transcript: "Lens", conversationCoachEnabled: false).shouldRespond)
        XCTAssertEqual(
            gate.decide(transcript: "Codex", conversationCoachEnabled: true),
            .ignore("bare Codex trigger armed")
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "Hey Codex, what window is open on my Mac?",
                conversationCoachEnabled: true
            ),
            .respond("explicit Codex address")
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "What window is open on my Mac?",
                conversationCoachEnabled: true
            ),
            .respond("explicit information request")
        )
        XCTAssertEqual(
            gate.decide(transcript: "Codex, take a pic", conversationCoachEnabled: true),
            .respond("explicit visual action")
        )
    }

    func testRayBanCodexTranscriptionVariantsAreHardWakeWords() {
        var gate = AddressedSpeechGate()
        let variants = [
            "Codex, explain that",
            "Code X, explain that",
            "Codec, explain that",
        ]

        for variant in variants {
            XCTAssertEqual(
                gate.decide(transcript: variant, conversationCoachEnabled: true),
                .respond("explicit Codex address"),
                variant
            )
        }
    }

    func testBareCodexTranscriptionVariantsWaitForTheRequest() {
        var gate = AddressedSpeechGate()
        let variants = ["Codex", "Codec", "Code X", "Hey Codex"]

        for variant in variants {
            XCTAssertEqual(
                gate.decide(transcript: variant, conversationCoachEnabled: true),
                .ignore("bare Codex trigger armed"),
                variant
            )
        }
    }

    func testBareCodexSilentlyArmsExactlyOneCompletedRequest() {
        var gate = AddressedSpeechGate(codexTriggerWindow: 12)
        let start = Date(timeIntervalSince1970: 1_000)

        XCTAssertEqual(
            gate.decide(
                transcript: "Codex",
                conversationCoachEnabled: true,
                now: start
            ),
            .ignore("bare Codex trigger armed")
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "Take a pic",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(3)
            ),
            .respond("explicit visual action")
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "Take a pic",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(4)
            ),
            .ignore("short unaddressed visual command")
        )
    }

    func testCodexTriggerWaitsThroughIncompleteFragmentsAndExpires() {
        var gate = AddressedSpeechGate(codexTriggerWindow: 12)
        let start = Date(timeIntervalSince1970: 1_000)

        _ = gate.decide(
            transcript: "Code X",
            conversationCoachEnabled: true,
            now: start
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "Can you...",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(3)
            ),
            .ignore("incomplete request fragment")
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "tell me the time",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(6)
            ),
            .respond("explicit Codex address")
        )

        _ = gate.decide(
            transcript: "Codex",
            conversationCoachEnabled: true,
            now: start.addingTimeInterval(20)
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "Take a pic",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(33)
            ),
            .ignore("short unaddressed visual command")
        )
    }

    func testClearRequestsDoNotNeedWakeWord() {
        var gate = AddressedSpeechGate()
        XCTAssertTrue(gate.decide(transcript: "Read this screen", conversationCoachEnabled: false).shouldRespond)
        XCTAssertTrue(gate.decide(transcript: "What am I looking at?", conversationCoachEnabled: false).shouldRespond)
        XCTAssertTrue(gate.decide(transcript: "Can you fact check that?", conversationCoachEnabled: false).shouldRespond)
        XCTAssertTrue(gate.decide(transcript: "Could you look over here", conversationCoachEnabled: true).shouldRespond)
    }

    func testShortVisualCommandsNeedCodexDuringAmbientConversation() {
        var gate = AddressedSpeechGate(followUpWindow: 45)
        let start = Date(timeIntervalSince1970: 1_000)

        for transcript in ["Take a pic", "Snap that photo", "Look at this"] {
            XCTAssertEqual(
                gate.decide(
                    transcript: transcript,
                    conversationCoachEnabled: true,
                    now: start
                ),
                .ignore("short unaddressed visual command"),
                transcript
            )
        }
        XCTAssertEqual(
            gate.decide(
                transcript: "Codex, take a pic",
                conversationCoachEnabled: true,
                now: start
            ),
            .respond("explicit visual action")
        )

        gate.noteAssistantResponse(at: start)
        XCTAssertEqual(
            gate.decide(
                transcript: "Look at this",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(10)
            ),
            .respond("explicit visual action")
        )
    }

    func testIncompleteRequestFragmentsNeverInterruptTheWearer() {
        var gate = AddressedSpeechGate()
        let fragments = [
            "Can you...",
            "Could you",
            "Can you please...",
            "Could you just...",
            "Could you go ahead and...",
            "What do you...",
            "What I need you to...",
            "I need you to...",
            "I need you to just...",
            "I'd like you to...",
            "I was wondering if you could...",
            "Codex, can you please...",
            "Hey Codex, I need you to just...",
        ]

        for fragment in fragments {
            XCTAssertEqual(
                gate.decide(transcript: fragment, conversationCoachEnabled: true),
                .ignore("incomplete request fragment"),
                fragment
            )
        }

        XCTAssertTrue(
            gate.decide(
                transcript: "Can you check what is open on my computer?",
                conversationCoachEnabled: true
            ).requiresCoachEvaluation
        )
    }

    func testExplicitVisualRequestsRequireDeterministicCapture() {
        var gate = AddressedSpeechGate()
        let visualRequests = [
            "Codex, take a pic",
            "Codex, snap that photo",
            "Could you look over here",
            "Codex, read this screen",
            "Codex, what do you see?",
            "Now I want you to take a picture",
            "Go ahead and take another photo",
            "I need you to read this screen",
            "Codex, take a pick",
            "Codex, now take the pick again",
        ]

        for transcript in visualRequests {
            let decision = gate.decide(
                transcript: transcript,
                conversationCoachEnabled: true
            )
            XCTAssertEqual(decision, .respond("explicit visual action"), transcript)
            XCTAssertTrue(decision.requiresForcedVisualCapture, transcript)
        }

        XCTAssertFalse(
            gate.decide(
                transcript: "Help me with this argument",
                conversationCoachEnabled: true
            ).requiresForcedVisualCapture
        )
        XCTAssertFalse(
            gate.decide(
                transcript: "Take your pick",
                conversationCoachEnabled: true
            ).requiresForcedVisualCapture
        )
    }

    func testAmbientStatementIsIgnoredInDirectMode() {
        var gate = AddressedSpeechGate()
        XCTAssertFalse(gate.decide(transcript: "I went to the store yesterday and bought milk", conversationCoachEnabled: false).shouldRespond)
    }

    func testShortFollowUpWithinWindowResponds() {
        var gate = AddressedSpeechGate(followUpWindow: 45)
        let start = Date(timeIntervalSince1970: 1_000)
        gate.noteAssistantResponse(at: start)
        XCTAssertTrue(gate.decide(transcript: "Do that too", conversationCoachEnabled: false, now: start.addingTimeInterval(20)).shouldRespond)
        XCTAssertFalse(gate.decide(transcript: "That happened a long time ago", conversationCoachEnabled: false, now: start.addingTimeInterval(60)).shouldRespond)
    }

    func testDefaultFollowUpWindowKeepsImmediateFollowUpsButReleasesAmbientConversation() {
        var gate = AddressedSpeechGate()
        let start = Date(timeIntervalSince1970: 1_000)
        gate.noteAssistantResponse(at: start)

        XCTAssertEqual(
            gate.decide(
                transcript: "What window is open on my Mac?",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(30)
            ),
            .respond("explicit information request")
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "Can you explain that another way?",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(30)
            ),
            .respond("active assistant request")
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "Can you explain that another way?",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(60)
            ),
            .evaluate("possible direct assistant request")
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "Codex, can you explain that another way?",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(60)
            ),
            .respond("explicit Codex address")
        )
    }

    func testActiveAssistantQuestionsBypassSilentCoachClassifier() {
        var gate = AddressedSpeechGate(followUpWindow: 120)
        let start = Date(timeIntervalSince1970: 1_000)
        gate.noteAssistantResponse(at: start)

        XCTAssertEqual(
            gate.decide(
                transcript: "Why did that happen?",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(60)
            ),
            .respond("active assistant question")
        )
    }

    func testCommonInformationRequestsSurviveMissingCodexTranscription() {
        var gate = AddressedSpeechGate()
        let requests = [
            "What time is it?",
            "What day is it?",
            "What window is open on my Mac?",
        ]

        for request in requests {
            XCTAssertEqual(
                gate.decide(transcript: request, conversationCoachEnabled: true),
                .respond("explicit information request"),
                request
            )
        }
    }

    func testFollowUpWindowDoesNotForwardArbitraryShortConversation() {
        var gate = AddressedSpeechGate(followUpWindow: 45)
        let start = Date(timeIntervalSince1970: 1_000)
        gate.noteAssistantResponse(at: start)
        XCTAssertFalse(gate.decide(
            transcript: "That happened a long time ago",
            conversationCoachEnabled: false,
            now: start.addingTimeInterval(20)
        ).shouldRespond)
    }

    func testExplicitTextConfirmationIsAcceptedOnlyDuringAssistantFollowUp() {
        var gate = AddressedSpeechGate(followUpWindow: 45)
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(gate.decide(
            transcript: "Confirm text",
            conversationCoachEnabled: true,
            now: start
        ).shouldRespond)
        gate.noteAssistantResponse(at: start)
        XCTAssertTrue(gate.decide(
            transcript: "Confirm text",
            conversationCoachEnabled: true,
            now: start.addingTimeInterval(10)
        ).shouldRespond)
        XCTAssertFalse(gate.decide(
            transcript: "Send it",
            conversationCoachEnabled: true,
            now: start.addingTimeInterval(10)
        ).shouldRespond)
    }

    func testCoachIgnoresCasualChatterAndOpinions() {
        var gate = AddressedSpeechGate()
        XCTAssertFalse(gate.decide(transcript: "Yeah dude for real", conversationCoachEnabled: true).shouldRespond)
        XCTAssertFalse(gate.decide(transcript: "Yeah dude they're stupid", conversationCoachEnabled: true).shouldRespond)
        XCTAssertTrue(gate.decide(
            transcript: "What did you do yesterday?",
            conversationCoachEnabled: true
        ).requiresCoachEvaluation)
    }

    func testCoachEvaluatesFactualAndDebateCandidates() {
        var gate = AddressedSpeechGate()
        let candidates = [
            "The moon landing happened in 1972",
            "That is not true because the evidence proves the opposite",
            "What year did the moon landing happen?",
            "Earth is flat",
            "Portland is the capital of Oregon",
        ]
        for transcript in candidates {
            XCTAssertTrue(
                gate.decide(
                    transcript: transcript,
                    conversationCoachEnabled: true
                ).requiresCoachEvaluation,
                transcript
            )
        }
    }

    func testGeneralNoWakeWordRequestIsEvaluatedInsteadOfDiscarded() {
        var gate = AddressedSpeechGate()
        XCTAssertEqual(
            gate.decide(
                transcript: "What window is open on my Mac?",
                conversationCoachEnabled: true
            ),
            .respond("explicit information request")
        )
        XCTAssertEqual(
            gate.decide(
                transcript: "Bring Visual Studio Code to the front",
                conversationCoachEnabled: true
            ),
            .evaluate("possible direct assistant request")
        )
    }

    func testAmbientTextingPhraseRequiresIntentEvaluation() {
        var gate = AddressedSpeechGate()

        XCTAssertEqual(
            gate.decide(
                transcript: "Text me when you arrive",
                conversationCoachEnabled: true
            ),
            .evaluate("possible direct assistant request")
        )
    }

    func testAmbiguousHumanRelayRequestsStaySilentInCoachMode() {
        var gate = AddressedSpeechGate()
        let humanRelayRequests = [
            "Can you tell him Redrum?",
            "Tell her I'll call later",
            "Could you ask them about dinner?",
            "Let him know we are leaving",
        ]

        for transcript in humanRelayRequests {
            XCTAssertEqual(
                gate.decide(
                    transcript: transcript,
                    conversationCoachEnabled: true
                ),
                .ignore("ambiguous human relay"),
                transcript
            )
        }

        XCTAssertEqual(
            gate.decide(
                transcript: "Text John on iMessage that I'll call later",
                conversationCoachEnabled: true
            ),
            .evaluate("possible direct assistant request")
        )
    }

    func testEmbeddedHumanConversationIsNeverTreatedAsADirectCommand() {
        var gate = AddressedSpeechGate()
        let transcripts = [
            "She told me to look at the apartment tomorrow",
            "The store is open today after all",
            "I asked him to tell me what happened",
            "Can you pick up milk on your way home?",
        ]
        for transcript in transcripts {
            let decision = gate.decide(
                transcript: transcript,
                conversationCoachEnabled: true
            )
            XCTAssertFalse(decision.shouldRespond, transcript)
        }
    }

    func testConversationEndingsStaySilentAndCloseContext() {
        var gate = AddressedSpeechGate()
        XCTAssertEqual(
            gate.decide(transcript: "Okay, bye. Talk to you later", conversationCoachEnabled: true),
            .ignore("conversation ending")
        )
        XCTAssertEqual(
            gate.decide(transcript: "I have to go now", conversationCoachEnabled: true),
            .ignore("conversation ending")
        )
        XCTAssertEqual(
            gate.decide(transcript: "It was nice talking to you", conversationCoachEnabled: true),
            .ignore("conversation ending")
        )
    }

    func testConversationEndingClearsAssistantFollowUpWindow() {
        var gate = AddressedSpeechGate(followUpWindow: 45)
        let start = Date(timeIntervalSince1970: 1_000)
        gate.noteAssistantResponse(at: start)
        XCTAssertTrue(gate.decide(
            transcript: "Do that too",
            conversationCoachEnabled: true,
            now: start.addingTimeInterval(10)
        ).shouldRespond)

        XCTAssertEqual(
            gate.decide(
                transcript: "Okay, have a good one",
                conversationCoachEnabled: true,
                now: start.addingTimeInterval(15)
            ),
            .ignore("conversation ending")
        )
        XCTAssertFalse(gate.decide(
            transcript: "Do that too",
            conversationCoachEnabled: true,
            now: start.addingTimeInterval(20)
        ).shouldRespond)
    }

    func testCoachDecisionSeparatesDirectRequestFromAmbientInterjection() {
        let direct = CoachAttentionResult.decode(
            argumentsString: #"{"sourceItemId":"item-1","disposition":"direct_request","reason":"clearly asks the assistant","spokenResponse":"classifier must not answer"}"#,
            expectedSourceItemID: "item-1"
        )
        XCTAssertEqual(direct?.disposition, .directRequest)
        XCTAssertEqual(direct?.spokenResponse, "")

        let ambient = CoachAttentionResult.decode(
            argumentsString: #"{"sourceItemId":"item-2","disposition":"coach_interjection","reason":"material factual correction","spokenResponse":"The Apollo 11 landing was in 1969, not 1972."}"#,
            expectedSourceItemID: "item-2"
        )
        XCTAssertEqual(ambient?.disposition, .coachInterjection)
        XCTAssertEqual(ambient?.spokenResponse, "The Apollo 11 landing was in 1969, not 1972.")
    }

    func testCoachClassifierPolicyTreatsDebateCorrectionAsCoreBehavior() {
        let policy = CoachAttentionPolicy.classifierInstructions
        XCTAssertTrue(policy.contains("Proactive debate and fact-check help is a core function"))
        XCTAssertTrue(policy.contains("A direct request is not required"))
        XCTAssertTrue(policy.contains("Apollo 11 landed on the Moon in 1969, not 1972"))
        XCTAssertTrue(policy.contains("It must not be classified silent"))
        XCTAssertTrue(policy.contains("Can you tell him Redrum?"))
        XCTAssertTrue(policy.contains("MUST be silent"))
        XCTAssertTrue(policy.contains("do not assume every “you” means the assistant"))
        XCTAssertTrue(policy.contains("incomplete fragment into direct_request"))
        XCTAssertTrue(policy.contains("generic readiness phrase"))
    }

    func testConversationAudioPolicyUsesNearFieldAndSupportedTranscription() {
        XCTAssertEqual(ConversationAudioPolicy.noiseReductionType, "near_field")
        XCTAssertEqual(
            ConversationAudioPolicy.transcriptionModel,
            "gpt-4o-mini-transcribe"
        )
        XCTAssertEqual(
            ConversationAudioPolicy.preferredDiarizationModel,
            "gpt-4o-transcribe-diarize"
        )
        XCTAssertFalse(ConversationAudioPolicy.diarizationAvailable)
    }

    func testCoachContextPreservesAnonymousSpeakerTurns() {
        let rendered = CoachTranscriptContext.render(
            segments: [
                CoachTranscriptSegment(id: "2", speaker: "B", text: "No, it was 1972.", start: 2),
                CoachTranscriptSegment(id: "1", speaker: "A", text: "I think it was 1969.", start: 1),
            ],
            fallback: "unused"
        )
        XCTAssertEqual(
            rendered,
            "[Speaker A] I think it was 1969.\n[Speaker B] No, it was 1972."
        )
        XCTAssertFalse(CoachAttentionPolicy.classifierInstructions.contains("identifies the wearer"))
        XCTAssertTrue(CoachAttentionPolicy.classifierInstructions.contains("does not identify the wearer"))
    }

    func testCoachContextFallsBackWhenNoDiarizedSegmentsArrive() {
        XCTAssertEqual(
            CoachTranscriptContext.render(segments: [], fallback: "  ordinary transcript  "),
            "ordinary transcript"
        )
    }

    func testCoachDecisionFailsClosedAndCapsSpeechAtTwentyFiveWords() {
        XCTAssertNil(CoachAttentionResult.decode(
            argumentsString: #"{"sourceItemId":"wrong","disposition":"direct_request","reason":"","spokenResponse":""}"#,
            expectedSourceItemID: "expected"
        ))
        XCTAssertNil(CoachAttentionResult.decode(
            argumentsString: #"{"sourceItemId":"item-1","disposition":"coach_interjection","reason":"","spokenResponse":""}"#,
            expectedSourceItemID: "item-1"
        ))

        let longWords = (1...30).map { "word\($0)" }.joined(separator: " ")
        let encoded = #"{"sourceItemId":"item-1","disposition":"coach_interjection","reason":"useful","spokenResponse":"\#(longWords)"}"#
        let result = CoachAttentionResult.decode(
            argumentsString: encoded,
            expectedSourceItemID: "item-1"
        )
        XCTAssertEqual(result?.spokenResponse.split(separator: " ").count, 25)
    }
}
