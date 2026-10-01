const languages = ['en', 'zh-TW', 'ja', 'ko'];
function normalize(value: string): string {
  const aliases: Record<string,string> = { zh:'zh-TW', 'zh-hant':'zh-TW', 'zh-tw':'zh-TW', 'en-us':'en', 'en-gb':'en', 'ja-jp':'ja', 'ko-kr':'ko' };
  return aliases[value.trim().toLowerCase()] ?? value.trim().toLowerCase();
}
export function getTranslationPairs(source: string, target: string, model = ''): Array<[string,string]> | null {
  source = normalize(source); target = normalize(target);
  if (!languages.includes(target)) return null;
  // Breeze handles Chinese/English mixing; translation source is detected per fragment.
  const sources = model === 'breeze-asr-25' ? ['en','zh-TW']
    : source === 'auto' ? languages : languages.includes(source) ? [source] : null;
  return sources?.filter(from => from !== target).map(from => [from,target]) ?? null;
}
