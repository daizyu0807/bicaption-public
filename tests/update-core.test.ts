import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildReplaceScript, compareVersions, decideInstall, isLoopbackUrl, parseLeafHash, parseSha256Sums, pickUpdateAssets,
  resolveReleaseApiUrl, RELEASE_API_URL, RELEASE_ASSET_PREFIX, verifyUpdate, type StagedAppFacts,
} from '../electron/update-core.js';

const LEAF = 'c6fa8864aef7274733223858c24c10670b0e20cc';

test('versions compare numerically and tolerate a leading v', () => {
  assert.equal(compareVersions('v0.1.13', '0.1.12'), 1);
  assert.equal(compareVersions('0.1.12', '0.1.12'), 0);
  assert.equal(compareVersions('0.1.9', '0.1.12'), -1);
  assert.equal(compareVersions('0.2', '0.1.12'), 1);
});

test('only loopback addresses can override the release API', () => {
  assert.equal(resolveReleaseApiUrl('http://127.0.0.1:8765/latest.json'), 'http://127.0.0.1:8765/latest.json');
  assert.equal(resolveReleaseApiUrl('http://localhost:1/x'), 'http://localhost:1/x');
  for (const bad of ['https://evil.example/latest.json', 'http://evil.example/x', 'http://127.0.0.1.evil.example/x', 'file:///etc/passwd', '']) {
    assert.equal(resolveReleaseApiUrl(bad), RELEASE_API_URL, bad);
  }
  assert.equal(isLoopbackUrl('http://127.0.0.1:80/a'), true);
});

test('update assets must come from the project release downloads with a checksum file', () => {
  const zip = { name: 'BiCaption-0.1.13-arm64-mac.zip', browser_download_url: `${RELEASE_ASSET_PREFIX}v0.1.13/BiCaption-0.1.13-arm64-mac.zip` };
  const sums = { name: 'SHA256SUMS.txt', browser_download_url: `${RELEASE_ASSET_PREFIX}v0.1.13/SHA256SUMS.txt` };
  assert.deepEqual(pickUpdateAssets([zip, sums], 'v0.1.13'), { zip, sums });
  assert.equal(pickUpdateAssets([zip], '0.1.13'), null, 'no checksum file');
  assert.equal(pickUpdateAssets([sums], '0.1.13'), null, 'no zip');
  assert.equal(pickUpdateAssets([{ ...zip, name: 'BiCaption-0.1.14-arm64-mac.zip' }, sums], '0.1.13'), null, 'wrong version');
  const foreign = { ...zip, browser_download_url: 'https://example.com/BiCaption-0.1.13-arm64-mac.zip' };
  assert.equal(pickUpdateAssets([foreign, sums], '0.1.13'), null, 'foreign host');
  const loopback = { ...zip, browser_download_url: 'http://127.0.0.1:8765/BiCaption-0.1.13-arm64-mac.zip' };
  assert.equal(pickUpdateAssets([loopback, sums], '0.1.13', false), null);
  assert.ok(pickUpdateAssets([loopback, { ...sums, browser_download_url: 'http://127.0.0.1:8765/SHA256SUMS.txt' }], '0.1.13', true));
});

test('checksum files and signature requirements are parsed strictly', () => {
  const sums = parseSha256Sums(`${'A'.repeat(64)}  BiCaption-0.1.13-arm64.dmg\n${'b'.repeat(64)}  BiCaption-0.1.13-arm64-mac.zip\nnot a checksum line\n`);
  assert.equal(sums.get('BiCaption-0.1.13-arm64-mac.zip'), 'b'.repeat(64));
  assert.equal(sums.get('BiCaption-0.1.13-arm64.dmg'), 'a'.repeat(64), 'hashes compare in lower case');
  assert.equal(sums.size, 2);
  assert.equal(parseLeafHash(`designated => identifier "com.davedai.bicaption" and certificate leaf = H"${LEAF.toUpperCase()}"`), LEAF);
  assert.equal(parseLeafHash('designated => identifier "com.davedai.bicaption"'), null, 'identifier-only signatures carry no certificate');
  assert.equal(parseLeafHash('designated => cdhash H"abcd"'), null);
});

test('the update is installed in the app only when every precondition holds', () => {
  const assets = { zip: { name: 'z', browser_download_url: 'u' }, sums: { name: 's', browser_download_url: 'u' } };
  const ok = { packaged: true, currentLeaf: LEAF, assets, installDirWritable: true, sessionActive: false };
  assert.deepEqual(decideInstall(ok), { mode: 'auto' });
  for (const [change, expected] of [
    [{ packaged: false }, /開發模式/],
    [{ currentLeaf: null }, /沒有憑證簽章/],
    [{ assets: null }, /校驗檔/],
    [{ installDirWritable: false }, /權限/],
    [{ sessionActive: true }, /正在進行/],
  ] as const) {
    const decision = decideInstall({ ...ok, ...change });
    assert.equal(decision.mode, 'manual');
    assert.match((decision as { reason: string }).reason, expected);
  }
});

