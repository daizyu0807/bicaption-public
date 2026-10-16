import { app } from 'electron';
import { createWriteStream, existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile, execFileSync, spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { getSidecarCommand, getSpawnCwd } from './paths.js';

const SENSEVOICE_MODEL_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const SENSEVOICE_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2';
const VAD_MODEL_FILE = 'silero_vad.onnx';
const VAD_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const BREEZE_ASR_MODEL_ID = 'Kenji8000/Breeze-ASR-25-mlx';
const BREEZE_ASR_MODEL_REVISION = '56b8508317e7766d904d1f0b8cc612687dfa39a4';
const BREEZE_ASR_RUNTIME_MARKER = 'breeze-asr-runtime.enabled';
const TRANSCRIBE_RUNTIME_MARKER = 'transcribe-runtime.enabled';
const QWEN3_ASR_MODEL_FILE = 'Qwen3-ASR-0.6B-Q4_K_M.gguf';
const BREEZE_GGUF_MODEL_FILE = 'Breeze-ASR-25-Q4_K_M.gguf';
const BREEZE_GGUF_MODEL_URL = 'https://huggingface.co/handy-computer/Breeze-ASR-25-gguf/resolve/main/Breeze-ASR-25-Q4_K_M.gguf';
const QWEN3_ASR_MODEL_URL = 'https://huggingface.co/handy-computer/Qwen3-ASR-0.6B-gguf/resolve/main/Qwen3-ASR-0.6B-Q4_K_M.gguf';
export interface ModelStatus {
  sensevoice: boolean;
  breezeAsr: boolean;
  breezeAsrRuntime: boolean;
  qwen3Asr: boolean;
  qwen3AsrRuntime: boolean;
  breezeGguf: boolean;
  breezeGgufRuntime: boolean;
  vad: boolean;
  ffmpeg: boolean;
  ready: boolean;
}

export interface ModelDownloadProgress {
  stage: 'sensevoice' | 'breeze-asr-25' | 'qwen3-asr' | 'breeze-gguf' | 'vad' | 'extracting';
  percent: number;
  downloadedMB: number;
  totalMB: number;
}

export class ModelDownloader extends EventEmitter {
  private pythonDir: string;
  private huggingFaceHome: string;
  private aborted = false;

  /**
   * @param modelDir - Directory where models are stored.
   *   In dev: projectRoot/python. In production: userData/models.
   */
  constructor(modelDir: string, huggingFaceHome: string) {
    super();
    this.pythonDir = modelDir;
    this.huggingFaceHome = huggingFaceHome;
    this.migrateLegacyHuggingFaceCache();
  }

  checkStatus(): ModelStatus {
    const sensevoice = existsSync(join(this.pythonDir, SENSEVOICE_MODEL_DIR, 'model.int8.onnx'));
    const breezeAsrRuntime = this.checkBreezeAsrRuntimeReady();
    const breezeAsr = breezeAsrRuntime && this.checkBreezeAsrModelReady();
    // Packaged builds carry the transcribe.cpp runtime next to the sidecar and mark it; development builds use the venv.
    const qwen3AsrRuntime = this.checkTranscribeRuntimeReady();
    const qwen3Asr = qwen3AsrRuntime && existsSync(join(this.pythonDir, QWEN3_ASR_MODEL_FILE));
    const breezeGgufRuntime = qwen3AsrRuntime;
    const breezeGguf = breezeGgufRuntime && existsSync(join(this.pythonDir, BREEZE_GGUF_MODEL_FILE));
    const vad = existsSync(join(this.pythonDir, VAD_MODEL_FILE));
    let ffmpeg = false;
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      ffmpeg = true;
    } catch {
      ffmpeg = false;
    }
    return {
      sensevoice,
      breezeAsr,
      breezeAsrRuntime,
      qwen3AsrRuntime,
      qwen3Asr,
      breezeGgufRuntime,
      breezeGguf,
      vad,
      ffmpeg,
      ready: sensevoice && vad,
    };
  }

  abort() {
    this.aborted = true;
  }

  private static readonly MODEL_MAP: Record<string, { dir?: string; file?: string; url?: string; stage: 'sensevoice' | 'breeze-asr-25' | 'qwen3-asr' | 'breeze-gguf' | 'vad'; isArchive: boolean; packageName?: string; isBreezeAsr?: boolean }> = {
    sensevoice: { dir: SENSEVOICE_MODEL_DIR, url: SENSEVOICE_ARCHIVE_URL, stage: 'sensevoice', isArchive: true },
    'breeze-asr-25': { stage: 'breeze-asr-25', isArchive: false, isBreezeAsr: true },
    'qwen3-asr': { file: QWEN3_ASR_MODEL_FILE, url: QWEN3_ASR_MODEL_URL, stage: 'qwen3-asr', isArchive: false, packageName: 'transcribe-cpp' },
    'breeze-gguf': { file: BREEZE_GGUF_MODEL_FILE, url: BREEZE_GGUF_MODEL_URL, stage: 'breeze-gguf', isArchive: false, packageName: 'transcribe-cpp' },
    vad: { file: VAD_MODEL_FILE, url: VAD_MODEL_URL, stage: 'vad', isArchive: false },
  };

  async downloadOne(modelKey: string): Promise<void> {
    this.aborted = false;
    const entry = ModelDownloader.MODEL_MAP[modelKey];
    if (!entry) throw new Error(`Unknown model: ${modelKey}`);

    if (entry.isBreezeAsr) {
      if (!this.checkBreezeAsrRuntimeReady()) {
        throw new Error('此版本未包含 Breeze ASR runtime；請使用 BICAPTION_INCLUDE_BREEZE_ASR=1 建立專用版本。');
      }
      await this.prepareBreezeAsrModel();
    } else if (entry.isArchive) {
      const archiveName = `${modelKey}.tar.bz2`;
      const archivePath = join(this.pythonDir, archiveName);
      await this.downloadFile(entry.url!, archivePath, entry.stage);
      if (this.aborted) return;
      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try { rmSync(archivePath); } catch {}
    } else {
      if ((entry.stage === 'qwen3-asr' || entry.stage === 'breeze-gguf') && entry.packageName && !app.isPackaged && !this.checkPythonPackage(entry.packageName)) {
        await this.installPythonPackage(entry.packageName, entry.stage);
        if (this.aborted) return;
      }
      await this.downloadFile(entry.url!, join(this.pythonDir, entry.file!), entry.stage);
    }

    if (!this.aborted) {
      this.emit('done', this.checkStatus());
    }
  }

  deleteModel(modelKey: string): void {
    const entry = ModelDownloader.MODEL_MAP[modelKey];
    if (!entry) return;

    if (entry.isBreezeAsr) {
      const repoDir = this.getHuggingFaceRepoDir(BREEZE_ASR_MODEL_ID);
      if (existsSync(repoDir)) {
        try {
          rmSync(repoDir, { recursive: true, force: true });
        } catch (error) {
          console.error(`Failed to delete Breeze ASR model cache: ${error}`);
        }
      }
    } else {
      const dirPath = entry.dir ? join(this.pythonDir, entry.dir) : null;
      const filePath = entry.file ? join(this.pythonDir, entry.file) : null;
      
      if (dirPath && existsSync(dirPath)) {
        try {
          rmSync(dirPath, { recursive: true, force: true });
        } catch (error) {
          console.error(`Failed to delete model directory ${dirPath}: ${error}`);
        }
      } else if (filePath && existsSync(filePath)) {
        try {
          rmSync(filePath, { force: true });
        } catch (error) {
          console.error(`Failed to delete model file ${filePath}: ${error}`);
        }
      }
    }

    this.emit('done', this.checkStatus());
  }

  async downloadAll(): Promise<void> {
    this.aborted = false;
    const status = this.checkStatus();

    if (!status.vad) {
      await this.downloadFile(VAD_MODEL_URL, join(this.pythonDir, VAD_MODEL_FILE), 'vad');
      if (this.aborted) return;
    }

    if (!status.sensevoice) {
      const archivePath = join(this.pythonDir, 'sensevoice.tar.bz2');
      await this.downloadFile(SENSEVOICE_ARCHIVE_URL, archivePath, 'sensevoice');
      if (this.aborted) return;

      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try {
        rmSync(archivePath);
      } catch {}
    }

    if (!this.aborted) {
      this.emit('done', this.checkStatus());
    }
  }

  private emitProgress(progress: ModelDownloadProgress) {
    this.emit('progress', progress);
  }

  private downloadFile(url: string, dest: string, stage: ModelDownloadProgress['stage']): Promise<void> {
    return new Promise((resolve, reject) => {
      const tmpDest = dest + '.tmp';
      const doRequest = (requestUrl: string) => {
        const mod = requestUrl.startsWith('https') ? https : http;
        mod.get(requestUrl, (res: any) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doRequest(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} downloading ${stage}`));
            return;
          }

          const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
          let downloadedBytes = 0;
          const file = createWriteStream(tmpDest);

          res.on('data', (chunk: Buffer) => {
            if (this.aborted) {
              res.destroy();
              file.close();
              try { rmSync(tmpDest); } catch {}
              return;
            }
            downloadedBytes += chunk.length;
            file.write(chunk);
            this.emitProgress({
              stage,
              percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
              downloadedMB: Math.round(downloadedBytes / 1048576),
              totalMB: Math.round(totalBytes / 1048576),
            });
          });

          res.on('end', () => {
            file.end(() => {
              if (!this.aborted) {
                renameSync(tmpDest, dest);
              }
              resolve();
            });
          });

          res.on('error', (err: Error) => {
            file.close();
            try { rmSync(tmpDest); } catch {}
            reject(err);
          });
        }).on('error', reject);
      };
      doRequest(url);
    });
  }

  private extractTarBz2(archivePath: string, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('tar', ['xjf', archivePath], { cwd }, (error) => {
        if (error) {
          reject(new Error(`Failed to extract model archive: ${error.message}`));
        } else {
          this.emitProgress({ stage: 'extracting', percent: 100, downloadedMB: 0, totalMB: 0 });
          resolve();
        }
      });
    });
  }

  private getPythonCommand(): string {
    const venvPython = join(process.cwd(), '.venv', 'bin', 'python');
    return existsSync(venvPython) ? venvPython : 'python3';
  }

  private checkPythonPackage(packageName: string): boolean {
    try {
      execFileSync(this.getPythonCommand(), ['-c', `from importlib.metadata import version; version(${JSON.stringify(packageName)})`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private installPythonPackage(packageName: string, stage: 'qwen3-asr' | 'breeze-gguf'): Promise<void> {
    if (app.isPackaged) {
      this.emitProgress({ stage, percent: 100, downloadedMB: 0, totalMB: 0 });
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const command = this.getPythonCommand();
      this.emitProgress({ stage, percent: 5, downloadedMB: 0, totalMB: 0 });
      const child = spawn(command, ['-m', 'pip', 'install', packageName], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', () => {
        this.emitProgress({ stage, percent: 60, downloadedMB: 0, totalMB: 0 });
      });
      child.stderr.on('data', () => {
        this.emitProgress({ stage, percent: 60, downloadedMB: 0, totalMB: 0 });
      });
      child.on('exit', (code) => {
        if (code === 0) {
          this.emitProgress({ stage, percent: 100, downloadedMB: 0, totalMB: 0 });
          resolve();
        } else {
          reject(new Error(`Failed to install ${packageName}`));
        }
      });
      child.on('error', reject);
    });
  }

  private migrateLegacyHuggingFaceCache() {
    const managedHubDir = join(this.huggingFaceHome, 'hub');
    if (existsSync(managedHubDir)) {
      return;
    }

    const legacyHubDir = join(process.env.HOME || '', '.cache', 'huggingface', 'hub');
    if (!legacyHubDir || !existsSync(legacyHubDir)) {
      return;
    }

    try {
      mkdirSync(dirname(managedHubDir), { recursive: true });
      const legacyStat = lstatSync(legacyHubDir);
      if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
        return;
      }
      symlinkSync(legacyHubDir, managedHubDir, 'dir');
    } catch {
      // Ignore migration failures and fall back to downloading into the managed cache.
    }
  }

  private getHuggingFaceRepoDir(modelId: string): string {
    return join(this.huggingFaceHome, 'hub', `models--${modelId.replace(/\//g, '--')}`);
  }

  private checkTranscribeRuntimeReady(): boolean {
    if (!app.isPackaged) {
      return this.checkPythonPackage('transcribe-cpp');
    }
    return Boolean(process.resourcesPath)
      && existsSync(join(process.resourcesPath, 'sidecar', TRANSCRIBE_RUNTIME_MARKER));
  }

  private checkBreezeAsrRuntimeReady(): boolean {
    if (!app.isPackaged) {
      return this.checkPythonPackage('mlx-whisper');
    }
    return Boolean(process.resourcesPath)
      && existsSync(join(process.resourcesPath, 'sidecar', BREEZE_ASR_RUNTIME_MARKER));
  }

  private checkBreezeAsrModelReady(): boolean {
    return existsSync(join(
      this.getHuggingFaceRepoDir(BREEZE_ASR_MODEL_ID),
      'snapshots',
      BREEZE_ASR_MODEL_REVISION,
      'config.json',
    ));
  }

  private prepareBreezeAsrModel(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emitProgress({ stage: 'breeze-asr-25', percent: 1, downloadedMB: 0, totalMB: 0 });
      const command = app.isPackaged ? getSidecarCommand().command : this.getPythonCommand();
      const args = app.isPackaged
        ? [...getSidecarCommand().args, '--breeze-asr-download']
        : [
            '-c',
            'from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2])',
            BREEZE_ASR_MODEL_ID,
            BREEZE_ASR_MODEL_REVISION,
          ];
      const child = spawn(command, args, {
        cwd: app.isPackaged ? getSpawnCwd() : process.cwd(),
        env: {
          ...process.env,
          HF_HOME: this.huggingFaceHome,
          HUGGINGFACE_HUB_CACHE: join(this.huggingFaceHome, 'hub'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onProgress = () => this.emitProgress({ stage: 'breeze-asr-25', percent: 50, downloadedMB: 0, totalMB: 0 });
      child.stdout.on('data', onProgress);
      child.stderr.on('data', onProgress);
      child.on('exit', (code) => {
        if (code === 0 && this.checkBreezeAsrModelReady()) {
          this.emitProgress({ stage: 'breeze-asr-25', percent: 100, downloadedMB: 0, totalMB: 0 });
          resolve();
        } else {
          reject(new Error('Breeze ASR 25 下載或版本驗證失敗。'));
        }
      });
      child.on('error', reject);
    });
  }

}
