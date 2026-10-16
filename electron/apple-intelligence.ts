import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AppleIntelligenceReply } from './types.js';
import { finishPunctuation, longestCommonAlignment, stripFullWidthMarks, transplantPunctuation } from './dictation-punctuation.js';

export interface PolishOptions {
  enabled: boolean;
  language: string;
  style: string;
  glossary: string;
  maxExpansionRatio: number;
}

export interface AppleIntelligenceRequest {
  text: string;
  language: string;
  style: string;
  glossary: string;
  task?: 'meeting-insights' | 'punctuate' | 'tidy';
}

export async function runAppleIntelligence(helper: string, request?: AppleIntelligenceRequest, timeout = 8000): Promise<AppleIntelligenceReply> {
  if (!existsSync(helper)) return { status: 'unavailable', reason: 'helper_missing' };
  return new Promise(resolve => {
    const child = execFile(helper, request ? [] : ['--status'], { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) { resolve({ status: 'error', reason: error.killed ? 'timeout' : 'helper_failed' }); return; }
      try {
        const reply = JSON.parse(stdout.trim()) as AppleIntelligenceReply;
        if (!['ok', 'available', 'unavailable', 'error'].includes(reply.status)) throw new Error('Invalid status');
        resolve(reply);
      } catch { resolve({status: 'error', reason: 'invalid_response'}); }
    });
    child.stdin?.on('error', () => { /* The exit callback handles an unavailable helper. */ });
    child.stdin?.end(request ? JSON.stringify(request) : undefined);
  });
}

const LEADING_FILLERS = /^(?:[\s，,。]*(?:那個|就是|嗯|呃|欸))+[\s，,。]*/u;
/** Loads the on-device model ahead of the real polish call; a cold start costs ~3s. Never throws. */
export async function prewarmAppleIntelligence(helper: string, timeout = 20_000): Promise<boolean> {
  if (!existsSync(helper)) return false;
  return new Promise(resolve => {
    execFile(helper, ['--prewarm'], { timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 }, (error, stdout) => {
      if (error) { resolve(false); return; }
      try { resolve((JSON.parse(stdout.trim()) as AppleIntelligenceReply).status === 'ok'); }
      catch { resolve(false); }
    });
  });
}

const ENGLISH_FILLERS = new Set(['um', 'uh', 'erm', 'hmm', 'mm']);

/**
 * The model sometimes answers with full-width digits (２０２６) or Latin letters (Ｏ) even though the input used
 * ASCII, because the prompt asks for full-width Chinese punctuation. Letters and digits go back to ASCII.
 */
