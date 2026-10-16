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
  rewriteBackend: 'disabled' | 'rules' | 'cloud-llm' | 'local-llm' | 'apple-intelligence' | null;
  rewriteApplied: boolean;
  fallbackReason: string | null;
  finalLatencyMs: number | null;
  finalChunkCount: number | null;
  outputAction: DictationOutputAction | null;
  outputStatus: DictationOutputStatusEvent['status'] | null;
  outputDetail: string | null;
  lastError: string | null;
  /** When the hotkey went down; lets the overlay admit that a slow microphone is not recording yet. */
  startedAtMs: number | null;
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
  startedAtMs: null,
};

export function reduceDictationEvent(state: DictationViewState, event: SidecarEvent): DictationViewState {
  if (event.mode !== 'dictation') {
    return state;
  }

  switch (event.type) {
    case 'session_state':
      // The sidecar announces "connecting" again while it loads the recogniser, after "recording" has already been
      // sent. Only the first "connecting" of a session starts over; a repeat must not push the bar back to "preparing".
      if (event.state === 'connecting' && !(state.activeSessionId && event.sessionId === state.activeSessionId)) {
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

export type DictationStageKey = 'listening' | 'transcribing' | 'polishing' | 'outputting';
export type DictationStepStatus = 'pending' | 'active' | 'done' | 'skipped';

export interface DictationProgress {
  tone: 'live' | 'processing' | 'done' | 'warning' | 'error';
  stage: DictationStageKey | 'finished' | 'error';
  title: string;
  detail: string | null;
  /** True while the user can still discard (✕) or end (✓) the recording by hand. */
  cancellable: boolean;
  steps: { key: DictationStageKey; label: string; status: DictationStepStatus }[];
}

/** Beyond this the microphone is visibly late (a Bluetooth headset can take seconds to open it). */
const MIC_SLOW_MS = 400;

const STAGE_LABELS: Record<DictationStageKey, string> = {
  listening: '收音',
  transcribing: '辨識',
  polishing: '潤飾',
  outputting: '輸出',
};

function describePasteFallback(detail: string | null): string {
  if (!detail) return '已放入剪貼簿，請手動貼上';
  if (detail.startsWith('Accessibility')) return '缺少輔助使用權限，文字在剪貼簿';
  if (detail.startsWith('Late result')) return '這是前一次聽寫的結果，已放入剪貼簿';
  if (detail.startsWith('Focus changed')) return '焦點已切換到其他 app，文字在剪貼簿';
  if (detail.startsWith('Window changed')) return '視窗已切換，文字在剪貼簿';
  if (detail.startsWith('Focused window moved')) return '視窗位置已變更，文字在剪貼簿';
  return '無法自動貼上，文字在剪貼簿';
}

function buildSteps(
  polishEnabled: boolean,
  activeIndex: number | 'all-done',
  polishSkipped = false,
): DictationProgress['steps'] {
  const keys: DictationStageKey[] = polishEnabled
    ? ['listening', 'transcribing', 'polishing', 'outputting']
    : ['listening', 'transcribing', 'outputting'];
  return keys.map((key, index) => {
    let status: DictationStepStatus;
    if (activeIndex === 'all-done') status = 'done';
    else if (index < activeIndex) status = 'done';
    else if (index === activeIndex) status = 'active';
    else status = 'pending';
    if (key === 'polishing' && polishSkipped && activeIndex === 'all-done') status = 'skipped';
    return { key, label: STAGE_LABELS[key], status };
  });
}

/** Maps the dictation view state to the stage the user should see, so every wait has a visible reason. */
export function getDictationProgress(
  state: DictationViewState,
  options: { polishEnabled: boolean; nowMs?: number },
): DictationProgress | null {
  const { polishEnabled } = options;
  const stepIndex = (key: DictationStageKey) => (polishEnabled ? ['listening', 'transcribing', 'polishing', 'outputting'] : ['listening', 'transcribing', 'outputting']).indexOf(key);

  if (state.lastError || state.dictationState === 'error') {
    return { tone: 'error', stage: 'error', title: '語音輸入中斷', detail: state.lastError, steps: [], cancellable: false };
  }
  const preparing = state.dictationState === 'preparing'
    || (state.activeSessionId && ['connecting', 'streaming'].includes(state.sessionState) && state.dictationState === 'idle');
  if (preparing) {
    const waitedMs = options.nowMs !== undefined && state.startedAtMs !== null ? options.nowMs - state.startedAtMs : 0;
    if (waitedMs >= MIC_SLOW_MS) {
      return {
        tone: 'live', stage: 'listening', title: '準備麥克風', detail: '麥克風還沒準備好，先不要說話',
        cancellable: true,
        steps: buildSteps(polishEnabled, stepIndex('listening')),
      };
    }
    return {
      tone: 'live', stage: 'listening', title: '收音中', detail: '放開快捷鍵後開始辨識',
      cancellable: true,
      steps: buildSteps(polishEnabled, stepIndex('listening')),
    };
  }
  if (state.dictationState === 'recording' || state.dictationState === 'capturing'
    || (state.activeSessionId && state.sessionState === 'connecting' && state.dictationState !== 'stopped')) {
    return {
      tone: 'live', stage: 'listening', title: '收音中', detail: '放開快捷鍵後開始辨識',
      cancellable: true,
      steps: buildSteps(polishEnabled, stepIndex('listening')),
    };
  }
  if (state.dictationState === 'processing' || state.dictationState === 'stopped'
    || (state.activeSessionId && state.sessionState === 'stopped' && !state.finalText && state.dictationState !== 'done')) {
    if (polishEnabled && state.detail?.includes('潤飾')) {
      return {
        tone: 'processing', stage: 'polishing', title: '潤飾中', detail: '整理語句與標點', cancellable: false,
        steps: buildSteps(polishEnabled, stepIndex('polishing')),
      };
    }
    return {
      tone: 'processing', stage: 'transcribing', title: '辨識中', detail: '正在把語音轉成文字', cancellable: false,
      steps: buildSteps(polishEnabled, stepIndex('transcribing')),
    };
  }
  if (state.dictationState === 'done') {
    if (!state.finalText.trim()) {
      return { tone: 'warning', stage: 'finished', title: '沒有聽到內容', detail: '請靠近麥克風再試一次', steps: [], cancellable: false };
    }
    const polishSkipped = polishEnabled && state.fallbackReason !== null;
    const skippedNote = polishSkipped ? '潤飾已略過，使用原文' : null;
    if (!state.outputStatus) {
      return {
        tone: 'processing', stage: 'outputting', title: '輸出中', detail: skippedNote, cancellable: false,
        steps: buildSteps(polishEnabled, stepIndex('outputting'), polishSkipped),
      };
    }
    const steps = buildSteps(polishEnabled, 'all-done', polishSkipped);
    if (state.outputStatus === 'fallback') {
      return {
        tone: 'warning', stage: 'finished', title: '已複製，未貼上',
        detail: describePasteFallback(state.outputDetail), cancellable: false, steps,
      };
    }
    return {
      tone: 'done', stage: 'finished',
      title: state.outputStatus === 'pasted' ? '已送出貼上' : '已複製',
      detail: skippedNote, cancellable: false, steps,
    };
  }
  return null;
}

/** Pressing the hotkey: drop the previous result at once so the overlay never flashes it before the new session reports in. */
export function reduceDictationStarting(): DictationViewState {
  return { ...initialDictationViewState, dictationState: 'preparing', startedAtMs: Date.now() };
}
