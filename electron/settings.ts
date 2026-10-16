import Store from 'electron-store';
import { migrateRetiredSttModel } from './stt-model-migration.js';
import type { AppSettings } from './types.js';

const DEPRECATED_LOCAL_LLM_MODELS = new Set([
  'mlx-community/gemma-4-e4b-it-8bit',
]);

const LEGACY_DICTATION_STT_MODEL = 'whisper-mlx';
const LEGACY_DICTATION_ENDPOINT_MS = 1200;
const LEGACY_DICTATION_REWRITE_MODE: AppSettings['dictationRewriteMode'] = 'rules-and-local-llm';
const LEGACY_DICTATION_OUTPUT_STYLE: AppSettings['dictationOutputStyle'] = 'polished';

function getFastDictationSttModel(sourceLang: string | undefined): string {
  return sourceLang === 'auto' ? 'sensevoice' : 'apple-stt';
}

function normalizeDictationSttModel(model: string | undefined, sourceLang: string | undefined): string {
  const candidate = migrateRetiredSttModel((model ?? '').trim(), sourceLang ?? 'en');
  if (!candidate || candidate === 'whisper-mlx' || candidate === 'moonshine') {
    return sourceLang === 'auto' ? 'groq-whisper' : 'apple-stt';
  }
  return candidate;
}

function normalizeSubtitleSttModel(model: string | undefined, sourceLang: string | undefined): string {
  const candidate = migrateRetiredSttModel((model ?? '').trim(), sourceLang ?? 'en');
  if (sourceLang === 'auto' && candidate === 'apple-stt') {
    return 'sensevoice';
  }
  if (!candidate || candidate === 'moonshine' || candidate === 'whisper-mlx' || candidate === 'groq-whisper' || candidate === 'breeze-asr-25' || candidate === 'qwen3-asr' || candidate === 'breeze-gguf') {
    return sourceLang === 'auto' ? 'sensevoice' : 'apple-stt';
  }
  return candidate;
}

function normalizeMeetingSttModel(model: string | undefined, sourceLang: string | undefined): string {
  const candidate = migrateRetiredSttModel((model ?? '').trim(), sourceLang ?? 'en');
  if (sourceLang === 'auto' && candidate === 'apple-stt') {
    return 'sensevoice';
  }
  if (!candidate || candidate === 'moonshine' || candidate === 'whisper-mlx' || candidate === 'groq-whisper' || candidate === 'qwen3-asr' || candidate === 'breeze-gguf') {
    return sourceLang === 'auto' ? 'sensevoice' : 'apple-stt';
  }
  return candidate;
}

function normalizeSubtitleTranslateModel(sttModel: string, translateModel: string | undefined): string {
  const candidate = (translateModel ?? '').trim();
  if (candidate === 'gemini-live') {
    return 'apple-translation';
  }
  return candidate === 'google' ? 'apple-translation' : candidate || defaultSettings.translateModel;
}

function normalizeMeetingTranslateModel(sttModel: string, translateModel: string | undefined): string {
  const candidate = (translateModel ?? '').trim();
  if (candidate === 'gemini-live') {
    return 'apple-translation';
  }
  return candidate === 'google' ? 'apple-translation' : candidate || defaultSettings.meetingTranslateModel;
}

function normalizeDictationRewriteMode(mode: AppSettings['dictationRewriteMode'] | undefined): AppSettings['dictationRewriteMode'] {
  if (mode === 'rules-and-cloud') {
    return mode;
  }
  if (mode === 'rules-and-local-llm') {
    return mode;
  }
  return 'rules';
}

function normalizeDictationLocalLlmModel(model: string | undefined): string {
  const candidate = (model ?? '').trim();
  if (!candidate || DEPRECATED_LOCAL_LLM_MODELS.has(candidate)) {
    return defaultSettings.dictationLocalLlmModel;
  }
  return candidate;
}

