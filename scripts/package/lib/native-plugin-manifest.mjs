import fs from 'node:fs';
import path from 'node:path';

import { verifyMacPlugin } from '../../../native/ae-plugin/verify-macos.mjs';
import {
  NATIVE_PLUGIN_MANIFEST_PATH,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  bundleError,
  canonicalJson,
  copyRegularFileStable,
  copyTree,
  readCanonicalJsonFile,
  readJsonFile,
  sha256Bytes,
  sha256File,
  writeCanonicalJson,
} from './manifest.mjs';

export const NATIVE_PLUGIN_ROOT = path.posix.dirname(NATIVE_PLUGIN_MANIFEST_PATH);
export const NATIVE_PLUGIN_MANIFEST_NAME = path.posix.basename(NATIVE_PLUGIN_MANIFEST_PATH);
export const NATIVE_PLUGIN_PAYLOAD_ROOT = 'payload';
export const NATIVE_PLUGIN_BUNDLE_NAME = 'AeMcpNative.plugin';
export const NATIVE_PLUGIN_RECEIPT_NAME = 'build-receipt.json';

const NATIVE_PLUGIN_MANIFEST_RELATIVE = NATIVE_PLUGIN_MANIFEST_PATH;
const BUNDLE_RELATIVE = NATIVE_PLUGIN_PAYLOAD_ROOT + '/' + NATIVE_PLUGIN_BUNDLE_NAME;
const RECEIPT_RELATIVE = NATIVE_PLUGIN_PAYLOAD_ROOT + '/' + NATIVE_PLUGIN_RECEIPT_NAME;
const EXECUTABLE_RELATIVE =
  BUNDLE_RELATIVE + '/Contents/MacOS/AeMcpNative';
const PIPL_RELATIVE =
  BUNDLE_RELATIVE + '/Contents/Resources/AeMcpNative.rsrc';
const PIPL_COMPATIBILITY_VERSION = 0x00010000;
const SDK_NAME = 'Adobe After Effects C/C++ Plug-in SDK';
const SDK_VERSION = '25.6.61';
const SDK_BUILD = 61;
const PRODUCT_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function nativeError(code, message) {
  return bundleError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(
  value,
  expected,
  label,
  code = 'BUNDLE_NATIVE_PLUGIN_MANIFEST_INVALID',
) {
  if (!isRecord(value)
      || JSON.stringify(Object.keys(value).sort())
        !== JSON.stringify([...expected].sort())) {
    throw nativeError(
      code,
      label + ' has an unexpected shape',
    );
  }
}

function validateNativeArtifact(value, label) {
  assertExactKeys(
    value,
    [
      'architecture',
      'bundleName',
      'bundleTreeSha256',
      'bundleType',
      'codeSignature',
      'entryPoint',
      'executableSha256',
      'fileCount',
      'piplSha256',
      'platform',
      'schemaVersion',
    ],
    label,
    'BUNDLE_NATIVE_PLUGIN_ARTIFACT_INVALID',
  );
  if (value.schemaVersion !== 1
      || value.bundleName !== NATIVE_PLUGIN_BUNDLE_NAME
      || value.platform !== 'macos-arm64'
      || value.architecture !== 'arm64'
      || value.bundleType !== 'AEgx'
      || value.entryPoint !== 'AeMcpNativeMain'
      || value.codeSignature !== 'ad-hoc-verified'
      || value.fileCount !== 5
      || !SHA256_PATTERN.test(value.bundleTreeSha256 ?? '')
      || !SHA256_PATTERN.test(value.executableSha256 ?? '')
      || !SHA256_PATTERN.test(value.piplSha256 ?? '')) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_ARTIFACT_INVALID',
      label + ' is not a supported macOS AEGP artifact',
    );
  }
  return value;
}

