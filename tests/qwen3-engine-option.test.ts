import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../src/App.tsx');
const downloader = read('../electron/model-downloader.ts');
const types = read('../electron/types.ts');
const settings = read('../electron/settings.ts');

test('Qwen3-ASR is a selectable dictation engine with an honest label and note', () => {
  const options = app.match(/const ASR_MODEL_OPTIONS = \[([\s\S]*?)\] as const;/);
  assert.ok(options, 'ASR_MODEL_OPTIONS should exist');
  assert.match(options[1], /key: 'qwen3-asr', label: 'Qwen3-ASR 高準確度（實驗）', note: '本地 \/ 約 1 GB 記憶體 \/ 吃個人詞庫'/);
  const unavailable = app.match(/function isAsrModelUnavailableInMode\(modelKey: string, mode: SessionMode\) \{([\s\S]*?)\n\}/);
  assert.ok(unavailable);
  assert.match(unavailable[1], /modelKey === 'qwen3-asr'[\s\S]*mode !== 'dictation'/, 'dictation only');
  assert.match(app, /option\.key === 'qwen3-asr' && !localModelStatus\?\.qwen3Asr/, 'disabled until the model and runtime are there');
  assert.match(app, /'qwen3-asr': status\?\.qwen3Asr \?\? false,/);
  assert.match(app, /draft\.dictationSttModel === 'qwen3-asr'/, 'the engine row explains what it does');
});

test('the model library can download Qwen3-ASR and shows when the runtime is missing', () => {
  const library = app.match(/const MODEL_LIBRARY = \[([\s\S]*?)\] as const;/);
  assert.ok(library);
  assert.match(library[1], /key: 'qwen3-asr'/);
  assert.match(library[1], /sizeLabel: '~0\.6 GB'/);
  assert.match(app, /case 'qwen3-asr':\s*return status\?\.qwen3Asr \?\? false;/);
  assert.match(app, /entry\.key !== 'qwen3-asr' \|\| Boolean\(localModelStatus\?\.qwen3AsrRuntime\)/);
});

test('the downloader reports Qwen3 status and fetches one GGUF file after installing the binding', () => {
  assert.match(downloader, /const QWEN3_ASR_MODEL_FILE = 'Qwen3-ASR-0\.6B-Q4_K_M\.gguf';/);
  assert.match(downloader, /handy-computer\/Qwen3-ASR-0\.6B-gguf\/resolve\/main\/Qwen3-ASR-0\.6B-Q4_K_M\.gguf/);
  assert.match(downloader, /'qwen3-asr': \{ file: QWEN3_ASR_MODEL_FILE, url: QWEN3_ASR_MODEL_URL, stage: 'qwen3-asr', isArchive: false, packageName: 'transcribe-cpp' \}/);
  assert.match(downloader, /qwen3AsrRuntime,\s*qwen3Asr,/);
  assert.match(downloader, /const qwen3Asr = qwen3AsrRuntime && existsSync\(join\(this\.pythonDir, QWEN3_ASR_MODEL_FILE\)\);/);
  assert.match(downloader, /const qwen3AsrRuntime = this\.checkTranscribeRuntimeReady\(\);/);
  assert.match(downloader, /private checkTranscribeRuntimeReady\(\): boolean \{\s*if \(!app\.isPackaged\) \{\s*return this\.checkPythonPackage\('transcribe-cpp'\);[\s\S]*?TRANSCRIBE_RUNTIME_MARKER/);
  assert.match(types, /qwen3Asr: boolean;\s*qwen3AsrRuntime: boolean;/);
  assert.equal((types.match(/'qwen3-asr'/g) ?? []).length >= 1, true, 'the download stage union knows the engine');
});

test('subtitle and meeting never inherit a dictation-only engine', () => {
  const subtitle = settings.match(/function normalizeSubtitleSttModel[\s\S]*?\n\}/)![0];
  const meeting = settings.match(/function normalizeMeetingSttModel[\s\S]*?\n\}/)![0];
  assert.match(subtitle, /candidate === 'qwen3-asr'/);
  assert.match(meeting, /candidate === 'qwen3-asr'/);
});
