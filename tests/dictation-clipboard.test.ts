import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreClipboard, snapshotClipboard, type ClipboardLike } from '../electron/dictation-clipboard.js';

type FakeImage = { isEmpty(): boolean; id: string };

function fakeClipboard(initial: { text?: string; html?: string; rtf?: string; image?: FakeImage; formats?: string[] } = {}) {
  const state = { text: initial.text ?? '', html: initial.html ?? '', rtf: initial.rtf ?? '', image: initial.image ?? null as FakeImage | null,
    formats: initial.formats ?? [] };
  const writes: unknown[] = [];
  const clipboard: ClipboardLike<FakeImage> = {
    availableFormats: () => state.formats,
    readText: () => state.text,
    readHTML: () => state.html,
    readRTF: () => state.rtf,
    readImage: () => state.image ?? { isEmpty: () => true, id: 'empty' },
    write: (data) => { writes.push(data); state.text = data.text ?? ''; state.html = data.html ?? ''; state.rtf = data.rtf ?? ''; state.image = data.image ?? null; state.formats = ['restored']; },
    writeText: (text) => { state.text = text; state.html = ''; state.rtf = ''; state.image = null; state.formats = ['text/plain']; },
    clear: () => { writes.push('clear'); Object.assign(state, { text: '', html: '', rtf: '', image: null, formats: [] }); },
  };
  return { clipboard, state, writes };
}

test('text, html and rtf on the clipboard come back after the paste', () => {
  const { clipboard, state } = fakeClipboard({ text: 'old', html: '<b>old</b>', rtf: '{\\rtf old}', formats: ['text/plain', 'text/html', 'text/rtf'] });
  const snapshot = snapshotClipboard(clipboard);
  clipboard.writeText('dictated');
  assert.equal(restoreClipboard(clipboard, snapshot, 'dictated'), 'restored');
  assert.deepEqual([state.text, state.html, state.rtf], ['old', '<b>old</b>', '{\\rtf old}']);
});

test('an image on the clipboard is restored', () => {
  const image: FakeImage = { isEmpty: () => false, id: 'png-1' };
  const { clipboard, state } = fakeClipboard({ image, formats: ['image/png'] });
  const snapshot = snapshotClipboard(clipboard);
  clipboard.writeText('dictated');
  assert.equal(restoreClipboard(clipboard, snapshot, 'dictated'), 'restored');
  assert.equal(state.image?.id, 'png-1');
});

test('an originally empty clipboard is cleared again', () => {
  const { clipboard, state } = fakeClipboard();
  const snapshot = snapshotClipboard(clipboard);
  clipboard.writeText('dictated');
  assert.equal(restoreClipboard(clipboard, snapshot, 'dictated'), 'cleared');
  assert.equal(state.text, '');
});

test('a copy made during the paste is never overwritten', () => {
  const { clipboard, state } = fakeClipboard({ text: 'old', formats: ['text/plain'] });
  const snapshot = snapshotClipboard(clipboard);
  clipboard.writeText('dictated');
  clipboard.writeText('user copied this meanwhile');
  assert.equal(restoreClipboard(clipboard, snapshot, 'dictated'), 'kept-new-copy');
  assert.equal(state.text, 'user copied this meanwhile');
});

test('files and custom formats cannot be rewritten, so the original is not touched', () => {
  const { clipboard, state } = fakeClipboard({ text: 'a.txt', formats: ['text/plain', 'text/uri-list'] });
  const snapshot = snapshotClipboard(clipboard);
  assert.equal(snapshot.restorable, false);
  clipboard.writeText('dictated');
  assert.equal(restoreClipboard(clipboard, snapshot, 'dictated'), 'not-restorable');
  assert.equal(state.text, 'dictated', 'the dictated text stays retrievable');
});

test('browser-internal markers next to plain content do not block the restore', () => {
  const { clipboard } = fakeClipboard({ text: 'old', formats: ['text/plain', 'chromium/x-source-url', 'org.chromium.web-custom-data'] });
  assert.equal(snapshotClipboard(clipboard).restorable, true);
});
