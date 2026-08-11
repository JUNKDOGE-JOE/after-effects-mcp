#!/usr/bin/env node
// Fail-closed bundle freshness gate (#223). Dev installs deploy the committed
// plugin/client/dist tree verbatim, so deploying with edited panel sources and
// a stale bundle silently ships old panel code to a real After Effects — that
// is exactly how the 22c514a hostBridge fix reached a machine without its
// bundle. CI proves the same equivalence via rebuild + `git diff`; this gate
// covers the local deploy path that runs before CI ever sees the commit.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const panelRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(panelRoot, '..', '..');

let esbuild;
let buildOptions;
try {
  ({ buildOptions } = await import('./build-options.mjs'));
  esbuild = await import('esbuild');
} catch (error) {
  console.error(`verify-bundle: the panel build toolchain failed to load: ${error && error.message ? error.message : error}`);
  console.error('verify-bundle: run "npm ci" in plugin/panel first.');
  process.exit(2);
}

const result = await esbuild.build({ ...buildOptions(), write: false, logLevel: 'silent' });
const stale = [];
for (const output of result.outputFiles) {
  let committed = null;
  try {
    committed = readFileSync(output.path);
  } catch {
    // A missing output counts as stale: the build produces it, the tree lacks it.
  }
  if (committed === null || Buffer.compare(Buffer.from(output.contents), committed) !== 0) {
    stale.push(path.relative(repoRoot, output.path).replaceAll(path.sep, '/'));
  }
}

if (stale.length > 0) {
  console.error(`verify-bundle: plugin/client/dist is stale for: ${stale.join(', ')}`);
  console.error('verify-bundle: run "npm run build" in plugin/panel, commit the result, and retry.');
  process.exit(1);
}
console.log('verify-bundle: plugin/client/dist matches the panel sources.');
