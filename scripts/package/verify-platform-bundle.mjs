import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertBinaryArchitecture, detectBinaryArchitectureFile } from './lib/binary-arch.mjs';
import {
  validateLicenseInventory,
  validateRuntimeSpdx,
  verifyExtractedLicenseEvidence,
} from './lib/runtime-evidence.mjs';
import { validateRuntimeManifest } from './lib/runtime-manifest.mjs';
import {
  NATIVE_PLUGIN_MANIFEST_PATH,
  PLATFORM_IDS,
  SHA256_PATTERN,
  assertPortableRelativePath,
  bundleError,
  canonicalJson,
  collectManifestEntries,
  comparePortableUtf8,
  readCanonicalJsonFile,
  readJsonFile,
  sha256File,
  validateBundleManifest,
} from './lib/manifest.mjs';
import {
  NATIVE_PLUGIN_ROOT,
  verifyNativePluginStage,
} from './lib/native-plugin-manifest.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADOBE_SDK_LOCKED_FILE_DIGESTS = new Set([
  'c6abccd52ae25936b819b78c4fea2858bd161f216f72f75184fe9ec55a49756e',
  'e02fa2b488c3cceb238866b648eb9a2526d308a260744367915a2f173663c36c',
  '3d3a39175a09d07f6f9734284636f9eadce968b05161650e3cba097a95905330',
  '640b513bfdfdab264057f3fce0356ced468cdb6d3bd3e2666e6743ec8be1fdba',
]);

function validateHelperManifest(value, platform) {
  const expectedTop = ['entrypoints', 'files', 'helperId', 'platform', 'schemaVersion'];
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedTop)
      || value.schemaVersion !== 1 || value.platform !== platform
      || value.helperId !== 'com.junkdoge.ae-mcp.platform-helper'
      || !value.entrypoints || typeof value.entrypoints.helper !== 'string'
      || typeof value.entrypoints.launcher !== 'string'
      || JSON.stringify(Object.keys(value.entrypoints).sort())
        !== JSON.stringify(['helper', 'launcher'])
      || value.entrypoints.helper === value.entrypoints.launcher
      || !Array.isArray(value.files) || value.files.length < 2) {
    throw bundleError('BUNDLE_HELPER_IDENTITY_INVALID', 'helper manifest identity is invalid');
  }
  const paths = new Set();
  for (const record of value.files) {
    assertPortableRelativePath(record?.path, 'BUNDLE_HELPER_IDENTITY_INVALID');
    if (JSON.stringify(Object.keys(record ?? {}).sort())
          !== JSON.stringify(['architecture', 'path', 'sha256'])
        || paths.has(record.path)
        || !['macho-arm64', 'pe-x64', 'script', 'data'].includes(record.architecture)
        || !SHA256_PATTERN.test(record.sha256 ?? '')) {
      throw bundleError('BUNDLE_HELPER_IDENTITY_INVALID', 'helper payload record is invalid');
    }
    paths.add(record.path);
  }
  if (!paths.has(value.entrypoints.helper) || !paths.has(value.entrypoints.launcher)) {
    throw bundleError('BUNDLE_HELPER_IDENTITY_INVALID', 'helper entrypoints are not declared payload files');
  }
  const records = new Map(value.files.map((record) => [record.path, record]));
  const nativeArchitecture = platform === 'macos-arm64' ? 'macho-arm64' : 'pe-x64';
  const helperArchitecture = records.get(value.entrypoints.helper)?.architecture;
  const launcherArchitecture = records.get(value.entrypoints.launcher)?.architecture;
  if (helperArchitecture !== nativeArchitecture
      || (platform === 'macos-arm64'
        ? !['macho-arm64', 'script'].includes(launcherArchitecture)
        : launcherArchitecture !== nativeArchitecture)) {
    throw bundleError('BUNDLE_HELPER_IDENTITY_INVALID', 'helper entrypoint architecture is invalid');
  }
  return value;
}

async function verifyEntry(expected, actual) {
  if (!actual || expected.type !== actual.type || expected.size !== actual.size
      || expected.mode !== actual.mode
      || (expected.type === 'symlink'
        && Object.hasOwn(expected, 'linkTarget')
        && expected.linkTarget !== actual.linkTarget)) {
    throw bundleError('BUNDLE_FILE_METADATA_MISMATCH', `bundle metadata mismatch: ${expected.path}`);
  }
  if (expected.sha256 !== actual.sha256) {
    throw bundleError('BUNDLE_HASH_MISMATCH', `bundle SHA-256 mismatch: ${expected.path}`);
  }
}

