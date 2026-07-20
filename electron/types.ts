export type SessionState = 'idle' | 'connecting' | 'streaming' | 'error' | 'stopped';
export type SessionMode = 'subtitle' | 'dictation' | 'meeting';
export type DictationOutputAction = 'copy' | 'paste' | 'copy-and-paste';

export interface DictationHotkeyBinding {
  keyCode: number;
  modifiers: string[];
}

export interface DictationHotkeyEvent {
  type: 'listener_ready' | 'hotkey_down' | 'hotkey_up' | 'permission_status' | 'error' | 'listener_stopped';
  keyCode?: number;
  modifiers?: Record<string, boolean>;
  cancelled?: boolean;
  trusted?: boolean;
  message?: string;
}

export interface CaptionConfig {
  mode: SessionMode;
  sessionId: string;
  deviceId: string;
  outputDeviceId: string;
  sourceLang: string;
  targetLang: string;
  sttModel: string;
  translateModel: string;
  chunkMs: number;
  partialStableMs: number;
  beamSize: number;
  bestOf: number;
  vadFilter: boolean;
  conditionOnPrev: boolean;
  dictationRewriteMode?: 'disabled' | 'rules' | 'rules-and-cloud' | 'rules-and-local-llm';
  dictationCloudEnhancementEnabled?: boolean;
  dictationOutputStyle?: 'literal' | 'polished';
  dictationInitialPromptText?: string;
  dictationVocabularyContext?: string;
  dictationProperNounCorrectionEnabled?: boolean;
  dictationPersonalGlossary?: string;
  dictationCloudApiKey?: string;
  geminiApiKey?: string;
  dictationCloudModel?: string;
  dictationCloudLlmPrompt?: string;
  dictationMaxRewriteExpansionRatio?: number;
  dictationLocalLlmModel?: string;
  dictationLocalLlmRunner?: string;
  dictationLocalLlmPrompt?: string;
  meetingSourceMode?: 'system-audio' | 'microphone' | 'dual';
  meetingSpeakerLabelsEnabled?: boolean;
  meetingMicrophoneLabel?: string;
  meetingSystemLabel?: string;
  meetingLocalSpeakerVerificationEnabled?: boolean;
  meetingLocalSpeakerProfileId?: string;
  meetingLocalSpeakerFingerprint?: string;
  meetingNotesPrompt?: string;
  meetingSaveTranscript?: boolean;
  meetingTranscriptDirectory?: string;
  /** Named pipe path for Electron-driven system audio capture (SCK via desktopCapturer). */
  sckPipePath?: string;
  /** Sample rate of the system audio capture (e.g. 48000). Sidecar resamples to 16kHz. */
  sckSampleRate?: number;
}

export interface SessionUpdatePayload {
  mode: SessionMode;
  sourceLang?: string;
  targetLang?: string;
  translateModel?: string;
  partialStableMs?: number;
  meetingSpeakerLabelsEnabled?: boolean;
}

interface SessionScopedEvent {
  mode: SessionMode;
  sessionId: string;
}

