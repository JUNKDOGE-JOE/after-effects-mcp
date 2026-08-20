import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PLATFORM_IDS,
  NATIVE_PLUGIN_MANIFEST_PATH,
  SEMVER_PATTERN,
  SOURCE_SHA_PATTERN,
  bundleError,
  collectManifestEntries,
  copyTree,
  readJsonFile,
  sha256File,
  validateBundleManifest,
  writeCanonicalJson,
} from './lib/manifest.mjs';
import {
  NATIVE_PLUGIN_ROOT,
  stageNativePluginArtifact,
} from './lib/native-plugin-manifest.mjs';
import {
  DEVELOPMENT_IDENTITY_PROFILE,
  normalizeIdentityVerificationProfile,
  requiresExactIdentity,
} from './lib/identity-verification-profile.mjs';
import { validateRuntimeManifest } from './lib/runtime-manifest.mjs';
import { verifyPlatformBundle } from './verify-platform-bundle.mjs';

const execFileAsync = promisify(execFile);

function pluginFilter(relative) {
  const segments = relative.split('/');
  const basename = segments.at(-1);
  if (segments[0] === 'panel') return false;
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
  verificationProfile = DEVELOPMENT_IDENTITY_PROFILE,
  inputs = {},
  dependencies = {},
} = {}) {
  const profile = normalizeIdentityVerificationProfile(verificationProfile);
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
  const toolsRoot = path.resolve(inputs.bundledToolsRoot
    ?? path.join(resolvedRepoRoot, 'packages', 'core', 'ae_mcp', 'skills_bundled'));
  const supportMatrixPath = path.resolve(inputs.supportMatrixPath
    ?? path.join(resolvedRepoRoot, 'packaging', 'support-matrix.json'));
  const nativePluginRoot = inputs.nativePluginRoot === undefined
    ? undefined : path.resolve(inputs.nativePluginRoot);
  if (nativePluginRoot !== undefined && platform !== 'macos-arm64') {
    throw bundleError(
      'BUNDLE_NATIVE_PLUGIN_PLATFORM_INVALID',
      'the AEGP native plug-in artifact is only valid for macos-arm64',
    );
  }
  await requiredDirectory(pluginRoot, 'plugin');
  await requiredFile(path.join(pluginRoot, '.debug'), 'tracked plugin .debug');
  await requiredDirectory(runtimeRoot, 'runtime');
  await requiredDirectory(toolsRoot, 'bundled tools');
  await requiredFile(supportMatrixPath, 'support matrix');
  for (const [file, label] of [
    [path.join(runtimeRoot, 'runtime-manifest.json'), 'runtime manifest'],
    [path.join(runtimeRoot, 'sbom.spdx.json'), 'SPDX SBOM'],
    [path.join(runtimeRoot, 'license-inventory.json'), 'license inventory'],
  ]) await requiredFile(file, label);

  const runtimeManifest = await readJsonFile(path.join(runtimeRoot, 'runtime-manifest.json'));
  validateRuntimeManifest(runtimeManifest, platform);

  const temporary = await makeTemporarySibling(destination);
  try {
    await copyTree(pluginRoot, temporary, { filter: pluginFilter });
    await copyTree(runtimeRoot, path.join(temporary, 'runtime', platform));
    await copyTree(toolsRoot, path.join(temporary, 'bundled-tools'));
    await fs.promises.mkdir(path.join(temporary, 'metadata'), { recursive: true });
    await fs.promises.copyFile(
      supportMatrixPath,
      path.join(temporary, 'metadata', 'support-matrix.json'),
      fs.constants.COPYFILE_EXCL,
    );
    const nativePlugin = nativePluginRoot === undefined
      ? undefined
      : await stageNativePluginArtifact({
        sourceRoot: nativePluginRoot,
        destinationRoot: path.join(temporary, ...NATIVE_PLUGIN_ROOT.split('/')),
        productVersion: version,
        sourceCommitSha,
        verificationProfile: profile,
        candidateRepoRoot: resolvedRepoRoot,
        dependencies,
      });
    const runtimeManifestPath = path.join(temporary, 'runtime', platform, 'runtime-manifest.json');
    const runtimeSbomPath = path.join(temporary, 'runtime', platform, 'sbom.spdx.json');
    const licenseInventoryPath = path.join(
      temporary,
      'runtime',
      platform,
      'license-inventory.json',
    );
    const manifest = validateBundleManifest({
      schemaVersion: 1,
      version,
      platform,
      sourceCommitSha,
      ...(nativePlugin ? {
        nativePlugin: {
          manifestPath: NATIVE_PLUGIN_MANIFEST_PATH,
          manifestSha256: nativePlugin.manifestSha256,
        },
      } : {}),
      runtime: {
        nodeVersion: runtimeManifest.node.version,
        pythonVersion: runtimeManifest.python.version,
        manifestSha256: await sha256File(runtimeManifestPath),
        sbomSha256: await sha256File(runtimeSbomPath),
        licenseInventorySha256: await sha256File(licenseInventoryPath),
      },
      files: await collectManifestEntries(temporary),
    });
    await writeCanonicalJson(path.join(temporary, 'bundle-manifest.json'), manifest);
    await verifyPlatformBundle({
      root: temporary,
      platform,
      version,
      sourceCommitSha,
      verificationProfile: profile,
      candidateRepoRoot: resolvedRepoRoot,
      dependencies,
    });
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
  const allowed = new Set([
    '--native-plugin-artifact',
    '--out',
    '--platform',
    '--profile',
    '--version',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const equal = item.indexOf('=');
    const key = equal === -1 ? item : item.slice(0, equal);
    const value = equal === -1 ? argv[++index] : item.slice(equal + 1);
    if (!allowed.has(key) || !value || values.has(key)) throw new Error(`invalid argument: ${item}`);
    values.set(key, value);
  }
  for (const key of ['--platform', '--version', '--out']) {
    if (!values.has(key)) throw new Error(`${key} is required`);
  }
  const parsed = {
    platform: values.get('--platform'),
    version: values.get('--version'),
    outDir: values.get('--out'),
    verificationProfile: values.get('--profile') ?? DEVELOPMENT_IDENTITY_PROFILE,
  };
  normalizeIdentityVerificationProfile(parsed.verificationProfile);
  if (values.has('--native-plugin-artifact')) {
    parsed.inputs = { nativePluginRoot: values.get('--native-plugin-artifact') };
  }
  return parsed;
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
