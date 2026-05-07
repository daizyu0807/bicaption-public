import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DictationFinalEvent, DictationLearningCandidate, DictationLearningRecord } from './types.js';

const MAX_HISTORY_RECORDS = 20;

function normalizeTerm(term: string) {
  return term.trim().replace(/\s+/g, ' ');
}

function readHistory(filePath: string): DictationLearningRecord[] {
  try {
    if (!existsSync(filePath)) {
      return [];
    }
    const payload = JSON.parse(readFileSync(filePath, 'utf-8')) as DictationLearningRecord[];
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

function writeHistory(filePath: string, records: DictationLearningRecord[]) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf-8');
}

function extractInitialPromptCandidates(finalText: string): DictationLearningCandidate[] {
  const seen = new Set<string>();
  const candidates: DictationLearningCandidate[] = [];
  const matches = finalText.match(/[A-Za-z][A-Za-z0-9.+-]{1,}(?:\s+[A-Za-z0-9.+-]{1,}){0,2}/g) ?? [];
  for (const rawMatch of matches) {
    const term = normalizeTerm(rawMatch);
    const compact = term.replace(/\s+/g, '');
    const isInteresting = /[A-Z]/.test(term)
      || /^[A-Z0-9]{2,}$/.test(compact)
      || /^[A-Za-z]+(?:\s+[A-Za-z]+){1,2}$/.test(term);
    if (!isInteresting) {
      continue;
    }
    const dedupeKey = term.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    candidates.push({
      id: randomUUID(),
      term,
      kind: 'initial-prompt',
      source: 'final-text',
    });
  }
  return candidates.slice(0, 6);
}

export function buildDictationLearningCandidates(
  _literalTranscript: string,
  finalText: string,
) {
  return extractInitialPromptCandidates(finalText);
}

export function listDictationLearningRecords(filePath: string) {
  return readHistory(filePath);
}

export function appendDictationLearningRecord(
  filePath: string,
  event: DictationFinalEvent,
  sourceLang: string,
) {
  const nextRecord: DictationLearningRecord = {
    id: randomUUID(),
    sessionId: event.sessionId,
    createdAtMs: Date.now(),
    sourceLang,
    literalTranscript: event.literalTranscript,
    dictionaryText: event.dictionaryText,
    finalText: event.finalText,
    rewriteBackend: event.rewriteBackend,
    rewriteApplied: event.rewriteApplied,
    latencyMs: event.latencyMs,
    candidates: buildDictationLearningCandidates(event.literalTranscript, event.finalText),
  };
  const current = readHistory(filePath);
  writeHistory(filePath, [nextRecord, ...current].slice(0, MAX_HISTORY_RECORDS));
  return nextRecord;
}
