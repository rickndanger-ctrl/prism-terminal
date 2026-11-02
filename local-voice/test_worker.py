import unittest
from worker import InvalidRequest, validate_request, safe_identifier

class WorkerBoundaryTests(unittest.TestCase):
    def request(self, **changes):
        return {"id": "voice-123", "text": "Prism is ready.", "voice": "af_heart", "speed": 1.0, **changes}
    def test_both_voices_are_supported(self):
        for voice in ["af_heart", "am_michael"]:
            self.assertEqual(validate_request(self.request(voice=voice))["voice"], voice)
    def test_text_is_bounded_and_nonempty(self):
        for text in ["", "   ", "x" * 2001, "hello\x00world", 42]:
            with self.assertRaises(InvalidRequest): validate_request(self.request(text=text))
        self.assertEqual(len(validate_request(self.request(text="x" * 2000))["text"]), 2000)
    def test_protocol_injection_cannot_escape_identifier(self):
        for identifier in ["", 'x\n{"type":"ready"}', "x" * 129, None]:
            with self.assertRaises(InvalidRequest): validate_request(self.request(id=identifier))
            self.assertIsNone(safe_identifier(self.request(id=identifier)))
    def test_extra_fields_and_unknown_voices_rejected(self):
        for request in [self.request(voice="arbitrary"), self.request(url="https://example.com"), []]:
            with self.assertRaises(InvalidRequest): validate_request(request)
    def test_nonfinite_or_unbounded_speed_rejected(self):
        for speed in [float("nan"), float("inf"), True, 0.79, 1.21, "1"]:
            with self.assertRaises(InvalidRequest): validate_request(self.request(speed=speed))
    def test_whitespace_normalization_retains_meaning(self):
        self.assertEqual(validate_request(self.request(text="  Ready.\nNext task?  "))["text"], "Ready.\nNext task?")

if __name__ == "__main__": unittest.main()
