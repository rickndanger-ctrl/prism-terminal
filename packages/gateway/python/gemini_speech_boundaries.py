"""Local 16kHz PCM speech boundaries. No transcription or attention decisions."""
from collections import deque


class SpeechBoundaries:
    FRAME_BYTES = 640  # 20 ms, mono, signed 16-bit little-endian at 16kHz.

    def __init__(self, speech_test=None):
        if speech_test is None:
            import webrtcvad
            detector = webrtcvad.Vad(1)
            speech_test = lambda frame: detector.is_speech(frame, 16000)
        self._speech_test = speech_test
        self._buffer = bytearray()
        self._prefix = deque(maxlen=15)  # Preserve the first syllable: 300ms pre-roll.
        self._votes = deque(maxlen=5)
        self._active = False
        self._silent_frames = 0
        self._active_frames = 0

    def feed(self, pcm):
        if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2 or len(pcm) > 32000:
            raise ValueError("Invalid speech-detector PCM")
        self._buffer.extend(pcm)
        events = []
        while len(self._buffer) >= self.FRAME_BYTES:
            frame = bytes(self._buffer[:self.FRAME_BYTES])
            del self._buffer[:self.FRAME_BYTES]
            voiced = bool(self._speech_test(frame))
            if not self._active:
                self._prefix.append(frame)
                self._votes.append(voiced)
                if len(self._votes) == 5 and sum(self._votes) >= 4:
                    self._active = True
                    self._active_frames = len(self._prefix)
                    self._silent_frames = 0
                    events.extend([("start", None), ("audio", b"".join(self._prefix))])
                    self._prefix.clear()
                    self._votes.clear()
                continue
            events.append(("audio", frame))
            self._active_frames += 1
            self._silent_frames = 0 if voiced else self._silent_frames + 1
            reason = "limit" if self._active_frames >= 3000 else "silence" if self._silent_frames >= 35 else None
            if reason:
                events.append(("end", reason))
                self._active = False
                self._silent_frames = self._active_frames = 0
                self._prefix.clear()
                self._votes.clear()
        return events

    def reset(self):
        # Closing/muting is not permission to generate a response.
        self._buffer.clear()
        self._prefix.clear()
        self._votes.clear()
        self._active = False
        self._silent_frames = self._active_frames = 0
