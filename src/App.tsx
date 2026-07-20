import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSettings,
  CaptionConfig,
  DictationHotkeyBinding,
  DictationOutputAction,
  MeetingCopilotInsightsResult,
  MeetingSpeakerKind,
  ModelDownloadProgress,
  ModelStatus,
  SessionMode,
  SidecarEvent,
} from '../electron/types.js';
import { applySettingsOverlayStyle, initialViewState, reduceSidecarEvent } from './caption-state.js';
import { initialDictationViewState, reduceDictationEvent, reduceDictationOutputStatus } from './dictation-state.js';
import { pickPreferredInputDevice } from './device-preferences.js';
import { getDictationHotkeyLabel, isModifierOnlyHotkey, validateDictationHotkey } from './dictation-hotkey.js';
import { initialMeetingViewState, reduceMeetingEvent } from './meeting-state.js';
import { buildMeetingTurns } from './meeting-turns.js';
import {
  getDefaultSubtitleTargetLang,
  isTranslationEnabled,
  resolveSttModelForSourceLang,
  resolveTargetLangForSourceLang,
  sttModelSupportsAutoDetect,
} from './session-settings-logic.js';

const GROQ_MODEL_OPTIONS = [
  { value: 'auto', label: '自動選擇（推薦）' },
  { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
  { value: 'qwen/qwen3-32b', label: 'Qwen 3 32B' },
  { value: 'custom', label: '自訂模型' },
] as const;

function isOverlayRoute() {
  return window.location.hash === '#overlay';
}

function OverlayView({
  viewState,
  dictationState,
  settings,
  overlayMode,
}: {
  viewState: ReturnType<typeof useCaptionState>;
  dictationState: ReturnType<typeof useDictationState>;
  settings: AppSettings;
  overlayMode: 'hidden' | 'subtitle' | 'dictation';
}) {
  const overlayStyle = applySettingsOverlayStyle(settings);
  const hasVisibleCaptions = viewState.captions.length > 0 || Boolean(viewState.partial);
  const isDictationActive = ['connecting', 'streaming'].includes(dictationState.sessionState)
    || ['recording', 'capturing', 'processing'].includes(dictationState.dictationState);
  const [showDictationResult, setShowDictationResult] = useState(false);
  const shouldShowDictationPrompt = isDictationActive || showDictationResult;
  const shouldShowShell = hasVisibleCaptions
    || viewState.sessionState === 'streaming'
    || viewState.sessionState === 'connecting'
    || shouldShowDictationPrompt
    || overlayMode === 'dictation';
  const translationEnabled = isTranslationEnabled(settings);
  const stackRef = useRef<HTMLElement | null>(null);
  const overlayAutoScrollIgnoreUntil = useRef(0);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(null);
  const suppressOrbClickRef = useRef(false);
  const dictationPrompt = getDictationPrompt(dictationState, showDictationResult);
  const effectiveDictationPrompt = overlayMode === 'dictation'
    ? dictationPrompt ?? {
      tone: 'live' as const,
      title: '正在聽你說',
      detail: '按住快捷鍵說話，放開後送出辨識。',
    }
    : dictationPrompt;
  const isDictationOverlayMode = overlayMode === 'dictation';

  useEffect(() => {
    function isNearBottom() {
      const el = stackRef.current;
      if (!el) {
        return true;
      }
      return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }
    function enterManualMode(reason: string) {
      if (Date.now() < overlayAutoScrollIgnoreUntil.current) {
        return;
      }
      setIsFollowingLatest(false);
    }
    function syncManualFromPosition(reason: string) {
      window.requestAnimationFrame(() => {
        if (Date.now() < overlayAutoScrollIgnoreUntil.current) {
          return;
        }
        if (!isNearBottom()) {
          enterManualMode(reason);
        }
      });
    }
    function onWheel(event: WheelEvent) {
      if (event.deltaY < 0) {
        syncManualFromPosition('wheel-manual');
      }
    }
    function onScroll() {
      syncManualFromPosition('scroll-manual');
    }
    window.addEventListener('wheel', onWheel, { passive: true, capture: true });
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  useEffect(() => {
    if (!stackRef.current || !isFollowingLatest) {
      return;
    }
    overlayAutoScrollIgnoreUntil.current = Date.now() + 120;
    stackRef.current.scrollTop = stackRef.current.scrollHeight;
  }, [isFollowingLatest, viewState.captions, viewState.partial]);

  useEffect(() => {
    if (!dictationState.finalText) {
      return;
    }
    setShowDictationResult(true);
    const timeoutId = window.setTimeout(() => setShowDictationResult(false), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [dictationState.finalText]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.screenX - drag.startX;
      const dy = e.screenY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        suppressOrbClickRef.current = true;
      }
      window.app.setOverlayPosition(drag.winX + dx, drag.winY + dy);
    }
    function onMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  if (!shouldShowShell) {
    return <main className="overlay-window overlay-hidden" />;
  }

  async function closeOverlayAndFocusSettings() {
    await window.app.hideOverlay();
    await window.app.showSettings();
  }

  function scrollOverlayToLatest() {
    const el = stackRef.current;
    if (!el) {
      return;
    }
    overlayAutoScrollIgnoreUntil.current = Date.now() + 120;
    el.scrollTop = el.scrollHeight;
    setIsFollowingLatest(true);
  }

  if (isDictationOverlayMode && effectiveDictationPrompt) {
    return (
      <main className="overlay-window overlay-window-dictation" style={overlayStyle}>
        <section
          className={`dictation-float-shell dictation-float-shell-${effectiveDictationPrompt.tone}`}
          onMouseDown={async (e) => {
            if (!(e.target as HTMLElement).closest('.dictation-float-orb')) {
              return;
            }
            const [winX, winY] = await window.app.getOverlayPosition();
            suppressOrbClickRef.current = false;
            dragRef.current = { startX: e.screenX, startY: e.screenY, winX, winY };
          }}
        >
          <button
            className={`dictation-float-orb dictation-float-${effectiveDictationPrompt.tone}`}
            onClick={(e) => {
              if (suppressOrbClickRef.current) {
                suppressOrbClickRef.current = false;
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              void closeOverlayAndFocusSettings();
            }}
            aria-label={effectiveDictationPrompt.title}
          >
            {effectiveDictationPrompt.tone === 'live' ? (
              <>
                <span className="dictation-float-wave dictation-float-wave-a" />
                <span className="dictation-float-wave dictation-float-wave-b" />
                <span className="dictation-float-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
              </>
            ) : null}
            {effectiveDictationPrompt.tone === 'processing' ? (
              <span className="dictation-float-processing-glyph" aria-hidden="true">
                <span className="dictation-float-spinner" />
                <span className="dictation-float-dot dictation-float-dot-a" />
                <span className="dictation-float-dot dictation-float-dot-b" />
                <span className="dictation-float-dot dictation-float-dot-c" />
              </span>
            ) : null}
            {effectiveDictationPrompt.tone === 'done' ? (
              <span className="dictation-float-done-glyph" aria-hidden="true">
                <span className="dictation-float-check" />
              </span>
            ) : null}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="overlay-window" style={overlayStyle}>
      <header className="overlay-titlebar" onMouseDown={async (e) => {
        if ((e.target as HTMLElement).closest('.no-drag')) return;
        const [winX, winY] = await window.app.getOverlayPosition();
        dragRef.current = { startX: e.screenX, startY: e.screenY, winX, winY };
      }}>
        <div className="overlay-window-controls no-drag">
          <button className="traffic-light traffic-close" onClick={closeOverlayAndFocusSettings} aria-label="Hide overlay">
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <span className="overlay-title">{isDictationOverlayMode ? '語音輸入' : 'BiCaption'}</span>
        {!isDictationOverlayMode && !isFollowingLatest ? (
          <button className="overlay-follow-button no-drag" onClick={scrollOverlayToLatest}>
            回到最新
          </button>
        ) : (
          <span className="overlay-follow-spacer no-drag" aria-hidden="true" />
        )}
      </header>
      <section className={`overlay-body${isDictationOverlayMode ? ' overlay-body-prompt-only' : ''}`} ref={stackRef}>
          {shouldShowDictationPrompt && dictationPrompt && (
            <div className={`dictation-prompt dictation-prompt-${dictationPrompt.tone} no-drag`}>
              <span className="dictation-prompt-dot" aria-hidden="true">
                {dictationPrompt.tone === 'live' && (
                  <>
                    <span className="dictation-prompt-ring dictation-prompt-ring-a" />
                    <span className="dictation-prompt-ring dictation-prompt-ring-b" />
                  </>
                )}
              </span>
              <div className="dictation-prompt-copy">
                <p className="dictation-prompt-title">{dictationPrompt.title}</p>
                <p className="dictation-prompt-text">{dictationPrompt.detail}</p>
                {dictationPrompt.tone === 'processing' && (
                  <span className="dictation-prompt-progress" aria-hidden="true">
                    <span className="dictation-prompt-progress-bar" />
                  </span>
                )}
              </div>
            </div>
          )}
          {!isDictationOverlayMode ? viewState.captions.map((caption) => (
            <div key={caption.segmentId} className="caption-pair no-drag">
              <p className="caption-line">{caption.sourceText}</p>
              {translationEnabled && caption.translatedText ? (
                <p className="caption-line caption-translation">{caption.translatedText}</p>
              ) : null}
            </div>
          )) : null}
          {!isDictationOverlayMode && viewState.partial ? (
            <p className="caption-line caption-partial no-drag">{viewState.partial.sourceText}</p>
          ) : null}
          {!isDictationOverlayMode && !hasVisibleCaptions ? (
            <>
              <p className="caption-line caption-hint no-drag">Listening for speech...</p>
              <p className="caption-line caption-hint no-drag">Confirm input level is active, then captions appear here.</p>
            </>
          ) : null}
      </section>
    </main>
  );
}

function useCaptionState() {
  const [viewState, setViewState] = useState(initialViewState);

  useEffect(() => {
    if (!window.app) {
      setViewState((current) => ({
        ...current,
        sessionState: 'error',
        lastError: 'Preload API is unavailable.',
      }));
      return;
    }

    return window.app.subscribe('sidecar:event', (payload) => {
      const event = payload as SidecarEvent;
      startTransition(() => {
        setViewState((current) => reduceSidecarEvent(current, event));
      });
    });
  }, []);

  return viewState;
}

function useDictationState() {
  const [viewState, setViewState] = useState(initialDictationViewState);

  useEffect(() => {
    if (!window.app) {
      setViewState((current) => ({
        ...current,
        sessionState: 'error',
        lastError: 'Preload API is unavailable.',
      }));
      return;
    }

    return window.app.subscribe('sidecar:event', (payload) => {
      const event = payload as SidecarEvent;
      startTransition(() => {
        setViewState((current) => reduceDictationEvent(current, event));
      });
    });
  }, []);

  useEffect(() => {
    if (!window.app) {
      return;
    }
    return window.app.subscribe('dictation:output-status', (payload) => {
      startTransition(() => {
        setViewState((current) => reduceDictationOutputStatus(current, payload as {
          type: 'dictation_output_status';
          action: DictationOutputAction;
          status: 'copied' | 'pasted' | 'fallback';
          detail?: string;
        }));
      });
    });
  }, []);

  return viewState;
}

function useOverlayMode() {
  const [mode, setMode] = useState<'hidden' | 'subtitle' | 'dictation'>('hidden');

  useEffect(() => {
    if (!window.app) {
      return;
    }

    return window.app.subscribe('overlay:mode', (payload) => {
      setMode(payload.mode);
    });
  }, []);

  return mode;
}

function useMeetingState() {
  const [viewState, setViewState] = useState(initialMeetingViewState);

  useEffect(() => {
    if (!window.app) {
      setViewState((current) => ({
        ...current,
        sessionState: 'error',
        lastError: 'Preload API is unavailable.',
      }));
      return;
    }

    return window.app.subscribe('sidecar:event', (payload) => {
      const event = payload as SidecarEvent;
      startTransition(() => {
        setViewState((current) => reduceMeetingEvent(current, event));
      });
    });
  }, []);

  const clearEntries = useCallback(() => {
    setViewState((current) => ({ ...current, entries: [], partial: null }));
  }, []);

  return { ...viewState, clearEntries };
}

function getDictationPrompt(
  state: ReturnType<typeof useDictationState>,
  showResult: boolean,
): { tone: 'live' | 'processing' | 'done'; title: string; detail: string } | null {
  if (state.lastError) {
    return {
      tone: 'processing',
      title: '語音輸入中斷',
      detail: state.lastError,
    };
  }
  if (state.dictationState === 'recording') {
    return {
      tone: 'live',
      title: '正在聽你說',
      detail: '按住快捷鍵繼續說話，放開後送出辨識。',
    };
  }
  if (state.dictationState === 'capturing' || (state.activeSessionId && state.sessionState === 'connecting' && state.dictationState !== 'stopped')) {
    return {
      tone: 'live',
      title: '正在聽你說',
      detail: '持續收音中，放開後才會開始整理。',
    };
  }
  if (state.dictationState === 'processing' || state.dictationState === 'stopped' || (state.activeSessionId && state.sessionState === 'stopped' && !state.finalText)) {
    return {
      tone: 'processing',
      title: '正在整理語音',
      detail: '放開後會自動完成辨識並輸出文字。',
    };
  }
  if (state.finalText) {
    return {
      tone: 'done',
      title: '已完成語音輸入',
      detail: state.finalText,
    };
  }
  return null;
}

function isMeetingTranslationEnabled(settings: AppSettings): boolean {
  return settings.meetingTranslateModel !== 'disabled';
}

function buildSessionConfig(settings: AppSettings, mode: SessionMode = 'subtitle'): CaptionConfig {
  const isDictation = mode === 'dictation';
  const isMeeting = mode === 'meeting';
  const subtitleTranslateModel = settings.sttModel === 'gemini-live'
    ? 'gemini-live'
    : settings.translateModel === 'gemini-live'
      ? 'google'
      : settings.translateModel;
  const meetingPrimaryDeviceId = settings.meetingSourceMode === 'system-audio'
    ? settings.meetingSystemAudioDeviceId
    : settings.meetingMicDeviceId;
  const meetingSecondaryDeviceId = settings.meetingSourceMode === 'dual'
    ? settings.meetingSystemAudioDeviceId
    : '';
  return {
    mode,
    sessionId: crypto.randomUUID(),
    deviceId: isMeeting ? meetingPrimaryDeviceId : isDictation ? settings.dictationDeviceId : settings.subtitleDeviceId,
    outputDeviceId: isMeeting ? meetingSecondaryDeviceId : settings.outputDeviceId,
    sourceLang: isMeeting ? settings.meetingSourceLang : isDictation ? settings.dictationSourceLang : settings.sourceLang,
    targetLang: isMeeting ? settings.meetingTargetLang : settings.targetLang,
    sttModel: isMeeting ? settings.meetingSttModel : isDictation ? settings.dictationSttModel : settings.sttModel,
    translateModel: isMeeting ? settings.meetingTranslateModel : isDictation ? settings.translateModel : subtitleTranslateModel,
    chunkMs: isDictation ? settings.dictationChunkMs : settings.subtitleChunkMs,
    partialStableMs: isMeeting ? settings.meetingPartialStableMs : isDictation ? settings.dictationEndpointMs : settings.subtitlePartialStableMs,
    beamSize: settings.beamSize,
    bestOf: settings.bestOf,
    vadFilter: settings.vadFilter,
    conditionOnPrev: settings.conditionOnPrev,
    dictationRewriteMode: isDictation ? settings.dictationRewriteMode : undefined,
    dictationCloudEnhancementEnabled: isDictation ? settings.dictationCloudEnhancementEnabled : undefined,
    dictationOutputStyle: isDictation ? settings.dictationOutputStyle : undefined,
    dictationInitialPromptText: isDictation ? settings.dictationInitialPromptText : undefined,
    dictationVocabularyContext: undefined,
    dictationProperNounCorrectionEnabled: isDictation ? false : undefined,
    dictationPersonalGlossary: undefined,
    dictationCloudApiKey: settings.dictationCloudApiKey,
    geminiApiKey: settings.geminiApiKey,
    dictationCloudModel: settings.dictationCloudModel,
    dictationCloudLlmPrompt: isDictation ? settings.dictationCloudLlmPrompt : undefined,
    dictationMaxRewriteExpansionRatio: isDictation ? settings.dictationMaxRewriteExpansionRatio : undefined,
    dictationLocalLlmModel: isDictation ? settings.dictationLocalLlmModel : undefined,
    dictationLocalLlmRunner: isDictation ? settings.dictationLocalLlmRunner : undefined,
    dictationLocalLlmPrompt: isDictation ? settings.dictationLocalLlmPrompt : undefined,
    meetingSourceMode: isMeeting ? settings.meetingSourceMode : undefined,
    meetingSpeakerLabelsEnabled: isMeeting ? settings.meetingSpeakerLabelsEnabled : undefined,
    meetingMicrophoneLabel: isMeeting ? settings.meetingMicrophoneLabel : undefined,
    meetingSystemLabel: isMeeting ? settings.meetingSystemLabel : undefined,
    meetingNotesPrompt: isMeeting ? settings.meetingNotesPrompt : undefined,
    meetingSaveTranscript: isMeeting ? settings.meetingSaveTranscript : undefined,
    meetingTranscriptDirectory: isMeeting ? settings.meetingTranscriptDirectory : undefined,
  };
}

function getDownloadLabel(progress: ModelDownloadProgress | null): string {
  if (!progress) return '下載模型';
  if (progress.stage === 'extracting') return '解壓縮中…';
  const stageNames: Record<string, string> = { sensevoice: 'SenseVoice', 'apple-stt': 'SFSpeechRecognizer', vad: 'VAD' };
  const name = stageNames[progress.stage] ?? progress.stage;
  if (progress.totalMB > 0) {
    return `下載 ${name}… ${progress.downloadedMB}/${progress.totalMB} MB (${progress.percent}%)`;
  }
  return `下載 ${name}…`;
}

function getDictationPermissionSummary(
  accessibility: { trusted: boolean; status: string } | null,
  inputMonitoring: { trusted: boolean; available: boolean; detail?: string } | null,
) {
  if (!accessibility || !inputMonitoring) {
    return {
      label: '檢查中',
      detail: '正在確認語音輸入快捷鍵權限。',
      missing: [] as string[],
    };
  }
  const missing = [
    accessibility.trusted ? null : '輔助使用',
    inputMonitoring.trusted ? null : '輸入監控',
  ].filter((item): item is string => Boolean(item));
  if (missing.length === 0) {
    return {
      label: '已允許',
      detail: '語音輸入快捷鍵已可使用。',
      missing,
    };
  }
  const inputDetail = inputMonitoring.available === false && inputMonitoring.detail
    ? ` ${inputMonitoring.detail}`
    : '';
  return {
    label: '未授權',
    detail: `請允許 ${missing.join('、')}。完成授權後切回 BiCaption，系統會重新檢查。${inputDetail}`,
    missing,
  };
}

const MODEL_LIBRARY = [
  {
    key: 'sensevoice',
    label: 'SenseVoice',
    sizeLabel: '~0.9 GB',
    format: 'ONNX (int8)',
    description: '多語辨識主力模型，適合繁體中文、英文與混語場景。',
  },
  {
    key: 'groq-whisper',
    label: 'Groq Whisper',
    sizeLabel: 'Cloud',
    format: 'Groq API',
    description: '線上高品質 STT，適合英文專名與混語 dictation 場景。',
  },
  {
    key: 'breeze-asr-25',
    label: 'Breeze ASR 25 精準辨識',
    sizeLabel: '~3.1 GB',
    format: 'MLX / batch',
    description: '台灣中文與中英混說的本地精準辨識；聽寫放鍵或會議偵測到停頓後才產生完整文字。',
  },
  {
    key: 'vad',
    label: 'Silero VAD',
    sizeLabel: '~2 MB',
    format: 'ONNX',
    description: '語音活動偵測元件，負責切分說話片段。',
  },
] as const;

const ASR_MODEL_OPTIONS = [
  { key: 'gemini-live', label: 'Gemini 3.5 Live Translate', note: '雲端即時 STT + 翻譯' },
  { key: 'groq-whisper', label: 'Groq Whisper', note: '線上高準確 / 需網路' },
  { key: 'breeze-asr-25', label: 'Breeze ASR 25 精準辨識', note: '本地分段 / 台灣中文與混語' },
  { key: 'apple-stt', label: 'SFSpeechRecognizer', note: '本地快速' },
  { key: 'sensevoice', label: 'SenseVoice', note: '本地多語' },
] as const;

const SUBTITLE_ASR_MODEL_OPTIONS = ASR_MODEL_OPTIONS.filter((option) =>
  option.key === 'apple-stt' || option.key === 'sensevoice' || option.key === 'gemini-live');

type AppGlyphName =
  | 'subtitle'
  | 'meeting'
  | 'dictation'
  | 'models'
  | 'cloud'
  | 'waveform'
  | 'mic'
  | 'dual';

function AppGlyph({ name, size = 16 }: { name: AppGlyphName; size?: number }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (name) {
    case 'subtitle':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <rect x="3.5" y="5.5" width="17" height="13" rx="2.8" {...common} />
          <path d="M8 10h8M8 14h8" {...common} />
        </svg>
      );
    case 'meeting':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <circle cx="9" cy="9" r="2.4" {...common} />
          <circle cx="15.4" cy="9.6" r="2.4" {...common} />
          <path d="M4.7 17.2c.7-2.2 2.4-3.6 4.3-3.6 1.9 0 3.5 1.4 4.2 3.6" {...common} />
          <path d="M11.8 17.2c.6-1.7 1.9-2.8 3.6-2.8 1.6 0 3 1.1 3.8 2.8" {...common} />
        </svg>
      );
    case 'dictation':
    case 'mic':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <rect x="9" y="4.2" width="6" height="10.2" rx="3" {...common} />
          <path d="M6.8 10.8c0 3 2.3 5.2 5.2 5.2s5.2-2.2 5.2-5.2" {...common} />
          <path d="M12 16v3.6M9 19.6h6" {...common} />
        </svg>
      );
    case 'models':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <rect x="7.2" y="7.2" width="9.6" height="9.6" rx="2.2" {...common} />
          <path d="M9.5 3.8v2.4M14.5 3.8v2.4M9.5 17.8v2.4M14.5 17.8v2.4M3.8 9.5h2.4M17.8 9.5h2.4M3.8 14.5h2.4M17.8 14.5h2.4" {...common} />
        </svg>
      );
    case 'cloud':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <path d="M7.3 18.2h9.2a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.5-1.4 3.4 3.4 0 0 0 0 8.4Z" {...common} />
        </svg>
      );
    case 'waveform':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <path d="M3.8 12h2.4l1.6-3.7 3.1 8 2.4-5.5 1.7 3.2h5.2" {...common} />
        </svg>
      );
    case 'dual':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <path d="M3.6 12h2.2l1.4-3.3 2.6 6.7 2-4.5 1.4 2.7h2.4" {...common} />
          <rect x="15.2" y="6.2" width="3.8" height="6.8" rx="1.9" {...common} />
          <path d="M14.4 10.6c0 2 1.4 3.4 2.7 3.4 1.3 0 2.7-1.4 2.7-3.4M17.1 14v2.2M15.3 16.2h3.6" {...common} />
        </svg>
      );
  }
}

