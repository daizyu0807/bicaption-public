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
const WHISPER_TINY_EN_MODEL_DIR = 'sherpa-onnx-whisper-tiny.en';
const WHISPER_TINY_EN_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2';
const WHISPER_SMALL_MODEL_DIR = 'sherpa-onnx-whisper-small';
const WHISPER_SMALL_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2';
const ZIPFORMER_KOREAN_MODEL_DIR = 'sherpa-onnx-zipformer-korean-2024-06-24';
const ZIPFORMER_KOREAN_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-korean-2024-06-24.tar.bz2';
const VAD_MODEL_FILE = 'silero_vad.onnx';
const VAD_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const DEFAULT_MLX_WHISPER_MODEL = process.env.BICAPTION_MLX_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo';
const BREEZE_ASR_MODEL_ID = 'Kenji8000/Breeze-ASR-25-mlx';
const BREEZE_ASR_MODEL_REVISION = '56b8508317e7766d904d1f0b8cc612687dfa39a4';
const BREEZE_ASR_RUNTIME_MARKER = 'breeze-asr-runtime.enabled';
export interface ModelStatus {
  sensevoice: boolean;
  mlxWhisper: boolean;
  breezeAsr: boolean;
  breezeAsrRuntime: boolean;
  whisperTinyEn: boolean;
  whisperSmall: boolean;
  zipformerKo: boolean;
  vad: boolean;
  ffmpeg: boolean;
  ready: boolean;
}

