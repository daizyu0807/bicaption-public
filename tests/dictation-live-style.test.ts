import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('every live dictation indicator uses the blue-cyan palette', () => {
  assert.match(styles, /\.dictation-float-shell-live \.dictation-float-step-active\s*\{[^}]*rgba\(6, 182, 212,/s);
  assert.doesNotMatch(styles, /dictation-prompt/);
});
