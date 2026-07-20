import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');

test('dictation overlay follows the active input display instead of the primary display', () => {
  assert.match(
    mainSource,
    /function getDictationTargetDisplay\(\)[\s\S]*screen\.getDisplayMatching\([\s\S]*pendingDictationPasteTarget/,
  );
  assert.match(
    mainSource,
    /screen\.getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)/,
  );

  const defaultBounds = mainSource.match(
    /function getDefaultDictationOverlayBounds[\s\S]*?\{([\s\S]*?)\n\}\n\nfunction getDictationOverlayBounds/,
  );
  assert.ok(defaultBounds, 'default dictation overlay bounds should exist');
  assert.doesNotMatch(defaultBounds[1], /getPrimaryDisplay/);
  assert.match(defaultBounds[1], /targetDisplay\.workArea/);

  const resolvedBounds = mainSource.match(
    /function getDictationOverlayBounds\(\) \{([\s\S]*?)\n\}\n\nfunction restoreSubtitleOverlayBounds/,
  );
  assert.ok(resolvedBounds, 'resolved dictation overlay bounds should exist');
  assert.match(resolvedBounds[1], /cachedDisplay\.id === targetDisplay\.id/);
});
