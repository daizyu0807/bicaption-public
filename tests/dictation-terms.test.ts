import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mergeCommaSeparatedTerms } from '../electron/dictation-terms.js';

test('merging terms de-duplicates case-insensitively and never writes the word undefined into the prompt', () => {
  assert.equal(mergeCommaSeparatedTerms('Claude, GitHub', 'github, Codex'), 'Claude, github, Codex', 'the newer spelling replaces the older one in place');
  assert.equal(mergeCommaSeparatedTerms(undefined as unknown as string, 'Claude'), 'Claude');
  assert.equal(mergeCommaSeparatedTerms('undefined, Claude', 'null, Codex'), 'Claude, Codex');
  assert.equal(mergeCommaSeparatedTerms('', ''), '');
});

test('the dictionary text reaches the sidecar only for dictation and only when the dictionary is enabled', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /\.\.\.buildDictationVocabularyFields\(settings, mode\)/);
  const types = readFileSync(new URL('../electron/types.ts', import.meta.url), 'utf8');
  assert.match(types, /dictationDictionaryText\?: string;/);
  assert.match(types, /dictationDictionaryEnabled: boolean;/);
  assert.match(types, /dictationDictionaryText: string;/);
});

test('the hot-word list is a separate setting that only dictation sends to the sidecar', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../electron/settings.ts', import.meta.url), 'utf8');
  assert.match(settings, /dictationHotwords: '',/);
  const types = readFileSync(new URL('../electron/types.ts', import.meta.url), 'utf8');
  assert.match(types, /dictationHotwords: string;/);
  assert.match(types, /dictationHotwords\?: string;/);
});
