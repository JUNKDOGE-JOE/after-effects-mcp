import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArtifactManifest,
  serializeArtifactManifest,
  validateArtifactManifestStructure,
  verifyArtifactManifest,
} from '../artifact-manifest.mjs';
import { makeArtifactManifestFixture } from './helpers/artifact-manifest-fixture.mjs';

test('artifact manifest binds direct ZXP/DMG outputs and dual-platform evidence', async (t) => {
  const fixture = await makeArtifactManifestFixture(t);
  const manifest = await buildArtifactManifest({
    version: '0.10.1',
    candidateSha: fixture.candidateSha,
    workflowRunId: '42',
    artifacts: fixture.artifacts,
    productAcceptanceEvidencePath: fixture.productAcceptanceEvidencePath,
    evidence: fixture.evidence,
  });

  assert.deepEqual(validateArtifactManifestStructure(manifest), []);
  assert.doesNotThrow(() => serializeArtifactManifest(manifest));
  assert.deepEqual(await verifyArtifactManifest(manifest, fixture.root), []);
  assert.deepEqual(
    manifest.artifacts.map((item) => item.role),
    ['dmg', 'zxp', 'zxp'],
  );
});

test('artifact manifest rejects an unsupported artifact role and malformed evidence', async (t) => {
  const fixture = await makeArtifactManifestFixture(t);
  const manifest = await buildArtifactManifest({
    version: '0.10.1',
    candidateSha: fixture.candidateSha,
    workflowRunId: '42',
    artifacts: fixture.artifacts,
    productAcceptanceEvidencePath: fixture.productAcceptanceEvidencePath,
    evidence: fixture.evidence,
  });
  manifest.artifacts[0].role = 'native-plugin';
  assert.notDeepEqual(validateArtifactManifestStructure(manifest), []);

  const broken = { ...manifest, evidence: manifest.evidence.slice(1) };
  assert.notDeepEqual(validateArtifactManifestStructure(broken), []);
});
