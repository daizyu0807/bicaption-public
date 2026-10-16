import assert from 'node:assert/strict';
import test from 'node:test';
import { polishDictationText } from '../electron/apple-intelligence.js';
import { applyQuestionMarks, finishPunctuation, stripFullWidthMarks, transplantPunctuation } from '../electron/dictation-punctuation.js';

const options = {enabled: true, language: 'zh-TW', style: 'literal', glossary: '', maxExpansionRatio: 1.3};
const polishedOptions = {...options, style: 'polished'};
const words = (value: string) => stripFullWidthMarks(value);

test('the model punctuation is placed into the original wording', () => {
  const source = '我覺得這個功能可以先上線然後再看使用者的回饋你覺得呢';
  const output = transplantPunctuation(source, '我覺得這個功能可以先上線，然後再看使用者的回饋，你覺得呢？');
  assert.equal(output, '我覺得這個功能可以先上線，然後再看使用者的回饋，你覺得呢？');
});

test('characters the model dropped, changed or translated never reach the result', () => {
  const source = '我現在是一邊看著 youtube 但好像它也都是直接進入收音中了';
  for (const model of [
    '我現在是一邊看著 youtube，但好像它也都是直接進入收音中。',                // dropped the final particle
    '我現在是一邊看著 YouTube，但似乎它也都是直接進入收音中了。',              // reworded and re-cased
    '我現在是一邊看著影片，但好像它也都是直接進入收音中了。',                  // translated a term
    '我現在是一邊看著 youtube，但好像它也都是直接進入收音中了。垃圾字元追加',   // appended junk
  ]) {
    const result = transplantPunctuation(source, model);
    assert.equal(words(result), source, model);
  }
});

test('a mark placed before a dropped particle moves behind it', () => {
  const result = transplantPunctuation('這個是收音中了', '這個是收音中。');
  assert.equal(result, '這個是收音中了。');
});

test('marks the text already had are kept even when the model does not repeat them', () => {
  const result = transplantPunctuation('先備份，再刪除', '先備份再刪除。');
  assert.equal(words(result), '先備份再刪除');
  assert.ok(result.includes('先備份，再刪除'));
});

test('finishing drops a model-added final period but keeps a question mark and an existing ending', () => {
  assert.equal(finishPunctuation('今天開會，下午三點。', '今天開會下午三點'), '今天開會，下午三點');
  assert.equal(finishPunctuation('你覺得呢？', '你覺得呢'), '你覺得呢？');
  assert.equal(finishPunctuation('好的。', '好的。'), '好的。');
  assert.equal(finishPunctuation('，今天，，開會', ''), '今天，開會');
});

test('a Chinese dictation is punctuated without any wording change', async () => {
  const calls: Array<{task?: string; text: string}> = [];
  const result = await polishDictationText('好像有問題喔現在會重複錄製了', options, async request => {
    calls.push({task: (request as {task?: string}).task, text: request.text});
    return {status: 'ok', text: '好像有問題喔，現在會重複錄製。'};
  });
  assert.deepEqual(calls, [{task: 'punctuate', text: '好像有問題喔現在會重複錄製了'}], 'one punctuation call, no free-form rewrite');
  assert.deepEqual(result, {text: '好像有問題喔，現在會重複錄製了', applied: true});
});

test('a reworded model answer cannot change the dictation wording', async () => {
  const result = await polishDictationText('好像有問題喔現在會重複錄製', options,
    async () => ({status: 'ok', text: '似乎有問題，現在會重複錄製。'}));
  assert.equal(words(result.text), '好像有問題喔現在會重複錄製');
});

test('English-only dictation keeps the original polish path', async () => {
  const tasks: Array<string | undefined> = [];
  await polishDictationText('we should test the api tomorrow', options, async request => {
    tasks.push((request as {task?: string}).task);
    return {status: 'ok', text: 'We should test the API tomorrow.'};
  });
  assert.deepEqual(tasks, [undefined]);
});

test('model failure leaves the text untouched and reports why', async () => {
  const unavailable = await polishDictationText('我覺得這個方案可以', options, async () => ({status: 'unavailable', reason: 'timeout'}));
  assert.deepEqual(unavailable, {text: '我覺得這個方案可以', applied: false, fallbackReason: 'apple_intelligence_timeout'});
  const empty = await polishDictationText('我覺得這個方案可以', options, async () => ({status: 'ok', text: ''}));
  assert.equal(empty.fallbackReason, 'apple_intelligence_invalid_output');
});


const task = (request: unknown) => (request as {task?: string}).task;

test('忠實修正 only punctuates and never asks for a rewrite', async () => {
  const tasks: Array<string | undefined> = [];
  await polishDictationText('呃我想說那個我們明天開會', options, async request => { tasks.push(task(request)); return {status: 'ok', text: request.text}; });
  assert.deepEqual(tasks, ['punctuate']);
});

test('潤飾整理 uses the tidied text when it is the input with only deletions', async () => {
  const result = await polishDictationText('呃我想說那個下週三下午三點開會', polishedOptions,
    async () => ({status: 'ok', text: '我想說下週三下午三點開會。'}));
  assert.deepEqual(result, {text: '我想說下週三下午三點開會', applied: true});
});

test('潤飾整理 falls back to punctuation when the model swaps, adds or cuts too much', async () => {
  const input = '好像有問題喔現在會重複錄製';
  for (const tidy of ['我有問題喔，現在會重複錄製。', '好像有問題喔，現在會重複錄製，已經修好了。', '現在會。']) {
    const tasks: string[] = [];
    const result = await polishDictationText(input, polishedOptions, async request => {
      tasks.push(task(request) ?? 'none');
      return {status: 'ok', text: task(request) === 'tidy' ? tidy : '好像有問題喔，現在會重複錄製。'};
    });
    assert.deepEqual(tasks, ['tidy', 'punctuate'], tidy);
    assert.equal(result.text, '好像有問題喔，現在會重複錄製', tidy);
  }
});

