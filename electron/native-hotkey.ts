import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { DictationHotkeyBinding, DictationHotkeyEvent } from './types.js';
import { getGlobalHotkeyCommand, getSpawnCwd } from './paths.js';

export class NativeHotkeyBridge extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;

  startListening(binding: DictationHotkeyBinding) {
    this.stopListening();

    const { command, args } = getGlobalHotkeyCommand();
    if (!existsSync(command)) {
      this.emit('event', {
        type: 'error',
        message: `Missing global-hotkey helper at ${command}. Rebuild and repackage the app.`,
      } satisfies DictationHotkeyEvent);
      return;
    }
    const child = spawn(command, [
      ...args,
      '--listen',
      '--key-code',
      String(binding.keyCode),
      '--modifiers',
      binding.modifiers.join(','),
    ], {
      cwd: getSpawnCwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const event = JSON.parse(trimmed) as DictationHotkeyEvent;
        this.emit('event', event);
        this.emit(event.type, event);
      } catch (error) {
        this.emit('event', {
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to parse native hotkey event',
        } satisfies DictationHotkeyEvent);
      }
    });

    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      this.emit('event', {
        type: 'error',
        message: trimmed,
      } satisfies DictationHotkeyEvent);
    });

    child.on('error', (error) => {
      this.child = null;
      this.emit('event', {
        type: 'error',
        message: error.message,
      } satisfies DictationHotkeyEvent);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.emit('event', {
        type: 'listener_stopped',
        message: signal ? `Exited via ${signal}` : `Exited with code ${String(code)}`,
      } satisfies DictationHotkeyEvent);
    });
  }

  stopListening() {
    if (!this.child) {
      return;
    }
    this.child.kill('SIGTERM');
    this.child = null;
  }
}
