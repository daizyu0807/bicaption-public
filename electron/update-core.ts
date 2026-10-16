/**
 * Pure rules for the in-app updater (see docs/decisions/2026-10-16-self-update.md). Nothing here touches the disk or the
 * network, so every decision that can install code is covered by unit tests.
 */

export const RELEASE_ASSET_PREFIX = 'https://github.com/daizyu0807/bicaption-public/releases/download/';
export const RELEASE_API_URL = 'https://api.github.com/repos/daizyu0807/bicaption-public/releases/latest';

export function normalizeVersion(version: string) {
  return version.trim().replace(/^v/i, '');
}

export function compareVersions(left: string, right: string) {
  const leftParts = normalizeVersion(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

/** Loopback only: lets a local end-to-end test point the updater at a test server and nothing else. */
export function isLoopbackUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

export function resolveReleaseApiUrl(override: string | undefined) {
  return override && isLoopbackUrl(override) ? override : RELEASE_API_URL;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface UpdateAssets {
  zip: ReleaseAsset;
  sums: ReleaseAsset;
}

/** An asset may only come from this project's public release downloads (or loopback while testing). */
export function isTrustedAssetUrl(url: string, allowLoopback: boolean) {
  return url.startsWith(RELEASE_ASSET_PREFIX) || (allowLoopback && isLoopbackUrl(url));
}

export function pickUpdateAssets(assets: ReleaseAsset[], version: string, allowLoopback = false): UpdateAssets | null {
  const zipName = `BiCaption-${normalizeVersion(version)}-arm64-mac.zip`;
  const zip = assets.find((asset) => asset.name === zipName);
  const sums = assets.find((asset) => asset.name === 'SHA256SUMS.txt');
  if (!zip || !sums) return null;
  if (!isTrustedAssetUrl(zip.browser_download_url, allowLoopback) || !isTrustedAssetUrl(sums.browser_download_url, allowLoopback)) return null;
  return { zip, sums };
}

export function parseSha256Sums(text: string) {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

/** The pinned certificate of a signed app, from `codesign -dr -` output; null for ad-hoc / identifier-only signatures. */
export function parseLeafHash(designatedRequirement: string) {
  const match = designatedRequirement.match(/certificate leaf\s*=\s*H"([0-9a-fA-F]{40})"/);
  return match ? match[1].toLowerCase() : null;
}

export type InstallDecision = { mode: 'auto' } | { mode: 'manual'; reason: string };

export interface InstallFacts {
  packaged: boolean;
  currentLeaf: string | null;
  assets: UpdateAssets | null;
  installDirWritable: boolean;
  sessionActive: boolean;
}

/** Whether the update can be installed from inside the app, and if not, why the download page is offered instead. */
export function decideInstall(facts: InstallFacts): InstallDecision {
  if (!facts.packaged) return { mode: 'manual', reason: '開發模式不支援 app 內更新。' };
  if (!facts.currentLeaf) return { mode: 'manual', reason: '目前安裝的版本沒有憑證簽章，無法確認新版來自同一個發行者，請手動下載安裝一次；之後的版本就能在 app 內更新。' };
  if (!facts.assets) return { mode: 'manual', reason: '這個 Release 沒有可驗證的安裝檔與校驗檔。' };
  if (!facts.installDirWritable) return { mode: 'manual', reason: '沒有權限寫入安裝位置。' };
  if (facts.sessionActive) return { mode: 'manual', reason: '正在進行字幕、會議或語音輸入，請先結束再更新。' };
  return { mode: 'auto' };
}

export interface StagedAppFacts {
  zipSha256: string;
  expectedSha256: string | undefined;
  signatureOk: boolean;
  stagedLeaf: string | null;
  currentLeaf: string | null;
  stagedBundleId: string;
  currentBundleId: string;
  stagedVersion: string;
  expectedVersion: string;
  currentVersion: string;
}

/** Every check a downloaded update must pass before anything is replaced; returns the first failure, or null. */
export function verifyUpdate(facts: StagedAppFacts): string | null {
  if (!facts.expectedSha256) return '校驗檔沒有這個安裝檔的 SHA-256。';
  if (facts.zipSha256 !== facts.expectedSha256) return '安裝檔的 SHA-256 與校驗檔不符。';
  if (!facts.signatureOk) return '新版的程式碼簽章無法通過驗證。';
  if (!facts.currentLeaf || !facts.stagedLeaf || facts.stagedLeaf !== facts.currentLeaf) return '新版的簽章憑證與目前安裝的版本不同。';
  if (facts.stagedBundleId !== facts.currentBundleId) return '新版的 bundle ID 與目前的不同。';
  if (normalizeVersion(facts.stagedVersion) !== normalizeVersion(facts.expectedVersion)) return '新版內的版本號與 Release 不符。';
  if (compareVersions(facts.stagedVersion, facts.currentVersion) <= 0) return '新版的版本號不高於目前的版本。';
  return null;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface ReplaceScriptOptions {
  pid: number;
  target: string;
  staged: string;
  backup: string;
  log: string;
  /** Command that must succeed on the installed copy; defaults to a strict codesign check. */
  verifyCommand?: string;
  /** Seconds the new app must stay running before the backup is removed. */
  healthSeconds?: number;
  /** Command that opens an app bundle; `open` unless a test overrides it. */
  openCommand?: string;
  /** How many half-seconds to wait for the running app to quit before giving up. */
  waitHalfSeconds?: number;
}

/** The detached script that swaps the app once it has quit and rolls back if the new copy does not come up. */
export function buildReplaceScript(options: ReplaceScriptOptions) {
  const verify = options.verifyCommand ?? '/usr/bin/codesign --verify --deep --strict';
  const open = options.openCommand ?? '/usr/bin/open';
  const health = options.healthSeconds ?? 10;
  const wait = Math.trunc(options.waitHalfSeconds ?? 120);
  return `#!/bin/bash
set -u
PID=${Math.trunc(options.pid)}
TARGET=${shellQuote(options.target)}
STAGED=${shellQuote(options.staged)}
BACKUP=${shellQuote(options.backup)}
LOG=${shellQuote(options.log)}
log() { printf '%s %s\\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG"; }
restore() {
  log "restoring the previous version"
  rm -rf "$TARGET"
  [ -d "$BACKUP" ] && mv "$BACKUP" "$TARGET"
  ${open} "$TARGET"
}
log "waiting for pid $PID to quit"
for _ in $(seq 1 ${wait}); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  log "the app did not quit; leaving the installed version untouched"
  exit 1
fi
rm -rf "$BACKUP"
if ! mv "$TARGET" "$BACKUP"; then
  log "could not move the installed app aside"
  ${open} "$TARGET"
  exit 1
fi
if ! ditto "$STAGED" "$TARGET"; then
  log "copying the new version failed"
  restore
  exit 1
fi
if ! ${verify} "$TARGET" >> "$LOG" 2>&1; then
  log "the installed copy failed verification"
  restore
  exit 1
fi
log "starting the new version"
${open} "$TARGET"
sleep ${health}
if pgrep -f "$TARGET/Contents/MacOS/" > /dev/null; then
  log "the new version is running; removing the backup"
  rm -rf "$BACKUP" "$STAGED"
  exit 0
fi
log "the new version is not running"
restore
exit 1
`;
}
