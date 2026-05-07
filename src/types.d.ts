import type { AppSettings, CaptionConfig, DictationHotkeyBinding, DictationHotkeyEvent, DictationLearningRecord, DictationOutputStatusEvent, MeetingCopilotInsightsRequest, MeetingCopilotInsightsResult, MeetingEnrollSpeakerRequest, MeetingEnrollSpeakerResult, MeetingNotesRequest, MeetingNotesResult, MeetingReportRequest, MeetingReportResult, ModelDownloadProgress, ModelStatus, OverlayBounds, SessionUpdatePayload, SidecarEvent } from '../electron/types.js';

type SubscribeMap = {
  'sidecar:event': SidecarEvent;
  'dictation:hotkey-event': DictationHotkeyEvent;
  'dictation:output-status': DictationOutputStatusEvent;
  'overlay:mode': { mode: 'hidden' | 'subtitle' | 'dictation' };
  'settings:changed': AppSettings;
  'models:progress': ModelDownloadProgress;
  'models:done': ModelStatus;
  'models:error': string;
};

declare global {
  interface Window {
    app: {
      loadSettings(): Promise<AppSettings>;
      saveSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
      listDictationLearningRecords(): Promise<DictationLearningRecord[]>;
      addDictationInitialPromptTerm(term: string): Promise<AppSettings>;
      startSession(config: CaptionConfig): Promise<{ ok: boolean }>;
      updateSession(payload: SessionUpdatePayload): Promise<{ ok: boolean }>;
      stopSession(): Promise<{ ok: boolean }>;
      listDevices(): Promise<Array<{ id: string; label: string; kind: string }>>;
      showSettings(): Promise<{ ok: boolean }>;
      hideSettings(): Promise<{ ok: boolean }>;
      minimizeSettings(): Promise<{ ok: boolean }>;
      toggleSettingsMaximize(): Promise<{ ok: boolean }>;
      relaunchApp(): Promise<{ ok: boolean }>;
      getOverlayPosition(): Promise<[number, number]>;
      setOverlayPosition(x: number, y: number): Promise<void>;
      getOverlayBounds(): Promise<OverlayBounds>;
      setOverlayBounds(bounds: Partial<OverlayBounds>): Promise<OverlayBounds>;
      showOverlay(): Promise<{ ok: boolean }>;
      hideOverlay(): Promise<{ ok: boolean }>;
      chooseSaveDirectory(): Promise<string | null>;
      openSaveDirectory(directory?: string): Promise<{ ok: boolean }>;
      checkModels(): Promise<ModelStatus>;
      downloadModels(): Promise<{ ok: boolean }>;
      downloadModel(modelKey: string): Promise<{ ok: boolean }>;
      checkAccessibilityPermission(): Promise<{ trusted: boolean; status: string }>;
      requestAccessibilityPermission(): Promise<{ trusted: boolean; status: string }>;
      openAccessibilitySettings(): Promise<{ ok: boolean }>;
      checkInputMonitoringPermission(): Promise<{ trusted: boolean; available: boolean; detail?: string }>;
      requestInputMonitoringPermission(): Promise<{ trusted: boolean; available: boolean; detail?: string }>;
      openInputMonitoringSettings(): Promise<{ ok: boolean }>;
      checkScreenRecordingPermission(): Promise<{ granted: boolean; detail?: string }>;
      requestScreenRecordingPermission(): Promise<{ granted: boolean; detail?: string }>;
      openScreenRecordingSettings(): Promise<{ ok: boolean }>;
      testDictationHotkey(binding: DictationHotkeyBinding): Promise<{ ok: boolean }>;
      stopDictationHotkeyTest(): Promise<{ ok: boolean }>;
      deleteModel(modelKey: string): Promise<ModelStatus>;
      enrollMeetingLocalSpeaker(request: MeetingEnrollSpeakerRequest): Promise<MeetingEnrollSpeakerResult>;
      generateMeetingCopilotInsights(request: MeetingCopilotInsightsRequest): Promise<MeetingCopilotInsightsResult>;
      generateMeetingNotes(request: MeetingNotesRequest): Promise<MeetingNotesResult>;
      exportMeetingReport(request: MeetingReportRequest): Promise<MeetingReportResult>;
      subscribe<K extends keyof SubscribeMap>(
        eventName: K,
        handler: (payload: SubscribeMap[K]) => void,
      ): () => void;
    };
  }
}

export {};
