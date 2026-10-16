import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  buildReplaceScript, parseLeafHash, parseSha256Sums, verifyUpdate, type UpdateAssets,
} from './update-core.js';

function run(command: string, args: string[]) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, output: `${stdout}${stderr}` });
    });
  });
}

/** `/Applications/BiCaption.app` from `/Applications/BiCaption.app/Contents/MacOS/BiCaption`. */
export function appBundleFromExecPath(execPath: string) {
  const index = execPath.indexOf('.app/');
  return index === -1 ? null : execPath.slice(0, index + 4);
}

export async function readLeafHash(appPath: string) {
  const { output } = await run('/usr/bin/codesign', ['-dr', '-', appPath]);
  return parseLeafHash(output);
}

async function readPlistValue(appPath: string, key: string) {
  const { code, output } = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')]);
  return code === 0 ? output.trim() : '';
}

export function canWriteInstallDir(appPath: string) {
  try {
    accessSync(dirname(appPath), constants.W_OK);
    accessSync(appPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function download(url: string, destination: string, onProgress?: (fraction: number) => void) {
  const response = await fetch(url, { headers: { 'User-Agent': 'BiCaption' }, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`下載失敗（HTTP ${response.status}）`);
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const source = Readable.fromWeb(response.body as never);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) onProgress?.(Math.min(1, received / total));
  });
  await pipeline(source, createWriteStream(destination));
  return received;
}

export interface PreparedUpdate {
  stagedApp: string;
  version: string;
  directory: string;
}

export interface PrepareOptions {
  assets: UpdateAssets;
  version: string;
  currentApp: string;
  currentVersion: string;
  currentLeaf: string | null;
  workRoot: string;
  onProgress?: (fraction: number) => void;
}

/** Download, check and unpack an update. Throws a readable reason (and removes the download) when any check fails. */
export async function prepareUpdate(options: PrepareOptions): Promise<PreparedUpdate> {
  const directory = join(options.workRoot, options.version.replace(/[^0-9A-Za-z.]/g, ''));
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const sumsPath = join(directory, 'SHA256SUMS.txt');
    await download(options.assets.sums.browser_download_url, sumsPath);
    const sums = parseSha256Sums(await readFile(sumsPath, 'utf8'));
    const zipPath = join(directory, options.assets.zip.name);
    await download(options.assets.zip.browser_download_url, zipPath, options.onProgress);
    const zipSha256 = await sha256File(zipPath);

    const extractDir = join(directory, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    const unzip = await run('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
    if (unzip.code !== 0) throw new Error('安裝檔無法解壓縮。');
    const apps = readdirSync(extractDir).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error('安裝檔內容不是單一的 App。');
    const stagedApp = join(extractDir, apps[0]);

    const signature = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
    const failure = verifyUpdate({
      zipSha256,
      expectedSha256: sums.get(options.assets.zip.name),
      signatureOk: signature.code === 0,
      stagedLeaf: await readLeafHash(stagedApp),
      currentLeaf: options.currentLeaf,
      stagedBundleId: await readPlistValue(stagedApp, 'CFBundleIdentifier'),
      currentBundleId: await readPlistValue(options.currentApp, 'CFBundleIdentifier'),
      stagedVersion: await readPlistValue(stagedApp, 'CFBundleShortVersionString'),
      expectedVersion: options.version,
      currentVersion: options.currentVersion,
    });
    if (failure) throw new Error(failure);
    rmSync(zipPath, { force: true });
    return { stagedApp, version: options.version, directory };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Hand over to a detached script that replaces the app after this process has quit. The caller then quits the app. */
export function startReplacement(prepared: PreparedUpdate, currentApp: string, pid: number) {
  const scriptPath = join(prepared.directory, 'replace.sh');
  writeFileSync(scriptPath, buildReplaceScript({
    pid,
    target: currentApp,
    staged: prepared.stagedApp,
    backup: `${currentApp}.previous`,
    log: join(prepared.directory, 'update.log'),
  }), { mode: 0o700 });
  if (!existsSync(scriptPath)) throw new Error('無法建立更新腳本。');
  spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
}
