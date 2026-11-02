import unittest

from gemini_speech_boundaries import SpeechBoundaries


class SpeechBoundariesTests(unittest.TestCase):
    quiet = b"\0" * 640
    voice = b"\1\0" * 320

    def detector(self):
        return SpeechBoundaries(lambda frame: frame == self.voice)

    def test_preserves_preroll_and_ends_after_silence(self):
        detector = self.detector()
        self.assertEqual(detector.feed(self.quiet * 10), [])
        events = detector.feed(self.voice * 4)
        self.assertEqual(events[0], ("start", None))
        self.assertEqual(events[1], ("audio", self.quiet * 10 + self.voice * 4))
        self.assertFalse(any(kind == "end" for kind, _ in detector.feed(self.quiet * 34)))
        self.assertEqual(detector.feed(self.quiet)[-1], ("end", "silence"))

    def test_short_noise_does_not_start(self):
        detector = self.detector()
        self.assertEqual(detector.feed(self.voice * 3 + self.quiet * 10), [])

    def test_partial_frames_and_reset_do_not_create_a_response(self):
        detector = self.detector()
        self.assertEqual(detector.feed(self.voice[:320]), [])
        self.assertEqual(detector.feed(self.voice[320:]), [])
        detector.reset()
        self.assertEqual(detector.feed(self.quiet * 10), [])

    def test_pause_inside_speech_is_not_an_end(self):
        detector = self.detector()
        detector.feed(self.voice * 5)
        detector.feed(self.quiet * 30)
        detector.feed(self.voice)
        self.assertFalse(any(kind == "end" for kind, _ in detector.feed(self.quiet * 34)))
        self.assertEqual(detector.feed(self.quiet)[-1], ("end", "silence"))

    def test_long_speech_is_bounded(self):
        detector = self.detector()
        ends = []
        for _ in range(60):
            ends.extend(event for event in detector.feed(self.voice * 50) if event[0] == "end")
        self.assertEqual(ends, [("end", "limit")])

    def test_invalid_pcm(self):
        for value in [None, "audio", b"", b"x", bytes(32002)]:
            with self.assertRaises(ValueError):
                self.detector().feed(value)

    def test_native_detector_accepts_silent_pcm(self):
        self.assertEqual(SpeechBoundaries().feed(self.quiet * 50), [])


if __name__ == "__main__":
    unittest.main()
