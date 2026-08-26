import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  NATIVE_PLUGIN_MANIFEST_PATH,
  PLATFORM_IDS,
  SEMVER_PATTERN,
  SOURCE_SHA_PATTERN,
  bundleError,
  collectManifestEntries,
  copyTree,
  copyRegularFileStable,
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
  RELEASE_AUDIT_IDENTITY_PROFILE,
  normalizeIdentityVerificationProfile,
} from './lib/identity-verification-profile.mjs';
import { verifyPlatformBundle } from './verify-platform-bundle.mjs';

const execFileAsync = promisify(execFile);
const PAYLOAD_DIRECTORIES = Object.freeze(['client', 'CSXS', 'host', 'icons', 'jsx', 'shared']);
const OPENCODE_RUNTIME_RELATIVE_PATH = 'runtime/opencode/opencode.exe';

function payloadFilter(relative) {
  const segments = relative.split('/');
  const basename = segments.at(-1);
  if (segments.some((segment) => ['node_modules/.cache', 'test', 'tests'].includes(segment))) {
    return false;
  }
  return !/(?:^|\.)test\.[^/]+$/i.test(basename)
    && basename !== '.gitignore'
    && basename !== '.DS_Store';
}

async function requireDirectory(directory, label) {
  const stats = await fs.promises.lstat(directory).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw bundleError('BUNDLE_INPUT_MISSING', `required ${label} directory is missing: ${directory}`);
  }
}

async function requireFile(filePath, label) {
  const stats = await fs.promises.lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
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
  if (!PLATFORM_IDS.has(platform)) {
    throw bundleError('BUNDLE_PLATFORM_INVALID', `unsupported platform: ${platform}`);
  }
  if (!SEMVER_PATTERN.test(version ?? '')) {
    throw bundleError('BUNDLE_VERSION_INVALID', `invalid semver: ${version}`);
  }
  if (!SOURCE_SHA_PATTERN.test(sourceCommitSha ?? '')) {
    throw bundleError('INVALID_SOURCE_COMMIT_SHA', 'source commit SHA must be 40 lowercase hexadecimal characters');
  }
  const resolvedRepoRoot = path.resolve(String(repoRoot ?? ''));
  const destination = path.resolve(String(outDir ?? ''));
  if (await fs.promises.lstat(destination).catch(() => null)) {
    throw bundleError('BUNDLE_OUTPUT_EXISTS', `bundle output already exists: ${destination}`);
  }

  const pluginRoot = path.resolve(inputs.pluginRoot ?? path.join(resolvedRepoRoot, 'plugin'));
  const supportMatrixPath = path.resolve(
    inputs.supportMatrixPath ?? path.join(resolvedRepoRoot, 'packaging', 'support-matrix.json'),
  );
  const nativePluginRoot = inputs.nativePluginRoot === undefined
    ? undefined : path.resolve(inputs.nativePluginRoot);
  const runtimeStagingRoot = path.resolve(inputs.runtimeStagingRoot
    ?? path.join(resolvedRepoRoot, 'scripts', 'package', 'runtime-staging', 'opencode'));
  if (nativePluginRoot !== undefined && platform !== 'macos-arm64') {
    throw bundleError(
      'BUNDLE_NATIVE_PLUGIN_PLATFORM_INVALID',
      'the AEGP native plug-in artifact is only valid for macos-arm64',
    );
  }
  await requireDirectory(pluginRoot, 'plugin');
  await requireFile(supportMatrixPath, 'support matrix');
  for (const directory of PAYLOAD_DIRECTORIES) {
    await requireDirectory(path.join(pluginRoot, directory), `plugin/${directory}`);
  }
  await requireFile(path.join(pluginRoot, 'CSXS', 'manifest.xml'), 'CEP manifest');
  await requireFile(path.join(pluginRoot, 'host', 'package.json'), 'host package manifest');
  await requireFile(path.join(pluginRoot, 'host', 'package-lock.json'), 'host lockfile');

  const temporary = await makeTemporarySibling(destination);
  try {
    for (const directory of PAYLOAD_DIRECTORIES) {
      await copyTree(
        path.join(pluginRoot, directory),
        path.join(temporary, directory),
        { filter: payloadFilter },
      );
    }
    if (platform === 'windows-x64') {
      const stagedRuntime = path.join(runtimeStagingRoot, 'opencode.exe');
      const runtimeStats = await fs.promises.lstat(stagedRuntime).catch(() => null);
      if (runtimeStats?.isFile() && !runtimeStats.isSymbolicLink() && runtimeStats.nlink === 1) {
        const destinationRuntime = path.join(temporary, ...OPENCODE_RUNTIME_RELATIVE_PATH.split('/'));
        await fs.promises.mkdir(path.dirname(destinationRuntime), { recursive: true });
        await copyRegularFileStable(stagedRuntime, destinationRuntime, { expectedStats: runtimeStats });
      } else {
        const message = 'WARNING: OpenCode runtime is not staged; run node scripts/package/fetch-opencode-runtime.mjs before packaging.';
        (dependencies.warnImpl ?? console.warn)(message);
        if (profile === RELEASE_AUDIT_IDENTITY_PROFILE) {
          throw bundleError('BUNDLE_OPENCODE_RUNTIME_MISSING', message);
        }
      }
    }
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
    throw bundleError('INVALID_SOURCE_COMMIT_SHA', 'candidate SHA must equal the checked-out HEAD');
  }
  const dirty = await gitOutput(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw bundleError('BUNDLE_SOURCE_DIRTY', 'tracked candidate source is dirty');
  return requested;
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(['--native-plugin-artifact', '--out', '--platform', '--profile', '--version']);
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
  const result = {
    platform: values.get('--platform'),
    version: values.get('--version'),
    outDir: values.get('--out'),
    verificationProfile: values.get('--profile') ?? DEVELOPMENT_IDENTITY_PROFILE,
  };
  normalizeIdentityVerificationProfile(result.verificationProfile);
  if (values.has('--native-plugin-artifact')) {
    result.inputs = { nativePluginRoot: values.get('--native-plugin-artifact') };
  }
  return result;
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
