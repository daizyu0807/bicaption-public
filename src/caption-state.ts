import type { CSSProperties } from 'react';
import type { AppSettings, CaptionRecord, SidecarEvent } from '../electron/types.js';

export interface CaptionViewState {
  captions: CaptionRecord[];
  partial: CaptionRecord | null;
  sessionState: string;
  activeSessionId: string | null;
  metrics: {
    inputLevel: number;
    processingLagMs: number;
    queueDepth: number;
  };
  lastError: string | null;
}

export const initialViewState: CaptionViewState = {
  captions: [],
  partial: null,
  sessionState: 'idle',
  activeSessionId: null,
  metrics: {
    inputLevel: 0,
    processingLagMs: 0,
    queueDepth: 0,
  },
  lastError: null,
};

const DUPLICATE_HISTORY_WINDOW = 6;
const DUPLICATE_TAIL_MIN_CHARS = 12;

function normalizeCaptionText(text: string | undefined) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function cleanupTrimmedCaptionText(text: string) {
  return text.replace(/[\s,.;:!?，。；：！？]+$/u, '').trim();
}

function trimRepeatedHistoryTail(
  text: string | undefined,
  captions: CaptionRecord[],
  pickText: (caption: CaptionRecord) => string | undefined,
) {
  const normalized = normalizeCaptionText(text);
  if (!normalized) {
    return '';
  }

  const recentTexts = captions
    .slice(-DUPLICATE_HISTORY_WINDOW)
    .map((caption) => normalizeCaptionText(pickText(caption)))
    .filter((value) => value.length > 0);

  for (let count = recentTexts.length; count > 0; count -= 1) {
    const candidate = recentTexts.slice(recentTexts.length - count).join(' ').trim();
    if (candidate.length < DUPLICATE_TAIL_MIN_CHARS) {
      continue;
    }
    if (!normalized.endsWith(candidate)) {
      continue;
    }

    const trimmed = cleanupTrimmedCaptionText(
      normalizeCaptionText(normalized.slice(0, normalized.length - candidate.length)),
    );
    if (!trimmed) {
      return '';
    }
    const removedRatio = candidate.length / normalized.length;
    if (removedRatio >= 0.35) {
      return trimmed;
    }
  }

  return normalized;
}

export function reduceSidecarEvent(state: CaptionViewState, event: SidecarEvent): CaptionViewState {
  if (event.mode !== 'subtitle') {
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
          segmentId: event.segmentId,
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
      const priorCaptions = state.captions.filter((caption) => caption.segmentId !== event.segmentId);
      const sourceText = trimRepeatedHistoryTail(event.sourceText, priorCaptions, (caption) => caption.sourceText);
      if (!sourceText) {
        return {
          ...state,
          partial: state.partial?.segmentId === event.segmentId ? null : state.partial,
        };
      }
      // When the first final_caption arrives (translatedText=""), preserve
      // any existing translation so subtitles don't flicker between the
      // initial emit and the translation-worker emit.
      const existing = state.captions.find((c) => c.segmentId === event.segmentId);
      const translatedText = trimRepeatedHistoryTail(
        event.translatedText || existing?.translatedText || '',
        priorCaptions,
        (caption) => caption.translatedText,
      ) || existing?.translatedText || '';
      return {
        ...state,
        partial: state.partial?.segmentId === event.segmentId ? null : state.partial,
        captions: [
          ...priorCaptions,
          {
            segmentId: event.segmentId,
            sourceText,
            translatedText,
            startedAtMs: event.startedAtMs,
            endedAtMs: event.endedAtMs,
            isFinal: true,
          },
        ],
      };
    }
    case 'metrics':
      if (!state.activeSessionId || event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        metrics: {
          inputLevel: event.inputLevel,
          processingLagMs: event.processingLagMs,
          queueDepth: event.queueDepth,
        },
      };
    case 'session_state':
      if (event.state === 'connecting') {
        return {
          ...state,
          captions: [],
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
        lastError: event.state === 'error' ? event.detail ?? 'Unknown error' : state.lastError,
      };
    case 'session_stopped_ack':
    case 'dictation_state':
    case 'dictation_final':
    case 'meeting_caption':
      return state;
    case 'error':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        lastError: event.message,
        sessionState: event.recoverable ? state.sessionState : 'error',
      };
    default:
      return state;
  }
}

export function applySettingsOverlayStyle(settings: AppSettings): CSSProperties {
  return {
    opacity: settings.overlayOpacity,
    fontSize: `${settings.overlayFontScale}rem`,
    justifyContent: settings.overlayPosition === 'top' ? 'flex-start' : 'flex-end',
  };
}
