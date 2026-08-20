#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
}

export function verifyWindowsZxpStage({ stageRoot, version }) {
  const resolved = path.resolve(stageRoot);
  if (!/^0\.\d+\.\d+$/.test(version || '')) throw contractError('release version is invalid');
  if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isDirectory()) {
    throw contractError('Windows ZXP stage root is missing');
  }
  validateRuntimeBoundary(resolved);
  validatePanelContracts(resolved, version);
  return Object.freeze({ platform: 'windows-x64', version });
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
