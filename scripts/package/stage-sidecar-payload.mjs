#!/usr/bin/env node

// Stage the Claude sidecar payload where production resolves it (#239).
//
// Production resolveSidecarPath reads runtime/<platform>/node/sidecar with a
// sibling runtime/<platform>/node/shared — lib.mjs imports
// ../shared/tool-approval.mjs and ../shared/chat-attachments.mjs, so both
// trees must ship together. This script is the single implementation used by
// scripts/package-zxp.ps1 ([4/6]) and by CI's hermetic self-check staging, so
// the pipeline and the tests can never drift apart again.
//
// Modes:
//   --stage-root <dir>                stage-root already contains root
//                                     sidecar/ and shared/ copies (the ZXP
//                                     staging flow after its plugin copy step)
//   --stage-root <dir> --from-plugin <plugin-root>
//                                     seed sidecar/ and shared/ from a plugin
//                                     checkout first (CI staging flow)
// Both modes finish by installing production dependencies, fail-closed
// verifying the payload closure, and REMOVING the stage-root sidecar/ and
// shared/ copies so the artifact ships exactly one payload.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const SIDECAR_SOURCES = Object.freeze([
  'agent-sidecar.mjs', 'lib.mjs', 'package.json', 'package-lock.json',
]);
const SHARED_SOURCES = Object.freeze(['tool-approval.mjs', 'chat-attachments.mjs']);
const PLATFORM_SDK_PACKAGE = Object.freeze({
  'windows-x64': '@anthropic-ai/claude-agent-sdk-win32-x64',
  'macos-arm64': '@anthropic-ai/claude-agent-sdk-darwin-arm64',
});

function stageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireRegularFile(filePath, label) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw stageError('SIDECAR_PAYLOAD_INCOMPLETE', `${label} is missing: ${filePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw stageError('SIDECAR_PAYLOAD_INCOMPLETE', `${label} is not a regular file: ${filePath}`);
  }
}

async function copyFileStrict(source, destination, label) {
  requireRegularFile(source, label);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination);
}

export function payloadClosure(platform) {
  const sdkPackage = PLATFORM_SDK_PACKAGE[platform];
  if (!sdkPackage) throw stageError('SIDECAR_PLATFORM_INVALID', `unsupported platform: ${platform}`);
  const closure = [
    ['sidecar', 'agent-sidecar.mjs'],
    ['sidecar', 'lib.mjs'],
    ['sidecar', 'package.json'],
    ['shared', 'tool-approval.mjs'],
    ['shared', 'chat-attachments.mjs'],
    ['sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'],
    ['sidecar', 'node_modules', ...sdkPackage.split('/'), 'package.json'],
  ];
  if (platform === 'windows-x64') {
    closure.push(['sidecar', 'node_modules', ...sdkPackage.split('/'), 'claude.exe']);
  }
  return closure;
}

export async function stageSidecarPayload({
  stageRoot,
  platform,
  fromPlugin,
  npmCommand,
}) {
  const resolvedStageRoot = path.resolve(stageRoot);
  const nodeRoot = path.join(resolvedStageRoot, 'runtime', platform, 'node');

  if (fromPlugin) {
    const pluginRoot = path.resolve(fromPlugin);
    for (const name of SIDECAR_SOURCES) {
      await copyFileStrict(
        path.join(pluginRoot, 'sidecar', name),
        path.join(resolvedStageRoot, 'sidecar', name),
        `plugin sidecar source ${name}`,
      );
    }
    for (const name of SHARED_SOURCES) {
      await copyFileStrict(
        path.join(pluginRoot, 'shared', name),
        path.join(resolvedStageRoot, 'shared', name),
        `plugin shared source ${name}`,
      );
    }
  }

  for (const name of SIDECAR_SOURCES) {
    await copyFileStrict(
      path.join(resolvedStageRoot, 'sidecar', name),
      path.join(nodeRoot, 'sidecar', name),
      `staged sidecar source ${name}`,
    );
  }
  for (const name of SHARED_SOURCES) {
    await copyFileStrict(
      path.join(resolvedStageRoot, 'shared', name),
      path.join(nodeRoot, 'shared', name),
      `staged shared source ${name}`,
    );
  }

  // npm on Windows is a .cmd shim; Node >= 20 (CVE-2024-27980) refuses to
  // spawn those without a shell. The command line is constant, so the shell
  // carries no injection surface.
  const npm = npmCommand || 'npm';
  if (process.platform === 'win32') {
    await execFileAsync(`${npm} ci --omit=dev`, {
      cwd: path.join(nodeRoot, 'sidecar'),
      maxBuffer: 64 * 1024 * 1024,
      shell: true,
    });
  } else {
    await execFileAsync(npm, ['ci', '--omit=dev'], {
      cwd: path.join(nodeRoot, 'sidecar'),
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  for (const segments of payloadClosure(platform)) {
    requireRegularFile(
      path.join(nodeRoot, ...segments),
      `sidecar runtime payload ${segments.join('/')}`,
    );
  }

  await fs.promises.rm(path.join(resolvedStageRoot, 'sidecar'), { recursive: true, force: true });
  await fs.promises.rm(path.join(resolvedStageRoot, 'shared'), { recursive: true, force: true });

  return { nodeRoot };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--stage-root', '--platform', '--from-plugin', '--npm-command'].includes(key)
        || value === undefined || values.has(key)) {
      throw stageError('SIDECAR_STAGE_ARGUMENT_INVALID', `invalid argument: ${String(key)}`);
    }
    values.set(key, value);
  }
  if (!values.has('--stage-root') || !values.has('--platform')) {
    throw stageError('SIDECAR_STAGE_ARGUMENT_INVALID', '--stage-root and --platform are required');
  }
  return {
    stageRoot: values.get('--stage-root'),
    platform: values.get('--platform'),
    fromPlugin: values.get('--from-plugin'),
    npmCommand: values.get('--npm-command'),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = await stageSidecarPayload(parseArgs(process.argv.slice(2)));
    process.stdout.write(`sidecar payload staged: ${result.nodeRoot}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code ?? 'SIDECAR_STAGE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
