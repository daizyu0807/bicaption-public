import test from 'node:test';
import assert from 'node:assert/strict';
import { isInputDevice, pickPreferredInputDevice } from '../src/device-preferences.js';

test('pickPreferredInputDevice prefers built-in microphones over continuity devices', () => {
  const selected = pickPreferredInputDevice([
    { id: '1', label: 'iPhone Microphone (1ch)', kind: 'input' },
    { id: '2', label: 'MacBook Pro Microphone (1ch)', kind: 'input' },
  ]);

  assert.equal(selected?.id, '2');
});

test('pickPreferredInputDevice deprioritizes virtual loopback devices when a real mic exists', () => {
  const selected = pickPreferredInputDevice([
    { id: '1', label: 'Loopback Audio (2ch)', kind: 'input' },
    { id: '2', label: 'USB Headset Microphone (1ch)', kind: 'input' },
  ]);

  assert.equal(selected?.id, '2');
});

test('isInputDevice accepts duplex devices', () => {
  assert.equal(isInputDevice({ id: '1', label: 'Built-in Microphone (2in/2out)', kind: 'duplex' }), true);
  assert.equal(isInputDevice({ id: '2', label: 'Built-in Output (2ch)', kind: 'output' }), false);
});

import { resolveDictationDeviceId, SYSTEM_DEFAULT_DEVICE_ID } from '../src/device-preferences.js';

const mic = { id: 'MacBook Pro的麥克風', label: 'MacBook Pro的麥克風', kind: 'input' };
const pods = { id: 'AirPods', label: 'AirPods', kind: 'duplex' };
const speaker = { id: 'MacBook Pro的揚聲器', label: 'MacBook Pro的揚聲器', kind: 'output' };

test('dictation follows the system default input unless a still-present device was chosen', () => {
  assert.equal(SYSTEM_DEFAULT_DEVICE_ID, '__system_default__');
  assert.equal(resolveDictationDeviceId('', [mic, pods]), SYSTEM_DEFAULT_DEVICE_ID);
  assert.equal(resolveDictationDeviceId(SYSTEM_DEFAULT_DEVICE_ID, [mic, pods]), SYSTEM_DEFAULT_DEVICE_ID);
  assert.equal(resolveDictationDeviceId('AirPods', [mic, pods]), 'AirPods');
});

test('a chosen device that is gone, or is not an input, falls back to following the system, not to the built-in mic', () => {
  assert.equal(resolveDictationDeviceId('AirPods', [mic]), SYSTEM_DEFAULT_DEVICE_ID);
  assert.equal(resolveDictationDeviceId('MacBook Pro的揚聲器', [mic, speaker]), SYSTEM_DEFAULT_DEVICE_ID);
});

test('the settings screen offers the follow-system option first and new installs default to it', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<option value=\{SYSTEM_DEFAULT_DEVICE_ID\}>跟隨系統預設輸入裝置<\/option>\s*\{inputDevices\.map/);
  assert.match(app, /dictationDeviceId: resolveDictationDeviceId\(loadedSettings\.dictationDeviceId, loadedDevices\)/);
  const settings = readFileSync(new URL('../electron/settings.ts', import.meta.url), 'utf8');
  assert.match(settings, /dictationDeviceId: '__system_default__',/);
});
