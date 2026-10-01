import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from apple_translation import AppleTranslationProvider, normalize_translation_language


class AppleTranslationTests(unittest.TestCase):
    def provider(self):
        self.file = tempfile.NamedTemporaryFile()
        self.addCleanup(self.file.close)
        with patch.dict(os.environ, {"BICAPTION_APPLE_TRANSLATION_HELPER": self.file.name}):
            return AppleTranslationProvider(persistent=False)

    def test_batch_preserves_empty_positions_and_cache(self):
        provider = self.provider()
        with patch("apple_translation.subprocess.run", return_value=subprocess.CompletedProcess(
            [], 0, json.dumps({"status": "installed", "translations": ["你好", "再見"]}), ""
        )) as run:
            self.assertEqual(provider.translate_many(["Hello", "", "Goodbye"], "en", "zh-TW"), ["你好", "", "再見"])
            self.assertEqual(provider.translate("Hello", "en", "zh-TW"), "你好")
            self.assertEqual(run.call_count, 1)

    def test_missing_assets_and_bad_results_are_errors_not_empty_captions(self):
        for payload in [{"status": "supported", "message": "請下載語言包"},
                        {"status": "installed", "translations": []},
                        {"status": "installed", "translations": [""]}]:
            with patch("apple_translation.subprocess.run", return_value=subprocess.CompletedProcess([], 0, json.dumps(payload), "")):
                with self.assertRaises(RuntimeError): self.provider().translate("Hello", "en", "zh-TW")

    def test_timeout_is_reported(self):
        with patch("apple_translation.subprocess.run", side_effect=subprocess.TimeoutExpired("helper", 30)):
            with self.assertRaisesRegex(RuntimeError, "逾時"): self.provider().translate("Hello", "en", "zh-TW")

    def test_auto_language_is_detected_per_fragment(self):
        provider = self.provider()
        replies = [subprocess.CompletedProcess([], 0, json.dumps({"status": "installed", "translations": [text]}), "")
                   for text in ["你好", "早安"]]
        with patch("apple_translation.subprocess.run", side_effect=replies) as run:
            self.assertEqual(provider.translate_many(["Hello", "おはよう"], "auto", "zh-TW"), ["你好", "早安"])
            self.assertEqual([json.loads(call.kwargs['input']) for call in run.call_args_list], [["Hello"], ["おはよう"]])

    def test_asr_chinese_language_alias_is_supported_for_breeze(self):
        provider = self.provider()
        with patch("apple_translation.subprocess.run", return_value=subprocess.CompletedProcess(
            [], 0, json.dumps({"status": "installed", "translations": ["Hello"]}), ""
        )) as run:
            self.assertEqual(provider.translate("你好", "zh", "en"), "Hello")
            args = run.call_args.args[0]
            self.assertEqual(args[args.index("--source") + 1], "zh-Hant")

    def test_language_aliases_keep_unknown_languages_visible(self):
        for source, expected in [("zh", "zh-Hant"), ("zh-CN", "zh-Hans"), ("en-US", "en"), ("auto", "auto"), ("fr", "fr")]:
            self.assertEqual(normalize_translation_language(source), expected)

    def test_breeze_language_constraints_are_sent_to_both_helper_modes(self):
        provider = self.provider()
        provider.source_languages = ["en", "zh-Hant", "zh-Hans"]
        with patch("apple_translation.subprocess.run", return_value=subprocess.CompletedProcess(
            [], 0, json.dumps({"status": "installed", "translations": ["測試"]}), ""
        )) as run:
            provider.translate("test", "auto", "zh-TW")
            args = run.call_args.args[0]
            self.assertIn("--source-languages", args)
            self.assertEqual(args[args.index("--source-languages") + 1], "en,zh-Hant,zh-Hans")
        provider.persistent = True
        with patch.object(provider, "_request", return_value={"status":"installed", "translations":["好"]}) as request:
            provider.translate("OK", "auto", "zh-TW")
            self.assertEqual(provider.source_languages, ["en", "zh-Hant", "zh-Hans"])

    def test_missing_helper(self):
        with patch.dict(os.environ, {"BICAPTION_APPLE_TRANSLATION_HELPER": ""}):
            with self.assertRaisesRegex(RuntimeError, "缺失"): AppleTranslationProvider()

class PersistentAppleTranslationTests(unittest.TestCase):
    def test_worker_receives_breeze_source_language_contract(self):
        with tempfile.TemporaryDirectory() as folder:
            helper = Path(folder) / 'helper'
            helper.write_text('#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({"status":"ready"}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({"status":"installed","translations":[",".join(r["sourceLanguages"]) for x in r["texts"]]}),flush=True)\n')
            helper.chmod(0o700)
            with patch.dict(os.environ, {"BICAPTION_APPLE_TRANSLATION_HELPER": str(helper)}):
                provider = AppleTranslationProvider(persistent=True, source_languages=["en", "zh-Hant", "zh-Hans"])
            try:
                self.assertEqual(provider.translate('test', 'auto', 'zh-TW'), 'en,zh-Hant,zh-Hans')
            finally:
                provider.close()

    def test_reuses_worker_for_uncached_sentences_and_closes_it(self):
        with tempfile.TemporaryDirectory() as folder:
            helper = Path(folder) / 'helper'
            helper.write_text('#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({"status":"ready"}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({"status":"installed","translations":["translated:"+x for x in r["texts"]]}),flush=True)\n')
            helper.chmod(0o700)
            with patch.dict(os.environ, {"BICAPTION_APPLE_TRANSLATION_HELPER": str(helper)}):
                provider = AppleTranslationProvider(persistent=True)
            try:
                self.assertEqual(provider.translate('one', 'en', 'zh-TW'), 'translated:one')
                process = provider._process
                self.assertEqual(provider.translate('two', 'en', 'zh-TW'), 'translated:two')
                self.assertIs(provider._process, process)
                process.kill()
                process.wait(timeout=2)
                self.assertEqual(provider.translate('three', 'en', 'zh-TW'), 'translated:three')
                self.assertIsNot(provider._process, process)
                process = provider._process
            finally:
                provider.close()
            self.assertIsNotNone(process.poll())
