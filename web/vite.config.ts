import * as path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Frontend build for the visualizer (`codegraph ui`).
 *
 * Tailwind is wired through PostCSS (`web/postcss.config.mjs`), not the
 * `@tailwindcss/vite` plugin — see that file for why.
 *
 * There is exactly ONE package.json in this repo — the root one — and every
 * frontend dependency lives in its devDependencies (no npm workspaces). This
 * config therefore sets `root` to `web/` explicitly and writes the bundle into
 * `dist/ui-web/`, which the server serves statically and npm ships as part of
 * `dist`.
 */
export default defineConfig({
  root: __dirname,
  // Absolute asset URLs: the server serves the bundle from `/`, and a deep SPA
  // route (`/node/abc`) must still resolve `/assets/...` correctly.
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'dist', 'ui-web'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    // `vite dev` talks to a `codegraph ui` running on its default port, so the
    // dev server and the production bundle hit the exact same API paths.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4747',
        changeOrigin: false,
      },
    },
  },
});
