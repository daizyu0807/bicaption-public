import type { DictationOutputAction, DictationOutputStatusEvent, SidecarEvent } from '../electron/types.js';

export interface DictationViewState {
  sessionState: string;
  dictationState: string;
  activeSessionId: string | null;
  detail: string | null;
  literalTranscript: string;
  dictionaryText: string;
  finalText: string;
  initialPromptText: string;
  matchedCorrections: string[];
  rewriteBackend: 'disabled' | 'rules' | 'cloud-llm' | 'local-llm' | null;
  rewriteApplied: boolean;
  fallbackReason: string | null;
  finalLatencyMs: number | null;
  finalChunkCount: number | null;
  outputAction: DictationOutputAction | null;
  outputStatus: DictationOutputStatusEvent['status'] | null;
  outputDetail: string | null;
  lastError: string | null;
}

export const initialDictationViewState: DictationViewState = {
  sessionState: 'idle',
  dictationState: 'idle',
  activeSessionId: null,
  detail: null,
  literalTranscript: '',
  dictionaryText: '',
  finalText: '',
  initialPromptText: '',
  matchedCorrections: [],
  rewriteBackend: null,
  rewriteApplied: false,
  fallbackReason: null,
  finalLatencyMs: null,
  finalChunkCount: null,
  outputAction: null,
  outputStatus: null,
  outputDetail: null,
  lastError: null,
};

export function reduceDictationEvent(state: DictationViewState, event: SidecarEvent): DictationViewState {
  if (event.mode !== 'dictation') {
    return state;
  }

  switch (event.type) {
    case 'session_state':
      if (event.state === 'connecting') {
        return {
          ...state,
          sessionState: event.state,
          dictationState: 'idle',
          activeSessionId: event.sessionId,
          detail: event.detail ?? null,
          literalTranscript: '',
          dictionaryText: '',
          finalText: '',
          initialPromptText: '',
          matchedCorrections: [],
          rewriteBackend: null,
          rewriteApplied: false,
          fallbackReason: null,
          finalLatencyMs: null,
          finalChunkCount: null,
          outputAction: null,
          outputStatus: null,
          outputDetail: null,
          lastError: null,
        };
      }
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        sessionState: event.state,
        detail: event.detail ?? state.detail,
        lastError: event.state === 'error' ? event.detail ?? 'Unknown error' : state.lastError,
      };
    case 'dictation_state':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        activeSessionId: state.activeSessionId ?? event.sessionId,
        dictationState: event.state,
        detail: event.detail ?? state.detail,
      };
    case 'dictation_final':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        activeSessionId: state.activeSessionId ?? event.sessionId,
        dictationState: state.dictationState === 'error' ? state.dictationState : 'done',
        detail: state.detail,
        literalTranscript: event.literalTranscript,
        dictionaryText: event.dictionaryText,
        finalText: event.finalText,
        initialPromptText: event.initialPromptText ?? '',
        matchedCorrections: event.matchedCorrections ?? [],
        rewriteBackend: event.rewriteBackend,
        rewriteApplied: event.rewriteApplied,
        fallbackReason: event.fallbackReason ?? null,
        finalLatencyMs: event.latencyMs,
        finalChunkCount: event.chunkCount ?? null,
      };
    case 'session_stopped_ack':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        sessionState: 'stopped',
      };
    case 'error':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        activeSessionId: state.activeSessionId ?? event.sessionId,
        dictationState: 'error',
        lastError: event.message,
      };
    case 'partial_caption':
    case 'final_caption':
    case 'metrics':
    case 'meeting_caption':
      return state;
    default:
      return state;
  }
}

export function reduceDictationOutputStatus(
  state: DictationViewState,
  event: DictationOutputStatusEvent,
): DictationViewState {
  return {
    ...state,
    outputAction: event.action,
    outputStatus: event.status,
    outputDetail: event.detail ?? null,
  };
}
