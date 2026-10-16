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
  assert.match(resolvedBounds[1], /return getDefaultDictationOverlayBounds\(getDictationTargetDisplay\(\)\)/);
  assert.doesNotMatch(resolvedBounds[1], /getInputAnchoredBounds|dictationOverlayBoundsCache/);
  assert.match(defaultBounds[1], /workArea\.x \+ \(workArea\.width - DICTATION_OVERLAY_WIDTH\) \/ 2/);
  assert.match(defaultBounds[1], /workArea\.y \+ workArea\.height - DICTATION_OVERLAY_SIZE - 128/);
});

test('the overlay stays long enough to read a blocked paste or an empty result', () => {
  assert.match(mainSource, /const DICTATION_WARNING_VISIBLE_MS = 5000;/);
  assert.match(mainSource, /hideDictationOverlaySoon\(dictationResultNeedsReading \? DICTATION_WARNING_VISIBLE_MS : 1800\)/);
  assert.match(mainSource, /dictationResultNeedsReading = result.status === 'fallback';/);
});

test('the cancel button closes the overlay at once and ignores late events from the discarded session', () => {
  const cancel = mainSource.match(/ipcMain\.handle\('dictation:cancel'[\s\S]*?return \{ ok: true \};\n  \}\);/);
  assert.ok(cancel, 'cancel handler should exist');
  assert.ok(cancel[0].indexOf('hideDictationOverlayNow()') < cancel[0].indexOf('await sessionTransitionPromise'),
    'the overlay must be hidden before waiting for a starting session');
  assert.match(cancel[0], /cancelledDictationSessions\.add/);
  assert.match(mainSource, /dictationOverlaySuppressed \|\| cancelledDictationSessions\.has\(event\.sessionId\)/);
  assert.match(mainSource, /cancelledDictationSessions\.delete\(event\.sessionId\)/);
  assert.match(mainSource, /async function startDictationFromHotkey\(\) \{\n  dictationOverlaySuppressed = false;/);
});

test('the confirm button shows the recognising stage before the stop round trip', () => {
  const confirm = mainSource.match(/ipcMain\.handle\('dictation:confirm'[\s\S]*?return \{ ok: true \};\n  \}\);/);
  assert.ok(confirm, 'confirm handler should exist');
  assert.ok(confirm[0].indexOf('emitLocalDictationProcessingState()') < confirm[0].indexOf('await stopDictationFromHotkey()'));
});

test('ggml-metal start-up logging from the GGUF backend is not turned into a sidecar error event', () => {
  const sidecarSource = readFileSync(new URL('../electron/sidecar.ts', import.meta.url), 'utf8');
  const patterns = sidecarSource.match(/const ignoredStderrPatterns = \[([\s\S]*?)\];/);
  assert.ok(patterns, 'ignoredStderrPatterns should exist');
  assert.match(patterns[1], /'ggml_metal_'/);
});

test('every press measures how long the user is not being recorded', () => {
  assert.match(mainSource, /dictationHotkeyDownAtMs = Date\.now\(\)/);
  assert.match(mainSource, /dictation hotkey_to_streaming_ms=/);
});

test('the modifier-only start delay is a short, tunable constant instead of a hard-coded 160 ms', () => {
  assert.match(mainSource, /const DICTATION_MODIFIER_ONLY_START_DELAY_MS = Math\.max\(0, Number\(process\.env\.BICAPTION_DICTATION_MODIFIER_START_MS \?\? 100\) \|\| 0\);/);
  assert.match(mainSource, /\}, DICTATION_MODIFIER_ONLY_START_DELAY_MS\);/);
  assert.doesNotMatch(mainSource, /\}, 160\);/);
});

test('the renderer learns the final text before the paste, so the outputting stage is real', () => {
  const body = mainSource.match(/async function handleDictationFinal\(event: SidecarEvent\) \{([\s\S]*?)\n\}\n\nfunction runAppleScript/);
  assert.ok(body, 'handleDictationFinal should exist');
  const text = body[1];
  const sendFinal = text.indexOf("sendToWindows('sidecar:event', event)");
  assert.notEqual(sendFinal, -1);
  assert.equal(text.split("sendToWindows('sidecar:event', event)").length - 1, 1, 'the final event is sent exactly once');
  assert.ok(sendFinal < text.indexOf('deliverDictationOutput('), 'sent after polishing and before the clipboard and paste');
  assert.ok(sendFinal > text.indexOf('polishDictationText'), 'sent after the polish has produced the text');
  assert.ok(text.indexOf('clearActiveSession(event.sessionId)') > text.indexOf('deliverDictationOutput('), 'session bookkeeping still happens last');
});
