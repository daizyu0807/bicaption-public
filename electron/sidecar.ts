import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptionConfig, SessionUpdatePayload, SidecarEvent } from './types.js';
import { getDebugTracePath, getManagedHuggingFaceHome, getSidecarCommand, getModelDir, getSpawnCwd } from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ignoredStderrPatterns = [
  'Disabling PyTorch because PyTorch >= 2.4 is required but found 2.2.2',
  'PyTorch was not found. Models won\'t be available',
];
const ignoredStdoutPatterns = [
  'Intel MKL',
  'OMP:',
  'OpenMP',
  'MKL_VERBOSE',
];
const tracePath = getDebugTracePath();
const tracedEventTypes = new Set<SidecarEvent['type']>([
  'session_state',
  'session_stopped_ack',
  'dictation_final',
  'error',
]);

function traceSidecar(message: string) {
  try {
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, `${new Date().toISOString()} [electron-sidecar] ${message}\n`, 'utf-8');
  } catch {
    // Ignore trace write failures.
  }
}

function formatTraceEvent(event: SidecarEvent): string {
  const base = `stdout event=${event.type} session=${event.sessionId} mode=${event.mode}`;
  if (event.type === 'error') {
    return `${base} code=${event.code} recoverable=${String(event.recoverable)} message=${JSON.stringify(event.message)}`;
  }
  if (event.type === 'session_state') {
    return `${base} state=${event.state} detail=${JSON.stringify(event.detail ?? '')}`;
  }
  return base;
}

function shouldTraceEvent(event: SidecarEvent): boolean {
  return tracedEventTypes.has(event.type);
}

interface SidecarCommand {
  command: 'start_session' | 'stop_session' | 'ping' | 'update_session';
  payload: Record<string, unknown> | CaptionConfig | SessionUpdatePayload;
}

export class SidecarBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pendingStopPromise: Promise<void> | null = null;
  private resolvePendingStop: (() => void) | null = null;

  start() {
    if (this.child) {
      return;
    }

    const { command, args: spawnArgs } = getSidecarCommand();
    const huggingFaceHome = getManagedHuggingFaceHome();
    traceSidecar(`spawn command=${command} args=${spawnArgs.join(' ')}`);
    const child = spawn(command, spawnArgs, {
      cwd: getSpawnCwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        USE_TORCH: '0',
        KMP_WARNINGS: '0',
        MKL_VERBOSE: '0',
        BICAPTION_MODEL_DIR: getModelDir(),
        BICAPTION_TRACE_PATH: tracePath,
        HF_HOME: huggingFaceHome,
        HUGGINGFACE_HUB_CACHE: join(huggingFaceHome, 'hub'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const lineReader = createInterface({ input: child.stdout });
    lineReader.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      if (ignoredStdoutPatterns.some((pattern) => trimmed.includes(pattern))) {
        return;
      }
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        this.emit('error', {
          type: 'error',
          mode: 'subtitle',
          sessionId: 'sidecar-bridge',
          code: 'sidecar_stdout',
          message: trimmed,
          recoverable: true,
        } satisfies SidecarEvent);
        return;
      }
      try {
        const event = JSON.parse(trimmed) as SidecarEvent;
        if (shouldTraceEvent(event)) {
          traceSidecar(formatTraceEvent(event));
        }
        if (event.type === 'session_stopped_ack') {
          traceSidecar(`resolving pending stop for session=${event.sessionId}`);
          this.finishPendingStop();
        }
        this.emit(event.type, event);
        this.emit('event', event);
      } catch (error) {
        this.emit('error', {
          type: 'error',
          mode: 'subtitle',
          sessionId: 'sidecar-bridge',
          code: 'sidecar_parse_error',
          message: `${error instanceof Error ? error.message : 'Unknown sidecar parse error'}: ${trimmed.slice(0, 160)}`,
          recoverable: true,
        } satisfies SidecarEvent);
      }
    });

    const errorReader = createInterface({ input: child.stderr });
    errorReader.on('line', (line) => {
      if (!line.trim()) {
        return;
      }
      traceSidecar(`stderr ${line.trim()}`);
      if (ignoredStderrPatterns.some((pattern) => line.includes(pattern))) {
        return;
      }
      this.emit('error', {
        type: 'error',
        mode: 'subtitle',
        sessionId: 'sidecar-bridge',
        code: 'sidecar_stderr',
        message: line,
        recoverable: true,
      } satisfies SidecarEvent);
    });

    child.on('exit', (code, signal) => {
      traceSidecar(`child exit code=${String(code)} signal=${String(signal)}`);
      this.child = null;
      this.finishPendingStop();
      this.emit('session_state', {
        type: 'session_state',
        mode: 'subtitle',
        sessionId: 'sidecar-exit',
        state: code === 0 ? 'stopped' : 'error',
        detail: signal ? `Exited via ${signal}` : `Exited with code ${String(code)}`,
      } satisfies SidecarEvent);
    });
  }

  send(command: SidecarCommand) {
    if (!this.child) {
      this.start();
    }
    traceSidecar(`send command=${command.command} session=${String((command.payload as CaptionConfig)?.sessionId ?? '')}`);
    this.child?.stdin.write(`${JSON.stringify(command)}\n`);
  }

  startSession(config: CaptionConfig) {
    this.send({ command: 'start_session', payload: config });
  }

  stopSession() {
    if (!this.child) {
      traceSidecar('stopSession skipped because child is null');
      return Promise.resolve();
    }
    if (this.pendingStopPromise) {
      traceSidecar('stopSession reused existing pendingStopPromise');
      return this.pendingStopPromise;
    }
    traceSidecar('stopSession created pendingStopPromise');
    this.pendingStopPromise = new Promise<void>((resolve) => {
      this.resolvePendingStop = resolve;
    });
    this.send({ command: 'stop_session', payload: {} });
    return this.pendingStopPromise;
  }

  ping() {
    this.send({ command: 'ping', payload: {} });
  }

  updateSession(payload: SessionUpdatePayload) {
    this.send({ command: 'update_session', payload });
  }

  dispose() {
    void this.stopSession();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.finishPendingStop();
  }

  private finishPendingStop() {
    traceSidecar('finishPendingStop invoked');
    this.resolvePendingStop?.();
    this.resolvePendingStop = null;
    this.pendingStopPromise = null;
  }
}
