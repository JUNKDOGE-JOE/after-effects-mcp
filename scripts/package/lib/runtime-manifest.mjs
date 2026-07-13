import path from 'node:path';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PLATFORM_IDS = new Set(['macos-arm64', 'windows-x64']);

function runtimeManifestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertPortableRuntimePath(relative, invalid) {
  if (typeof relative !== 'string'
      || relative.length === 0
      || relative.length > 1024
      || relative.includes('\\')
      || relative.includes('\0')
      || path.posix.isAbsolute(relative)) {
    invalid(`invalid portable runtime path: ${String(relative)}`);
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
    invalid(`invalid portable runtime path: ${relative}`);
  }
}

function validateRuntimeComponent(component, invalid) {
  const allowedKeys = new Set([
    'disposition',
    'license',
    'licenseEvidence',
    'name',
    'relationship',
    'sha256',
    'source',
    'version',
  ]);
  const requiredKeys = ['license', 'name', 'sha256', 'source', 'version'];
  if (!component || typeof component !== 'object' || Array.isArray(component)
      || Object.keys(component).some((key) => !allowedKeys.has(key))
      || requiredKeys.some((key) => typeof component[key] !== 'string' || !component[key])
      || component.license === 'UNKNOWN'
      || !SHA256_PATTERN.test(component.sha256)
      || (Object.hasOwn(component, 'relationship')
        && !['STATIC_LINK', 'DYNAMIC_LINK', 'CONTAINS'].includes(component.relationship))
      || (Object.hasOwn(component, 'disposition') && component.disposition !== 'payload')) {
    invalid('runtime component record is invalid');
  }
  if (Object.hasOwn(component, 'licenseEvidence')) {
    if (!Array.isArray(component.licenseEvidence) || component.licenseEvidence.length === 0) {
      invalid('runtime component license evidence is invalid');
    }
    for (const evidence of component.licenseEvidence) {
      const keys = ['kind', 'path', 'sha256'];
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
          || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(keys)
          || !['metadata-file', 'source-file', 'payload-file'].includes(evidence.kind)
          || !SHA256_PATTERN.test(evidence.sha256 ?? '')) {
        invalid('runtime component license evidence is invalid');
      }
      assertPortableRuntimePath(evidence.path, invalid);
    }
  }
}

function validateRuntimeApproval(approval, invalid) {
  const keys = ['approvalId', 'licenseRef', 'package', 'sourceSha256', 'version'];
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)
      || JSON.stringify(Object.keys(approval).sort()) !== JSON.stringify(keys)
      || keys.some((key) => typeof approval[key] !== 'string' || !approval[key])
      || !/^LicenseRef-[A-Za-z0-9.-]+$/.test(approval.licenseRef)
      || !SHA256_PATTERN.test(approval.sourceSha256)) {
    invalid('runtime license approval record is invalid');
  }
}

function validateRuntimeFileRecords(files, components, invalid) {
  if (!Array.isArray(files) || files.length === 0) invalid('runtime file inventory is empty');
  const paths = new Set();
  const records = new Map();
  let previous = '';
  for (const record of files) {
    const keys = ['mode', 'path', 'sha256', 'size', 'type'];
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)
        || !['file', 'symlink'].includes(record.type)
        || !SHA256_PATTERN.test(record.sha256 ?? '')
        || !Number.isSafeInteger(record.size) || record.size < 0
        || !/^[0-7]{4}$/.test(record.mode ?? '')) {
      invalid('runtime file inventory record is invalid');
    }
    assertPortableRuntimePath(record.path, invalid);
    const portableKey = record.path.normalize('NFC').toLowerCase();
    if (paths.has(portableKey)
        || portableKey === 'runtime-manifest.json'
        || (previous && compareUtf8(record.path, previous) <= 0)) {
      invalid('runtime file inventory paths are duplicate, reserved, or unsorted');
    }
    paths.add(portableKey);
    records.set(record.path, record);
    previous = record.path;
  }
  for (const component of components) {
    for (const evidence of component.licenseEvidence ?? []) {
      if (evidence.kind !== 'payload-file') continue;
      const record = records.get(evidence.path);
      if (!record || record.type !== 'file' || record.sha256 !== evidence.sha256) {
        invalid('payload license evidence is not bound to a regular runtime file');
      }
    }
  }
}

export function validateRuntimeManifest(
  value,
  platform,
  { code = 'BUNDLE_RUNTIME_MANIFEST_INVALID' } = {},
) {
  const invalid = (message) => { throw runtimeManifestError(code, message); };
  const expectedTop = [
    'components',
    'files',
    'licenseApprovals',
    'node',
    'platform',
    'python',
    'schemaVersion',
  ];
  if (!PLATFORM_IDS.has(platform)
      || !value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedTop)
      || value.schemaVersion !== 1 || value.platform !== platform
      || JSON.stringify(Object.keys(value.node ?? {}).sort())
        !== JSON.stringify(['assetSha256', 'version'])
      || JSON.stringify(Object.keys(value.python ?? {}).sort())
        !== JSON.stringify(['assetSha256', 'distributionRelease', 'version'])
      || value.node?.version !== '24.17.0' || value.python?.version !== '3.13.14'
      || value.python?.distributionRelease !== '20260610'
      || !SHA256_PATTERN.test(value.node?.assetSha256 ?? '')
      || !SHA256_PATTERN.test(value.python?.assetSha256 ?? '')
      || !Array.isArray(value.licenseApprovals)
      || !Array.isArray(value.components) || value.components.length === 0
      || !Array.isArray(value.files)) {
    invalid('runtime manifest identity is invalid');
  }
  value.components.forEach((component) => validateRuntimeComponent(component, invalid));
  value.licenseApprovals.forEach((approval) => validateRuntimeApproval(approval, invalid));
  validateRuntimeFileRecords(value.files, value.components, invalid);
  return value;
}
