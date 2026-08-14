#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HELPER_FILES = Object.freeze([
  'bin/ae-mcp-platform-helper.exe',
  'bin/ae-mcp.exe',
  'lib/ae-mcp-platform-helper-transport.node',
]);
const FORBIDDEN_RUNTIME_PATHS = Object.freeze([
  'runtime/windows-x64/node/node.exe',
  'runtime/windows-x64/python',
  'runtime/windows-x64/runtime-manifest.json',
  'runtime/windows-x64/bundle-manifest.json',
]);

function contractError(message) {
  const error = new Error(message);
  error.code = 'WINDOWS_ZXP_CONTRACT_INVALID';
  return error;
}

function regularFile(filePath) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (cause) {
    throw contractError(`required ZXP file is missing: ${filePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw contractError(`ZXP path is not a regular file: ${filePath}`);
  }
  return filePath;
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function relativeFiles(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw contractError(`ZXP stage contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join('/'));
      else throw contractError(`ZXP stage contains an unsupported path: ${absolute}`);
    }
  };
  visit(root);
  return result.sort();
}

function exactSet(actual, expected, message) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) throw contractError(message);
}

function validateHelper(stageRoot) {
  const helperRoot = path.join(stageRoot, 'platform', 'windows-x64');
  const manifestPath = regularFile(path.join(helperRoot, 'helper-manifest.json'));
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw contractError('Windows Platform Helper manifest is invalid JSON');
  }
  const records = Array.isArray(manifest.files) ? manifest.files : [];
  if (manifest.schemaVersion !== 1
      || manifest.platform !== 'windows-x64'
      || manifest.helperId !== 'com.junkdoge.ae-mcp.platform-helper'
      || manifest.entrypoints?.helper !== HELPER_FILES[0]
      || manifest.entrypoints?.launcher !== HELPER_FILES[1]) {
    throw contractError('Windows Platform Helper manifest identity is invalid');
  }
  exactSet(records.map((record) => record?.path), HELPER_FILES,
    'Windows Platform Helper manifest inventory is invalid');
  exactSet(relativeFiles(helperRoot), ['helper-manifest.json', ...HELPER_FILES],
    'Windows Platform Helper directory contains missing or unexpected files');
  for (const record of records) {
    if (!record || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw contractError('Windows Platform Helper manifest hash is invalid');
    }
    const filePath = regularFile(path.join(helperRoot, ...record.path.split('/')));
    if (sha256File(filePath) !== record.sha256) {
      throw contractError(`Windows Platform Helper hash mismatch: ${record.path}`);
    }
  }
}

function validateRuntimeBoundary(stageRoot) {
  for (const relativePath of FORBIDDEN_RUNTIME_PATHS) {
    if (fs.existsSync(path.join(stageRoot, ...relativePath.split('/')))) {
      throw contractError(`forbidden bundled runtime path is present: ${relativePath}`);
    }
  }
  const aex = relativeFiles(stageRoot).find((relativePath) => relativePath.toLowerCase().endsWith('.aex'));
  if (aex) throw contractError(`native AEX must remain a separate release asset: ${aex}`);
  regularFile(path.join(stageRoot, 'runtime', 'windows-x64', 'node', 'host', 'package.json'));
  regularFile(path.join(
    stageRoot,
    'runtime',
    'windows-x64',
    'node',
    'host',
    'node_modules',
    'express',
    'package.json',
  ));
  // #239: production resolveSidecarPath reads runtime/windows-x64/node/sidecar
  // and the .debug development fallback is stripped from the ZXP, so a stage
  // without this payload ships a Claude channel that cannot start. The stray
  // stage-root copy is the build input, not a shippable location.
  const sidecarRoot = path.join(stageRoot, 'runtime', 'windows-x64', 'node', 'sidecar');
  regularFile(path.join(sidecarRoot, 'agent-sidecar.mjs'));
  regularFile(path.join(sidecarRoot, 'package.json'));
  regularFile(path.join(sidecarRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'));
  if (fs.existsSync(path.join(stageRoot, 'sidecar'))) {
    throw contractError('sidecar must ship under runtime/windows-x64/node/sidecar, not at the stage root');
  }
}

function validatePanelContracts(stageRoot, version) {
  const bundle = fs.readFileSync(regularFile(path.join(stageRoot, 'client', 'dist', 'app.js')), 'utf8');
  if (!new RegExp(`PANEL_VERSION\\s*=\\s*["']${version.replaceAll('.', '\\.') }["']`).test(bundle)) {
    throw contractError(`compiled Panel contract is missing release version ${version}`);
  }
  for (const marker of [
    'astral.sh/uv/install.ps1',
    '#subdirectory=packages/${sub}',
    'src("core")',
    'src("bridge")',
    'src("snapshot-mss")',
  ]) {
    if (!bundle.includes(marker)) throw contractError(`compiled Panel contract is missing: ${marker}`);
  }
  if (!/["']tool["']\s*,\s*["']install["']\s*,\s*["']--force["']\s*,\s*["']--from["']/.test(bundle)) {
    throw contractError('compiled Panel contract is missing the uv tool install command');
  }
  const transport = fs.readFileSync(
    regularFile(path.join(stageRoot, 'host', 'platform-helper-transport.js')),
    'utf8',
  );
  for (const marker of HELPER_FILES) {
    if (!transport.includes(marker)) throw contractError(`Host Helper contract is missing: ${marker}`);
  }
}

export function verifyWindowsZxpStage({ stageRoot, version }) {
  const resolved = path.resolve(stageRoot);
  if (!/^0\.\d+\.\d+$/.test(version || '')) throw contractError('release version is invalid');
  if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isDirectory()) {
    throw contractError('Windows ZXP stage root is missing');
  }
  validateHelper(resolved);
  validateRuntimeBoundary(resolved);
  validatePanelContracts(resolved, version);
  return Object.freeze({ platform: 'windows-x64', version, helperFiles: [...HELPER_FILES] });
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--stage', '--version'].includes(key) || value === undefined || values.has(key)) {
      throw contractError(`invalid argument: ${String(key)}`);
    }
    values.set(key, value);
  }
  if (!values.has('--stage') || !values.has('--version')) {
    throw contractError('--stage and --version are required');
  }
  return { stageRoot: values.get('--stage'), version: values.get('--version') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = verifyWindowsZxpStage(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Windows ZXP stage verified: v${result.version}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code ?? 'WINDOWS_ZXP_CONTRACT_INVALID'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
