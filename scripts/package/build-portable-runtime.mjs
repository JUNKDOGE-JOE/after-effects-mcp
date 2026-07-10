import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { generateRuntimeInventory } from './generate-runtime-inventory.mjs';
import { parsePortableRuntimeArgs, SUPPORTED_PLATFORMS } from './lib/args.mjs';
import {
  createSiblingTempDirectory,
  pathExists,
  publishDirectoryAtomically,
  readJson,
  sha256File,
} from './lib/files.mjs';
import { downloadLockedAsset } from './lib/locked-download.mjs';

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

async function extractSingleRoot({ archive, extractionRoot, expectedName, destination }) {
  await fs.promises.mkdir(extractionRoot, { recursive: true });
  await run('tar', ['-xf', archive, '-C', extractionRoot]);
  const entries = (await fs.promises.readdir(extractionRoot)).filter((name) => name !== '__MACOSX');
  if (entries.length !== 1 || entries[0] !== expectedName) {
    throw codedError(
      'INVALID_RUNTIME_ARCHIVE',
      `expected ${archive} to contain only ${expectedName}, received ${entries.join(', ')}`,
    );
  }
  await fs.promises.rename(path.join(extractionRoot, expectedName), destination);
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

function prependPath(environment, value) {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === 'path')
    ?? 'PATH';
  return { ...environment, [key]: `${value}${path.delimiter}${environment[key] ?? ''}` };
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

async function smokeRuntime({ runtimeRoot, platform, runtimeLock }) {
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
      destination: nodeArchive,
    });
    await downloadLockedAsset({
      ...runtimeLock.python.assets[platform],
      destination: pythonArchive,
    });

    const nodeRootName = platform === 'windows-x64'
      ? `node-v${runtimeLock.node.version}-win-x64`
      : `node-v${runtimeLock.node.version}-darwin-arm64`;
    await extractSingleRoot({
      archive: nodeArchive,
      extractionRoot: path.join(buildRoot, 'extract-node'),
      expectedName: nodeRootName,
      destination: path.join(temporary, 'node'),
    });
    await extractSingleRoot({
      archive: pythonArchive,
      extractionRoot: path.join(buildRoot, 'extract-python'),
      expectedName: 'python',
      destination: path.join(temporary, 'python'),
    });

    await installNodePayload({
      runtimeRoot: temporary,
      repoRoot: resolvedRepoRoot,
      buildRoot,
      platform,
    });
    await buildAndInstallPython({
      runtimeRoot: temporary,
      repoRoot: resolvedRepoRoot,
      buildRoot,
      buildPackages,
      platform,
    });
    await smokeRuntime({ runtimeRoot: temporary, platform, runtimeLock });
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
