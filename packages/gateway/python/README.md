# Gemini WebRTC audio bridge

This is the Mac-side audio component, not a runnable authenticated service yet.
It does not open a local microphone, camera, HTTP listener, or Google connection.
The host provides the authorized SDP offer and callbacks for 16kHz input PCM,
untrusted data-channel messages, and connection state. Google output is supplied
as 24kHz PCM. WebRTC continues to own the phone's capture and playback path.

`on_control` must synchronously enqueue bounded host work, preserving arrival
order. It must not execute a command directly. Audio/state callbacks may return
awaitables, with a two-second deadline. Slow/failing consumers close the peer.
The output queue is capped at thirty seconds; close clears it and cancels input.
Clearing unsent PCM cannot retract RTP packets already transmitted to the phone.
The phone adapter still needs an explicit playback-stop implementation.

From the repository root, prepare an isolated Python environment when deploying
this component (the development tests used an existing experimental environment):

```sh
python3 -m venv packages/gateway/python/.venv
packages/gateway/python/.venv/bin/python -m pip install -r packages/gateway/python/requirements.txt
packages/gateway/python/.venv/bin/python -B -m unittest discover -s packages/gateway/python -p 'test_gemini*.py' -v
```

The seven tests include two real local WebRTC peers exchanging synthetic audio in
both directions plus ordered data-channel messages, and real subprocess signaling,
PCM transfer, malformed-input rejection, and EOF shutdown. They use no external API.
The optional `scripts/probe-gemini-webrtc.py` does call Google, reads the dedicated
Gemini Keychain entry, and consumes API quota. It generates its own speech fixture
and uses this bridge class; it never reads a microphone or user recording.

`gemini_bridge_process.py` exposes private JSON-lines IPC to its parent, with
bounded frames/queues and no listener. The TypeScript `GeminiBridgeProcess`
supervisor starts it without a shell or inherited API-key environment, validates
responses, caps the startup wait, and kills only its own child if graceful close
does not finish within two seconds. It never respawns or replays an offer.

Still required before phone deployment: compose the supervisor with authenticated
signaling and the TypeScript Gemini connection, explicit addressed-speech policy,
phone event translation, session recovery, and physical acceptance. Do not route
the installed app to this component until those paths exist and are tested.
