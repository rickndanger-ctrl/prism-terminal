"""WebRTC audio leg for the Gemini gateway; no provider credentials or HTTP server.

The authenticated host owns signaling, attention policy, provider connections,
and tool permissions. This module never accesses a local microphone or camera.
"""
import asyncio
import fractions
import inspect
import time

from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from av import AudioFrame, AudioResampler


class PCMOutputTrack(AudioStreamTrack):
    """24kHz mono output paced in 20ms frames, with a bounded playback queue."""
    MAX_BYTES = 48000 * 30

    def __init__(self):
        super().__init__()
        self._buffer = bytearray()
        self._pts = 0
        self._started = None

    @property
    def queued_bytes(self):
        return len(self._buffer)

    def push(self, pcm):
        if self.readyState != "live" or not isinstance(pcm, bytes) or not pcm or len(pcm) % 2:
            raise ValueError("Invalid output PCM")
        if len(self._buffer) + len(pcm) > self.MAX_BYTES:
            raise ValueError("Output queue limit")
        self._buffer.extend(pcm)

    def clear(self):
        self._buffer.clear()

    def stop(self):
        self.clear()
        super().stop()

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        if self._started is None:
            self._started = time.monotonic()
        await asyncio.sleep(max(0, self._started + self._pts / 24000 - time.monotonic()))
        if self.readyState != "live":
            raise MediaStreamError
        chunk = bytes(self._buffer[:960])
        del self._buffer[:960]
        frame = AudioFrame(format="s16", layout="mono", samples=480)
        frame.planes[0].update(chunk.ljust(960, b"\0"))
        frame.sample_rate = 24000
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, 24000)
        self._pts += 480
        return frame


class GeminiWebRTCBridge:
    """One peer per authenticated session, no reconnect or automatic replay.

    on_pcm receives 16kHz mono PCM. on_control receives bounded data-channel
    strings as untrusted input, not executable instructions. on_control must be
    synchronous and only enqueue host work, preserving arrival order. Other
    callbacks can be async and are awaited with a two-second deadline.
    """
    def __init__(self, on_pcm, on_control, on_state):
        self.peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.output = PCMOutputTrack()
        self.peer.addTrack(self.output)
        self._on_pcm, self._on_control, self._on_state = on_pcm, on_control, on_state
        self._tasks = set()
        self._channel = None
        self._offered = False
        self._closed = False
        self._audio_seen = False
        self._closing_task = None
        self.closed_event = asyncio.Event()

        @self.peer.on("track")
        def incoming(track):
            if track.kind != "audio" or self._audio_seen:
                self._request_close()
                return
            self._audio_seen = True
            self._spawn(self._receive_audio(track))

        @self.peer.on("datachannel")
        def channel_opened(channel):
            if self._channel is not None or not channel.ordered:
                self._request_close()
                return
            self._channel = channel
            def ready():
                if not self._closed:
                    self._spawn(self._call(self._on_state, "controlReady"))
            if channel.readyState == "open":
                ready()
            else:
                channel.on("open", ready)

            @channel.on("message")
            def message(value):
                if self._closed:
                    return
                if not isinstance(value, str) or len(value.encode("utf-8")) > 65536:
                    self._request_close()
                    return
                try:
                    result = self._on_control(value)
                    if inspect.isawaitable(result):
                        if inspect.iscoroutine(result):
                            result.close()
                        raise ValueError("Control callback must enqueue synchronously")
                except Exception:
                    self._request_close()

        @self.peer.on("connectionstatechange")
        async def changed():
            if self._closed:
                return
            try:
                await self._call(self._on_state, self.peer.connectionState)
            finally:
                if self.peer.connectionState in ("failed", "closed"):
                    await self.close()

    @property
    def closed(self):
        return self._closed

    def _spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)

    def _request_close(self):
        if not self._closed and self._closing_task is None:
            self._closing_task = asyncio.create_task(self.close())

    def _task_done(self, task):
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None and not self._closed:
            self._request_close()

    async def _call(self, callback, value):
        result = callback(value)
        if inspect.isawaitable(result):
            await asyncio.wait_for(result, 2)

    async def _receive_audio(self, track):
        resampler = AudioResampler(format="s16", layout="mono", rate=16000)
        while not self._closed:
            frame = await track.recv()
            for converted in resampler.resample(frame):
                pcm = converted.to_ndarray().tobytes()
                if not pcm or len(pcm) > 32000 or len(pcm) % 2:
                    raise ValueError("Invalid input PCM")
                await self._call(self._on_pcm, pcm)

    async def answer(self, sdp):
        if self._closed or self._offered or not isinstance(sdp, str) or not sdp.startswith("v=0") or len(sdp.encode()) > 131072:
            raise ValueError("Invalid or duplicate offer")
        self._offered = True
        try:
            async with asyncio.timeout(15):
                await self.peer.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
                if not self._audio_seen:
                    raise ValueError("Audio offer required")
                await self.peer.setLocalDescription(await self.peer.createAnswer())
                return self.peer.localDescription.sdp
        except BaseException:
            await self.close()
            raise

    def send_control(self, message):
        if self._closed or self._channel is None or self._channel.readyState != "open":
            raise ValueError("Control channel unavailable")
        if not isinstance(message, str) or len(message.encode()) > 65536 or self._channel.bufferedAmount > 131072:
            raise ValueError("Invalid or backlogged control message")
        self._channel.send(message)

    def send_pcm(self, pcm):
        if self._closed:
            raise ValueError("Bridge closed")
        self.output.push(pcm)

    def clear_audio(self):
        # Clears only unsent PCM. The phone must also handle clearAudio to stop
        # already transmitted/decoded playback; this cannot retract RTP packets.
        self.output.clear()

    async def close(self):
        if self._closed:
            return
        self._closed = True
        self.output.stop()
        current = asyncio.current_task()
        pending = [task for task in self._tasks if task is not current]
        for task in pending:
            task.cancel()
        try:
            await asyncio.gather(*pending, return_exceptions=True)
            await self.peer.close()
        finally:
            try:
                await self._call(self._on_state, "closed")
            except Exception:
                pass  # Failure notifications cannot resurrect a closed peer.
            finally:
                self.closed_event.set()