export function validateNativeBuildReceipt(value) {
  assertExactKeys(
    value,
    [
      'artifact',
      'build',
      'productVersion',
      'protocolSchemaSha256',
      'schemaVersion',
      'sdk',
      'source',
      'sourceCommit',
    ],
    'native build receipt',
    'BUNDLE_NATIVE_PLUGIN_RECEIPT_INVALID',
  );
  assertExactKeys(
    value.source,
    ['commit', 'repositoryClean'],
    'native build receipt source',
    'BUNDLE_NATIVE_PLUGIN_RECEIPT_INVALID',
  );
  assertExactKeys(
    value.sdk,
    [
      'archiveVerification',
      'claimedBuild',
      'claimedVersion',
      'inputProvenance',
      'materialIncluded',
      'name',
      'rootVerification',
    ],
    'native build receipt SDK evidence',
    'BUNDLE_NATIVE_PLUGIN_RECEIPT_INVALID',
  );
  assertExactKeys(
    value.build,
    [
      'compatibilityEvidence',
      'configuration',
      'distributionApproved',
      'runtimeEvidence',
      'signing',
    ],
    'native build receipt build evidence',
    'BUNDLE_NATIVE_PLUGIN_RECEIPT_INVALID',
  );
  validateNativeArtifact(value.artifact, 'native build receipt artifact');
  if (value.schemaVersion !== 1
      || !PRODUCT_VERSION_PATTERN.test(value.productVersion ?? '')
      || !SOURCE_SHA_PATTERN.test(value.sourceCommit ?? '')
      || value.source.commit !== value.sourceCommit
      || value.source.repositoryClean !== true
      || !SHA256_PATTERN.test(value.protocolSchemaSha256 ?? '')
      || value.sdk.name !== SDK_NAME
      || value.sdk.claimedVersion !== SDK_VERSION
      || value.sdk.claimedBuild !== SDK_BUILD
      || value.sdk.materialIncluded !== false
      || value.sdk.archiveVerification !== 'sha256-verified'
      || value.sdk.rootVerification !== 'layout-and-content-verified'
      || value.sdk.inputProvenance
        !== 'archive-byte-identity-plus-canonical-root-content'
      || value.build.configuration !== 'development'
      || value.build.signing !== 'ad-hoc'
      || value.build.distributionApproved !== false
      || value.build.runtimeEvidence !== false
      || value.build.compatibilityEvidence !== false) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_RECEIPT_INVALID',
      'native build receipt evidence is invalid',
    );
  }
  return value;
}

export function validateNativePluginManifest(value) {
  assertExactKeys(
    value,
    [
      'architecture',
      'artifact',
      'build',
      'platform',
      'productVersion',
      'protocol',
      'schemaVersion',
      'sdk',
      'sourceCommitSha',
    ],
    'native plug-in manifest',
  );
  assertExactKeys(
    value.artifact,
    [
      'bundleIdentifier',
      'bundleName',
      'bundlePath',
      'bundleTreeSha256',
      'bundleType',
      'entryPoint',
      'executablePath',
      'executableSha256',
      'fileCount',
      'payloadRoot',
      'piplCompatibilityVersion',
      'piplPath',
      'piplResourceId',
      'piplSha256',
      'receiptPath',
      'receiptSha256',
    ],
    'native plug-in manifest artifact',
  );
  assertExactKeys(
    value.sdk,
    [
      'archiveSha256',
      'claimedBuild',
      'claimedVersion',
      'materialIncluded',
      'name',
      'policySha256',
      'rootContentSha256',
      'verification',
    ],
    'native plug-in manifest SDK evidence',
  );
  assertExactKeys(value.protocol, ['schemaSha256'], 'native plug-in protocol evidence');
  assertExactKeys(
    value.build,
    ['configuration', 'distributionApproved', 'signatureVerification', 'signing'],
    'native plug-in build evidence',
  );
  if (value.schemaVersion !== 1
      || !PRODUCT_VERSION_PATTERN.test(value.productVersion ?? '')
      || !SOURCE_SHA_PATTERN.test(value.sourceCommitSha ?? '')
      || value.platform !== 'macos-arm64'
      || value.architecture !== 'arm64'
      || value.artifact.payloadRoot !== NATIVE_PLUGIN_PAYLOAD_ROOT
      || value.artifact.bundlePath !== BUNDLE_RELATIVE
      || value.artifact.receiptPath !== RECEIPT_RELATIVE
      || !SHA256_PATTERN.test(value.artifact.receiptSha256 ?? '')
      || value.artifact.bundleName !== NATIVE_PLUGIN_BUNDLE_NAME
      || value.artifact.bundleIdentifier !== 'dev.aemcp.native-plugin'
      || value.artifact.bundleType !== 'AEgx'
      || value.artifact.entryPoint !== 'AeMcpNativeMain'
      || value.artifact.fileCount !== 5
      || !SHA256_PATTERN.test(value.artifact.bundleTreeSha256 ?? '')
      || value.artifact.executablePath !== EXECUTABLE_RELATIVE
      || !SHA256_PATTERN.test(value.artifact.executableSha256 ?? '')
      || value.artifact.piplPath !== PIPL_RELATIVE
      || value.artifact.piplResourceId !== 16000
      || value.artifact.piplCompatibilityVersion !== PIPL_COMPATIBILITY_VERSION
      || !SHA256_PATTERN.test(value.artifact.piplSha256 ?? '')
      || value.sdk.name !== SDK_NAME
      || value.sdk.claimedVersion !== SDK_VERSION
      || value.sdk.claimedBuild !== SDK_BUILD
      || !SHA256_PATTERN.test(value.sdk.policySha256 ?? '')
      || !SHA256_PATTERN.test(value.sdk.archiveSha256 ?? '')
      || !SHA256_PATTERN.test(value.sdk.rootContentSha256 ?? '')
      || value.sdk.verification
        !== 'archive-byte-identity-plus-canonical-root-content'
      || value.sdk.materialIncluded !== false
      || !SHA256_PATTERN.test(value.protocol.schemaSha256 ?? '')
      || value.build.configuration !== 'development'
      || value.build.signing !== 'ad-hoc'
      || value.build.signatureVerification !== 'ad-hoc-verified'
      || value.build.distributionApproved !== false) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_MANIFEST_INVALID',
      'native plug-in manifest identity is invalid',
    );
  }
  return value;
}

