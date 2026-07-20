import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('every live dictation indicator uses the blue-cyan palette', () => {
  assert.match(styles, /\.dictation-prompt-live\s*\{[^}]*rgba\(6, 182, 212,/s);
  assert.match(styles, /\.dictation-prompt-dot\s*\{[^}]*background:\s*#06b6d4;/s);
  assert.match(styles, /\.dictation-prompt-ring\s*\{[^}]*rgba\(6, 182, 212,/s);
});
