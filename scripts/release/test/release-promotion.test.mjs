import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function text(relative) {
  return readFile(relative, 'utf8');
}

test('release workflow validates direct release evidence with pinned Node', async () => {
  const workflow = await text('.github/workflows/release.yml');
  assert.match(workflow, /actions\/setup-node/);
  assert.match(workflow, /node-version: 24\.17\.0/);
  assert.match(workflow, /scripts\/release\/test\/artifact-manifest\.test\.mjs/);
  assert.match(workflow, /scripts\/release\/test\/version-consistency\.test\.mjs/);
  assert.doesNotMatch(workflow, /python|uv|sidecar|runtime-license|build-portable-runtime/iu);
});

test('attestation and candidate workflows run direct contract tests only', async () => {
  const [attestation, buildRc] = await Promise.all([
    text('.github/workflows/attestation.yml'),
    text('.github/workflows/build-rc.yml'),
  ]);
  for (const workflow of [attestation, buildRc]) {
    assert.match(workflow, /actions\/setup-node/);
    assert.doesNotMatch(workflow, /python|uv|sidecar|runtime|helper/iu);
  }
  assert.match(buildRc, /verify-windows-zxp-stage\.test\.mjs/);
  assert.match(attestation, /validate-attestation-comment\.test\.mjs/);
});
