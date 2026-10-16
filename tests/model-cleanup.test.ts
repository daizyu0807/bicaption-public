import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { migrateRetiredSttModel } from '../electron/stt-model-migration.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('a settings file naming an engine with no option anywhere is moved to a selectable one', () => {
  for (const retired of ['gemini-live', 'apple-speech-analyzer', 'whisper-tiny-en', 'whisper-small', 'zipformer-ko']) {
    assert.equal(migrateRetiredSttModel(retired, 'en'), 'apple-stt', retired);
    assert.equal(migrateRetiredSttModel(retired, 'auto'), 'sensevoice', retired);
  }
  for (const kept of ['apple-stt', 'sensevoice', 'breeze-asr-25', 'breeze-gguf', 'qwen3-asr', 'groq-whisper']) {
    assert.equal(migrateRetiredSttModel(kept, 'en'), kept, kept);
  }
});

test('the downloader only knows models that have an option in the app', () => {
  const downloader = read('../electron/model-downloader.ts');
  for (const trial of ['whisper-tiny', 'whisper-small', 'zipformer', 'whisper-large-v3-turbo', 'mlxWhisper', 'DEFAULT_MLX_WHISPER_MODEL']) {
    assert.ok(!downloader.includes(trial), `${trial} must not be downloaded or tracked`);
  }
  const map = downloader.match(/MODEL_MAP[\s\S]*?\n  \};/)?.[0] ?? '';
  const keys = [...map.matchAll(/^\s+'?([a-z0-9-]+)'?: \{/gm)].map((m) => m[1]).filter((k) => k !== 'dir');
  assert.deepEqual(keys.sort(), ['breeze-asr-25', 'breeze-gguf', 'qwen3-asr', 'sensevoice', 'vad']);
});

test('every downloadable model is selectable in at least one feature', () => {
  const app = read('../src/App.tsx');
  const options = app.match(/const ASR_MODEL_OPTIONS = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
  const selectable = new Set([...options.matchAll(/key: '([a-z0-9-]+)'/g)].map((m) => m[1]));
  for (const key of ['sensevoice', 'breeze-asr-25', 'qwen3-asr', 'breeze-gguf']) {
    assert.ok(selectable.has(key), `${key} has a download but no option`);
  }
});
