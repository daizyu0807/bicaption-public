import type { MeetingSpeakerKind, SidecarEvent } from '../electron/types.js';

export interface MeetingCaptionRecord {
  id: string;
  turnId?: string;
  speakerId?: string;
  speakerLabel?: string;
  speakerKind?: MeetingSpeakerKind;
  speakerProfileId?: string;
  speakerMatchConfidence?: number;
  sourceText: string;
  translatedText?: string;
  sourceLang?: string;
  targetLang?: string;
  source?: 'microphone' | 'system';
  startedAtMs: number;
  endedAtMs?: number;
  isFinal: boolean;
}

export interface MeetingViewState {
  entries: MeetingCaptionRecord[];
  partial: MeetingCaptionRecord | null;
  sessionState: string;
  activeSessionId: string | null;
  lastError: string | null;
}

export const initialMeetingViewState: MeetingViewState = {
  entries: [],
  partial: null,
  sessionState: 'idle',
  activeSessionId: null,
  lastError: null,
};

function upsertMeetingEntry(entries: MeetingCaptionRecord[], nextEntry: MeetingCaptionRecord) {
  return [
    ...entries.filter((entry) => entry.id !== nextEntry.id),
    nextEntry,
  ].sort((left, right) => left.startedAtMs - right.startedAtMs);
}

export function reduceMeetingEvent(state: MeetingViewState, event: SidecarEvent): MeetingViewState {
  if (event.mode !== 'meeting') {
    return state;
  }

  switch (event.type) {
    case 'partial_caption':
      if (!state.activeSessionId || event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        partial: {
          id: event.segmentId,
          sourceText: event.sourceText,
          startedAtMs: event.startedAtMs,
          endedAtMs: event.updatedAtMs,
          isFinal: false,
        },
      };
    case 'final_caption': {
      if (!state.activeSessionId || event.sessionId !== state.activeSessionId) {
        return state;
      }
      const existing = state.entries.find((entry) => entry.id === event.segmentId);
      return {
        ...state,
        partial: state.partial?.id === event.segmentId ? null : state.partial,
        entries: [
          ...state.entries.filter((entry) => entry.id !== event.segmentId),
          {
            id: event.segmentId,
            sourceText: event.sourceText,
            translatedText: event.translatedText || existing?.translatedText || '',
            sourceLang: event.detectedLang,
            targetLang: event.translatedText ? undefined : existing?.targetLang,
            startedAtMs: event.startedAtMs,
            endedAtMs: event.endedAtMs,
            isFinal: true,
          },
        ],
      };
    }
    case 'meeting_caption': {
      if (!state.activeSessionId || event.sessionId !== state.activeSessionId) {
        return state;
      }
      const existing = state.entries.find((entry) => entry.id === event.segmentId);
      return {
        ...state,
        partial: null,
        entries: upsertMeetingEntry(state.entries, {
          id: event.segmentId,
          turnId: event.turnId,
          speakerId: event.speakerId,
          speakerLabel: event.speakerLabel,
          speakerKind: event.speakerKind,
          speakerProfileId: event.speakerProfileId,
          speakerMatchConfidence: event.speakerMatchConfidence,
          source: event.source,
          sourceLang: event.sourceLang,
          targetLang: event.targetLang,
          sourceText: event.text,
          translatedText: event.translatedText || existing?.translatedText,
          startedAtMs: event.tsStartMs,
          endedAtMs: event.tsEndMs,
          isFinal: true,
        }),
      };
    }
    case 'session_state':
      if (event.state === 'connecting') {
        return {
          ...state,
          entries: [],
          partial: null,
          activeSessionId: event.sessionId,
          sessionState: event.state,
          lastError: null,
        };
      }
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        sessionState: event.state,
        activeSessionId: event.state === 'stopped' || event.state === 'error' ? null : state.activeSessionId,
        partial: event.state === 'stopped' || event.state === 'error' ? null : state.partial,
        lastError: event.state === 'error' ? event.detail ?? 'Unknown error' : state.lastError,
      };
    case 'session_stopped_ack':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        sessionState: 'stopped',
        activeSessionId: null,
        partial: null,
      };
    case 'error':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        lastError: event.message,
        sessionState: event.recoverable ? state.sessionState : 'error',
      };
    case 'metrics':
    case 'dictation_state':
    case 'dictation_final':
      return state;
    default:
      return state;
  }
}
