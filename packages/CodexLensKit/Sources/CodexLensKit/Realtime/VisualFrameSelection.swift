import Foundation

/// Device-independent measurements produced for one glasses photo. The app
/// computes these from the original in-memory JPEG before metadata stripping
/// and compression; this type keeps the ranking policy deterministic and
/// headlessly testable.
public struct VisualFrameQuality: Equatable, Sendable {
    public let recognizedCharacterCount: Int
    public let recognizedLineCount: Int
    public let averageTextConfidence: Double
    public let normalizedSharpness: Double
    public let pixelCount: Int
    public let encodedByteCount: Int

    public init(
        recognizedCharacterCount: Int,
        recognizedLineCount: Int,
        averageTextConfidence: Double,
        normalizedSharpness: Double,
        pixelCount: Int,
        encodedByteCount: Int
    ) {
        self.recognizedCharacterCount = max(0, recognizedCharacterCount)
        self.recognizedLineCount = max(0, recognizedLineCount)
        self.averageTextConfidence = min(max(averageTextConfidence, 0), 1)
        self.normalizedSharpness = min(max(normalizedSharpness, 0), 1)
        self.pixelCount = max(0, pixelCount)
        self.encodedByteCount = max(0, encodedByteCount)
    }
}

public enum VisualFrameSelector {
    /// Scores text evidence first and visual edge detail second. JPEG byte size
    /// is deliberately not part of the score: noisy or badly compressed frames
    /// can be larger than a readable frame.
    public static func score(_ quality: VisualFrameQuality) -> Double {
        let characterCoverage = min(Double(quality.recognizedCharacterCount) / 240, 1)
        let lineCoverage = min(Double(quality.recognizedLineCount) / 14, 1)
        let sharpness = min(quality.normalizedSharpness / 0.10, 1)

        // Vision occasionally returns a few low-confidence characters from an
        // object edge. Require a small credible text signal before letting OCR
        // dominate the general sharpness measurement.
        let hasCredibleText = quality.recognizedCharacterCount >= 4
            && quality.recognizedLineCount >= 1
            && quality.averageTextConfidence >= 0.30

        if hasCredibleText {
            return 1_000
                + (characterCoverage * 520)
                + (lineCoverage * 180)
                + (quality.averageTextConfidence * 240)
                + (sharpness * 60)
        }

        return sharpness * 100
    }

    public static func bestIndex(in qualities: [VisualFrameQuality]) -> Int? {
        guard !qualities.isEmpty else { return nil }
        return qualities.indices.max { lhs, rhs in
            let lhsScore = score(qualities[lhs])
            let rhsScore = score(qualities[rhs])
            if lhsScore != rhsScore { return lhsScore < rhsScore }

            // Pixel count is a useful deterministic tie breaker if a future
            // camera profile mixes resolutions. Keep encoded bytes last and
            // prefer the earlier capture on a complete tie.
            if qualities[lhs].pixelCount != qualities[rhs].pixelCount {
                return qualities[lhs].pixelCount < qualities[rhs].pixelCount
            }
            if qualities[lhs].encodedByteCount != qualities[rhs].encodedByteCount {
                return qualities[lhs].encodedByteCount < qualities[rhs].encodedByteCount
            }
            return lhs > rhs
        }
    }
}

public enum VisualCaptureMode: String, Equatable, Sendable {
    case fast
    case read
    case careful
}

public struct VisualCapturePlan: Equatable, Sendable {
    public let mode: VisualCaptureMode
    public let frameCount: Int

    public init(mode: VisualCaptureMode, frameCount: Int) {
        self.mode = mode
        self.frameCount = frameCount
    }
}

public enum VisualCapturePlanner {
    /// An ordinary spoken photo/look request gets one fast frame. Explicit
    /// text-reading requests use high-resolution OCR candidates, and a
    /// deliberate careful pass remains bounded to three.
    public static func plan(request: String, requestedMode: String?) -> VisualCapturePlan {
        let normalizedRequest = request.lowercased()
        let words = Set(
            normalizedRequest
                .components(separatedBy: CharacterSet.alphanumerics.inverted)
                .filter { !$0.isEmpty }
        )
        let explicitlyQuick = !words.isDisjoint(with: ["quick", "quickly", "fast"])
        // Match complete words. Substring matching made the assistant name
        // "Codex" contain "code", routing every addressed photo request into
        // the slower multi-frame reading path.
        // Natural reading requests need not contain the literal word "read".
        // Keep this narrow: "tell me what you see" is still a fast look, and
        // "what did he say" is not a request for camera OCR.
        let normalizedPhrase = normalizedRequest
            .replacingOccurrences(of: "’", with: "'")
        let asksWhatIsWritten = normalizedPhrase.range(
            of: #"\bwhat\s+(?:does|do)\s+(?:this|that|these|those|it)\s+say\b|\bwhat(?:\s+is|'s)\s+(?:written|printed)\b"#,
            options: .regularExpression
        ) != nil
        let explicitlyReadingText = asksWhatIsWritten || !words.isDisjoint(with: [
            "read", "text", "screen", "code", "document", "documents",
            "page", "pages", "sign", "signs",
        ])

        if requestedMode == VisualCaptureMode.careful.rawValue {
            return VisualCapturePlan(mode: .careful, frameCount: 3)
        }
        if explicitlyReadingText {
            if requestedMode == VisualCaptureMode.fast.rawValue, explicitlyQuick {
                return VisualCapturePlan(mode: .fast, frameCount: 1)
            }
            return VisualCapturePlan(mode: .read, frameCount: 2)
        }
        return VisualCapturePlan(mode: .fast, frameCount: 1)
    }
}
