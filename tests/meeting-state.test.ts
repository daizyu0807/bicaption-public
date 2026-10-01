import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMeetingViewState, reduceMeetingEvent } from '../src/meeting-state.js';

test('meeting reducer upserts translated captions by segment id', () => {
  const connecting = reduceMeetingEvent(initialMeetingViewState, {
    type: 'session_state',
    mode: 'meeting',
    sessionId: 'meeting-1',
    state: 'connecting',
  });

  const withSource = reduceMeetingEvent(connecting, {
    type: 'meeting_caption',
    mode: 'meeting',
    sessionId: 'meeting-1',
    segmentId: 'seg-1',
    turnId: 'turn-1',
    speakerId: 'microphone',
    speakerLabel: '我方',
    speakerKind: 'source-default',
    speakerProfileId: '',
    speakerMatchConfidence: 0,
    source: 'microphone',
    sourceLang: 'en',
    targetLang: 'zh-TW',
    text: 'hello team',
    translatedText: '',
    tsStartMs: 10,
    tsEndMs: 30,
  });

  const withTranslation = reduceMeetingEvent(withSource, {
    type: 'meeting_caption',
    mode: 'meeting',
    sessionId: 'meeting-1',
    segmentId: 'seg-1',
    turnId: 'turn-1',
    speakerId: 'microphone',
    speakerLabel: '我方',
    speakerKind: 'source-default',
    speakerProfileId: '',
    speakerMatchConfidence: 0,
    source: 'microphone',
    sourceLang: 'en',
    targetLang: 'zh-TW',
    text: 'hello team',
    translatedText: '大家好',
    tsStartMs: 10,
    tsEndMs: 30,
  });

  assert.equal(withTranslation.entries.length, 1);
  assert.equal(withTranslation.entries[0]?.turnId, 'turn-1');
  assert.equal(withTranslation.entries[0]?.speakerKind, 'source-default');
  assert.equal(withTranslation.entries[0]?.translatedText, '大家好');
});

test('meeting reducer clears active session after stop ack', () => {
  const connecting = reduceMeetingEvent(initialMeetingViewState, {
    type: 'session_state',
    mode: 'meeting',
    sessionId: 'meeting-1',
    state: 'connecting',
  });

  const stopped = reduceMeetingEvent(connecting, {
    type: 'session_stopped_ack',
    mode: 'meeting',
    sessionId: 'meeting-1',
  });

  assert.equal(stopped.sessionState, 'stopped');
  assert.equal(stopped.activeSessionId, null);
  assert.equal(stopped.partial, null);
});

test('stopping preserves unfinished words for review and next meeting starts clean', () => {
  const state = { ...initialMeetingViewState, activeSessionId: 'm1', sessionState: 'streaming', partial: { id: 'p1', sourceText: 'last unfinished words', startedAtMs: 10, isFinal: false } };
  const stopped = reduceMeetingEvent(state, { type: 'session_stopped_ack', mode: 'meeting', sessionId: 'm1' });
  assert.equal(stopped.entries[0]?.sourceText, 'last unfinished words');
  assert.equal(stopped.entries[0]?.isFinal, false);
  assert.equal(stopped.partial, null);
  const next = reduceMeetingEvent(stopped, { type: 'session_state', mode: 'meeting', sessionId: 'm2', state: 'connecting' });
  assert.equal(next.entries.length, 0);
});

test('a recovered translation clears its stale warning without hiding other errors', () => {
  const active = { ...initialMeetingViewState, activeSessionId:'m', sessionState:'streaming' };
  const failed = reduceMeetingEvent(active,{type:'error',mode:'meeting',sessionId:'m',code:'translation_failed',message:'temporary translation warning',recoverable:true});
  const caption = {type:'meeting_caption' as const,mode:'meeting' as const,sessionId:'m',segmentId:'s',text:'Hello',translatedText:'你好',tsStartMs:1,tsEndMs:2};
  assert.equal(reduceMeetingEvent(failed,caption).lastError,null);
  const audioError = reduceMeetingEvent(active,{type:'error',mode:'meeting',sessionId:'m',code:'capture_failed',message:'audio problem',recoverable:true});
  assert.equal(reduceMeetingEvent(audioError,caption).lastError,'audio problem');
});
