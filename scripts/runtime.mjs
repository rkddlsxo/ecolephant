import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const venvPython = path.join(
  root,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
export function discoverPython(explicit) {
  const options = [
    explicit,
    process.env.PYTHON,
    'python3.12',
    'python3',
    'python',
    path.join(
      os.homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
    ),
  ].filter(Boolean);
  for (const candidate of options) {
    const found = spawnSync(
      candidate,
      ['-c', 'import sys; assert sys.version_info >= (3,12); print(sys.executable)'],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    );
    if (found.status === 0) return found.stdout.trim();
  }
  throw new Error('Install Python 3.12+ or use npm run setup -- --python <absolute path>');
}
export function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
export function requireSetup() {
  if (!fs.existsSync(venvPython) || !fs.existsSync(path.join(root, 'backend/.env'))) {
    throw new Error('Run npm install and npm run setup first');
  }
}
