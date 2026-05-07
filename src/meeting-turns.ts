import type { MeetingCaptionRecord } from './meeting-state.js';

export interface MeetingTurnRecord extends Omit<MeetingCaptionRecord, 'id' | 'sourceText' | 'translatedText'> {
  id: string;
  segmentIds: string[];
  sourceText: string;
  translatedText?: string;
}

function appendChunkText(current: string, next: string | undefined) {
  const normalizedNext = next?.trim() ?? '';
  if (!normalizedNext) {
    return current;
  }
  if (!current) {
    return normalizedNext;
  }
  return `${current} ${normalizedNext}`.trim();
}

export function buildMeetingTurns(entries: MeetingCaptionRecord[]): MeetingTurnRecord[] {
  const turns: MeetingTurnRecord[] = [];

  for (const entry of entries) {
    const turnKey = entry.turnId || entry.id;
    const last = turns[turns.length - 1];
    const shouldMergeIntoLast = last
      && last.id === turnKey
      && last.source === entry.source;
    if (shouldMergeIntoLast) {
      last.segmentIds.push(entry.id);
      last.sourceText = appendChunkText(last.sourceText, entry.sourceText);
      last.translatedText = appendChunkText(last.translatedText ?? '', entry.translatedText);
      last.endedAtMs = entry.endedAtMs ?? last.endedAtMs;
      last.isFinal = last.isFinal && entry.isFinal;
      continue;
    }

    turns.push({
      ...entry,
      id: turnKey,
      segmentIds: [entry.id],
      sourceText: entry.sourceText.trim(),
      translatedText: entry.translatedText?.trim() || '',
    });
  }

  return turns;
}
