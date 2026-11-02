import asyncio
import unittest

import numpy as np
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from gemini_webrtc_bridge import GeminiWebRTCBridge, PCMOutputTrack


class OutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_pcm_is_paced_and_clear_discards_queued_audio(self):
        track = PCMOutputTrack()
        track.push(b"\x01\x00" * 960)
        frame = await track.recv()
        self.assertEqual((frame.sample_rate, frame.samples, frame.pts), (24000, 480, 0))
        self.assertEqual(track.queued_bytes, 960)
        track.clear()
        frame = await track.recv()
        self.assertFalse(np.any(frame.to_ndarray()))
        track.stop()
        with self.assertRaises(ValueError):
            track.push(b"\0\0")

    async def test_invalid_or_unbounded_pcm_is_rejected_without_queue_growth(self):
        track = PCMOutputTrack()
        for value in [b"", b"x", "not bytes", b"\0" * (track.MAX_BYTES + 2)]:
            with self.assertRaises(ValueError):
                track.push(value)
            self.assertEqual(track.queued_bytes, 0)
        track.stop()


class PeerTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_local_peer_audio_both_directions_and_ordered_control(self):
        # Synthetic constant-amplitude signal, not a microphone or user recording.
        incoming = asyncio.Event()
        returned = asyncio.Event()
        controls = []
        replies = []
        frame_lengths = []

        def on_pcm(pcm):
            frame_lengths.append(len(pcm))
            if np.max(np.abs(np.frombuffer(pcm, dtype="<i2").astype(np.int32))) > 100:
                incoming.set()

        bridge = GeminiWebRTCBridge(on_pcm, controls.append, lambda _state: None)
        phone = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        input_track = PCMOutputTrack()
        phone.addTrack(input_track)
        channel = phone.createDataChannel("lens-control", ordered=True)
        channel.on("message", replies.append)
        tasks = []

        @phone.on("track")
        def received(track):
            async def read():
                while True:
                    frame = await track.recv()
                    if np.max(np.abs(frame.to_ndarray().astype(np.int32))) > 100:
                        returned.set()
            tasks.append(asyncio.create_task(read()))

        try:
            await phone.setLocalDescription(await phone.createOffer())
            answer = await bridge.answer(phone.localDescription.sdp)
            await phone.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
            async with asyncio.timeout(10):
                while phone.connectionState != "connected" or channel.readyState != "open":
                    await asyncio.sleep(0.02)
            tone = (np.sin(np.arange(24000) * 2 * np.pi * 440 / 24000) * 6000).astype("<i2").tobytes()
            input_track.push(tone)
            bridge.send_pcm(tone)
            channel.send('first'); channel.send('second')
            bridge.send_control('ack')
            await asyncio.wait_for(incoming.wait(), 5)
            await asyncio.wait_for(returned.wait(), 5)
            async with asyncio.timeout(5):
                while len(controls) != 2 or replies != ['ack']:
                    await asyncio.sleep(0.02)
            self.assertEqual(controls, ['first', 'second'])
            self.assertTrue(all(length > 0 and length % 2 == 0 and length <= 32000 for length in frame_lengths))
            with self.assertRaises(ValueError):
                await bridge.answer(phone.localDescription.sdp)
            bridge.clear_audio()
            self.assertEqual(bridge.output.queued_bytes, 0)
        finally:
            await bridge.close()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await phone.close()
        self.assertTrue(bridge.closed)
        with self.assertRaises(ValueError):
            bridge.send_pcm(b"\0\0")

    async def test_invalid_offer_does_not_start_a_session(self):
        states = []
        bridge = GeminiWebRTCBridge(lambda _: None, lambda _: None, states.append)
        try:
            with self.assertRaises(ValueError):
                await bridge.answer('not SDP')
            with self.assertRaises(ValueError):
                bridge.send_control('not connected')
        finally:
            await bridge.close()
        self.assertTrue(bridge.closed_event.is_set())
        self.assertEqual(states, ["closed"])


if __name__ == '__main__':
    unittest.main()
