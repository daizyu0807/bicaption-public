from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import numpy as np
from python.tests.test_sidecar import sidecar_module as sidecar

class MeetingSystemAudioTests(unittest.TestCase):
    def test_system_only_sck_reads_output_queue(self):
        app = sidecar.SidecarApp()
        app.config = SimpleNamespace(meeting_source_mode='system-audio')
        expected = np.array([0.2, 0.3], dtype=np.float32)
        app.capture = SimpleNamespace(_use_sck=True, drain_primary=lambda: np.zeros(0, dtype=np.float32), drain_output=lambda: expected)
        app.stop_event = MagicMock()
        app.stop_event.is_set.side_effect = [False, True]
        app.meeting_mic_transcriber = None
        app.meeting_system_transcriber = object()
        with patch.object(sidecar, 'emit'), patch.object(sidecar.time, 'sleep'), patch.object(app, '_append_meeting_audio'), patch.object(app, '_emit_metrics'), patch.object(app, '_feed_meeting_transcriber') as feed:
            app._run_meeting_stream_loop()
        system_calls = [call.args for call in feed.call_args_list if call.args[0] == 'system']
        np.testing.assert_array_equal(system_calls[0][1], expected)
