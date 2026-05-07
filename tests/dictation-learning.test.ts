import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDictationLearningCandidates } from '../electron/dictation-learning.ts';

test('dictation learning keeps single-run candidates in initial-prompt layer only', () => {
  const candidates = buildDictationLearningCandidates(
    '我剛剛用 vacation 測試 Tayshaun',
    '我剛剛用 BiCaption 測試 dictation',
  );

  assert.ok(candidates.every((candidate) => candidate.kind === 'initial-prompt'));
  assert.ok(candidates.some((candidate) => candidate.term === 'BiCaption'));
});

test('dictation learning keeps initial prompt candidates for interesting final terms', () => {
  const candidates = buildDictationLearningCandidates(
    '請幫我整理 llm 跟 helper 的測試',
    '請幫我整理 LLM 跟 Helper 的測試',
  );

  const promptCandidates = candidates.filter((candidate) => candidate.kind === 'initial-prompt');
  assert.ok(promptCandidates.some((candidate) => candidate.term === 'LLM'));
  assert.ok(promptCandidates.some((candidate) => candidate.term === 'Helper'));
});
