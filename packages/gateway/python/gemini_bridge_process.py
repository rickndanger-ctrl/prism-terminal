"""Private JSON-lines IPC for one gateway-owned WebRTC peer.

No listener, provider credentials, shell commands, or logging of message bodies.
The parent must authenticate signaling and supervise this process. EOF is stop.
"""
import asyncio
import base64
import json
import logging
import sys

from gemini_webrtc_bridge import GeminiWebRTCBridge
from gemini_speech_boundaries import SpeechBoundaries

MAX_LINE = 262144


async def run():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_LINE)
    read_transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    write_transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout.buffer)
    writer = asyncio.StreamWriter(write_transport, protocol, None, loop)
    output = asyncio.Queue(maxsize=128)
    failed = asyncio.Event()
    reason = None
    stopping = False
    detector = None

    def fail(category):
        nonlocal reason
        reason = reason or category
        failed.set()

    def emit(message):
        if failed.is_set():
            return
        line = (json.dumps(message, separators=(",", ":")) + "\n").encode()
        if len(line) > MAX_LINE:
            fail("output_limit")
            return
        try:
            output.put_nowait(line)
        except asyncio.QueueFull:
            fail("backpressure")

    def input_audio(pcm):
        events = detector.feed(pcm) if detector else [("audio", pcm)]
        for kind, value in events:
            if kind == "audio":
                emit({"type": "inputAudio", "pcm": base64.b64encode(value).decode()})
            elif kind == "start":
                emit({"type": "activityStart"})
            else:
                emit({"type": "activityEnd", "reason": value})

    bridge = GeminiWebRTCBridge(
        input_audio,
        lambda message: emit({"type": "control", "message": message}),
        lambda state: emit({"type": "state", "state": state}),
    )

    async def write_messages():
        while not stopping:
            line = await output.get()
            try:
                writer.write(line)
                async with asyncio.timeout(2):
                    await writer.drain()
            finally:
                output.task_done()

    async def read_commands():
        nonlocal detector
        offered = False
        while True:
            # An idle child must not linger if its parent never provides an offer.
            raw = await asyncio.wait_for(reader.readline(), 15 if not offered else 3600)
            if not raw:
                return
            if len(raw) > MAX_LINE or not raw.endswith(b"\n"):
                raise ValueError("Invalid IPC frame")
            command = json.loads(raw)
            if not isinstance(command, dict):
                raise ValueError("Invalid IPC object")
            kind = command.get("type")
            expected = {"offer": {"type", "sdp"}, "outputAudio": {"type", "pcm"},
                        "control": {"type", "message"}, "clearAudio": {"type"}, "close": {"type"}}
            offer_with_vad = kind == "offer" and set(command) == {"type", "sdp", "detectSpeech"} and isinstance(command["detectSpeech"], bool)
            if kind not in expected or (set(command) != expected[kind] and not offer_with_vad):
                raise ValueError("Invalid IPC command")
            if kind == "close":
                return
            if kind == "offer":
                if offered:
                    raise ValueError("Duplicate offer")
                offered = True
                if command.get("detectSpeech"):
                    detector = SpeechBoundaries()
                emit({"type": "answer", "sdp": await bridge.answer(command["sdp"])})
            elif not offered:
                raise ValueError("Offer required first")
            elif kind == "outputAudio":
                if not isinstance(command["pcm"], str):
                    raise ValueError("Invalid PCM")
                bridge.send_pcm(base64.b64decode(command["pcm"], validate=True))
            elif kind == "control":
                bridge.send_control(command["message"])
            elif kind == "clearAudio":
                bridge.clear_audio()

    write_task = asyncio.create_task(write_messages())
    read_task = asyncio.create_task(read_commands())
    failure_task = asyncio.create_task(failed.wait())
    closed_task = asyncio.create_task(bridge.closed_event.wait())
    tasks = [write_task, read_task, failure_task, closed_task]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if not task.cancelled() and task.exception() is not None:
                fail("ipc_failure")
        await bridge.close()
        if not failed.is_set():
            emit({"type": "closed"})
            await asyncio.wait_for(output.join(), 1)
    except Exception:
        fail("ipc_failure")
    finally:
        stopping = True
        if detector:
            detector.reset()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await bridge.close()
        read_transport.close()
        write_transport.close()
    return 1 if reason else 0


if __name__ == "__main__":
    # Third-party diagnostics can contain SDP/network details. The parent gets
    # structured state and a terminal exit status, never raw library logs.
    logging.disable(logging.CRITICAL)
    try:
        code = asyncio.run(run())
    except BaseException:
        code = 1
    raise SystemExit(code)
