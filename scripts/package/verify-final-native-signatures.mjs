import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { detectBinaryArchitectureFile } from './lib/binary-arch.mjs';
import { sha256Directory } from './lib/files.mjs';
import {
  readCanonicalJsonFile,
  sha256File,
  validateBundleManifest,
  writeCanonicalJson,
} from './lib/manifest.mjs';
import { verifyPlatformBundle } from './verify-platform-bundle.mjs';

const execFileAsync = promisify(execFile);
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const SIGNER_FINGERPRINT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const COMMAND_OPTIONS = Object.freeze({
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
  timeout: 30_000,
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function signatureKind(platform) {
  return platform === 'macos-arm64' ? 'codesign' : 'authenticode';
}

function protectedFingerprint(platform) {
  const name = platform === 'macos-arm64'
    ? 'AE_MCP_APPLE_CERT_FINGERPRINT_SHA256'
    : 'AE_MCP_WINDOWS_SIGNING_CERT_SHA1';
  const value = process.env[name];
  const expected = platform === 'macos-arm64' ? /^[a-f0-9]{64}$/ : /^[A-F0-9]{40}$/;
  if (!expected.test(value ?? '')) {
    throw new Error(`${name} is required for final native signature verification`);
  }
  return value;
}

function resolveManifestFile(root, relative) {
  const absolute = path.resolve(root, ...String(relative).split('/'));
  const remainder = path.relative(root, absolute);
  if (!relative || relative.includes('\\')
      || remainder === '..' || remainder.startsWith(`..${path.sep}`)
      || path.isAbsolute(remainder)) {
    throw new Error(`manifest path escapes the signed root: ${String(relative)}`);
  }
  return absolute;
}

async function readJson(pathname) {
  return JSON.parse(await fs.promises.readFile(pathname, 'utf8'));
}

async function productOwnedPaths(root, platform, manifest) {
  const owned = new Set();
  if (manifest.nativePlugin) {
    const nativeManifest = await readJson(resolveManifestFile(
      root,
      manifest.nativePlugin.manifestPath,
    ));
    const executablePath = nativeManifest?.artifact?.executablePath;
    if (typeof executablePath !== 'string' || executablePath.length === 0) {
      throw new Error('signed native plug-in manifest executable identity is missing');
    }
    owned.add(`${path.posix.dirname(manifest.nativePlugin.manifestPath)}/${executablePath}`);
  }
  return owned;
}

async function inspectMacSignature({
  filePath,
  requireProductIdentity,
  expectedFingerprint,
}) {
  await execFileAsync(
    '/usr/bin/codesign',
    ['--verify', '--strict', '--verbose=4', filePath],
    COMMAND_OPTIONS,
  );
  await execFileAsync(
    '/usr/bin/codesign',
    ['-d', '--verbose=4', filePath],
    COMMAND_OPTIONS,
  );
  const temporary = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'ae-mcp-final-signature-'),
  );
  try {
    const certificatePrefix = path.join(temporary, 'certificate');
    await execFileAsync(
      '/usr/bin/codesign',
      ['-d', '--extract-certificates', certificatePrefix, filePath],
      COMMAND_OPTIONS,
    );
    const { stdout } = await execFileAsync(
      '/usr/bin/shasum',
      ['-a', '256', `${certificatePrefix}0`],
      COMMAND_OPTIONS,
    );
    const signerFingerprint = stdout.trim().split(/\s+/u)[0];
    if (!/^[a-f0-9]{64}$/.test(signerFingerprint)) {
      throw new Error(`codesign certificate fingerprint is invalid: ${filePath}`);
    }
    if (requireProductIdentity && signerFingerprint !== expectedFingerprint) {
      throw new Error(`product signer fingerprint mismatch: ${filePath}`);
    }
    return { verified: true, signerFingerprint };
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

export async function inspectWindowsSignature({
  filePath,
  requireProductIdentity,
  expectedFingerprint,
}, dependencies = {}) {
  const temporary = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'ae-mcp-authenticode-'),
  );
  try {
    const scriptPath = path.join(temporary, 'inspect-authenticode.ps1');
    await fs.promises.writeFile(scriptPath, [
      'param(',
      '  [Parameter(Mandatory = $true)]',
      '  [string]$FilePath',
      ')',
      '$signature = Get-AuthenticodeSignature -LiteralPath $FilePath',
      '[PSCustomObject]@{',
      '  Status = [string]$signature.Status',
      '  SignerCertificate = if ($null -eq $signature.SignerCertificate) { $null } else {',
      '    [PSCustomObject]@{',
      '      Thumbprint = [string]$signature.SignerCertificate.Thumbprint',
      '    }',
      '  }',
      '} | ConvertTo-Json -Compress',
      '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    const executeFile = dependencies.executeFile ?? execFileAsync;
    const { stdout } = await executeFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        scriptPath,
        '-FilePath',
        filePath,
      ],
      COMMAND_OPTIONS,
    );
    const inspected = JSON.parse(stdout);
    const signerFingerprint = inspected?.SignerCertificate?.Thumbprint;
    if (inspected?.Status !== 'Valid' || !/^[A-F0-9]{40}$/.test(signerFingerprint ?? '')) {
      throw new Error(`Authenticode signature is invalid: ${filePath}`);
    }
    if (requireProductIdentity
        && signerFingerprint.toUpperCase() !== expectedFingerprint.toUpperCase()) {
      throw new Error(`product signer fingerprint mismatch: ${filePath}`);
    }
    return { verified: true, signerFingerprint };
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

async function defaultInspectSignature(input) {
  return input.platform === 'macos-arm64'
    ? inspectMacSignature(input)
    : inspectWindowsSignature(input);
}

function validateInput({ platform, candidateSha, signedRoot, zxpPath, dmgPath }) {
  if (!PLATFORMS.has(platform)) throw new Error(`unsupported platform: ${platform}`);
  if (!SOURCE_SHA.test(candidateSha ?? '')) throw new Error('candidate SHA is invalid');
  if (path.resolve(String(signedRoot ?? '')) !== signedRoot) {
    throw new Error('signed root must be absolute');
  }
  if (path.resolve(String(zxpPath ?? '')) !== zxpPath) {
    throw new Error('exactly one absolute ZXP path is required');
  }
  if (platform === 'macos-arm64') {
    if (path.resolve(String(dmgPath ?? '')) !== dmgPath) {
      throw new Error('macOS requires exactly one absolute DMG path');
    }
  } else if (dmgPath !== undefined) {
    throw new Error('Windows final signature evidence must not include a DMG');
  }
}

export async function verifyFinalNativeSignatures(input, dependencies = {}) {
  validateInput(input);
  const {
    platform,
    candidateSha,
    signedRoot,
    zxpPath,
    dmgPath,
  } = input;
  const bundleManifestPath = path.join(signedRoot, 'bundle-manifest.json');
  const manifest = validateBundleManifest(
    await readCanonicalJsonFile(bundleManifestPath),
  );
  if (manifest.platform !== platform || manifest.sourceCommitSha !== candidateSha) {
    throw new Error('signed bundle platform or candidate identity mismatch');
  }
  await verifyPlatformBundle({
    root: signedRoot,
    platform,
    version: manifest.version,
    sourceCommitSha: candidateSha,
    verificationProfile: 'release-audit',
  });

  const acceptedArchitectures = platform === 'macos-arm64'
    ? new Set(['macho-arm64', 'macho-universal-arm64'])
    : new Set(['pe-x64']);
  const owned = await productOwnedPaths(signedRoot, platform, manifest);
  const expectedFingerprint = protectedFingerprint(platform);
  const inspectSignature = dependencies.inspectSignature ?? defaultInspectSignature;
  const files = [];
  const productVerifiedPaths = new Set();
  for (const record of manifest.files) {
    if (record.type !== 'file') continue;
    const filePath = resolveManifestFile(signedRoot, record.path);
    const architecture = await detectBinaryArchitectureFile(filePath);
    if (!acceptedArchitectures.has(architecture)) continue;
    const requireProductIdentity = owned.has(record.path);
    const inspected = await inspectSignature({
      platform,
      filePath,
      requireProductIdentity,
      expectedFingerprint: requireProductIdentity ? expectedFingerprint : undefined,
    });
    if (inspected?.verified !== true
        || !SIGNER_FINGERPRINT.test(inspected.signerFingerprint ?? '')) {
      throw new Error(`native signature adapter rejected: ${record.path}`);
    }
    if (requireProductIdentity
        && inspected.signerFingerprint.toLowerCase() !== expectedFingerprint.toLowerCase()) {
      throw new Error(`product signer fingerprint mismatch: ${record.path}`);
    }
    if (requireProductIdentity) productVerifiedPaths.add(record.path);
    files.push({
      path: record.path,
      sha256: record.sha256,
      signatureKind: signatureKind(platform),
      signerFingerprint: inspected.signerFingerprint,
      verified: true,
    });
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));

  if ([...owned].some((requiredPath) => (
    !owned.has(requiredPath) || !productVerifiedPaths.has(requiredPath)
  ))) {
    throw new Error('final product native signature coverage is missing');
  }

  const artifactPaths = [zxpPath, ...(dmgPath === undefined ? [] : [dmgPath])];
  const artifacts = [];
  for (const artifactPath of artifactPaths) {
    artifacts.push({
      name: path.basename(artifactPath),
      sha256: await sha256File(artifactPath),
    });
  }
  return {
    schemaVersion: 1,
    platform,
    candidateSha,
    result: 'PASS',
    signedBundleManifestSha256: await sha256File(bundleManifestPath),
    finalRootSha256: await sha256Directory(signedRoot),
    discoveredNativeCount: files.length,
    files,
    artifacts,
  };
}

export async function writeFinalNativeSignatureEvidence(input, dependencies = {}) {
  const resolvedOut = path.resolve(String(input?.outPath ?? ''));
  if (input?.outPath !== resolvedOut) throw new Error('output path must be absolute');
  const resolvedSignedRoot = path.resolve(String(input?.signedRoot ?? ''));
  const relativeOutput = path.relative(resolvedSignedRoot, resolvedOut);
  if (relativeOutput === ''
      || (!path.isAbsolute(relativeOutput)
        && relativeOutput !== '..'
        && !relativeOutput.startsWith(`..${path.sep}`))) {
    throw new Error('output path must be outside the signed root');
  }
  try {
    await fs.promises.lstat(resolvedOut);
    throw new Error(`output already exists: ${resolvedOut}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const evidence = await verifyFinalNativeSignatures(input, dependencies);
  await writeCanonicalJson(resolvedOut, evidence);
  return evidence;
}

export function parseFinalNativeSignatureArgs(argv) {
  const allowed = new Set([
    '--platform',
    '--candidate-sha',
    '--signed-root',
    '--zxp',
    '--dmg',
    '--out',
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const equal = item.indexOf('=');
    const key = equal === -1 ? item : item.slice(0, equal);
    const value = equal === -1 ? argv[++index] : item.slice(equal + 1);
    if (!allowed.has(key) || !value || values.has(key)) {
      throw new Error(`invalid argument: ${String(item)}`);
    }
    values.set(key, value);
  }
  for (const required of ['--platform', '--candidate-sha', '--signed-root', '--zxp', '--out']) {
    if (!values.has(required)) throw new Error(`${required} is required`);
  }
  const platform = values.get('--platform');
  const dmgPath = values.get('--dmg');
  if (platform === 'macos-arm64' && !dmgPath) throw new Error('--dmg is required for macOS');
  if (platform === 'windows-x64' && dmgPath) throw new Error('--dmg is forbidden for Windows');
  const parsed = {
    platform,
    candidateSha: values.get('--candidate-sha'),
    signedRoot: values.get('--signed-root'),
    zxpPath: values.get('--zxp'),
    ...(dmgPath ? { dmgPath } : {}),
    outPath: values.get('--out'),
  };
  validateInput(parsed);
  if (path.resolve(parsed.outPath) !== parsed.outPath) {
    throw new Error('--out must be absolute');
  }
  return parsed;
}

async function main() {
  await writeFinalNativeSignatureEvidence(
    parseFinalNativeSignatureArgs(process.argv.slice(2)),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`FINAL_NATIVE_SIGNATURES_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
