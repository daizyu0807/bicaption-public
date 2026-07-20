import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');

test('dictation captures the paste target before showing the recording overlay', () => {
  const match = mainSource.match(
    /async function startDictationFromHotkey\(\) \{([\s\S]*?)\n\}\n\nfunction emitLocalDictationProcessingState/,
  );
  assert.ok(match, 'startDictationFromHotkey implementation should exist');

  const body = match[1];
  const captureIndex = body.indexOf('pendingDictationPasteTarget = await getFrontmostFocusSnapshotWithRetry()');
  const overlayIndex = body.indexOf('showDictationOverlay()');

  assert.notEqual(captureIndex, -1, 'paste target should be captured when dictation starts');
  assert.notEqual(overlayIndex, -1, 'dictation overlay should still be shown');
  assert.ok(captureIndex < overlayIndex, 'paste target must be captured before the overlay can affect focus');
  assert.doesNotMatch(body, /pendingDictationPasteTarget = null/);
});
