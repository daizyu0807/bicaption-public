import assert from 'node:assert/strict';
import test from 'node:test';
import { generateNativeMeetingInsights } from '../electron/meeting-insights.js';

test('meeting insights use the native task and recent transcript without an API key', async () => {
  const result = await generateNativeMeetingInsights({transcriptText: 'x'.repeat(3000) + '最近討論 API', targetLang: 'zh-TW'}, async request => {
    assert.equal(request.task, 'meeting-insights');
    assert.equal(request.text.length, 2000);
    assert.ok(request.text.endsWith('最近討論 API'));
    assert.equal(request.language, 'zh-TW');
    return {status: 'ok', text: JSON.stringify({summary: ' 測試 API ', topics: ['API', ''], reminders: []})};
  });
  assert.deepEqual(result, {summary: '測試 API', topics: ['API'], reminders: []});
});

test('no transcript never calls the native model', async () => {
  await assert.rejects(generateNativeMeetingInsights({transcriptText: ' ', targetLang: 'en'}, async () => {throw new Error('must not call');}), /沒有可分析/);
});

test('auto output language resolves to Traditional Chinese', async () => {
  await generateNativeMeetingInsights({transcriptText: 'test', targetLang: 'auto'}, async request => {
    assert.equal(request.language, 'zh-TW');
    return {status: 'ok', text: '{"summary":"","topics":[],"reminders":[]}'};
  });
});

for (const [reason, message] of [['not_enabled', '啟用 Apple Intelligence'], ['model_not_ready', '尚未就緒'], ['timeout', '逾時'], ['language_unsupported', '不支援'], ['helper_missing', '無法產生洞察']]) {
  test(`${reason} gives an actionable error instead of fabricated insights`, async () => {
    await assert.rejects(generateNativeMeetingInsights({transcriptText: 'hello', targetLang: 'en'}, async () => ({status: 'error', reason})), new RegExp(message));
  });
}

test('invalid response cannot become meeting facts', async () => {
  for (const text of ['', '{}', '{"summary":42,"topics":[],"reminders":[]}', '{"summary":"test","topics":[{}],"reminders":[]}']) {
    await assert.rejects(generateNativeMeetingInsights({transcriptText: 'test', targetLang: 'en'}, async () => ({status: 'ok', text})), /格式不完整/);
  }
});

test('topic repetition and duplicate labels are removed without rewriting the summary', async () => {
  const result = await generateNativeMeetingInsights({transcriptText: '今天討論版本與 API 測試。', targetLang: 'zh-TW'}, async () => ({status: 'ok', text: JSON.stringify({
    summary: '版本版本是逐字原文，不在摘要套用重複詞替換。', topics: ['版本版本', '版本', ' API 測試 ', 'api測試。'], reminders: [],
  })}));
  assert.deepEqual(result.topics, ['版本', 'API 測試']);
  assert.equal(result.summary, '版本版本是逐字原文，不在摘要套用重複詞替換。');
});

test('reminders require a matching quote within the recent excerpt', async () => {
  const result = await generateNativeMeetingInsights({transcriptText: '發布日期還沒定。\nWe should test the API tomorrow.', targetLang: 'zh-TW'}, async () => ({status: 'ok', text: JSON.stringify({
    summary: '發布日期待確認。', topics: ['發布日期'], reminders: [
      {text: '發布日期待確認', evidence: '發布日期還沒定'},
      {text: '發布日期待確認。', evidence: '發布日期還沒定'},
      {text: '指定 Alex 下週發布', evidence: 'Alex 下週發布'},
      {text: '虛構提醒', evidence: ''},
      {text: '測試 API', evidence: 'We should test the API tomorrow.'},
    ],
  })}));
  assert.deepEqual(result.reminders, ['發布日期待確認', '測試 API']);
});

test('earlier context excluded from the native request cannot support a reminder', async () => {
  const result = await generateNativeMeetingInsights({transcriptText: '舊議題尚未確認。' + 'x'.repeat(2100), targetLang: 'zh-TW'}, async () => ({status: 'ok', text: JSON.stringify({
    summary: '', topics: [], reminders: [{text: '舊議題待確認', evidence: '舊議題尚未確認'}],
  })}));
  assert.deepEqual(result.reminders, []);
});

test('unstructured reminders are rejected instead of displayed as grounded results', async () => {
  await assert.rejects(generateNativeMeetingInsights({transcriptText: '測試', targetLang: 'zh-TW'}, async () => ({status: 'ok', text: '{"summary":"測試","topics":[],"reminders":["虛構建議"]}'})), /格式不完整/);
});
