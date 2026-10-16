import { restoreClipboard, snapshotClipboard, type ClipboardLike } from './dictation-clipboard.js';
import type { DictationOutputAction } from './types.js';

export type PasteBlockReason = 'accessibility_denied' | 'target_changed' | 'focus_unavailable';

export interface DictationOutputDeps {
  clipboard: ClipboardLike;
  /** Accessibility permission and focus checks; run before the clipboard is touched. */
  checkPasteAllowed(): Promise<{ ok: true } | { ok: false; reason: PasteBlockReason }>;
  /** Sends Cmd+V. Resolves true when the shortcut was sent, which does not prove the text was inserted. */
  sendPasteShortcut(): Promise<boolean>;
  describeFallback(reason: PasteBlockReason | 'paste_failed' | 'stale_session'): Promise<string>;
  sleep(ms: number): Promise<void>;
  trace(message: string): void;
}

export interface DictationOutputResult {
  status: 'copied' | 'pasted' | 'fallback';
  detail?: string;
}

/** Time the target app gets to read the clipboard before the original content is put back. */
export const PASTE_SETTLE_MS = 350;

/**
 * Deliver the dictated text. The result always stays retrievable: the clipboard is only rewritten after the
 * paste checks pass, a failed paste leaves the text on the clipboard, and `paste` (as opposed to
 * `copy-and-paste`) puts the original clipboard back once the shortcut has been sent and the clipboard still
 * holds our text. `pasted` means the shortcut was sent, not that the field accepted the text.
 */
export async function deliverDictationOutput(
  deps: DictationOutputDeps,
  action: DictationOutputAction,
  text: string,
  options: { stale?: boolean } = {},
): Promise<DictationOutputResult> {
  const { clipboard } = deps;
  if (action === 'copy') {
    clipboard.writeText(text);
    return { status: 'copied' };
  }
  if (options.stale) {
    clipboard.writeText(text);
    return { status: 'fallback', detail: await deps.describeFallback('stale_session') };
  }
  const allowed = await deps.checkPasteAllowed();
  if (!allowed.ok) {
    deps.trace(`dictation paste_blocked reason=${allowed.reason}`);
    clipboard.writeText(text);
    return { status: 'fallback', detail: await deps.describeFallback(allowed.reason) };
  }
  const snapshot = action === 'paste' ? snapshotClipboard(clipboard) : null;
  clipboard.writeText(text);
  const sent = await deps.sendPasteShortcut();
  if (!sent) {
    return { status: 'fallback', detail: await deps.describeFallback('paste_failed') };
  }
  if (snapshot) {
    await deps.sleep(PASTE_SETTLE_MS);
    deps.trace(`dictation clipboard_restore result=${restoreClipboard(clipboard, snapshot, text)}`);
  }
  return { status: 'pasted', detail: 'Paste shortcut sent to foreground app.' };
}