async function verifyRuntimeInventory(root, platform, runtimeManifest) {
  const runtimeRoot = path.join(root, 'runtime', platform);
  const actual = await collectManifestEntries(runtimeRoot, { omit: ['runtime-manifest.json'] });
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const expected = [...runtimeManifest.files].sort((left, right) => (
    comparePortableUtf8(left.path, right.path)
  ));
  const expectedPaths = new Set(expected.map((entry) => entry.path));
  if (expectedPaths.size !== expected.length
      || expected.length !== actual.length
      || expected.some((entry) => !actualByPath.has(entry.path))) {
    throw bundleError('BUNDLE_RUNTIME_MANIFEST_INVALID', 'runtime manifest file set does not match payload');
  }
  for (const entry of expected) await verifyEntry(entry, actualByPath.get(entry.path));
}

async function verifySupportContract(root, platform) {
  const support = await readJsonFile(
    path.join(root, 'metadata', 'support-matrix.json'),
    'BUNDLE_SUPPORT_MATRIX_INVALID',
  );
  const expected = {
    schemaVersion: 1,
    platforms: {
      'macos-arm64': { minOsVersion: '14.0', arch: 'arm64', rosetta: false },
      'windows-x64': { minOsVersion: '11.0.26100', arch: 'x64' },
    },
    afterEffects: { majors: [25, 26], manifestRange: '[25.0,26.9]' },
  };
  if (canonicalJson(support) !== canonicalJson(expected) || !support.platforms[platform]) {
    throw bundleError('BUNDLE_SUPPORT_MATRIX_INVALID', 'support matrix does not match the release contract');
  }
  const cep = await fs.promises.readFile(path.join(root, 'CSXS', 'manifest.xml'), 'utf8');
  const matches = [...cep.matchAll(/<Host\s+Name="AEFT"\s+Version="([^"]+)"\s*\/>/g)];
  if (matches.length !== 1 || matches[0][1] !== '[25.0,26.9]') {
    throw bundleError('BUNDLE_CEP_RANGE_INVALID', 'CEP manifest host range must be exactly [25.0,26.9]');
  }
}

async function verifyRuntimeEvidence(root, platform, runtimeManifest, bundleManifest) {
  const runtimeRoot = path.join(root, 'runtime', platform);
  const sbomPath = path.join(runtimeRoot, 'sbom.spdx.json');
  const licenseInventoryPath = path.join(runtimeRoot, 'license-inventory.json');
  if (await sha256File(sbomPath) !== bundleManifest.runtime.sbomSha256) {
    throw bundleError('BUNDLE_HASH_MISMATCH', 'runtime SPDX SBOM SHA-256 mismatch');
  }
  if (await sha256File(licenseInventoryPath)
      !== bundleManifest.runtime.licenseInventorySha256) {
    throw bundleError('BUNDLE_HASH_MISMATCH', 'runtime license inventory SHA-256 mismatch');
  }
  const licenseInventory = await readJsonFile(
    licenseInventoryPath,
    'BUNDLE_LICENSE_INVENTORY_INVALID',
  );
  validateLicenseInventory(licenseInventory, {
    platform,
    components: runtimeManifest.components,
    licenseApprovals: runtimeManifest.licenseApprovals,
    extractedLicenses: licenseInventory.extractedLicenses,
  });
  await verifyExtractedLicenseEvidence({
    runtimeRoot,
    components: runtimeManifest.components,
    extractedLicenses: licenseInventory.extractedLicenses,
    code: 'BUNDLE_LICENSE_INVENTORY_INVALID',
  });
  const sbom = await readJsonFile(
    sbomPath,
    'BUNDLE_SBOM_INVALID',
  );
  validateRuntimeSpdx(sbom, {
    platform,
    components: runtimeManifest.components,
    extractedLicenses: licenseInventory.extractedLicenses,
  });
}

