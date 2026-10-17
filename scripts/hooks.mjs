import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
if (fs.existsSync('.git') && !process.env.CI && process.env.HUSKY !== '0') {
  const result = spawnSync(process.execPath, ['node_modules/husky/bin.js'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
