import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildDictationVocabularyFields } from '../electron/dictation-session-fields.js';

const settings = {
  dictationInitialPromptText: 'Claude, Linear',
  dictationDictionaryEnabled: true,
  dictationDictionaryText: '智慧潤飾 <= 智慧論士',
  dictationHotwords: 'BiCaption',
};

test('dictation sessions carry the initial prompt, dictionary and hotwords', () => {
  assert.deepEqual(buildDictationVocabularyFields(settings, 'dictation'), {
    dictationInitialPromptText: 'Claude, Linear',
    dictationDictionaryText: '智慧潤飾 <= 智慧論士',
    dictationHotwords: 'BiCaption',
  });
});

test('a disabled dictionary is dropped but the other terms stay', () => {
  const fields = buildDictationVocabularyFields({ ...settings, dictationDictionaryEnabled: false }, 'dictation');
  assert.equal(fields.dictationDictionaryText, undefined);
  assert.equal(fields.dictationHotwords, 'BiCaption');
});

test('subtitle and meeting sessions never receive dictation vocabulary', () => {
  for (const mode of ['subtitle', 'meeting'] as const) {
    assert.deepEqual(buildDictationVocabularyFields(settings, mode), {
      dictationInitialPromptText: undefined,
      dictationDictionaryText: undefined,
      dictationHotwords: undefined,
    });
  }
});

test('both the main-process and renderer builders spread the shared vocabulary fields', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(main, /\.\.\.buildDictationVocabularyFields\(settings, mode\)/);
  assert.match(app, /\.\.\.buildDictationVocabularyFields\(settings, mode\)/);
  assert.doesNotMatch(app, /dictationInitialPromptText: isDictation/);
});

test('without the Apple polish the final text still gets rule-based question marks', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.match(main, /if \(!settings\.dictationAppleIntelligenceEnabled\) \{[\s\S]*?applyQuestionMarks\(event\.finalText \|\| event\.literalTranscript\)/);
});
