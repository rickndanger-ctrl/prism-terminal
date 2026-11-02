/// Classifies server transcript deltas without coupling the unit-tested policy
/// to the app target's WebRTC transport.
public enum RealtimeReadbackEventPolicy {
    public static func isAssistantTranscriptDelta(_ eventType: String) -> Bool {
        eventType == "response.output_audio_transcript.delta"
            || eventType == "response.output_text.delta"
    }

    /// Only an audio transcript proves that the assistant generated speech.
    /// Text-only output may be displayed, but it cannot arm an audio confirmation.
    public static func isSpokenTranscriptDelta(_ eventType: String) -> Bool {
        eventType == "response.output_audio_transcript.delta"
    }

    /// A partial, failed, or cancelled response cannot arm a consequential
    /// action even when it happened to emit the complete transcript first.
    public static func isEligibleCompletedSpokenResponse(
        status: String,
        hadSpokenOutput: Bool,
        containedToolCall: Bool
    ) -> Bool {
        status == "completed" && hadSpokenOutput && !containedToolCall
    }
}
