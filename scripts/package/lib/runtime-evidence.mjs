import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EPOCH = '1970-01-01T00:00:00.000Z';
const SPDX_CREATOR = 'Tool: ae-mcp-runtime-inventory';
const PLATFORM_IDS = new Set(['macos-arm64', 'windows-x64']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LICENSE_REF_PATTERN = /^LicenseRef-[A-Za-z0-9.-]+$/;

function evidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]),
    );
  }
  return value;
}

export function canonicalRuntimeEvidenceJson(value) {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertPortableEvidencePath(relative) {
  if (typeof relative !== 'string'
      || relative.length === 0
      || relative.length > 1024
      || relative.includes('\\')
      || relative.includes('\0')
      || path.posix.isAbsolute(relative)) {
    throw evidenceError('RUNTIME_EVIDENCE_INVALID', 'extracted license evidence path is invalid');
  }
  const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (relative.split('/').some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || /[<>:"|?*\u0000-\u001f]/.test(segment)
    || /[ .]$/.test(segment)
    || reservedWindowsName.test(segment)
  ))) {
    throw evidenceError('RUNTIME_EVIDENCE_INVALID', 'extracted license evidence path is invalid');
  }
}

function assertComponent(component) {
  if (!component || typeof component !== 'object' || Array.isArray(component)
      || typeof component.name !== 'string' || !component.name
      || typeof component.version !== 'string' || !component.version
      || typeof component.license !== 'string' || !component.license
      || typeof component.source !== 'string' || !component.source
      || !SHA256_PATTERN.test(component.sha256 ?? '')) {
    throw evidenceError('RUNTIME_EVIDENCE_INVALID', 'runtime component projection is invalid');
  }
}

function assertApproval(approval) {
  const expectedKeys = ['approvalId', 'licenseRef', 'package', 'sourceSha256', 'version'];
  if (!approval || JSON.stringify(Object.keys(approval).sort()) !== JSON.stringify(expectedKeys)
      || expectedKeys.some((key) => typeof approval[key] !== 'string' || !approval[key])
      || !SHA256_PATTERN.test(approval.sourceSha256)
      || !LICENSE_REF_PATTERN.test(approval.licenseRef)) {
    throw evidenceError('RUNTIME_EVIDENCE_INVALID', 'runtime license approval projection is invalid');
  }
}

function licenseRefsInExpression(expression) {
  const refs = new Set();
  const pattern = /(?:^|[^A-Za-z0-9.-])(LicenseRef-[A-Za-z0-9.-]+)(?=$|[^A-Za-z0-9.-])/g;
  for (const match of expression.matchAll(pattern)) refs.add(match[1]);
  return [...refs].sort(compareUtf8);
}

function componentLicenseRefs(components) {
  return [...new Set(components.flatMap(({ license }) => licenseRefsInExpression(license)))]
    .sort(compareUtf8);
}

function normalizeExtractedLicenses(components, extractedLicenses) {
  if (!Array.isArray(extractedLicenses)) {
    throw evidenceError('RUNTIME_EVIDENCE_INVALID', 'extracted license records must be an array');
  }
  const records = extractedLicenses.map((record) => {
    const expectedKeys = ['evidence', 'extractedText', 'licenseId', 'name'];
    const expectedEvidenceKeys = ['path', 'sha256'];
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
        || !LICENSE_REF_PATTERN.test(record.licenseId ?? '')
        || typeof record.name !== 'string' || !record.name.trim()
        || typeof record.extractedText !== 'string' || !record.extractedText.trim()
        || !record.evidence || typeof record.evidence !== 'object'
        || Array.isArray(record.evidence)
        || JSON.stringify(Object.keys(record.evidence).sort())
          !== JSON.stringify(expectedEvidenceKeys)
        || !SHA256_PATTERN.test(record.evidence.sha256 ?? '')) {
      throw evidenceError('RUNTIME_EVIDENCE_INVALID', 'extracted license record is invalid');
    }
    assertPortableEvidencePath(record.evidence.path);
    if (sha256Bytes(Buffer.from(record.extractedText, 'utf8')) !== record.evidence.sha256) {
      throw evidenceError(
        'RUNTIME_EVIDENCE_INVALID',
        `extracted license text does not match its evidence digest: ${record.licenseId}`,
      );
    }
    return clone(record);
  }).sort((left, right) => compareUtf8(left.licenseId, right.licenseId));

  const requiredRefs = componentLicenseRefs(components);
  const actualRefs = records.map(({ licenseId }) => licenseId);
  if (new Set(actualRefs).size !== actualRefs.length
      || JSON.stringify(actualRefs) !== JSON.stringify(requiredRefs)) {
    throw evidenceError(
      'RUNTIME_EVIDENCE_INVALID',
      'SPDX LicenseRef identifiers and extracted license records are not one-to-one',
    );
  }
  for (const record of records) {
    const isBoundToReviewedPayload = components.some((component) => (
      licenseRefsInExpression(component.license).includes(record.licenseId)
      && Array.isArray(component.licenseEvidence)
      && component.licenseEvidence.some((evidence) => (
        evidence?.kind === 'payload-file'
        && evidence.path === record.evidence.path
        && evidence.sha256 === record.evidence.sha256
      ))
    ));
    if (!isBoundToReviewedPayload) {
      throw evidenceError(
        'RUNTIME_EVIDENCE_INVALID',
        `extracted license is not bound to component payload evidence: ${record.licenseId}`,
      );
    }
  }
  return records;
}

