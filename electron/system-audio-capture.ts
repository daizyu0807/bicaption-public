/**
 * System audio capture via Electron's desktopCapturer + getDisplayMedia.
 *
 * Uses setDisplayMediaRequestHandler to auto-select the screen source
 * (no picker dialog). An AudioWorklet in a hidden BrowserWindow extracts
 * PCM float32 chunks and sends them to the main process via IPC.
 *
 * This uses the Electron app's own Screen Recording TCC permission —
 * no separate helper app authorization is needed.
 */

import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type SystemAudioCallback = (pcmFloat32: Buffer) => void;

interface CaptureState {
  window: BrowserWindow;
  onSamples: SystemAudioCallback;
  sampleRate: number;
}

/** Resolve the preload path the same way main.ts does. */
function getPreloadPath(): string {
  const isPackaged = app.isPackaged;
  const projectRoot = join(__dirname, '../..');
  return isPackaged
    ? join(app.getAppPath(), 'electron', 'system-audio-preload.cjs')
    : join(projectRoot, 'electron', 'system-audio-preload.cjs');
}

export class SystemAudioCapture {
  private state: CaptureState | null = null;
  private readyResolve: ((sampleRate: number) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  /**
   * Start capturing system audio.
   * Resolves with the capture sample rate once audio is flowing.
   */
  async start(onSamples: SystemAudioCallback): Promise<number> {
    if (this.state) {
      throw new Error('System audio capture already running');
    }

    // Register IPC handlers.
    ipcMain.on('system-audio:pcm-chunk', this.handlePCM);
    ipcMain.once('system-audio:ready', this.handleReady);
    ipcMain.once('system-audio:error', this.handleError);

    // Set up display media handler to auto-select screen (no picker).
    session.defaultSession.setDisplayMediaRequestHandler(
      async (_request, callback) => {
        console.log('[system-audio] displayMediaRequestHandler invoked');
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        console.log(`[system-audio] desktopCapturer sources: ${sources.length}`);
        if (sources.length === 0) {
          callback({});
          return;
        }
        callback({
          video: sources[0],
          audio: 'loopback',
          enableLocalEcho: false,
        });
      },
    );

    const preloadPath = getPreloadPath();
    console.log(`[system-audio] preload path: ${preloadPath}`);

    // Create hidden window for audio capture.
    const captureWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        preload: preloadPath,
      },
    });

    this.state = { window: captureWindow, onSamples, sampleRate: 48000 };

    // Forward renderer console to main for debugging.
    captureWindow.webContents.on('console-message', (_e: Electron.Event, ..._args: unknown[]) => {
      // Use the params-based approach; fall back to positional for older Electron.
      const params = (_e as any).params ?? {};
      const msg = params.message ?? (typeof _args[1] === 'string' ? _args[1] : String(_args[1] ?? ''));
      console.log(`[system-audio-renderer] ${msg}`);
    });

    // Write a minimal HTML file to disk so we get a file:// origin (secure context).
    // about:blank and data: URLs don't provide navigator.mediaDevices.
    const captureScript = buildCaptureScript();
    const html = `<!DOCTYPE html><html><head><title>SCK</title></head><body><script>${captureScript}</script></body></html>`;
    const htmlPath = join(app.getPath('temp'), 'bicaption-sck-capture.html');
    writeFileSync(htmlPath, html, 'utf-8');
    console.log(`[system-audio] loading capture page: ${htmlPath}`);
    await captureWindow.loadFile(htmlPath);
    console.log('[system-audio] capture page loaded, waiting for ready...');

    // Wait for the renderer to signal ready or error.
    const sampleRate = await new Promise<number>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const timer = setTimeout(() => {
        console.log('[system-audio] TIMEOUT waiting for ready signal');
        reject(new Error('System audio capture timed out'));
      }, 15_000);
      // Clear timeout on settle to avoid stale log from previous attempts.
      const orig = this.readyResolve;
      this.readyResolve = (sr) => { clearTimeout(timer); orig?.(sr); };
      const origRej = this.readyReject;
      this.readyReject = (err) => { clearTimeout(timer); origRej?.(err); };
    });

    if (this.state) {
      this.state.sampleRate = sampleRate;
    }
    console.log(`[system-audio] capture started, sampleRate=${sampleRate}`);
    return sampleRate;
  }

  stop(): void {
    ipcMain.removeListener('system-audio:pcm-chunk', this.handlePCM);
    ipcMain.removeAllListeners('system-audio:ready');
    ipcMain.removeAllListeners('system-audio:error');
    session.defaultSession.setDisplayMediaRequestHandler(null);

    if (this.state?.window && !this.state.window.isDestroyed()) {
      this.state.window.destroy();
    }
    this.state = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  get isCapturing(): boolean {
    return this.state !== null;
  }

  get sampleRate(): number {
    return this.state?.sampleRate ?? 48000;
  }

  // --- IPC handlers (arrow functions to preserve `this`) ---

  private handlePCM = (_event: Electron.IpcMainEvent, arrayBuffer: ArrayBuffer): void => {
    if (this.state?.onSamples) {
      this.state.onSamples(Buffer.from(arrayBuffer));
    }
  };

  private handleReady = (_event: Electron.IpcMainEvent, sampleRate: number): void => {
    console.log(`[system-audio] ready signal received, sampleRate=${sampleRate}`);
    this.readyResolve?.(sampleRate);
    this.readyResolve = null;
    this.readyReject = null;
  };

  private handleError = (_event: Electron.IpcMainEvent, message: string): void => {
    console.log(`[system-audio] error signal received: ${message}`);
    this.readyReject?.(new Error(`System audio capture failed: ${message}`));
    this.readyResolve = null;
    this.readyReject = null;
  };
}

/**
 * Build the JS capture code embedded in the HTML page.
 */
function buildCaptureScript(): string {
  const processorCode = `
class SystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._chunkSize = 960;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const ch = input[0];
    const buf = new Float32Array(this._buffer.length + ch.length);
    buf.set(this._buffer);
    buf.set(ch, this._buffer.length);
    this._buffer = buf;
    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.slice(0, this._chunkSize);
      this.port.postMessage({ samples: chunk.buffer }, [chunk.buffer]);
      this._buffer = this._buffer.slice(this._chunkSize);
    }
    return true;
  }
}
registerProcessor('system-audio-processor', SystemAudioProcessor);
`;

  return `(async function() {
  try {
    console.log('[capture] checking bridge...');
    if (!window.__systemAudio) {
      console.error('[capture] __systemAudio bridge not available!');
      return;
    }
    console.log('[capture] calling getDisplayMedia...');
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    console.log('[capture] stream obtained, video=' +
      stream.getVideoTracks().length + ' audio=' + stream.getAudioTracks().length);
    stream.getVideoTracks().forEach(t => t.stop());
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      window.__systemAudio.sendError('No audio track in captured stream');
      return;
    }
    console.log('[capture] setting up AudioWorklet...');
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    const blob = new Blob([${JSON.stringify(processorCode)}], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const processor = new AudioWorkletNode(ctx, 'system-audio-processor');
    processor.port.onmessage = (e) => {
      window.__systemAudio.sendPCM(e.data.samples);
    };
    source.connect(processor);
    console.log('[capture] ready, sampleRate=' + ctx.sampleRate);
    window.__systemAudio.sendReady(ctx.sampleRate);
  } catch (err) {
    console.error('[capture] error:', err);
    if (window.__systemAudio) {
      window.__systemAudio.sendError(err.message || String(err));
    }
  }
})();`;
}