async function verifyHostRuntime(root, platform, entries) {
  const relativeHostRoot = `runtime/${platform}/node/host`;
  const hostRoot = path.join(root, 'runtime', platform, 'node', 'host');
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const requireFile = (relative) => {
    const entry = entriesByPath.get(`${relativeHostRoot}/${relative}`);
    if (!entry || entry.type !== 'file') {
      throw bundleError(
        'BUNDLE_HOST_RUNTIME_INVALID',
        `required production host runtime file is missing: ${relative}`,
      );
    }
  };
  requireFile('package.json');
  requireFile('node_modules/express/package.json');

  const hostPackage = await readJsonFile(
    path.join(hostRoot, 'package.json'),
    'BUNDLE_HOST_RUNTIME_INVALID',
  );
  const expressPackage = await readJsonFile(
    path.join(hostRoot, 'node_modules', 'express', 'package.json'),
    'BUNDLE_HOST_RUNTIME_INVALID',
  );
  if (hostPackage.name !== 'ae-mcp-host'
      || typeof hostPackage.dependencies?.express !== 'string'
      || expressPackage.name !== 'express') {
    throw bundleError('BUNDLE_HOST_RUNTIME_INVALID', 'production host package identity is invalid');
  }
  const mainEntry = expressPackage.main === undefined ? 'index.js' : expressPackage.main;
  if (typeof mainEntry !== 'string' || !mainEntry.trim() || mainEntry.includes('\0')) {
    throw bundleError('BUNDLE_HOST_RUNTIME_INVALID', 'Express package main is invalid');
  }
  const expressRoot = path.join(hostRoot, 'node_modules', 'express');
  const resolvedEntry = path.resolve(expressRoot, mainEntry);
  const entryRelative = path.relative(expressRoot, resolvedEntry);
  if (!entryRelative || entryRelative.startsWith('..') || path.isAbsolute(entryRelative)) {
    throw bundleError('BUNDLE_HOST_RUNTIME_INVALID', 'Express package main escapes its package root');
  }
  requireFile(`node_modules/express/${entryRelative.split(path.sep).join('/')}`);
}

async function verifyHelper(root, platform, manifest) {
  const helperRoot = path.join(root, 'platform', platform);
  const helperManifestPath = path.join(helperRoot, 'helper-manifest.json');
  if (await sha256File(helperManifestPath) !== manifest.helper.manifestSha256) {
    throw bundleError('BUNDLE_HASH_MISMATCH', 'helper manifest SHA-256 mismatch');
  }
  const helper = validateHelperManifest(await readJsonFile(helperManifestPath), platform);
  const helperEntries = await collectManifestEntries(helperRoot);
  const helperEntriesByPath = new Map(helperEntries.map((entry) => [entry.path, entry]));
  const declared = new Set(['helper-manifest.json', ...helper.files.map((record) => record.path)]);
  if (helperEntries.length !== declared.size
      || helperEntries.some((entry) => !declared.has(entry.path))) {
    throw bundleError('BUNDLE_HELPER_IDENTITY_INVALID', 'helper payload contains undeclared files');
  }
  for (const record of helper.files) {
    if (helperEntriesByPath.get(record.path)?.type !== 'file') {
      throw bundleError(
        'BUNDLE_HELPER_IDENTITY_INVALID',
        `helper payload must be a regular file: ${record.path}`,
      );
    }
    const filePath = path.resolve(helperRoot, ...record.path.split('/'));
    const relative = path.relative(helperRoot, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw bundleError('BUNDLE_HELPER_IDENTITY_INVALID', 'helper file path escapes helper root');
    }
    if (await sha256File(filePath) !== record.sha256) {
      throw bundleError('BUNDLE_HASH_MISMATCH', `helper payload SHA-256 mismatch: ${record.path}`);
    }
    if (record.architecture === 'script') {
      const mode = (await fs.promises.stat(filePath)).mode & 0o111;
      if (!mode) throw bundleError('BUNDLE_EXECUTABLE_MODE_INVALID', `helper script is not executable: ${record.path}`);
    } else if (record.architecture !== 'data') {
      const expectedArchitecture = platform === 'macos-arm64' ? 'macho-arm64' : 'pe-x64';
      if (record.architecture !== expectedArchitecture) {
        throw bundleError('BUNDLE_ARCH_MISMATCH', `helper manifest architecture mismatch: ${record.path}`);
      }
      await assertBinaryArchitecture(filePath, platform, `helper:${record.path}`);
    }
  }
}

