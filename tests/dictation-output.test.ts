import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverDictationOutput, type DictationOutputDeps } from '../electron/dictation-output.js';
import type { ClipboardLike } from '../electron/dictation-clipboard.js';

function setup(overrides: Partial<DictationOutputDeps> = {}, initialText = 'original') {
  const state = { text: initialText, formats: initialText ? ['text/plain'] : [] as string[] };
  const log: string[] = [];
  const clipboard: ClipboardLike = {
    availableFormats: () => state.formats,
    readText: () => state.text,
    readHTML: () => '',
    readRTF: () => '',
    readImage: () => ({ isEmpty: () => true }),
    write: (data) => { state.text = data.text ?? ''; log.push('write'); },
    writeText: (text) => { state.text = text; state.formats = ['text/plain']; log.push('writeText'); },
    clear: () => { state.text = ''; state.formats = []; log.push('clear'); },
  };
  const deps: DictationOutputDeps = {
    clipboard,
    checkPasteAllowed: async () => ({ ok: true }),
    sendPasteShortcut: async () => { log.push('cmd-v'); return true; },
    describeFallback: async (reason) => `fallback:${reason}`,
    sleep: async () => { log.push('settle'); },
    trace: () => {},
    ...overrides,
  };
  return { deps, state, log };
}

test('copy mode leaves the result on the clipboard and never pastes', async () => {
  const { deps, state, log } = setup();
  assert.deepEqual(await deliverDictationOutput(deps, 'copy', 'hello'), { status: 'copied' });
  assert.equal(state.text, 'hello');
  assert.ok(!log.includes('cmd-v'));
});

test('paste mode restores the original clipboard after the shortcut was sent', async () => {
  const { deps, state, log } = setup();
  const result = await deliverDictationOutput(deps, 'paste', 'hello');
  assert.equal(result.status, 'pasted');
  assert.match(result.detail ?? '', /shortcut sent/, 'status wording claims the shortcut, not a confirmed insert');
  assert.equal(state.text, 'original');
  assert.deepEqual(log, ['writeText', 'cmd-v', 'settle', 'write']);
});

test('copy-and-paste keeps the result on the clipboard', async () => {
  const { deps, state } = setup();
  assert.equal((await deliverDictationOutput(deps, 'copy-and-paste', 'hello')).status, 'pasted');
  assert.equal(state.text, 'hello');
});

test('a blocked paste never touches the original clipboard before the check, and leaves the text retrievable', async () => {
  for (const reason of ['accessibility_denied', 'target_changed', 'focus_unavailable'] as const) {
    const { deps, state, log } = setup({ checkPasteAllowed: async () => ({ ok: false, reason }) });
    const result = await deliverDictationOutput(deps, 'paste', 'hello');
    assert.deepEqual(result, { status: 'fallback', detail: `fallback:${reason}` });
    assert.equal(state.text, 'hello');
    assert.ok(!log.includes('cmd-v'));
  }
});

test('the paste check runs before the clipboard is rewritten', async () => {
  const { deps, log } = setup({ checkPasteAllowed: async () => { return { ok: false, reason: 'target_changed' } as const; } });
  const order: string[] = [];
  const original = deps.clipboard.writeText;
  deps.clipboard.writeText = (text) => { order.push('write'); original(text); };
  const check = deps.checkPasteAllowed;
  deps.checkPasteAllowed = async () => { order.push('check'); return check(); };
  await deliverDictationOutput(deps, 'paste', 'hello');
  assert.deepEqual(order, ['check', 'write']);
  assert.ok(log.length >= 0);
});

test('a failed shortcut keeps the dictated text instead of restoring the original', async () => {
  const { deps, state } = setup({ sendPasteShortcut: async () => false });
  const result = await deliverDictationOutput(deps, 'paste', 'hello');
  assert.deepEqual(result, { status: 'fallback', detail: 'fallback:paste_failed' });
  assert.equal(state.text, 'hello');
});

test('text the user copies while the paste settles is not overwritten', async () => {
  const { deps, state } = setup();
  deps.sleep = async () => { state.text = 'copied meanwhile'; };
  assert.equal((await deliverDictationOutput(deps, 'paste', 'hello')).status, 'pasted');
  assert.equal(state.text, 'copied meanwhile');
});

test('a late result from an older session is copied, never pasted into the next session', async () => {
  const { deps, state, log } = setup();
  const result = await deliverDictationOutput(deps, 'paste', 'late text', { stale: true });
  assert.deepEqual(result, { status: 'fallback', detail: 'fallback:stale_session' });
  assert.equal(state.text, 'late text');
  assert.ok(!log.includes('cmd-v'));
});

test('an originally empty clipboard is cleared again after a plain paste', async () => {
  const { deps, state } = setup({}, '');
  await deliverDictationOutput(deps, 'paste', 'hello');
  assert.equal(state.text, '');
});

test('main delivers each dictation session once and routes output through the shared flow', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.match(main, /deliveredDictationFinalSessions\.has\(event\.sessionId\)/);
  assert.match(main, /const sessionIsStale = Boolean\(activeSessionId\) && event\.sessionId !== activeSessionId;/);
  assert.match(main, /deliverDictationOutput\(\{[\s\S]*?\}, outputAction, outputText, \{ stale: sessionIsStale \}\)/);
  assert.doesNotMatch(main, /tryPasteClipboard/);
});
