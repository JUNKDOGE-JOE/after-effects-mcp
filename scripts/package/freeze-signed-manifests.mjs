import fs from 'node:fs';
import path from 'node:path';

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

function resolvePayloadFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')) {
    throw new Error('helper manifest contains an invalid payload path');
  }
  const absolute = path.resolve(root, ...relative.split('/'));
  const remainder = path.relative(root, absolute);
  if (remainder.startsWith('..') || path.isAbsolute(remainder)) {
    throw new Error('helper manifest payload escapes the helper root');
  }
  return absolute;
}

async function freezeHelperManifest(root, platform) {
  const helperRoot = path.join(root, 'platform', platform);
  const helperManifestPath = path.join(helperRoot, 'helper-manifest.json');
  const helper = await readJsonFile(helperManifestPath, 'BUNDLE_HELPER_IDENTITY_INVALID');
  if (!Array.isArray(helper.files) || helper.platform !== platform) {
    throw new Error('signed helper manifest identity mismatch');
  }
  const files = [];
  for (const record of helper.files) {
    const absolute = resolvePayloadFile(helperRoot, record?.path);
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`signed helper payload is not one regular file: ${String(record?.path)}`);
    }
    files.push({
      path: record.path,
      architecture: record.architecture,
      sha256: await sha256File(absolute),
    });
  }
  await writeCanonicalJson(helperManifestPath, { ...helper, files });
  return sha256File(helperManifestPath);
}

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

  const helperManifestSha256 = await freezeHelperManifest(resolvedRoot, platform);
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
    helper: {
      ...sourceManifest.helper,
      manifestSha256: helperManifestSha256,
    },
    files: await collectManifestEntries(resolvedRoot, { omit: ['bundle-manifest.json'] }),
  });
  await writeCanonicalJson(bundleManifestPath, finalManifest);
  await verifyPlatformBundle({
    root: resolvedRoot,
    platform,
    version,
    sourceCommitSha,
  });
  return Object.freeze({
    sourceStageSha256,
    signedBundleManifestSha256: await sha256File(bundleManifestPath),
    finalRootSha256: await sha256Directory(resolvedRoot),
  });
}
