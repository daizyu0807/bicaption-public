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