export interface ModelDownloadProgress {
  stage: 'sensevoice' | 'mlx-whisper' | 'breeze-asr-25' | 'whisper-tiny-en' | 'whisper-small' | 'zipformer-ko' | 'vad' | 'extracting';
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
    const mlxWhisperRuntimeReady = app.isPackaged ? true : this.checkPythonPackage('mlx-whisper');
    const mlxWhisper = mlxWhisperRuntimeReady && this.checkMlxWhisperModelReady(DEFAULT_MLX_WHISPER_MODEL);
    const breezeAsrRuntime = this.checkBreezeAsrRuntimeReady();
    const breezeAsr = breezeAsrRuntime && this.checkBreezeAsrModelReady();
    const whisperTinyEn = existsSync(join(this.pythonDir, WHISPER_TINY_EN_MODEL_DIR, 'tiny.en-encoder.int8.onnx'));
    const whisperSmall = existsSync(join(this.pythonDir, WHISPER_SMALL_MODEL_DIR, 'small-encoder.int8.onnx'));
    const zipformerKo = existsSync(join(this.pythonDir, ZIPFORMER_KOREAN_MODEL_DIR, 'encoder-epoch-99-avg-1.int8.onnx'));
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
      mlxWhisper,
      breezeAsr,
      breezeAsrRuntime,
      whisperTinyEn,
      whisperSmall,
      zipformerKo,
      vad,
      ffmpeg,
      ready: (sensevoice || mlxWhisper || whisperTinyEn || whisperSmall || zipformerKo) && vad,
    };
  }

  abort() {
    this.aborted = true;
  }

  private static readonly MODEL_MAP: Record<string, { dir?: string; file?: string; url?: string; stage: 'sensevoice' | 'mlx-whisper' | 'breeze-asr-25' | 'whisper-tiny-en' | 'whisper-small' | 'zipformer-ko' | 'vad'; isArchive: boolean; isPythonPackage?: boolean; packageName?: string; isBreezeAsr?: boolean }> = {
    sensevoice: { dir: SENSEVOICE_MODEL_DIR, url: SENSEVOICE_ARCHIVE_URL, stage: 'sensevoice', isArchive: true },
    'mlx-whisper': { stage: 'mlx-whisper', isArchive: false, isPythonPackage: true, packageName: 'mlx-whisper' },
    'breeze-asr-25': { stage: 'breeze-asr-25', isArchive: false, isBreezeAsr: true },
    'whisper-tiny-en': { dir: WHISPER_TINY_EN_MODEL_DIR, url: WHISPER_TINY_EN_ARCHIVE_URL, stage: 'whisper-tiny-en', isArchive: true },
    'whisper-small': { dir: WHISPER_SMALL_MODEL_DIR, url: WHISPER_SMALL_ARCHIVE_URL, stage: 'whisper-small', isArchive: true },
    'zipformer-ko': { dir: ZIPFORMER_KOREAN_MODEL_DIR, url: ZIPFORMER_KOREAN_ARCHIVE_URL, stage: 'zipformer-ko', isArchive: true },
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
    } else if (entry.isPythonPackage) {
      await this.installPythonPackage(entry.packageName!, 'mlx-whisper');
      if (this.aborted) return;
      await this.prepareMlxWhisperModel(DEFAULT_MLX_WHISPER_MODEL, 'mlx-whisper');
    } else if (entry.isArchive) {
      const archiveName = `${modelKey}.tar.bz2`;
      const archivePath = join(this.pythonDir, archiveName);
      await this.downloadFile(entry.url!, archivePath, entry.stage);
      if (this.aborted) return;
      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try { rmSync(archivePath); } catch {}
    } else {
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
    } else if (entry.isPythonPackage) {
      // For MLX Whisper, we only clear the model cache if it's managed.
      const repoDir = join(
        this.huggingFaceHome,
        'hub',
        `models--${DEFAULT_MLX_WHISPER_MODEL.replace(/\//g, '--')}`,
      );
      if (existsSync(repoDir)) {
        try {
          rmSync(repoDir, { recursive: true, force: true });
        } catch (error) {
          console.error(`Failed to delete MLX model cache: ${error}`);
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

    if (!status.mlxWhisper) {
      await this.installPythonPackage('mlx-whisper', 'mlx-whisper');
      if (this.aborted) return;
      await this.prepareMlxWhisperModel(DEFAULT_MLX_WHISPER_MODEL, 'mlx-whisper');
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

    if (!status.whisperTinyEn) {
      const archivePath = join(this.pythonDir, 'whisper-tiny-en.tar.bz2');
      await this.downloadFile(WHISPER_TINY_EN_ARCHIVE_URL, archivePath, 'whisper-tiny-en');
      if (this.aborted) return;

      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try {
        rmSync(archivePath);
      } catch {}
    }

    if (!status.whisperSmall) {
      const archivePath = join(this.pythonDir, 'whisper-small.tar.bz2');
      await this.downloadFile(WHISPER_SMALL_ARCHIVE_URL, archivePath, 'whisper-small');
      if (this.aborted) return;

      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try {
        rmSync(archivePath);
      } catch {}
    }

    if (!status.zipformerKo) {
      const archivePath = join(this.pythonDir, 'zipformer-ko.tar.bz2');
      await this.downloadFile(ZIPFORMER_KOREAN_ARCHIVE_URL, archivePath, 'zipformer-ko');
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

  private installPythonPackage(packageName: string, stage: 'mlx-whisper'): Promise<void> {
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

  private checkMlxWhisperModelReady(modelId: string): boolean {
    if (app.isPackaged) {
      const repoDir = join(
        this.huggingFaceHome,
        'hub',
        `models--${modelId.replace(/\//g, '--')}`,
      );
      const refsMain = join(repoDir, 'refs', 'main');
      const snapshotsDir = join(repoDir, 'snapshots');
      return existsSync(refsMain) && existsSync(snapshotsDir);
    }

    try {
      execFileSync(this.getPythonCommand(), [
        '-c',
        [
          'import sys',
          'from huggingface_hub import snapshot_download',
          'snapshot_download(repo_id=sys.argv[1], local_files_only=True)',
        ].join('; '),
        modelId,
      ], {
        stdio: 'ignore',
        env: {
          ...process.env,
          HF_HOME: this.huggingFaceHome,
          HUGGINGFACE_HUB_CACHE: join(this.huggingFaceHome, 'hub'),
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private getHuggingFaceRepoDir(modelId: string): string {
    return join(this.huggingFaceHome, 'hub', `models--${modelId.replace(/\//g, '--')}`);
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

  private prepareMlxWhisperModel(modelId: string, stage: 'mlx-whisper'): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = this.getPythonCommand();
      this.emitProgress({ stage, percent: 40, downloadedMB: 0, totalMB: 0 });
      const child = spawn(command, [
        '-c',
        [
          'import sys',
          'from huggingface_hub import snapshot_download',
          'snapshot_download(repo_id=sys.argv[1])',
        ].join('; '),
        modelId,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HF_HOME: this.huggingFaceHome,
          HUGGINGFACE_HUB_CACHE: join(this.huggingFaceHome, 'hub'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', () => {
        this.emitProgress({ stage, percent: 80, downloadedMB: 0, totalMB: 0 });
      });
      child.stderr.on('data', () => {
        this.emitProgress({ stage, percent: 80, downloadedMB: 0, totalMB: 0 });
      });
      child.on('exit', (code) => {
        if (code === 0) {
          this.emitProgress({ stage, percent: 100, downloadedMB: 0, totalMB: 0 });
          resolve();
        } else {
          reject(new Error(`Failed to prepare MLX Whisper model ${modelId}`));
        }
      });
      child.on('error', reject);
    });
  }

}