async function assertExactDirectoryEntries(directory, expected, label) {
  const metadata = await fs.promises.lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_INPUT_MISSING',
      label + ' directory is missing or symbolic',
    );
  }
  const entries = (await fs.promises.readdir(directory)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(entries) !== JSON.stringify(wanted)) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_FILE_SET_MISMATCH',
      label + ' file set is not exact',
    );
  }
}

async function candidateEvidence(repoRoot) {
  const policyPath = path.join(repoRoot, 'packaging', 'ae-sdk-inputs.json');
  const protocolPath = path.join(
    repoRoot,
    'native',
    'ae-plugin',
    'protocol',
    'aegp-rpc.schema.json',
  );
  const policy = await readJsonFile(policyPath, 'BUNDLE_NATIVE_PLUGIN_SDK_INVALID');
  const mac = policy?.sdk?.platforms?.['macos-arm64'];
  if (policy?.schemaVersion !== 1
      || policy.sdk?.name !== SDK_NAME
      || policy.sdk?.claimedVersion !== SDK_VERSION
      || policy.sdk?.claimedBuild !== SDK_BUILD
      || !SHA256_PATTERN.test(mac?.archive?.sha256 ?? '')
      || mac?.rootContentLock?.status !== 'canonical-file-tree-verified'
      || !SHA256_PATTERN.test(mac?.rootContentLock?.sha256 ?? '')) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_SDK_INVALID',
      'candidate SDK policy does not contain the locked macOS SDK evidence',
    );
  }
  return Object.freeze({
    policySha256: sha256Bytes(Buffer.from(canonicalJson(policy), 'utf8')),
    archiveSha256: mac.archive.sha256,
    rootContentSha256: mac.rootContentLock.sha256,
    protocolSchemaSha256: await sha256File(protocolPath),
  });
}

function assertReceiptMatchesCandidate(
  receipt,
  expectedVersion,
  expectedSourceCommit,
  evidence,
) {
  if (receipt.productVersion !== expectedVersion) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_VERSION_MISMATCH',
      'native product version does not match the platform bundle',
    );
  }
  if (receipt.sourceCommit !== expectedSourceCommit) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_SOURCE_MISMATCH',
      'native source commit does not match the platform bundle',
    );
  }
  if (receipt.protocolSchemaSha256 !== evidence.protocolSchemaSha256) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_PROTOCOL_MISMATCH',
      'native RPC protocol digest does not match the candidate schema',
    );
  }
}

function verifierFrom(dependencies) {
  const verifier = dependencies?.verifyMacPlugin ?? verifyMacPlugin;
  if (typeof verifier !== 'function') {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_VERIFIER_INVALID',
      'native plug-in verifier dependency is invalid',
    );
  }
  return verifier;
}

function sameCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

