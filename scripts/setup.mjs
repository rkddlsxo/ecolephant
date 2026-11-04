import fs from 'node:fs';
import path from 'node:path';
import { root, venvPython, discoverPython, run } from './runtime.mjs';
import { configureLocalEnvironment } from './setup-env.mjs';
const explicit = process.argv.indexOf('--python');
if (!fs.existsSync(venvPython))
  run(discoverPython(explicit >= 0 ? process.argv[explicit + 1] : undefined), [
    '-m',
    'venv',
    path.join(root, '.venv'),
  ]);
run(venvPython, ['-m', 'pip', 'install', '-r', 'backend/requirements-dev.txt']);
await configureLocalEnvironment({ root, python: venvPython });
fs.mkdirSync(path.join(root, '.data'), { recursive: true });
run(process.execPath, [path.join(root, 'scripts/contracts.mjs')]);
console.log(
  'Setup complete. Start with npm run dev. Demo credentials stay in ignored local files.',
);
