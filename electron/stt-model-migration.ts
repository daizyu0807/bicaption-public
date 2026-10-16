// Engines that no longer have an option anywhere in the app. A setting that still names one is moved to the engine
// that suits the source language, so an old settings file cannot select a model nothing downloads or runs.
const RETIRED_STT_MODELS = new Set([
  "apple-speech-analyzer",
  "gemini-live",
  "whisper-tiny-en",
  "whisper-small",
  "zipformer-ko",
]);

export function migrateRetiredSttModel(model: string, sourceLang: string): string {
  if (!RETIRED_STT_MODELS.has(model)) return model;
  return sourceLang.trim().toLowerCase() === "auto" ? "sensevoice" : "apple-stt";
}
