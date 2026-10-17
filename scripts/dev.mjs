import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { root, venvPython, requireSetup } from './runtime.mjs';
requireSetup();
const portable = path.join(root, '.tools/node22/node.exe');
const frontendNode =
  process.platform === 'win32' && fs.existsSync(portable) ? portable : process.execPath;
const children = [
  spawn(venvPython, ['backend/run.py'], { cwd: root, stdio: 'inherit', windowsHide: true }),
  spawn(frontendNode, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {
    cwd: path.join(root, 'frontend'),
    stdio: 'inherit',
    windowsHide: true,
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log('ecolephant: http://127.0.0.1:5173 | local API: http://127.0.0.1:5000');
