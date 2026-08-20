import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
}

test('the bundled host keeps the exact Express dependency pin', () => {
  const manifest = readJson('plugin/host/package.json');
  const lock = readJson('plugin/host/package-lock.json');
  assert.equal(manifest.dependencies.express, '4.22.2');
  assert.equal(lock.packages[''].dependencies.express, '4.22.2');
  assert.equal(lock.packages['node_modules/express'].version, '4.22.2');
});

test('retired package roots and the old lockfile are absent', () => {
  for (const relative of ['packages', 'plugin/sidecar', 'packaging/runtime-lock.json']) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, relative)), false, relative);
  }
});
