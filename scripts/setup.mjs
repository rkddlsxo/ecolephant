import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { root, venvPython, discoverPython, run } from './runtime.mjs';
const explicit = process.argv.indexOf('--python');
if (!fs.existsSync(venvPython))
  run(discoverPython(explicit >= 0 ? process.argv[explicit + 1] : undefined), [
    '-m',
    'venv',
    path.join(root, '.venv'),
  ]);
run(venvPython, ['-m', 'pip', 'install', '-r', 'backend/requirements-dev.txt']);
const file = path.join(root, 'backend/.env');
if (!fs.existsSync(file)) {
  const token = crypto.randomBytes(32).toString('hex');
  const example = fs.readFileSync(path.join(root, 'backend/.env.example'), 'utf8');
  fs.writeFileSync(
    file,
    example.replace('ECOLEPHANT_LOCAL_TOKEN=', `ECOLEPHANT_LOCAL_TOKEN=${token}`),
    { mode: 0o600 },
  );
}
const local = fs
  .readFileSync(file, 'utf8')
  .match(/^ECOLEPHANT_LOCAL_TOKEN=(.+)$/m)?.[1]
  .trim();
if (!local) throw new Error('Set ECOLEPHANT_LOCAL_TOKEN in backend/.env');
const front = path.join(root, 'frontend/.env.local');
if (!fs.existsSync(front))
  fs.writeFileSync(
    front,
    `VITE_LOCAL_TOKEN=${local}
`,
    { mode: 0o600 },
  );
fs.mkdirSync(path.join(root, '.data'), { recursive: true });
run(process.execPath, [path.join(root, 'scripts/contracts.mjs')]);
console.log(
  'Setup complete. Start with npm run dev. Demo credentials stay in ignored local files.',
);
