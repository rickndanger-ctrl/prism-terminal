#!/usr/bin/env python3
"""One-time public model download. Runtime worker never downloads anything."""
from pathlib import Path
import hashlib
import urllib.request
from worker import ASSETS

root = Path(__file__).resolve().parent / 'models'
root.mkdir(exist_ok=True)
for name, expected in ASSETS.items():
    path = root / name
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        print(f'{name}: verified')
        continue
    temporary = path.with_suffix(path.suffix + '.download')
    url = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/' + name
    try:
        urllib.request.urlretrieve(url, temporary)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Model download failed integrity verification')
        temporary.replace(path)
        print(f'{name}: downloaded and verified')
    finally:
        temporary.unlink(missing_ok=True)
