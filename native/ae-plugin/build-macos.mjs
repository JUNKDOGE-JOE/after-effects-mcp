#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  loadAeSdkPolicy,
  verifyAeSdkInput,
} from '../../scripts/package/ae-sdk-input.mjs';
import { verifyMacPlugin } from './verify-macos.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_ROOT = path.dirname(MODULE_PATH);
const REPO_ROOT = path.resolve(MODULE_ROOT, '../..');

function buildError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeBuildError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('AE_')) return error;
  return buildError(
    'AE_PLUGIN_BUILD_IO_FAILED',
    'native build input/output access failed without producing an artifact',
  );
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function command(tool, args, redactions = []) {
  try {
    return execFileSync(tool, args, {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    let detail = `${error?.stderr ?? ''}`.slice(-4000);
    for (const redaction of redactions) detail = detail.split(redaction).join('<redacted-path>');
    throw buildError(
      'AE_PLUGIN_BUILD_TOOL_FAILED',
      `${path.basename(tool)} failed${detail.trim() ? `: ${detail.trim()}` : ''}`,
    );
  }
}

function commandBytes(tool, args, redactions = []) {
  try {
    return execFileSync(tool, args, {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    let detail = `${error?.stderr ?? ''}`.slice(-4000);
    for (const redaction of redactions) detail = detail.split(redaction).join('<redacted-path>');
    throw buildError(
      'AE_PLUGIN_BUILD_TOOL_FAILED',
      `${path.basename(tool)} failed${detail.trim() ? `: ${detail.trim()}` : ''}`,
    );
  }
}

function gitFileBytes(sourceCommit, relativePath) {
  return commandBytes('/usr/bin/git', [
    '-C', REPO_ROOT, 'show', `${sourceCommit}:${relativePath}`,
  ], [REPO_ROOT]);
}

async function snapshotProductFile(sourceCommit, relativePath, snapshotRoot) {
  const destination = path.join(snapshotRoot, ...relativePath.split('/'));
  await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(
    destination,
    gitFileBytes(sourceCommit, relativePath),
    { flag: 'wx', mode: 0o600 },
  );
  return destination;
}

async function digestSafeTree(root) {
  const records = [];
  let totalBytes = 0;
  async function visit(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const stats = await fs.promises.lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw buildError('AE_SDK_LAYOUT_INVALID', 'SDK build snapshot source contains a symlink');
      }
      if (stats.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1 || stats.size > 16 * 1024 * 1024) {
        throw buildError('AE_SDK_LAYOUT_INVALID', 'SDK build snapshot source is not a safe file tree');
      }
      totalBytes += stats.size;
      if (records.length >= 2048 || totalBytes > 64 * 1024 * 1024) {
        throw buildError('AE_SDK_LAYOUT_INVALID', 'SDK build snapshot source exceeds safety bounds');
      }
      const bytes = await fs.promises.readFile(candidate);
      records.push({
        path: path.relative(root, candidate).split(path.sep).join('/'),
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  await visit(root);
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

async function digestFile(filePath) {
  return crypto.createHash('sha256').update(
    await fs.promises.readFile(filePath),
  ).digest('hex');
}

function parseCli(argv, environment = process.env) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--sdk-archive', '--sdk-root', '--output'].includes(name)
        || !value || options.has(name)) {
      throw buildError(
        'AE_PLUGIN_ARGUMENT_INVALID',
        'expected unique --sdk-archive, --sdk-root, and --output options',
      );
    }
    options.set(name, value);
  }
  const sdkArchive = options.get('--sdk-archive') ?? environment.AE_SDK_ARCHIVE;
  const sdkRoot = options.get('--sdk-root') ?? environment.AE_SDK_ROOT;
  const output = options.get('--output');
  if (!sdkArchive) {
    throw buildError('AE_SDK_ARCHIVE_REQUIRED', 'AE_SDK_ARCHIVE or --sdk-archive is required');
  }
  if (!sdkRoot) throw buildError('AE_SDK_ROOT_REQUIRED', 'AE_SDK_ROOT or --sdk-root is required');
  if (!output || !path.isAbsolute(output)) {
    throw buildError('AE_PLUGIN_ARGUMENT_INVALID', '--output must be an absolute path outside the repository');
  }
  return { sdkArchive, sdkRoot, output: path.resolve(output) };
}

async function resolveSdkRoot(input, expectedRoot) {
  const resolvedInput = await fs.promises.realpath(input);
  return path.basename(resolvedInput) === expectedRoot
    ? resolvedInput : fs.promises.realpath(path.join(resolvedInput, expectedRoot));
}

async function repositoryBoundaries() {
  const redactions = [REPO_ROOT];
  const commonInput = command('/usr/bin/git', [
    '-C', REPO_ROOT, 'rev-parse', '--git-common-dir',
  ], redactions).trim();
  const commonDirectory = await fs.promises.realpath(
    path.resolve(REPO_ROOT, commonInput),
  );
  const worktreeOutput = command('/usr/bin/git', [
    '-C', REPO_ROOT, 'worktree', 'list', '--porcelain',
  ], redactions);
  const worktrees = [];
  for (const line of worktreeOutput.split(/\r?\n/u)) {
    if (!line.startsWith('worktree ')) continue;
    worktrees.push(await fs.promises.realpath(line.slice('worktree '.length)));
  }
  if (worktrees.length === 0) {
    throw buildError('AE_PLUGIN_REPOSITORY_INVALID', 'Git reported no repository worktrees');
  }
  return Object.freeze([commonDirectory, ...new Set(worktrees)]);
}

function assertOutsideBoundaries(candidate, boundaries, label) {
  if (boundaries.some((boundary) => isInside(boundary, candidate))) {
    throw buildError(
      'AE_PLUGIN_PATH_INVALID',
      `${label} must remain outside every repository worktree and the Git common directory`,
    );
  }
}

async function safeBuildRoots() {
  const root = await fs.promises.realpath('/private/tmp').catch(() => null);
  return root ? [root] : [];
}

async function ensureOutputParent(output, sdkRoot, boundaries) {
  if (typeof output !== 'string' || !path.isAbsolute(output)) {
    throw buildError('AE_PLUGIN_OUTPUT_INVALID', 'native build output must be an absolute path');
  }
  const resolvedOutput = path.resolve(output);
  assertOutsideBoundaries(resolvedOutput, boundaries, 'native build output');
  const existing = await fs.promises.lstat(resolvedOutput).catch(() => null);
  if (existing) throw buildError('AE_PLUGIN_OUTPUT_EXISTS', 'native build output already exists');
  const parent = path.dirname(resolvedOutput);
  const parentStats = await fs.promises.lstat(parent).catch(() => null);
  if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
    throw buildError(
      'AE_PLUGIN_OUTPUT_INVALID',
      'native build output parent must already exist as a real directory',
    );
  }
  const realParent = await fs.promises.realpath(parent);
  if (realParent !== parent) {
    throw buildError('AE_PLUGIN_OUTPUT_INVALID', 'native build output cannot traverse a symlink');
  }
  const canonicalOutput = path.join(realParent, path.basename(resolvedOutput));
  assertOutsideBoundaries(canonicalOutput, boundaries, 'native build output');
  const allowedRoots = await safeBuildRoots();
  if (!allowedRoots.some((root) => isInside(root, canonicalOutput))) {
    throw buildError(
      'AE_PLUGIN_OUTPUT_INVALID',
      'native development builds are restricted to canonical /private/tmp',
    );
  }
  if (isInside(sdkRoot, canonicalOutput)) {
    throw buildError(
      'AE_PLUGIN_OUTPUT_INVALID',
      'native build output must remain outside the repository and verified SDK root',
    );
  }
  return { canonicalOutput, realParent };
}

function readCleanSourceCommit() {
  const redactions = [REPO_ROOT];
  const status = command('/usr/bin/git', [
    '-C', REPO_ROOT, 'status', '--porcelain=v1', '--untracked-files=all',
  ], redactions);
  if (status.trim()) {
    throw buildError(
      'AE_PLUGIN_SOURCE_DIRTY',
      'native evidence builds require a fully committed, clean repository worktree',
    );
  }
  return command('/usr/bin/git', [
    '-C', REPO_ROOT, 'rev-parse', '--verify', 'HEAD',
  ], redactions).trim();
}

async function writeReceipt(
  stage,
  verification,
  sourceCommit,
  sdkVerification,
  schemaBytes,
) {
  const receipt = {
    schemaVersion: 1,
    artifact: verification,
    sourceCommit,
    source: {
      commit: sourceCommit,
      repositoryClean: true,
    },
    protocolSchemaSha256: crypto.createHash('sha256').update(schemaBytes).digest('hex'),
    sdk: {
      name: 'Adobe After Effects C/C++ Plug-in SDK',
      claimedVersion: '25.6.61',
      claimedBuild: 61,
      materialIncluded: false,
      archiveVerification: sdkVerification.archiveVerification,
      rootVerification: sdkVerification.rootVerification,
      inputProvenance: sdkVerification.provenance,
    },
    build: {
      configuration: 'development',
      signing: 'ad-hoc',
      distributionApproved: false,
      runtimeEvidence: false,
      compatibilityEvidence: false,
    },
  };
  await fs.promises.writeFile(
    path.join(stage, 'build-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return receipt;
}

async function buildMacPluginInternal({
  sdkArchive: sdkArchiveInput,
  sdkRoot: sdkRootInput,
  output,
}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw buildError('AE_PLUGIN_PLATFORM_UNSUPPORTED', 'macOS arm64 is required for this development build');
  }
  const sourceCommit = readCleanSourceCommit();
  const boundaries = await repositoryBoundaries();
  const policy = await loadAeSdkPolicy();
  const verification = await verifyAeSdkInput({
    archivePath: sdkArchiveInput,
    rootInput: sdkRootInput,
    platform: 'macos-arm64',
    policy,
    repoRoot: REPO_ROOT,
  });
  if (!verification.sdkRootReady) {
    throw buildError('AE_SDK_CONTENT_EVIDENCE_PENDING', 'verified SDK content is required before building');
  }
  const sdkRoot = await resolveSdkRoot(sdkRootInput, policy.sdk.extractedRoot);
  const sdkArchive = await fs.promises.realpath(sdkArchiveInput);
  assertOutsideBoundaries(sdkRoot, boundaries, 'Adobe SDK root');
  assertOutsideBoundaries(sdkArchive, boundaries, 'Adobe SDK archive');
  const { canonicalOutput, realParent: outputParent } = await ensureOutputParent(
    output, sdkRoot, boundaries,
  );
  const stage = path.join(
    outputParent,
    `.${path.basename(output)}.stage-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  const bundle = path.join(stage, 'AeMcpNative.plugin');
  const contents = path.join(bundle, 'Contents');
  const executable = path.join(contents, 'MacOS', 'AeMcpNative');
  const resource = path.join(contents, 'Resources', 'AeMcpNative.rsrc');
  const objects = path.join(stage, '.objects');
  const sourceSnapshot = path.join(stage, '.product-source');
  const sdkSnapshot = path.join(stage, '.restricted-sdk-snapshot');
  const redactions = [sdkRoot, REPO_ROOT, stage, sdkSnapshot];
  let stageOwned = false;

  try {
    await fs.promises.mkdir(stage, { mode: 0o700 });
    stageOwned = true;
    const productInputPaths = [
      'native/ae-plugin/include/aemcp_native/host_dispatcher.hpp',
      'native/ae-plugin/src/core/host_dispatcher.cpp',
      'native/ae-plugin/src/aegp/plugin_entry.cpp',
      'native/ae-plugin/resources/Info.plist',
      'native/ae-plugin/resources/AeMcpNative_PiPL.r',
    ];
    const productInputs = new Map();
    for (const relativePath of productInputPaths) {
      productInputs.set(
        relativePath,
        await snapshotProductFile(sourceCommit, relativePath, sourceSnapshot),
      );
    }
    const schemaBytes = gitFileBytes(
      sourceCommit, 'native/ae-plugin/protocol/aegp-rpc.schema.json',
    );

    await fs.promises.mkdir(path.join(sdkSnapshot, 'Examples', 'Resources'), {
      recursive: true,
      mode: 0o700,
    });
    await fs.promises.cp(
      path.join(sdkRoot, 'Examples', 'Headers'),
      path.join(sdkSnapshot, 'Examples', 'Headers'),
      {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
      },
    );
    await fs.promises.copyFile(
      path.join(sdkRoot, 'Examples', 'Resources', 'AE_General.r'),
      path.join(sdkSnapshot, 'Examples', 'Resources', 'AE_General.r'),
      fs.constants.COPYFILE_EXCL,
    );
    const [sourceSdkDigest, snapshotSdkDigest, repeatedSdkVerification] = await Promise.all([
      digestSafeTree(path.join(sdkRoot, 'Examples', 'Headers'))
        .then(async (headersDigest) => ({
          headersDigest,
          aeGeneralDigest: await digestFile(
            path.join(sdkRoot, 'Examples', 'Resources', 'AE_General.r'),
          ),
        })),
      digestSafeTree(path.join(sdkSnapshot, 'Examples', 'Headers'))
        .then(async (headersDigest) => ({
          headersDigest,
          aeGeneralDigest: await digestFile(
            path.join(sdkSnapshot, 'Examples', 'Resources', 'AE_General.r'),
          ),
        })),
      verifyAeSdkInput({
        archivePath: sdkArchiveInput,
        rootInput: sdkRootInput,
        platform: 'macos-arm64',
        policy,
        repoRoot: REPO_ROOT,
      }),
    ]);
    if (!isDeepStrictEqual(sourceSdkDigest, snapshotSdkDigest)
        || !isDeepStrictEqual(verification, repeatedSdkVerification)) {
      throw buildError(
        'AE_SDK_INPUT_CHANGED',
        'verified SDK inputs changed while the private build snapshot was created',
      );
    }

    await fs.promises.mkdir(path.join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(path.join(contents, 'Resources'), { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(objects, { mode: 0o700 });
    await fs.promises.copyFile(
      productInputs.get('native/ae-plugin/resources/Info.plist'),
      path.join(contents, 'Info.plist'),
      fs.constants.COPYFILE_EXCL,
    );

    const xcrun = '/usr/bin/xcrun';
    const clang = command(xcrun, ['--find', 'clang++']).trim();
    const rez = command(xcrun, ['--find', 'Rez']).trim();
    const sysroot = command(xcrun, ['--sdk', 'macosx', '--show-sdk-path']).trim();
    const includes = [
      '-isystem', path.join(sdkSnapshot, 'Examples', 'Headers'),
      '-isystem', path.join(sdkSnapshot, 'Examples', 'Headers', 'SP'),
      '-I', path.join(sourceSnapshot, 'native', 'ae-plugin', 'include'),
    ];
    const compileFlags = [
      '-std=c++20', '-stdlib=libc++', '-arch', 'arm64', '-mmacosx-version-min=14.0',
      '-isysroot', sysroot,
      `-DAE_MCP_SOURCE_COMMIT="${sourceCommit}"`,
      '-pthread', '-fPIC', '-fvisibility=hidden', '-fvisibility-inlines-hidden',
      '-Wall', '-Wextra', '-Wpedantic', '-Werror', '-O0',
      ...includes,
    ];
    const sourceFiles = [
      productInputs.get('native/ae-plugin/src/core/host_dispatcher.cpp'),
      productInputs.get('native/ae-plugin/src/aegp/plugin_entry.cpp'),
    ];
    const objectFiles = [];
    for (const [index, source] of sourceFiles.entries()) {
      const object = path.join(objects, `${index}.o`);
      command(clang, [...compileFlags, '-c', source, '-o', object], redactions);
      objectFiles.push(object);
    }
    command(clang, [
      '-bundle', '-arch', 'arm64', '-mmacosx-version-min=14.0', '-pthread',
      '-isysroot', sysroot,
      '-Wl,-dead_strip', '-Wl,-exported_symbol,_AeMcpNativeMain',
      ...objectFiles, '-framework', 'CoreFoundation', '-o', executable,
    ], redactions);
    command(rez, [
      '-useDF', '-arch', 'arm64', '-isysroot', sysroot,
      '-i', path.join(sdkSnapshot, 'Examples', 'Headers'),
      '-i', path.join(sdkSnapshot, 'Examples', 'Resources'),
      productInputs.get('native/ae-plugin/resources/AeMcpNative_PiPL.r'),
      '-o', resource,
    ], redactions);

    await fs.promises.rm(objects, { recursive: true });
    await fs.promises.rm(sourceSnapshot, { recursive: true });
    await fs.promises.rm(sdkSnapshot, { recursive: true });
    command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle], redactions);
    const artifactVerification = await verifyMacPlugin({ bundlePath: bundle });
    if (readCleanSourceCommit() !== sourceCommit) {
      throw buildError('AE_PLUGIN_SOURCE_CHANGED', 'repository HEAD changed during native build');
    }
    const receipt = await writeReceipt(
      stage, artifactVerification, sourceCommit, verification, schemaBytes,
    );
    await fs.promises.rename(stage, canonicalOutput);
    return Object.freeze({
      schemaVersion: 1,
      output: canonicalOutput,
      bundle: path.join(canonicalOutput, 'AeMcpNative.plugin'),
      receipt: path.join(canonicalOutput, 'build-receipt.json'),
      artifact: artifactVerification,
      sourceCommit: receipt.sourceCommit,
      runtimeEvidence: false,
    });
  } catch (error) {
    if (stageOwned) {
      try {
        await fs.promises.rm(stage, { recursive: true, force: true });
      } catch {
        throw buildError(
          'AE_PLUGIN_BUILD_CLEANUP_REQUIRED',
          'native build failed and its private staging cleanup did not complete',
        );
      }
    }
    throw error;
  }
}

export async function buildMacPlugin(options) {
  try {
    return await buildMacPluginInternal(options);
  } catch (error) {
    throw normalizeBuildError(error);
  }
}

function publicError(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'AE_PLUGIN_BUILD_FAILED',
      message: typeof error?.message === 'string' ? error.message : 'native plug-in build failed',
    },
  };
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) {
  try {
    const result = await buildMacPlugin(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  }
}
