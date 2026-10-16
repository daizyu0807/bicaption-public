import io
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from python.tests.test_sidecar import sidecar_module as sidecar

class AppleStartupTests(unittest.TestCase):
    def test_native_start_error_is_not_reported_as_ready(self):
        transcriber = sidecar.AppleSttTranscriber('en')
        transcriber._results.put({'type': 'error', 'code': 'auth_denied', 'message': 'Speech recognition not authorized', 'recoverable': False})
        process = SimpleNamespace(stdout=io.BytesIO(), stderr=io.BytesIO(), poll=lambda: 1)
        with patch.object(sidecar.os.path, 'isfile', return_value=True), patch.object(sidecar, 'launch_apple_helper', return_value=process), patch.object(sidecar.threading, 'Thread'):
            with self.assertRaisesRegex(RuntimeError, 'Speech recognition not authorized'):
                transcriber.start()

    def test_native_exit_without_ready_fails_start(self):
        transcriber = sidecar.AppleSttTranscriber('en')
        process = SimpleNamespace(stdout=io.BytesIO(), stderr=io.BytesIO(), poll=lambda: -6)
        with patch.object(sidecar.os.path, 'isfile', return_value=True), patch.object(sidecar, 'launch_apple_helper', return_value=process), patch.object(sidecar.threading, 'Thread'):
            with self.assertRaisesRegex(RuntimeError, 'Apple.*-6'):
                transcriber.start()

    def test_native_ready_allows_start(self):
        transcriber = sidecar.AppleSttTranscriber('en')
        transcriber._results.put({'type': 'ready'})
        process = SimpleNamespace(stdout=io.BytesIO(), stderr=io.BytesIO(), poll=lambda: None)
        with patch.object(sidecar.os.path, 'isfile', return_value=True), patch.object(sidecar, 'launch_apple_helper', return_value=process), patch.object(sidecar.threading, 'Thread'):
            transcriber.start()

class AppleContextualStringsTests(unittest.TestCase):
    def _start_args(self, **kwargs):
        transcriber = sidecar.AppleSttTranscriber('en', **kwargs)
        transcriber._results.put({'type': 'ready'})
        process = SimpleNamespace(stdout=io.BytesIO(), stderr=io.BytesIO(), poll=lambda: None)
        with patch.object(sidecar.os.path, 'isfile', return_value=True), patch.object(sidecar, 'launch_apple_helper', return_value=process) as launch, patch.object(sidecar.threading, 'Thread'):
            transcriber.start()
        return launch.call_args[0][1]

    def test_empty_vocabulary_keeps_helper_arguments_unchanged(self):
        self.assertEqual(self._start_args(), ['--locale', 'en-US'])

    def test_vocabulary_is_passed_to_the_helper_as_json(self):
        import json
        args = self._start_args(contextual_strings=['BiCaption', '智慧潤飾'])
        index = args.index('--contextual-strings-json')
        self.assertEqual(json.loads(args[index + 1]), ['BiCaption', '智慧潤飾'])

    def test_dictation_session_builds_apple_vocabulary_from_all_term_sources(self):
        config = sidecar.SessionConfig(
            mode='dictation', session_id='s', device_id='', output_device_id='', target_lang='', translate_model='', chunk_ms=0, partial_stable_ms=600, stt_model='apple-stt', source_lang='en',
            dictation_initial_prompt_text='Claude, Linear', dictation_dictionary_text='', dictation_hotwords='BiCaption')
        with patch.object(sidecar, 'AppleSttTranscriber') as cls:
            sidecar.get_streaming_transcriber(config, announce=False)
        self.assertEqual(cls.call_args.kwargs['contextual_strings'], ['BiCaption', 'Claude', 'Linear'])

    def test_non_dictation_sessions_get_no_vocabulary(self):
        config = sidecar.SessionConfig(
            mode='subtitle', session_id='s', device_id='', output_device_id='', target_lang='', translate_model='', chunk_ms=0, partial_stable_ms=600, stt_model='apple-stt', source_lang='en',
            dictation_initial_prompt_text='Claude', dictation_hotwords='BiCaption')
        with patch.object(sidecar, 'AppleSttTranscriber') as cls:
            sidecar.get_streaming_transcriber(config, announce=False)
        self.assertEqual(cls.call_args.kwargs['contextual_strings'], [])


class HelperLifecycleTests(unittest.TestCase):
    def test_early_launchservices_exit_does_not_end_event_reader(self):
        from apple_helper_launch import AppHelperProcess
        process = AppHelperProcess.__new__(AppHelperProcess)
        process.native_pid = None
        process.started_at = 100
        process.launcher = SimpleNamespace(poll=lambda: 0)
        with patch('apple_helper_launch.time.monotonic', return_value=101):
            self.assertIsNone(process.poll())

    def test_native_lifetime_outlives_open_wrapper(self):
        from apple_helper_launch import AppHelperProcess
        process = AppHelperProcess.__new__(AppHelperProcess)
        process.native_pid = 4321
        process.launcher = SimpleNamespace(poll=lambda: 0)
        with patch('apple_helper_launch.os.kill'):
            self.assertIsNone(process.poll())
        with patch('apple_helper_launch.os.kill', side_effect=ProcessLookupError):
            self.assertEqual(process.poll(), 0)
