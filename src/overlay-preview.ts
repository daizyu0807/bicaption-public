export type OverlayMode = 'hidden' | 'subtitle' | 'dictation' | 'preview';
export function shouldRenderSubtitleOverlay(mode: OverlayMode, sessionState: string, hasCaptions: boolean): boolean {
  return mode === 'preview' || mode === 'subtitle' || hasCaptions || ['streaming','connecting'].includes(sessionState);
}
export function getSubtitlePreview(source: string, target: string) {
  const samples: Record<string,string> = {
    en: 'This is a preview of your live captions.',
    'zh-TW': '這是即時字幕的預覽。',
    ja: 'これはリアルタイム字幕のプレビューです。',
    ko: '실시간 자막 미리보기입니다.',
  };
  return { sourceText: samples[source] ?? samples.en, translatedText: samples[target] ?? samples['zh-TW'] };
}
