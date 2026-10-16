import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../electron/settings.ts', import.meta.url), 'utf8');
const defaults = source.slice(source.indexOf('export const defaultSettings'), source.indexOf('function shouldApplyFastDictationDefaults'));

// The shipped defaults are the combination that measured best; a change here changes every fresh install.
test('fresh installs start with the best-performing engines and polish for each mode', () => {
  const expected: Array<[string, string]> = [
    ['dictationSttModel', "'breeze-gguf'"],
    ['dictationSourceLang', "'zh-TW'"],
    ['dictationRewriteMode', "'rules'"],
    ['dictationAppleIntelligenceEnabled', 'true'],
    ['dictationOutputStyle', "'polished'"],
    ['dictationOutputAction', "'copy-and-paste'"],
    ['sttModel', "'apple-stt'"],
    ['sourceLang', "'en'"],
    ['targetLang', "'zh-TW'"],
    ['translateModel', "'apple-translation'"],
    ['meetingSttModel', "'sensevoice'"],
    ['meetingSourceLang', "'auto'"],
    ['meetingTranslateModel', "'disabled'"],
  ];
  for (const [key, value] of expected) {
    assert.match(defaults, new RegExp(`\\n  ${key}: ${value},`), key);
  }
});
