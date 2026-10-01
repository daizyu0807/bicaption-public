import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppleTranslationStatus } from '../electron/types.js';

type PermissionKey = 'microphone' | 'speech' | 'screen' | 'accessibility' | 'input';

export function SetupPanel({ source, target, translationEnabled, needsSpeech, sttModel = '', onPermissionsResolved, onClose }: {
  source: string; target: string; translationEnabled: boolean; needsSpeech: boolean; sttModel?: string; onPermissionsResolved?: (ready: boolean) => void; onClose?: () => void;
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

  return <section className="setup-panel" id="usage-setup" aria-labelledby="setup-title">
    <header className="setup-header">
      <div className="setup-header-copy">
        <h2 id="setup-title">使用準備</h2>
        <p>準備收音與翻譯，聽寫功能可依需要再設定。</p>
      </div>
      {onClose && <button className="setup-dialog-close" type="button" aria-label="關閉使用準備" onClick={onClose}>×</button>}
    </header>
    <div className="setup-body">
      <section className="setup-permissions" aria-labelledby="setup-permissions-title">
        <h3 id="setup-permissions-title" className="sr-only">功能準備</h3>
        <div className="setup-checklist">
          <div className="setup-row">
            <div><strong>字幕收音</strong><p>使用麥克風與系統音訊產生字幕。{needsSpeech ? ' Apple 辨識另需語音辨識授權。' : ''}</p></div>
            {permissionsReady ? <span className="setup-ready"><span aria-hidden="true">✓</span> 已就緒</span> :
              <button className="button-secondary" disabled={busy} onClick={() => void request(requiredPermissions)}>
                {busy ? '設定中…' : '設定收音'}
              </button>}
          </div>
          <div className="setup-row setup-optional-row">
            <div><strong>聽寫輸入 <span className="setup-optional-label">選用</span></strong><p>使用快捷鍵或自動貼上時，才需要輸入監控與輔助使用。</p></div>
            {dictationReady ? <span className="setup-ready"><span aria-hidden="true">✓</span> 已就緒</span> :
              <button className="button-secondary" disabled={busy} onClick={() => void request(dictationPermissions)}>設定聽寫</button>}
          </div>
        </div>
      </section>
      {translationEnabled && <section className="setup-translation" aria-labelledby="setup-translation-title">
        <div className="setup-section-heading"><h3 id="setup-translation-title">翻譯語言包</h3><span className="setup-local-label">Apple 本機翻譯</span></div>
        <div className="setup-row">
          <div><strong>{source === 'auto' || sttModel === 'breeze-asr-25' ? '自動辨識 → ' : `${({en:'英文', 'zh-TW':'繁體中文', ja:'日文', ko:'韓文'} as Record<string,string>)[source] ?? source} → `}{({en:'英文', 'zh-TW':'繁體中文', ja:'日文', ko:'韓文'} as Record<string,string>)[target] ?? target}</strong>
            <p>{sttModel === 'breeze-asr-25' ? '準備中英文翻譯配對' : source === 'auto' ? '準備英文、繁中、日文與韓文的可用配對' : '下載一次，之後可離線翻譯'}</p></div>
          {translation?.status === 'installed' ? <span className="setup-ready"><span aria-hidden="true">✓</span> 可離線使用</span> :
            <button className="button-secondary" disabled={busy || translation?.status === 'unsupported'} onClick={() => void prepare()}>
              {busy ? '準備中…' : '準備語言包'}
            </button>}
        </div>
        {translation?.message && <p role="status" className="model-hint">{translation.message}</p>}
      </section>}
      {busy && <p role="status" className="model-hint">請完成系統提示；下載進度會顯示在 Apple 的視窗中。</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
    </div>
    <footer className="setup-footer">
      <div className="setup-footer-copy"><strong>{restartNeeded ? '完成後，重新開啟一次' : ready ? '已完成準備' : '設定只需完成一次'}</strong>
        <p>{restartNeeded ? '確認系統設定已勾選，再重新開啟 BiCaption。' : ready ? '可以關閉此視窗，回到字幕或語音輸入。' : '系統若詢問立即重開，可先選稍後，完成後再一起重開。'}</p>
      </div>
      <div className="setup-footer-actions">
        <button className="button-secondary" disabled={busy} onClick={() => void refresh().catch(() => setError('無法檢查，請重試。'))}>重新檢查</button>
        {restartNeeded && <button className="button-primary" disabled={busy} onClick={() => window.app.relaunchApp()}>完成設定並重新開啟一次</button>}
      </div>
    </footer>
  </section>;
}
