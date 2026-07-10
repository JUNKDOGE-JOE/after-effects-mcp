import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildLicenseInventory,
  buildRuntimeSpdx,
  validateLicenseInventory,
  validateRuntimeSpdx,
  verifyExtractedLicenseEvidence,
} from '../lib/runtime-evidence.mjs';

const platform = 'macos-arm64';
const components = [{
  name: 'fixture-component',
  version: '1.2.3',
  license: 'MIT',
  source: 'workspace:fixture',
  sha256: 'a'.repeat(64),
  relationship: 'CONTAINS',
  disposition: 'payload',
  licenseEvidence: [{
    kind: 'payload-file',
    path: 'licenses/fixture.txt',
    sha256: 'b'.repeat(64),
  }],
}];
const licenseApprovals = [{
  package: 'fixture-component',
  version: '1.2.3',
  sourceSha256: 'a'.repeat(64),
  licenseRef: 'LicenseRef-Fixture',
  approvalId: 'LEGAL-1',
}];

test('runtime evidence builders produce exact deterministic projections', () => {
  const licenses = buildLicenseInventory({ platform, components, licenseApprovals });
  assert.deepEqual(licenses, {
    schemaVersion: 1,
    platform,
    components,
    licenseApprovals,
    extractedLicenses: [],
  });
  const sbom = buildRuntimeSpdx({ platform, components });
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.creationInfo.created, '1970-01-01T00:00:00.000Z');
  assert.match(
    sbom.documentNamespace,
    /^https:\/\/github\.com\/JUNKDOGE-JOE\/after-effects-mcp\/spdx\/runtime\/macos-arm64\/[a-f0-9]{64}$/,
  );
  assert.deepEqual(sbom.packages[0], {
    SPDXID: 'SPDXRef-Package-000001',
    checksums: [{ algorithm: 'SHA256', checksumValue: 'a'.repeat(64) }],
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'MIT',
    licenseDeclared: 'MIT',
    name: 'fixture-component',
    sourceInfo: 'workspace:fixture',
    versionInfo: '1.2.3',
  });
  assert.deepEqual(sbom.hasExtractedLicensingInfos, []);
  assert.doesNotThrow(() => validateLicenseInventory(licenses, {
    platform, components, licenseApprovals,
  }));
  assert.doesNotThrow(() => validateRuntimeSpdx(sbom, { platform, components }));
});

test('LicenseRef evidence is complete, one-to-one, and backed by exact staged text', async (t) => {
  const runtimeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-license-evidence-'));
  t.after(() => fs.promises.rm(runtimeRoot, { recursive: true, force: true }));
  const extractedText = 'Fixture reviewed license text.\n';
  const evidencePath = 'licenses/LicenseRef-Fixture.txt';
  await fs.promises.mkdir(path.dirname(path.join(runtimeRoot, evidencePath)), { recursive: true });
  await fs.promises.writeFile(path.join(runtimeRoot, evidencePath), extractedText, 'utf8');
  const extractedLicenses = [{
    licenseId: 'LicenseRef-Fixture',
    name: 'Fixture reviewed license',
    extractedText,
    evidence: {
      path: evidencePath,
      sha256: createHash('sha256').update(extractedText, 'utf8').digest('hex'),
    },
  }];
  const refComponents = [{
    ...components[0],
    license: 'MIT OR LicenseRef-Fixture',
    licenseEvidence: [{
      kind: 'payload-file',
      path: evidencePath,
      sha256: extractedLicenses[0].evidence.sha256,
    }],
  }];

  const licenses = buildLicenseInventory({
    platform,
    components: refComponents,
    licenseApprovals,
    extractedLicenses,
  });
  const sbom = buildRuntimeSpdx({ platform, components: refComponents, extractedLicenses });
  assert.deepEqual(licenses.extractedLicenses, extractedLicenses);
  assert.deepEqual(sbom.hasExtractedLicensingInfos, [{
    licenseId: 'LicenseRef-Fixture',
    extractedText,
    name: 'Fixture reviewed license',
    comment: `Reviewed runtime evidence: ${evidencePath} (SHA-256: ${extractedLicenses[0].evidence.sha256})`,
  }]);
  await assert.doesNotReject(verifyExtractedLicenseEvidence({
    runtimeRoot,
    components: refComponents,
    extractedLicenses,
  }));

  assert.throws(
    () => buildRuntimeSpdx({ platform, components: refComponents, extractedLicenses: [] }),
    { code: 'RUNTIME_EVIDENCE_INVALID' },
  );
  assert.throws(
    () => buildRuntimeSpdx({
      platform,
      components: [{
        ...refComponents[0],
        licenseEvidence: [{
          kind: 'payload-file',
          path: 'licenses/unreviewed.txt',
          sha256: extractedLicenses[0].evidence.sha256,
        }],
      }],
      extractedLicenses,
    }),
    { code: 'RUNTIME_EVIDENCE_INVALID' },
  );
  assert.throws(
    () => buildRuntimeSpdx({
      platform,
      components: refComponents,
      extractedLicenses: [...extractedLicenses, {
        ...extractedLicenses[0],
        licenseId: 'LicenseRef-Unused',
      }],
    }),
    { code: 'RUNTIME_EVIDENCE_INVALID' },
  );

  await fs.promises.writeFile(path.join(runtimeRoot, evidencePath), 'forged text\n', 'utf8');
  await assert.rejects(
    verifyExtractedLicenseEvidence({ runtimeRoot, components: refComponents, extractedLicenses }),
    { code: 'RUNTIME_LICENSE_EVIDENCE_INVALID' },
  );
});

test('license inventory rejects component, approval, order, and extra-field drift', () => {
  const baseline = buildLicenseInventory({ platform, components, licenseApprovals });
  for (const mutate of [
    (value) => { value.platform = 'windows-x64'; },
    (value) => { value.components[0].license = 'Apache-2.0'; },
    (value) => { value.licenseApprovals[0].approvalId = 'FORGED'; },
    (value) => { value.unreviewed = true; },
  ]) {
    const value = structuredClone(baseline);
    mutate(value);
    assert.throws(
      () => validateLicenseInventory(value, { platform, components, licenseApprovals }),
      { code: 'BUNDLE_LICENSE_INVENTORY_INVALID' },
    );
  }
});

test('SPDX evidence rejects identity, package, checksum, relationship, and extra-field drift', () => {
  const baseline = buildRuntimeSpdx({ platform, components });
  for (const mutate of [
    (value) => { value.name = 'ae-mcp-runtime-windows-x64'; },
    (value) => { value.creationInfo.created = new Date().toISOString(); },
    (value) => { value.packages[0].versionInfo = '9.9.9'; },
    (value) => { value.packages[0].checksums[0].checksumValue = 'f'.repeat(64); },
    (value) => { value.relationships[0].relationshipType = 'CONTAINS'; },
    (value) => { value.unreviewed = true; },
  ]) {
    const value = structuredClone(baseline);
    mutate(value);
    assert.throws(
      () => validateRuntimeSpdx(value, { platform, components }),
      { code: 'BUNDLE_SBOM_INVALID' },
    );
  }
});