export const defaultSettings: AppSettings = {
  deviceId: '',
  subtitleDeviceId: '',
  dictationDeviceId: '__system_default__',
  dictationEnabled: false,
  outputDeviceId: '',
  dictationSttModel: 'breeze-gguf',
  dictationSourceLang: 'zh-TW',
  dictationHotkey: {
    keyCode: 59,
    modifiers: [],
  },
  sourceLang: 'en',
  targetLang: 'zh-TW',
  sttModel: 'apple-stt',
  translateModel: 'apple-translation',
  subtitleChunkMs: 400,
  subtitlePartialStableMs: 500,
  subtitleVadMode: 'aggressive',
  meetingPartialStableMs: 80,
  dictationChunkMs: 400,
  dictationEndpointMs: 600,
  dictationVadMode: 'conservative',
  chunkMs: 400,
  partialStableMs: 500,
  beamSize: 1,
  bestOf: 1,
  vadFilter: false,
  conditionOnPrev: false,
  dictationOutputAction: 'copy-and-paste',
  dictationRewriteMode: 'rules',
  dictationAppleIntelligenceEnabled: true,
  dictationCloudEnhancementEnabled: false,
  dictationOutputStyle: 'polished',
  dictationMaxRewriteExpansionRatio: 1.3,
  dictationInitialPromptText: 'Claude, Anthropic, OpenAI, ChatGPT, Gemini',
  dictationDictionaryEnabled: true,
  dictationDictionaryText: '',
  dictationHotwords: '',
  dictationVocabularyContext: `優先考慮以下類型的專有名詞：
- AI agent 名稱
- CLI 工具名
- 模型名稱
- 開發工具與框架名
- 英文技術術語

目前最常出現的詞：
- Claude Code：常見近似音可能像 cloud code、clod code、claude cold
- Codex：常見近似音可能像 code x、codec、cool das
- Gemini CLI：常見近似音可能像 gemini c l i、james cli、deck james cli

如果語音內容在談 AI 開發、agent、CLI、prompt、token、workflow、trigger，
請優先把音近或形近的片段理解為上述類型的專有名詞。

若一句話明顯是在列舉常用 AI 助手、agent 或 CLI 工具，且出現奇怪的中英混合音譯片段，請優先在 Claude Code、Codex、Gemini CLI 之間判斷最可能的對應。`,
  dictationProperNounCorrectionEnabled: true,
  dictationPersonalGlossary: `Claude Code
Codex
Gemini CLI`,
  dictationCloudApiKey: '',
  dictationCloudModel: 'auto',
  dictationCloudLlmPrompt: `你是語音輸入的雲端文字整理器。
請根據目前模式，先修正辨識錯字與專有名詞，再決定是否進一步整理語句。

目標語言：{language_label}
輸出風格：{style_label}
專名修正：{proper_noun_mode}

規則：
1. 不得新增事實、結論、建議或原文沒有的資訊。
2. 優先修正 STT 誤判、同音錯字、英文專名、CLI 工具名、品牌名與模型名稱。
3. 若模式偏忠實，請只做必要整理；若模式偏發文，可進一步讓句子更自然好讀。
4. 若個人詞彙表中出現候選專名，優先使用它們做還原。
5. 如果原文明顯是在列舉重點、步驟、待辦、條件比較，或出現「第一點、第二點、第三點」這類訊號，請優先整理成清楚的編號或條列格式。
6. 不得自行新增項目，只能重排與整理原文已經提到的內容。
7. 逐字稿通常沒有標點：請加上全形標點（，。？！、），標點前後不留空格，長句適度斷句。
8. 英文詞一律保留英文，不得翻成中文，並修正大小寫（GitHub、PR、CI、TypeScript）。若明顯是英文技術詞被聽成發音相近的字，依上下文與詞彙表還原；沒把握就保持原樣。
9. 刪除口頭禪與重複；說話者自我修正（「不對，是…」）時只保留更正後的內容。
10. 只輸出整理後的純文字，不要 Markdown 粗體或符號，不要解釋。

個人詞彙表：
{personal_glossary}

常用字彙情境：
{vocab_context}

Literal transcript:
{literal_transcript}
`,
  dictationLocalLlmModel: 'mlx-community/Qwen2.5-3B-Instruct-4bit',
  dictationLocalLlmRunner: '',
  dictationLocalLlmPrompt: `You are a deterministic dictation cleanup engine.
Rewrite the text for direct insertion into another app.
Target language: {language_label}.
Output style: {style_label}.
Proper noun correction: {proper_noun_mode}.
Strict rules:
1. Keep the original meaning exactly.
2. Do not add facts, explanations, or missing context.
3. Fix obvious speech-recognition mistakes and restore likely product names, CLI tools, model names, and brands from context.
4. If personal glossary terms are plausible matches, prefer them.
5. For faithful mode, stay close to the original wording.
6. For polished mode, improve readability without adding new facts.
7. Remove fillers and spoken tics when they do not carry meaning.
8. Add necessary punctuation to segment the text into proper sentences.
9. For Traditional Chinese, use full-width punctuation.
10. Return only the rewritten text.
Personal glossary:
{personal_glossary}
Common vocabulary context:
{vocab_context}
Literal transcript:
{literal_transcript}`,
  meetingMicDeviceId: '',
  meetingSystemAudioDeviceId: '',
  meetingSourceMode: 'dual',
  meetingSourceLang: 'auto',
  meetingTargetLang: 'zh-TW',
  meetingSttModel: 'sensevoice',
  meetingTranslateModel: 'disabled',
  meetingSpeakerLabelsEnabled: true,
  meetingMicrophoneLabel: '我方',
  meetingSystemLabel: '遠端',
  meetingLocalSpeakerVerificationEnabled: false,
  meetingLocalSpeakerProfileId: '',
  meetingLocalSpeakerFingerprint: '',
  meetingLocalSpeakerEnrolledAtMs: 0,
  meetingNotesPrompt: `請根據以下會議逐字稿整理成結構化會議記錄。

輸出要求：
1. 先給一段中文摘要
2. 列出主要決策
3. 列出 action items 與負責人
4. 列出待確認事項與風險
5. 若 transcript 中有 speaker label，請保留`,
  meetingSaveTranscript: true,
  meetingTranscriptDirectory: '',
  saveEnabled: false,
  saveDirectory: '',
  overlayOpacity: 0.9,
  overlayFontScale: 1,
  overlayPosition: 'bottom',
  overlayX: 0,
  overlayY: 0,
  overlayWidth: 900,
  overlayHeight: 220,
};

