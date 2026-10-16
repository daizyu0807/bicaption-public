/**
 * Clipboard save / restore around an automatic paste.
 *
 * Electron exposes no clipboard change counter and writes one clipboard item at a time, so this module only
 * promises what it can check: text, HTML, RTF and image content is saved and restored in one write, and the
 * restore is skipped when the clipboard no longer holds the text we put there (the user copied something
 * meanwhile) or when the original held formats we cannot rewrite (files, custom types).
 */

export interface ClipboardImageLike {
  isEmpty(): boolean;
}

export interface ClipboardLike<Image extends ClipboardImageLike = ClipboardImageLike> {
  availableFormats(): string[];
  readText(): string;
  readHTML(): string;
  readRTF(): string;
  readImage(): Image;
  write(data: { text?: string; html?: string; rtf?: string; image?: Image }): void;
  writeText(text: string): void;
  clear(): void;
}

export interface ClipboardSnapshot<Image extends ClipboardImageLike = ClipboardImageLike> {
  text: string;
  html: string;
  rtf: string;
  image: Image | null;
  empty: boolean;
  /** False when the clipboard held formats this module cannot write back. */
  restorable: boolean;
}

const KNOWN_FORMATS = new Set(['text/plain', 'text/html', 'text/rtf', 'image/png', 'image/tiff', 'image/jpeg']);
// Internal markers that apps add next to normal content; losing them does not change what the user copied.
const IGNORABLE_FORMAT = /chromium|x-source-url|^dyn\.|^com\.apple\.(?:ink|pasteboard\.promised)|org\.nspasteboard/i;

export function snapshotClipboard<Image extends ClipboardImageLike>(clipboard: ClipboardLike<Image>): ClipboardSnapshot<Image> {
  const formats = clipboard.availableFormats();
  const image = formats.some((format) => format.startsWith('image/')) ? clipboard.readImage() : null;
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: image && !image.isEmpty() ? image : null,
    empty: formats.length === 0,
    restorable: formats.every((format) => KNOWN_FORMATS.has(format) || IGNORABLE_FORMAT.test(format)),
  };
}

export type ClipboardRestoreResult = 'restored' | 'cleared' | 'kept-new-copy' | 'not-restorable';

/**
 * Put the original clipboard back after a paste, but only when it still holds exactly `ourText` (nothing copied
 * since). An originally empty clipboard is cleared again.
 */
export function restoreClipboard<Image extends ClipboardImageLike>(
  clipboard: ClipboardLike<Image>,
  snapshot: ClipboardSnapshot<Image>,
  ourText: string,
): ClipboardRestoreResult {
  if (!snapshot.restorable) return 'not-restorable';
  if (clipboard.readText() !== ourText) return 'kept-new-copy';
  if (snapshot.empty) {
    clipboard.clear();
    return 'cleared';
  }
  clipboard.write({
    ...(snapshot.text ? { text: snapshot.text } : {}),
    ...(snapshot.html ? { html: snapshot.html } : {}),
    ...(snapshot.rtf ? { rtf: snapshot.rtf } : {}),
    ...(snapshot.image ? { image: snapshot.image } : {}),
  });
  return 'restored';
}
