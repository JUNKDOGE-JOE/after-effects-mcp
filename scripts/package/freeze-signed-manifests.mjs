import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { sha256Directory } from './lib/files.mjs';
import {
  collectManifestEntries,
  readCanonicalJsonFile,
  readJsonFile,
  sha256File,
  validateBundleManifest,
  writeCanonicalJson,
} from './lib/manifest.mjs';
import { verifyPlatformBundle } from './verify-platform-bundle.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
export async function freezeSignedManifests({
  root,
  platform,
  version,
  sourceCommitSha,
  sourceStageSha256,
} = {}) {
  if (!PLATFORMS.has(platform)) throw new Error('invalid signed manifest platform');
  if (!SHA256.test(sourceStageSha256 || '')) throw new Error('invalid source stage digest');
  const resolvedRoot = path.resolve(String(root ?? ''));
  if (root !== resolvedRoot) throw new Error('signed manifest root must be absolute');
  const bundleManifestPath = path.join(resolvedRoot, 'bundle-manifest.json');
  const sourceManifest = await readCanonicalJsonFile(bundleManifestPath);
  if (await sha256File(bundleManifestPath) !== sourceStageSha256) {
    throw new Error('source stage digest does not match the unsigned bundle manifest');
  }
  if (sourceManifest.platform !== platform || sourceManifest.version !== version
      || sourceManifest.sourceCommitSha !== sourceCommitSha) {
    throw new Error('unsigned bundle manifest identity mismatch');
  }

  const runtimeRoot = path.join(resolvedRoot, 'runtime', platform);
  const runtimeManifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  const sbomPath = path.join(runtimeRoot, 'sbom.spdx.json');
  const licenseInventoryPath = path.join(runtimeRoot, 'license-inventory.json');
  const finalManifest = validateBundleManifest({
    ...sourceManifest,
    runtime: {
      ...sourceManifest.runtime,
      manifestSha256: await sha256File(runtimeManifestPath),
      sbomSha256: await sha256File(sbomPath),
      licenseInventorySha256: await sha256File(licenseInventoryPath),
    },
    files: await collectManifestEntries(resolvedRoot, { omit: ['bundle-manifest.json'] }),
  });
  await writeCanonicalJson(bundleManifestPath, finalManifest);
  await verifyPlatformBundle({
    root: resolvedRoot,
    platform,
    version,
    sourceCommitSha,
    verificationProfile: 'release-audit',
  });
  return Object.freeze({
    sourceStageSha256,
    signedBundleManifestSha256: await sha256File(bundleManifestPath),
    finalRootSha256: await sha256Directory(resolvedRoot),
  });
}

export async function freezeSignedManifestsWithEvidence({ evidencePath, ...input } = {}) {
  const resolvedRoot = path.resolve(String(input.root ?? ''));
  const resolvedEvidencePath = path.resolve(String(evidencePath ?? ''));
  if (input.root !== resolvedRoot) throw new Error('signed manifest root must be absolute');
  if (evidencePath !== resolvedEvidencePath
      || path.basename(resolvedEvidencePath) !== 'freeze-evidence.json'
      || path.dirname(resolvedEvidencePath) !== path.dirname(resolvedRoot)) {
    throw new Error('freeze evidence must be the canonical sibling of the signing work root');
  }
  const inputSha256 = await sha256Directory(resolvedRoot);
  const frozen = await freezeSignedManifests(input);
  const outputSha256 = await sha256Directory(resolvedRoot);
  if (frozen.finalRootSha256 !== outputSha256) {
    throw new Error('signed manifest freeze root digest mismatch');
  }
  const evidence = Object.freeze({
    schemaVersion: 1,
    platform: input.platform,
    sourceStageSha256: input.sourceStageSha256,
    step: Object.freeze({
      id: 'freeze-signed-manifests',
      inputSha256,
      outputSha256,
      exitCode: 0,
    }),
  });
  await writeCanonicalJson(resolvedEvidencePath, evidence);
  return evidence;
}

function parseCli(argv) {
  const allowed = new Set([
    '--root',
    '--platform',
    '--version',
    '--source-commit-sha',
    '--source-stage-sha256',
    '--evidence',
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || values.has(name)) {
      throw new Error(`invalid freeze argument: ${String(name)}`);
    }
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  return values;
}

async function main(argv) {
  const options = parseCli(argv);
  await freezeSignedManifestsWithEvidence({
    root: path.resolve(options.get('--root')),
    platform: options.get('--platform'),
    version: options.get('--version'),
    sourceCommitSha: options.get('--source-commit-sha'),
    sourceStageSha256: options.get('--source-stage-sha256'),
    evidencePath: path.resolve(options.get('--evidence')),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`FREEZE_SIGNED_MANIFESTS_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