async function assertEmbeddedSourceCommit(bundlePath, sourceCommit) {
  const executable = path.join(bundlePath, 'Contents', 'MacOS', 'AeMcpNative');
  const metadata = await fs.promises.lstat(executable).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size <= 0 || metadata.size > 128 * 1024 * 1024) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_ARTIFACT_INVALID',
      'native executable is not a bounded regular file',
    );
  }
  const bytes = await fs.promises.readFile(executable);
  if (!bytes.includes(Buffer.from(sourceCommit, 'ascii'))) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_SOURCE_MISMATCH',
      'native executable does not embed the exact source commit',
    );
  }
}

function manifestFor(receipt, receiptSha256, evidence) {
  return validateNativePluginManifest({
    schemaVersion: 1,
    productVersion: receipt.productVersion,
    sourceCommitSha: receipt.sourceCommit,
    platform: 'macos-arm64',
    architecture: 'arm64',
    artifact: {
      payloadRoot: NATIVE_PLUGIN_PAYLOAD_ROOT,
      bundlePath: BUNDLE_RELATIVE,
      receiptPath: RECEIPT_RELATIVE,
      receiptSha256,
      bundleName: NATIVE_PLUGIN_BUNDLE_NAME,
      bundleIdentifier: 'dev.aemcp.native-plugin',
      bundleType: receipt.artifact.bundleType,
      entryPoint: receipt.artifact.entryPoint,
      fileCount: receipt.artifact.fileCount,
      bundleTreeSha256: receipt.artifact.bundleTreeSha256,
      executablePath: EXECUTABLE_RELATIVE,
      executableSha256: receipt.artifact.executableSha256,
      piplPath: PIPL_RELATIVE,
      piplResourceId: 16000,
      piplCompatibilityVersion: PIPL_COMPATIBILITY_VERSION,
      piplSha256: receipt.artifact.piplSha256,
    },
    sdk: {
      name: SDK_NAME,
      claimedVersion: SDK_VERSION,
      claimedBuild: SDK_BUILD,
      policySha256: evidence.policySha256,
      archiveSha256: evidence.archiveSha256,
      rootContentSha256: evidence.rootContentSha256,
      verification: 'archive-byte-identity-plus-canonical-root-content',
      materialIncluded: false,
    },
    protocol: {
      schemaSha256: evidence.protocolSchemaSha256,
    },
    build: {
      configuration: receipt.build.configuration,
      signing: receipt.build.signing,
      signatureVerification: receipt.artifact.codeSignature,
      distributionApproved: receipt.build.distributionApproved,
    },
  });
}

function assertManifestMatchesReceipt(manifest, receipt, evidence) {
  const expected = manifestFor(receipt, manifest.artifact.receiptSha256, evidence);
  if (!sameCanonical(manifest, expected)) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_EVIDENCE_MISMATCH',
      'native manifest does not match the build receipt and candidate evidence',
    );
  }
}

async function verifyArtifact(bundlePath, receipt, dependencies) {
  const actual = validateNativeArtifact(
    await verifierFrom(dependencies)({
      bundlePath,
      expectedProductVersion: receipt.productVersion,
    }),
    'observed native artifact',
  );
  if (!sameCanonical(actual, receipt.artifact)) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_ARTIFACT_MISMATCH',
      'observed native artifact does not match its build receipt',
    );
  }
  await assertEmbeddedSourceCommit(bundlePath, receipt.sourceCommit);
  return actual;
}

