import fs from 'node:fs';
import path from 'node:path';
import { root, venvPython, requireSetup, run } from './runtime.mjs';
requireSetup();
const output = path.join(root, '.build/lambda');
// Only a task-owned build directory is replaced. No environment file is copied.
if (!output.startsWith(path.join(root, '.build') + path.sep)) throw new Error('Invalid asset path');
fs.mkdirSync(output, { recursive: true });
run(venvPython, [
  '-m',
  'pip',
  'install',
  '--upgrade',
  '--platform',
  'manylinux2014_x86_64',
  '--platform',
  'manylinux_2_28_x86_64',
  '--implementation',
  'cp',
  '--python-version',
  '3.12',
  '--only-binary=:all:',
  '--target',
  output,
  '-r',
  'backend/requirements.txt',
]);
fs.cpSync(path.join(root, 'backend/ecolephant'), path.join(output, 'ecolephant'), {
  recursive: true,
  filter: (source) => !source.split(path.sep).includes('__pycache__'),
});
fs.copyFileSync(
  path.join(root, 'backend/lambda_handler.py'),
  path.join(output, 'lambda_handler.py'),
);
console.log('Lambda asset prepared in .build/lambda; no deployment performed.');
