import threading
import time
import unittest
from unittest.mock import patch

import numpy as np

from python.tests.test_sidecar import sidecar_module as sidecar


class FakeCapture:
    level = 1.0
    queue = type("Q", (), {"qsize": lambda self: 0, "maxsize": 0})()
    output_queue = queue

    def __init__(self, blocks=None):
        self.pending = list(blocks or [])
        self.stop_calls = 0
        self.lock = threading.Lock()

    def push(self, block):
        with self.lock:
            self.pending.append(block)

    def drain(self):
        with self.lock:
            blocks, self.pending = self.pending, []
        return np.concatenate(blocks) if blocks else np.zeros(0, dtype=np.float32)

    def stop(self):
        self.stop_calls += 1


class FakeTranscriber:
    def __init__(self, hold=None):
        self.fed = []
        self.feeding = threading.Event()
        self.hold = hold
        self.flush_calls = 0
        self.flush_error = None
        self.stopped = False

    def feed_audio(self, samples, base_time_ms):
        self.fed.append(samples.copy())
        self.feeding.set()
        if self.hold is not None:
            self.hold.wait(5)
        return []

    def flush(self, *_):
        self.flush_calls += 1
        if self.flush_error:
            raise self.flush_error
        return []

    def stop(self):
        self.stopped = True


def make_app(capture, transcriber, mode='dictation'):
    app = sidecar.SidecarApp()
    app.config = sidecar.SessionConfig(
        mode=mode, session_id='s1', device_id='', output_device_id='', source_lang='zh', target_lang='',
        stt_model='test-double', translate_model='', chunk_ms=0, partial_stable_ms=600)
    app.active = True
    app.capture = capture
    app.transcriber = transcriber
    app.thread = threading.Thread(target=app._stream_loop)
    return app


class StopTailTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        patcher = patch.object(sidecar, 'emit', self.events.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _finals(self):
        return [e for e in self.events if e.get('type') == 'dictation_final']

    def test_busy_consumer_still_feeds_queued_tail_exactly_once(self):
        release = threading.Event()
        capture = FakeCapture([np.ones(320, dtype=np.float32)])
        transcriber = FakeTranscriber(hold=release)
        app = make_app(capture, transcriber)
        app.thread.start()
        self.assertTrue(transcriber.feeding.wait(3))
        capture.push(np.full(320, 2, dtype=np.float32))
        stopper = threading.Thread(target=app.stop_session)
        stopper.start()
        time.sleep(0.1)
        release.set()
        stopper.join(5)
        self.assertFalse(stopper.is_alive())
        markers = [float(x) for block in transcriber.fed for x in np.unique(block)]
        self.assertEqual(sum(block.size for block in transcriber.fed), 640)
        self.assertEqual(sorted(markers), [1.0, 2.0])
        self.assertEqual(capture.pending, [])
        self.assertEqual(len(self._finals()), 1)

    def test_producer_is_stopped_before_the_consumer_is_told_to_stop(self):
        order = []
        capture = FakeCapture()
        capture.stop = lambda: order.append('capture')
        app = make_app(capture, FakeTranscriber())
        real_set = app.stop_event.set
        app.stop_event.set = lambda: (order.append('event'), real_set())[1]
        app.thread.start()
        app.stop_session()
        self.assertEqual(order[:2], ['capture', 'event'])

    def test_stop_with_no_audio_finishes_with_one_final(self):
        app = make_app(FakeCapture(), FakeTranscriber())
        app.thread.start()
        app.stop_session()
        self.assertEqual(len(self._finals()), 1)

    def test_second_stop_for_the_same_session_does_not_deliver_again(self):
        app = make_app(FakeCapture(), FakeTranscriber())
        app.thread.start()
        app.stop_session()
        app.config = sidecar.SessionConfig(**{**app.config.__dict__})
        app.capture = FakeCapture()
        app.transcriber = FakeTranscriber()
        app.thread = threading.Thread(target=app._stream_loop)
        app.thread.start()
        app.stop_session()
        self.assertEqual(len(self._finals()), 1)

    def test_flush_failure_is_reported_not_silent(self):
        transcriber = FakeTranscriber()
        transcriber.flush_error = RuntimeError('boom')
        app = make_app(FakeCapture(), transcriber)
        app.thread.start()
        app.stop_session()
        self.assertTrue(any(e.get('code') == 'dictation_flush_failed' for e in self.events))
        self.assertEqual(len(self._finals()), 1)

    def test_consumer_timeout_reports_failure_and_does_not_release_under_the_consumer(self):
        release = threading.Event()
        capture = FakeCapture([np.ones(320, dtype=np.float32)])
        transcriber = FakeTranscriber(hold=release)
        app = make_app(capture, transcriber)
        app.thread.start()
        self.assertTrue(transcriber.feeding.wait(3))
        with patch.object(sidecar, 'STOP_CONSUMER_JOIN_SECONDS', 0.2):
            app.stop_session()
        self.assertEqual(self._finals(), [])
        self.assertTrue(any(e.get('code') == 'stop_consumer_timeout' for e in self.events))
        self.assertFalse(transcriber.stopped, 'the transcriber must not be released while the consumer still feeds it')
        release.set()
        deadline = time.monotonic() + 3
        while not transcriber.stopped and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(transcriber.stopped, 'released once the consumer really ended')

    def test_subtitle_sessions_also_get_the_tail(self):
        release = threading.Event()
        capture = FakeCapture([np.ones(160, dtype=np.float32)])
        transcriber = FakeTranscriber(hold=release)
        app = make_app(capture, transcriber, mode='subtitle')
        app.thread.start()
        self.assertTrue(transcriber.feeding.wait(3))
        capture.push(np.full(160, 3, dtype=np.float32))
        stopper = threading.Thread(target=app.stop_session)
        stopper.start()
        time.sleep(0.1)
        release.set()
        stopper.join(5)
        self.assertEqual(sum(block.size for block in transcriber.fed), 320)


if __name__ == '__main__':
    unittest.main()
