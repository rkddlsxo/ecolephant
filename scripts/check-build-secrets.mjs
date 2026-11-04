import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root } from './runtime.mjs';

const frontend = path.join(root, 'frontend');
const tempParent = realpathSync(tmpdir());
const tempOutput = mkdtempSync(path.join(tempParent, 'ecolephant-bundle-check-'));
const resolvedOutput = realpathSync(tempOutput);
if (
  path.dirname(resolvedOutput) !== tempParent ||
  !path.basename(resolvedOutput).startsWith('ecolephant-bundle-check-')
) {
  throw new Error('Unexpected temporary build location');
}
const sentinel = `local-test-${randomBytes(24).toString('hex')}`;
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? files(name) : entry.isFile() ? [name] : [];
  });
}

try {
  const result = spawnSync(
    process.execPath,
    [vite, 'build', '--outDir', resolvedOutput, '--emptyOutDir'],
    {
      cwd: frontend,
      windowsHide: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        VITE_LOCAL_TOKEN: sentinel,
        VITE_AUTH_MODE: 'cognito',
        VITE_COGNITO_USER_POOL_ID: 'ap-northeast-2_Example1',
        VITE_COGNITO_CLIENT_ID: 'exampleclient',
        VITE_API_BASE_URL: 'https://api.example.invalid',
      },
    },
  );
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
  } else {
    const leaks = files(resolvedOutput).filter((file) => readFileSync(file).includes(sentinel));
    if (leaks.length) {
      console.error('Local development token was embedded in a hosted build.');
      for (const file of leaks) console.error(path.relative(resolvedOutput, file));
      process.exitCode = 1;
    } else {
      console.log('PASS hosted build contains no local test token');
    }
  }
} finally {
  if (realpathSync(tempOutput) !== resolvedOutput || path.dirname(resolvedOutput) !== tempParent) {
    throw new Error('Temporary build location changed');
  }
  rmSync(resolvedOutput, { recursive: true, force: true });
}
