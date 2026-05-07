import test from 'node:test';
import assert from 'node:assert/strict';
import { getActivateBehavior } from '../electron/activate-behavior.ts';

test('activate keeps settings hidden when only subtitle overlay is visible', () => {
  assert.equal(
    getActivateBehavior({
      settingsVisible: false,
      overlayVisible: true,
    }),
    'noop',
  );
});

test('activate does not change settings visibility when overlay and settings are both visible', () => {
  assert.equal(
    getActivateBehavior({
      settingsVisible: true,
      overlayVisible: true,
    }),
    'noop',
  );
});

test('activate shows settings when no overlay is visible', () => {
  assert.equal(
    getActivateBehavior({
      settingsVisible: false,
      overlayVisible: false,
    }),
    'show-settings',
  );
});

test('activate shows settings when settings is already visible and overlay is hidden', () => {
  assert.equal(
    getActivateBehavior({
      settingsVisible: true,
      overlayVisible: false,
    }),
    'show-settings',
  );
});