const SETTINGS_TAB_META = {
  subtitle: {
    title: '雙語字幕',
    english: 'Bilingual',
    icon: 'subtitle',
    description: '把系統音訊或麥克風即時轉成雙語字幕。',
  },
  meeting: {
    title: '會議字幕',
    english: 'Meeting',
    icon: 'meeting',
    description: '用雙來源收音建立可保存、可匯出的會議逐字稿。',
  },
  dictation: {
    title: '語音輸入',
    english: 'Dictation',
    icon: 'dictation',
    description: '按住說話、放開送出，讓語音直接變成可用文字。',
  },
  models: {
    title: '模型',
    english: 'Models',
    icon: 'models',
    description: '集中管理本地模型與雲端憑證。',
  },
} as const;

function getSessionStatusLabel(state: string) {
  switch (state) {
    case 'streaming':
      return '進行中';
    case 'connecting':
      return '準備中';
    case 'stopped':
      return '已停止';
    case 'error':
      return '異常';
    default:
      return '待命中';
  }
}

function getSessionStatusTone(state: string) {
  switch (state) {
    case 'streaming':
      return 'live';
    case 'connecting':
      return 'warm';
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}

function getTopStatusLabel(
  tab: 'subtitle' | 'meeting' | 'dictation' | 'models',
  options: {
    modelsReady: boolean;
    meetingModelsReady: boolean;
    readyModelCount: number;
    totalModelCount: number;
    isDictationAutosaving: boolean;
  },
) {
  switch (tab) {
    case 'subtitle':
      return options.modelsReady ? '所有模型就緒' : '需要下載模型';
    case 'meeting':
      return options.meetingModelsReady ? '會議模型就緒' : '會議模型未齊';
    case 'dictation':
      return options.isDictationAutosaving ? '設定儲存中' : '語音輸入已待命';
    case 'models':
      return `${options.readyModelCount}/${options.totalModelCount} 模型就緒`;
  }
}

function getAsrOptionsForMode(mode: SessionMode) {
  return ASR_MODEL_OPTIONS.map((option) => {
    const disabled = isAsrModelUnavailableInMode(option.key, mode);
    const note = disabled
      ? `${option.note} / 目前此情境不可用`
      : option.note;
    return {
      ...option,
      disabled,
      note,
    };
  });
}

function isAsrModelUnavailableInMode(modelKey: string, mode: SessionMode) {
  if (modelKey === 'gemini-live') {
    return mode !== 'subtitle' && mode !== 'meeting';
  }
  if (modelKey === 'breeze-asr-25') {
    return mode === 'subtitle';
  }
  return (modelKey === 'whisper-mlx' || modelKey === 'groq-whisper') && mode !== 'dictation';
}

function isModelReady(status: ModelStatus | null, key: (typeof MODEL_LIBRARY)[number]['key']) {
  switch (key) {
    case 'groq-whisper':
      return true;
    case 'sensevoice':
      return status?.sensevoice ?? false;
    case 'breeze-asr-25':
      return status?.breezeAsr ?? false;
    case 'vad':
      return status?.vad ?? false;
    default:
      return false;
  }
}

function getDictationOutputActionLabel(action: DictationOutputAction) {
  switch (action) {
    case 'copy':
      return '複製到剪貼簿';
    case 'paste':
      return '貼到目前視窗';
    case 'copy-and-paste':
      return '先複製再貼上';
  }
}

function isSessionModelReady(status: ModelStatus | null, modelKey: string) {
  const modelReadyMap: Record<string, boolean> = {
    'gemini-live': true,
    'groq-whisper': true,
    'breeze-asr-25': status?.breezeAsr ?? false,
    sensevoice: status?.sensevoice ?? false,
    'apple-stt': true,
  };
  return modelKey === 'sensevoice'
    ? Boolean(modelReadyMap[modelKey] && (status?.vad ?? true))
    : Boolean(modelReadyMap[modelKey]);
}

function getMeetingSpeakerLabel(
  settings: Pick<AppSettings, 'meetingMicrophoneLabel' | 'meetingSystemLabel'>,
  speakerKind?: MeetingSpeakerKind,
  source?: 'microphone' | 'system',
  fallbackLabel?: string,
) {
  if (speakerKind === 'verified-local') {
    return settings.meetingMicrophoneLabel || (fallbackLabel && fallbackLabel !== '我方' ? fallbackLabel : '') || '我方';
  }
  if (source === 'microphone') {
    return settings.meetingMicrophoneLabel || fallbackLabel || '我方';
  }
  if (source === 'system') {
    return settings.meetingSystemLabel || fallbackLabel || '遠端';
  }
  return fallbackLabel || '未標記';
}

function formatMeetingTimestamp(timestamp?: number) {
  if (!timestamp) {
    return '剛剛';
  }
  return new Date(timestamp).toLocaleTimeString('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMeetingInsightList(items: string[]) {
  return items.length > 0 ? items : ['尚未產生'];
}

function getDictationPrimaryKeyLabel(binding: DictationHotkeyBinding) {
  switch (binding.keyCode) {
    case 59:
      return 'Ctrl';
    case 63:
      return 'Fn';
    case 49:
      return 'Space';
    case 36:
      return 'Return';
    default:
      return getDictationHotkeyLabel(binding);
  }
}

function getRewriteBackendLabel(backend: 'disabled' | 'rules' | 'cloud-llm' | 'local-llm' | null) {
  switch (backend) {
    case 'disabled':
      return '未整理';
    case 'rules':
      return '規則整理';
    case 'cloud-llm':
      return '雲端 LLM';
    case 'local-llm':
      return '本地 LLM';
    default:
      return '尚無結果';
  }
}

function getRewriteFallbackLabel(reason: string | null) {
  switch (reason) {
    case 'cloud_rewrite_unavailable':
      return '雲端 rewrite provider 尚未接入，已回退。';
    case 'local_llm_rewrite_unavailable':
      return '本地 LLM rewrite provider 尚未接入，已回退。';
    case 'local_llm_provider_missing':
      return '找不到本地 LLM rewrite script，已回退到規則整理。';
    case 'local_llm_dependency_missing':
      return '本地 LLM 依賴未安裝，已回退到規則整理。';
    case 'local_llm_model_missing':
      return '尚未設定本地 LLM 模型，已回退到規則整理。';
    case 'local_llm_timeout':
      return '本地 LLM 回應逾時，已回退到規則整理。';
    case 'local_llm_provider_error':
      return '本地 LLM 執行失敗，已回退到規則整理。';
    case 'local_llm_invalid_response':
      return '本地 LLM 回傳格式無法解析，已回退到規則整理。';
    case 'rewrite_empty':
      return '整理結果為空，已回退到前一階段文字。';
    case 'rewrite_expanded_too_much':
      return '整理結果膨脹過多，已回退到前一階段文字。';
    case 'rewrite_dropped_dictionary_term':
      return '整理結果遺失個人詞彙表中的關鍵專有名詞，已回退到前一階段文字。';
    default:
      return null;
  }
}

function SettingsView({
  settings,
  devices,
  viewState,
  meetingViewState,
  modelStatus,
  onSave,
}: {
  settings: AppSettings;
  devices: Array<{ id: string; label: string; kind: string }>;
  viewState: ReturnType<typeof useCaptionState>;
  meetingViewState: ReturnType<typeof useMeetingState>;
  modelStatus: ModelStatus | null;
  onSave: (partial: Partial<AppSettings>) => Promise<void>;
}) {
  const [activeSettingsTab, setActiveSettingsTab] = useState<'subtitle' | 'dictation' | 'meeting' | 'models'>('subtitle');
  const [draft, setDraft] = useState(settings);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const inputDevices = devices.filter((d) => d.kind === 'input' || d.kind === 'duplex');
  const loopbackDevices = devices.filter((d) => d.kind === 'duplex');
  const [downloadProgress, setDownloadProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [localModelStatus, setLocalModelStatus] = useState(modelStatus);
  const [accessibilityPermission, setAccessibilityPermission] = useState<{ trusted: boolean; status: string } | null>(null);
  const [inputMonitoringPermission, setInputMonitoringPermission] = useState<{ trusted: boolean; available: boolean; detail?: string } | null>(null);
  const [screenRecordingPermission, setScreenRecordingPermission] = useState<{ granted: boolean; detail?: string } | null>(null);
  const [hotkeyTestError, setHotkeyTestError] = useState<string | null>(null);
  const [subtitleActionError, setSubtitleActionError] = useState<string | null>(null);
  const [dictationPermissionReadyToRestart, setDictationPermissionReadyToRestart] = useState(false);
  const dictationPermissionFlowActiveRef = useRef(false);
  const [meetingCopilotInsights, setMeetingCopilotInsights] = useState<MeetingCopilotInsightsResult | null>(null);
  const [meetingCopilotError, setMeetingCopilotError] = useState<string | null>(null);
  const [isMeetingCopilotLoading, setIsMeetingCopilotLoading] = useState(false);
  const [dictationAutosaveError, setDictationAutosaveError] = useState<string | null>(null);
  const [isDictationAutosaving, setIsDictationAutosaving] = useState(false);
  const isSubtitleStreaming = viewState.sessionState === 'streaming' || viewState.sessionState === 'connecting';
  const translationOn = isTranslationEnabled(draft);
  const meetingTranslationOn = isMeetingTranslationEnabled(draft);
  const hotkeyBinding: DictationHotkeyBinding = draft.dictationHotkey;
  const hotkeyValidation = validateDictationHotkey(hotkeyBinding);
  const dictationPermissionSummary = getDictationPermissionSummary(accessibilityPermission, inputMonitoringPermission);
  const accessibilityPermissionGranted = accessibilityPermission?.trusted === true;
  const inputMonitoringPermissionGranted = inputMonitoringPermission?.trusted === true;
  const needsDictationPermission = dictationPermissionSummary.missing.length > 0 || !accessibilityPermission || !inputMonitoringPermission;
  const showDictationPermissionCard = needsDictationPermission || dictationPermissionReadyToRestart;
  const cloudLlmEnabled = draft.dictationRewriteMode === 'rules-and-cloud';
  const localLlmEnabled = draft.dictationRewriteMode === 'rules-and-local-llm';
  const onlineSttEnabled = draft.dictationSttModel === 'groq-whisper';
  const cloudModelSelection = GROQ_MODEL_OPTIONS.some((option) => option.value === draft.dictationCloudModel)
    ? draft.dictationCloudModel
    : 'custom';
  const modelsReady = !isAsrModelUnavailableInMode(draft.sttModel, 'subtitle')
    && isSessionModelReady(localModelStatus, draft.sttModel);
  const meetingModelsReady = !isAsrModelUnavailableInMode(draft.meetingSttModel, 'meeting')
    && isSessionModelReady(localModelStatus, draft.meetingSttModel);
  const isDownloading = downloadProgress !== null;
  const subtitleModelEntries = MODEL_LIBRARY.map((entry) => ({
    ...entry,
    ready: isModelReady(localModelStatus, entry.key),
    runtimeAvailable: entry.key !== 'breeze-asr-25' || Boolean(localModelStatus?.breezeAsrRuntime),
  }));
  const subtitleAsrOptions = SUBTITLE_ASR_MODEL_OPTIONS.map((option) => {
    const disabled = draft.sourceLang === 'auto' && !sttModelSupportsAutoDetect(option.key);
    return {
      ...option,
      disabled,
      note: disabled ? `${option.note} / 不支援自動偵測` : option.note,
    };
  });
  const dictationAsrOptions = getAsrOptionsForMode('dictation').map((option) => {
    const disabled = option.disabled || (option.key === 'breeze-asr-25' && !localModelStatus?.breezeAsr);
    return {
      ...option,
      disabled,
      note: disabled && option.key === 'breeze-asr-25'
        ? '需先下載模型，且 App 必須含 Breeze runtime'
        : option.note,
    };
  });
  const meetingAsrOptions = getAsrOptionsForMode('meeting').map((option) => {
    const disabled = option.disabled
      || (option.key === 'breeze-asr-25' && !localModelStatus?.breezeAsr)
      || (draft.meetingSourceLang === 'auto' && !sttModelSupportsAutoDetect(option.key));
    return {
      ...option,
      disabled,
      note: disabled && option.key === 'breeze-asr-25'
        ? '需先下載模型，且 App 必須含 Breeze runtime'
        : disabled && !option.disabled
          ? `${option.note} / 不支援自動偵測`
          : option.note,
    };
  });
  const meetingTurns = useMemo(() => buildMeetingTurns(meetingViewState.entries), [meetingViewState.entries]);
  const isMeetingStreaming = meetingViewState.sessionState === 'streaming' || meetingViewState.sessionState === 'connecting';
  const hasMeetingTranscript = meetingViewState.entries.length > 0 || Boolean(meetingViewState.partial);
  const meetingTranscriptRef = useRef<HTMLDivElement | null>(null);
  const meetingTranscriptUserScrolledUp = useRef(false);
  const lastMeetingTranscriptScrollTop = useRef(0);
  const activeTabMeta = SETTINGS_TAB_META[activeSettingsTab];
  const readyModelCount = subtitleModelEntries.filter((entry) => entry.ready).length;
  const topStatusLabel = getTopStatusLabel(activeSettingsTab, {
    modelsReady,
    meetingModelsReady,
    readyModelCount,
    totalModelCount: subtitleModelEntries.length,
    isDictationAutosaving,
  });
  const sidebarStatuses = [
    {
      key: 'subtitle',
      label: '雙語字幕',
      english: SETTINGS_TAB_META.subtitle.english,
      icon: SETTINGS_TAB_META.subtitle.icon,
    },
    {
      key: 'meeting',
      label: '會議字幕',
      english: SETTINGS_TAB_META.meeting.english,
      icon: SETTINGS_TAB_META.meeting.icon,
    },
    {
      key: 'dictation',
      label: '語音輸入',
      english: SETTINGS_TAB_META.dictation.english,
      icon: SETTINGS_TAB_META.dictation.icon,
    },
    {
      key: 'models',
      label: '模型',
      english: SETTINGS_TAB_META.models.english,
      icon: SETTINGS_TAB_META.models.icon,
    },
  ] as const;
  function resetMeetingWorkspace() {
    meetingViewState.clearEntries();
    setMeetingCopilotInsights(null);
    setMeetingCopilotError(null);
  }

  async function handleMeetingEnd() {
    if (isMeetingStreaming) {
      await window.app.stopSession();
    }
    resetMeetingWorkspace();
  }

  function buildMeetingCopilotTranscript() {
    const finalLines = meetingTurns.map((turn) => {
      const speakerLabel = getMeetingSpeakerLabel(draft, turn.speakerKind, turn.source, turn.speakerLabel);
      return `[${formatMeetingTimestamp(turn.startedAtMs ?? turn.endedAtMs)}] ${speakerLabel}: ${turn.sourceText}`;
    });
    if (meetingViewState.partial?.sourceText) {
      const speakerLabel = getMeetingSpeakerLabel(
        draft,
        meetingViewState.partial.speakerKind,
        meetingViewState.partial.source,
        meetingViewState.partial.speakerLabel,
      );
      finalLines.push(`[正在說話] ${speakerLabel}: ${meetingViewState.partial.sourceText}`);
    }
    return finalLines.join('\n').trim();
  }

  async function handleGenerateMeetingCopilotInsights() {
    const transcriptText = buildMeetingCopilotTranscript();
    if (!transcriptText) {
      setMeetingCopilotError('目前還沒有可分析的會議逐字稿。');
      return;
    }
    setIsMeetingCopilotLoading(true);
    setMeetingCopilotError(null);
    try {
      const result = await window.app.generateMeetingCopilotInsights({
        transcriptText,
        targetLang: draft.meetingTargetLang || 'zh-TW',
      });
      setMeetingCopilotInsights(result);
    } catch (error) {
      setMeetingCopilotError(error instanceof Error ? error.message : '產生會議洞察失敗。');
    } finally {
      setIsMeetingCopilotLoading(false);
    }
  }

  useEffect(() => {
    setLocalModelStatus(modelStatus);
  }, [modelStatus]);

  useEffect(() => {
    const unsubs = [
      window.app.subscribe('models:progress', (payload) => {
        setDownloadProgress(payload as ModelDownloadProgress);
        setDownloadError(null);
      }),
      window.app.subscribe('models:done', (payload) => {
        setDownloadProgress(null);
        setLocalModelStatus(payload as ModelStatus);
      }),
      window.app.subscribe('models:error', (payload) => {
        setDownloadProgress(null);
        setDownloadError(payload as string);
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.app.checkAccessibilityPermission(),
      window.app.checkInputMonitoringPermission(),
    ]).then(([accessibility, inputMonitoring]) => {
      if (cancelled) {
        return;
      }
      setAccessibilityPermission(accessibility);
      setInputMonitoringPermission(inputMonitoring);
    }).catch((error: unknown) => {
      if (cancelled) {
        return;
      }
      setHotkeyTestError(error instanceof Error ? error.message : 'Failed to check dictation permissions');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (draft.outputDeviceId === '__screencapturekit__' || draft.meetingSystemAudioDeviceId === '__screencapturekit__') {
      window.app.checkScreenRecordingPermission().then(setScreenRecordingPermission).catch(() => {});
    }
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
    return () => {
      delete document.body.dataset.theme;
    };
  }, [theme]);

  useEffect(() => {
    const refElement = meetingTranscriptRef.current;
    if (!refElement) {
      return;
    }
    const transcriptEl = refElement;
    function isAtBottom() {
      return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 8;
    }
    function onScroll() {
      const currentScrollTop = transcriptEl.scrollTop;
      if (currentScrollTop < lastMeetingTranscriptScrollTop.current) {
        meetingTranscriptUserScrolledUp.current = true;
      } else if (isAtBottom()) {
        meetingTranscriptUserScrolledUp.current = false;
      }
      lastMeetingTranscriptScrollTop.current = currentScrollTop;
    }
    lastMeetingTranscriptScrollTop.current = transcriptEl.scrollTop;
    meetingTranscriptUserScrolledUp.current = !isAtBottom();
    transcriptEl.addEventListener('scroll', onScroll);
    return () => transcriptEl.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = meetingTranscriptRef.current;
    if (!el || meetingTranscriptUserScrolledUp.current) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [meetingViewState.entries, meetingViewState.partial]);

  async function refreshDictationPermissions(options: { markRestartWhenGranted?: boolean } = {}) {
    const [accessibility, inputMonitoring] = await Promise.all([
      window.app.checkAccessibilityPermission(),
      window.app.checkInputMonitoringPermission(),
    ]);
    setAccessibilityPermission(accessibility);
    setInputMonitoringPermission(inputMonitoring);
    if (accessibility.trusted && inputMonitoring.trusted) {
      setHotkeyTestError(null);
      if (options.markRestartWhenGranted) {
        setDictationPermissionReadyToRestart(true);
      }
    } else {
      setDictationPermissionReadyToRestart(false);
    }
    return { accessibility, inputMonitoring };
  }

  useEffect(() => {
    function refreshWhenActive() {
      if (document.visibilityState !== 'hidden') {
        refreshDictationPermissions({
          markRestartWhenGranted: dictationPermissionFlowActiveRef.current,
        }).catch(() => {});
      }
    }

    window.addEventListener('focus', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);
    return () => {
      window.removeEventListener('focus', refreshWhenActive);
      document.removeEventListener('visibilitychange', refreshWhenActive);
    };
  }, []);

  async function requestDictationPermissions() {
    setHotkeyTestError(null);
    setDictationPermissionReadyToRestart(false);
    dictationPermissionFlowActiveRef.current = true;
    try {
      let accessibility = await window.app.checkAccessibilityPermission();
      if (!accessibility.trusted) {
        accessibility = await window.app.requestAccessibilityPermission();
        setAccessibilityPermission(accessibility);
      }

      let inputMonitoring = await window.app.checkInputMonitoringPermission();
      if (!inputMonitoring.trusted) {
        inputMonitoring = await window.app.requestInputMonitoringPermission();
        setInputMonitoringPermission(inputMonitoring);
      }

      const refreshed = await refreshDictationPermissions({ markRestartWhenGranted: true });
      if (!refreshed.accessibility.trusted || !refreshed.inputMonitoring.trusted) {
        setHotkeyTestError('完成授權後切回 BiCaption，系統會重新檢查。');
        await openDictationPermissionSettings();
      }
    } catch (error) {
      setHotkeyTestError(error instanceof Error ? error.message : 'Failed to request dictation permissions');
    }
  }

  async function openDictationPermissionSettings() {
    if (!accessibilityPermission?.trusted) {
      await window.app.openAccessibilitySettings();
      return;
    }
    await window.app.openInputMonitoringSettings();
  }

  useEffect(() => {
    if (activeSettingsTab !== 'dictation') {
      return;
    }
    function onFocus() {
      void refreshDictationPermissions({ markRestartWhenGranted: needsDictationPermission });
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [activeSettingsTab, needsDictationPermission]);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    if (!['dictation', 'models'].includes(activeSettingsTab)) {
      return;
    }
    const draftSnapshot = JSON.stringify(draft);
    const settingsSnapshot = JSON.stringify(settings);
    if (draftSnapshot === settingsSnapshot) {
      setIsDictationAutosaving(false);
      return;
    }

    setIsDictationAutosaving(true);
    const timeoutId = window.setTimeout(() => {
      onSave(draft)
        .then(() => {
          setDictationAutosaveError(null);
        })
        .catch((error: unknown) => {
          setDictationAutosaveError(error instanceof Error ? error.message : 'Failed to save dictation settings');
        })
        .finally(() => {
          setIsDictationAutosaving(false);
        });
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [activeSettingsTab, draft, onSave, settings]);

  function toggleHotkeyModifier(modifier: string, checked: boolean) {
    const modifiers = checked
      ? [...new Set([...draft.dictationHotkey.modifiers, modifier])]
      : draft.dictationHotkey.modifiers.filter((item) => item !== modifier);
    setDraft({
      ...draft,
      dictationHotkey: {
        ...draft.dictationHotkey,
        modifiers,
      },
    });
  }

  const modifierOnlyHotkey = isModifierOnlyHotkey(hotkeyBinding);

  return (
    <main className="va-shell">
      <aside className="va-sidebar">
        <div className="va-sidebar-topbar">
          <div className="va-window-dots" aria-label="視窗控制">
            <button
              className="va-window-dot-button va-window-dot va-window-dot-red"
              type="button"
              onClick={() => void window.app.hideSettings()}
              aria-label="關閉視窗"
            />
            <button
              className="va-window-dot-button va-window-dot va-window-dot-yellow"
              type="button"
              onClick={() => void window.app.minimizeSettings()}
              aria-label="最小化視窗"
            />
            <button
              className="va-window-dot-button va-window-dot va-window-dot-green"
              type="button"
              onClick={() => void window.app.toggleSettingsMaximize()}
              aria-label="縮放視窗"
            />
          </div>
          <button
            className="va-theme-button"
            type="button"
            aria-label="切換主題"
            onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
          >
            {theme === 'light' ? '◐' : '◑'}
          </button>
        </div>
        <div className="va-brand">
          <p className="va-brand-wordmark"><span className="va-brand-dot" /> <span className="va-brand-text"><span className="va-brand-bi">Bi</span><span className="va-brand-caption">Caption</span></span></p>
          <p className="va-brand-kicker">Realtime Bilingual</p>
        </div>
        <div className="va-tabbar">
          {sidebarStatuses.map((tab) => (
            <button
              key={tab.key}
              className={activeSettingsTab === tab.key ? 'va-tab active' : 'va-tab'}
              onClick={() => setActiveSettingsTab(tab.key)}
            >
              <span className="va-tab-icon" aria-hidden="true"><AppGlyph name={tab.icon} /></span>
              <span className="va-tab-copy">
                <span className="va-tab-label">{tab.label}</span>
                <span className="va-tab-note">{tab.english}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="va-sidebar-footer">
          <div className="va-status-card">
            <span className="va-status-dot" aria-hidden="true" />
            <div className="va-status-copy">
              <strong>目前狀態</strong>
              <span>{isSubtitleStreaming ? '字幕視窗浮動中' : '字幕待命中'}</span>
              <span>{readyModelCount === subtitleModelEntries.length ? '所有模型已就緒' : `${readyModelCount}/${subtitleModelEntries.length} 模型已就緒`}</span>
            </div>
          </div>
        </div>
      </aside>

      <section className="va-main">
        <header className="va-header">
          <div className="va-header-copy">
            <h2 className="va-title">{activeTabMeta.title}</h2>
            <p className="va-description">{activeTabMeta.description}</p>
          </div>
          <div className="va-header-actions">
            {activeSettingsTab === 'subtitle' ? (
              <button
                className="button-secondary va-button-secondary"
                type="button"
                onClick={() => window.app.showOverlay()}
              >
                預覽字幕視窗
              </button>
            ) : null}
            <div className="va-top-pill">
              <span className="va-top-pill-check" aria-hidden="true">✓</span>
              <span>{topStatusLabel}</span>
            </div>
          </div>
        </header>

        <div className={`va-content va-content-${activeSettingsTab}`}>
        {activeSettingsTab === 'dictation' && (
        <div className="va-grid-panel va-grid-panel-dictation">
          <article className="va-card va-hero-card">
            <div className="va-dictation-hero-icon" aria-hidden="true"><AppGlyph name="mic" size={42} /></div>
            <div className="va-hero-copy">
              <span className="va-hero-badge">Push to talk</span>
              <h3 className="va-hero-title">按住快捷鍵說話</h3>
              <p className="va-hero-hint">鬆開後自動完成辨識、整理與輸出，適合高頻輸入場景。</p>
              <div className="va-keycap-row">
                {draft.dictationHotkey.modifiers.map((modifier) => (
                  <span key={modifier} className="va-keycap">
                    {modifier === 'cmd' ? '⌘' : modifier === 'shift' ? '⇧' : modifier === 'ctrl' ? '⌃' : '⌥'}
                  </span>
                ))}
                {draft.dictationHotkey.modifiers.length > 0 ? <span className="va-keycap-plus">+</span> : null}
                <span className="va-keycap">{getDictationPrimaryKeyLabel(hotkeyBinding)}</span>
                <span className="va-keycap-note">放開後整段送出</span>
              </div>
            </div>
            <div className="va-hero-toggle">
              <label className="toggle-row subtitle-toggle-row">
                <input
                  type="checkbox"
                  checked={draft.dictationEnabled}
                  onChange={(event) => setDraft({ ...draft, dictationEnabled: event.target.checked })}
                />
                <span className="sr-only">啟用語音輸入快捷鍵</span>
              </label>
            </div>
          </article>

          <article className="va-card va-card-bodyless">
            <div className="bc-card-header">
              <h3 className="bc-card-title">快捷鍵組合</h3>
              <p className="bc-card-hint">選擇主鍵和組合修飾鍵。</p>
            </div>
            <div className="bc-card-body">
              <div className="va-row">
                <div className="va-row-copy">
                  <strong>主鍵</strong>
                </div>
                <select
                  value={draft.dictationHotkey.keyCode}
                  onChange={(event) => {
                    const keyCode = Number(event.target.value);
                    setDraft({
                      ...draft,
                      dictationHotkey: {
                        ...draft.dictationHotkey,
                        keyCode,
                        modifiers: [59, 63].includes(keyCode) ? [] : draft.dictationHotkey.modifiers,
                      },
                    });
                  }}
                >
                  <option value="59">Hold Ctrl</option>
                  <option value="63">Hold Fn</option>
                  <option value="49">Space</option>
                  <option value="36">Return</option>
                </select>
              </div>
              <div className="va-divider" />
              <div className="va-row va-row-align-top">
                <div className="va-row-copy">
                  <strong>組合鍵</strong>
                  {modifierOnlyHotkey ? <p>單鍵模式下不能另外加 modifier。</p> : null}
                </div>
                <div className="va-chip-grid">
                  {[
                    { key: 'cmd', label: '⌘ Cmd' },
                    { key: 'shift', label: '⇧ Shift' },
                    { key: 'ctrl', label: '⌃ Ctrl' },
                    { key: 'alt', label: '⌥ Option' },
                  ].map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={draft.dictationHotkey.modifiers.includes(item.key) ? 'va-chip-button active' : 'va-chip-button'}
                      disabled={modifierOnlyHotkey}
                      onClick={() => toggleHotkeyModifier(item.key, !draft.dictationHotkey.modifiers.includes(item.key))}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              {showDictationPermissionCard && (
                <div className="bc-inline-permission">
                  <div className="bc-permission-header">
                    <span className="bc-permission-shield" aria-hidden="true">✓</span>
                    <div className="bc-inline-permission-copy">
                      <strong>完成語音輸入設定</strong>
                      <p>依序完成兩項權限，最後只需重新開啟一次。</p>
                    </div>
                  </div>
                  <div className="bc-permission-progress">
                    <div className={accessibilityPermissionGranted ? 'bc-permission-step complete' : 'bc-permission-step current'}>
                      <span className="bc-permission-step-marker" aria-hidden="true">{accessibilityPermissionGranted ? '✓' : '1'}</span>
                      <div className="bc-permission-step-copy">
                        <strong>輔助使用</strong>
                        <span>允許自動貼上辨識結果</span>
                      </div>
                      <span className={accessibilityPermissionGranted ? 'bc-permission-status complete' : 'bc-permission-status pending'}>
                        {accessibilityPermissionGranted ? '已允許' : '待完成'}
                      </span>
                    </div>
                    <div className={inputMonitoringPermissionGranted ? 'bc-permission-step complete' : accessibilityPermissionGranted ? 'bc-permission-step current' : 'bc-permission-step'}>
                      <span className="bc-permission-step-marker" aria-hidden="true">{inputMonitoringPermissionGranted ? '✓' : '2'}</span>
                      <div className="bc-permission-step-copy">
                        <strong>輸入監控</strong>
                        <span>允許全域快捷鍵在背景運作</span>
                      </div>
                      <span className={inputMonitoringPermissionGranted ? 'bc-permission-status complete' : 'bc-permission-status pending'}>
                        {inputMonitoringPermissionGranted ? '已允許' : '待完成'}
                      </span>
                    </div>
                  </div>
                  <div className="bc-inline-permission-actions">
                    {needsDictationPermission ? (
                      <button className="button-primary bc-permission-primary" onClick={requestDictationPermissions}>
                        {!accessibilityPermissionGranted ? '授權輔助使用' : '授權輸入監控'}
                      </button>
                    ) : null}
                    {dictationPermissionReadyToRestart ? (
                      <button className="button-primary bc-permission-primary" onClick={async () => { await window.app.relaunchApp(); }}>
                        完成授權並重新開啟
                      </button>
                    ) : null}
                    <p className="bc-permission-footnote">
                      {dictationPermissionReadyToRestart ? '兩項權限已完成，重新開啟後即可使用。' : '兩項皆完成後即可重新開啟 BiCaption。'}
                    </p>
                  </div>
                </div>
              )}
              {hotkeyValidation.error ? <p className="error-text">{hotkeyValidation.error}</p> : null}
              {!hotkeyValidation.error && hotkeyValidation.warning ? <p className="model-hint">{hotkeyValidation.warning}</p> : null}
              {hotkeyTestError ? <p className="error-text">{hotkeyTestError}</p> : null}
            </div>
          </article>

          <article className="va-card va-card-bodyless">
            <div className="bc-card-header">
              <h3 className="bc-card-title">輸出與引擎</h3>
              <p className="bc-card-hint">設定收音裝置、辨識模型與輸出方式。</p>
            </div>
            <div className="bc-card-body">
              <div className="va-row">
                <div className="va-row-copy">
                  <strong>輸入裝置</strong>
                </div>
                <select
                  value={draft.dictationDeviceId}
                  onChange={(event) => setDraft({ ...draft, dictationDeviceId: event.target.value })}
                >
                  {inputDevices.map((device) => (
                    <option key={device.id} value={device.id}>{device.label}</option>
                  ))}
                </select>
              </div>
              <div className="va-divider" />
              <div className="va-row">
                <div className="va-row-copy">
                  <strong>辨識引擎</strong>
                  <p>{draft.dictationSttModel === 'groq-whisper'
                    ? 'Groq Whisper 適合混語與專有名詞。'
                    : draft.dictationSttModel === 'breeze-asr-25'
                      ? 'Breeze 會在放開按鍵後離線批次辨識，適合台灣中文與中英混說。'
                      : 'Apple STT / 本地模型較適合快速回應。'}</p>
                </div>
                <select
                  value={draft.dictationSttModel}
                  onChange={(event) => setDraft({ ...draft, dictationSttModel: event.target.value })}
                >
                  {dictationAsrOptions.map((option) => (
                    <option key={option.key} value={option.key} disabled={option.disabled}>{option.label}（{option.note}）</option>
                  ))}
                </select>
              </div>
              <div className="va-divider" />
              <div className="va-row">
                <div className="va-row-copy">
                  <strong>輸出方式</strong>
                  {draft.dictationOutputAction !== 'copy' ? <p>自動貼上需要 Accessibility 權限。</p> : null}
                </div>
                <select
                  value={draft.dictationOutputAction}
                  onChange={(event) => setDraft({ ...draft, dictationOutputAction: event.target.value as DictationOutputAction })}
                >
                  <option value="copy">{getDictationOutputActionLabel('copy')}</option>
                  <option value="paste">{getDictationOutputActionLabel('paste')}</option>
                  <option value="copy-and-paste">{getDictationOutputActionLabel('copy-and-paste')}</option>
                </select>
              </div>
            </div>
          </article>

          <article className="va-card va-card-bodyless">
            <div className="bc-card-header">
              <h3 className="bc-card-title">LLM 潤稿</h3>
              <p className="bc-card-hint">可選擇雲端或本地 LLM，幫你修正錯字、斷句與專有名詞。</p>
            </div>
            <div className="bc-card-body">
              <div className="va-choice-grid">
                {[
                  {
                    key: 'rules-and-cloud',
                    title: 'Groq 雲端潤稿',
                    hint: '準確、快速，需 API Key',
                    icon: 'cloud',
                  },
                  {
                    key: 'rules-and-local-llm',
                    title: '本地 LLM 潤稿',
                    hint: 'Qwen 2.5 3B · 完全離線',
                    icon: 'models',
                  },
                ].map((option) => {
                  const active = draft.dictationRewriteMode === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      className={active ? 'va-choice-card active' : 'va-choice-card'}
                      onClick={() => setDraft({
                        ...draft,
                        dictationRewriteMode: active ? 'rules' : option.key as AppSettings['dictationRewriteMode'],
                        dictationCloudEnhancementEnabled: option.key === 'rules-and-cloud' ? !active : false,
                      })}
                    >
                      <span className={active ? 'va-choice-icon active' : 'va-choice-icon'} aria-hidden="true">
                        <AppGlyph name={option.icon as AppGlyphName} />
                      </span>
                      <span className="va-choice-copy">
                        <strong>{option.title}</strong>
                        <span>{option.hint}</span>
                      </span>
                      <span className={active ? 'va-choice-check active' : 'va-choice-check'} aria-hidden="true">✓</span>
                    </button>
                  );
                })}
              </div>
              {(cloudLlmEnabled || onlineSttEnabled) && (
                <>
                  <div className="va-divider" />
                  <div className="va-stack-row">
                    <div className="va-row-copy">
                      <strong>Groq API Key</strong>
                      <p>{onlineSttEnabled ? '同時提供線上 STT 與雲端整理。' : '僅用於雲端文字整理。'}</p>
                    </div>
                    <input
                      type="password"
                      value={draft.dictationCloudApiKey}
                      onChange={(event) => setDraft({ ...draft, dictationCloudApiKey: event.target.value })}
                      placeholder="gsk_..."
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                </>
              )}
              {(cloudLlmEnabled || localLlmEnabled) && (
                <>
                  <div className="va-divider" />
                  <div className="va-row va-row-align-top">
                    <div className="va-row-copy">
                      <strong>處理模式</strong>
                      <p>忠實修正只修錯字；潤飾整理會幫你做語句整理。</p>
                    </div>
                    <div className="va-segmented" role="tablist" aria-label="處理模式">
                      <button
                        type="button"
                        className={draft.dictationOutputStyle === 'literal' ? 'va-segmented-button active' : 'va-segmented-button'}
                        onClick={() => setDraft({ ...draft, dictationOutputStyle: 'literal' })}
                      >
                        忠實修正
                      </button>
                      <button
                        type="button"
                        className={draft.dictationOutputStyle === 'polished' ? 'va-segmented-button active' : 'va-segmented-button'}
                        onClick={() => setDraft({ ...draft, dictationOutputStyle: 'polished' })}
                      >
                        潤飾整理
                      </button>
                    </div>
                  </div>
                  <div className="va-divider" />
                  <div className="va-stack-row">
                    <div className="va-row-copy">
                      <strong>潤稿 Prompt</strong>
                      <p>可用變數：{'{language_label}'} {'{style_label}'} {'{literal_transcript}'}</p>
                    </div>
                    <textarea
                      className="va-prompt-textarea"
                      rows={4}
                      value={cloudLlmEnabled ? draft.dictationCloudLlmPrompt : draft.dictationLocalLlmPrompt}
                      onChange={(event) => setDraft({
                        ...draft,
                        dictationCloudLlmPrompt: event.target.value,
                        dictationLocalLlmPrompt: event.target.value,
                      })}
                      placeholder="輸入你的潤稿 Prompt..."
                    />
                  </div>
                </>
              )}
            </div>
          </article>
        </div>
        )}

        {activeSettingsTab === 'subtitle' && (
        <div className="subtitle-workspace settings-content-grid">
          <div className="subtitle-grid-panel">
            <article className="va-card subtitle-language-card">
              <div className="bc-card-header">
                <h3 className="bc-card-title">語言 / Languages</h3>
                <p className="bc-card-hint">辨識來源語言，並選擇翻譯目標。</p>
              </div>
              <div className="subtitle-language-body">
                <div className="subtitle-language-box">
                  <span className="subtitle-language-label">來源</span>
                  <div className="subtitle-language-row">
                    <span className="subtitle-language-badge subtitle-language-badge-source">
                      {draft.sourceLang === 'auto' ? '🌐' : draft.sourceLang === 'zh-TW' ? '繁' : draft.sourceLang === 'ja' ? '日' : draft.sourceLang === 'ko' ? '한' : 'EN'}
                    </span>
                    <select value={draft.sourceLang} onChange={(event) => {
                      const lang = event.target.value;
                      setDraft({
                        ...draft,
                        sourceLang: lang,
                        sttModel: resolveSttModelForSourceLang(lang, draft.sttModel),
                        targetLang: resolveTargetLangForSourceLang(lang, draft.targetLang, isTranslationEnabled(draft)),
                      });
                    }}>
                      <option value="auto">自動偵測</option>
                      <option value="en">English</option>
                      <option value="zh-TW">繁體中文</option>
                      <option value="ja">日本語</option>
                      <option value="ko">한국어</option>
                    </select>
                  </div>
                </div>
                <div className="subtitle-language-arrow" aria-hidden="true">→</div>
                <div className={`subtitle-language-box${translationOn ? '' : ' subtitle-language-box-disabled'}`}>
                  <span className="subtitle-language-label">翻譯成</span>
                  <div className="subtitle-language-row">
                    <span className="subtitle-language-badge subtitle-language-badge-target">
                      {draft.targetLang === 'zh-TW' ? '繁' : draft.targetLang === 'ja' ? '日' : draft.targetLang === 'ko' ? '한' : 'EN'}
                    </span>
                    <select value={draft.targetLang} onChange={(event) => setDraft({ ...draft, targetLang: event.target.value })} disabled={!translationOn}>
                      <option value="zh-TW">繁體中文</option>
                      <option value="en">English</option>
                      <option value="ja">日本語</option>
                      <option value="ko">한국어</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className="subtitle-language-footer">
                <div>
                  <strong className="subtitle-language-footer-title">啟用雙語字幕</strong>
                  <p className="subtitle-language-footer-hint">原文和譯文同時顯示在浮動視窗。</p>
                </div>
                <label className="toggle-row subtitle-toggle-row">
                  <input
                    type="checkbox"
                    checked={translationOn}
                    disabled={draft.sttModel === 'gemini-live'}
                    onChange={(event) => setDraft({
                      ...draft,
                      translateModel: event.target.checked ? 'google' : 'disabled',
                      targetLang: event.target.checked
                        ? (draft.targetLang === draft.sourceLang
                          ? getDefaultSubtitleTargetLang(draft.sourceLang)
                          : draft.targetLang)
                        : draft.targetLang,
                    })}
                  />
                  <span className="sr-only">啟用雙語字幕</span>
                </label>
              </div>
            </article>

            <article className="va-card va-card-bodyless">
              <div className="bc-card-header">
                <h3 className="bc-card-title">音訊來源</h3>
                <p className="bc-card-hint">字幕會依照這些裝置辨識。</p>
              </div>
              <div className="bc-card-body">
                <div className="bc-device-row">
                  <div className="bc-device-copy">
                    <span className="bc-device-icon bc-device-icon-rose">◍</span>
                    <div>
                      <strong>麥克風</strong>
                    </div>
                  </div>
                  <select
                    value={draft.subtitleDeviceId}
                    onChange={(event) => setDraft({ ...draft, subtitleDeviceId: event.target.value })}
                  >
                    <option value="__disabled__">停用</option>
                    {inputDevices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="bc-row-divider" />
                <div className="bc-device-row">
                  <div className="bc-device-copy">
                    <span className="bc-device-icon bc-device-icon-sky">⋯</span>
                    <div>
                      <strong>系統音訊</strong>
                      <p>用於捕捉會議軟體或影片的聲音。</p>
                    </div>
                  </div>
                  <select value={draft.outputDeviceId} onChange={(event) => {
                    const value = event.target.value;
                    setDraft({ ...draft, outputDeviceId: value });
                    if (value === '__screencapturekit__') {
                      window.app.checkScreenRecordingPermission().then(setScreenRecordingPermission).catch(() => {});
                    }
                  }}>
                    <option value="__screencapturekit__">系統音訊（免切換）</option>
                    <option value="">停用</option>
                    {loopbackDevices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                </div>
                {draft.outputDeviceId === '__screencapturekit__' && screenRecordingPermission !== null && !screenRecordingPermission.granted && (
                  <div className="bc-inline-permission">
                    <div className="bc-inline-permission-copy">
                      <strong className="hotkey-permission-missing">螢幕錄製未授權</strong>
                      <p>請在系統設定允許 BiCaption 使用螢幕與系統音訊錄製。</p>
                    </div>
                    <div className="bc-inline-permission-actions">
                      <button
                        className="secondary"
                        onClick={async () => {
                          setSubtitleActionError(null);
                          const result = await window.app.requestScreenRecordingPermission();
                          setScreenRecordingPermission(result);
                          if (!result.granted) {
                            setSubtitleActionError(result.detail ?? '完成授權後切回 BiCaption，系統會重新檢查。');
                            await window.app.openScreenRecordingSettings();
                          }
                        }}
                      >
                        授權
                      </button>
                    </div>
                    {subtitleActionError && <p className="error-text">{subtitleActionError}</p>}
                  </div>
                )}
              </div>
            </article>

            <article className="va-card va-card-bodyless">
              <div className="bc-card-header">
                <h3 className="bc-card-title">浮動視窗外觀</h3>
                <p className="bc-card-hint">調整字幕視窗的透明度與字體大小。</p>
              </div>
              <div className="bc-card-body">
                <div className="bc-slider-row">
                  <div className="bc-slider-copy">
                    <strong>透明度</strong>
                  </div>
                  <div className="bc-slider-control">
                    <input type="range" min="0.3" max="1" step="0.05" value={draft.overlayOpacity} onChange={(event) => setDraft({ ...draft, overlayOpacity: Number(event.target.value) })} />
                    <span>{Math.round(draft.overlayOpacity * 100)}%</span>
                  </div>
                </div>
                <div className="bc-row-divider" />
                <div className="bc-slider-row">
                  <div className="bc-slider-copy">
                    <strong>字體大小</strong>
                  </div>
                  <div className="bc-slider-control">
                    <input type="range" min="0.8" max="1.8" step="0.1" value={draft.overlayFontScale} onChange={(event) => setDraft({ ...draft, overlayFontScale: Number(event.target.value) })} />
                    <span>{draft.overlayFontScale.toFixed(1)}×</span>
                  </div>
                </div>
                <div className="bc-row-divider" />
                <div className="bc-slider-row">
                  <div className="bc-slider-copy">
                    <strong>翻譯觸發延遲</strong>
                    <p>讓句子停穩多久後再翻譯。太短會頻繁重譯。</p>
                  </div>
                  <div className="bc-slider-control">
                    <input type="range" min="200" max="2000" step="100" value={draft.partialStableMs} onChange={(event) => setDraft({ ...draft, partialStableMs: Number(event.target.value) })} />
                    <span>{draft.partialStableMs}ms</span>
                  </div>
                </div>
              </div>
            </article>

            <article className="va-card va-card-bodyless">
              <div className="bc-card-header">
                <h3 className="bc-card-title">辨識引擎</h3>
                <p className="bc-card-hint">依需求選擇；來源語言為自動偵測時，僅能使用支援多語的引擎。</p>
              </div>
              <div className="bc-card-body">
                <div className="bc-simple-row">
                  <div className="bc-simple-copy">
                    <strong>語音辨識</strong>
                    <p>
                      {draft.sttModel === 'apple-stt'
                        ? 'Apple STT：本地、最快，固定語言優先。'
                        : draft.sttModel === 'sensevoice'
                          ? 'SenseVoice：本地多語，可處理混語場景。'
                          : draft.sttModel === 'gemini-live'
                            ? 'Gemini Live Translate：雲端即時收音、辨識並翻譯，需網路。'
                            : 'Groq Whisper：雲端高品質，需網路。'}
                    </p>
                  </div>
                  <select
                    value={draft.sttModel}
                    onChange={(event) => {
                      const nextModel = event.target.value;
                      setDraft({
                        ...draft,
                        sttModel: nextModel,
                        translateModel: nextModel === 'gemini-live'
                          ? 'gemini-live'
                          : draft.translateModel === 'gemini-live'
                            ? 'google'
                            : draft.translateModel,
                      });
                    }}
                  >
                    {subtitleAsrOptions.map((option) => (
                      <option key={option.key} value={option.key} disabled={option.disabled}>{option.label}（{option.note}）</option>
                    ))}
                  </select>
                </div>
                {draft.sttModel === 'groq-whisper' && (
                  <div className="bc-inline-field">
                    <label className="settings-label">
                      <span>Groq API Key</span>
                      <input
                        type="password"
                        value={draft.dictationCloudApiKey}
                        onChange={(event) => setDraft({ ...draft, dictationCloudApiKey: event.target.value })}
                        placeholder="gsk_..."
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <p className="model-hint">Groq Whisper 會把字幕音訊送到雲端做語音辨識；翻譯仍維持你目前的翻譯引擎設定。</p>
                  </div>
                )}
                {draft.sttModel === 'gemini-live' && (
                  <div className="bc-inline-field">
                    <label className="settings-label">
                      <span>Gemini API Key</span>
                      <input
                        type="password"
                        value={draft.geminiApiKey}
                        onChange={(event) => setDraft({ ...draft, geminiApiKey: event.target.value })}
                        placeholder="AIza..."
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <p className="model-hint">Gemini Live Translate 會把字幕音訊送到 Gemini 雲端做即時 STT 與翻譯。</p>
                  </div>
                )}
              </div>
            </article>

            <article className="va-card va-card-bodyless">
              <div className="bc-card-header">
                <h3 className="bc-card-title">儲存字幕</h3>
                <p className="bc-card-hint">每次會話結束後自動匯出 .txt。</p>
              </div>
              <div className="bc-card-body">
                <div className="bc-simple-row">
                  <div className="bc-simple-copy">
                    <strong>儲存字幕記錄</strong>
                  </div>
                  <label className="toggle-row subtitle-toggle-row">
                    <input type="checkbox" checked={draft.saveEnabled} onChange={(event) => setDraft({ ...draft, saveEnabled: event.target.checked })} />
                    <span className="sr-only">儲存字幕記錄</span>
                  </label>
                </div>
                {draft.saveEnabled && (
                  <div className="save-path-row bc-save-row">
                    <span className="save-path-text">{draft.saveDirectory || '~/Documents/BiCaption'}</span>
                    <button
                      className="secondary"
                      onClick={async () => {
                        const dir = await window.app.chooseSaveDirectory();
                        if (dir) {
                          setDraft({ ...draft, saveDirectory: dir });
                        }
                      }}
                    >
                      選擇
                    </button>
                    {draft.saveDirectory && (
                      <button className="secondary" onClick={() => window.app.openSaveDirectory(draft.saveDirectory)}>
                        開啟
                      </button>
                    )}
                  </div>
                )}
              </div>
            </article>
          </div>
        </div>
        )}

        {activeSettingsTab === 'meeting' && (
          <div className="va-grid-panel va-grid-panel-meeting">
            <article className="va-card va-card-feature">
              <div className="bc-card-header">
                <h3 className="bc-card-title">即時逐字稿</h3>
                <p className="bc-card-hint">會議進行中時，每個人的發言會即時顯示於此。</p>
              </div>
              <div className="va-meeting-thread" ref={meetingTranscriptRef}>
                {meetingTurns.length === 0 && !meetingViewState.partial ? (
                  <p className="va-meeting-empty">開始會議字幕後，這裡會顯示每位講者的逐字稿與翻譯。</p>
                ) : (
                  <>
                    {meetingTurns.map((turn) => {
                      const speakerLabel = draft.meetingSpeakerLabelsEnabled
                        ? getMeetingSpeakerLabel(draft, turn.speakerKind, turn.source, turn.speakerLabel)
                        : '';
                      const isRemote = turn.source === 'system';
                      return (
                        <article key={turn.id} className="va-meeting-turn">
                          {speakerLabel ? (
                            <span className={isRemote ? 'va-meeting-avatar va-meeting-avatar-remote' : 'va-meeting-avatar va-meeting-avatar-local'}>
                              {speakerLabel.slice(0, 1)}
                            </span>
                          ) : null}
                          <div className="va-meeting-turn-copy">
                            {speakerLabel ? (
                              <div className="va-meeting-turn-meta">
                                <strong>{speakerLabel}</strong>
                                <span>{formatMeetingTimestamp(turn.startedAtMs ?? turn.endedAtMs)}</span>
                              </div>
                            ) : null}
                            <div className="va-meeting-turn-bubble">
                              <p className="va-meeting-turn-source">{turn.sourceText}</p>
                              {meetingTranslationOn && turn.translatedText ? (
                                <p className="va-meeting-turn-translation">{turn.translatedText}</p>
                              ) : null}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                    {meetingViewState.partial ? (
                      <article className="va-meeting-turn va-meeting-turn-partial">
                        {draft.meetingSpeakerLabelsEnabled ? (
                          <span className={meetingViewState.partial.source === 'system' ? 'va-meeting-avatar va-meeting-avatar-remote' : 'va-meeting-avatar va-meeting-avatar-local'}>
                            {getMeetingSpeakerLabel(
                              draft,
                              meetingViewState.partial.speakerKind,
                              meetingViewState.partial.source,
                              meetingViewState.partial.speakerLabel,
                            ).slice(0, 1)}
                          </span>
                        ) : null}
                        <div className="va-meeting-turn-copy">
                          {draft.meetingSpeakerLabelsEnabled ? (
                            <div className="va-meeting-turn-meta">
                              <strong>
                                {getMeetingSpeakerLabel(
                                  draft,
                                  meetingViewState.partial.speakerKind,
                                  meetingViewState.partial.source,
                                  meetingViewState.partial.speakerLabel,
                                )}
                              </strong>
                              <span>正在說話</span>
                            </div>
                          ) : null}
                          <div className="va-meeting-turn-bubble va-meeting-turn-bubble-partial">
                            <p className="va-meeting-turn-source">{meetingViewState.partial.sourceText}</p>
                          </div>
                        </div>
                      </article>
                    ) : null}
                  </>
                )}
              </div>
              <div className="va-meeting-feature-footer">
                <div className="va-meeting-feature-status">
                  <span className={isMeetingStreaming ? 'va-meeting-status-dot live' : 'va-meeting-status-dot'} aria-hidden="true" />
                  <span>
                    {meetingViewState.sessionState === 'streaming'
                      ? '會議進行中'
                      : meetingViewState.sessionState === 'connecting'
                        ? '正在準備收音'
                        : hasMeetingTranscript
                          ? '本次逐字稿已停止'
                          : '尚未開始會議字幕'}
                  </span>
                </div>
                <div className="va-meeting-feature-actions">
                  <button
                    className="button-secondary"
                    type="button"
                    disabled={!hasMeetingTranscript}
                    onClick={resetMeetingWorkspace}
                  >
                    清空
                  </button>
                  <button
                    className="button-danger"
                    type="button"
                    disabled={!hasMeetingTranscript && !isMeetingStreaming}
                    onClick={handleMeetingEnd}
                  >
                    結束
                  </button>
                </div>
              </div>
            </article>

            <article className="va-card va-card-bodyless va-meeting-copilot-card">
              <div className="bc-card-header">
                <h3 className="bc-card-title">會議洞察</h3>
                <p className="bc-card-hint">手動用 Groq 根據目前逐字稿整理摘要、議題與提醒。</p>
              </div>
              <div className="bc-card-body va-meeting-copilot-body">
                <button
                  className="button-secondary"
                  type="button"
                  disabled={!hasMeetingTranscript || isMeetingCopilotLoading || !draft.dictationCloudApiKey.trim()}
                  onClick={handleGenerateMeetingCopilotInsights}
                >
                  {isMeetingCopilotLoading ? '產生中' : '產生洞察'}
                </button>
                {!draft.dictationCloudApiKey.trim() ? (
                  <p className="model-hint">需要先在「模型」頁設定 Groq API Key。</p>
                ) : !hasMeetingTranscript ? (
                  <p className="model-hint">開始會議並累積逐字稿後即可產生。</p>
                ) : null}
                {meetingCopilotError ? <p className="error-text">{meetingCopilotError}</p> : null}
                <div className="va-meeting-insight-grid">
                  <section className="va-meeting-insight-section">
                    <h4>摘要</h4>
                    <p>{meetingCopilotInsights?.summary || '尚未產生'}</p>
                  </section>
                  <section className="va-meeting-insight-section">
                    <h4>議題</h4>
                    <ul>
                      {formatMeetingInsightList(meetingCopilotInsights?.topics ?? []).map((item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  </section>
                  <section className="va-meeting-insight-section">
                    <h4>提醒</h4>
                    <ul>
                      {formatMeetingInsightList(meetingCopilotInsights?.reminders ?? []).map((item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  </section>
                </div>
              </div>
            </article>

            <article className="va-card va-card-bodyless">
              <div className="bc-card-header">
                <h3 className="bc-card-title">收音模式</h3>
                <p className="bc-card-hint">會議通常需要同時收本機與遠端聲音。</p>
              </div>
              <div className="bc-card-body">
                <div className="va-choice-stack">
                  {[
                    { key: 'dual', title: '雙來源', sub: '麥克風 + 系統音訊 · 推薦', icon: 'dual' },
                    { key: 'system-audio', title: '只收系統音訊', sub: '僅對方聲音', icon: 'waveform' },
                    { key: 'microphone', title: '只收麥克風', sub: '僅本機聲音', icon: 'mic' },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      className={draft.meetingSourceMode === opt.key ? 'va-choice-card active' : 'va-choice-card'}
                      onClick={() => setDraft({ ...draft, meetingSourceMode: opt.key as AppSettings['meetingSourceMode'] })}
                    >
                      <span className={draft.meetingSourceMode === opt.key ? 'va-choice-icon active' : 'va-choice-icon'}>
                        <AppGlyph name={opt.icon as AppGlyphName} />
                      </span>
                      <div className="va-choice-copy">
                        <strong>{opt.title}</strong>
                        <span>{opt.sub}</span>
                      </div>
                      <span className={draft.meetingSourceMode === opt.key ? 'va-choice-check active' : 'va-choice-check'} aria-hidden="true">✓</span>
                    </button>
                  ))}
                </div>
              </div>
            </article>

            <article className="va-card va-card-bodyless">
              <div className="bc-card-header">
                <h3 className="bc-card-title">發言者標籤</h3>
                <p className="bc-card-hint">依來源自動加上我方與遠端標籤。</p>
              </div>
              <div className="bc-card-body">
                <div className="va-row">
                  <div className="va-row-copy">
                    <strong>辨識發言者</strong>
                    <p>依來源自動加上我方與遠端標籤。</p>
                  </div>
                  <label className="toggle-row subtitle-toggle-row">
                    <input
                      type="checkbox"
                      checked={draft.meetingSpeakerLabelsEnabled}
                      onChange={(event) => setDraft({ ...draft, meetingSpeakerLabelsEnabled: event.target.checked })}
                    />
                    <span className="sr-only">辨識發言者標籤</span>
                  </label>
                </div>
                <div className="va-divider" />
                <div className="va-row">
                  <div className="va-row-copy"><strong>我方標籤</strong></div>
                  <input
                    type="text"
                    value={draft.meetingMicrophoneLabel}
                    onChange={(event) => setDraft({ ...draft, meetingMicrophoneLabel: event.target.value })}
                    placeholder="我方"
                  />
                </div>
                <div className="va-divider" />
                <div className="va-row">
                  <div className="va-row-copy"><strong>遠端標籤</strong></div>
                  <input
                    type="text"
                    value={draft.meetingSystemLabel}
                    onChange={(event) => setDraft({ ...draft, meetingSystemLabel: event.target.value })}
                    placeholder="遠端"
                  />
                </div>
              </div>
            </article>

            <article className="va-card va-card-bodyless">
              <div className="bc-card-header">
                <h3 className="bc-card-title">來源與語言</h3>
                <p className="bc-card-hint">設定會議收音來源、語言與翻譯。</p>
              </div>
              <div className="bc-card-body">
                <div className="va-row">
                  <div className="va-row-copy"><strong>麥克風</strong></div>
                  <select value={draft.meetingMicDeviceId} onChange={(event) => setDraft({ ...draft, meetingMicDeviceId: event.target.value })}>
                    {inputDevices.map((device) => (
                      <option key={device.id} value={device.id}>{device.label}</option>
                    ))}
                  </select>
                </div>
                <div className="va-divider" />
                <div className="va-row">
                  <div className="va-row-copy"><strong>系統音訊</strong></div>
                  <select
                    value={draft.meetingSystemAudioDeviceId}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft({ ...draft, meetingSystemAudioDeviceId: value });
                      if (value === '__screencapturekit__') {
                        window.app.checkScreenRecordingPermission().then(setScreenRecordingPermission).catch(() => {});
                      }
                    }}
                  >
                    <option value="__screencapturekit__">系統音訊（免切換）</option>
                    <option value="">停用</option>
                    {loopbackDevices.map((device) => (
                      <option key={device.id} value={device.id}>{device.label}</option>
                    ))}
                  </select>
                </div>
                <div className="va-divider" />
                <div className="va-row">
                  <div className="va-row-copy"><strong>來源語言</strong></div>
                  <select
                    value={draft.meetingSourceLang}
                    onChange={(event) => {
                      const lang = event.target.value;
                      setDraft({
                        ...draft,
                        meetingSourceLang: lang,
                        meetingSttModel: resolveSttModelForSourceLang(lang, draft.meetingSttModel),
                      });
                    }}
                  >
                    <option value="auto">自動偵測</option>
                    <option value="en">English</option>
                    <option value="zh-TW">繁體中文</option>
                    <option value="ja">日本語</option>
                    <option value="ko">韓國語</option>
                  </select>
                </div>
                <div className="va-divider" />
                <div className="va-row">
                  <div className="va-row-copy"><strong>目標語言</strong></div>
                  <select
                    value={draft.meetingTargetLang}
                    onChange={(event) => setDraft({ ...draft, meetingTargetLang: event.target.value })}
                    disabled={!meetingTranslationOn}
                  >
                    <option value="zh-TW">繁體中文</option>
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                    <option value="ko">韓國語</option>
                  </select>
                </div>
                <div className="va-divider" />
                <div className="va-row">
                  <div className="va-row-copy"><strong>啟用翻譯</strong></div>
                  <label className="toggle-row subtitle-toggle-row">
                    <input
                      type="checkbox"
                      checked={meetingTranslationOn}
                      onChange={(event) => setDraft({
                        ...draft,
                        meetingTranslateModel: event.target.checked
                          ? (draft.meetingSttModel === 'gemini-live' ? 'gemini-live' : 'google')
                          : 'disabled',
                      })}
                    />
                    <span className="sr-only">啟用翻譯</span>
                  </label>
                </div>
                {draft.meetingSystemAudioDeviceId === '__screencapturekit__' && screenRecordingPermission !== null && !screenRecordingPermission.granted ? (
                  <div className="bc-inline-permission">
                    <div className="bc-inline-permission-copy">
                      <strong className="hotkey-permission-missing">螢幕錄製未授權</strong>
                      <p>請在系統設定允許 BiCaption 使用螢幕與系統音訊錄製。</p>
                    </div>
                    <div className="bc-inline-permission-actions">
                      <button className="secondary" onClick={async () => {
                        setSubtitleActionError(null);
                        const result = await window.app.requestScreenRecordingPermission();
                        setScreenRecordingPermission(result);
                        if (!result.granted) {
                          setSubtitleActionError(result.detail ?? '完成授權後切回 BiCaption，系統會重新檢查。');
                          await window.app.openScreenRecordingSettings();
                        }
                      }}>
                        授權
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </article>

            <article className="va-card va-card-bodyless">
              <div className="bc-card-header">
                <h3 className="bc-card-title">儲存與辨識引擎</h3>
                <p className="bc-card-hint">控制逐字稿保存方式與辨識模型。</p>
              </div>
              <div className="bc-card-body">
                <div className="va-row">
                  <div className="va-row-copy"><strong>儲存會議逐字稿與錄音</strong></div>
                  <label className="toggle-row subtitle-toggle-row">
                    <input
                      type="checkbox"
                      checked={draft.meetingSaveTranscript}
                      onChange={(event) => setDraft({ ...draft, meetingSaveTranscript: event.target.checked })}
                    />
                    <span className="sr-only">儲存會議逐字稿與錄音</span>
                  </label>
                </div>
                {draft.meetingSaveTranscript ? (
                  <>
                    <div className="va-divider" />
                    <div className="save-path-row bc-save-row">
                      <span className="save-path-text">{draft.meetingTranscriptDirectory || '未設定'}</span>
                      <button className="secondary" onClick={async () => {
                        const dir = await window.app.chooseSaveDirectory();
                        if (dir) {
                          setDraft({ ...draft, meetingTranscriptDirectory: dir });
                        }
                      }}>選擇</button>
                      {draft.meetingTranscriptDirectory ? (
                        <button className="secondary" onClick={() => window.app.openSaveDirectory(draft.meetingTranscriptDirectory)}>開啟</button>
                      ) : null}
                    </div>
                  </>
                ) : null}
                <div className="va-divider" />
                <div className="va-row">
                  <div className="va-row-copy">
                    <strong>語音辨識引擎</strong>
                    {draft.meetingSttModel === 'apple-stt' ? <p>Apple STT 不支援多語自動判斷。</p> : null}
                    {draft.meetingSttModel === 'sensevoice' ? <p>SenseVoice 適合多人交替說話情境。</p> : null}
                    {draft.meetingSttModel === 'breeze-asr-25' ? <p>Breeze 會在偵測到說話停頓後辨識該段，適合台灣中文與中英混說；不提供連續 partial 字幕。</p> : null}
                    {draft.meetingSttModel === 'gemini-live' ? <p>Gemini Live 走雲端多語辨識與即時翻譯；dual source 會先以混音送出，不取代既有本地說話者分流。</p> : null}
                  </div>
                  <select
                    value={draft.meetingSttModel}
                    onChange={(event) => {
                      const nextModel = event.target.value;
                      setDraft({
                        ...draft,
                        meetingSttModel: nextModel,
                        meetingTranslateModel: nextModel === 'gemini-live'
                          ? 'gemini-live'
                          : draft.meetingTranslateModel === 'gemini-live'
                            ? 'google'
                            : draft.meetingTranslateModel,
                      });
                    }}
                    disabled={isMeetingStreaming}
                  >
                    {meetingAsrOptions.map((option) => (
                      <option key={option.key} value={option.key} disabled={option.disabled}>{option.label}（{option.note}）</option>
                    ))}
                  </select>
                </div>
                {draft.meetingSttModel === 'gemini-live' && (
                  <div className="bc-inline-field">
                    <label className="settings-label">
                      <span>Gemini API Key</span>
                      <input
                        type="password"
                        value={draft.geminiApiKey}
                        onChange={(event) => setDraft({ ...draft, geminiApiKey: event.target.value })}
                        placeholder="AIza..."
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <p className="model-hint">同一組 key 會用於 Gemini Live 字幕與會議模式；也可由本機 .env 提供。</p>
                  </div>
                )}
              </div>
            </article>
          </div>
        )}

        {activeSettingsTab === 'models' && (
        <div className="va-models-stack">
          <article className="va-card va-card-feature">
            <div className="bc-card-header">
              <h3 className="bc-card-title">模型管理</h3>
              <p className="bc-card-hint">模型是全 app 共用資源，下載一次即可用於所有功能。</p>
            </div>
            <div className="bc-card-body">
              <div className="model-catalog">
                {subtitleModelEntries.map((entry) => (
                  <article key={entry.key} className="model-card">
                    <div className="model-card-head">
                      <span className={`model-card-icon model-card-icon-${entry.ready ? 'ready' : 'idle'}`} aria-hidden="true">◫</span>
                      <div className="model-card-copy">
                        <h4>{entry.label}</h4>
                        <p>{entry.description}</p>
                      </div>
                      <span className={`model-badge ${entry.ready ? 'model-badge-ready' : ''}`}>
                        {entry.ready ? '已就緒' : entry.runtimeAvailable ? '未下載' : '此版本未內建'}
                      </span>
                    </div>
                    <div className="model-card-meta">
                      <span>格式: {entry.format}</span>
                      <span>大小: {entry.sizeLabel}</span>
                    </div>
                    <div className="model-card-actions">
                      {entry.ready ? (
                        <button className="secondary" disabled={isDownloading} onClick={() => window.app.deleteModel(entry.key)}>刪除</button>
                      ) : (
                        <button disabled={isDownloading || !entry.runtimeAvailable} onClick={() => window.app.downloadModel(entry.key)}>下載</button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {downloadProgress ? (
                <div className="model-download-banner">
                  <div className="model-row">
                    <span>正在下載: {MODEL_LIBRARY.find((m) => m.key === downloadProgress.stage)?.label}</span>
                    <span>{Math.round(downloadProgress.percent)}%</span>
                  </div>
                  <div className="progress-bar-container">
                    <div className="progress-bar-fill" style={{ width: `${downloadProgress.percent}%` }} />
                  </div>
                </div>
              ) : null}
              {downloadError ? <p className="error-text">下載失敗: {downloadError}</p> : null}
            </div>
          </article>

          <article className="va-card va-card-bodyless">
            <div className="bc-card-header">
              <h3 className="bc-card-title">雲端模型憑證</h3>
              <p className="bc-card-hint">管理線上 STT、雲端文字整理與 Gemini Live Translate 憑證。</p>
            </div>
            <div className="bc-card-body">
              <div className="va-stack-row">
                <div className="va-row-copy">
                  <strong>Groq API Key</strong>
                </div>
                <input
                  type="password"
                  value={draft.dictationCloudApiKey}
                  onChange={(event) => setDraft({ ...draft, dictationCloudApiKey: event.target.value })}
                  placeholder="gsk_..."
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="va-divider" />
              <div className="va-stack-row">
                <div className="va-row-copy">
                  <strong>Gemini API Key</strong>
                  <p>用於 Gemini 3.5 Live Translate。</p>
                </div>
                <input
                  type="password"
                  value={draft.geminiApiKey}
                  onChange={(event) => setDraft({ ...draft, geminiApiKey: event.target.value })}
                  placeholder="AIza..."
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
          </article>
        </div>
        )}
        </div>
        <footer className="va-footer">
        <div className="va-footer-meta">
          <span className="va-footer-spark" aria-hidden="true">✦</span>
          <span>{activeSettingsTab === 'dictation' && isDictationAutosaving ? '設定儲存中' : '設定會自動儲存'}</span>
        </div>
        <div className="va-footer-actions">
        {activeSettingsTab === 'subtitle' ? (
          <>
            <button className="button-secondary button-session-action" disabled={!isSubtitleStreaming} onClick={() => window.app.stopSession()}>
              停止
            </button>
            <button
              className="button-primary button-session-action"
              disabled={!modelsReady || !hotkeyValidation.isValid || isSubtitleStreaming}
              onClick={async () => {
                setSubtitleActionError(null);
                try {
                  const nextSettings = { ...draft };
                  await onSave(nextSettings);
                  await window.app.startSession(buildSessionConfig(nextSettings));
                } catch (error) {
                  setSubtitleActionError(error instanceof Error ? error.message : 'Failed to start subtitle session');
                }
              }}
            >
              {!modelsReady ? '需要下載模型' : '開始字幕'}
            </button>
            {subtitleActionError && <p className="error-text">{subtitleActionError}</p>}
          </>
        ) : activeSettingsTab === 'models' ? (
          <>
            <button
              className="button-primary"
              disabled={isDownloading}
              onClick={() => window.app.downloadModels()}
            >
              {isDownloading ? '下載中' : '下載所有模型'}
            </button>
            <p className="model-hint">
              {isDictationAutosaving ? '模型設定儲存中…' : '雲端模型憑證會自動保存。'}
            </p>
          </>
        ) : activeSettingsTab === 'meeting' ? (
          <>
            <button
              className="button-secondary button-session-action"
              disabled={!isMeetingStreaming}
              onClick={() => window.app.stopSession()}
            >
              停止
            </button>
            <button
              className="button-secondary button-session-action"
              disabled={!isMeetingStreaming}
              onClick={async () => {
                const nextSettings = { ...draft };
                await onSave(nextSettings);
                await window.app.updateSession({
                  mode: 'meeting',
                  sourceLang: nextSettings.meetingSourceLang,
                  targetLang: nextSettings.meetingTargetLang,
                  translateModel: nextSettings.meetingTranslateModel,
                  partialStableMs: nextSettings.meetingPartialStableMs,
                  meetingSpeakerLabelsEnabled: nextSettings.meetingSpeakerLabelsEnabled,
                });
              }}
            >
              套用
            </button>
            <button
              className="button-primary button-session-action"
              disabled={!meetingModelsReady || isMeetingStreaming}
              onClick={async () => {
                const nextSettings = { ...draft };
                await onSave(nextSettings);
                await window.app.startSession(buildSessionConfig(nextSettings, 'meeting'));
              }}
            >
              {!meetingModelsReady ? '需要下載模型' : '開始會議'}
            </button>
          </>
        ) : activeSettingsTab === 'dictation' ? (
          <>
            {dictationAutosaveError ? (
              <p className="error-text">{dictationAutosaveError}</p>
            ) : (
              <p className="model-hint">{isDictationAutosaving ? '語音輸入設定儲存中…' : '語音輸入設定會自動保存。'}</p>
            )}
          </>
        ) : null}
        </div>
        </footer>
      </section>
    </main>
  );
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [devices, setDevices] = useState<Array<{ id: string; label: string; kind: string }>>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const captionState = useCaptionState();
  const dictationState = useDictationState();
  const meetingState = useMeetingState();
  const overlayMode = useOverlayMode();
  const overlayRoute = isOverlayRoute();

  useEffect(() => {
    document.body.classList.toggle('overlay-route', overlayRoute);
    return () => {
      document.body.classList.remove('overlay-route');
    };
  }, [overlayRoute]);

  useEffect(() => {
    if (!window.app) {
      setBootError('Preload API is unavailable. Restart the app after Electron finishes compiling preload.');
      return;
    }

    Promise.all([
      window.app.loadSettings(),
      window.app.listDevices(),
    ]).then(([loadedSettings, loadedDevices]) => {
      setDevices(loadedDevices);
      const inputDeviceIds = new Set(
        loadedDevices.filter((d) => d.kind === 'input' || d.kind === 'duplex').map((d) => d.id),
      );
      const outputDeviceIds = new Set(loadedDevices.filter((d) => d.kind === 'output' || d.kind === 'duplex').map((d) => d.id));
      const preferred = pickPreferredInputDevice(loadedDevices);
      if (!loadedSettings.subtitleDeviceId || (loadedSettings.subtitleDeviceId !== '__disabled__' && !inputDeviceIds.has(loadedSettings.subtitleDeviceId))) {
        loadedSettings = { ...loadedSettings, subtitleDeviceId: preferred?.id ?? '' };
      }
      if (!loadedSettings.dictationDeviceId || !inputDeviceIds.has(loadedSettings.dictationDeviceId)) {
        loadedSettings = { ...loadedSettings, dictationDeviceId: preferred?.id ?? '' };
      }
      if (!loadedSettings.meetingMicDeviceId || !inputDeviceIds.has(loadedSettings.meetingMicDeviceId)) {
        loadedSettings = { ...loadedSettings, meetingMicDeviceId: preferred?.id ?? '' };
      }
      if (loadedSettings.outputDeviceId && loadedSettings.outputDeviceId !== '__screencapturekit__' && !outputDeviceIds.has(loadedSettings.outputDeviceId)) {
        loadedSettings = { ...loadedSettings, outputDeviceId: '' };
      }
      if (loadedSettings.meetingSystemAudioDeviceId && loadedSettings.meetingSystemAudioDeviceId !== '__screencapturekit__' && !outputDeviceIds.has(loadedSettings.meetingSystemAudioDeviceId)) {
        loadedSettings = { ...loadedSettings, meetingSystemAudioDeviceId: '' };
      }
      setSettings(loadedSettings);
    }).catch((error: unknown) => {
      setBootError(error instanceof Error ? error.message : 'Failed to load settings or devices');
    });
    window.app.checkModels().then(setModelStatus).catch(() => {});
    return window.app.subscribe('settings:changed', (payload) => {
      setSettings(payload as AppSettings);
    });
  }, []);

  async function onSave(partial: Partial<AppSettings>) {
    const next = await window.app.saveSettings(partial);
    setSettings(next);
  }

  if (bootError) {
    return <main className="settings-shell loading">{bootError}</main>;
  }

  if (!settings) {
    return <main className="settings-shell loading">Loading…</main>;
  }

  if (overlayRoute) {
    return <OverlayView viewState={captionState} dictationState={dictationState} settings={settings} overlayMode={overlayMode} />;
  }

  return <SettingsView settings={settings} devices={devices} viewState={captionState} meetingViewState={meetingState} modelStatus={modelStatus} onSave={onSave} />;
}