const goodFacts: StagedAppFacts = {
  zipSha256: 'a'.repeat(64), expectedSha256: 'a'.repeat(64), signatureOk: true, stagedLeaf: LEAF, currentLeaf: LEAF,
  stagedBundleId: 'com.davedai.bicaption', currentBundleId: 'com.davedai.bicaption',
  stagedVersion: '0.1.13', expectedVersion: 'v0.1.13', currentVersion: '0.1.12',
};

test('a downloaded update must pass every check before it can replace the app', () => {
  assert.equal(verifyUpdate(goodFacts), null);
  const cases: Array<[Partial<StagedAppFacts>, RegExp]> = [
    [{ expectedSha256: undefined }, /沒有這個安裝檔/],
    [{ zipSha256: 'b'.repeat(64) }, /SHA-256/],
    [{ signatureOk: false }, /簽章無法/],
    [{ stagedLeaf: 'd'.repeat(40) }, /憑證與目前/],
    [{ stagedLeaf: null }, /憑證與目前/],
    [{ currentLeaf: null, stagedLeaf: null }, /憑證與目前/],
    [{ stagedBundleId: 'com.evil.app' }, /bundle ID/],
    [{ stagedVersion: '0.1.99' }, /與 Release 不符/],
    [{ stagedVersion: '0.1.12', expectedVersion: '0.1.12' }, /不高於/],
    [{ stagedVersion: '0.1.11', expectedVersion: '0.1.11' }, /不高於/],
  ];
  for (const [change, expected] of cases) assert.match(verifyUpdate({ ...goodFacts, ...change }) ?? '', expected, JSON.stringify(change));
});

// The replacement script is exercised for real with stand-in "apps" (plain folders) in a temporary directory.
function scenario(options: { verify: string; opens: boolean; pidAlive?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'bicaption-update-'));
  const target = join(root, 'BiCaption.app');
  const staged = join(root, 'staging', 'BiCaption.app');
  const backup = join(root, 'BiCaption.app.previous');
  const log = join(root, 'update.log');
  const fakeBinary = (dir: string, marker: string) => {
    mkdirSync(join(dir, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(dir, 'Contents', 'marker'), marker);
    const exe = join(dir, 'Contents', 'MacOS', 'fake');
    writeFileSync(exe, '#!/bin/bash\nsleep 20\n');
    chmodSync(exe, 0o755);
  };
  fakeBinary(target, 'old');
  fakeBinary(staged, 'new');
  const opener = join(root, 'open.sh');
  writeFileSync(opener, options.opens
    ? '#!/bin/bash\nnohup "$1/Contents/MacOS/fake" > /dev/null 2>&1 &\n'
    : '#!/bin/bash\nexit 0\n');
  chmodSync(opener, 0o755);
  const sleeper = options.pidAlive ? spawn('sleep', ['30'], { stdio: 'ignore' }) : null;
  const pid = sleeper?.pid ?? Number(execFileSync('bash', ['-c', 'true & echo $!; wait']).toString().trim());
  const scriptPath = join(root, 'replace.sh');
  writeFileSync(scriptPath, buildReplaceScript({
    pid, target, staged, backup, log, verifyCommand: options.verify, openCommand: opener, healthSeconds: 1, waitHalfSeconds: 2,
  }));
  const status = (() => { try { execFileSync('bash', [scriptPath], { stdio: 'ignore' }); return 0; } catch (error) { return (error as { status?: number }).status ?? 1; } })();
  sleeper?.kill();
  const result = {
    status,
    marker: readFileSync(join(target, 'Contents', 'marker'), 'utf8'),
    backupExists: existsSync(backup),
    stagedExists: existsSync(staged),
    log: existsSync(log) ? readFileSync(log, 'utf8') : '',
  };
  try { execFileSync('pkill', ['-f', root]); } catch { /* nothing left running */ }
  rmSync(root, { recursive: true, force: true });
  return result;
}

test('replacement script: swaps the app, keeps it once the new version runs, and cleans up', () => {
  const result = scenario({ verify: 'true', opens: true });
  assert.equal(result.status, 0, result.log);
  assert.equal(result.marker, 'new');
  assert.equal(result.backupExists, false);
  assert.equal(result.stagedExists, false);
  assert.match(result.log, /new version is running/);
});

test('replacement script: restores the old app when the new copy fails verification', () => {
  const result = scenario({ verify: 'false', opens: true });
  assert.equal(result.status, 1);
  assert.equal(result.marker, 'old');
  assert.match(result.log, /failed verification/);
});

test('replacement script: restores the old app when the new version does not start', () => {
  const result = scenario({ verify: 'true', opens: false });
  assert.equal(result.status, 1);
  assert.equal(result.marker, 'old');
  assert.match(result.log, /not running/);
});

test('replacement script: never touches the installed app while it is still running', () => {
  const result = scenario({ verify: 'true', opens: true, pidAlive: true });
  assert.equal(result.status, 1);
  assert.equal(result.marker, 'old');
  assert.equal(result.backupExists, false);
  assert.match(result.log, /did not quit/);
});
