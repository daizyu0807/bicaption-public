import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const nativeHotkeySource = readFileSync(
  new URL('../electron/native-hotkey.ts', import.meta.url),
  'utf8',
);

test('stale native hotkey children cannot clear the active listener reference', () => {
  const ownershipGuards = nativeHotkeySource.match(
    /if \(this\.child === child\) \{\s*this\.child = null;\s*\}/g,
  );
  assert.equal(ownershipGuards?.length, 2, 'both child error and exit handlers must verify ownership');
});
