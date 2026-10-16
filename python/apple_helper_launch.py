"""Launch the Speech helper as its own macOS app, with local PCM IPC."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

class TailStream:
    def __init__(self, owner, path, diagnostics=False):
        self.owner, self.path, self.diagnostics = owner, path, diagnostics

    def __iter__(self):
        with open(self.path, 'rb') as stream:
            while True:
                line = stream.readline()
                if line:
                    if self.diagnostics:
                        try:
                            event = json.loads(line)
                            if event.get('type') == 'helper_process':
                                self.owner.native_pid = int(event['pid'])
                                continue
                        except (ValueError, KeyError, TypeError):
                            pass
                    yield line
                elif self.owner.finished or self.owner.poll() is not None:
                    return
                else:
                    time.sleep(0.02)

class AppHelperProcess:
    def __init__(self, bundle, args):
        self.directory = tempfile.TemporaryDirectory(prefix='bicaption-apple-speech-')
        root = Path(self.directory.name)
        self.finished = False
        self.native_pid = None
        self.started_at = time.monotonic()
        input_path = root / 'audio.fifo'
        output_path, error_path = root / 'stdout.jsonl', root / 'stderr.log'
        os.mkfifo(input_path, 0o600)
        output_path.touch(mode=0o600)
        error_path.touch(mode=0o600)
        # Keep the write end open before LaunchServices opens the read end.
        self.stdin = os.fdopen(os.open(input_path, os.O_RDWR), 'wb', buffering=0)
        try:
            self.launcher = subprocess.Popen([
                '/usr/bin/open', '-g', '-n', '-W', '--stdin', str(input_path),
                '--stdout', str(output_path), '--stderr', str(error_path),
                str(bundle), '--args', *args,
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            self.stdin.close()
            self.directory.cleanup()
            raise
        self.stdout = TailStream(self, output_path)
        self.stderr = TailStream(self, error_path, diagnostics=True)

    @property
    def returncode(self):
        return self.poll()

    def poll(self):
        if self.native_pid is not None:
            try:
                os.kill(self.native_pid, 0)
                return None
            except ProcessLookupError:
                return 0
        code = self.launcher.poll()
        # LaunchServices can finish `open -W` before the helper has even
        # published its PID. Follow the native process instead of that wrapper.
        if code == 0 and time.monotonic() - self.started_at < 10:
            return None
        return code

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        while (result := self.poll()) is None:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired('AppleSTTHelper', timeout)
            time.sleep(0.02)
        self.finished = True
        return result

    def _signal(self, sig):
        if self.native_pid is not None:
            try: os.kill(self.native_pid, sig)
            except ProcessLookupError: pass
        if sig == signal.SIGKILL:
            self.launcher.kill()
        else:
            self.launcher.terminate()

    def terminate(self): self._signal(signal.SIGTERM)
    def kill(self): self._signal(signal.SIGKILL)

    def cleanup(self):
        self.finished = True
        if not self.stdin.closed:
            self.stdin.close()
        self.directory.cleanup()

def launch_apple_helper(binary, args):
    bundle = Path(binary).resolve().parents[2]
    if sys.platform == 'darwin' and bundle.suffix == '.app' and (bundle/'Contents'/'Info.plist').is_file():
        return AppHelperProcess(bundle, args)
    return subprocess.Popen([binary, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
