import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDictationViewState, reduceDictationEvent, reduceDictationOutputStatus } from '../src/dictation-state.js';

test('dictation reducer tracks active session and final transcript', () => {
  const connecting = reduceDictationEvent(initialDictationViewState, {
    type: 'session_state',
    mode: 'dictation',
    sessionId: 'dictation-1',
    state: 'connecting',
  });
  const recording = reduceDictationEvent(connecting, {
    type: 'dictation_state',
    mode: 'dictation',
    sessionId: 'dictation-1',
    state: 'recording',
    detail: 'Dictation session started',
  });
  const completed = reduceDictationEvent(recording, {
    type: 'dictation_final',
    mode: 'dictation',
    sessionId: 'dictation-1',
    literalTranscript: 'hello world',
    dictionaryText: 'hello world',
    finalText: 'hello world',
    initialPromptText: 'Claude, Anthropic',
    matchedCorrections: ['Claude <= Cloud [context: AI, Anthropic]'],
    rewriteBackend: 'disabled',
    rewriteApplied: false,
    chunkCount: 2,
    startedAtMs: 10,
    endedAtMs: 40,
    latencyMs: 30,
  });

  assert.equal(completed.activeSessionId, 'dictation-1');
  assert.equal(completed.dictationState, 'done');
  assert.equal(completed.literalTranscript, 'hello world');
  assert.equal(completed.dictionaryText, 'hello world');
  assert.equal(completed.finalText, 'hello world');
  assert.equal(completed.initialPromptText, 'Claude, Anthropic');
  assert.deepEqual(completed.matchedCorrections, ['Claude <= Cloud [context: AI, Anthropic]']);
  assert.equal(completed.rewriteBackend, 'disabled');
  assert.equal(completed.rewriteApplied, false);
  assert.equal(completed.finalChunkCount, 2);
  assert.equal(completed.finalLatencyMs, 30);
});

test('dictation reducer ignores subtitle events', () => {
  const state = reduceDictationEvent(initialDictationViewState, {
    type: 'final_caption',
    mode: 'subtitle',
    sessionId: 'subtitle-1',
    segmentId: 'seg-1',
    sourceText: 'Hello',
    translatedText: '你好',
    startedAtMs: 1,
    endedAtMs: 2,
    latencyMs: 1,
  });

  assert.deepEqual(state, initialDictationViewState);
});

test('dictation reducer ignores stale session events', () => {
  const connecting = reduceDictationEvent(initialDictationViewState, {
    type: 'session_state',
    mode: 'dictation',
    sessionId: 'dictation-1',
    state: 'connecting',
  });
  const state = reduceDictationEvent(connecting, {
    type: 'dictation_final',
    mode: 'dictation',
    sessionId: 'dictation-2',
    literalTranscript: 'wrong session',
    dictionaryText: 'wrong session',
    finalText: 'wrong session',
    initialPromptText: '',
    matchedCorrections: [],
    rewriteBackend: 'disabled',
    rewriteApplied: false,
    startedAtMs: 1,
    endedAtMs: 2,
    latencyMs: 1,
  });

  assert.deepEqual(state, connecting);
});

test('dictation output status is tracked separately', () => {
  const state = reduceDictationOutputStatus(initialDictationViewState, {
    type: 'dictation_output_status',
    action: 'paste',
    status: 'fallback',
    detail: 'Focus changed, kept clipboard copy.',
  });

  assert.equal(state.outputAction, 'paste');
  assert.equal(state.outputStatus, 'fallback');
  assert.equal(state.outputDetail, 'Focus changed, kept clipboard copy.');
});
