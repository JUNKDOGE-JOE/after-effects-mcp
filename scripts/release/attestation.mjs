import { posix, win32 } from 'node:path';

const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
const RESULTS = new Set(['PASS', 'FAIL']);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DECIMAL_ID = /^\d+$/;
const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'platform',
  'result',
  'candidateSha',
  'workflowRunId',
  'artifactId',
  'artifactName',
  'artifactSha256',
  'osVersion',
  'codexVersion',
  'ae',
  'commands',
  'failures',
]);
const AE_FIELDS = new Set(['major', 'version', 'result']);
const COMMAND_FIELDS = new Set(['command', 'exitCode']);
const PASS_COMMAND_LABELS = new Map([
  ['macos-arm64', new Set([
    'bind installed runtime manifest to RC bundle',
    'shasum -a 256 artifact and bind manifest',
    'codesign --verify --deep --strict',
    'spctl --assess',
    'xcrun stapler validate',
    'mount exact notarized DMG',
    'verify exact ZXP payload from DMG',
    'extract exact signed ZXP for launcher binding',
    'bind installed stable launcher to signed ZXP',
    'install exact signed ZXP',
    'AE 25 installed-runtime smoke',
    'AE 26 installed-runtime smoke',
  ])],
  ['windows-x64', new Set([
    'Get-FileHash -Algorithm SHA256 and bind manifest',
    'Get-AuthenticodeSignature for every packaged executable',
    'install exact signed ZXP',
    'AE 25 installed-runtime smoke',
    'AE 26 installed-runtime smoke',
  ])],
]);

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyFields(value, fields) {
  return isPlainRecord(value) && Object.keys(value).every((key) => fields.has(key));
}

function requiredText(value, maximumLength = 512) {
  return typeof value === 'string'
    && value.length <= maximumLength
    && value.trim().length > 0;
}

function safeArtifactName(value) {
  return requiredText(value, 255)
    && value === value.normalize('NFC')
    && value !== '.'
    && value !== '..'
    && !/[\u0000-\u001f\u007f]/.test(value)
    && posix.basename(value) === value
    && win32.basename(value) === value;
}

function expectedHas(expected, key) {
  return isPlainRecord(expected) && Object.hasOwn(expected, key);
}

function isSupportedPassOs(platform, version) {
  if (platform === 'macos-arm64') {
    const match = /^macOS (\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version ?? ''));
    return Boolean(match && Number(match[1]) >= 14);
  }
  if (platform === 'windows-x64') {
    const match = /^Windows 10\.0\.(\d+)(?:\.\d+)?$/.exec(String(version ?? ''));
    return Boolean(match && Number(match[1]) >= 26100);
  }
  return false;
}

function isPassAeVersion(item) {
  if (!isPlainRecord(item) || ![25, 26].includes(item.major)) return false;
  return new RegExp(`^${item.major}\\.\\d+(?:\\.\\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$`)
    .test(String(item.version ?? ''));
}

