import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetingTurns } from '../src/meeting-turns.js';

test('buildMeetingTurns merges consecutive entries with the same turn id', () => {
  const turns = buildMeetingTurns([
    {
      id: 'seg-1',
      turnId: 'turn-1',
      speakerId: 'microphone',
      speakerLabel: 'Dave',
      speakerKind: 'verified-local',
      source: 'microphone',
      sourceText: 'hello',
      translatedText: '你好',
      startedAtMs: 10,
      endedAtMs: 20,
      isFinal: true,
    },
    {
      id: 'seg-2',
      turnId: 'turn-1',
      speakerId: 'microphone',
      speakerLabel: 'Dave',
      speakerKind: 'verified-local',
      source: 'microphone',
      sourceText: 'team',
      translatedText: '團隊',
      startedAtMs: 21,
      endedAtMs: 30,
      isFinal: true,
    },
    {
      id: 'seg-3',
      turnId: 'turn-2',
      speakerId: 'system',
      speakerLabel: 'Client',
      speakerKind: 'remote-default',
      source: 'system',
      sourceText: 'thanks',
      translatedText: '謝謝',
      startedAtMs: 40,
      endedAtMs: 55,
      isFinal: true,
    },
  ]);

  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0]?.segmentIds, ['seg-1', 'seg-2']);
  assert.equal(turns[0]?.sourceText, 'hello team');
  assert.equal(turns[0]?.translatedText, '你好 團隊');
  assert.equal(turns[1]?.id, 'turn-2');
});

test('buildMeetingTurns does not merge entries from different sources even with the same turn id', () => {
  const turns = buildMeetingTurns([
    {
      id: 'seg-local',
      turnId: 'turn-shared',
      speakerId: 'microphone',
      speakerLabel: '我方',
      speakerKind: 'verified-local',
      source: 'microphone',
      sourceText: '我們先看這個',
      translatedText: '',
      startedAtMs: 10,
      endedAtMs: 20,
      isFinal: true,
    },
    {
      id: 'seg-remote',
      turnId: 'turn-shared',
      speakerId: 'system',
      speakerLabel: '遠端',
      speakerKind: 'remote-default',
      source: 'system',
      sourceText: '我這邊有另一個想法',
      translatedText: '',
      startedAtMs: 21,
      endedAtMs: 30,
      isFinal: true,
    },
  ]);

  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.source, 'microphone');
  assert.equal(turns[0]?.sourceText, '我們先看這個');
  assert.equal(turns[1]?.source, 'system');
  assert.equal(turns[1]?.sourceText, '我這邊有另一個想法');
});
