import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDefaultSubtitleTargetLang,
  isTranslationEnabled,
  resolveSttModelForSourceLang,
  resolveTargetLangForSourceLang,
  sttModelSupportsAutoDetect,
} from '../src/session-settings-logic.js';

test('resolveSttModelForSourceLang keeps the user-picked engine for fixed languages', () => {
  assert.equal(resolveSttModelForSourceLang('en', 'sensevoice'), 'sensevoice');
  assert.equal(resolveSttModelForSourceLang('zh-TW', 'apple-stt'), 'apple-stt');
  assert.equal(resolveSttModelForSourceLang('ja', 'gemini-live'), 'gemini-live');
  assert.equal(resolveSttModelForSourceLang('ko', 'groq-whisper'), 'groq-whisper');
});

test('resolveSttModelForSourceLang only corrects the invalid auto + apple-stt combination', () => {
  assert.equal(resolveSttModelForSourceLang('auto', 'apple-stt'), 'sensevoice');
  assert.equal(resolveSttModelForSourceLang('auto', 'sensevoice'), 'sensevoice');
  assert.equal(resolveSttModelForSourceLang('auto', 'gemini-live'), 'gemini-live');
  assert.equal(resolveSttModelForSourceLang('auto', 'groq-whisper'), 'groq-whisper');
});

test('sttModelSupportsAutoDetect flags apple-stt as locale-fixed', () => {
  assert.equal(sttModelSupportsAutoDetect('apple-stt'), false);
  assert.equal(sttModelSupportsAutoDetect('sensevoice'), true);
  assert.equal(sttModelSupportsAutoDetect('gemini-live'), true);
});

test('getDefaultSubtitleTargetLang pairs zh-TW with en and everything else with zh-TW', () => {
  assert.equal(getDefaultSubtitleTargetLang('zh-TW'), 'en');
  assert.equal(getDefaultSubtitleTargetLang('en'), 'zh-TW');
  assert.equal(getDefaultSubtitleTargetLang('ja'), 'zh-TW');
  assert.equal(getDefaultSubtitleTargetLang('auto'), 'zh-TW');
});

test('resolveTargetLangForSourceLang re-picks target when the new source collides with it', () => {
  assert.equal(resolveTargetLangForSourceLang('en', 'en', true), 'zh-TW');
  assert.equal(resolveTargetLangForSourceLang('zh-TW', 'zh-TW', true), 'en');
});

test('resolveTargetLangForSourceLang leaves distinct or translation-off targets alone', () => {
  assert.equal(resolveTargetLangForSourceLang('en', 'zh-TW', true), 'zh-TW');
  assert.equal(resolveTargetLangForSourceLang('en', 'en', false), 'en');
  assert.equal(resolveTargetLangForSourceLang('auto', 'zh-TW', true), 'zh-TW');
});

test('isTranslationEnabled reflects stt/translate model combinations', () => {
  const base = { sttModel: 'apple-stt', translateModel: 'google', sourceLang: 'en', targetLang: 'zh-TW' };
  assert.equal(isTranslationEnabled(base), true);
  assert.equal(isTranslationEnabled({ ...base, translateModel: 'disabled' }), false);
  assert.equal(isTranslationEnabled({ ...base, sttModel: 'gemini-live' }), true);
  assert.equal(isTranslationEnabled({ ...base, translateModel: 'gemini-live' }), false);
  assert.equal(isTranslationEnabled({ ...base, targetLang: 'en' }), false);
  assert.equal(isTranslationEnabled({ ...base, sourceLang: 'auto', targetLang: 'zh-TW' }), true);
});
