import type { MeetingCopilotInsightsRequest, MeetingCopilotInsightsResult, AppleIntelligenceReply } from './types.js';
import type { AppleIntelligenceRequest } from './apple-intelligence.js';

export async function generateNativeMeetingInsights(request: MeetingCopilotInsightsRequest,
  generate: (request: AppleIntelligenceRequest) => Promise<AppleIntelligenceReply>): Promise<MeetingCopilotInsightsResult> {
  const transcript = typeof request?.transcriptText === 'string' ? request.transcriptText.trim() : '';
  if (!transcript) throw new Error('目前還沒有可分析的會議逐字稿。');
  const candidate = typeof request.targetLang === 'string' ? request.targetLang.trim() : '';
  const language = /^[a-z0-9-]{1,20}$/i.test(candidate) && candidate !== 'auto' ? candidate : 'zh-TW';
  const excerpt = transcript.slice(-2000);
  const reply = await generate({task: 'meeting-insights', text: excerpt, language, style: '', glossary: ''});
  if (reply.status !== 'ok') {
    const message = reply.reason === 'timeout' ? 'Apple 智慧產生洞察逾時，請重試。'
      : reply.reason === 'not_enabled' ? '請先在系統設定啟用 Apple Intelligence。'
      : reply.reason === 'model_not_ready' ? 'Apple 模型尚未就緒，請稍後再試。'
      : reply.reason === 'language_unsupported' ? 'Apple 智慧目前不支援這個輸出語言。'
      : 'Apple 智慧目前無法產生洞察，請稍後再試。';
    throw new Error(message);
  }
  try {
    const parsed: unknown = JSON.parse(reply.text ?? '');
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid object');
    const result = parsed as {summary: string; topics: string[]; reminders: Array<{text: string; evidence: string}>};
    if (typeof result.summary !== 'string' || !Array.isArray(result.topics) || !Array.isArray(result.reminders)
      || !result.topics.every(item => typeof item === 'string')
      || !result.reminders.every(item => item && typeof item.text === 'string' && typeof item.evidence === 'string')) throw new Error('Invalid fields');
    const key = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
    const unique = (items: string[]) => {
      const seen = new Set<string>();
      return items.filter(text => {
        const normalized = key(text);
        if (!normalized || seen.has(normalized)) return false;
        seen.add(normalized); return true;
      });
    };
    // Only topic labels receive repeated-word cleanup; factual sentences stay intact.
    const topics = unique(result.topics.map(item => item.trim().replace(/([\u3400-\u9fff]{2,8})\1+/gu, '$1'))).slice(0, 4);
    const normalizeQuote = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const source = normalizeQuote(excerpt);
    const reminders = unique(result.reminders.filter(item => {
      const quote = normalizeQuote(item.evidence);
      return quote.length >= 4 && source.includes(quote);
    }).map(item => item.text.trim())).slice(0, 3);
    return {summary: result.summary.trim(), topics, reminders};
  } catch { throw new Error('Apple 智慧回傳的洞察格式不完整，請重試。'); }
}
