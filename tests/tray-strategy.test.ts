import test from 'node:test';
import assert from 'node:assert/strict';
import { getTrayImagePreferenceOrder } from '../electron/tray-strategy.ts';

test('packaged builds prefer tray template before app icon', () => {
  assert.deepEqual(getTrayImagePreferenceOrder({ isPackaged: true }), [
    'template-file',
    'inline-template',
    'named-template',
    'app-icon',
  ]);
});

test('dev builds keep app icon ahead of template fallbacks', () => {
  assert.deepEqual(getTrayImagePreferenceOrder({ isPackaged: false }), [
    'app-icon',
    'template-file',
    'inline-template',
    'named-template',
  ]);
});
