import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  canonicalJson,
  validateBundleManifest,
} from '../package/lib/manifest.mjs';
import { validateRuntimeManifest } from '../package/lib/runtime-manifest.mjs';
import {
  validateLicenseInventory,
  validateRuntimeSpdx,
} from '../package/lib/runtime-evidence.mjs';
import { validateSigningReport } from './signing-report.mjs';

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DECIMAL_ID = /^\d+$/;
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
const ROLES = new Set(['install', 'payload']);
const REQUIRED_EVIDENCE_PLATFORMS = ['macos-arm64', 'windows-x64'];
const PRODUCT_SCENARIOS = [
  'clean-install-and-upgrade-rollback',
  'permission-denial-and-recovery',
  'persistence',
  'provider-header-routing',
  'tool-library',
];
const HASH_BUFFER_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_EVIDENCE_JSON_BYTES = 8 * 1024 * 1024;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
export const EVIDENCE_DIGEST_FIELDS = Object.freeze([
  'bundleManifest',
  'licenses',
  'nativeSignatureEvidence',
  'runtimeInventory',
  'sbom',
  'signedBundleManifest',
  'signingReport',
]);
const TOP_LEVEL_FIELDS = [
  'artifacts',
  'candidateSha',
  'evidence',
  'productAcceptanceEvidence',
  'productAcceptanceSha256',
  'schemaVersion',
  'version',
  'workflowRunId',
];
const ARTIFACT_FIELDS = ['artifactId', 'name', 'platform', 'role', 'sha256'];
const EVIDENCE_FIELDS = [
  'bundleManifest',
  'licenses',
  'nativeSignatureEvidence',
  'platform',
  'runtimeInventory',
  'sbom',
  'sha256',
  'signedBundleManifest',
  'signingReport',
];

function hasExactKeys(value, keys) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function sortValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON requires plain objects');
    }
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
    );
  }
  throw new TypeError('canonical JSON contains an unsupported value');
}

function safeArtifactName(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 255) {
    return false;
  }
  if (value !== value.normalize('NFC') || value === '.' || value === '..') return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return posix.basename(value) === value && win32.basename(value) === value;
}

