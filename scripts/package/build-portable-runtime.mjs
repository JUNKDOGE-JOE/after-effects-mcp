import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertNodeLicenseNoticeLock,
  generateRuntimeInventory,
} from './generate-runtime-inventory.mjs';
import { parsePortableRuntimeArgs, SUPPORTED_PLATFORMS } from './lib/args.mjs';
import { inspectLockedArchive, verifyExtractedArchive } from './lib/archive-preflight.mjs';
import {
  createSiblingTempDirectory,
  pathExists,
  publishDirectoryAtomically,
  readJson,
  readRegularFileSnapshot,
  sha256File,
  writeBytesAtomically,
} from './lib/files.mjs';
import { downloadLockedAsset } from './lib/locked-download.mjs';
import {
  loadPythonStandaloneEvidence,
  stagePythonStandaloneNotices,
  verifyPythonStandalonePayloadEvidence,
} from './lib/python-standalone-evidence.mjs';

const PACKAGE_PROJECTS = [
  'packages/core/pyproject.toml',
  'packages/bridge/pyproject.toml',
  'packages/snapshot-mss/pyproject.toml',
];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseLockedPackages(lockText) {
  const packages = new Map();
  const pattern = /\[\[package\]\]\s*\n([\s\S]*?)(?=\n\[\[package\]\]|$)/g;
  for (const match of lockText.matchAll(pattern)) {
    const block = match[1];
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (!name || !version) continue;
    const dependencySection = block.match(/^dependencies = \[([\s\S]*?)^\]/m)?.[1] ?? '';
    const dependencies = [...dependencySection.matchAll(/\{ name = "([^"]+)"/g)]
      .map((dependency) => dependency[1]);
    const hashes = [...block.matchAll(/hash = "sha256:([a-f0-9]{64})"/g)]
      .map((hash) => hash[1]);
    packages.set(name.toLowerCase().replace(/[-_.]+/g, '-'), {
      name,
      version,
      dependencies,
      hashes: [...new Set(hashes)].sort(),
    });
  }
  return packages;
}

function buildSystemRequirements(pyprojectText) {
  const section = pyprojectText.match(/\[build-system\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? '';
  const requires = section.match(/requires\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return [...requires.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

export function assertWorkspaceBuildBackendsLocked(repoRoot) {
  const lockText = fs.readFileSync(path.join(repoRoot, 'uv.lock'), 'utf8');
  const lockedPackages = parseLockedPackages(lockText);
  const roots = new Map();

  for (const relativeProject of PACKAGE_PROJECTS) {
    const requirements = buildSystemRequirements(
      fs.readFileSync(path.join(repoRoot, relativeProject), 'utf8'),
    );
    if (requirements.length === 0) {
      throw codedError('UNLOCKED_BUILD_BACKEND', `${relativeProject} has no build backend lock`);
    }
    for (const requirement of requirements) {
      const exact = requirement.match(/^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)$/);
      const packageName = (exact?.[1] ?? requirement.split(/[<>=!~; ]/, 1)[0]).toLowerCase();
      const normalized = packageName.replace(/[-_.]+/g, '-');
      const locked = lockedPackages.get(normalized);
      if (!exact || !locked || locked.version !== exact[2] || locked.hashes.length === 0) {
        throw codedError(
          'UNLOCKED_BUILD_BACKEND',
          `build backend ${packageName} must be exactly pinned and present with hashes in uv.lock (${relativeProject})`,
        );
      }
      roots.set(normalized, locked);
    }
  }

  const closure = new Map();
  const pending = [...roots.keys()];
  while (pending.length > 0) {
    const normalized = pending.pop();
    if (closure.has(normalized)) continue;
    const locked = lockedPackages.get(normalized);
    if (!locked || locked.hashes.length === 0) {
      throw codedError(
        'UNLOCKED_BUILD_BACKEND',
        `build dependency ${normalized} must be present with hashes in uv.lock`,
      );
    }
    closure.set(normalized, locked);
    for (const dependency of locked.dependencies) {
      pending.push(dependency.toLowerCase().replace(/[-_.]+/g, '-'));
    }
  }
  return [...closure.values()].sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

export async function assertUvLockCurrent(repoRoot, options = {}) {
  const uv = options.uv ?? process.env.UV ?? 'uv';
  const cacheDir = options.cacheDir
    ?? process.env.UV_CACHE_DIR
    ?? path.join(os.tmpdir(), 'ae-mcp-runtime-uv-cache');
  try {
    await run(uv, [
      'lock',
      '--check',
      '--offline',
      '--cache-dir', cacheDir,
    ], { cwd: repoRoot, capture: true });
  } catch (error) {
    throw codedError(
      'UV_LOCK_STALE',
      `uv.lock is stale or cannot be verified offline: ${error.message}`,
    );
  }
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(codedError(
        'RUNTIME_BUILD_COMMAND_FAILED',
        `${command} ${args.join(' ')} failed with ${signal ?? code}${stderr ? `: ${stderr.trim()}` : ''}`,
      ));
    });
  });
}

function assertNativeBuildHost(platform) {
  const native = process.platform === 'darwin' && process.arch === 'arm64'
    ? 'macos-arm64'
    : process.platform === 'win32' && process.arch === 'x64'
      ? 'windows-x64'
      : null;
  if (native !== platform) {
    throw codedError(
      'UNSUPPORTED_BUILD_HOST',
      `portable runtime smoke requires native ${platform}; current host is ${process.platform}-${process.arch}`,
    );
  }
}

async function writeBuildConstraints(buildRoot, buildPackages) {
  const lines = buildPackages.map((item) => (
    `${item.name}==${item.version} ${item.hashes.map((hash) => `--hash=sha256:${hash}`).join(' ')}`
  ));
  const filePath = path.join(buildRoot, 'build-tools.requirements.txt');
  await fs.promises.writeFile(filePath, `${lines.join('\n')}\n`, { flag: 'wx' });
  return filePath;
}

function archiveInspectionLimits(contract) {
  const requiredNumbers = [
    'archiveBytes',
    'rawEntryCount',
    'regularBytes',
    'maxEntryBytes',
    'decompressedBytes',
  ];
  if (
    !contract
    || !['ustar-gzip', 'zip'].includes(contract.format)
    || typeof contract.root !== 'string'
    || !contract.root
    || !/^[a-f0-9]{64}$/.test(contract.sha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(contract.manifestSha256 ?? '')
    || requiredNumbers.some((name) => (
      !Number.isSafeInteger(contract[name]) || contract[name] < 0
    ))
  ) {
    throw codedError('INVALID_RUNTIME_LOCK', 'runtime archive contract is incomplete or invalid');
  }
  return {
    maxArchiveBytes: contract.archiveBytes,
    maxDecompressedBytes: contract.decompressedBytes,
    maxEntries: Math.max(1, contract.rawEntryCount),
    maxEntryBytes: Math.max(1, contract.maxEntryBytes),
    maxTotalBytes: Math.max(1, contract.regularBytes),
    expectedArchiveBytes: contract.archiveBytes,
    expectedDecompressedBytes: contract.decompressedBytes,
    expectedManifestSha256: contract.manifestSha256,
    expectedMaxEntryBytes: contract.maxEntryBytes,
    expectedRawEntryCount: contract.rawEntryCount,
    expectedRegularBytes: contract.regularBytes,
  };
}

function systemTarCommand() {
  if (process.platform !== 'win32') return '/usr/bin/tar';
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw codedError('SYSTEM_TAR_UNAVAILABLE', 'SystemRoot is required for absolute system tar');
  }
  return path.win32.join(systemRoot, 'System32', 'tar.exe');
}

function sanitizedTarEnvironment() {
  if (process.platform !== 'win32') {
    return { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' };
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const environment = {
    PATH: path.win32.join(systemRoot, 'System32'),
    SystemRoot: systemRoot,
    WINDIR: process.env.WINDIR ?? systemRoot,
  };
  for (const name of ['TEMP', 'TMP']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

export async function extractSingleRoot({
  archive,
  extractionRoot,
  destination,
  contract,
}) {
  const resolvedArchive = path.resolve(archive);
  const resolvedExtractionRoot = path.resolve(extractionRoot);
  const resolvedDestination = path.resolve(destination);
  const limits = archiveInspectionLimits(contract);

  if (await pathExists(resolvedExtractionRoot)) {
    throw codedError(
      'INVALID_RUNTIME_ARCHIVE',
      `archive staging directory already exists: ${resolvedExtractionRoot}`,
    );
  }
  if (await pathExists(resolvedDestination)) {
    throw codedError(
      'INVALID_RUNTIME_ARCHIVE',
      `archive destination already exists: ${resolvedDestination}`,
    );
  }

  const snapshotDirectory = await createSiblingTempDirectory(
    `${resolvedExtractionRoot}.locked-archive`,
  );
  const snapshotArchive = path.join(snapshotDirectory, 'archive');
  if (process.platform !== 'win32') await fs.promises.chmod(snapshotDirectory, 0o700);
  let published = false;

  try {
    await fs.promises.copyFile(
      resolvedArchive,
      snapshotArchive,
      fs.constants.COPYFILE_EXCL,
    );
    if (process.platform !== 'win32') await fs.promises.chmod(snapshotArchive, 0o600);
    const snapshotStats = await fs.promises.lstat(snapshotArchive);
    if (
      !snapshotStats.isFile()
      || snapshotStats.isSymbolicLink()
      || snapshotStats.size !== contract.archiveBytes
    ) {
      throw codedError(
        'INVALID_RUNTIME_ARCHIVE',
        `archive byte length mismatch: expected ${contract.archiveBytes}, received ${snapshotStats.size}`,
      );
    }
    const archiveSha256 = await sha256File(snapshotArchive);
    if (archiveSha256 !== contract.sha256) {
      throw codedError(
        'INVALID_RUNTIME_ARCHIVE',
        `archive SHA-256 mismatch: expected ${contract.sha256}, received ${archiveSha256}`,
      );
    }
    const inspection = await inspectLockedArchive({
      archivePath: snapshotArchive,
      format: contract.format,
      expectedRoot: contract.root,
      limits,
    });

    await fs.promises.mkdir(path.dirname(resolvedExtractionRoot), { recursive: true });
    await fs.promises.mkdir(resolvedExtractionRoot, { mode: 0o700 });
    if (process.platform !== 'win32') await fs.promises.chmod(resolvedExtractionRoot, 0o700);
    await run(
      systemTarCommand(),
      ['-xf', snapshotArchive, '-C', resolvedExtractionRoot],
      { env: sanitizedTarEnvironment() },
    );
    await verifyExtractedArchive({ extractionRoot: resolvedExtractionRoot, inspection });
    await fs.promises.rename(
      path.join(resolvedExtractionRoot, contract.root),
      resolvedDestination,
    );
    published = true;
    await fs.promises.rmdir(resolvedExtractionRoot);
    await fs.promises.rm(snapshotDirectory, { recursive: true, force: true });
    return inspection;
  } catch (error) {
    const cleanupErrors = [];
    for (const cleanupPath of [
      ...(published ? [resolvedDestination] : []),
      resolvedExtractionRoot,
      snapshotDirectory,
    ]) {
      try {
        await fs.promises.rm(cleanupPath, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `archive extraction failed and cleanup was incomplete: ${error.message}`,
      );
    }
    throw error;
  }
}
function runtimeExecutables(runtimeRoot, platform) {
  if (platform === 'windows-x64') {
    return {
      node: path.join(runtimeRoot, 'node', 'node.exe'),
      npmCli: path.join(runtimeRoot, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      python: path.join(runtimeRoot, 'python', 'python.exe'),
      nodePath: path.join(runtimeRoot, 'node'),
    };
  }
  return {
    node: path.join(runtimeRoot, 'node', 'bin', 'node'),
    npmCli: path.join(runtimeRoot, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    python: path.join(runtimeRoot, 'python', 'bin', 'python3'),
    nodePath: path.join(runtimeRoot, 'node', 'bin'),
  };
}

export async function copyNodeRuntimeLicenseNotices({ repoRoot, runtimeRoot }) {
  const bom = await readJson(path.join(repoRoot, 'packaging/node-runtime-bom.json'));
  if (!Array.isArray(bom.licenseNotices) || bom.licenseNotices.length === 0) {
    throw codedError('NODE_LICENSE_NOTICE_INVALID', 'Node license notice lock is empty');
  }
  await fs.promises.mkdir(runtimeRoot, { recursive: true });

  async function assertNoSymlinkAncestors(root, filePath, label, allowMissing) {
    const rootStats = await fs.promises.lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw codedError(
        'NODE_LICENSE_NOTICE_INVALID',
        `Node license notice ${label} root is not a real directory: ${root}`,
      );
    }
    const relative = path.relative(root, filePath);
    const parts = relative.split(path.sep).filter(Boolean).slice(0, -1);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      let stats;
      try {
        stats = await fs.promises.lstat(current);
      } catch (error) {
        if (allowMissing && error.code === 'ENOENT') return;
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw codedError(
          'NODE_LICENSE_NOTICE_INVALID',
          `Node license notice ${label} has a symlink ancestor: ${current}`,
        );
      }
      if (!stats.isDirectory()) {
        throw codedError(
          'NODE_LICENSE_NOTICE_INVALID',
          `Node license notice ${label} ancestor is not a directory: ${current}`,
        );
      }
    }
  }

  async function readNoticeWithoutFollowingLinks(source, expectedStats) {
    let handle;
    try {
      handle = await fs.promises.open(
        source,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (error.code === 'ELOOP') {
        throw codedError(
          'NODE_LICENSE_NOTICE_INVALID',
          `Node license notice source is a symbolic link: ${source}`,
        );
      }
      throw error;
    }
    try {
      const before = await handle.stat();
      if (
        !before.isFile()
        || before.dev !== expectedStats.dev
        || before.ino !== expectedStats.ino
        || before.size !== expectedStats.size
      ) {
        throw codedError(
          'NODE_LICENSE_NOTICE_INVALID',
          `Node license notice source changed before reading: ${source}`,
        );
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs
        || bytes.length !== before.size
      ) {
        throw codedError(
          'NODE_LICENSE_NOTICE_INVALID',
          `Node license notice source changed while reading: ${source}`,
        );
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  for (const notice of bom.licenseNotices) {
    assertNodeLicenseNoticeLock(notice);
    const source = path.resolve(repoRoot, ...notice.sourcePath.split('/'));
    const sourceRelative = path.relative(repoRoot, source);
    if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) {
      throw codedError(
        'NODE_LICENSE_NOTICE_INVALID',
        `Node license notice source escapes repository: ${notice.sourcePath}`,
      );
    }
    const destination = path.resolve(runtimeRoot, ...notice.payloadPath.split('/'));
    const destinationRelative = path.relative(runtimeRoot, destination);
    if (destinationRelative.startsWith('..') || path.isAbsolute(destinationRelative)) {
      throw codedError(
        'NODE_LICENSE_NOTICE_INVALID',
        `Node license notice payload escapes runtime: ${notice.payloadPath}`,
      );
    }
    await assertNoSymlinkAncestors(repoRoot, source, 'source', false);
    const sourceStats = await fs.promises.lstat(source);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw codedError(
        'NODE_LICENSE_NOTICE_INVALID',
        `Node license notice source is not a regular file: ${notice.sourcePath}`,
      );
    }
    const sourceBytes = await readNoticeWithoutFollowingLinks(source, sourceStats);
    const actualSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    if (actualSha256 !== notice.sha256) {
      throw codedError(
        'NODE_LICENSE_NOTICE_MISMATCH',
        `Node license notice SHA-256 mismatch for ${notice.package}@${notice.version}`,
      );
    }
    await assertNoSymlinkAncestors(runtimeRoot, destination, 'destination', true);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await assertNoSymlinkAncestors(runtimeRoot, destination, 'destination', false);
    const destinationHandle = await fs.promises.open(
      destination,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o644,
    );
    try {
      await destinationHandle.writeFile(sourceBytes);
    } catch (error) {
      await destinationHandle.close();
      await fs.promises.rm(destination, { force: true });
      throw error;
    }
    await destinationHandle.close();
  }
}

function prependPath(environment, value) {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === 'path')
    ?? 'PATH';
  return { ...environment, [key]: `${value}${path.delimiter}${environment[key] ?? ''}` };
}

export async function copySidecarEntrypoints({ repoRoot, runtimeRoot }) {
  const sourceRoot = path.join(path.resolve(repoRoot), 'plugin', 'sidecar');
  const destinationRoot = path.join(path.resolve(runtimeRoot), 'node', 'sidecar');
  await fs.promises.mkdir(destinationRoot, { recursive: true });
  for (const name of ['agent-sidecar.mjs', 'lib.mjs']) {
    const source = path.join(sourceRoot, name);
    const destination = path.join(destinationRoot, name);
    const expectedStats = await fs.promises.lstat(source);
    const bytes = await readRegularFileSnapshot(source, {
      expectedStats,
      maxBytes: 8 * 1024 * 1024,
    });
    await writeBytesAtomically(destination, bytes, { mode: 0o644 });
  }
}

async function installNodePayload({ runtimeRoot, repoRoot, buildRoot, platform }) {
  const executables = runtimeExecutables(runtimeRoot, platform);
  for (const target of ['host', 'sidecar']) {
    const destination = path.join(runtimeRoot, 'node', target);
    await fs.promises.mkdir(destination, { recursive: true });
    for (const manifest of ['package.json', 'package-lock.json']) {
      await fs.promises.copyFile(
        path.join(repoRoot, 'plugin', target, manifest),
        path.join(destination, manifest),
      );
    }
    const environment = prependPath({
      ...process.env,
      npm_config_audit: 'false',
      npm_config_cache: path.join(buildRoot, 'npm-cache'),
      npm_config_fund: 'false',
      npm_config_ignore_scripts: 'true',
      npm_config_update_notifier: 'false',
    }, executables.nodePath);
    await run(executables.node, [
      executables.npmCli,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ], { cwd: destination, env: environment });
  }
  await copySidecarEntrypoints({ repoRoot, runtimeRoot });
}

async function removeMatchingDirectories(parent, pattern) {
  if (!(await pathExists(parent))) return;
  const entries = await fs.promises.readdir(parent, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => fs.promises.rm(path.join(parent, entry.name), { recursive: true, force: true })));
}

async function pruneDevelopmentArtifacts(root) {
  if (!(await pathExists(root))) return;
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const destination = path.join(root, entry.name);
    if (
      (entry.isDirectory() && /^(?:test|tests|__pycache__|\.cache)$/i.test(entry.name))
      || (entry.isFile() && /(?:^|\.)test\.[^/]+$/i.test(entry.name))
    ) {
      await fs.promises.rm(destination, { recursive: true, force: true });
      return;
    }
    if (entry.isDirectory()) await pruneDevelopmentArtifacts(destination);
  }));
}

function pythonRecordPath(line) {
  if (!line.startsWith('"')) return line.split(',', 1)[0];
  let value = '';
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === '"') {
      if (line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        return value;
      }
    } else {
      value += line[index];
    }
  }
  throw codedError('RUNTIME_PYTHON_RECORD_INVALID', `invalid Python RECORD line: ${line}`);
}

function isDevelopmentArtifactPath(relative) {
  const segments = relative.split('/');
  return segments.some((segment) => /^(?:test|tests|__pycache__|\.cache)$/i.test(segment))
    || /(?:^|\.)test\.[^/]+$/i.test(segments.at(-1) ?? '');
}

async function normalizePythonRecords({ runtimeRoot, platform }) {
  const sitePackages = platform === 'windows-x64'
    ? path.join(runtimeRoot, 'python', 'Lib', 'site-packages')
    : path.join(runtimeRoot, 'python', 'lib', 'python3.13', 'site-packages');
  if (!(await pathExists(sitePackages))) return;
  const entries = await fs.promises.readdir(sitePackages, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue;
    const record = path.join(sitePackages, entry.name, 'RECORD');
    if (!(await pathExists(record))) continue;
    const lines = (await fs.promises.readFile(record, 'utf8')).split(/\r?\n/).filter(Boolean);
    const retained = [];
    for (const line of lines) {
      const relative = pythonRecordPath(line);
      const absolute = path.resolve(sitePackages, relative.split('/').join(path.sep));
      const insideRuntime = path.relative(runtimeRoot, absolute);
      if (insideRuntime.startsWith('..') || path.isAbsolute(insideRuntime)) {
        throw codedError(
          'RUNTIME_PYTHON_RECORD_INVALID',
          `Python RECORD path escapes runtime root: ${relative}`,
        );
      }
      if ((await pathExists(absolute)) || !isDevelopmentArtifactPath(relative)) retained.push(line);
    }
    if (retained.length !== lines.length) {
      await fs.promises.writeFile(record, `${retained.join('\n')}\n`);
    }
  }
}

async function pruneRuntimeDevelopmentArtifacts({ runtimeRoot, platform }) {
  await pruneDevelopmentArtifacts(runtimeRoot);
  await normalizePythonRecords({ runtimeRoot, platform });
}

export async function pruneBundledRuntimeTools({ runtimeRoot, platform }) {
  const nodeRoot = path.join(runtimeRoot, 'node');
  const pythonRoot = path.join(runtimeRoot, 'python');
  const nodePaths = platform === 'windows-x64'
    ? [
      'include',
      'node_modules/npm',
      'node_modules/corepack',
      'npm', 'npm.cmd', 'npm.ps1',
      'npx', 'npx.cmd', 'npx.ps1',
      'corepack', 'corepack.cmd', 'corepack.ps1',
      'pnpm', 'pnpm.cmd', 'pnpm.ps1',
      'pnpx', 'pnpx.cmd', 'pnpx.ps1',
      'yarn', 'yarn.cmd', 'yarn.ps1',
      'yarnpkg', 'yarnpkg.cmd', 'yarnpkg.ps1',
    ]
    : [
      'include',
      'lib/node_modules/npm',
      'lib/node_modules/corepack',
      'bin/npm', 'bin/npx', 'bin/corepack',
      'bin/pnpm', 'bin/pnpx', 'bin/yarn', 'bin/yarnpkg',
    ];
  await Promise.all(nodePaths.map((relative) => (
    fs.promises.rm(path.join(nodeRoot, relative), { recursive: true, force: true })
  )));

  const pythonLib = platform === 'windows-x64'
    ? path.join(pythonRoot, 'Lib')
    : path.join(pythonRoot, 'lib', 'python3.13');
  const sitePackages = path.join(pythonLib, 'site-packages');
  const scriptRoot = platform === 'windows-x64'
    ? path.join(pythonRoot, 'Scripts')
    : path.join(pythonRoot, 'bin');
  if (await pathExists(scriptRoot)) {
    const scripts = await fs.promises.readdir(scriptRoot);
    await Promise.all(scripts
      .filter((name) => /^(pip|easy_install)(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i.test(name))
      .map((name) => fs.promises.rm(path.join(scriptRoot, name), { force: true })));
  }
  await fs.promises.rm(path.join(pythonLib, 'ensurepip'), { recursive: true, force: true });
  await fs.promises.rm(path.join(sitePackages, 'pip'), { recursive: true, force: true });
  await fs.promises.rm(path.join(sitePackages, 'setuptools'), { recursive: true, force: true });
  await fs.promises.rm(path.join(sitePackages, '_distutils_hack'), { recursive: true, force: true });
  await fs.promises.rm(path.join(sitePackages, 'distutils-precedence.pth'), { force: true });
  await removeMatchingDirectories(sitePackages, /^pip-.*\.dist-info$/i);
  await removeMatchingDirectories(sitePackages, /^setuptools-.*\.dist-info$/i);
  await pruneRuntimeDevelopmentArtifacts({ runtimeRoot, platform });
}

async function assertPeX64(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const dos = Buffer.alloc(64);
    const dosRead = await handle.read(dos, 0, dos.length, 0);
    if (dosRead.bytesRead !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') {
      throw codedError('CLAUDE_CLI_INVALID', 'Claude CLI is not a PE executable');
    }
    const peOffset = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    const peRead = await handle.read(pe, 0, pe.length, peOffset);
    if (
      peRead.bytesRead !== pe.length
      || pe.toString('ascii', 0, 4) !== 'PE\0\0'
      || pe.readUInt16LE(4) !== 0x8664
    ) {
      throw codedError('CLAUDE_CLI_INVALID', 'Claude CLI is not a PE x64 executable');
    }
  } finally {
    await handle.close();
  }
}

export async function assertClaudeCliPayload({ platform, repoRoot, runtimeRoot, runtimeLock }) {
  const cliLock = runtimeLock.claudeCli;
  const contract = cliLock?.assets?.[platform];
  if (!cliLock || !contract) {
    throw codedError('CLAUDE_CLI_INVALID', `Claude CLI lock is missing ${platform}`);
  }
  const sidecarLock = await readJson(path.join(repoRoot, 'plugin/sidecar/package-lock.json'));
  const sdkLock = sidecarLock.packages?.['node_modules/@anthropic-ai/claude-agent-sdk'];
  const platformLock = sidecarLock.packages?.[`node_modules/${contract.package}`];
  if (
    sdkLock?.version !== cliLock.sdkVersion
    || sdkLock.optionalDependencies?.[contract.package] !== cliLock.sdkVersion
    || platformLock?.version !== cliLock.sdkVersion
    || platformLock.optional !== true
  ) {
    throw codedError(
      'CLAUDE_CLI_INVALID',
      `required Claude CLI package ${contract.package}@${cliLock.sdkVersion} is missing from lock`,
    );
  }

  const sidecarModules = path.join(runtimeRoot, 'node', 'sidecar', 'node_modules');
  const sdkPackagePath = path.join(sidecarModules, '@anthropic-ai', 'claude-agent-sdk', 'package.json');
  const platformPackageRoot = path.join(sidecarModules, ...contract.package.split('/'));
  const platformPackagePath = path.join(platformPackageRoot, 'package.json');
  const binaryPath = path.join(platformPackageRoot, contract.binary);
  if (
    !(await pathExists(sdkPackagePath))
    || !(await pathExists(platformPackagePath))
    || !(await pathExists(binaryPath))
  ) {
    throw codedError(
      'CLAUDE_CLI_INVALID',
      `required Claude CLI package or binary is missing: ${contract.package}/${contract.binary}`,
    );
  }
  const sdkPackage = await readJson(sdkPackagePath);
  const platformPackage = await readJson(platformPackagePath);
  if (
    sdkPackage.name !== '@anthropic-ai/claude-agent-sdk'
    || sdkPackage.version !== cliLock.sdkVersion
    || platformPackage.name !== contract.package
    || platformPackage.version !== cliLock.sdkVersion
  ) {
    throw codedError('CLAUDE_CLI_INVALID', 'installed Claude CLI package identity does not match lock');
  }

  const stats = await fs.promises.lstat(binaryPath);
  if (!stats.isFile()) {
    throw codedError('CLAUDE_CLI_INVALID', `Claude CLI binary is not a regular file: ${binaryPath}`);
  }
  if (platform === 'macos-arm64') {
    const mode = (stats.mode & 0o777).toString(8).padStart(4, '0');
    if (contract.mode !== '0755' || mode !== contract.mode) {
      throw codedError(
        'CLAUDE_CLI_INVALID',
        `Claude CLI mode mismatch: expected ${contract.mode}, received ${mode}`,
      );
    }
  } else {
    if (contract.mode !== 'regular-pe-x64' || path.extname(binaryPath).toLowerCase() !== '.exe') {
      throw codedError('CLAUDE_CLI_INVALID', 'Windows Claude CLI mode must be regular-pe-x64');
    }
    await assertPeX64(binaryPath);
  }
  const digest = await sha256File(binaryPath);
  if (digest !== contract.sha256) {
    throw codedError(
      'CLAUDE_CLI_INVALID',
      `Claude CLI SHA-256 mismatch: expected ${contract.sha256}, received ${digest}`,
    );
  }
  const version = (await run(binaryPath, ['--version'], { capture: true })).stdout.trim();
  const expectedVersion = `${cliLock.version} (Claude Code)`;
  if (version !== expectedVersion) {
    throw codedError(
      'CLAUDE_CLI_INVALID',
      `Claude CLI version mismatch: expected ${expectedVersion}, received ${version}`,
    );
  }
  return version;
}

function validateExportedRequirements(contents) {
  const logical = contents.replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  for (const requirement of logical) {
    if (!/^[A-Za-z0-9_.-]+==[^ ;]+(?:\s*;[^\\]+)?\s+.*--hash=sha256:[a-f0-9]{64}/.test(requirement)) {
      throw codedError(
        'UNPINNED_PYTHON_REQUIREMENT',
        `uv.lock export contains an unpinned or unhashed requirement: ${requirement}`,
      );
    }
  }
}

async function buildAndInstallPython({
  runtimeRoot,
  repoRoot,
  buildRoot,
  buildPackages,
  platform,
}) {
  const executables = runtimeExecutables(runtimeRoot, platform);
  const uv = process.env.UV ?? 'uv';
  const uvCache = path.join(buildRoot, 'uv-cache');
  const wheelRoot = path.join(runtimeRoot, 'wheels');
  const buildConstraints = await writeBuildConstraints(buildRoot, buildPackages);
  const uvLockBefore = await sha256File(path.join(repoRoot, 'uv.lock'));
  await fs.promises.mkdir(wheelRoot, { recursive: true });

  await run(uv, [
    'build',
    '--all-packages',
    '--wheel',
    '--out-dir', wheelRoot,
    '--build-constraints', buildConstraints,
    '--require-hashes',
    '--python', executables.python,
    '--no-python-downloads',
    '--cache-dir', uvCache,
  ], { cwd: repoRoot });

  const wheels = (await fs.promises.readdir(wheelRoot))
    .filter((name) => name.endsWith('.whl'))
    .sort();
  if (wheels.length !== 3) {
    throw codedError('WORKSPACE_WHEEL_SET_INVALID', `expected 3 workspace wheels, received ${wheels.length}`);
  }

  const requirements = path.join(buildRoot, 'runtime.requirements.txt');
  await run(uv, [
    'export',
    '--frozen',
    '--all-packages',
    '--no-dev',
    '--no-emit-workspace',
    '--no-annotate',
    '--no-header',
    '--format', 'requirements.txt',
    '--output-file', requirements,
    '--python', executables.python,
    '--no-python-downloads',
    '--cache-dir', uvCache,
  ], { cwd: repoRoot });
  validateExportedRequirements(await fs.promises.readFile(requirements, 'utf8'));

  await run(uv, [
    'pip', 'install',
    '--python', executables.python,
    '--requirements', requirements,
    '--require-hashes',
    '--no-deps',
    '--only-binary', ':all:',
    '--no-python-downloads',
    '--cache-dir', uvCache,
  ], { cwd: repoRoot });
  await run(uv, [
    'pip', 'install',
    '--python', executables.python,
    '--no-index',
    '--no-deps',
    '--no-build',
    '--no-python-downloads',
    '--cache-dir', uvCache,
    ...wheels.map((wheel) => path.join(wheelRoot, wheel)),
  ], { cwd: repoRoot });

  const uvLockAfter = await sha256File(path.join(repoRoot, 'uv.lock'));
  if (uvLockAfter !== uvLockBefore) {
    throw codedError('UV_LOCK_CHANGED', 'portable runtime build changed frozen uv.lock');
  }
}

async function smokeRuntime({ runtimeRoot, repoRoot, platform, runtimeLock }) {
  const executables = runtimeExecutables(runtimeRoot, platform);
  const nodeVersion = (await run(executables.node, ['--version'], { capture: true })).stdout.trim();
  if (nodeVersion !== `v${runtimeLock.node.version}`) {
    throw codedError('NODE_SMOKE_FAILED', `expected v${runtimeLock.node.version}, received ${nodeVersion}`);
  }
  await run(executables.node, [
    '-e',
    "const value=require('express'); if(typeof value!=='function') process.exit(1)",
  ], { cwd: path.join(runtimeRoot, 'node', 'host') });
  await run(executables.node, [
    '--input-type=module',
    '-e',
    "const value=await import('@anthropic-ai/claude-agent-sdk'); if(!value) process.exit(1)",
  ], { cwd: path.join(runtimeRoot, 'node', 'sidecar') });
  await assertClaudeCliPayload({
    platform,
    repoRoot,
    runtimeRoot,
    runtimeLock,
  });
  await run(executables.python, [
    '-I',
    '-c',
    'import ae_mcp, ae_mcp_bridge, ae_mcp_snapshot_mss',
  ], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
}

export async function buildPortableRuntime({ platform, outDir, repoRoot }) {
  if (!SUPPORTED_PLATFORMS.has(platform)) throw new Error(`unsupported platform: ${platform}`);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedOutDir = path.resolve(outDir);

  // This gate intentionally precedes host checks, downloads, and temporary-directory creation.
  const buildPackages = assertWorkspaceBuildBackendsLocked(resolvedRepoRoot);
  await assertUvLockCurrent(resolvedRepoRoot);
  assertNativeBuildHost(platform);
  if (await pathExists(resolvedOutDir)) {
    throw codedError('RUNTIME_OUTPUT_EXISTS', `runtime output already exists: ${resolvedOutDir}`);
  }

  const runtimeLock = await readJson(path.join(resolvedRepoRoot, 'packaging/runtime-lock.json'));
  const temporary = await createSiblingTempDirectory(resolvedOutDir);
  const buildRoot = path.join(temporary, '.build');
  try {
    const downloads = path.join(buildRoot, 'downloads');
    const nodeArchive = path.join(downloads, platform === 'windows-x64' ? 'node.zip' : 'node.tar.gz');
    const pythonArchive = path.join(downloads, 'python.tar.gz');
    await fs.promises.mkdir(downloads, { recursive: true });
    await downloadLockedAsset({
      ...runtimeLock.node.assets[platform],
      expectedBytes: runtimeLock.node.assets[platform].archiveBytes,
      destination: nodeArchive,
    });
    await downloadLockedAsset({
      ...runtimeLock.python.assets[platform],
      expectedBytes: runtimeLock.python.assets[platform].archiveBytes,
      destination: pythonArchive,
    });

    await extractSingleRoot({
      archive: nodeArchive,
      extractionRoot: path.join(buildRoot, 'extract-node'),
      destination: path.join(temporary, 'node'),
      contract: runtimeLock.node.assets[platform],
    });
    await extractSingleRoot({
      archive: pythonArchive,
      extractionRoot: path.join(buildRoot, 'extract-python'),
      destination: path.join(temporary, 'python'),
      contract: runtimeLock.python.assets[platform],
    });

    await installNodePayload({
      runtimeRoot: temporary,
      repoRoot: resolvedRepoRoot,
      buildRoot,
      platform,
    });
    await pruneBundledRuntimeTools({ runtimeRoot: temporary, platform });
    await copyNodeRuntimeLicenseNotices({
      repoRoot: resolvedRepoRoot,
      runtimeRoot: temporary,
    });
    const pythonEvidence = loadPythonStandaloneEvidence({
      bundle: path.join(
        resolvedRepoRoot,
        'packaging/evidence/python-standalone/evidence-bundle.json',
      ),
      runtimeLock,
      bom: path.join(resolvedRepoRoot, 'packaging/python-standalone-bom.json'),
    });
    stagePythonStandaloneNotices({
      runtimeRoot: temporary,
      platform,
      evidence: pythonEvidence,
    });
    verifyPythonStandalonePayloadEvidence({
      runtimeRoot: temporary,
      platform,
      bom: path.join(resolvedRepoRoot, 'packaging/python-standalone-bom.json'),
    });
    await buildAndInstallPython({
      runtimeRoot: temporary,
      repoRoot: resolvedRepoRoot,
      buildRoot,
      buildPackages,
      platform,
    });
    await smokeRuntime({
      runtimeRoot: temporary,
      repoRoot: resolvedRepoRoot,
      platform,
      runtimeLock,
    });
    await pruneRuntimeDevelopmentArtifacts({ runtimeRoot: temporary, platform });
    await fs.promises.rm(buildRoot, { recursive: true, force: true });
    const manifest = await generateRuntimeInventory({
      platform,
      runtimeRoot: temporary,
      repoRoot: resolvedRepoRoot,
      licenseApprovalPath: process.env.AE_MCP_RUNTIME_LICENSE_APPROVAL,
    });
    await publishDirectoryAtomically({ temporary, destination: resolvedOutDir });
    return {
      root: resolvedOutDir,
      manifestPath: path.join(resolvedOutDir, 'runtime-manifest.json'),
      manifest,
    };
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const { platform, outDir } = parsePortableRuntimeArgs(process.argv.slice(2));
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDirectory, '..', '..');
  await buildPortableRuntime({ platform, outDir, repoRoot });
  const lock = await readJson(path.join(repoRoot, 'packaging/runtime-lock.json'));
  process.stdout.write(
    `runtime ready: ${platform} node=${lock.node.version} python=${lock.python.version}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