test('a flipped meaning is not accepted: cutting the first half of a contrast', async () => {
  const input = '我不是說要刪掉它我是說要先備份';
  const result = await polishDictationText(input, polishedOptions, async request =>
    ({status: 'ok', text: task(request) === 'tidy' ? '我不是說要先備份。' : '我不是說要刪掉它，我是說要先備份。'}));
  assert.equal(result.text, '我不是說要刪掉它，我是說要先備份');
});

test('an unavailable model is reported once and not asked a second time', async () => {
  let calls = 0;
  const result = await polishDictationText('我覺得這個方案可以', polishedOptions, async () => { calls += 1; return {status: 'unavailable', reason: 'timeout'}; });
  assert.equal(calls, 1);
  assert.equal(result.fallbackReason, 'apple_intelligence_timeout');
});

test('潤飾整理 never drops the ending, a question word or a negation', async () => {
  const cases: Array<[string, string]> = [
    ['這是你調整了什麼', '這是你調整了。'],
    ['但現在是預測會有修飾嗎為什麼我覺得有改變', '但現在是預測會有修飾，為什麼我覺得有改變。'],
    ['所以現在應該是可以直接使用才對', '現在可以直接使用。'],
    ['我不是說要刪掉它我是說要先備份', '我說要刪掉它，我是說要先備份。'],
  ];
  for (const [input, tidy] of cases) {
    const result = await polishDictationText(input, polishedOptions, async request =>
      ({status: 'ok', text: task(request) === 'tidy' ? tidy : request.text}));
    assert.equal(result.text.replace(/[，。？！、：；\s]/g, ''), input, input);
  }
});

test('a self-correction may still be removed when most of the sentence stays', async () => {
  const result = await polishDictationText('我們大家這週都有空所以下週二開會不對是下週三下午三點開會', polishedOptions,
    async () => ({status: 'ok', text: '我們大家這週都有空，所以下週三下午三點開會。'}));
  assert.equal(result.text, '我們大家這週都有空，所以下週三下午三點開會');
});

test('questions get a question mark by rule, statements that mention a question do not', () => {
  const cases: Array<[string, string]> = [
    ['你覺得這樣可以嗎', '你覺得這樣可以嗎？'],
    ['你覺得這樣可以嗎。', '你覺得這樣可以嗎？'],
    ['這個是不是可行嗎，我想想', '這個是不是可行嗎？我想想'],
    ['現在是預測會有修飾嗎為什麼我覺得被修飾過了', '現在是預測會有修飾嗎？為什麼我覺得被修飾過了？'],
    ['為什麼它還有切換的問題', '為什麼它還有切換的問題？'],
    ['這個功能什麼時候可以上線', '這個功能什麼時候可以上線？'],
    ['你有沒有看到那個錯誤訊息', '你有沒有看到那個錯誤訊息？'],
    ['我覺得這個方案可以，你覺得呢', '我覺得這個方案可以，你覺得呢？'],
    ['我不知道為什麼會這樣', '我不知道為什麼會這樣'],
    ['他問我什麼時候有空，我說下週', '他問我什麼時候有空，我說下週'],
    ['我想知道怎麼設定', '我想知道怎麼設定'],
    ['他吃了嗎啡', '他吃了嗎啡'],
    ['好像對於使用問號的判斷還是不是很準確', '好像對於使用問號的判斷還是不是很準確'],
    ['明天要不要開會我覺得可以', '明天要不要開會我覺得可以'],
    ['明天開會，大家都到了', '明天開會，大家都到了'],
  ];
  for (const [input, expected] of cases) assert.equal(applyQuestionMarks(input), expected, input);
});

test('a model-added final period after a question becomes a question mark and survives the no-final-period rule', async () => {
  const result = await polishDictationText('你覺得這樣可以嗎', options, async () => ({status: 'ok', text: '你覺得這樣可以嗎。'}));
  assert.equal(result.text, '你覺得這樣可以嗎？');
});

test('潤飾整理 may not delete a meaningful clause even when most of the text stays', async () => {
  const input = '我昨天去了公司然後看到它已經做好了應該今天就可以上線了';
  const tasks: string[] = [];
  const result = await polishDictationText(input, polishedOptions, async request => {
    tasks.push(task(request) ?? 'none');
    return {status: 'ok', text: task(request) === 'tidy'
      ? '我昨天去了公司，應該今天就可以上線了。'
      : '我昨天去了公司，然後看到它已經做好了，應該今天就可以上線了。'};
  });
  assert.deepEqual(tasks, ['tidy', 'punctuate']);
  assert.equal(result.text, '我昨天去了公司，然後看到它已經做好了，應該今天就可以上線了');
});

test('潤飾整理 may delete fillers, immediate repeats and the retracted half of a correction', async () => {
  const cases: Array<[string, string, string]> = [
    ['呃我想說那個我們大家這週都有空所以開會', '我想說我們大家這週都有空，所以開會。', '我想說我們大家這週都有空，所以開會'],
    ['我覺得這個這個功能可以先上線然後再看回饋', '我覺得這個功能可以先上線，然後再看回饋。', '我覺得這個功能可以先上線，然後再看回饋'],
    ['我們大家這週都有空所以下週二開會不對是下週三下午三點開會', '我們大家這週都有空，所以下週三下午三點開會。', '我們大家這週都有空，所以下週三下午三點開會'],
  ];
  for (const [input, tidy, expected] of cases) {
    const result = await polishDictationText(input, polishedOptions, async () => ({status: 'ok', text: tidy}));
    assert.equal(result.text, expected, input);
  }
});
