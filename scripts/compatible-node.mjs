import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import process from 'node:process';

const CODEX_NODE_SEGMENT = '/Codex.app/Contents/Resources/node';

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function currentNodeUsesCodexRuntime(currentNodePath) {
  return currentNodePath.includes(CODEX_NODE_SEGMENT);
}

export function getCompatibleNodePath() {
  const currentNodePath = safeRealpath(process.execPath);
  if (!currentNodeUsesCodexRuntime(currentNodePath)) {
    return currentNodePath;
  }

  const pathCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => join(dir, 'node'));

  const explicitCandidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ];

  const checkedCandidates = [];
  for (const candidate of unique([...explicitCandidates, ...pathCandidates])) {
    const resolvedCandidate = safeRealpath(candidate);
    checkedCandidates.push(candidate);

    if (resolvedCandidate === currentNodePath) {
      continue;
    }

    if (isExecutable(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }

  throw new Error(
    [
      'Codex 內建 Node 啟用了 hardened runtime，無法載入 Rollup 的原生模組。',
      '請安裝或加入一個外部 Node 到 PATH（例如 Homebrew 的 /opt/homebrew/bin/node），',
      '然後重新執行目前指令。',
      `目前檢查過的候選路徑：${checkedCandidates.join(', ')}`,
    ].join(' '),
  );
}
