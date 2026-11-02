# Prism local voice runtime

A small, offline Kokoro speech worker for Prism Terminal. It provides speech synthesis; Codex remains the conversation and tool engine. It is not a hosted GPT Realtime clone and does not call OpenAI, Hugging Face inference, or any other speech API.

## Runtime

- Python 3.12, kokoro-onnx 0.6.1, ONNX Runtime CPU provider with four inference threads.
- Kokoro v1.0 int8, 114,119,327 bytes; voice archive 28,214,398 bytes.
- Both assets are checked against the upstream release SHA-256 values at every startup.
- `af_heart`: American female voice; `am_michael`: American male voice.
- 24 kHz, mono, 16-bit PCM WAV; speed defaults to 1.0 at the gateway and must stay between 0.8 and 1.2.
- No listener or LaunchAgent. The gateway owns a persistent child process and terminates it to cancel work.
- No transcript logs. stdout is exclusively protocol JSON, including when a dependency tries to print.

## Installation

Run in this directory using the existing `uv` installation:

```sh
uv venv --python 3.12 .venv
uv pip install --no-cache --python .venv/bin/python -r requirements.lock
.venv/bin/python setup.py
.venv/bin/python -u worker.py
```

Keep `worker.py` beside `models/`. The gateway receives absolute paths to `.venv/bin/python` and `worker.py`; it does not use a shell or accept a user-supplied executable.

## Protocol

Startup emits:

```json
{"type":"ready","provider":"kokoro","voices":["af_heart","am_michael"],"sampleRate":24000}
```

Each request is exactly one JSON line:

```json
{"id":"request-uuid","text":"Prism is ready.","voice":"af_heart","speed":1.0}
```

Success is `{ "id": "request-uuid", "audioBase64": "...", "sampleRate": 24000, "format": "wav" }`. Failure is `{ "id": "request-uuid", "error": "FIXED_ERROR_CODE" }`. No error includes the submitted text. Startup failures emit `{"type":"error","error":"LOCAL_VOICE_STARTUP_FAILED"}` and exit with code 1.

Input is limited to 2,000 text characters, 128 safe ID characters, and 16,384 bytes per newline-delimited request. Output is bounded to 180 seconds. Oversized/incomplete protocol lines terminate the worker so a trailing fragment cannot become another request. Inference is sequential. Killing the process cancels the active request; nothing is replayed.

## Validation

`python3 -m unittest discover -s local-voice -p test_worker.py` (from the repository root) checks input bounds, voices, speed, protocol IDs and unknown keys without downloading or running a model. Model/audio smoke testing is separate and requires the optional local installation above. No recorded audio, model files, or machine-specific probe outputs are shipped.

Historical development measurements on an Apple M4 Mac (November 1, 2026): startup 1.793 seconds; female sample 8.273 seconds of audio generated in 1.247 seconds; male sample 8.757 seconds generated in 1.015 seconds. A historical run with macOS network access denied also passed for both voices (0.874-second startup; 1.455/0.997-second synthesis). Terminating active synthesis exited in 0.008 seconds. These are not a fresh verification of a public clone and cover local synthesis, not iPhone network or playback latency. Voice quality remains a listening judgment.

## Sources and licensing

- [kokoro-onnx official repository](https://github.com/thewh1teagle/kokoro-onnx): MIT implementation.
- [PyPI 0.6.1](https://pypi.org/project/kokoro-onnx/0.6.1/): pinned distribution.
- [Official ONNX model release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1): exact model/voice artifacts and checksums.
- [Kokoro-82M model card](https://huggingface.co/hexgrad/Kokoro-82M): Apache 2.0 weights.
- [Author's voice catalogue](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md): voice identities and estimated training-data quality. It rates Heart A and Michael C+; those grades do not guarantee a listener's preference.
