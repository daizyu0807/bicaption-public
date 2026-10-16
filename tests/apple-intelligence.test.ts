import assert from 'node:assert/strict';
import test from 'node:test';
import { polishDictationText, prewarmAppleIntelligence, runAppleIntelligence } from '../electron/apple-intelligence.js';
import { initialDictationViewState, reduceDictationEvent } from '../src/dictation-state.js';

const options = {enabled: true, language: 'zh-TW', style: 'polished', glossary: 'Codex\nAPI', maxExpansionRatio: 1.3};

test('switch off returns the original output without calling the native model', async () => {
  const result = await polishDictationText('今天測試 API', {...options, enabled: false}, async () => {throw new Error('must not call');});
  assert.deepEqual(result, {text: '今天測試 API', applied: false});
});

for (const reason of ['not_enabled', 'model_not_ready', 'language_unsupported', 'timeout']) {
  test(`${reason} falls back to the existing result`, async () => {
    const result = await polishDictationText('原本辨識結果', options, async () => ({status: 'unavailable', reason}));
    assert.equal(result.text, '原本辨識結果');
    assert.equal(result.applied, false);
    assert.equal(result.fallbackReason, `apple_intelligence_${reason}`);
  });
}

test('malformed output never changes the wording of a Chinese dictation and exceptions are reported', async () => {
  for (const text of ['', '今天確認版本 3', '新增許多原文未提到的資訊'.repeat(20), '好']) {
    const result = await polishDictationText('今天確認版本 2', options, async () => ({status: 'ok', text}));
    assert.equal(result.text.replace(/[，。？！、：；\s]/g, ''), '今天確認版本2');
  }
  const result = await polishDictationText('今天確認版本 2', options, async () => {throw new Error('native failure');});
  assert.equal(result.text, '今天確認版本 2');
  assert.equal(result.fallbackReason, 'apple_intelligence_generation_failed');
});

test('oversized input avoids native generation and a missing helper falls back', async () => {
  const result = await polishDictationText('字'.repeat(3001), options, async () => {throw new Error('must not call');});
  assert.equal(result.fallbackReason, 'apple_intelligence_input_limit');
  assert.deepEqual(await runAppleIntelligence('/nonexistent/bicaption-apple-intelligence'), {status: 'unavailable', reason: 'helper_missing'});
});

test('English must not silently become Chinese or gain a generated heading', async () => {
  for (const text of ['我們應該明天測試 API 並保留版本 2。', 'Cleaned transcript: We should test the API tomorrow and keep version 2.']) {
    const result = await polishDictationText('We should test the API tomorrow and keep version 2', options, async () => ({status: 'ok', text}));
    assert.equal(result.fallbackReason, 'apple_intelligence_invalid_output');
  }
});

test('a tentative request must not become a command', async () => {
  const result = await polishDictationText('We should test the API tomorrow and keep version 2', options,
    async () => ({status: 'ok', text: 'Test the API tomorrow and keep version 2'}));
  assert.equal(result.text, 'We should test the API tomorrow and keep version 2');
  assert.equal(result.fallbackReason, 'apple_intelligence_invalid_output');
});

test('the displayed final result and history use the Apple backend', () => {
  const result = reduceDictationEvent({...initialDictationViewState, activeSessionId: 'test'}, {
    type: 'dictation_final', mode: 'dictation', sessionId: 'test', literalTranscript: '測試 API', dictionaryText: '測試 API', finalText: '測試 API。',
    rewriteBackend: 'apple-intelligence', rewriteApplied: true, startedAtMs: 0, endedAtMs: 100, latencyMs: 20,
  });
  assert.equal(result.finalText, '測試 API。');
  assert.equal(result.rewriteBackend, 'apple-intelligence');
});

test('English filler words may be dropped', async () => {
  const result = await polishDictationText('um 我們明天開會 uh', options, async () => ({status: 'ok', text: '我們明天開會。'}));
  assert.equal(result.applied, true);
});

test('unavailable and timeout replies are not retried', async () => {
  let calls = 0;
  await polishDictationText('我覺得這個方案可以', options, async () => { calls += 1; return {status: 'unavailable', reason: 'timeout'}; });
  assert.equal(calls, 1);
});

test('prewarming never throws and reports a missing helper', async () => {
  assert.equal(await prewarmAppleIntelligence('/nonexistent/bicaption-apple-intelligence'), false);
});

