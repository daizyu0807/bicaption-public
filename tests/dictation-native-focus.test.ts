import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
test('focus lookup uses the focused window rather than the first app window', () => {
  assert.ok(source.includes('AXFocusedWindow'));
});
test('paste sends the physical V key so a Chinese input method cannot alter it', () => {
  assert.ok(source.includes('key code 9 using command down'));
});
test('the actual focus script compiles on macOS', { skip: process.platform !== 'darwin' }, () => {
  const body = source.split('async function getFrontmostFocusSnapshot():')[1];
  const array = body.slice(body.indexOf('runAppleScript([') + 'runAppleScript('.length, body.indexOf('])).trimEnd()') + 1);
  const lines = vm.runInNewContext(array) as string[];
  execFileSync('/usr/bin/osacompile', ['-o', '/private/tmp/bicaption-focus-test.scpt', ...lines.flatMap(line => ['-e', line])]);
});
