const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('app', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  listDictationLearningRecords: () => ipcRenderer.invoke('dictation-learning:list'),
  addDictationInitialPromptTerm: (term) => ipcRenderer.invoke('dictation-learning:add-initial-prompt-term', term),
  startSession: (config) => ipcRenderer.invoke('session:start', config),
  updateSession: (payload) => ipcRenderer.invoke('session:update', payload),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  listDevices: () => ipcRenderer.invoke('session:devices'),
  showSettings: () => ipcRenderer.invoke('app:show-settings'),
  hideSettings: () => ipcRenderer.invoke('app:hide-settings'),
  minimizeSettings: () => ipcRenderer.invoke('app:minimize-settings'),
  toggleSettingsMaximize: () => ipcRenderer.invoke('app:toggle-settings-maximize'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  getOverlayPosition: () => ipcRenderer.invoke('overlay:get-position'),
  setOverlayPosition: (x, y) => ipcRenderer.invoke('overlay:set-position', x, y),
  getOverlayBounds: () => ipcRenderer.invoke('overlay:get-bounds'),
  setOverlayBounds: (bounds) => ipcRenderer.invoke('overlay:set-bounds', bounds),
  showOverlay: () => ipcRenderer.invoke('overlay:show'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  chooseSaveDirectory: () => ipcRenderer.invoke('save:choose-directory'),
  openSaveDirectory: (directory) => ipcRenderer.invoke('save:open-directory', directory),
  checkModels: () => ipcRenderer.invoke('models:check'),
  downloadModels: () => ipcRenderer.invoke('models:download'),
  downloadModel: (modelKey) => ipcRenderer.invoke('models:download-one', modelKey),
  deleteModel: (modelKey) => ipcRenderer.invoke('models:delete', modelKey),
  checkAccessibilityPermission: () => ipcRenderer.invoke('permissions:check-accessibility'),
  requestAccessibilityPermission: () => ipcRenderer.invoke('permissions:request-accessibility'),
  openAccessibilitySettings: () => ipcRenderer.invoke('permissions:open-accessibility'),
  checkInputMonitoringPermission: () => ipcRenderer.invoke('permissions:check-input-monitoring'),
  requestInputMonitoringPermission: () => ipcRenderer.invoke('permissions:request-input-monitoring'),
  openInputMonitoringSettings: () => ipcRenderer.invoke('permissions:open-input-monitoring'),
  checkScreenRecordingPermission: () => ipcRenderer.invoke('permissions:check-screen-recording'),
  requestScreenRecordingPermission: () => ipcRenderer.invoke('permissions:request-screen-recording'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('permissions:open-screen-recording'),
  testDictationHotkey: (binding) => ipcRenderer.invoke('dictation:test-hotkey', binding),
  stopDictationHotkeyTest: () => ipcRenderer.invoke('dictation:stop-hotkey-test'),
  enrollMeetingLocalSpeaker: (request) => ipcRenderer.invoke('meeting:enroll-local-speaker', request),
  generateMeetingCopilotInsights: (request) => ipcRenderer.invoke('meeting:generate-copilot-insights', request),
  generateMeetingNotes: (request) => ipcRenderer.invoke('meeting:generate-notes', request),
  exportMeetingReport: (request) => ipcRenderer.invoke('meeting:export-report', request),
  subscribe: (eventName, handler) => on(eventName, handler),
});
