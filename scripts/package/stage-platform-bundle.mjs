import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PLATFORM_IDS,
  SEMVER_PATTERN,
  SOURCE_SHA_PATTERN,
  assertPortableRelativePath,
  bundleError,
  collectManifestEntries,
  copyTree,
  readJsonFile,
  sha256File,
  validateBundleManifest,
  writeCanonicalJson,
} from './lib/manifest.mjs';
import { validateRuntimeManifest } from './lib/runtime-manifest.mjs';
import { verifyPlatformBundle } from './verify-platform-bundle.mjs';

const execFileAsync = promisify(execFile);

function pluginFilter(relative) {
  const segments = relative.split('/');
  const basename = segments.at(-1);
  if (relative === '.debug' || segments[0] === 'panel') return false;
  if (segments.some((segment) => ['node_modules', 'test', 'tests', '__pycache__', '.cache'].includes(segment))) return false;
  if (/(?:^|\.)test\.[^/]+$/i.test(basename) || basename === '.gitignore' || basename === '.DS_Store') return false;
  return true;
}

async function requiredDirectory(directory, label) {
  try {
    const stats = await fs.promises.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('not a directory');
  } catch (error) {
    throw bundleError('BUNDLE_INPUT_MISSING', `required ${label} directory is missing: ${directory}`);
  }
}

async function requiredFile(filePath, label) {
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new Error('not a regular file');
    }
  } catch (error) {
    throw bundleError('BUNDLE_INPUT_MISSING', `required ${label} file is missing: ${filePath}`);
  }
}

