import asyncio
import json
from pathlib import Path
import sys
import unittest

from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from gemini_webrtc_bridge import PCMOutputTrack

ENTRY = Path(__file__).with_name("gemini_bridge_process.py")


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def spawn(self):
        process = await asyncio.create_subprocess_exec(sys.executable, "-B", str(ENTRY),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        async def cleanup():
            if process.returncode is None:
                process.kill()
                await process.wait()
        self.addAsyncCleanup(cleanup)
        return process

    async def test_eof_and_explicit_close_exit_cleanly(self):
        for message in [b"", b'{"type":"close"}\n']:
            process = await self.spawn()
            output, error = await asyncio.wait_for(process.communicate(message), 5)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(error, b"")
            self.assertIn({"type": "closed"}, [json.loads(line) for line in output.splitlines()])

    async def test_invalid_input_exits_without_echoing_private_data(self):
        for message in [b'{"type":"shell","private":"do-not-echo"}\n',
                        b'private-not-json\n', b'[]\n', b'{"type":"offer","sdp":"v=0\\r\\n"}\n',
                        b'x' * 262145 + b'\n']:
            process = await self.spawn()
            output, error = await asyncio.wait_for(process.communicate(message), 5)
            self.assertEqual(process.returncode, 1)
            self.assertNotIn(b"private", output + error)
            self.assertEqual(error, b"")

    async def test_offer_answer_and_audio_cross_process_boundary(self):
        process = await self.spawn()
        phone = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        phone.addTrack(PCMOutputTrack())
        try:
            await phone.setLocalDescription(await phone.createOffer())
            process.stdin.write((json.dumps({"type": "offer", "sdp": phone.localDescription.sdp}) + "\n").encode())
            await process.stdin.drain()
            async with asyncio.timeout(10):
                while True:
                    raw = await process.stdout.readline()
                    self.assertTrue(raw, "Bridge ended before SDP answer")
                    message = json.loads(raw)
                    if message["type"] == "answer":
                        await phone.setRemoteDescription(RTCSessionDescription(sdp=message["sdp"], type="answer"))
                        break
                while True:
                    raw = await process.stdout.readline()
                    self.assertTrue(raw, "Bridge ended before audio")
                    message = json.loads(raw)
                    if message["type"] == "inputAudio":
                        self.assertTrue(message["pcm"])
                        break
            process.stdin.write(b'{"type":"close"}\n')
            await process.stdin.drain()
            _, error = await asyncio.wait_for(process.communicate(), 5)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(error, b"")
        finally:
            await phone.close()
            if process.returncode is None:
                process.kill()
                await process.wait()


if __name__ == "__main__":
    unittest.main()
