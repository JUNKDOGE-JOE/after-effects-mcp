import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalRuntimeEvidenceJson } from '../lib/runtime-evidence.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture(t) {
  const runtimeRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'ae-mcp-runtime-license-artifacts-'),
  );
  t.after(() => fs.promises.rm(runtimeRoot, { recursive: true, force: true }));
  return runtimeRoot;
}

function component({ name, licenseId, evidence }) {
  return {
    name,
    version: '1.0.0',
    license: licenseId,
    source: `https://example.invalid/${name}.tgz`,
    sha256: 'a'.repeat(64),
    licenseEvidence: evidence,
  };
}

test('writes canonical SPDX and license inventory from exact UTF-8 payload evidence', async (t) => {
  const { writeRuntimeLicenseArtifacts } = await import(
    '../lib/runtime-license-artifacts.mjs'
  );
  const runtimeRoot = await fixture(t);
  const bytes = Buffer.from('Reviewed fixture terms.\n', 'utf8');
  const evidencePath = 'licenses/reviewed/fixture.txt';
  await fs.promises.mkdir(path.join(runtimeRoot, 'licenses/reviewed'), { recursive: true });
  await fs.promises.writeFile(path.join(runtimeRoot, evidencePath), bytes);
  const components = [component({
    name: 'fixture',
    licenseId: 'LicenseRef-Fixture',
    evidence: [{ kind: 'payload-file', path: evidencePath, sha256: sha256(bytes) }],
  })];

  const result = await writeRuntimeLicenseArtifacts({
    runtimeRoot,
    platform: 'macos-arm64',
    components,
    licenseApprovals: [],
  });
  assert.deepEqual(result.extractedLicenses, [{
    licenseId: 'LicenseRef-Fixture',
    name: 'Fixture',
    extractedText: bytes.toString('utf8'),
    evidence: { path: evidencePath, sha256: sha256(bytes) },
  }]);
  assert.equal(
    await fs.promises.readFile(path.join(runtimeRoot, 'license-inventory.json'), 'utf8'),
    canonicalRuntimeEvidenceJson(result.licenseInventory),
  );
  assert.equal(
    await fs.promises.readFile(path.join(runtimeRoot, 'sbom.spdx.json'), 'utf8'),
    canonicalRuntimeEvidenceJson(result.sbom),
  );
});

test('rejects divergent textual candidates for one LicenseRef before writing artifacts', async (t) => {
  const { writeRuntimeLicenseArtifacts } = await import(
    '../lib/runtime-license-artifacts.mjs'
  );
  const runtimeRoot = await fixture(t);
  const candidates = [
    ['licenses/a.txt', Buffer.from('terms A\n')],
    ['licenses/b.txt', Buffer.from('terms B\n')],
  ];
  await fs.promises.mkdir(path.join(runtimeRoot, 'licenses'), { recursive: true });
  for (const [relative, bytes] of candidates) {
    await fs.promises.writeFile(path.join(runtimeRoot, relative), bytes);
  }
  const components = candidates.map(([relative, bytes], index) => component({
    name: `fixture-${index}`,
    licenseId: 'LicenseRef-Fixture',
    evidence: [{ kind: 'payload-file', path: relative, sha256: sha256(bytes) }],
  }));

  await assert.rejects(
    writeRuntimeLicenseArtifacts({
      runtimeRoot,
      platform: 'macos-arm64',
      components,
      licenseApprovals: [],
    }),
    /divergent textual evidence.*LicenseRef-Fixture/i,
  );
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'license-inventory.json')), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'sbom.spdx.json')), false);
});

test('rejects a LicenseRef backed only by binary payloads', async (t) => {
  const { writeRuntimeLicenseArtifacts } = await import(
    '../lib/runtime-license-artifacts.mjs'
  );
  const runtimeRoot = await fixture(t);
  const bytes = Buffer.from([0xff, 0xfe, 0xfd, 0x00]);
  const evidencePath = 'python/vcruntime140.dll';
  await fs.promises.mkdir(path.join(runtimeRoot, 'python'), { recursive: true });
  await fs.promises.writeFile(path.join(runtimeRoot, evidencePath), bytes);

  await assert.rejects(
    writeRuntimeLicenseArtifacts({
      runtimeRoot,
      platform: 'windows-x64',
      components: [component({
        name: 'vc-runtime',
        licenseId: 'LicenseRef-Microsoft-Visual-Cpp-Runtime',
        evidence: [{ kind: 'payload-file', path: evidencePath, sha256: sha256(bytes) }],
      })],
      licenseApprovals: [],
    }),
    /no reviewed UTF-8 textual evidence.*Microsoft-Visual-Cpp-Runtime/i,
  );
});

test('stages virtual reviewed text atomically and is deterministic on rerun', async (t) => {
  const { writeRuntimeLicenseArtifacts } = await import(
    '../lib/runtime-license-artifacts.mjs'
  );
  const runtimeRoot = await fixture(t);
  const bytes = Buffer.from('Node bundled license section.\n', 'utf8');
  const evidencePath = 'licenses/extracted/LicenseRef-Node-Bundle.txt';
  const components = [component({
    name: 'node-bundle',
    licenseId: 'LicenseRef-Node-Bundle',
    evidence: [{ kind: 'payload-file', path: evidencePath, sha256: sha256(bytes) }],
  })];
  const input = {
    runtimeRoot,
    platform: 'macos-arm64',
    components,
    licenseApprovals: [],
    virtualFiles: [{ path: evidencePath, bytes }],
  };

  const first = await writeRuntimeLicenseArtifacts(input);
  const second = await writeRuntimeLicenseArtifacts(input);

  assert.deepEqual(second, first);
  assert.deepEqual(await fs.promises.readFile(path.join(runtimeRoot, evidencePath)), bytes);
});
