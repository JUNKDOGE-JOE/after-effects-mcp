#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { sha256Directory } from './lib/files.mjs';
import { sha256File } from './lib/manifest.mjs';
import { auditZxpPayload } from './lib/zxp-payload-audit.mjs';
import {
  assertSigningPaths,
  signingError,
  writeSigningSliceEvidence,
} from './signing-plan.mjs';

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/;

function requireSecretEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw signingError('SIGNING_CREDENTIAL_MISSING', `${name} is required`);
  }
  return value;
}

function sameToolState(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function verifyPinnedSignerTool(command, expectedSha256, expectedState) {
  let state;
  try {
    state = await fs.promises.lstat(command, { bigint: true });
  } catch (error) {
    throw signingError('SIGNING_ZXP_TOOL_INVALID', 'reviewed ZXP signer cannot be inspected', error);
  }
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1n) {
    throw signingError('SIGNING_ZXP_TOOL_INVALID', 'reviewed ZXP signer must be one regular non-linked file');
  }
  if (expectedState && !sameToolState(expectedState, state)) {
    throw signingError('SIGNING_ZXP_TOOL_CHANGED', 'reviewed ZXP signer changed during signing');
  }
  let actualSha256;
  try {
    actualSha256 = await sha256File(command);
  } catch (error) {
    throw signingError('SIGNING_ZXP_TOOL_INVALID', 'reviewed ZXP signer failed stable hashing', error);
  }
  const after = await fs.promises.lstat(command, { bigint: true });
  if (!sameToolState(state, after)) {
    throw signingError('SIGNING_ZXP_TOOL_CHANGED', 'reviewed ZXP signer changed while hashing');
  }
  if (actualSha256 !== expectedSha256) {
    throw signingError('SIGNING_ZXP_TOOL_MISMATCH', 'reviewed ZXP signer SHA-256 mismatch');
  }
  return state;
}

export async function buildZxp({
  root,
  platform,
  out,
  evidence,
  sourceStageSha256,
  environment = process.env,
  execFileImpl = execFile,
  auditZxpPayloadImpl = auditZxpPayload,
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
  const expectedCommandSha256 = requireSecretEnvironment(
    environment,
    'AE_MCP_ZXP_SIGN_CMD_SHA256',
  );
  const certificate = requireSecretEnvironment(environment, 'AE_MCP_ZXP_CERT_PATH');
  const password = requireSecretEnvironment(environment, 'AE_MCP_ZXP_CERT_PASSWORD');
  const expectedCertificateFingerprint = requireSecretEnvironment(
    environment,
    'AE_MCP_ZXP_CERT_FINGERPRINT_SHA256',
  );
  if (!SHA256.test(expectedCertificateFingerprint)) {
    throw signingError(
      'SIGNING_ZXP_AUDIT_INPUT_INVALID',
      'AE_MCP_ZXP_CERT_FINGERPRINT_SHA256 must be a lowercase SHA-256 digest',
    );
  }
  if (!SHA256.test(expectedCommandSha256)) {
    throw signingError(
      'SIGNING_ZXP_TOOL_INVALID',
      'AE_MCP_ZXP_SIGN_CMD_SHA256 must be a lowercase SHA-256 digest',
    );
  }
  if (!SHA256.test(sourceStageSha256 || '')) {
    throw signingError(
      'SIGNING_STAGE_DIGEST_MISMATCH',
      'sourceStageSha256 must be the verified unsigned bundle-manifest digest',
    );
  }
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
  const inputSha256 = await sha256Directory(signingRoot);
  const signerState = await verifyPinnedSignerTool(command, expectedCommandSha256);
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
  await verifyPinnedSignerTool(command, expectedCommandSha256, signerState);
  const outputSha256 = await sha256File(outPath);
  await verifyPinnedSignerTool(command, expectedCommandSha256, signerState);
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
  await verifyPinnedSignerTool(command, expectedCommandSha256, signerState);
  const afterVerifySha256 = await sha256File(outPath);
  if (afterVerifySha256 !== outputSha256) {
    throw signingError('SIGNING_OUTPUT_CHANGED', 'ZXP changed during verification');
  }
  const audit = await auditZxpPayloadImpl({
    signingRoot,
    zxpPath: outPath,
    expectedCertificateFingerprint,
  });
  if (!audit || audit.certificateFingerprint !== expectedCertificateFingerprint
      || audit.payloadSha256 !== inputSha256) {
    throw signingError(
      'SIGNING_ZXP_PAYLOAD_MISMATCH',
      'independent ZXP payload or certificate audit did not match the signing input',
    );
  }
  if (await sha256File(outPath) !== outputSha256) {
    throw signingError('SIGNING_OUTPUT_CHANGED', 'ZXP changed during independent payload audit');
  }
  const slice = {
    schemaVersion: 1,
    platform,
    sourceStageSha256,
    steps: [
      { id: 'sign-zxp', inputSha256, outputSha256, exitCode: 0 },
      { id: 'verify-zxp', inputSha256: outputSha256, outputSha256, exitCode: 0 },
    ],
    verifiedIdentity: {
      zxpCertificateFingerprint: audit.certificateFingerprint,
      zxpPayloadSha256: audit.payloadSha256,
      zxpVerified: true,
    },
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
    if (![
      '--root', '--platform', '--out', '--evidence', '--source-stage-sha256',
    ].includes(name) || value === undefined) {
      throw signingError('SIGNING_ARGUMENT_INVALID', `invalid ZXP argument: ${String(name)}`);
    }
    if (values.has(name)) throw signingError('SIGNING_ARGUMENT_INVALID', `duplicate argument: ${name}`);
    values.set(name, value);
  }
  for (const required of [
    '--root', '--platform', '--out', '--evidence', '--source-stage-sha256',
  ]) {
    if (!values.has(required)) throw signingError('SIGNING_ARGUMENT_INVALID', `${required} is required`);
  }
  return {
    root: values.get('--root'),
    platform: values.get('--platform'),
    out: values.get('--out'),
    evidence: values.get('--evidence'),
    sourceStageSha256: values.get('--source-stage-sha256'),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildZxp(parseCli(process.argv.slice(2))).catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : 'SIGNING_ZXP_FAILED';
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
