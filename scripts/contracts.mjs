import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const files = [
  ['docs/api/openapi.json', 'backend/ecolephant/contracts/openapi.json'],
  ['harness/fixtures/policy/example.json', 'backend/ecolephant/contracts/policy.json'],
  ['harness/fixtures/policy/example.json', 'ai/src/policy.json'],
];
for (const [source, target] of files) {
  const input = fs.readFileSync(path.join(root, source));
  const output = path.join(root, target);
  if (check) {
    if (!fs.existsSync(output) || !input.equals(fs.readFileSync(output)))
      throw new Error(`Stale contract: ${target}`);
  } else {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, input);
  }
}
const generated = path.join(root, 'frontend/src/api/generated.ts');
const before = fs.existsSync(generated) ? fs.readFileSync(generated, 'utf8') : '';
const cli = path.join(root, 'node_modules/openapi-typescript/bin/cli.js');
const result = spawnSync(
  process.execPath,
  [cli, 'docs/api/openapi.json', '-o', 'frontend/src/api/generated.ts'],
  { cwd: root, stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status || 1);
if (check && fs.readFileSync(generated, 'utf8') !== before) {
  fs.writeFileSync(generated, before);
  throw new Error('Stale generated API types; run npm run contracts:sync');
}
console.log(check ? 'Contract copies and generated types match' : 'Contracts synchronized');
