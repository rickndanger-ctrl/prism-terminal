#!/usr/bin/env python3
"""Offline Kokoro speech worker. stdin/stdout are a bounded NDJSON protocol.

The parent owns the worker lifetime. Terminating it cancels synthesis immediately.
No listener, API client, key lookup, download, or transcript logging is used here.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import math
import os
from pathlib import Path
import re
import sys
import wave

MAX_TEXT_CHARACTERS = 2_000
MAX_LINE_BYTES = 16_384
MAX_AUDIO_SECONDS = 180
VOICES = ("af_heart", "am_michael")
SAMPLE_RATE = 24_000
ASSETS = {
    "kokoro-v1.0.int8.onnx": "ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}


class InvalidRequest(ValueError):
    pass


def validate_request(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"id", "text", "voice", "speed"}:
        raise InvalidRequest("INVALID_REQUEST")
    identifier = value["id"]
    if not isinstance(identifier, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier) is None:
        raise InvalidRequest("INVALID_REQUEST_ID")
    text = value["text"]
    if (not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARACTERS
            or any(ord(c) < 32 and c not in "\n\r\t" for c in text)):
        raise InvalidRequest("INVALID_TEXT")
    if value["voice"] not in VOICES:
        raise InvalidRequest("INVALID_VOICE")
    speed = value["speed"]
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not 0.8 <= speed <= 1.2:
        raise InvalidRequest("INVALID_SPEED")
    return {"id": identifier, "text": text.strip(), "voice": value["voice"], "speed": float(speed)}


def safe_identifier(value: object) -> str | None:
    if isinstance(value, dict):
        candidate = value.get("id")
        if isinstance(candidate, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", candidate):
            return candidate
    return None


def load_engine():
    import onnxruntime as ort
    from kokoro_onnx import Kokoro

    root = Path(__file__).resolve().parent / "models"
    for name, expected in ASSETS.items():
        path = root / name
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError("MODEL_INTEGRITY_FAILED")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.log_severity_level = 4
    session = ort.InferenceSession(str(root / "kokoro-v1.0.int8.onnx"),
                                  sess_options=options, providers=["CPUExecutionProvider"])
    engine = Kokoro.from_session(session, str(root / "voices-v1.0.bin"))
    if any(voice not in engine.voices for voice in VOICES):
        raise ValueError("VOICE_ASSET_MISSING")
    return engine


def synthesize(engine, request: dict) -> dict:
    import numpy as np

    samples, sample_rate = engine.create(request["text"], voice=request["voice"],
                                         speed=request["speed"], lang="en-us")
    samples = np.asarray(samples).ravel()
    if (sample_rate != SAMPLE_RATE or not 0 < samples.size <= SAMPLE_RATE * MAX_AUDIO_SECONDS
            or not np.isfinite(samples).all()):
        raise ValueError("INVALID_AUDIO")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return {"id": request["id"], "audioBase64": base64.b64encode(output.getvalue()).decode("ascii"),
            "sampleRate": SAMPLE_RATE, "format": "wav"}


def run() -> int:
    # Keep stdout exclusively for our protocol even if a dependency prints via C.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
    with open(os.devnull, "w") as quiet:
        os.dup2(quiet.fileno(), sys.stdout.fileno())
    logging.disable(logging.CRITICAL)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"

    def emit(value):
        protocol.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
        protocol.flush()

    try:
        engine = load_engine()
    except Exception:
        emit({"type": "error", "error": "LOCAL_VOICE_STARTUP_FAILED"})
        return 1
    emit({"type": "ready", "provider": "kokoro", "voices": list(VOICES), "sampleRate": SAMPLE_RATE})
    try:
        while True:
            raw = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_LINE_BYTES or not raw.endswith(b"\n"):
                emit({"id": None, "error": "REQUEST_TOO_LARGE_OR_INCOMPLETE"})
                return 2  # Do not interpret an oversized line's tail as a new request.
            value = None
            try:
                value = json.loads(raw)
                request = validate_request(value)
            except (ValueError, TypeError, UnicodeDecodeError) as error:
                code = str(error) if isinstance(error, InvalidRequest) else "INVALID_JSON"
                emit({"id": safe_identifier(value), "error": code})
                continue
            try:
                emit(synthesize(engine, request))
            except Exception:
                # Never echo the transcript, phonemes, paths, or library exception.
                emit({"id": request["id"], "error": "LOCAL_VOICE_SYNTHESIS_FAILED"})
    finally:
        engine.voices.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
