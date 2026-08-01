#!/usr/bin/env node

// Reversible development install of the AeMcpNative .aex into the Windows
// Common Plug-ins topology for AE 25/26. Records an install receipt
// (canonical path, hash, size, mtime) and removes exactly what it installed.
// Writing to Program Files requires elevation; run this script from an
// elevated shell. Production installer/signing/upgrade lifecycle is #80.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ARTIFACT_NAME = 'AeMcpNative.aex';
const CLI_USAGE = `Usage: node native/ae-plugin/install-dev-windows.mjs \\
  install --artifact <absolute-path> [--plugins-root <path>] \\
| remove --receipt <absolute-path>

Default target: %ProgramFiles%\\Adobe\\Common\\Plug-ins\\7.0\\MediaCore
Elevation is required for the default target.
`;

function installError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('AE_')) return error;
  return installError('AE_PLUGIN_INSTALL_FAILED', 'development install failed');
}

async function digestFile(filePath) {
  return crypto.createHash('sha256').update(
    await fs.promises.readFile(filePath),
  ).digest('hex');
}

function defaultPluginsRoot(environment = process.env) {
  const programFiles = environment.ProgramFiles ?? 'C:\\Program Files';
  return path.join(
    programFiles, 'Adobe', 'Common', 'Plug-ins', '7.0', 'MediaCore',
  );
}

export async function installDevWindowsAex(input = {}) {
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw installError(
        'AE_PLUGIN_PLATFORM_UNSUPPORTED',
        'Windows x64 is required for the development install',
      );
    }
    const artifactPath = input.artifactPath;
    if (typeof artifactPath !== 'string' || !path.isAbsolute(artifactPath)) {
      throw installError('AE_PLUGIN_ARGUMENT_INVALID', '--artifact must be an absolute path');
    }
    const artifactStats = await fs.promises.lstat(artifactPath).catch(() => null);
    if (!artifactStats?.isFile() || artifactStats.isSymbolicLink()
        || artifactStats.size < 1024 || path.basename(artifactPath) !== ARTIFACT_NAME) {
      throw installError(
        'AE_PLUGIN_INSTALL_FAILED',
        'artifact must be one regular AeMcpNative.aex file',
      );
    }
    const pluginsRoot = path.resolve(input.pluginsRoot ?? defaultPluginsRoot());
    const rootStats = await fs.promises.lstat(pluginsRoot).catch(() => null);
    if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
      throw installError(
        'AE_PLUGIN_INSTALL_FAILED',
        'the Windows Common Plug-ins topology for AE 25/26 is unavailable',
      );
    }
    const installedPath = path.join(pluginsRoot, ARTIFACT_NAME);
    const existing = await fs.promises.lstat(installedPath).catch(() => null);
    if (existing) {
      throw installError(
        'AE_PLUGIN_INSTALL_FAILED',
        'a development install already exists; remove it first',
      );
    }
    await fs.promises.copyFile(artifactPath, installedPath, fs.constants.COPYFILE_EXCL);
    const installedStats = await fs.promises.lstat(installedPath);
    const receipt = {
      schemaVersion: 1,
      operation: 'install',
      artifact: {
        sourcePath: path.resolve(artifactPath),
        sourceSha256: await digestFile(artifactPath),
      },
      installed: {
        path: installedPath,
        sha256: await digestFile(installedPath),
        bytes: installedStats.size,
        mtimeMs: installedStats.mtimeMs,
      },
      topology: 'windows-common-plugins-7.0-mediacore',
      installedAtUnixMs: Date.now(),
      runtimeEvidence: false,
    };
    const receiptPath = path.join(
      path.dirname(artifactPath), 'install-receipt.json',
    );
    await fs.promises.writeFile(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: 'wx' },
    );
    return Object.freeze({
      installedPath,
      receipt: receiptPath,
      installedSha256: receipt.installed.sha256,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function removeDevWindowsAex(input = {}) {
  try {
    const receiptPath = input?.receiptPath;
    if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
      throw installError('AE_PLUGIN_ARGUMENT_INVALID', '--receipt must be an absolute path');
    }
    let receipt;
    try {
      receipt = JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
    } catch {
      throw installError('AE_PLUGIN_INSTALL_FAILED', 'install receipt is unreadable');
    }
    const installedPath = receipt?.installed?.path;
    if (typeof installedPath !== 'string'
        || path.basename(installedPath) !== ARTIFACT_NAME) {
      throw installError('AE_PLUGIN_INSTALL_FAILED', 'install receipt target is invalid');
    }
    const stats = await fs.promises.lstat(installedPath).catch(() => null);
    if (stats) {
      const currentSha256 = await digestFile(installedPath);
      if (currentSha256 !== receipt.installed.sha256) {
        throw installError(
          'AE_PLUGIN_INSTALL_FAILED',
          'installed artifact changed since the receipt was recorded; refusing removal',
        );
      }
      await fs.promises.rm(installedPath);
    }
    await fs.promises.rm(receiptPath);
    return Object.freeze({ removed: true });
  } catch (error) {
    throw normalizeError(error);
  }
}

function publicError(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'AE_PLUGIN_INSTALL_FAILED',
      message: typeof error?.message === 'string' ? error.message : 'development install failed',
    },
  };
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) {
  const [commandName, ...rest] = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < rest.length;) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!['--artifact', '--receipt', '--plugins-root'].includes(name)
        || !value || options.has(name)) {
      process.stderr.write(CLI_USAGE);
      process.exitCode = 1;
      break;
    }
    options.set(name, value);
    index += 2;
  }
  (async () => {
    try {
      if (commandName === 'install') {
        const result = await installDevWindowsAex({
          artifactPath: options.get('--artifact'),
          pluginsRoot: options.get('--plugins-root'),
        });
        process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      } else if (commandName === 'remove') {
        const result = await removeDevWindowsAex({ receiptPath: options.get('--receipt') });
        process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      } else {
        process.stderr.write(CLI_USAGE);
        process.exitCode = 1;
      }
    } catch (error) {
      process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
      process.exitCode = 1;
    }
  })();
}
