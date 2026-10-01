import test from 'node:test';
import assert from 'node:assert/strict';
import { getTranslationPairs } from '../electron/translation-languages.js';
test('Breeze prepares only its Chinese and English pairs with automatic recognition', () => {
  assert.deepEqual(getTranslationPairs('auto','en','breeze-asr-25'), [['zh-TW','en']]);
  assert.deepEqual(getTranslationPairs('auto','zh-TW','breeze-asr-25'), [['en','zh-TW']]);
  assert.deepEqual(getTranslationPairs('zh','en','breeze-asr-25'), [['zh-TW','en']]);
});
test('unsupported target is still rejected and ordinary auto keeps all supported sources', () => {
  assert.equal(getTranslationPairs('auto','fr','breeze-asr-25'), null);
  assert.equal(getTranslationPairs('invalid','en','apple-stt'), null);
  assert.equal(getTranslationPairs('auto','en','sensevoice')?.length,3);
});
