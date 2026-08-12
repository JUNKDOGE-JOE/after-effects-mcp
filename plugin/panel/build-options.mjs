import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared esbuild config for build.mjs and verify-bundle.mjs (#223): the
// freshness gate must rebuild with exactly the shipped options or it can
// never prove anything. absWorkingDir pins resolution to the panel root so
// both entry points work from any cwd.
export function buildOptions() {
  const panelRoot = path.dirname(fileURLToPath(import.meta.url));
  return {
    absWorkingDir: panelRoot,
    entryPoints: ['src/main.jsx'],
    bundle: true,
    outfile: '../client/dist/app.js',
    format: 'iife',
    target: 'es2019',
    // CEP 11 (AE 2023/2024, V8 8.8) lacks newer runtime APIs that `target`
    // cannot lower (Object.hasOwn, Array.prototype.at, structuredClone) — the
    // inject shim defines them conditionally before any bundled code runs.
    inject: ['src/cep-runtime-inject.js'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    // CEP pages have Node injected; React/lucide are bundled into the panel asset.
    loader: { '.css': 'css' },
    logLevel: 'info',
  };
}
