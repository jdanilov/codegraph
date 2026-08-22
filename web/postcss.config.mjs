/**
 * Tailwind v4 runs as a PostCSS plugin here rather than through
 * `@tailwindcss/vite`: the repo has a single, CommonJS root `package.json`
 * (no `web/package.json` by design), so `vite.config.ts` is loaded as CJS and
 * cannot import the ESM-only vite plugin. PostCSS config is loaded at runtime,
 * where an `.mjs` file is fine.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
