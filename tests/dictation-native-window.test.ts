import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNativeFocusGeometry } from '../electron/dictation-native-window.js';

const native = { x: 886, y: -1410, width: 1720, height: 1410 };
test('oversized accessibility geometry cannot select the wrong monitor', () => {
  assert.deepEqual(resolveNativeFocusGeometry(native, null), { window: native, input: null });
});
test('oversized or off-window editor elements are rejected', () => {
  assert.equal(resolveNativeFocusGeometry(native, { x: -1666, y: -1562, width: 1128, height: 3749 }).input, null);
});
test('valid focused input keeps its coordinates without multiplying Retina scale', () => {
  const input = { x: 1000, y: -400, width: 700, height: 150 };
  assert.deepEqual(resolveNativeFocusGeometry(native, input), { window: native, input });
});
