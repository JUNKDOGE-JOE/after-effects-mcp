import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

import { canonicalJson, validateBundleManifest } from '../package/lib/manifest.mjs';
import { validateSigningReport } from './signing-report.mjs';

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DECIMAL_ID = /^\d+$/;
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
const ROLES = new Set(['dmg', 'zxp']);
const REQUIRED_EVIDENCE_PLATFORMS = ['macos-arm64', 'windows-x64'];
const PRODUCT_SCENARIOS = [
  'clean-install-and-upgrade-rollback',
  'permission-denial-and-recovery',
  'persistence',
  'provider-header-routing',
  'tool-library',
];
const MAX_HASH_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_EVIDENCE_JSON_BYTES = 8 * 1024 * 1024;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
export const EVIDENCE_DIGEST_FIELDS = Object.freeze([
  'bundleManifest',
  'nativeSignatureEvidence',
  'signedBundleManifest',
  'signingReport',
]);
const EVIDENCE_FIELDS = Object.freeze([
  ...EVIDENCE_DIGEST_FIELDS,
  'platform',
  'sha256',
]);
const ARTIFACT_FIELDS = Object.freeze(['artifactId', 'name', 'platform', 'role', 'sha256']);
const TOP_LEVEL_FIELDS = Object.freeze([
  'artifacts',
  'candidateSha',
  'evidence',
  'productAcceptanceEvidence',
  'productAcceptanceSha256',
  'schemaVersion',
  'version',
  'workflowRunId',
]);

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function canonicalStringify(value) {
  return `${JSON.stringify(sortValue(value))}\n`;
}

function artifactNameKey(name) {
  return String(name).toLocaleLowerCase('en-US');
}

function safeArtifactName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && name === name.trim()
    && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

function untrustedFile(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'AE_MCP_UNTRUSTED_FILE';
  return error;
}

function unchangedFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readJsonEvidence(filePath, field) {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > BigInt(MAX_EVIDENCE_JSON_BYTES)) {
    throw untrustedFile(`evidence JSON must be one bounded regular file: ${field}`);
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !unchangedFile(before, opened)) {
      throw untrustedFile(`evidence JSON changed before reading: ${field}`);
    }
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) break;
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (position !== bytes.length || !unchangedFile(opened, after)) {
      throw untrustedFile(`evidence JSON changed while reading: ${field}`);
    }
    const value = JSON.parse(STRICT_UTF8.decode(bytes));
    if (!bytes.equals(Buffer.from(canonicalEvidenceJson(field, value), 'utf8'))) {
      throw untrustedFile(`evidence JSON is not canonical: ${field}`);
    }
    return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}

function canonicalEvidenceJson(field, value) {
  return field === 'signingReport' ? canonicalStringify(value) : canonicalJson(value);
}

