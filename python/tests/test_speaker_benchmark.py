from pathlib import Path
import importlib.util
import json
import math
import sys
import tempfile
import types
import unittest
import wave
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

stubbed_modules = {
    "sounddevice": {},
    "sherpa_onnx": {},
    "deep_translator": {
        "GoogleTranslator": type(
            "GoogleTranslator",
            (),
            {
                "__init__": lambda self, *args, **kwargs: None,
                "translate": lambda self, text: text,
            },
        ),
    },
    "opencc": {
        "OpenCC": type(
            "OpenCC",
            (),
            {
                "__init__": lambda self, *args, **kwargs: None,
                "convert": lambda self, text: text,
            },
        ),
    },
}

try:
    import numpy  # noqa: F401
except Exception:
    stubbed_modules["numpy"] = {}

for module_name, attrs in stubbed_modules.items():
    if module_name not in sys.modules:
        module = types.ModuleType(module_name)
        for attr_name, attr_value in attrs.items():
            setattr(module, attr_name, attr_value)
        sys.modules[module_name] = module

import numpy as np
HAS_REAL_NUMPY = hasattr(np, "arange")

module_path = Path(__file__).resolve().parent.parent / "speaker-benchmark.py"
spec = importlib.util.spec_from_file_location("speaker_benchmark", module_path)
if spec is None or spec.loader is None:
    raise RuntimeError("Failed to load speaker-benchmark.py for tests")
speaker_benchmark = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = speaker_benchmark
spec.loader.exec_module(speaker_benchmark)
run_benchmark = speaker_benchmark.run_benchmark
summarize_results = speaker_benchmark.summarize_results


def write_wav(path: Path, audio: Any, sample_rate: int = 16000) -> None:
    pcm16 = np.clip(audio, -1.0, 1.0)
    pcm16 = (pcm16 * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm16.tobytes())


class SpeakerBenchmarkTest(unittest.TestCase):
    def test_summarize_results_computes_rates(self) -> None:
        result = summarize_results([
            types.SimpleNamespace(expected_match=True, outcome="true_positive", confidence=0.9),
            types.SimpleNamespace(expected_match=True, outcome="false_negative", confidence=0.4),
            types.SimpleNamespace(expected_match=False, outcome="false_positive", confidence=0.85),
            types.SimpleNamespace(expected_match=False, outcome="true_negative", confidence=0.2),
        ], threshold=0.82)
        self.assertEqual(result["falseAcceptRate"], 0.5)
        self.assertEqual(result["falseRejectRate"], 0.5)
        self.assertEqual(result["positiveCases"], 2)
        self.assertEqual(result["negativeCases"], 2)

    def test_run_benchmark_writes_json_and_markdown(self) -> None:
        if not HAS_REAL_NUMPY:
            self.skipTest("numpy is unavailable in this test environment")
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            t = np.arange(16000 * 2, dtype=np.float32) / 16000.0
            reference = 0.12 * np.sin(2 * math.pi * 220 * t)
            non_match = 0.12 * np.sin(2 * math.pi * 440 * t)
            write_wav(root / "reference.wav", reference)
            write_wav(root / "match.wav", reference)
            write_wav(root / "non-match.wav", non_match)
            manifest = {
                "threshold": 0.82,
                "reference": {"audioPath": "reference.wav"},
                "cases": [
                    {"id": "same", "audioPath": "match.wav", "expectedMatch": True},
                    {"id": "other", "audioPath": "non-match.wav", "expectedMatch": False},
                ],
            }
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            output = run_benchmark(manifest_path, root / "out")
            self.assertTrue(Path(output["jsonPath"]).exists())
            self.assertTrue(Path(output["markdownPath"]).exists())
            payload = json.loads(Path(output["jsonPath"]).read_text(encoding="utf-8"))
            self.assertEqual(payload["summary"]["totalCases"], 2)
            self.assertEqual(len(payload["results"]), 2)


if __name__ == "__main__":
    unittest.main()
