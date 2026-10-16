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

import { getDictationProgress, type DictationViewState } from '../src/dictation-state.js';

function stateWith(patch: Partial<DictationViewState>): DictationViewState {
  return { ...initialDictationViewState, activeSessionId: 's1', ...patch };
}
const statuses = (state: DictationViewState, polishEnabled = true) =>
  getDictationProgress(state, { polishEnabled })?.steps.map(step => `${step.key}:${step.status}`);

test('progress is empty before any dictation starts', () => {
  assert.equal(getDictationProgress(initialDictationViewState, { polishEnabled: true }), null);
});

test('recording is the listening stage and later stages stay pending', () => {
  const progress = getDictationProgress(stateWith({ dictationState: 'recording' }), { polishEnabled: true })!;
  assert.equal(progress.stage, 'listening');
  assert.equal(progress.tone, 'live');
  assert.deepEqual(statuses(stateWith({ dictationState: 'recording' })),
    ['listening:active', 'transcribing:pending', 'polishing:pending', 'outputting:pending']);
});

test('after release the transcribing stage is shown until the polish event arrives', () => {
  const processing = stateWith({ dictationState: 'processing', detail: 'Transcribing' });
  assert.equal(getDictationProgress(processing, { polishEnabled: true })!.stage, 'transcribing');
  assert.deepEqual(statuses(processing),
    ['listening:done', 'transcribing:active', 'polishing:pending', 'outputting:pending']);
  const polishing = stateWith({ dictationState: 'processing', detail: 'Apple 智慧潤飾中' });
  assert.equal(getDictationProgress(polishing, { polishEnabled: true })!.stage, 'polishing');
  assert.deepEqual(statuses(polishing),
    ['listening:done', 'transcribing:done', 'polishing:active', 'outputting:pending']);
});

test('the polishing step is omitted when polishing is switched off', () => {
  assert.deepEqual(statuses(stateWith({ dictationState: 'processing' }), false),
    ['listening:done', 'transcribing:active', 'outputting:pending']);
});

test('a final text without an output status is the outputting stage', () => {
  const state = stateWith({ dictationState: 'done', finalText: '你好', outputAction: null, outputStatus: null });
  assert.equal(getDictationProgress(state, { polishEnabled: true })!.stage, 'outputting');
});

test('pasted shows a clear success and a skipped polish is reported with its reason', () => {
  const pasted = getDictationProgress(stateWith({
    dictationState: 'done', finalText: '你好', outputAction: 'copy-and-paste', outputStatus: 'pasted',
  }), { polishEnabled: true })!;
  assert.equal(pasted.title, '已送出貼上');
  assert.equal(pasted.tone, 'done');
  assert.equal(pasted.detail, null);
  const skipped = getDictationProgress(stateWith({
    dictationState: 'done', finalText: '你好', outputAction: 'copy-and-paste', outputStatus: 'pasted',
    fallbackReason: 'apple_intelligence_invalid_output',
  }), { polishEnabled: true })!;
  assert.equal(skipped.title, '已送出貼上');
  assert.match(skipped.detail ?? '', /潤飾已略過/);
  assert.deepEqual(statuses(stateWith({
    dictationState: 'done', finalText: '你好', outputAction: 'copy-and-paste', outputStatus: 'pasted',
    fallbackReason: 'apple_intelligence_invalid_output',
  })), ['listening:done', 'transcribing:done', 'polishing:skipped', 'outputting:done']);
});

test('copy-only output says it was copied', () => {
  const progress = getDictationProgress(stateWith({
    dictationState: 'done', finalText: '你好', outputAction: 'copy', outputStatus: 'copied',
  }), { polishEnabled: false })!;
  assert.equal(progress.title, '已複製');
  assert.equal(progress.tone, 'done');
});

test('a blocked paste is a warning that explains why the text is only on the clipboard', () => {
  const focus = getDictationProgress(stateWith({
    dictationState: 'done', finalText: '你好', outputAction: 'copy-and-paste', outputStatus: 'fallback',
    outputDetail: 'Focus changed from Notes to Safari, kept clipboard copy.',
  }), { polishEnabled: true })!;
  assert.equal(focus.tone, 'warning');
  assert.equal(focus.title, '已複製，未貼上');
  assert.match(focus.detail ?? '', /切換/);
  const unknown = getDictationProgress(stateWith({
    dictationState: 'done', finalText: '你好', outputAction: 'copy-and-paste', outputStatus: 'fallback',
    outputDetail: 'Paste unavailable, kept clipboard copy.',
  }), { polishEnabled: true })!;
  assert.match(unknown.detail ?? '', /剪貼簿/);
});

