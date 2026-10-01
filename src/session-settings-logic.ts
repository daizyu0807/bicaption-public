import type { AppSettings } from '../electron/types.js';
import { migrateRetiredSttModel } from '../electron/stt-model-migration.js';

// Apple SFSpeechRecognizer needs a fixed locale; the sidecar silently
// falls back to en-US when it receives "auto", so the UI must not allow
// that combination.
export function sttModelSupportsAutoDetect(model: string): boolean {
  return model !== 'apple-stt';
}

// Only correct combinations that would silently misbehave; never override
// an engine the user picked on purpose.
export function resolveSttModelForSourceLang(sourceLang: string, currentModel: string): string {
  currentModel = migrateRetiredSttModel(currentModel, sourceLang);
  if (sourceLang === 'auto' && !sttModelSupportsAutoDetect(currentModel)) {
    return 'sensevoice';
  }
  return currentModel;
}

export function getDefaultSubtitleTargetLang(sourceLang: string): string {
  return sourceLang === 'zh-TW' ? 'en' : 'zh-TW';
}

// When the source language changes and now collides with the target,
// pick a sensible default target so translation keeps doing something.
export function resolveTargetLangForSourceLang(
  sourceLang: string,
  targetLang: string,
  translationEnabled: boolean,
): string {
  if (translationEnabled && targetLang === sourceLang) {
    return getDefaultSubtitleTargetLang(sourceLang);
  }
  return targetLang;
}

export function isTranslationEnabled(
  settings: Pick<AppSettings, 'sttModel' | 'translateModel' | 'sourceLang' | 'targetLang'>,
): boolean {
  if (settings.translateModel === 'disabled') return false;
  return settings.sourceLang === 'auto' || settings.targetLang !== settings.sourceLang;
}