function validateHelperInput(value, platform) {
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
    throw bundleError('BUNDLE_HELPER_IDENTITY_INVALID', 'helper input manifest is invalid');
  }
  const paths = new Set();
  for (const record of value.files) {
    assertPortableRelativePath(record?.path, 'BUNDLE_HELPER_IDENTITY_INVALID');
    if (JSON.stringify(Object.keys(record ?? {}).sort())
          !== JSON.stringify(['architecture', 'path', 'sha256'])
        || paths.has(record.path)
        || !['macho-arm64', 'pe-x64', 'script', 'data'].includes(record.architecture)
        || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) {
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

async function copyHelperPayload(sourceRoot, destinationRoot, manifest) {
  await fs.promises.mkdir(destinationRoot, { recursive: true });
  const sourceManifest = path.join(sourceRoot, 'helper-manifest.json');
  await fs.promises.copyFile(
    sourceManifest,
    path.join(destinationRoot, 'helper-manifest.json'),
    fs.constants.COPYFILE_EXCL,
  );
  for (const record of manifest.files) {
    const source = path.join(sourceRoot, ...record.path.split('/'));
    const destination = path.join(destinationRoot, ...record.path.split('/'));
    const stats = await fs.promises.lstat(source).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink()) {
      throw bundleError('BUNDLE_INPUT_MISSING', `declared helper payload is missing: ${record.path}`);
    }
    if (stats.nlink !== 1) {
      throw bundleError(
        'BUNDLE_HARDLINK_FORBIDDEN',
        `hard-linked helper payload is forbidden: ${record.path}`,
      );
    }
    if (await sha256File(source) !== record.sha256) {
      throw bundleError('BUNDLE_HASH_MISMATCH', `helper input SHA-256 mismatch: ${record.path}`);
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') await fs.promises.chmod(destination, stats.mode & 0o777);
  }
}

async function makeTemporarySibling(destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  return fs.promises.mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.tmp-`));
}

export async function stagePlatformBundle({
  platform,
  version,
  outDir,
  repoRoot,
  sourceCommitSha,
  inputs = {},
} = {}) {
  if (!PLATFORM_IDS.has(platform)) throw bundleError('BUNDLE_PLATFORM_INVALID', `unsupported platform: ${platform}`);
  if (!SEMVER_PATTERN.test(version ?? '')) throw bundleError('BUNDLE_VERSION_INVALID', `invalid semver: ${version}`);
  if (!SOURCE_SHA_PATTERN.test(sourceCommitSha ?? '')) {
    throw bundleError('INVALID_SOURCE_COMMIT_SHA', 'source commit SHA must be 40 lowercase hexadecimal characters');
  }
  const resolvedRepoRoot = path.resolve(String(repoRoot ?? ''));
  const destination = path.resolve(String(outDir ?? ''));
  try {
    await fs.promises.lstat(destination);
    throw bundleError('BUNDLE_OUTPUT_EXISTS', `bundle output already exists: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const pluginRoot = path.resolve(inputs.pluginRoot ?? path.join(resolvedRepoRoot, 'plugin'));
  const runtimeRoot = path.resolve(inputs.runtimeRoot ?? path.join(resolvedRepoRoot, 'build', 'runtime', platform));
  const helperRoot = path.resolve(inputs.helperRoot ?? path.join(resolvedRepoRoot, 'build', 'helper', platform));
  const toolsRoot = path.resolve(inputs.bundledToolsRoot
    ?? path.join(resolvedRepoRoot, 'packages', 'core', 'ae_mcp', 'skills_bundled'));
  const supportMatrixPath = path.resolve(inputs.supportMatrixPath
    ?? path.join(resolvedRepoRoot, 'packaging', 'support-matrix.json'));
  await requiredDirectory(pluginRoot, 'plugin');
  await requiredDirectory(runtimeRoot, 'runtime');
  await requiredDirectory(helperRoot, 'helper');
  await requiredDirectory(toolsRoot, 'bundled tools');
  await requiredFile(supportMatrixPath, 'support matrix');
  for (const [file, label] of [
    [path.join(runtimeRoot, 'runtime-manifest.json'), 'runtime manifest'],
    [path.join(runtimeRoot, 'sbom.spdx.json'), 'SPDX SBOM'],
    [path.join(runtimeRoot, 'license-inventory.json'), 'license inventory'],
    [path.join(helperRoot, 'helper-manifest.json'), 'helper manifest'],
  ]) await requiredFile(file, label);

  const runtimeManifest = await readJsonFile(path.join(runtimeRoot, 'runtime-manifest.json'));
  validateRuntimeManifest(runtimeManifest, platform);
  const helperManifest = validateHelperInput(
    await readJsonFile(path.join(helperRoot, 'helper-manifest.json')),
    platform,
  );

  const temporary = await makeTemporarySibling(destination);
  try {
    await copyTree(pluginRoot, temporary, { filter: pluginFilter });
    await copyTree(runtimeRoot, path.join(temporary, 'runtime', platform));
    await copyHelperPayload(helperRoot, path.join(temporary, 'platform', platform), helperManifest);
    await copyTree(toolsRoot, path.join(temporary, 'bundled-tools'));
    await fs.promises.mkdir(path.join(temporary, 'metadata'), { recursive: true });
    await fs.promises.copyFile(
      supportMatrixPath,
      path.join(temporary, 'metadata', 'support-matrix.json'),
      fs.constants.COPYFILE_EXCL,
    );
    const runtimeManifestPath = path.join(temporary, 'runtime', platform, 'runtime-manifest.json');
    const runtimeSbomPath = path.join(temporary, 'runtime', platform, 'sbom.spdx.json');
    const licenseInventoryPath = path.join(
      temporary,
      'runtime',
      platform,
      'license-inventory.json',
    );
    const helperManifestPath = path.join(temporary, 'platform', platform, 'helper-manifest.json');
    const manifest = validateBundleManifest({
      schemaVersion: 1,
      version,
      platform,
      sourceCommitSha,
      runtime: {
        nodeVersion: runtimeManifest.node.version,
        pythonVersion: runtimeManifest.python.version,
        manifestSha256: await sha256File(runtimeManifestPath),
        sbomSha256: await sha256File(runtimeSbomPath),
        licenseInventorySha256: await sha256File(licenseInventoryPath),
      },
      helper: {
        helperId: helperManifest.helperId,
        manifestSha256: await sha256File(helperManifestPath),
      },
      files: await collectManifestEntries(temporary),
    });
    await writeCanonicalJson(path.join(temporary, 'bundle-manifest.json'), manifest);
    await verifyPlatformBundle({ root: temporary, platform, version, sourceCommitSha });
    await fs.promises.rename(temporary, destination);
    return { root: destination, manifestPath: path.join(destination, 'bundle-manifest.json') };
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function gitOutput(repoRoot, args) {
  const result = await execFileAsync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function resolveCliSourceCommit(repoRoot, environment = process.env) {
  const head = await gitOutput(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  const requested = environment.AE_MCP_SOURCE_COMMIT_SHA || head;
  if (!SOURCE_SHA_PATTERN.test(requested) || requested !== head) {
    throw bundleError('INVALID_SOURCE_COMMIT_SHA', 'candidate SHA must equal the exact checked-out HEAD');
  }
  const dirty = await gitOutput(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw bundleError('BUNDLE_SOURCE_DIRTY', 'tracked candidate source is dirty');
  const untrackedInputs = await gitOutput(repoRoot, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    'plugin',
    'packages/core/ae_mcp/skills_bundled',
    'packaging/support-matrix.json',
  ]);
  const ignoredInputs = await gitOutput(repoRoot, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    'plugin',
    'packages/core/ae_mcp/skills_bundled',
    'packaging/support-matrix.json',
  ]);
  const ignoredProductionInput = ignoredInputs.split('\0').filter(Boolean).some((relative) => {
    if (relative.startsWith('plugin/')) return pluginFilter(relative.slice('plugin/'.length));
    return relative.startsWith('packages/core/ae_mcp/skills_bundled/')
      || relative === 'packaging/support-matrix.json';
  });
  if (untrackedInputs || ignoredProductionInput) {
    throw bundleError('BUNDLE_SOURCE_DIRTY', 'untracked candidate source would enter the bundle');
  }
  return requested;
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(['--platform', '--version', '--out']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const equal = item.indexOf('=');
    const key = equal === -1 ? item : item.slice(0, equal);
    const value = equal === -1 ? argv[++index] : item.slice(equal + 1);
    if (!allowed.has(key) || !value || values.has(key)) throw new Error(`invalid argument: ${item}`);
    values.set(key, value);
  }
  for (const key of allowed) if (!values.has(key)) throw new Error(`${key} is required`);
  return {
    platform: values.get('--platform'),
    version: values.get('--version'),
    outDir: values.get('--out'),
  };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDirectory, '..', '..');
  const sourceCommitSha = await resolveCliSourceCommit(repoRoot);
  await stagePlatformBundle({ ...input, repoRoot, sourceCommitSha });
  process.stdout.write(`bundle staged: ${input.platform} ${input.version} ${path.resolve(input.outDir)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs as parseStagePlatformBundleArgs };
