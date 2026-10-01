import test from 'node:test';
import assert from 'node:assert/strict';
import { initialViewState, reduceSidecarEvent } from '../src/caption-state.js';

test('partial captions replace current partial state', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const state = reduceSidecarEvent(connected, {
    type: 'partial_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-1',
    sourceText: 'Hello',
    startedAtMs: 1,
    updatedAtMs: 2,
  });

  assert.equal(state.partial?.sourceText, 'Hello');
  assert.equal(state.captions.length, 0);
});

test('final captions are retained and clear matching partial', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const withPartial = reduceSidecarEvent(connected, {
    type: 'partial_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-1',
    sourceText: 'Hel',
    startedAtMs: 1,
    updatedAtMs: 2,
  });
  const state = reduceSidecarEvent(withPartial, {
    type: 'final_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-1',
    sourceText: 'Hello',
    translatedText: '你好',
    startedAtMs: 1,
    endedAtMs: 3,
    latencyMs: 1200,
  });

  assert.equal(state.partial, null);
  assert.equal(state.captions[0]?.translatedText, '你好');
});

test('non-subtitle events are ignored by caption reducer', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const state = reduceSidecarEvent(connected, {
    type: 'final_caption',
    mode: 'dictation',
    sessionId: 'session-2',
    segmentId: 'seg-1',
    sourceText: 'Hello',
    translatedText: '',
    startedAtMs: 1,
    endedAtMs: 2,
    latencyMs: 1,
  });

  assert.deepEqual(state, connected);
});

test('dictation events are ignored by subtitle caption reducer', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const afterState = reduceSidecarEvent(connected, {
    type: 'dictation_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'recording',
  });
  const afterFinal = reduceSidecarEvent(afterState, {
    type: 'dictation_final',
    mode: 'subtitle',
    sessionId: 'session-1',
    text: 'Hello',
    startedAtMs: 1,
    endedAtMs: 2,
    latencyMs: 1,
  });

  assert.deepEqual(afterState, connected);
  assert.deepEqual(afterFinal, connected);
});

test('final captions trim repeated history tail from source and translation', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const first = reduceSidecarEvent(connected, {
    type: 'final_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-1',
    sourceText: 'usually people will be there at 9 o clock because the meeting will start',
    translatedText: '通常人們會在九點到場，因為會議要開始',
    startedAtMs: 1,
    endedAtMs: 2,
    latencyMs: 10,
  });
  const second = reduceSidecarEvent(first, {
    type: 'final_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-2',
    sourceText: 'I was waiting for 20 minutes to get my coffee usually people will be there at 9 o clock because the meeting will start',
    translatedText: '我等了二十分鐘才拿到咖啡，通常人們會在九點到場，因為會議要開始',
    startedAtMs: 3,
    endedAtMs: 4,
    latencyMs: 12,
  });

  assert.equal(second.captions[1]?.sourceText, 'I was waiting for 20 minutes to get my coffee');
  assert.equal(second.captions[1]?.translatedText, '我等了二十分鐘才拿到咖啡');
});

test('fully replayed final captions are ignored', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const first = reduceSidecarEvent(connected, {
    type: 'final_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-1',
    sourceText: 'normally everyone arrives before the meeting starts and gets settled in',
    translatedText: '通常大家會在會議開始前到齊並先安頓好',
    startedAtMs: 1,
    endedAtMs: 2,
    latencyMs: 10,
  });
  const replay = reduceSidecarEvent(first, {
    type: 'final_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-2',
    sourceText: 'normally everyone arrives before the meeting starts and gets settled in',
    translatedText: '通常大家會在會議開始前到齊並先安頓好',
    startedAtMs: 3,
    endedAtMs: 4,
    latencyMs: 12,
  });

  assert.equal(replay.captions.length, 1);
  assert.equal(replay.captions[0]?.segmentId, 'seg-1');
});

test('translation failure is visible independently of diagnostic errors and clears on recovery', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state', mode: 'subtitle', sessionId: 'session-1', state: 'connecting',
  });
  const failed = reduceSidecarEvent(connected, {
    type: 'error', mode: 'subtitle', sessionId: 'session-1', code: 'translation_failed',
    message: 'Google 翻譯請求受限', recoverable: true,
  });
  assert.equal(failed.translationError, 'Google 翻譯請求受限');
  const diagnostic = reduceSidecarEvent(failed, {
    type: 'error', mode: 'subtitle', sessionId: 'session-1', code: 'sidecar_stderr',
    message: 'diagnostic', recoverable: true,
  });
  assert.equal(diagnostic.translationError, failed.translationError);
  const recovered = reduceSidecarEvent(diagnostic, {
    type: 'final_caption', mode: 'subtitle', sessionId: 'session-1', segmentId: 'seg-recovered',
    sourceText: 'hello', translatedText: '你好', startedAtMs: 1, endedAtMs: 2, latencyMs: 1,
  });
  assert.equal(recovered.translationError, null);
});
