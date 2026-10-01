import sys
import unittest
import contextlib
import io
import json
import tempfile
import wave
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from asr_metrics import aggregate_scores, edit_distance, score_transcript
from asr_benchmark import main, read_rows, run_qwen, score_rows


class AsrMetricsTests(unittest.TestCase):
    def test_chinese_and_unicode(self):
        self.assertEqual(score_transcript("台灣中文", "台灣中午")["cer"]["rate"], 0.25)
        self.assertEqual(score_transcript("café", "cafe\u0301")["cer"]["errors"], 0)
        self.assertEqual(score_transcript("你 好", "你好")["cer"]["errors"], 0)

    def test_case_punctuation_and_repetition_are_not_hidden(self):
        self.assertEqual(score_transcript("Yes", "yes")["cer"]["errors"], 1)
        self.assertEqual(score_transcript("no no", "no")["wer"]["errors"], 1)
        self.assertEqual(score_transcript("好。", "好")["cer"]["errors"], 1)

    def test_micro_aggregation_not_average(self):
        rows = [score_transcript("a", "b"), score_transcript("a" * 9, "a" * 9)]
        self.assertEqual(aggregate_scores(rows)["cer"]["rate"], 0.1)

    def test_empty_reference_preserves_insertions(self):
        metric = score_transcript("", "ghost words")
        self.assertIsNone(metric["wer"]["rate"])
        self.assertEqual(metric["wer"]["errors"], 2)
        self.assertIsNone(aggregate_scores([metric])["cer"]["rate"])
        self.assertEqual(aggregate_scores([])["wer"]["rate"], 0)

    def test_all_edit_types_and_symmetry(self):
        self.assertEqual(edit_distance(list("abc"), list("axcd")), 2)
        self.assertEqual(edit_distance([], list("abc")), 3)
        self.assertEqual(edit_distance(list("abc"), []), 3)

    def test_invalid_counts_are_rejected(self):
        for invalid in [-1, True, 0.5, "1"]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                aggregate_scores([{"cer": {"errors": invalid, "reference_units": 1}, "wer": {"errors": 0, "reference_units": 1}}])
        with self.assertRaises(ValueError):
            aggregate_scores([{}])
        with self.assertRaises(TypeError):
            score_transcript(None, "hi")

    def test_categories_and_silence_are_visible(self):
        result = score_rows([
            {"id": "a", "category": "zh", "reference": "中文", "hypothesis": "中午"},
            {"id": "b", "category": "silence", "reference": "", "hypothesis": "ghost"},
        ])
        self.assertEqual(result["by_category"]["zh"]["cer"]["rate"], 0.5)
        self.assertIsNone(result["by_category"]["silence"]["cer"]["rate"])

    def test_manifest_resolves_local_audio_and_rejects_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with wave.open(str(root / "clip.wav"), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(b"\x00\x00" * 1600)
            manifest = root / "manifest.json"
            row = {"id": "clip", "audio": "clip.wav", "reference": ""}
            manifest.write_text(json.dumps([row]))
            parsed = read_rows(manifest, audio=True)
            self.assertEqual(parsed[0]["audio_seconds"], 0.1)
            self.assertEqual(Path(parsed[0]["audio"]), (root / "clip.wav").resolve())
            manifest.write_text(json.dumps([row, row]))
            with self.assertRaises(ValueError):
                read_rows(manifest, audio=True)

    def test_missing_model_fails_before_runtime_import(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "already downloaded"):
                run_qwen([], Path(directory))

    def test_cli_success_and_invalid_input_exit_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rows.json"
            path.write_text(json.dumps([{"id": "one", "reference": "no", "hypothesis": "yes"}]))
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(main(["--score", str(path)]), 0)
            self.assertEqual(json.loads(out.getvalue())["aggregate"]["wer"]["errors"], 1)
            path.write_text("{}")
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(main(["--score", str(path)]), 2)
            self.assertEqual(json.loads(out.getvalue())["status"], "blocked")

    def test_qwen_offline_contract_and_runtime_error(self):
        import builtins
        original_import = builtins.__import__
        def unavailable(name, *args, **kwargs):
            if name == "mlx_audio.stt":
                import os
                self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
                self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
                raise ImportError("pilot runtime missing")
            return original_import(name, *args, **kwargs)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config.json").write_text("{}")
            with patch("builtins.__import__", side_effect=unavailable), self.assertRaisesRegex(ImportError, "runtime missing"):
                run_qwen([], root)


if __name__ == "__main__":
    unittest.main()
