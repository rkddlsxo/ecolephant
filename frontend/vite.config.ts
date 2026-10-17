import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:5000', '/health': 'http://127.0.0.1:5000' },
  },
  build: { sourcemap: false },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
});
