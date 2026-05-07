import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

import { getCompatibleNodePath } from './compatible-node.mjs';

const viteBin = join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');
const nodePath = getCompatibleNodePath();

const child = spawn(nodePath, [viteBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