export async function verifyNativePluginStage({
  root,
  productVersion,
  sourceCommitSha,
  candidateRepoRoot,
  dependencies = {},
} = {}) {
  const nativeRoot = path.resolve(String(root ?? ''));
  await assertExactDirectoryEntries(
    nativeRoot,
    [NATIVE_PLUGIN_MANIFEST_NAME, NATIVE_PLUGIN_PAYLOAD_ROOT],
    'native plug-in stage',
  );
  const payloadRoot = path.join(nativeRoot, NATIVE_PLUGIN_PAYLOAD_ROOT);
  await assertExactDirectoryEntries(
    payloadRoot,
    [NATIVE_PLUGIN_BUNDLE_NAME, NATIVE_PLUGIN_RECEIPT_NAME],
    'native plug-in payload',
  );
  const manifestPath = path.join(nativeRoot, NATIVE_PLUGIN_MANIFEST_NAME);
  const manifest = validateNativePluginManifest(
    await readCanonicalJsonFile(manifestPath),
  );
  if (manifest.productVersion !== productVersion) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_VERSION_MISMATCH',
      'native manifest version does not match the platform bundle',
    );
  }
  if (manifest.sourceCommitSha !== sourceCommitSha) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_SOURCE_MISMATCH',
      'native manifest source does not match the platform bundle',
    );
  }
  const evidence = await candidateEvidence(path.resolve(String(candidateRepoRoot ?? '')));
  const receiptPath = path.join(payloadRoot, NATIVE_PLUGIN_RECEIPT_NAME);
  if (await sha256File(receiptPath) !== manifest.artifact.receiptSha256) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_HASH_MISMATCH',
      'native build receipt digest does not match its manifest',
    );
  }
  const receipt = validateNativeBuildReceipt(
    await readJsonFile(receiptPath, 'BUNDLE_NATIVE_PLUGIN_RECEIPT_INVALID'),
  );
  assertReceiptMatchesCandidate(receipt, productVersion, sourceCommitSha, evidence);
  assertManifestMatchesReceipt(manifest, receipt, evidence);
  await verifyArtifact(
    path.join(payloadRoot, NATIVE_PLUGIN_BUNDLE_NAME),
    receipt,
    dependencies,
  );
  return manifest;
}

export async function stageNativePluginArtifact({
  sourceRoot,
  destinationRoot,
  productVersion,
  sourceCommitSha,
  candidateRepoRoot,
  dependencies = {},
} = {}) {
  if (!PRODUCT_VERSION_PATTERN.test(productVersion ?? '')) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_VERSION_MISMATCH',
      'native stage requires a semantic product version',
    );
  }
  if (!SOURCE_SHA_PATTERN.test(sourceCommitSha ?? '')) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_SOURCE_MISMATCH',
      'native stage requires a full source commit',
    );
  }
  const source = path.resolve(String(sourceRoot ?? ''));
  const destination = path.resolve(String(destinationRoot ?? ''));
  await assertExactDirectoryEntries(
    source,
    [NATIVE_PLUGIN_BUNDLE_NAME, NATIVE_PLUGIN_RECEIPT_NAME],
    'native build output',
  );
  const evidence = await candidateEvidence(path.resolve(String(candidateRepoRoot ?? '')));
  const sourceReceipt = validateNativeBuildReceipt(
    await readJsonFile(
      path.join(source, NATIVE_PLUGIN_RECEIPT_NAME),
      'BUNDLE_NATIVE_PLUGIN_RECEIPT_INVALID',
    ),
  );
  assertReceiptMatchesCandidate(
    sourceReceipt,
    productVersion,
    sourceCommitSha,
    evidence,
  );
  await verifyArtifact(
    path.join(source, NATIVE_PLUGIN_BUNDLE_NAME),
    sourceReceipt,
    dependencies,
  );
  const existing = await fs.promises.lstat(destination).catch(() => null);
  if (existing) {
    throw nativeError(
      'BUNDLE_NATIVE_PLUGIN_OUTPUT_EXISTS',
      'native stage output already exists',
    );
  }
  try {
    const payloadRoot = path.join(destination, NATIVE_PLUGIN_PAYLOAD_ROOT);
    await fs.promises.mkdir(payloadRoot, { recursive: true });
    await copyTree(
      path.join(source, NATIVE_PLUGIN_BUNDLE_NAME),
      path.join(payloadRoot, NATIVE_PLUGIN_BUNDLE_NAME),
    );
    await copyRegularFileStable(
      path.join(source, NATIVE_PLUGIN_RECEIPT_NAME),
      path.join(payloadRoot, NATIVE_PLUGIN_RECEIPT_NAME),
    );
    const receiptSha256 = await sha256File(
      path.join(payloadRoot, NATIVE_PLUGIN_RECEIPT_NAME),
    );
    const manifest = manifestFor(sourceReceipt, receiptSha256, evidence);
    const manifestPath = path.join(destination, NATIVE_PLUGIN_MANIFEST_NAME);
    await writeCanonicalJson(manifestPath, manifest);
    await verifyNativePluginStage({
      root: destination,
      productVersion,
      sourceCommitSha,
      candidateRepoRoot,
      dependencies,
    });
    return Object.freeze({
      manifest,
      manifestPath,
      manifestRelativePath: NATIVE_PLUGIN_MANIFEST_RELATIVE,
      manifestSha256: await sha256File(manifestPath),
    });
  } catch (error) {
    await fs.promises.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
