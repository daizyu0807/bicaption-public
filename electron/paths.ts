/**
 * Centralized path resolution for dev vs production (packaged) builds.
 *
 * Dev mode:
 *   - sidecar: /usr/bin/arch -arm64 .venv/bin/python python/sidecar.py
 *   - models: python/  (alongside sidecar.py)
 *
 * Production (app.isPackaged):
 *   - sidecar: resources/sidecar/bicaption-sidecar  (PyInstaller binary)
 *   - models: ~/Library/Application Support/bicaption/models/
 */
import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');

export interface SidecarSpawnConfig {
  command: string;
  args: string[];
}

function getDevGlobalHotkeyHelperPath() {
  const helperAppBinary = join(projectRoot, 'GlobalHotkeyHelper.app', 'Contents', 'MacOS', 'global-hotkey');
  if (existsSync(helperAppBinary)) {
    return helperAppBinary;
  }
  return join(projectRoot, 'python', 'global-hotkey');
}

function getDevAppleSttHelperPath() {
  const helperAppBinary = join(projectRoot, 'AppleSTTHelper.app', 'Contents', 'MacOS', 'apple-stt');
  if (existsSync(helperAppBinary)) {
    return helperAppBinary;
  }
  return join(projectRoot, 'python', 'apple-stt');
}

export function getGlobalHotkeyCommand(): SidecarSpawnConfig {
  if (isPackaged()) {
    const helperAppBinary = join(process.resourcesPath!, 'GlobalHotkeyHelper.app', 'Contents', 'MacOS', 'global-hotkey');
    const helperBin = existsSync(helperAppBinary)
      ? helperAppBinary
      : join(process.resourcesPath!, 'sidecar', 'global-hotkey');
    return {
      command: helperBin,
      args: [],
    };
  }

  return {
    command: getDevGlobalHotkeyHelperPath(),
    args: [],
  };
}

export function getAppleSttCommand(): SidecarSpawnConfig {
  if (isPackaged()) {
    const helperBin = join(process.resourcesPath!, 'AppleSTTHelper.app', 'Contents', 'MacOS', 'apple-stt');
    return {
      command: helperBin,
      args: [],
    };
  }

  return {
    command: getDevAppleSttHelperPath(),
    args: [],
  };
}

export function getAppleSttHelperAppPath(): string {
  if (isPackaged()) {
    return join(process.resourcesPath!, 'AppleSTTHelper.app');
  }
  return join(projectRoot, 'AppleSTTHelper.app');
}

export function getGlobalHotkeyHelperAppPath(): string {
  if (isPackaged()) {
    return join(process.resourcesPath!, 'GlobalHotkeyHelper.app');
  }
  return join(projectRoot, 'GlobalHotkeyHelper.app');
}

export function isPackaged(): boolean {
  return app.isPackaged;
}

/**
 * Returns the command + args to spawn the sidecar process.
 */
export function getSidecarCommand(): SidecarSpawnConfig {
  if (isPackaged()) {
    const sidecarBin = join(process.resourcesPath!, 'sidecar', 'bicaption-sidecar');
    return {
      command: sidecarBin,
      args: ['--model-dir', getModelDir()],
    };
  }

  // Dev mode: use venv python
  const venvPython = join(projectRoot, '.venv', 'bin', 'python');
  const pythonBin = existsSync(venvPython) ? venvPython : 'python3';
  const sidecarScript = join(projectRoot, 'python', 'sidecar.py');
  return {
    command: '/usr/bin/arch',
    args: ['-arm64', pythonBin, sidecarScript],
  };
}

/**
 * Returns the directory where STT models are stored.
 * In production this is inside userData; in dev it's the python/ directory.
 */
/**
 * Returns a valid cwd for spawning the sidecar process.
 * In production the asar path is not a real directory, so use userData instead.
 */
export function getSpawnCwd(): string {
  if (isPackaged()) {
    return app.getPath('userData');
  }
  return projectRoot;
}

export function getManagedHuggingFaceHome(): string {
  const baseDir = isPackaged()
    ? app.getPath('userData')
    : join(projectRoot, '.cache');
  const hfHome = join(baseDir, 'huggingface');
  if (!existsSync(hfHome)) {
    mkdirSync(hfHome, { recursive: true });
  }
  return hfHome;
}

export function getModelDir(): string {
  if (isPackaged()) {
    const modelDir = join(app.getPath('userData'), 'models');
    if (!existsSync(modelDir)) {
      mkdirSync(modelDir, { recursive: true });
    }
    return modelDir;
  }
  return join(projectRoot, 'python');
}

export function getDebugTracePath(): string {
  return join(getSpawnCwd(), '.debug', 'dictation-trace.log');
}

export function getDictationLearningHistoryPath(): string {
  const baseDir = isPackaged()
    ? app.getPath('userData')
    : join(projectRoot, '.debug');
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }
  return join(baseDir, 'dictation-learning-history.json');
}
