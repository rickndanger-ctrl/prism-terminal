"""Local-only choice adapter; no execution, network inference, or transcript logs.

Optional adapter for an operator-provided, verified Clef runtime.
Set CODEX_LENS_CLEF_HOME on that host; models and runtime are not bundled.
"""
import importlib.util
import importlib.metadata
import json
import os
from pathlib import Path
import sys

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
runtime_home = os.environ.get('CODEX_LENS_CLEF_HOME')
if not runtime_home:
    raise SystemExit('Configure CODEX_LENS_CLEF_HOME before using this optional adapter.')
base = Path(runtime_home).expanduser().resolve()
spec = importlib.util.spec_from_file_location('verified_clef', base / 'runtime/clef_action_helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
ACTIONS = {
    'open': 'Open or focus a named Mac application.',
    'close': 'Close the current Mac window, without discarding unsaved changes.',
    'type': 'Write literal text into a new unsaved TextEdit document. Never send or execute it.',
    'search': 'Search the web for a query in the browser.',
    'ask': 'Conversation, negation, hypothetical or quoted instruction, unsupported or unclear task. Ask instead of acting.',
}
def load_model():
    # Separate adapter compatibility pin: Homebrew advanced 3.14.7 to 3.14.9.
    # Do not rewrite Zeus's manifest or weaken the model/dependency checks.
    assert sys.version_info[:3] == (3, 14, 9), 'Unsupported adapter Python'
    manifest_path = base / 'runtime/manifest.json'
    assert helper.sha256_file(manifest_path) == helper.EXPECTED_MANIFEST_SHA256
    manifest = json.loads(manifest_path.read_text())
    root = base / ('hf/hub/models--mlx-community--clef-flash-4bit/snapshots/' + helper.MODEL_REVISION)
    for name in manifest['model_files']:
        assert (root / name).is_file()
    for name, expected in manifest['sha256'].items():
        assert helper.sha256_file(root / name) == expected
    for name, expected in manifest['packages'].items():
        assert importlib.metadata.version(name) == expected
    sys.path.insert(0, str(root))
    model_spec = importlib.util.spec_from_file_location('clef_mlx', root / 'clef_mlx.py')
    module = importlib.util.module_from_spec(model_spec)
    sys.modules['clef_mlx'] = module
    model_spec.loader.exec_module(module)
    return module.load(str(root))

with helper.suppress_model_output():
    model = load_model()
print(json.dumps({'type': 'ready'}), flush=True)
while True:
    line = sys.stdin.buffer.readline(16385)
    if not line:
        break
    if len(line) > 16384 or not line.endswith(b'\n'):
        break
    request_id = None
    try:
        data = json.loads(line)
        request_id = data['id']
        assert isinstance(request_id, str) and len(request_id) <= 64
        assert set(data) == {'id', 'text'}
        assert isinstance(data['text'], str) and 0 < len(data['text']) <= 2000
        with helper.suppress_model_output():
            result = model.systemone({'model': 'clef-flash', 'truncate': False,
                'state': {'utterance': data['text']},
                'questions': {'action': {'type': 'choice',
                    'instructions': 'Select one available button only. Negated, quoted, hypothetical, ambiguous, or unsupported commands must select ask. This is a suggestion, not authorization.',
                    'criteria': ACTIONS}}}, truncate=False)
        choice = result['answers']['action']['choice']
        assert choice in ACTIONS
        print(json.dumps({'id': request_id, 'action': choice}), flush=True)
    except Exception:
        print(json.dumps({'id': request_id, 'error': 'CLEF_UNAVAILABLE'}), flush=True)