export async function sha256File(filePath) {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw untrustedFile('path must identify one regular file');
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !unchangedFile(before, opened)) {
      throw untrustedFile('file changed before hashing');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(MAX_HASH_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!unchangedFile(opened, after)) throw untrustedFile('file changed while hashing');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function expectedSigningOutputs(artifacts, platform) {
  return artifacts.filter((artifact) => artifact.platform === platform).map((artifact) => ({
    name: artifact.name,
    role: artifact.role,
    sha256: artifact.sha256,
  })).sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

function assertProductAcceptanceEvidence(value, candidateSha) {
  if (!hasExactKeys(value, ['candidateSha', 'coverage', 'result', 'schemaVersion'])
      || value.schemaVersion !== 1 || value.candidateSha !== candidateSha
      || value.result !== 'PASS' || !Array.isArray(value.coverage)) {
    throw new Error('product acceptance evidence identity mismatch');
  }
  const actualIds = value.coverage.map((item) => item?.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(PRODUCT_SCENARIOS)
      || value.coverage.some((item) => !hasExactKeys(item, ['evidenceSha256', 'id', 'result'])
        || item.result !== 'PASS' || !DIGEST.test(item.evidenceSha256 ?? ''))) {
    throw new Error('product acceptance coverage is incomplete or invalid');
  }
}

function assertNativeSignatureEvidence(record, platform, candidateSha, artifacts) {
  const value = record.nativeSignatureEvidence;
  const keys = [
    'artifacts', 'candidateSha', 'discoveredNativeCount', 'files', 'finalRootSha256',
    'platform', 'result', 'schemaVersion', 'signedBundleManifestSha256',
  ];
  if (!hasExactKeys(value, keys) || value.schemaVersion !== 1 || value.platform !== platform
      || value.candidateSha !== candidateSha || value.result !== 'PASS'
      || value.signedBundleManifestSha256 !== record.sha256.signedBundleManifest
      || !Number.isSafeInteger(value.discoveredNativeCount) || value.discoveredNativeCount < 0
      || !Array.isArray(value.files) || value.files.length !== value.discoveredNativeCount
      || !Array.isArray(value.artifacts)) {
    throw new Error('final native signature evidence identity mismatch');
  }
  const finalFiles = new Map(record.signedBundleManifest.files.map((item) => [item.path, item]));
  const expectedKind = platform === 'macos-arm64' ? 'codesign' : 'authenticode';
  let previous = '';
  for (const item of value.files) {
    if (!hasExactKeys(item, ['path', 'sha256', 'signatureKind', 'signerFingerprint', 'verified'])
        || !item.path || (previous && item.path <= previous)
        || !DIGEST.test(item.sha256 ?? '') || item.signatureKind !== expectedKind
        || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(item.signerFingerprint ?? '')
        || item.verified !== true || finalFiles.get(item.path)?.sha256 !== item.sha256) {
      throw new Error('final native signature file coverage is invalid');
    }
    previous = item.path;
  }
  const expectedArtifacts = expectedSigningOutputs(artifacts, platform);
  const actualArtifacts = value.artifacts.map((item) => ({
    name: item?.name,
    role: item?.role,
    sha256: item?.sha256,
  })).sort((left, right) => String(left.name).localeCompare(String(right.name), 'en'));
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error('final native signature evidence artifact mismatch');
  }
}

function assertEvidenceIdentity(record, platform, candidateSha, artifacts) {
  if (!hasExactKeys(record, EVIDENCE_FIELDS)
      || !hasExactKeys(record.sha256, EVIDENCE_DIGEST_FIELDS)
      || EVIDENCE_DIGEST_FIELDS.some((field) => !DIGEST.test(record.sha256[field] ?? ''))) {
    throw new Error('evidence record schema mismatch');
  }
  for (const field of EVIDENCE_DIGEST_FIELDS) {
    if (createHash('sha256').update(canonicalEvidenceJson(field, record[field])).digest('hex')
        !== record.sha256[field]) {
      throw new Error(`embedded evidence digest mismatch: ${field}`);
    }
  }
  validateBundleManifest(record.bundleManifest);
  validateBundleManifest(record.signedBundleManifest);
  validateSigningReport(record.signingReport);
  if (record.platform !== platform || record.bundleManifest.platform !== platform
      || record.signedBundleManifest.platform !== platform
      || record.bundleManifest.sourceCommitSha !== candidateSha
      || record.signedBundleManifest.sourceCommitSha !== candidateSha
      || record.signedBundleManifest.version !== record.bundleManifest.version
      || record.signingReport.platform !== platform
      || record.signingReport.candidateSha !== candidateSha
      || record.signingReport.result !== 'PASS'
      || record.signingReport.signedBundleManifestSha256 !== record.sha256.signedBundleManifest) {
    throw new Error('evidence identity mismatch');
  }
  assertNativeSignatureEvidence(record, platform, candidateSha, artifacts);
  const actualOutputs = record.signingReport.outputs.map((output) => ({
    name: output?.name,
    role: output?.role,
    sha256: output?.sha256,
  })).sort((left, right) => String(left.name).localeCompare(String(right.name), 'en'));
  if (JSON.stringify(actualOutputs) !== JSON.stringify(expectedSigningOutputs(artifacts, platform))) {
    throw new Error('signing report output mismatch');
  }
}

function validateArtifactShape(item) {
  if (!safeArtifactName(item?.name)) throw new Error('artifact name must be a basename');
  if (!PLATFORMS.has(item?.platform)) throw new Error('invalid artifact platform');
  if (!DECIMAL_ID.test(String(item?.artifactId ?? ''))) throw new Error('invalid artifact id');
  if (!ROLES.has(item?.role)) throw new Error('invalid artifact role');
  if (typeof item?.path !== 'string' || item.path.length === 0) {
    throw new Error('artifact path is required');
  }
}

export function validateArtifactManifestStructure(manifest) {
  const errors = [];
  if (!hasExactKeys(manifest, TOP_LEVEL_FIELDS)) errors.push('artifact manifest top-level schema mismatch');
  if (manifest?.schemaVersion !== 1 || !VERSION.test(String(manifest?.version ?? ''))
      || !SHA.test(String(manifest?.candidateSha ?? ''))
      || !DECIMAL_ID.test(String(manifest?.workflowRunId ?? ''))) {
    errors.push('invalid manifest identity');
  }
  try {
    if (!DIGEST.test(manifest?.productAcceptanceSha256 ?? '')
        || createHash('sha256').update(canonicalJson(manifest.productAcceptanceEvidence)).digest('hex')
          !== manifest.productAcceptanceSha256) {
      throw new Error('product acceptance evidence digest mismatch');
    }
    assertProductAcceptanceEvidence(manifest.productAcceptanceEvidence, manifest.candidateSha);
  } catch (error) {
    errors.push(error.message);
  }
  if (!Array.isArray(manifest?.artifacts) || manifest.artifacts.length === 0) {
    errors.push('at least one artifact is required');
  } else {
    let previousName = '';
    const names = new Set();
    for (const item of manifest.artifacts) {
      const name = String(item?.name ?? '');
      if (!hasExactKeys(item, ARTIFACT_FIELDS)) errors.push(`artifact record schema mismatch: ${name}`);
      if (!safeArtifactName(item?.name) || names.has(artifactNameKey(name))) {
        errors.push(`invalid or duplicate artifact name: ${name}`);
      }
      names.add(artifactNameKey(name));
      if (previousName && name <= previousName) errors.push('artifact inventory is not sorted');
      previousName = name;
      if (!PLATFORMS.has(item?.platform)) errors.push(`invalid artifact platform: ${name}`);
      if (!DECIMAL_ID.test(String(item?.artifactId ?? ''))) errors.push(`invalid artifact id: ${name}`);
      if (!ROLES.has(item?.role)) errors.push(`invalid artifact role: ${name}`);
      if (!DIGEST.test(item?.sha256 ?? '')) errors.push(`invalid digest: ${name}`);
    }
  }
  const evidence = Array.isArray(manifest?.evidence) ? manifest.evidence : [];
  if (JSON.stringify(evidence.map((item) => item?.platform))
      !== JSON.stringify(REQUIRED_EVIDENCE_PLATFORMS)) {
    errors.push('missing dual-platform build evidence');
  }
  for (const item of evidence) {
    try {
      assertEvidenceIdentity(item, item?.platform, manifest?.candidateSha, manifest?.artifacts ?? []);
    } catch (error) {
      errors.push(`${error.message}: ${String(item?.platform ?? 'unknown')}`);
    }
  }
  return errors;
}

export function serializeArtifactManifest(manifest) {
  const bytes = Buffer.from(canonicalStringify(manifest), 'utf8');
  if (bytes.length > MAX_ARTIFACT_MANIFEST_BYTES) throw new Error('artifact manifest exceeds 64 MiB');
  const errors = validateArtifactManifestStructure(manifest);
  if (errors.length) throw new Error(`artifact manifest is invalid: ${errors.join('; ')}`);
  return bytes;
}

export async function buildArtifactManifest(input = {}) {
  const version = String(input.version ?? '');
  const candidateSha = String(input.candidateSha ?? '');
  const workflowRunId = String(input.workflowRunId ?? '');
  if (!VERSION.test(version)) throw new Error('invalid version');
  if (!SHA.test(candidateSha)) throw new Error('invalid candidate SHA');
  if (!DECIMAL_ID.test(workflowRunId)) throw new Error('invalid workflow run id');
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    throw new Error('at least one artifact is required');
  }
  input.artifacts.forEach(validateArtifactShape);
  if (!Array.isArray(input.evidence) || input.evidence.length !== 2) {
    throw new Error('exactly one evidence record is required for each platform');
  }
  const evidencePlatforms = input.evidence.map((item) => item?.platform).sort();
  if (JSON.stringify(evidencePlatforms) !== JSON.stringify(REQUIRED_EVIDENCE_PLATFORMS)) {
    throw new Error('exactly one evidence record is required for each platform');
  }
  const artifacts = [];
  for (const item of input.artifacts) {
    artifacts.push({
      artifactId: String(item.artifactId),
      name: item.name,
      platform: item.platform,
      role: item.role,
      sha256: await sha256File(item.path),
    });
  }
  artifacts.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const productAcceptance = await readJsonEvidence(
    input.productAcceptanceEvidencePath,
    'productAcceptanceEvidence',
  );
  assertProductAcceptanceEvidence(productAcceptance.value, candidateSha);
  const evidence = [];
  for (const item of input.evidence) {
    const sources = {
      bundleManifest: await readJsonEvidence(item.bundleManifestPath, 'bundleManifest'),
      signedBundleManifest: await readJsonEvidence(
        item.signedBundleManifestPath,
        'signedBundleManifest',
      ),
      nativeSignatureEvidence: await readJsonEvidence(
        item.nativeSignatureEvidencePath,
        'nativeSignatureEvidence',
      ),
      signingReport: await readJsonEvidence(item.signingReportPath, 'signingReport'),
    };
    const record = {
      platform: item.platform,
      bundleManifest: sources.bundleManifest.value,
      signedBundleManifest: sources.signedBundleManifest.value,
      nativeSignatureEvidence: sources.nativeSignatureEvidence.value,
      signingReport: sources.signingReport.value,
      sha256: Object.fromEntries(
        EVIDENCE_DIGEST_FIELDS.map((field) => [field, sources[field].sha256]),
      ),
    };
    assertEvidenceIdentity(record, item.platform, candidateSha, artifacts);
    evidence.push(record);
  }
  evidence.sort((left, right) => left.platform.localeCompare(right.platform, 'en'));
  const manifest = {
    schemaVersion: 1,
    version,
    candidateSha,
    workflowRunId,
    artifacts,
    evidence,
    productAcceptanceEvidence: productAcceptance.value,
    productAcceptanceSha256: productAcceptance.sha256,
  };
  serializeArtifactManifest(manifest);
  return manifest;
}

export async function verifyArtifactManifest(manifest, root) {
  const errors = validateArtifactManifestStructure(manifest);
  if (errors.length) return errors;
  for (const item of manifest.artifacts) {
    try {
      if (await sha256File(join(root, item.name)) !== item.sha256) {
        errors.push(`sha256 mismatch: ${item.name}`);
      }
    } catch {
      errors.push(`unable to hash artifact: ${item.name}`);
    }
  }
  return errors;
}
