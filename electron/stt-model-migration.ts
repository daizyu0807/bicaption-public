export function migrateRetiredSttModel(model: string, sourceLang: string): string {
  if (model !== "apple-speech-analyzer" && model !== "gemini-live") return model;
  return sourceLang.trim().toLowerCase() === "auto" ? "sensevoice" : "apple-stt";
}