export function normaliseFullWidthDigits(value: string) {
  return value
    .replace(/[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/(\d)\uff0e(?=\d)/g, '$1.');
}

/** English words from the input that vanished from the output, i.e. were translated or dropped. */
export function lostEnglishWords(input: string, output: string) {
  const inputWords = new Set(input.toLowerCase().match(/[a-z]+/g) ?? []);
  const outputWords = new Set(output.toLowerCase().match(/[a-z]+/g) ?? []);
  const missing = (input.toLowerCase().match(/[a-z]{3,}/g) ?? [])
    .filter(word => !ENGLISH_FILLERS.has(word) && !outputWords.has(word));
  if (!missing.length) return [];
  // A spelling fix such as "get hub" -> "GitHub" replaces words with a new English token; a translation introduces none.
  const introduced = [...outputWords].some(word => word.length >= 3 && !inputWords.has(word));
  return introduced ? [] : missing;
}

/** Speech that legitimately loses words when cleaned up: fillers, repeated phrases, self-corrections. */
const DISFLUENCY = /呃|嗯|欸|不對|我是說|我的意思是|啊不是|不是是|那個就是|就是就是|對對|(.{2,})\1|\b(?:um|uh|erm)\b/i;

// Only Chinese characters count: Latin words are covered by lostEnglishWords and digits by the number check, and a
// spelling fix such as "get hub" -> "GitHub" legitimately rewrites letters.
const comparable = (value: string) => value.replace(/[^\u3400-\u9fff]/g, '');

function longestCommonSubsequence(a: string, b: string) {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [0];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Characters of the input that are missing from the output. Measured on 100 clean Taiwanese-Mandarin sentences, the
 * on-device model's rewording (dropping 又, swapping 孩子 for 小孩) raised the character error rate from 9.4% to
 * 14%, so without a disfluency to clean up nothing may be removed or replaced.
 */
export function removedContentCount(input: string, output: string) {
  const a = comparable(input);
  const b = comparable(output);
  return a.length - longestCommonSubsequence(a, b);
}

export function hasDisfluency(input: string) {
  return DISFLUENCY.test(input);
}

export async function polishDictationText(text: string, options: PolishOptions, generate: (request: {text: string; language: string; style: string; glossary: string; task?: 'punctuate' | 'tidy'}) => Promise<AppleIntelligenceReply>) {
  if (!options.enabled || !text.trim()) return { text, applied: false };
  if (text.length > 3000) return { text, applied: false, fallbackReason: 'apple_intelligence_input_limit' };
  const request = {text, language: options.language, style: options.style, glossary: options.glossary};
  const attempt = async (input: typeof request): Promise<AppleIntelligenceReply> => {
    try { return await generate(input); }
    catch { return {status: 'error', reason: 'generation_failed'}; }
  };
  if (!/[\u3400-\u9fff]/u.test(text)) return rewriteWithModel(text, options, request, attempt);
  // Chinese: 潤飾整理 tries to keep just what the speaker meant; whatever that attempt gets wrong falls back to
  // punctuation only, which cannot change a word.
  if (options.style === 'polished') {
    const tidied = await tidyChineseText(text, request, attempt);
    if (typeof tidied === 'object' && tidied) return {text, applied: false, fallbackReason: tidied.fallbackReason};
    if (tidied) return {text: tidied, applied: tidied !== text};
  }
  return punctuateChineseText(text, request, attempt);
}

const normaliseForCompare = (value: string) => value.toLowerCase().replace(/[\s，。？！、：；,.?!]/gu, '');

const FILLER_RUN = /^(?:呃|嗯|欸|哎|唉|誒|那個|就是|對對|啊)+$/u;
const CORRECTION_MARKER = /不對|啊不是|不是是|我的意思是|我是說/u;
// "我不是說要刪掉它，我是說要備份": 我是說 here continues a contrast, it does not retract what came before.
const CONTRAST = /不是[^我]{0,12}我是說/u;

/**
 * Every run of characters the model deleted must be a filler, an immediate repeat, or the retracted part of a spoken
 * correction. Deleting any other clause ("然後看到它已經做好了") loses information even when most of the text is left.
 */
function onlyRedundantRunsDeleted(before: string, after: string) {
  const beforeChars = [...before];
  const kept = new Set(longestCommonAlignment(beforeChars, [...after]).map(([index]) => index));
  let index = 0;
  while (index < beforeChars.length) {
    if (kept.has(index)) { index += 1; continue; }
    let end = index;
    while (end < beforeChars.length && !kept.has(end)) end += 1;
    const run = beforeChars.slice(index, end).join('');
    const repeated = before.slice(Math.max(0, index - run.length), index) === run || before.slice(end, end + run.length) === run;
    const retracted = CORRECTION_MARKER.test(run) && !CONTRAST.test(before);
    if (!FILLER_RUN.test(run) && !repeated && !retracted) return false;
    index = end;
  }
  return true;
}

/**
 * The on-device model drops filler and repeats well, but it also swaps a word ("好像" became "我有") or cuts a clause
 * ("我不是說要刪掉它我是說要先備份" lost its first half and meant the opposite). So its answer is only used when it is
 * the input with some characters deleted (nothing added or changed) and at least 60% of it is left.
 */
async function tidyChineseText(
  text: string,
  request: {text: string; language: string; style: string; glossary: string},
  attempt: (input: {text: string; language: string; style: string; glossary: string; task?: 'punctuate' | 'tidy'}) => Promise<AppleIntelligenceReply>,
) {
  const reply = await attempt({...request, text: stripFullWidthMarks(text), task: 'tidy'});
  // Unavailable or timed out: the punctuation pass would fail the same way, so do not ask again.
  if (reply.status === 'unavailable') return {fallbackReason: `apple_intelligence_${reply.reason ?? 'unavailable'}`};
  if (reply.status !== 'ok' || typeof reply.text !== 'string') return null;
  const output = reply.text.trim();
  const before = normaliseForCompare(text);
  const after = normaliseForCompare(output);
  if (!after || after.length < before.length * 0.6) return null;
  if (after.length - longestCommonSubsequence(before, after) > 0) return null;
  if (!onlyRedundantRunsDeleted(before, after)) return null;
  // Deleting is only safe for filler and repeats: the ending, a question word or a negation carries the meaning.
  if (after.slice(-2) !== before.slice(-2)) return null;
  const questionWords = (value: string) => (value.match(/[嗎呢什麼哪誰怎幾沒無別未非]/gu) ?? []).length;
  if (questionWords(after) < questionWords(before)) return null;
  const negations = (value: string) => (value.match(/不/gu) ?? []).length;
  if (negations(after) < negations(before) - (before.match(/不對/gu) ?? []).length) return null;
  return finishPunctuation(output, text);
}

async function rewriteWithModel(
  text: string,
  options: PolishOptions,
  request: {text: string; language: string; style: string; glossary: string},
  attempt: (input: typeof request) => Promise<AppleIntelligenceReply>,
) {
  let reply = await attempt(request);
  // The on-device model deterministically fails on some inputs that open with a filler such as "那個"; the retry
  // drops leading fillers. Other failures are not retried.
  if (reply.status === 'error' && reply.reason === 'generation_failed') {
    reply = await attempt({...request, text: text.replace(LEADING_FILLERS, '') || text});
  }
  if (reply.status !== 'ok') return {text, applied: false, fallbackReason: `apple_intelligence_${reply.reason ?? 'unavailable'}`};
  const output = normaliseFullWidthDigits(typeof reply.text === 'string' ? reply.text.trim() : '');
  const ratio = Number.isFinite(options.maxExpansionRatio) ? Math.max(1, options.maxExpansionRatio) : 1.3;
  const numbers = (value: string) => value.match(/\d+(?:[.,]\d+)*/g) ?? [];
  const protectedEnglish = text.match(/\b(?:should|could|would|must|might|may|not|never|don't|can't|won't)\b/gi) ?? [];
  if (!output || output.length > Math.max(text.length * ratio, text.length + 12)
    || output.length < text.trim().length * 0.4
    || (!/[\u3400-\u9fff]/u.test(text) && /[\u3400-\u9fff]/u.test(output))
    || /^(?:cleaned (?:text|transcript)|整理後(?:文字|結果))\s*[:：]/i.test(output)
    || protectedEnglish.some(word => !new RegExp(`\\b${word}\\b`, 'i').test(output))
    || lostEnglishWords(text, output).length > 0
    || (!hasDisfluency(text) && removedContentCount(text, output) > 0)
    || JSON.stringify(numbers(output)) !== JSON.stringify(numbers(text))) {
    return {text, applied: false, fallbackReason: 'apple_intelligence_invalid_output'};
  }
  return {text: output, applied: output !== text};
}

/**
 * Chinese dictation: the model only adds punctuation and only its punctuation positions are used, so wording, names,
 * numbers and negations stay exactly as recognised. Measured on real Breeze output the free-form polish prompt left
 * most sentences unpunctuated and reworded the rest ("好像" became "似乎", English terms were translated).
 */
async function punctuateChineseText(
  text: string,
  request: {text: string; language: string; style: string; glossary: string},
  attempt: (input: {text: string; language: string; style: string; glossary: string; task?: 'punctuate' | 'tidy'}) => Promise<AppleIntelligenceReply>,
) {
  const base = stripFullWidthMarks(text);
  const punctuationRequest = {...request, text: base, task: 'punctuate' as const};
  let reply = await attempt(punctuationRequest);
  // The model deterministically fails on some openings; the retry drops leading fillers, and the transplant maps the
  // marks back onto the full text.
  if (reply.status === 'error' && reply.reason === 'generation_failed') {
    const trimmed = base.replace(LEADING_FILLERS, '');
    if (trimmed && trimmed !== base) reply = await attempt({...punctuationRequest, text: trimmed});
  }
  // The on-device safety check sometimes rejects an ordinary sentence outright (always the same sentence); each half
  // of it passes, so punctuate the halves separately.
  if (reply.status === 'error' && reply.reason === 'generation_failed' && [...base].length >= 8) {
    const characters = [...base];
    const middle = Math.floor(characters.length / 2);
    const first = await attempt({...punctuationRequest, text: characters.slice(0, middle).join('')});
    const second = first.status === 'ok' ? await attempt({...punctuationRequest, text: characters.slice(middle).join('')}) : first;
    if (first.status === 'ok' && second.status === 'ok' && typeof first.text === 'string' && typeof second.text === 'string') {
      reply = {status: 'ok', text: `${first.text.trim().replace(/[。？！]$/u, '，')}${second.text.trim()}`};
    }
  }
  if (reply.status !== 'ok') return {text, applied: false, fallbackReason: `apple_intelligence_${reply.reason ?? 'unavailable'}`};
  const output = typeof reply.text === 'string' ? reply.text.trim() : '';
  if (!output) return {text, applied: false, fallbackReason: 'apple_intelligence_invalid_output'};
  const result = finishPunctuation(transplantPunctuation(text, output), text);
  // Only blanks next to a new mark may differ from the input; every other character must be identical.
  if (stripFullWidthMarks(result).replace(/\s/gu, '') !== base.replace(/\s/gu, '')) return {text, applied: false, fallbackReason: 'apple_intelligence_invalid_output'};
  return {text: result, applied: result !== text};
}