export function validateAttestation(value, expected = {}) {
  const errors = [];
  if (!hasOnlyFields(value, TOP_LEVEL_FIELDS)) errors.push('unexpected attestation fields');
  if (value?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!PLATFORMS.has(value?.platform)) errors.push('invalid platform');
  if (!RESULTS.has(value?.result)) errors.push('invalid result');
  if (!SHA.test(String(value?.candidateSha ?? ''))) errors.push('invalid candidate SHA');
  if (!DIGEST.test(String(value?.artifactSha256 ?? ''))) {
    errors.push('invalid artifact digest');
  }
  if (
    !DECIMAL_ID.test(String(value?.workflowRunId ?? ''))
    || !DECIMAL_ID.test(String(value?.artifactId ?? ''))
  ) {
    errors.push('invalid workflow/artifact id');
  }
  if (
    !safeArtifactName(value?.artifactName)
    || !requiredText(value?.osVersion)
    || !requiredText(value?.codexVersion)
  ) {
    errors.push('artifactName, osVersion, and codexVersion are required');
  }

  const commandsValid = Array.isArray(value?.commands)
    && value.commands.length <= 128
    && value.commands.every((item) => (
      hasOnlyFields(item, COMMAND_FIELDS)
      && requiredText(item.command, 4096)
      && Number.isInteger(item.exitCode)
      && item.exitCode >= -2147483648
      && item.exitCode <= 2147483647
    ));
  if (!commandsValid) errors.push('invalid commands');

  const failuresValid = Array.isArray(value?.failures)
    && value.failures.length <= 128
    && value.failures.every((item) => requiredText(item, 4096));
  if (!failuresValid) errors.push('invalid failures');

  const aeValid = Array.isArray(value?.ae)
    && value.ae.length <= 2
    && value.ae.every((item) => (
      hasOnlyFields(item, AE_FIELDS)
      && [25, 26].includes(item.major)
      && requiredText(item.version, 128)
      && /^\d+\.\d+/.test(item.version)
      && RESULTS.has(item.result)
    ));
  if (!aeValid) errors.push('invalid AE results');

  if (Array.isArray(value?.ae)) {
    const majors = value.ae
      .filter((item) => isPlainRecord(item) && [25, 26].includes(item.major))
      .map((item) => item.major);
    if (new Set(majors).size !== majors.length) errors.push('AE majors must be unique');
  }

  if (value?.result === 'PASS') {
    const passedMajors = Array.isArray(value.ae)
      ? value.ae.filter((item) => item?.result === 'PASS').map((item) => item?.major)
      : [];
    if (
      passedMajors.length !== 2
      || !passedMajors.includes(25)
      || !passedMajors.includes(26)
    ) {
      errors.push('PASS requires AE 25 and 26');
    }
    if (Array.isArray(value.failures) && value.failures.length > 0) {
      errors.push('PASS cannot contain failures');
    }
    if (Array.isArray(value.commands) && value.commands.length === 0) {
      errors.push('PASS requires command evidence');
    }
    if (Array.isArray(value.commands) && value.commands.some((item) => item?.exitCode !== 0)) {
      errors.push('PASS requires zero exit codes');
    }
    if (value.platform === 'macos-arm64' && !isSupportedPassOs(value.platform, value.osVersion)) {
      errors.push('PASS requires a supported macOS version (major >= 14)');
    }
    if (value.platform === 'windows-x64' && !isSupportedPassOs(value.platform, value.osVersion)) {
      errors.push('PASS requires a supported Windows version (build >= 26100)');
    }
    if (Array.isArray(value.ae)) {
      for (const item of value.ae) {
        if (isPlainRecord(item) && [25, 26].includes(item.major) && !isPassAeVersion(item)) {
          errors.push(`PASS AE ${item.major} version must match declared major`);
        }
      }
    }
    if (Array.isArray(value.commands)) {
      const labels = value.commands.map((item) => item?.command);
      if (new Set(labels).size !== labels.length) {
        errors.push('PASS requires unique verifier command labels');
      }
      const expectedLabels = PASS_COMMAND_LABELS.get(value.platform);
      if (
        expectedLabels
        && (labels.length !== expectedLabels.size || labels.some((label) => !expectedLabels.has(label)))
      ) {
        errors.push('PASS requires the exact platform verifier command set');
      }
    }
  } else if (value?.result === 'FAIL' && (!Array.isArray(value.failures) || value.failures.length === 0)) {
    errors.push('FAIL requires failure evidence');
  }

  if (expectedHas(expected, 'platform') && value?.platform !== expected.platform) {
    errors.push('platform mismatch');
  }
  if (expectedHas(expected, 'candidateSha') && value?.candidateSha !== expected.candidateSha) {
    errors.push('candidate mismatch');
  }
  if (
    expectedHas(expected, 'workflowRunId')
    && String(value?.workflowRunId) !== String(expected.workflowRunId)
  ) {
    errors.push('workflow run id mismatch');
  }
  if (expectedHas(expected, 'artifactId') && String(value?.artifactId) !== String(expected.artifactId)) {
    errors.push('artifact id mismatch');
  }
  if (expectedHas(expected, 'artifactName') && value?.artifactName !== expected.artifactName) {
    errors.push('artifact name mismatch');
  }
  if (
    expectedHas(expected, 'artifactSha256')
    && value?.artifactSha256 !== expected.artifactSha256
  ) {
    errors.push('artifact digest mismatch');
  }
  if (expectedHas(expected, 'result') && value?.result !== expected.result) {
    errors.push('result mismatch');
  }
  return errors;
}
