import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { getCompatibleNodePath } from './compatible-node.mjs';

const children = [];
const electronDistFiles = [
  join(process.cwd(), 'dist/electron/main.js'),
];
const projectRoot = process.cwd();
const pythonDir = join(projectRoot, 'python');
const venvPython = join(projectRoot, '.venv', 'bin', 'python');

function failPreflight(message, steps = []) {
  console.error(`\n[dev preflight] ${message}`);
  for (const step of steps) {
    console.error(`- ${step}`);
  }
  process.exit(1);
}

function localBin(name) {
  return join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
}

function assertNodeDependenciesInstalled() {
  const requiredBins = ['tsc', 'vite', 'electron'];
  const missingBins = requiredBins.filter((name) => !existsSync(localBin(name)));
  if (missingBins.length > 0) {
    failPreflight('Node dependencies are missing.', [
      'Run: npm install',
      `Missing tools: ${missingBins.join(', ')}`,
    ]);
  }
}

function assertPythonReady() {
  if (!existsSync(venvPython)) {
    failPreflight('Python virtual environment is missing.', [
      'Run: python3 -m venv .venv',
      'Run: source .venv/bin/activate',
      'Run: pip install -r python/requirements.txt',
    ]);
  }

  try {
    execFileSync(venvPython, ['-c', 'import numpy, sounddevice, deep_translator, opencc, sherpa_onnx'], {
      stdio: 'ignore',
      cwd: projectRoot,
    });
  } catch {
    failPreflight('Python dependencies are incomplete.', [
      'Run: source .venv/bin/activate',
      'Run: pip install -r python/requirements.txt',
    ]);
  }
}

function warnIfModelsMissing() {
  const missing = [];
  if (!existsSync(join(
    pythonDir,
    'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    'model.int8.onnx',
  ))) {
    missing.push('SenseVoice model');
  }
  if (!existsSync(join(pythonDir, 'silero_vad.onnx'))) {
    missing.push('Silero VAD model');
  }
  if (missing.length > 0) {
    console.warn('\n[dev preflight] Speech models are missing.');
    console.warn('- The app can still start so you can download models from Settings.');
    console.warn('- Or run: bash scripts/download-models.sh');
    console.warn(`- Missing assets: ${missing.join(', ')}`);
  }
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) {
      process.exitCode = code;
    }
  });
  return child;
}

async function waitForElectronDist() {
  while (true) {
    try {
      await Promise.all(electronDistFiles.map((file) => access(file, constants.F_OK)));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function stopChildren() {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

process.on('SIGINT', stopChildren);
process.on('SIGTERM', stopChildren);
process.on('exit', stopChildren);

async function main() {
  assertNodeDependenciesInstalled();
  assertPythonReady();
  warnIfModelsMissing();

  const compatibleNodePath = getCompatibleNodePath();

  start(localBin('tsc'), ['-p', 'tsconfig.electron.json']);
  const tsc = start(localBin('tsc'), ['-p', 'tsconfig.electron.json', '--watch', '--preserveWatchOutput']);
  const vite = start(compatibleNodePath, [join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')]);

  await once(vite, 'spawn');
  await waitForElectronDist();

  const electron = start(localBin('electron'), ['.'], {
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:5174',
    },
  });

  await Promise.race([
    once(electron, 'exit'),
    once(tsc, 'exit'),
    once(vite, 'exit'),
  ]);
  stopChildren();
}

main().catch((error) => {
  console.error(error);
  stopChildren();
  process.exit(1);
});
