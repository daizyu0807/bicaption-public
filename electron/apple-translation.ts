import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getAppleTranslationPath } from './paths.js';
import type { AppleTranslationStatus } from './types.js';

import { getTranslationPairs } from './translation-languages.js';
let pendingPreparation: Promise<AppleTranslationStatus> | null = null;
export async function prepareAppleTranslation(source: string, target: string, prepare = false, sttModel = ''): Promise<AppleTranslationStatus> {
  if (prepare) {
    if (pendingPreparation) return { status: 'error', message: '另一組語言包正在準備，請完成後再試。' };
    pendingPreparation = runAppleTranslation(source, target, true, sttModel);
    try { return await pendingPreparation; }
    finally { pendingPreparation = null; }
  }
  return runAppleTranslation(source, target, false, sttModel);
}

async function runAppleTranslation(source: string, target: string, prepare: boolean, sttModel: string): Promise<AppleTranslationStatus> {
  const pairs = getTranslationPairs(source, target, sttModel);
  if (!pairs) {
    return { status: 'unsupported', message: '這組翻譯語言目前無法使用。' };
  }
  const helper = getAppleTranslationPath();
  if (!existsSync(helper)) return { status: 'error', message: 'Apple 翻譯元件缺失，請重新安裝 BiCaption。' };
  let result: AppleTranslationStatus = { status: 'installed' };
  for (const [from, to] of pairs) {
    const state = await new Promise<AppleTranslationStatus>((resolve) => {
      execFile(helper, [prepare ? '--prepare' : '--status', '--source', from, '--target', to],
        { timeout: prepare ? 15 * 60_000 : 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
          try {
            const reply = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as AppleTranslationStatus;
            if (!['installed', 'supported', 'unsupported', 'error'].includes(reply.status)) throw new Error('Invalid status');
            resolve(reply);
          } catch {
            resolve({ status: 'error', message: error?.killed ? '語言包準備逾時，請重試。' : '無法確認 Apple 翻譯狀態，請重試。' });
          }
        });
    });
    if (state.status === 'error' || state.status === 'unsupported') return state;
    if (state.status === 'supported') result = state;
  }
  return result;
}
