#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { sha256Directory } from './lib/files.mjs';
import { sha256File } from './lib/manifest.mjs';
import {
  assertSigningPaths,
  signingError,
  writeSigningSliceEvidence,
} from './signing-plan.mjs';

const execFile = promisify(execFileCallback);

function requireSecretEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw signingError('SIGNING_CREDENTIAL_MISSING', `${name} is required`);
  }
  return value;
}

export async function buildZxp({
  root,
  platform,
  out,
  evidence,
  environment = process.env,
  execFileImpl = execFile,
}) {
  const signingRoot = path.resolve(root);
  const outPath = path.resolve(out);
  const evidencePath = path.resolve(evidence);
  if (root !== signingRoot || out !== outPath || evidence !== evidencePath) {
    throw signingError('SIGNING_PATH_ABSOLUTE_REQUIRED', 'all ZXP paths must be absolute');
  }
  if (!['macos-arm64', 'windows-x64'].includes(platform)) {
    throw signingError('SIGNING_PLATFORM_UNSUPPORTED', `unsupported ZXP platform: ${platform}`);
  }
  assertSigningPaths({ source: signingRoot, outputs: [outPath, evidencePath] });
  const command = requireSecretEnvironment(environment, 'AE_MCP_ZXP_SIGN_CMD');
  const certificate = requireSecretEnvironment(environment, 'AE_MCP_ZXP_CERT_PATH');
  const password = requireSecretEnvironment(environment, 'AE_MCP_ZXP_CERT_PASSWORD');
  if (!path.isAbsolute(command) || !path.isAbsolute(certificate)) {
    throw signingError(
      'SIGNING_CREDENTIAL_PATH_INVALID',
      'ZXP executable and certificate paths must be absolute',
    );
  }
  await fs.promises.access(signingRoot, fs.constants.R_OK);
  await fs.promises.access(certificate, fs.constants.R_OK);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
  for (const candidate of [outPath, evidencePath]) {
    try {
      await fs.promises.lstat(candidate);
      throw signingError('SIGNING_OUTPUT_EXISTS', 'ZXP output or evidence already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const sourceStageSha256 = await sha256File(path.join(signingRoot, 'bundle-manifest.json'));
  const inputSha256 = await sha256Directory(signingRoot);
  try {
    await execFileImpl(command, ['-sign', signingRoot, outPath, certificate, password], {
      env: environment,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    throw signingError('SIGNING_COMMAND_FAILED', 'ZXP signing command failed');
  }
  const outputSha256 = await sha256File(outPath);
  try {
    await execFileImpl(command, ['-verify', outPath], {
      env: environment,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    throw signingError('SIGNING_VERIFY_FAILED', 'ZXP verification command failed');
  }
  const afterVerifySha256 = await sha256File(outPath);
  if (afterVerifySha256 !== outputSha256) {
    throw signingError('SIGNING_OUTPUT_CHANGED', 'ZXP changed during verification');
  }
  const slice = {
    schemaVersion: 1,
    platform,
    sourceStageSha256,
    steps: [
      { id: 'sign-zxp', inputSha256, outputSha256, exitCode: 0 },
      { id: 'verify-zxp', inputSha256: outputSha256, outputSha256, exitCode: 0 },
    ],
    verifiedIdentity: { zxpVerified: true },
  };
  await writeSigningSliceEvidence({
    evidencePath,
    evidence: slice,
    platform,
    expectedStepIds: ['sign-zxp', 'verify-zxp'],
    expectedInputSha256: inputSha256,
    expectedStageSha256: sourceStageSha256,
  });
  return slice;
}

function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--root', '--platform', '--out', '--evidence'].includes(name) || value === undefined) {
      throw signingError('SIGNING_ARGUMENT_INVALID', `invalid ZXP argument: ${String(name)}`);
    }
    if (values.has(name)) throw signingError('SIGNING_ARGUMENT_INVALID', `duplicate argument: ${name}`);
    values.set(name, value);
  }
  for (const required of ['--root', '--platform', '--out', '--evidence']) {
    if (!values.has(required)) throw signingError('SIGNING_ARGUMENT_INVALID', `${required} is required`);
  }
  return {
    root: values.get('--root'),
    platform: values.get('--platform'),
    out: values.get('--out'),
    evidence: values.get('--evidence'),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildZxp(parseCli(process.argv.slice(2))).catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : 'SIGNING_ZXP_FAILED';
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
