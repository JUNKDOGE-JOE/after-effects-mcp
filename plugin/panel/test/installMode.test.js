import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPackagedEvidence, isDevelopmentInstall } from '../src/cep/installMode.js';

function adapterFor(id, hits) {
  return {
    id,
    paths: { join: (parts) => parts.join('/') },
    fs: { existsSync: (p) => hits.has(p) },
  };
}

test('a checkout with .debug and no packaged evidence is a development install', () => {
  const hits = new Set(['/ext/.debug']);
  assert.equal(isDevelopmentInstall({ extRoot: '/ext', adapter: adapterFor('windows-x64', hits) }), true);
});

test('a bare install without .debug is never development', () => {
  const hits = new Set(['/ext/bundle-manifest.json']);
  assert.equal(isDevelopmentInstall({ extRoot: '/ext', adapter: adapterFor('macos-arm64', hits) }), false);
  assert.equal(isDevelopmentInstall({ extRoot: '/ext', adapter: adapterFor('macos-arm64', new Set()) }), false);
});

test('the macOS bundle manifest defeats its mandatory .debug marker (#239)', () => {
  const hits = new Set(['/ext/.debug', '/ext/bundle-manifest.json']);
  assert.equal(isDevelopmentInstall({ extRoot: '/ext', adapter: adapterFor('macos-arm64', hits) }), false);
});

test('the relocated Windows host runtime defeats a hand-planted .debug', () => {
  const hits = new Set(['/ext/.debug', '/ext/runtime/windows-x64/node/host/package.json']);
  assert.equal(isDevelopmentInstall({ extRoot: '/ext', adapter: adapterFor('windows-x64', hits) }), false);
});

test('packaged evidence is either the bundle manifest or the host runtime payload', () => {
  const manifestOnly = new Set(['/ext/bundle-manifest.json']);
  const hostOnly = new Set(['/ext/runtime/windows-x64/node/host/package.json']);
  const neither = new Set();
  assert.equal(hasPackagedEvidence({ extRoot: '/ext', adapter: adapterFor('windows-x64', manifestOnly) }), true);
  assert.equal(hasPackagedEvidence({ extRoot: '/ext', adapter: adapterFor('windows-x64', hostOnly) }), true);
  assert.equal(hasPackagedEvidence({ extRoot: '/ext', adapter: adapterFor('windows-x64', neither) }), false);
});
