import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const app = read('src/App.tsx');
const downloader = read('electron/model-downloader.ts');
const settings = read('electron/settings.ts');
const types = read('electron/types.ts');

test('Breeze GGUF is a selectable dictation-only engine that stays disabled until model and runtime exist', () => {
  assert.match(app, /key: 'breeze-gguf', label: 'Breeze 台灣中文輕量版（實驗）'/);
  assert.match(app, /modelKey === 'breeze-gguf'\) && mode !== 'dictation'/, 'dictation only');
  assert.match(app, /option\.key === 'breeze-gguf' && !localModelStatus\?\.breezeGguf/);
  assert.match(app, /'breeze-gguf': status\?\.breezeGguf \?\? false,/);
  assert.match(app, /case 'breeze-gguf':\s*return status\?\.breezeGguf \?\? false;/);
  assert.match(app, /entry\.key !== 'breeze-gguf' \|\| Boolean\(localModelStatus\?\.breezeGgufRuntime\)/);
});

test('the downloader fetches the Q4_K_M GGUF after installing the binding and reports status', () => {
  assert.match(downloader, /const BREEZE_GGUF_MODEL_FILE = 'Breeze-ASR-25-Q4_K_M\.gguf';/);
  assert.match(downloader, /handy-computer\/Breeze-ASR-25-gguf\/resolve\/main\/Breeze-ASR-25-Q4_K_M\.gguf/);
  assert.match(downloader, /'breeze-gguf': \{ file: BREEZE_GGUF_MODEL_FILE, url: BREEZE_GGUF_MODEL_URL, stage: 'breeze-gguf', isArchive: false, packageName: 'transcribe-cpp' \}/);
  assert.match(downloader, /breezeGgufRuntime,\s*breezeGguf,/);
  assert.match(types, /breezeGguf: boolean;\s*breezeGgufRuntime: boolean;/);
  assert.match(types, /'breeze-gguf'/);
});

test('subtitle and meeting modes never keep the dictation-only Breeze GGUF engine', () => {
  assert.equal((settings.match(/candidate === 'breeze-gguf'/g) ?? []).length, 2);
});
