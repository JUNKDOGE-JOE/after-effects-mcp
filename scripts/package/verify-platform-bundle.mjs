import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  NATIVE_PLUGIN_MANIFEST_PATH,
  PLATFORM_IDS,
  bundleError,
  collectManifestEntries,
  readCanonicalJsonFile,
  readJsonFile,
  validateBundleManifest,
} from './lib/manifest.mjs';
import { NATIVE_PLUGIN_ROOT, verifyNativePluginStage } from './lib/native-plugin-manifest.mjs';
import {
  DEVELOPMENT_IDENTITY_PROFILE,
  normalizeIdentityVerificationProfile,
  requiresExactIdentity,
} from './lib/identity-verification-profile.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAYLOAD_ROOTS = new Set(['CSXS', 'client', 'host', 'icons', 'jsx', 'metadata', 'shared']);
const FORBIDDEN_ROOTS = new Set(['bin', 'helper', 'panel', 'platform', 'runtime', 'sidecar']);

async function verifyEntry(expected, actual, exactIdentity) {
  if (!actual || expected.type !== actual.type || expected.size !== actual.size
      || expected.mode !== actual.mode
      || (expected.type === 'symlink' && expected.linkTarget !== actual.linkTarget)) {
    throw bundleError('BUNDLE_FILE_METADATA_MISMATCH', `bundle metadata mismatch: ${expected.path}`);
  }
  if (exactIdentity && expected.sha256 !== actual.sha256) {
    throw bundleError('BUNDLE_HASH_MISMATCH', `bundle SHA-256 mismatch: ${expected.path}`);
  }
}

function assertProductionFileSet(entries) {
  for (const entry of entries) {
    const root = entry.path.split('/')[0];
    if (FORBIDDEN_ROOTS.has(root)) {
      throw bundleError('BUNDLE_RETIRED_PAYLOAD', `retired payload root is forbidden: ${entry.path}`);
    }
    if (!PAYLOAD_ROOTS.has(root) && root !== 'artifacts') {
      throw bundleError('BUNDLE_UNEXPECTED_ROOT', `unexpected staged root: ${entry.path}`);
    }
    if (/(?:\.dll|\.dylib|\.node|\.pyd|\.so|\.exe)$/i.test(entry.path)
        && !entry.path.startsWith(`${NATIVE_PLUGIN_ROOT}/`)) {
      throw bundleError(
        'BUNDLE_NATIVE_PAYLOAD_FORBIDDEN',
        `nested native payload is forbidden: ${entry.path}`,
      );
    }
    if (/(?:^|\/)(?:test|tests|__pycache__|\.cache)(?:\/|$)/.test(entry.path)
        || /(?:^|\.)test\.[^/]+$/i.test(path.posix.basename(entry.path))) {
      throw bundleError('BUNDLE_DEVELOPMENT_FILE', `development file is forbidden: ${entry.path}`);
    }
  }
}

async function verifyHostContract(root, entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const relative of [
    'host/package.json',
    'host/package-lock.json',
    'host/node_modules/express/package.json',
    'host/stdio-shim.js',
  ]) {
    if (byPath.get(relative)?.type !== 'file') {
      throw bundleError('BUNDLE_HOST_CONTRACT_INVALID', `required host file is missing: ${relative}`);
    }
  }
  const hostPackage = await readJsonFile(path.join(root, 'host', 'package.json'));
  const expressPackage = await readJsonFile(
    path.join(root, 'host', 'node_modules', 'express', 'package.json'),
  );
  if (hostPackage.name !== 'ae-mcp-host'
      || hostPackage.dependencies?.express !== '4.22.2'
      || expressPackage.name !== 'express'
      || expressPackage.version !== '4.22.2') {
    throw bundleError('BUNDLE_HOST_CONTRACT_INVALID', 'host Express contract is not pinned to 4.22.2');
  }
  const cep = await fs.promises.readFile(path.join(root, 'CSXS', 'manifest.xml'), 'utf8');
  if (!/<Host\s+Name="AEFT"\s+Version="\[23\.0,26\.9\]"\s*\/>/.test(cep)) {
    throw bundleError('BUNDLE_CEP_RANGE_INVALID', 'CEP host range must be exactly [23.0,26.9]');
  }
}

