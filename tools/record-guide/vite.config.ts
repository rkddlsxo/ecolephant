import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

// Local-only dev tool. Uses the self-hosted MediaPipe assets of the frontend (npm run pose:assets).
// Not part of the frontend build or routes; `vite build` is never run for it.
export default defineConfig({
  root: here,
  publicDir: fileURLToPath(new URL('../../frontend/public', import.meta.url)),
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  test: { root: here, environment: 'node' },
});
