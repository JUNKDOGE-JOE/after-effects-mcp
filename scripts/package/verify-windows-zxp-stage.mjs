#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REQUIRED_FILES = Object.freeze([
  'client/dist/app.js',
  'CSXS/manifest.xml',
  'host/server.js',
  'host/package.json',
  'host/package-lock.json',
  'host/node_modules/express/package.json',
  'host/stdio-shim.js',
  'host/mcp/generated/native_exec.generated.json',
  'host/mcp/generated/aegp-rpc.schema.json',
  'host/mcp/skills_bundled/manifest.json',
  'jsx/runtime.jsx',
  'shared/chat-attachments.mjs',
  'shared/tool-approval.mjs',
]);

const FORBIDDEN_TOP_LEVEL = new Set([
  '.debug',
  'bin',
  'helper',
  'panel',
  'platform',
  'sidecar',
]);
const OPENCODE_RUNTIME_PATH = 'runtime/opencode/opencode.exe';
const OPENCODE_RUNTIME_MANIFEST = Object.freeze(JSON.parse(
  fs.readFileSync(new URL('./opencode-runtime.json', import.meta.url), 'utf8'),
));

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

function validateRuntime(stageRoot, manifest) {
  const runtime = regularFile(path.join(stageRoot, ...OPENCODE_RUNTIME_PATH.split('/')));
  const stats = fs.statSync(runtime);
  // The payload carries the extracted executable, never the download archive,
  // so the stage is checked against the manifest's binary pins.
  if (stats.size !== manifest.binarySizeBytes) {
    throw contractError(`OpenCode runtime size mismatch: expected ${manifest.binarySizeBytes}, got ${stats.size}`);
  }
  const digest = createHash('sha256').update(fs.readFileSync(runtime)).digest('hex');
  if (digest !== String(manifest.binarySha256 || '').toLowerCase()) {
    throw contractError(`OpenCode runtime SHA-256 mismatch: expected ${manifest.binarySha256}, got ${digest}`);
  }
}

function validatePayloadBoundary(stageRoot, files, runtimeManifest) {
  for (const relativePath of files) {
    const topLevel = relativePath.split('/')[0];
    if (FORBIDDEN_TOP_LEVEL.has(topLevel)) {
      throw contractError(`retired ZXP payload root is present: ${topLevel}`);
    }
    if (topLevel === 'runtime' && relativePath !== OPENCODE_RUNTIME_PATH) {
      throw contractError(`unexpected runtime payload is present: ${relativePath}`);
    }
    if (/\.(?:dll|dylib|node|so|exe)$/i.test(relativePath) && relativePath !== OPENCODE_RUNTIME_PATH) {
      throw contractError(`nested native binary is not allowed in ZXP: ${relativePath}`);
    }
  }
  for (const required of REQUIRED_FILES) regularFile(path.join(stageRoot, ...required.split('/')));
  validateRuntime(stageRoot, runtimeManifest);
  const manifest = JSON.parse(fs.readFileSync(path.join(stageRoot, 'host/package.json'), 'utf8'));
  if (manifest.dependencies?.express !== '4.22.2') {
    throw contractError('host Express dependency is not pinned to 4.22.2');
  }
}

function validatePanelContracts(stageRoot, version) {
  const bundle = fs.readFileSync(regularFile(path.join(stageRoot, 'client/dist/app.js')), 'utf8');
  const escaped = String(version).replaceAll('.', '\\.');
  if (!new RegExp(`PANEL_VERSION\\s*=\\s*["']${escaped}["']`).test(bundle)) {
    throw contractError(`compiled Panel contract is missing release version ${version}`);
  }
  if (!bundle.includes('/host/stdio-shim.js')) {
    throw contractError('compiled Panel contract is missing the Claude Desktop shim path');
  }
  if (!bundle.includes('claude mcp add --transport http')) {
    throw contractError('compiled Panel contract is missing the Claude Code HTTP command');
  }
}

export function verifyWindowsZxpStage({
  stageRoot,
  version,
  runtimeManifest = OPENCODE_RUNTIME_MANIFEST,
}) {
  const resolved = path.resolve(stageRoot);
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw contractError('release version is invalid');
  if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isDirectory()) {
    throw contractError('Windows ZXP stage root is missing');
  }
  const files = relativeFiles(resolved);
  validatePayloadBoundary(resolved, files, runtimeManifest);
  validatePanelContracts(resolved, version);
  return Object.freeze({ platform: 'windows-x64', version, fileCount: files.length });
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
    process.stdout.write(`Windows ZXP stage verified: v${result.version} (${result.fileCount} files)\n`);
  } catch (error) {
    process.stderr.write(`${error?.code ?? 'WINDOWS_ZXP_CONTRACT_INVALID'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
