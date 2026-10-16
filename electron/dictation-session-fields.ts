import type { AppSettings, CaptionConfig, SessionMode } from './types.js';

/**
 * Dictation vocabulary fields shared by every CaptionConfig builder (main process hotkey/tray and renderer),
 * so the two builders cannot drift apart. Only dictation sessions carry them; the personal dictionary is
 * dropped when it is switched off.
 */
export function buildDictationVocabularyFields(
  settings: Pick<AppSettings, 'dictationInitialPromptText' | 'dictationDictionaryEnabled' | 'dictationDictionaryText' | 'dictationHotwords'>,
  mode: SessionMode,
): Pick<CaptionConfig, 'dictationInitialPromptText' | 'dictationDictionaryText' | 'dictationHotwords'> {
  if (mode !== 'dictation') {
    return { dictationInitialPromptText: undefined, dictationDictionaryText: undefined, dictationHotwords: undefined };
  }
  return {
    dictationInitialPromptText: settings.dictationInitialPromptText,
    dictationDictionaryText: settings.dictationDictionaryEnabled ? settings.dictationDictionaryText : undefined,
    dictationHotwords: settings.dictationHotwords,
  };
}