function shouldApplyFastDictationDefaults(stored: Partial<AppSettings> & { deviceId?: string }) {
  const hasLegacyFields = stored.dictationSttModel !== undefined
    || stored.dictationEndpointMs !== undefined
    || stored.dictationRewriteMode !== undefined
    || stored.dictationOutputStyle !== undefined;
  if (!hasLegacyFields) {
    return false;
  }
  return (stored.dictationSttModel === undefined || stored.dictationSttModel === LEGACY_DICTATION_STT_MODEL)
    && (stored.dictationEndpointMs === undefined || stored.dictationEndpointMs === LEGACY_DICTATION_ENDPOINT_MS)
    && (stored.dictationRewriteMode === undefined || stored.dictationRewriteMode === LEGACY_DICTATION_REWRITE_MODE)
    && (stored.dictationOutputStyle === undefined || stored.dictationOutputStyle === LEGACY_DICTATION_OUTPUT_STYLE);
}

function shouldUpgradeDictationOutputStyle(stored: Partial<AppSettings>) {
  return stored.dictationOutputStyle === undefined
    || stored.dictationOutputStyle === 'literal';
}

const store = new Store<AppSettings>({
  name: 'settings',
  defaults: defaultSettings,
});

export function loadSettings(): AppSettings {
  const stored = store.store as Partial<AppSettings> & { deviceId?: string };
  const legacyDeviceId = stored.deviceId ?? '';
  const subtitleSttModel = normalizeSubtitleSttModel(
    stored.sttModel ?? defaultSettings.sttModel,
    stored.sourceLang ?? defaultSettings.sourceLang,
  );
  const meetingSttModel = normalizeMeetingSttModel(
    stored.meetingSttModel ?? defaultSettings.meetingSttModel,
    stored.meetingSourceLang ?? stored.sourceLang ?? defaultSettings.meetingSourceLang,
  );
  const current: AppSettings = {
    ...defaultSettings,
    ...stored,
    subtitleDeviceId: stored.subtitleDeviceId ?? legacyDeviceId ?? '',
    dictationDeviceId: stored.dictationDeviceId || legacyDeviceId || defaultSettings.dictationDeviceId,
    dictationSourceLang: stored.dictationSourceLang ?? stored.sourceLang ?? defaultSettings.dictationSourceLang,
    dictationSttModel: normalizeDictationSttModel(
      stored.dictationSttModel ?? defaultSettings.dictationSttModel,
      stored.dictationSourceLang ?? stored.sourceLang ?? defaultSettings.dictationSourceLang,
    ),
    subtitleChunkMs: stored.subtitleChunkMs ?? stored.chunkMs ?? defaultSettings.subtitleChunkMs,
    subtitlePartialStableMs: stored.subtitlePartialStableMs ?? stored.partialStableMs ?? defaultSettings.subtitlePartialStableMs,
    meetingPartialStableMs: defaultSettings.meetingPartialStableMs,
    dictationChunkMs: stored.dictationChunkMs ?? stored.chunkMs ?? defaultSettings.dictationChunkMs,
    dictationEndpointMs: defaultSettings.dictationEndpointMs,
    dictationRewriteMode: normalizeDictationRewriteMode(stored.dictationRewriteMode),
    dictationAppleIntelligenceEnabled: stored.dictationAppleIntelligenceEnabled === true,
    dictationCloudApiKey: stored.dictationCloudApiKey ?? defaultSettings.dictationCloudApiKey,
    dictationCloudModel: stored.dictationCloudModel ?? defaultSettings.dictationCloudModel,
    dictationCloudLlmPrompt: stored.dictationCloudLlmPrompt ?? defaultSettings.dictationCloudLlmPrompt,
    dictationVocabularyContext: stored.dictationVocabularyContext ?? defaultSettings.dictationVocabularyContext,
    dictationProperNounCorrectionEnabled: stored.dictationProperNounCorrectionEnabled ?? defaultSettings.dictationProperNounCorrectionEnabled,
    dictationPersonalGlossary: stored.dictationPersonalGlossary ?? defaultSettings.dictationPersonalGlossary,
    dictationLocalLlmModel: normalizeDictationLocalLlmModel(stored.dictationLocalLlmModel),
    dictationCloudEnhancementEnabled: false,
    meetingMicDeviceId: stored.meetingMicDeviceId ?? legacyDeviceId ?? '',
    meetingSystemAudioDeviceId: stored.meetingSystemAudioDeviceId ?? stored.outputDeviceId ?? '',
    meetingSourceLang: stored.meetingSourceLang ?? stored.sourceLang ?? defaultSettings.meetingSourceLang,
    meetingTargetLang: stored.meetingTargetLang ?? stored.targetLang ?? defaultSettings.meetingTargetLang,
    meetingSttModel,
    meetingTranslateModel: normalizeMeetingTranslateModel(
      meetingSttModel,
      stored.meetingTranslateModel ?? stored.translateModel ?? defaultSettings.meetingTranslateModel,
    ),
    meetingSourceMode: stored.meetingSourceMode ?? defaultSettings.meetingSourceMode,
    meetingSpeakerLabelsEnabled: stored.meetingSpeakerLabelsEnabled ?? defaultSettings.meetingSpeakerLabelsEnabled,
    meetingMicrophoneLabel: stored.meetingMicrophoneLabel ?? defaultSettings.meetingMicrophoneLabel,
    meetingSystemLabel: stored.meetingSystemLabel ?? defaultSettings.meetingSystemLabel,
    meetingLocalSpeakerVerificationEnabled: stored.meetingLocalSpeakerVerificationEnabled ?? defaultSettings.meetingLocalSpeakerVerificationEnabled,
    meetingLocalSpeakerProfileId: stored.meetingLocalSpeakerProfileId ?? defaultSettings.meetingLocalSpeakerProfileId,
    meetingLocalSpeakerFingerprint: stored.meetingLocalSpeakerFingerprint ?? defaultSettings.meetingLocalSpeakerFingerprint,
    meetingLocalSpeakerEnrolledAtMs: stored.meetingLocalSpeakerEnrolledAtMs ?? defaultSettings.meetingLocalSpeakerEnrolledAtMs,
    meetingNotesPrompt: stored.meetingNotesPrompt ?? defaultSettings.meetingNotesPrompt,
    meetingSaveTranscript: stored.meetingSaveTranscript ?? defaultSettings.meetingSaveTranscript,
    meetingTranscriptDirectory: stored.meetingTranscriptDirectory ?? stored.saveDirectory ?? defaultSettings.meetingTranscriptDirectory,
    sttModel: subtitleSttModel,
    translateModel: normalizeSubtitleTranslateModel(subtitleSttModel, stored.translateModel ?? defaultSettings.translateModel),
  };
  if (shouldApplyFastDictationDefaults(stored)) {
    current.dictationSttModel = getFastDictationSttModel(current.dictationSourceLang);
    current.dictationEndpointMs = defaultSettings.dictationEndpointMs;
    current.dictationRewriteMode = defaultSettings.dictationRewriteMode;
  }
  if (shouldUpgradeDictationOutputStyle(stored)) {
    current.dictationOutputStyle = defaultSettings.dictationOutputStyle;
  }
  return current;
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  store.set(partial);
  return loadSettings();
}