function artifactNameKey(name) {
  return name.normalize('NFC').toLowerCase();
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(left, right) {
  return sameFile(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function untrustedFile(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'AE_MCP_UNTRUSTED_FILE';
  return error;
}

function canonicalEvidenceJson(field, value) {
  return ['nativeSignatureEvidence', 'productAcceptanceEvidence', 'signingReport'].includes(field)
    ? canonicalStringify(value)
    : canonicalJson(value);
}

function evidenceValueSha256(field, value) {
  return createHash('sha256').update(canonicalEvidenceJson(field, value)).digest('hex');
}

async function readJsonEvidence(path, field) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > BigInt(MAX_EVIDENCE_JSON_BYTES)) {
    throw untrustedFile('evidence JSON must be one bounded regular file');
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === 'ELOOP') throw untrustedFile('symbolic evidence JSON is not trusted', error);
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !unchangedFile(before, opened)) {
      throw untrustedFile('evidence JSON changed identity before reading');
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
      throw untrustedFile('evidence JSON changed while reading');
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

function expectedSigningOutputs(artifacts, platform) {
  return artifacts
    .filter((artifact) => artifact?.platform === platform)
    .map((artifact) => ({
      name: artifact.name,
      role: artifact.name.endsWith('.dmg') ? 'dmg' : 'zxp',
      sha256: artifact.sha256,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

function assertProductAcceptanceEvidence(value, candidateSha) {
  const keys = ['candidateSha', 'coverage', 'result', 'schemaVersion'];
  if (!hasExactKeys(value, keys)
      || value.schemaVersion !== 1 || value.candidateSha !== candidateSha
      || value.result !== 'PASS' || !Array.isArray(value.coverage)) {
    throw new Error('product acceptance evidence identity mismatch');
  }
  const actualIds = [];
  for (const item of value.coverage) {
    if (!hasExactKeys(item, ['evidenceSha256', 'id', 'result'])
        || typeof item.id !== 'string' || item.result !== 'PASS'
        || !DIGEST.test(item.evidenceSha256 || '')) {
      throw new Error('product acceptance coverage record is invalid');
    }
    actualIds.push(item.id);
  }
  if (JSON.stringify(actualIds) !== JSON.stringify(PRODUCT_SCENARIOS)) {
    throw new Error('product acceptance coverage is incomplete or unsorted');
  }
}

function assertNativeSignatureEvidence(record, platform, candidateSha, artifacts) {
  const value = record.nativeSignatureEvidence;
  const keys = [
    'artifacts', 'candidateSha', 'discoveredNativeCount', 'files', 'finalRootSha256',
    'platform', 'result', 'schemaVersion', 'signedBundleManifestSha256',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
      || value.schemaVersion !== 1 || value.platform !== platform
      || value.candidateSha !== candidateSha || value.result !== 'PASS'
      || value.signedBundleManifestSha256 !== record.sha256.signedBundleManifest
      || value.finalRootSha256 !== record.signingReport.finalRootSha256
      || !Number.isSafeInteger(value.discoveredNativeCount)
      || value.discoveredNativeCount < 2 || !Array.isArray(value.files)
      || value.files.length !== value.discoveredNativeCount
      || !Array.isArray(value.artifacts)) {
    throw new Error('final native signature evidence identity mismatch');
  }
  const finalFiles = new Map(record.signedBundleManifest.files.map((item) => [item.path, item]));
  const expectedKind = platform === 'macos-arm64' ? 'codesign' : 'authenticode';
  const requiredSuffixes = platform === 'macos-arm64'
    ? ['/bin/ae-mcp', '/bin/ae-mcp-platform-helper']
    : ['/bin/ae-mcp.exe', '/bin/ae-mcp-platform-helper.exe'];
  let previous = '';
  const seen = new Set();
  for (const item of value.files) {
    const itemKeys = ['path', 'sha256', 'signatureKind', 'signerFingerprint', 'verified'];
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(itemKeys)
        || typeof item.path !== 'string' || seen.has(item.path)
        || (previous && Buffer.compare(Buffer.from(item.path), Buffer.from(previous)) <= 0)
        || !DIGEST.test(item.sha256 || '') || item.signatureKind !== expectedKind
        || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(item.signerFingerprint || '')
        || item.verified !== true || finalFiles.get(item.path)?.sha256 !== item.sha256) {
      throw new Error('final native signature file coverage is invalid');
    }
    seen.add(item.path);
    previous = item.path;
  }
  if (requiredSuffixes.some((suffix) => ![...seen].some((item) => item.endsWith(suffix)))) {
    throw new Error('final helper or launcher signature coverage is missing');
  }
  const expectedArtifacts = expectedSigningOutputs(artifacts, platform)
    .map(({ name, sha256 }) => ({ name, sha256 }));
  const actualArtifacts = value.artifacts
    .map((item) => ({ name: item?.name, sha256: item?.sha256 }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name), 'en'));
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error('final native signature evidence artifact mismatch');
  }
}

function assertEvidenceIdentity(record, platform, candidateSha, artifacts) {
  if (!hasExactKeys(record, EVIDENCE_FIELDS)) {
    throw new Error('evidence record schema mismatch');
  }
  if (!record.sha256
      || JSON.stringify(Object.keys(record.sha256).sort())
        !== JSON.stringify(EVIDENCE_DIGEST_FIELDS)
      || EVIDENCE_DIGEST_FIELDS.some((field) => !DIGEST.test(record.sha256[field] ?? ''))) {
    throw new Error('evidence digest inventory mismatch');
  }
  for (const field of EVIDENCE_DIGEST_FIELDS) {
    if (evidenceValueSha256(field, record[field]) !== record.sha256[field]) {
      throw new Error(`embedded evidence digest mismatch: ${field}`);
    }
  }
  validateBundleManifest(record.bundleManifest);
  validateBundleManifest(record.signedBundleManifest);
  validateRuntimeManifest(record.runtimeInventory, platform);
  validateLicenseInventory(record.licenses, {
    platform,
    components: record.runtimeInventory.components,
    licenseApprovals: record.runtimeInventory.licenseApprovals,
    extractedLicenses: record.licenses?.extractedLicenses,
  });
  validateRuntimeSpdx(record.sbom, {
    platform,
    components: record.runtimeInventory.components,
    extractedLicenses: record.licenses?.extractedLicenses,
  });
  validateSigningReport(record.signingReport);
  if (
    record.bundleManifest?.schemaVersion !== 1
    || record.bundleManifest?.platform !== platform
    || record.bundleManifest?.sourceCommitSha !== candidateSha
    || record.signedBundleManifest?.schemaVersion !== 1
    || record.signedBundleManifest?.platform !== platform
    || record.signedBundleManifest?.sourceCommitSha !== candidateSha
    || record.signedBundleManifest?.version !== record.bundleManifest?.version
    || record.runtimeInventory?.schemaVersion !== 1
    || record.runtimeInventory?.platform !== platform
    || record.sbom?.spdxVersion !== 'SPDX-2.3'
    || record.licenses?.schemaVersion !== 1
    || record.licenses?.platform !== platform
    || record.signingReport?.schemaVersion !== 1
    || record.signingReport?.platform !== platform
    || record.signingReport?.candidateSha !== candidateSha
    || record.signingReport?.result !== 'PASS'
  ) {
    throw new Error('evidence identity mismatch');
  }
  if (record.bundleManifest.runtime?.manifestSha256 !== record.sha256.runtimeInventory) {
    throw new Error('runtime manifest digest mismatch');
  }
  if (record.bundleManifest.runtime?.sbomSha256 !== record.sha256.sbom) {
    throw new Error('runtime SBOM digest mismatch');
  }
  if (record.bundleManifest.runtime?.licenseInventorySha256 !== record.sha256.licenses) {
    throw new Error('runtime license inventory digest mismatch');
  }
  if (record.signingReport.sourceStageSha256 !== record.sha256.bundleManifest) {
    throw new Error('signing report source stage digest mismatch');
  }
  if (record.signingReport.signedBundleManifestSha256
      !== record.sha256.signedBundleManifest) {
    throw new Error('signing report signed bundle manifest digest mismatch');
  }
  if (record.signingReport.identity?.zxpPayloadSha256
      !== record.signingReport.finalRootSha256) {
    throw new Error('signing report final root identity mismatch');
  }
  assertNativeSignatureEvidence(record, platform, candidateSha, artifacts);
  const actualOutputs = Array.isArray(record.signingReport.outputs)
    ? record.signingReport.outputs.map((output) => ({
      name: output?.name,
      role: output?.role,
      sha256: output?.sha256,
    })).sort((left, right) => String(left.name).localeCompare(String(right.name), 'en'))
    : [];
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

export function canonicalStringify(value) {
  return `${JSON.stringify(sortValue(value))}\n`;
}

export function validateArtifactManifestStructure(manifest) {
  const errors = [];
  if (!hasExactKeys(manifest, TOP_LEVEL_FIELDS)) {
    errors.push('artifact manifest top-level schema mismatch');
  }
  if (
    manifest?.schemaVersion !== 1
    || !VERSION.test(String(manifest?.version ?? ''))
    || !SHA.test(String(manifest?.candidateSha ?? ''))
    || !DECIMAL_ID.test(String(manifest?.workflowRunId ?? ''))
  ) {
    errors.push('invalid manifest identity');
  }

  try {
    if (!DIGEST.test(manifest?.productAcceptanceSha256 || '')
        || evidenceValueSha256(
          'productAcceptanceEvidence',
          manifest?.productAcceptanceEvidence,
        ) !== manifest.productAcceptanceSha256) {
      throw new Error('product acceptance evidence digest mismatch');
    }
    assertProductAcceptanceEvidence(
      manifest.productAcceptanceEvidence,
      manifest.candidateSha,
    );
  } catch (error) {
    errors.push(error.message);
  }

  if (!Array.isArray(manifest?.artifacts) || manifest.artifacts.length === 0) {
    errors.push('at least one artifact is required');
  } else {
    const seenNames = new Set();
    let previousName = '';
    for (const item of manifest.artifacts) {
      const name = String(item?.name ?? '');
      if (!hasExactKeys(item, ARTIFACT_FIELDS)) {
        errors.push(`artifact record schema mismatch: ${name}`);
      }
      if (!safeArtifactName(item?.name)) {
        errors.push(`invalid artifact name: ${name}`);
        continue;
      }
      const nameKey = artifactNameKey(name);
      if (seenNames.has(nameKey)) errors.push(`duplicate artifact name: ${name}`);
      seenNames.add(nameKey);
      if (previousName && name <= previousName) {
        errors.push('artifact inventory is not strictly sorted');
      }
      previousName = name;
      if (!PLATFORMS.has(item.platform)) errors.push(`invalid artifact platform: ${name}`);
      if (!DECIMAL_ID.test(String(item.artifactId ?? ''))) {
        errors.push(`invalid artifact id: ${name}`);
      }
      if (!ROLES.has(item.role)) errors.push(`invalid artifact role: ${name}`);
      if (!DIGEST.test(String(item.sha256 ?? ''))) errors.push(`invalid digest: ${name}`);
    }
  }

  const evidence = Array.isArray(manifest?.evidence) ? manifest.evidence : [];
  if (JSON.stringify(evidence.map((item) => item?.platform))
      !== JSON.stringify(REQUIRED_EVIDENCE_PLATFORMS)) {
    errors.push('missing dual-platform build evidence');
  }
  for (const item of evidence) {
    try {
      assertEvidenceIdentity(
        item,
        item?.platform,
        manifest?.candidateSha,
        Array.isArray(manifest?.artifacts) ? manifest.artifacts : [],
      );
    } catch (error) {
      errors.push(`${error.message}: ${String(item?.platform ?? 'unknown')}`);
    }
  }
  return errors;
}

export function serializeArtifactManifest(manifest) {
  const bytes = Buffer.from(canonicalStringify(manifest), 'utf8');
  if (bytes.length > MAX_ARTIFACT_MANIFEST_BYTES) {
    throw new Error('artifact manifest aggregate exceeds 64 MiB');
  }
  const errors = validateArtifactManifestStructure(manifest);
  if (errors.length) throw new Error(`artifact manifest is invalid: ${errors.join('; ')}`);
  return bytes;
}

export async function sha256File(path) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw untrustedFile('path must identify a regular file without following a symbolic link');
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === 'ELOOP') throw untrustedFile('symbolic links are not trusted', error);
    throw error;
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !unchangedFile(before, opened)) {
      throw untrustedFile('file changed identity before hashing');
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
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

  for (const item of input.artifacts) validateArtifactShape(item);
  const artifactNameKeys = input.artifacts.map((item) => artifactNameKey(item.name));
  if (new Set(artifactNameKeys).size !== artifactNameKeys.length) {
    throw new Error('artifact names must be unique');
  }

  if (!Array.isArray(input.evidence)) {
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
  artifacts.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

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
      runtimeInventory: await readJsonEvidence(item.runtimeInventoryPath, 'runtimeInventory'),
      sbom: await readJsonEvidence(item.sbomPath, 'sbom'),
      licenses: await readJsonEvidence(item.licensesPath, 'licenses'),
      signingReport: await readJsonEvidence(item.signingReportPath, 'signingReport'),
    };
    const record = {
      platform: item.platform,
      bundleManifest: sources.bundleManifest.value,
      signedBundleManifest: sources.signedBundleManifest.value,
      nativeSignatureEvidence: sources.nativeSignatureEvidence.value,
      runtimeInventory: sources.runtimeInventory.value,
      sbom: sources.sbom.value,
      licenses: sources.licenses.value,
      signingReport: sources.signingReport.value,
      sha256: Object.fromEntries(
        EVIDENCE_DIGEST_FIELDS.map((field) => [field, sources[field].sha256]),
      ),
    };
    assertEvidenceIdentity(record, item.platform, candidateSha, artifacts);
    evidence.push(record);
  }
  evidence.sort((left, right) => left.platform < right.platform ? -1 : 1);

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
  if (errors.includes('invalid manifest identity')) return errors;

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    return errors;
  } else {
    for (const item of manifest.artifacts) {
      const name = String(item?.name ?? '');
      if (!hasExactKeys(item, ARTIFACT_FIELDS) || !safeArtifactName(item?.name)
          || !PLATFORMS.has(item.platform)
          || !DECIMAL_ID.test(String(item.artifactId ?? ''))
          || !ROLES.has(item.role) || !DIGEST.test(String(item.sha256 ?? ''))) continue;
      try {
        if (await sha256File(join(root, name)) !== item.sha256) {
          errors.push(`sha256 mismatch: ${name}`);
        }
      } catch (error) {
        if (error?.code === 'AE_MCP_UNTRUSTED_FILE' || error?.code === 'ELOOP') {
          errors.push(`untrusted artifact file: ${name}`);
        } else {
          errors.push(`unable to hash artifact: ${name}`);
        }
      }
    }
  }

  return errors;
}