export interface PartialCaptionEvent extends SessionScopedEvent {
  type: 'partial_caption';
  segmentId: string;
  sourceText: string;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface FinalCaptionEvent extends SessionScopedEvent {
  type: 'final_caption';
  segmentId: string;
  sourceText: string;
  translatedText: string;
  startedAtMs: number;
  endedAtMs: number;
  latencyMs: number;
  confidence?: number;
  detectedLang?: string;
}

export interface MetricsEvent extends SessionScopedEvent {
  type: 'metrics';
  inputLevel: number;
  processingLagMs: number;
  queueDepth: number;
}

export interface SessionStateEvent extends SessionScopedEvent {
  type: 'session_state';
  state: SessionState;
  detail?: string;
}

export interface DictationStateEvent extends SessionScopedEvent {
  type: 'dictation_state';
  state: 'idle' | 'recording' | 'capturing' | 'processing' | 'done' | 'stopped' | 'error';
  detail?: string;
}

export interface DictationFinalEvent extends SessionScopedEvent {
  type: 'dictation_final';
  literalTranscript: string;
  dictionaryText: string;
  finalText: string;
  initialPromptText?: string;
  matchedCorrections?: string[];
  rewriteBackend: 'disabled' | 'rules' | 'cloud-llm' | 'local-llm';
  rewriteApplied: boolean;
  fallbackReason?: string;
  chunkCount?: number;
  startedAtMs: number;
  endedAtMs: number;
  latencyMs: number;
}

export interface DictationLearningCandidate {
  id: string;
  term: string;
  kind: 'initial-prompt' | 'dictionary-entry';
  source: 'final-text' | 'transcript-diff';
  incorrect?: string;
  correct?: string;
}

export interface DictationLearningRecord {
  id: string;
  sessionId: string;
  createdAtMs: number;
  sourceLang: string;
  literalTranscript: string;
  dictionaryText: string;
  finalText: string;
  rewriteBackend: 'disabled' | 'rules' | 'cloud-llm' | 'local-llm';
  rewriteApplied: boolean;
  latencyMs: number;
  candidates: DictationLearningCandidate[];
}

export type MeetingSpeakerKind = 'source-default' | 'verified-local' | 'unverified-local' | 'remote-default';

export interface MeetingCaptionEvent extends SessionScopedEvent {
  type: 'meeting_caption';
  segmentId: string;
  turnId?: string;
  speakerId: string;
  speakerLabel?: string;
  speakerKind?: MeetingSpeakerKind;
  speakerProfileId?: string;
  speakerMatchConfidence?: number;
  source: 'microphone' | 'system';
  sourceLang?: string;
  targetLang: string;
  text: string;
  translatedText?: string;
  tsStartMs: number;
  tsEndMs: number;
}

export interface MeetingNotesRequest {
  transcriptId: string;
  targetLang: string;
  promptTemplate: string;
  includeActionItems: boolean;
  includeRisks: boolean;
  includeSpeakerNames: boolean;
  transcriptText?: string;
}

export interface MeetingNotesResult {
  summary: string;
  actionItems: string[];
  risks: string[];
  decisions: string[];
  rawPrompt: string;
}

export interface MeetingCopilotInsightsRequest {
  transcriptText: string;
  targetLang: string;
}

export interface MeetingCopilotInsightsResult {
  summary: string;
  topics: string[];
  reminders: string[];
}

export interface MeetingReportRequest {
  transcriptId: string;
  transcriptText?: string;
  notes?: MeetingNotesResult | null;
  title?: string;
}

export interface MeetingReportResult {
  path: string;
}

export interface MeetingEnrollSpeakerRequest {
  deviceId: string;
  durationSec?: number;
}

export interface MeetingEnrollSpeakerResult {
  profileId: string;
  fingerprint: string;
  sampleDurationMs: number;
  enrolledAtMs: number;
  speechRatio?: number;
  qualityScore?: number;
}

export interface DictationOutputStatusEvent {
  type: 'dictation_output_status';
  action: DictationOutputAction;
  status: 'copied' | 'pasted' | 'fallback';
  detail?: string;
}

export interface SessionStoppedAckEvent extends SessionScopedEvent {
  type: 'session_stopped_ack';
}

export interface ErrorEvent extends SessionScopedEvent {
  type: 'error';
  code: string;
  message: string;
  recoverable: boolean;
}

export type SidecarEvent =
  | PartialCaptionEvent
  | FinalCaptionEvent
  | MetricsEvent
  | SessionStateEvent
  | DictationStateEvent
  | DictationFinalEvent
  | MeetingCaptionEvent
  | SessionStoppedAckEvent
  | ErrorEvent;

export interface CaptionRecord {
  segmentId: string;
  sourceText: string;
  translatedText?: string;
  startedAtMs: number;
  endedAtMs?: number;
  isFinal: boolean;
}

export interface AppSettings {
  deviceId?: string;
  subtitleDeviceId: string;
  dictationDeviceId: string;
  dictationEnabled: boolean;
  outputDeviceId: string;
  dictationSttModel: string;
  dictationSourceLang: string;
  dictationHotkey: DictationHotkeyBinding;
  sourceLang: string;
  targetLang: string;
  sttModel: string;
  translateModel: string;
  subtitleChunkMs: number;
  subtitlePartialStableMs: number;
  subtitleVadMode: 'aggressive' | 'balanced';
  meetingPartialStableMs: number;
  dictationChunkMs: number;
  dictationEndpointMs: number;
  dictationVadMode: 'conservative' | 'balanced';
  chunkMs: number;
  partialStableMs: number;
  beamSize: number;
  bestOf: number;
  vadFilter: boolean;
  conditionOnPrev: boolean;
  dictationOutputAction: DictationOutputAction;
  dictationRewriteMode: 'disabled' | 'rules' | 'rules-and-cloud' | 'rules-and-local-llm';
  dictationCloudEnhancementEnabled: boolean;
  dictationOutputStyle: 'literal' | 'polished';
  dictationMaxRewriteExpansionRatio: number;
  dictationInitialPromptText: string;
  dictationVocabularyContext: string;
  dictationProperNounCorrectionEnabled: boolean;
  dictationPersonalGlossary: string;
  dictationCloudApiKey: string;
  geminiApiKey: string;
  dictationCloudModel: string;
  dictationCloudLlmPrompt: string;
  dictationLocalLlmModel: string;
  dictationLocalLlmRunner: string;
  dictationLocalLlmPrompt: string;
  meetingMicDeviceId: string;
  meetingSystemAudioDeviceId: string;
  meetingSourceMode: 'system-audio' | 'microphone' | 'dual';
  meetingSourceLang: string;
  meetingTargetLang: string;
  meetingSttModel: string;
  meetingTranslateModel: string;
  meetingSpeakerLabelsEnabled: boolean;
  meetingMicrophoneLabel: string;
  meetingSystemLabel: string;
  meetingLocalSpeakerVerificationEnabled: boolean;
  meetingLocalSpeakerProfileId: string;
  meetingLocalSpeakerFingerprint: string;
  meetingLocalSpeakerEnrolledAtMs: number;
  meetingNotesPrompt: string;
  meetingSaveTranscript: boolean;
  meetingTranscriptDirectory: string;
  saveEnabled: boolean;
  saveDirectory: string;
  overlayOpacity: number;
  overlayFontScale: number;
  overlayPosition: 'top' | 'bottom';
  overlayX: number;
  overlayY: number;
  overlayWidth: number;
  overlayHeight: number;
}

export interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ModelStatus {
  sensevoice: boolean;
  mlxWhisper: boolean;
  breezeAsr: boolean;
  breezeAsrRuntime: boolean;
  whisperTinyEn: boolean;
  whisperSmall: boolean;
  zipformerKo: boolean;
  vad: boolean;
  ffmpeg: boolean;
  ready: boolean;
}

export interface ModelDownloadProgress {
  stage: 'sensevoice' | 'mlx-whisper' | 'breeze-asr-25' | 'whisper-tiny-en' | 'whisper-small' | 'zipformer-ko' | 'vad' | 'extracting';
  percent: number;
  downloadedMB: number;
  totalMB: number;
}