test('an empty result tells the user nothing was heard, and an error stops the steps', () => {
  const empty = getDictationProgress(stateWith({ dictationState: 'done', finalText: '' }), { polishEnabled: true })!;
  assert.equal(empty.title, '沒有聽到內容');
  assert.equal(empty.tone, 'warning');
  const failed = getDictationProgress(stateWith({ dictationState: 'error', lastError: 'mic lost' }), { polishEnabled: true })!;
  assert.equal(failed.tone, 'error');
  assert.equal(failed.title, '語音輸入中斷');
  assert.equal(failed.detail, 'mic lost');
  assert.deepEqual(failed.steps, []);
});

import { reduceDictationStarting } from '../src/dictation-state.js';

test('pressing the hotkey clears the previous result immediately and shows listening from the first frame', () => {
  const previous = stateWith({
    dictationState: 'done', finalText: '上一次的內容', outputAction: 'copy-and-paste', outputStatus: 'pasted',
    fallbackReason: 'apple_intelligence_invalid_output', lastError: 'old error',
  });
  const starting = reduceDictationStarting();
  assert.equal(starting.finalText, '');
  assert.equal(starting.outputStatus, null);
  assert.equal(starting.lastError, null);
  assert.notEqual(starting, previous);
  const progress = getDictationProgress(starting, { polishEnabled: true })!;
  assert.equal(progress.title, '收音中');
  assert.equal(progress.stage, 'listening');
  assert.deepEqual(progress.steps.map(step => `${step.key}:${step.status}`),
    ['listening:active', 'transcribing:pending', 'polishing:pending', 'outputting:pending']);
});

test('a connected session that has not reported recording yet already reads as listening, never blank', () => {
  const connecting = stateWith({ sessionState: 'connecting', dictationState: 'idle' });
  const streaming = stateWith({ sessionState: 'streaming', dictationState: 'idle' });
  for (const state of [connecting, streaming]) {
    assert.equal(getDictationProgress(state, { polishEnabled: false })!.title, '收音中');
  }
  assert.equal(getDictationProgress(stateWith({ sessionState: 'streaming', dictationState: 'recording' }), { polishEnabled: false })!.title, '收音中');
});

test('only the preparing and listening stages offer the cancel and confirm buttons', () => {
  const options = { polishEnabled: true };
  assert.equal(getDictationProgress(reduceDictationStarting(), options)!.cancellable, true);
  assert.equal(getDictationProgress(stateWith({ dictationState: 'recording' }), options)!.cancellable, true);
  assert.equal(getDictationProgress(stateWith({ dictationState: 'processing' }), options)!.cancellable, false);
  assert.equal(getDictationProgress(stateWith({
    dictationState: 'done', finalText: '你好', outputAction: 'copy-and-paste', outputStatus: 'pasted',
  }), options)!.cancellable, false);
  assert.equal(getDictationProgress(stateWith({ dictationState: 'error', lastError: 'x' }), options)!.cancellable, false);
});

test('a microphone that is slow to open is called out instead of pretending to record', () => {
  const starting = { ...reduceDictationStarting(), startedAtMs: 10_000 };
  const quick = getDictationProgress(starting, { polishEnabled: false, nowMs: 10_200 })!;
  assert.equal(quick.title, '收音中');
  const slow = getDictationProgress(starting, { polishEnabled: false, nowMs: 10_900 })!;
  assert.equal(slow.title, '準備麥克風');
  assert.match(slow.detail ?? '', /先不要說話/);
  assert.equal(slow.cancellable, true);
  const recording = getDictationProgress({ ...starting, dictationState: 'recording' }, { polishEnabled: false, nowMs: 14_000 })!;
  assert.equal(recording.title, '收音中', 'once the sidecar says the microphone is open it is recording, however long it took');
});

test('a repeated "connecting" while the recogniser loads does not undo "recording"', () => {
  const connecting = reduceDictationEvent(initialDictationViewState, { type: 'session_state', mode: 'dictation', sessionId: 'dictation-1', state: 'connecting' });
  const recording = reduceDictationEvent(connecting, { type: 'dictation_state', mode: 'dictation', sessionId: 'dictation-1', state: 'recording' });
  const loading = reduceDictationEvent(recording, { type: 'session_state', mode: 'dictation', sessionId: 'dictation-1', state: 'connecting', detail: 'Loading Breeze ASR model...' });
  const streaming = reduceDictationEvent(loading, { type: 'session_state', mode: 'dictation', sessionId: 'dictation-1', state: 'streaming' });
  assert.equal(loading.dictationState, 'recording');
  assert.equal(streaming.dictationState, 'recording');
  assert.equal(getDictationProgress(streaming, { polishEnabled: false, nowMs: (streaming.startedAtMs ?? 0) + 5000 })?.title, '收音中');
  // a new session still starts from scratch
  const next = reduceDictationEvent(streaming, { type: 'session_state', mode: 'dictation', sessionId: 'dictation-2', state: 'connecting' });
  assert.equal(next.dictationState, 'idle');
  assert.equal(next.activeSessionId, 'dictation-2');
});
