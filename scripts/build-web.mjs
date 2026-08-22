#!/usr/bin/env node
/**
 * Build the visualizer frontend (`web/`) into `dist/ui-web/`.
 *
 * Wrapped in a script rather than calling `vite build` directly from the npm
 * script so a production install can still build the SERVER: `npm ci --omit=dev
 * && npm run build` has no vite (every frontend dependency is a devDependency
 * by contract), and that must warn and continue rather than fail the build.
 * Release and git-URL installs both run with devDependencies present, so they
 * get the real bundle.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let viteBin;
try {
  // Resolve through package.json: vite's `exports` map doesn't expose ./bin.
  const vitePackage = require.resolve('vite/package.json', { paths: [repoRoot] });
  viteBin = path.join(path.dirname(vitePackage), 'bin', 'vite.js');
} catch {
  console.warn('[build:web] vite is not installed — skipping the web UI bundle.');
  console.warn('[build:web] Run "npm install" (with devDependencies) to build it.');
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [viteBin, 'build', '--config', path.join(repoRoot, 'web', 'vite.config.ts')],
  { stdio: 'inherit', cwd: repoRoot }
);

process.exit(result.status ?? 1);
