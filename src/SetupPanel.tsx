import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppleTranslationStatus } from '../electron/types.js';

type PermissionKey = 'microphone' | 'speech' | 'screen' | 'accessibility' | 'input';
const languageNames: Record<string, string> = {
  auto: '自動偵測', en: '英文', 'zh-TW': '繁體中文', 'zh-CN': '簡體中文', ja: '日文', ko: '韓文',
};

export function SetupPanel({ source, target, translationEnabled, needsSpeech, sttModel = '', onPermissionsResolved, onClose, actionTarget }: {
  source: string; target: string; translationEnabled: boolean; needsSpeech: boolean; sttModel?: string; onPermissionsResolved?: (ready: boolean) => void; onClose?: () => void; actionTarget?: HTMLElement | null;
}) {
  const [permissions, setPermissions] = useState<Partial<Record<PermissionKey, boolean>>>({});
  const [translation, setTranslation] = useState<AppleTranslationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requiredPermissions: PermissionKey[] = needsSpeech ? ['microphone', 'speech', 'screen'] : ['microphone', 'screen'];
  const dictationPermissions: PermissionKey[] = ['accessibility', 'input'];
  const dictationReady = dictationPermissions.every(key => permissions[key] === true);
  const permissionsResolved = requiredPermissions.every(key => permissions[key] !== undefined);
  const permissionsReady = requiredPermissions.every(key => permissions[key] === true);
  useEffect(() => {
    if (permissionsResolved) onPermissionsResolved?.(permissionsReady);
  }, [permissionsResolved, permissionsReady, onPermissionsResolved]);
  const ready = requiredPermissions.every(key => permissions[key] === true)
    && (!translationEnabled || translation?.status === 'installed');
  const translationPair = `${source}:${target}:${translationEnabled}:${sttModel}`;
  const currentPair = useRef(translationPair);
  currentPair.current = translationPair;
  const refresh = useCallback(async () => {
    const pair = `${source}:${target}:${translationEnabled}:${sttModel}`;
    const [mic, speech, screen, accessibility, input] = await Promise.all([
      window.app.checkMicrophonePermission(), window.app.checkSpeechPermission(),
      window.app.checkScreenRecordingPermission(), window.app.checkAccessibilityPermission(),
      window.app.checkInputMonitoringPermission(),
    ]);
    setPermissions({ microphone: mic.granted, speech: speech.granted, screen: screen.granted,
      accessibility: accessibility.trusted, input: input.trusted });
    if (translationEnabled) {
      const result = await window.app.checkAppleTranslation(source, target, sttModel);
      if (currentPair.current === pair) setTranslation(result);
    }
  }, [source, target, translationEnabled, sttModel]);
  useEffect(() => {
    let active = true;
    const check = () => { if (active) void refresh().catch(() => setError('無法檢查準備狀態，請重試。')); };
    check(); window.addEventListener('focus', check);
    return () => { active = false; window.removeEventListener('focus', check); };
  }, [refresh]);
  useEffect(() => { setTranslation(null); }, [translationPair]);

  async function request(keys: PermissionKey[]) {
    setBusy(true); setError(null); setRestartNeeded(true);
    try {
      for (const key of keys) {
      if (permissions[key]) continue;
      if (key === 'microphone') await window.app.requestMicrophonePermission();
      if (key === 'speech') {
        const result = await window.app.requestSpeechPermission();
        if (!result.available) throw new Error('辨識元件需要更新，請重新安裝新版 BiCaption。');
      }
      if (key === 'screen') {
        const result = await window.app.requestScreenRecordingPermission();
        if (!result.granted) await window.app.openScreenRecordingSettings();
      }
      if (key === 'accessibility') {
        const result = await window.app.requestAccessibilityPermission();
        if (!result.trusted) await window.app.openAccessibilitySettings();
      }
      if (key === 'input') {
        const result = await window.app.requestInputMonitoringPermission();
        if (!result.trusted) await window.app.openInputMonitoringSettings();
      }
      }
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '授權未完成，請重試。'); }
    finally { setBusy(false); }
  }

  async function prepare() {
    setBusy(true); setError(null);
    try {
      const result = await window.app.prepareAppleTranslation(source, target, sttModel);
      if (currentPair.current === translationPair) setTranslation(result);
    }
    catch { setError('語言包準備未完成，請重試。'); }
    finally { setBusy(false); }
  }

  const permissionNames: Record<PermissionKey, string> = {
    microphone: '麥克風', screen: '系統音訊', speech: '語音辨識',
    accessibility: '輔助使用', input: '輸入監控',
  };
  const keys: PermissionKey[] = ['microphone', 'screen', 'speech', 'accessibility', 'input'];
  return <><section className="setup-panel va-card va-card-bodyless" id="usage-setup" aria-label="系統權限清單">
    <div className="setup-body bc-card-body">
      <div className="setup-checklist">
        {keys.map(key => <div className="setup-row" key={key}>
          <strong>{permissionNames[key]}</strong>
          <div className="setup-permission-action">
            {permissions[key] === undefined ? <span className="setup-permission-status">檢查中</span>
              : permissions[key] ? <span className="setup-permission-status setup-ready"><span aria-hidden="true">✓</span>已允許</span>
              : <button className="button-secondary" disabled={busy} title={`允許${permissionNames[key]}`} onClick={() => void request([key])}>允許</button>}
          </div>
        </div>)}
      </div>
      {busy && <p role="status" className="model-hint">請完成系統授權提示。</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
    </div>
  </section>
      {translationEnabled && <section className="setup-translation va-card va-card-bodyless" aria-labelledby="translation-pack-title">
        <div className="bc-card-header"><h3 className="bc-card-title" id="translation-pack-title">翻譯語言包</h3></div>
        <div className="bc-card-body">
        <div className="setup-row">
          <span>{languageNames[source] ?? source} → {languageNames[target] ?? target}</span>
          {translation?.status === 'installed' ? <span className="setup-ready">已就緒</span> :
            <button className="button-secondary" disabled={busy || translation?.status === 'unsupported'} onClick={() => void prepare()}>準備語言包</button>}
        </div>
        </div>
      </section>}
    {actionTarget && createPortal(<>
        <button className="button-primary" disabled={busy || keys.every(key => permissions[key] === true) || keys.some(key => permissions[key] === undefined)} onClick={() => void request(keys)}>授予所有權限</button>
        <button className="button-secondary" disabled={busy} onClick={() => void refresh().catch(() => setError('無法檢查，請重試。'))}>重新檢查</button>
        {restartNeeded && <button className="button-secondary" disabled={busy} onClick={() => window.app.relaunchApp()}>重新開啟</button>}
    </>, actionTarget)}
  </>;
}
