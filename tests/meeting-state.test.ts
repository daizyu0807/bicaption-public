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