async function verifyNativeFiles(root, platform, entries) {
  const requiredPaths = platform === 'macos-arm64'
    ? [
      `runtime/${platform}/node/bin/node`,
      `runtime/${platform}/python/bin/python3.13`,
      `runtime/${platform}/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
    ]
    : [
      `runtime/${platform}/node/node.exe`,
      `runtime/${platform}/python/python.exe`,
      `runtime/${platform}/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`,
    ];
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const relative of requiredPaths) {
    const entry = entriesByPath.get(relative);
    if (!entry || entry.type !== 'file') {
      throw bundleError('BUNDLE_ARCH_MISMATCH', `required native runtime entrypoint is missing: ${relative}`);
    }
    await assertBinaryArchitecture(
      path.join(root, ...relative.split('/')),
      platform,
      relative,
    );
    if (platform === 'macos-arm64' && (Number.parseInt(entry.mode, 8) & 0o111) === 0) {
      throw bundleError('BUNDLE_EXECUTABLE_MODE_INVALID', `macOS executable mode is missing: ${relative}`);
    }
  }
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const absolute = path.join(root, ...entry.path.split('/'));
    const detected = await detectBinaryArchitectureFile(absolute);
    const nativeExtension = /\.(?:node|dylib|so|exe|dll|pyd)$/i.test(entry.path);
    if (detected) {
      const expected = platform === 'macos-arm64' ? 'macho-arm64' : 'pe-x64';
      if (detected !== expected) {
        throw bundleError(
          'BUNDLE_ARCH_MISMATCH',
          `native architecture mismatch for ${entry.path}: expected ${expected}, received ${detected}`,
        );
      }
      if (platform === 'macos-arm64'
          && /(^|\/)bin\//.test(entry.path)
          && (Number.parseInt(entry.mode, 8) & 0o111) === 0) {
        throw bundleError('BUNDLE_EXECUTABLE_MODE_INVALID', `macOS executable mode is missing: ${entry.path}`);
      }
    } else if (nativeExtension) {
      throw bundleError('BUNDLE_ARCH_MISMATCH', `unrecognized native payload: ${entry.path}`);
    }
  }
}

function assertProductionFileSet(entries, platform) {
  const forbidden = entries.find((entry) => (
    entry.path === '.debug'
    || entry.path === 'panel'
    || entry.path.startsWith('panel/')
    || (!entry.path.startsWith('runtime/') && /(^|\/)node_modules(?:\/|$)/.test(entry.path))
    || /(^|\/)(?:test|tests|__pycache__|\.cache)(?:\/|$)/.test(entry.path)
    || /(?:^|\.)test\.[^/]+$/i.test(path.posix.basename(entry.path))
  ));
  if (forbidden) throw bundleError('BUNDLE_DEVELOPMENT_FILE', `development file is forbidden: ${forbidden.path}`);
  const foreign = platform === 'macos-arm64'
    ? /(?:win32|windows-x64|linux-|darwin-x64)/i
    : /(?:darwin-|macos-|linux-|win32-arm64)/i;
  const foreignEntry = entries.find((entry) => foreign.test(entry.path));
  if (foreignEntry) throw bundleError('BUNDLE_FOREIGN_PLATFORM', `foreign platform payload: ${foreignEntry.path}`);
  const adobeSdkMaterial = entries.find((entry) => (
    ADOBE_SDK_LOCKED_FILE_DIGESTS.has(entry.sha256)
    || /(?:^|\/)(?:AfterEffectsSDK[^/]*|ae[0-9._]+\.AfterEffectsSDK)(?:\/|$)/iu.test(entry.path)
    || /(?:^|\/)Examples(?:\/|$)/u.test(entry.path)
    || /(?:^|\/)(?:AE_GeneralPlug(?:Old)?|AE_IO|AEGP_SuiteHandler|SPBasic)\.h$/iu.test(entry.path)
    || /(?:^|\/)AE_General\.r$/iu.test(entry.path)
    || /(?:^|\/)(?:PiPLtool|AdobePIPL)(?:\.exe)?$/iu.test(entry.path)
    || /(?:^|\/)(?:documentation|after.?effects[^/]*sdk[^/]*)\.pdf$/iu.test(entry.path)
    || /(?:^|\/)ae-sdk-(?:extract|unpack)[^/]*$/iu.test(entry.path)
  ));
  if (adobeSdkMaterial) {
    throw bundleError(
      'BUNDLE_ADOBE_SDK_MATERIAL_FORBIDDEN',
      `Adobe SDK material is forbidden in the staged product: ${adobeSdkMaterial.path}`,
    );
  }
}

export async function verifyPlatformBundle({
  root,
  platform,
  version,
  sourceCommitSha,
  candidateRepoRoot = REPO_ROOT,
  dependencies = {},
} = {}) {
  if (!PLATFORM_IDS.has(platform)) throw bundleError('BUNDLE_PLATFORM_INVALID', `unsupported platform: ${platform}`);
  const resolvedRoot = path.resolve(String(root ?? ''));
  const manifestPath = path.join(resolvedRoot, 'bundle-manifest.json');
  const manifest = validateBundleManifest(await readCanonicalJsonFile(manifestPath));
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
  for (const entry of manifest.files) await verifyEntry(entry, actualByPath.get(entry.path));
  const nativeNamespace = path.posix.dirname(NATIVE_PLUGIN_ROOT);
  const nativeNamespaceEntries = actual.filter((entry) => (
    entry.path === nativeNamespace
    || entry.path.startsWith(`${nativeNamespace}/`)
  ));
  if (!manifest.nativePlugin && nativeNamespaceEntries.length > 0) {
    throw bundleError(
      'BUNDLE_NATIVE_PLUGIN_REFERENCE_MISSING',
      'native plug-in payload exists without a top-level manifest reference',
    );
  }
  if (manifest.nativePlugin) {
    const unexpectedNativeEntry = nativeNamespaceEntries.find((entry) => (
      entry.path !== NATIVE_PLUGIN_ROOT
      && !entry.path.startsWith(`${NATIVE_PLUGIN_ROOT}/`)
    ));
    if (unexpectedNativeEntry) {
      throw bundleError(
        'BUNDLE_NATIVE_PLUGIN_FILE_SET_MISMATCH',
        `unexpected native plug-in namespace entry: ${unexpectedNativeEntry.path}`,
      );
    }
    const nativeManifestEntry = actualByPath.get(NATIVE_PLUGIN_MANIFEST_PATH);
    if (!nativeManifestEntry
        || nativeManifestEntry.type !== 'file'
        || nativeManifestEntry.sha256 !== manifest.nativePlugin.manifestSha256) {
      throw bundleError(
        'BUNDLE_NATIVE_PLUGIN_HASH_MISMATCH',
        'native plug-in manifest reference does not match the staged file',
      );
    }
    await verifyNativePluginStage({
      root: path.join(resolvedRoot, ...NATIVE_PLUGIN_ROOT.split('/')),
      productVersion: manifest.version,
      sourceCommitSha: manifest.sourceCommitSha,
      candidateRepoRoot,
      dependencies,
    });
  }

  const runtimeManifestPath = path.join(resolvedRoot, 'runtime', platform, 'runtime-manifest.json');
  if (await sha256File(runtimeManifestPath) !== manifest.runtime.manifestSha256) {
    throw bundleError('BUNDLE_HASH_MISMATCH', 'runtime manifest SHA-256 mismatch');
  }
  const runtimeManifest = validateRuntimeManifest(await readJsonFile(runtimeManifestPath), platform);
  await verifyRuntimeInventory(resolvedRoot, platform, runtimeManifest);
  await verifyRuntimeEvidence(resolvedRoot, platform, runtimeManifest, manifest);
  await verifyHostRuntime(resolvedRoot, platform, actual);
  await verifySupportContract(resolvedRoot, platform);
  await verifyHelper(resolvedRoot, platform, manifest);
  assertProductionFileSet(actual, platform);
  await verifyNativeFiles(resolvedRoot, platform, actual);
  return manifest;
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(['--root', '--platform', '--version']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const equal = item.indexOf('=');
    const key = equal === -1 ? item : item.slice(0, equal);
    const value = equal === -1 ? argv[++index] : item.slice(equal + 1);
    if (!allowed.has(key) || !value || values.has(key)) throw new Error(`invalid argument: ${item}`);
    values.set(key, value);
  }
  for (const key of allowed) if (!values.has(key)) throw new Error(`${key} is required`);
  return { root: values.get('--root'), platform: values.get('--platform'), version: values.get('--version') };
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
