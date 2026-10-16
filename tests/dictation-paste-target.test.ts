import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');

test('dictation records the paste target before the overlay is shown, without delaying the microphone', () => {
  const match = mainSource.match(
    /async function startDictationFromHotkey\(\) \{([\s\S]*?)\n\}\n\nfunction emitLocalDictationProcessingState/,
  );
  assert.ok(match, 'startDictationFromHotkey implementation should exist');

  const body = match[1];
  const snapshotIndex = body.indexOf('getFrontmostFocusSnapshotWithRetry()');
  const transitionIndex = body.indexOf('await runSessionTransition');

  assert.notEqual(snapshotIndex, -1, 'paste target should be captured when dictation starts');
  assert.ok(snapshotIndex < transitionIndex, 'the snapshot starts before the session, and runs concurrently with it');
  // The only place the overlay is shown is the reveal closure, which runs from the snapshot callback or the timeout.
  assert.equal(body.split('showDictationOverlay()').length - 1, 1, 'the overlay must not be shown directly');
  assert.match(body, /const revealOverlay = \(\) => \{[\s\S]*?showDictationOverlay\(\);[\s\S]*?\};/);
  assert.match(body, /setTimeout\(revealOverlay, DICTATION_SNAPSHOT_OVERLAY_TIMEOUT_MS\)/);
  assert.match(body, /\.then\(\(snapshot\) => \{[\s\S]*?revealOverlay\(\);/);
  assert.doesNotMatch(body, /= await getFrontmostFocusSnapshotWithRetry\(\)/, 'the snapshot must not block the microphone');
  assert.match(body, /dictationSnapshotPending = true/);
  assert.match(mainSource, /if \(!dictationSnapshotPending\) showDictationOverlay\(\)/, 'sidecar state events must not show the overlay early');
});