export async function verifyPlatformBundle({
  root,
  platform,
  version,
  sourceCommitSha,
  verificationProfile = DEVELOPMENT_IDENTITY_PROFILE,
  candidateRepoRoot,
  dependencies = {},
} = {}) {
  const profile = normalizeIdentityVerificationProfile(verificationProfile);
  const exactIdentity = requiresExactIdentity(profile);
  if (!PLATFORM_IDS.has(platform)) {
    throw bundleError('BUNDLE_PLATFORM_INVALID', `unsupported platform: ${platform}`);
  }
  const resolvedRoot = path.resolve(String(root ?? ''));
  const manifest = validateBundleManifest(
    await readCanonicalJsonFile(path.join(resolvedRoot, 'bundle-manifest.json')),
  );
  if (manifest.platform !== platform) {
    throw bundleError('BUNDLE_PLATFORM_MISMATCH', `expected ${platform}, received ${manifest.platform}`);
  }
  if (manifest.version !== version) {
    throw bundleError('BUNDLE_VERSION_MISMATCH', `expected ${version}, received ${manifest.version}`);
  }
  if (sourceCommitSha !== undefined && manifest.sourceCommitSha !== sourceCommitSha) {
    throw bundleError('BUNDLE_SOURCE_COMMIT_MISMATCH', 'bundle source commit does not match candidate');
  }
  const actual = await collectManifestEntries(resolvedRoot, { omit: ['bundle-manifest.json'] });
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  if (manifest.files.length !== actual.length
      || manifest.files.some((entry) => !actualByPath.has(entry.path))) {
    throw bundleError('BUNDLE_FILE_SET_MISMATCH', 'bundle file set does not match manifest');
  }
  for (const entry of manifest.files) await verifyEntry(entry, actualByPath.get(entry.path), exactIdentity);
  assertProductionFileSet(actual);
  await verifyHostContract(resolvedRoot, actual);

  const nativeEntries = actual.filter((entry) => (
    entry.path === NATIVE_PLUGIN_ROOT || entry.path.startsWith(`${NATIVE_PLUGIN_ROOT}/`)
  ));
  if (!manifest.nativePlugin && nativeEntries.length > 0) {
    throw bundleError('BUNDLE_NATIVE_PLUGIN_REFERENCE_MISSING', 'native plug-in lacks a manifest reference');
  }
  if (manifest.nativePlugin) {
    const nativeManifestEntry = actualByPath.get(NATIVE_PLUGIN_MANIFEST_PATH);
    if (!nativeManifestEntry || nativeManifestEntry.type !== 'file'
        || (exactIdentity && nativeManifestEntry.sha256 !== manifest.nativePlugin.manifestSha256)) {
      throw bundleError('BUNDLE_NATIVE_PLUGIN_HASH_MISMATCH', 'native plug-in manifest hash mismatch');
    }
    await verifyNativePluginStage({
      root: path.join(resolvedRoot, ...NATIVE_PLUGIN_ROOT.split('/')),
      productVersion: manifest.version,
      sourceCommitSha: manifest.sourceCommitSha,
      verificationProfile: profile,
      candidateRepoRoot: candidateRepoRoot ?? REPO_ROOT,
      dependencies,
    });
  }
  return manifest;
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(['--root', '--platform', '--profile', '--version']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const equal = item.indexOf('=');
    const key = equal === -1 ? item : item.slice(0, equal);
    const value = equal === -1 ? argv[++index] : item.slice(equal + 1);
    if (!allowed.has(key) || !value || values.has(key)) throw new Error(`invalid argument: ${item}`);
    values.set(key, value);
  }
  for (const key of ['--root', '--platform', '--version']) {
    if (!values.has(key)) throw new Error(`${key} is required`);
  }
  return {
    root: values.get('--root'),
    platform: values.get('--platform'),
    version: values.get('--version'),
    verificationProfile: values.get('--profile') ?? DEVELOPMENT_IDENTITY_PROFILE,
  };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  await verifyPlatformBundle({
    ...input,
    sourceCommitSha: process.env.AE_MCP_SOURCE_COMMIT_SHA || undefined,
  });
  process.stdout.write(`bundle verified: ${input.platform} ${input.version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs as parseVerifyPlatformBundleArgs };
