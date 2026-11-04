import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { root, venvPython } from './runtime.mjs';
import { buildLambda } from './lambda-package-lib.mjs';

if (!fs.existsSync(venvPython)) throw new Error('Run npm install and npm run setup first');
const output = buildLambda(root, (stage) => {
  const result = spawnSync(
    venvPython,
    [
      '-m',
      'pip',
      'install',
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
      stage,
      '-r',
      'backend/requirements.txt',
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error('Dependency installation failed; existing package retained');
});
console.log(`Lambda asset prepared in ${output}; no deployment performed.`);