function assertInputs({ platform, components, licenseApprovals = [], extractedLicenses = [] }) {
  if (!PLATFORM_IDS.has(platform) || !Array.isArray(components) || components.length === 0
      || !Array.isArray(licenseApprovals)) {
    throw evidenceError('RUNTIME_EVIDENCE_INVALID', 'runtime evidence inputs are invalid');
  }
  components.forEach(assertComponent);
  licenseApprovals.forEach(assertApproval);
  return normalizeExtractedLicenses(components, extractedLicenses);
}

export function buildLicenseInventory({
  platform,
  components,
  licenseApprovals = [],
  extractedLicenses = [],
}) {
  const normalizedLicenses = assertInputs({
    platform,
    components,
    licenseApprovals,
    extractedLicenses,
  });
  return {
    schemaVersion: 1,
    platform,
    components: clone(components),
    licenseApprovals: clone(licenseApprovals),
    extractedLicenses: normalizedLicenses,
  };
}

export function buildRuntimeSpdx({ platform, components, extractedLicenses = [] }) {
  const normalizedLicenses = assertInputs({
    platform,
    components,
    licenseApprovals: [],
    extractedLicenses,
  });
  const projectionDigest = sha256Bytes(Buffer.from(canonicalRuntimeEvidenceJson({
    components,
    extractedLicenses: normalizedLicenses,
  }), 'utf8'));
  const packages = components.map((component, index) => ({
    SPDXID: `SPDXRef-Package-${String(index + 1).padStart(6, '0')}`,
    checksums: [{ algorithm: 'SHA256', checksumValue: component.sha256 }],
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: component.license,
    licenseDeclared: component.license,
    name: component.name,
    sourceInfo: component.source,
    versionInfo: component.version,
  }));
  return {
    SPDXID: 'SPDXRef-DOCUMENT',
    creationInfo: { created: EPOCH, creators: [SPDX_CREATOR] },
    dataLicense: 'CC0-1.0',
    documentNamespace: `https://github.com/JUNKDOGE-JOE/after-effects-mcp/spdx/runtime/${platform}/${projectionDigest}`,
    hasExtractedLicensingInfos: normalizedLicenses.map((record) => ({
      licenseId: record.licenseId,
      extractedText: record.extractedText,
      name: record.name,
      comment: `Reviewed runtime evidence: ${record.evidence.path} (SHA-256: ${record.evidence.sha256})`,
    })),
    name: `ae-mcp-runtime-${platform}`,
    packages,
    relationships: packages.map((record) => ({
      relatedSpdxElement: record.SPDXID,
      relationshipType: 'DESCRIBES',
      spdxElementId: 'SPDXRef-DOCUMENT',
    })),
    spdxVersion: 'SPDX-2.3',
  };
}

function assertExactProjection(actual, expected, code, label) {
  if (canonicalRuntimeEvidenceJson(actual) !== canonicalRuntimeEvidenceJson(expected)) {
    throw evidenceError(code, `${label} is not the exact runtime manifest projection`);
  }
  return actual;
}

export function validateLicenseInventory(actual, expected) {
  let projection;
  try {
    projection = buildLicenseInventory(expected);
  } catch (error) {
    throw evidenceError(
      'BUNDLE_LICENSE_INVENTORY_INVALID',
      `invalid expected license inventory: ${error.message}`,
    );
  }
  return assertExactProjection(
    actual,
    projection,
    'BUNDLE_LICENSE_INVENTORY_INVALID',
    'license inventory',
  );
}

export function validateRuntimeSpdx(actual, expected) {
  let projection;
  try {
    projection = buildRuntimeSpdx(expected);
  } catch (error) {
    throw evidenceError('BUNDLE_SBOM_INVALID', `invalid expected SPDX projection: ${error.message}`);
  }
  return assertExactProjection(actual, projection, 'BUNDLE_SBOM_INVALID', 'SPDX SBOM');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readRegularEvidenceFile(filePath, root, code) {
  let handle;
  try {
    const realRoot = await fs.promises.realpath(root);
    const realFile = await fs.promises.realpath(filePath);
    if (!isInside(realRoot, realFile) || realFile === realRoot) {
      throw evidenceError(code, `license evidence escapes runtime root: ${filePath}`);
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 16 * 1024 * 1024) {
      throw evidenceError(code, `license evidence is not one regular bounded file: ${filePath}`);
    }
    return await handle.readFile();
  } catch (error) {
    if (error?.code === code) throw error;
    throw evidenceError(code, `license evidence cannot be read safely: ${filePath}`);
  } finally {
    await handle?.close();
  }
}

export async function verifyExtractedLicenseEvidence({
  runtimeRoot,
  components,
  extractedLicenses = [],
  code = 'RUNTIME_LICENSE_EVIDENCE_INVALID',
}) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot) {
    throw evidenceError(code, 'runtime root is required for extracted license evidence');
  }
  components.forEach(assertComponent);
  let records;
  try {
    records = normalizeExtractedLicenses(components, extractedLicenses);
  } catch (error) {
    throw evidenceError(code, error.message);
  }
  const resolvedRoot = path.resolve(runtimeRoot);
  for (const record of records) {
    const filePath = path.resolve(resolvedRoot, ...record.evidence.path.split('/'));
    if (!isInside(resolvedRoot, filePath) || filePath === resolvedRoot) {
      throw evidenceError(code, `license evidence escapes runtime root: ${record.evidence.path}`);
    }
    const bytes = await readRegularEvidenceFile(filePath, resolvedRoot, code);
    if (!bytes.equals(Buffer.from(record.extractedText, 'utf8'))
        || sha256Bytes(bytes) !== record.evidence.sha256) {
      throw evidenceError(code, `license evidence bytes do not match: ${record.evidence.path}`);
    }
  }
  return records;
}
