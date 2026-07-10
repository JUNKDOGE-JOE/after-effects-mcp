import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  lstatSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
} from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import {
  buildSigningPlan as foundationBuildSigningPlan,
  validateSigningSliceEvidence as foundationValidateSigningSliceEvidence,
} from '../package/signing-plan.mjs';
import { verifyPlatformBundle as foundationVerifyPlatformBundle } from '../package/verify-platform-bundle.mjs';
import { freezeSignedManifests as foundationFreezeSignedManifests } from '../package/freeze-signed-manifests.mjs';
import { sha256Directory as foundationSha256Directory } from '../package/lib/files.mjs';
import { collectManifestEntries, copyTree } from '../package/lib/manifest.mjs';

const RELEASE_VERSION = '0.9.1';
const CANDIDATE_SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
const STEP_EVIDENCE_KEYS = new Set([
  'exitCode',
  'id',
  'inputSha256',
  'outputSha256',
]);
const MAX_SIGNING_EVIDENCE_BYTES = 1024 * 1024;
const MAX_SIGNING_MANIFEST_BYTES = 8 * 1024 * 1024;
const BASE_COMMAND_ENV_NAMES = Object.freeze([
  'COMSPEC',
  'DEVELOPER_DIR',
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'PATHEXT',
  'PSModulePath',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
]);

function platformPath(platform) {
  return platform === 'windows-x64' ? win32 : posix;
}

function isWithin(pathApi, parent, child) {
  const relative = pathApi.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}

function validateRoot(pathApi, value, label) {
  if (typeof value !== 'string' || value.includes('\0') || !pathApi.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return pathApi.normalize(value);
}

function resolvePhysicalPath(pathApi, value) {
  let current = value;
  const missingSegments = [];
  while (true) {
    try {
      const existing = realpathSync.native(current);
      return missingSegments.reduce(
        (resolved, segment) => pathApi.join(resolved, segment),
        existing,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('unable to resolve release signing root');
      const parent = pathApi.dirname(current);
      if (parent === current) return value;
      missingSegments.unshift(pathApi.basename(current));
      current = parent;
    }
  }
}

function assertEmptySigningRootAtConstruction(root) {
  let stat;
  try {
    stat = lstatSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('unable to inspect signing root');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('signing root must be a real directory');
  }
  if (readdirSync(root).length !== 0) throw new Error('signing root must be empty');
}

function validateReleaseSigningInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('release signing input must be an object');
  }
  const platform = input.platform;
  if (!PLATFORMS.has(platform)) throw new Error('invalid platform');
  if (input.version !== RELEASE_VERSION) throw new Error('invalid release version');
  if (!CANDIDATE_SHA.test(input.candidateSha || '')) throw new Error('invalid candidate SHA');

  const pathApi = platformPath(platform);
  const roots = {
    stageRoot: validateRoot(pathApi, input.stageRoot, 'stage root'),
    signingRoot: validateRoot(pathApi, input.signingRoot, 'signing root'),
    outRoot: validateRoot(pathApi, input.outRoot, 'output root'),
  };
  const entries = Object.entries(roots).map(([name, root]) => [
    name,
    root,
    resolvePhysicalPath(pathApi, root),
  ]);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftName, , leftPhysicalRoot] = entries[left];
      const [rightName, , rightPhysicalRoot] = entries[right];
      if (isWithin(pathApi, leftPhysicalRoot, rightPhysicalRoot) || isWithin(pathApi, rightPhysicalRoot, leftPhysicalRoot)) {
        throw new Error(`${leftName} and ${rightName} must not overlap`);
      }
    }
  }
  assertEmptySigningRootAtConstruction(roots.signingRoot);
  return Object.freeze({
    platform,
    candidateSha: input.candidateSha,
    version: input.version,
    ...roots,
  });
}

function command({ file, args, label, evidencePath, expectedStepIds, envNames, output }) {
  return Object.freeze({
    file,
    args: Object.freeze(args),
    label,
    evidencePath,
    expectedStepIds: Object.freeze([...expectedStepIds]),
    envNames: Object.freeze([...envNames]),
    output: output ? Object.freeze(output) : undefined,
    secretArgIndexes: Object.freeze([]),
  });
}

export function buildReleaseSigningCommands(input, { sourceStageSha256 } = {}) {
  const validated = validateReleaseSigningInput(input);
  const pathApi = platformPath(validated.platform);
  const nestedEvidencePath = pathApi.join(validated.outRoot, 'nested-signing-evidence.json');
  // package-macos-dmg.sh consumes this exact sibling name to bind the DMG to
  // the already-verified ZXP bytes. Keep one filename across Phase 0 and RCs.
  const zxpEvidencePath = pathApi.join(validated.outRoot, 'zxp-evidence.json');
  const zxpName = `ae-mcp-panel-v${validated.version}-${validated.platform}.zxp`;
  const zxpPath = pathApi.join(validated.outRoot, zxpName);

  if (validated.platform === 'macos-arm64') {
    const dmgEvidencePath = pathApi.join(validated.outRoot, 'dmg-signing-evidence.json');
    const dmgName = `ae-mcp-panel-v${validated.version}-${validated.platform}.dmg`;
    const dmgPath = pathApi.join(validated.outRoot, dmgName);
    return Object.freeze([
      command({
        file: 'bash',
        args: [
          'scripts/package/sign-macos-nested.sh',
          '--root',
          validated.signingRoot,
          '--evidence',
          nestedEvidencePath,
        ],
        label: 'sign-macos-nested',
        evidencePath: nestedEvidencePath,
        expectedStepIds: [
          'sign-helper', 'sign-xpc', 'sign-addon', 'sign-launcher', 'verify-nested',
        ],
        envNames: [
          'AE_MCP_APPLE_CERT_FINGERPRINT_SHA256',
          'AE_MCP_APPLE_SIGNING_IDENTITY',
          'AE_MCP_APPLE_TEAM_ID',
        ],
      }),
      command({
        file: process.execPath,
        args: [
          'scripts/package/build-zxp.mjs',
          '--root',
          validated.signingRoot,
          '--platform',
          validated.platform,
          '--out',
          zxpPath,
          '--evidence',
          zxpEvidencePath,
          ...(sourceStageSha256 ? ['--source-stage-sha256', sourceStageSha256] : []),
        ],
        label: 'sign-zxp',
        evidencePath: zxpEvidencePath,
        expectedStepIds: ['sign-zxp', 'verify-zxp'],
        envNames: [
          'AE_MCP_ZXP_CERT_FINGERPRINT_SHA256',
          'AE_MCP_ZXP_CERT_PASSWORD',
          'AE_MCP_ZXP_CERT_PATH',
          'AE_MCP_ZXP_SIGN_CMD',
          'AE_MCP_ZXP_SIGN_CMD_SHA256',
        ],
        output: { role: 'zxp', path: zxpPath },
      }),
      command({
        file: 'bash',
        args: [
          'scripts/package/package-macos-dmg.sh',
          '--zxp',
          zxpPath,
          '--out',
          dmgPath,
          '--evidence',
          dmgEvidencePath,
        ],
        label: 'package-macos-dmg',
        evidencePath: dmgEvidencePath,
        expectedStepIds: [
          'build-dmg', 'sign-dmg', 'notarize-dmg', 'staple-dmg', 'verify-gatekeeper',
        ],
        envNames: [
          'AE_MCP_APPLE_CERT_FINGERPRINT_SHA256',
          'AE_MCP_APPLE_SIGNING_IDENTITY',
          'AE_MCP_APPLE_TEAM_ID',
          'AE_MCP_NOTARY_KEYCHAIN_PATH',
          'AE_MCP_NOTARY_KEYCHAIN_PROFILE',
        ],
        output: { role: 'dmg', path: dmgPath },
      }),
    ]);
  }

  return Object.freeze([
    command({
      file: 'pwsh',
      args: [
        '-NoProfile',
        '-File',
        'scripts/package/sign-windows-nested.ps1',
        '-Root',
        validated.signingRoot,
        '-Evidence',
        nestedEvidencePath,
      ],
      label: 'sign-windows-nested',
      evidencePath: nestedEvidencePath,
      expectedStepIds: ['sign-helper', 'sign-addon', 'sign-launcher', 'verify-authenticode'],
      envNames: [
        'AE_MCP_WINDOWS_SIGNING_CERT_SHA1',
        'AE_MCP_WINDOWS_SIGNTOOL_PATH',
        'AE_MCP_WINDOWS_TIMESTAMP_URL',
      ],
    }),
    command({
      file: process.execPath,
      args: [
        'scripts/package/build-zxp.mjs',
        '--root',
        validated.signingRoot,
        '--platform',
        validated.platform,
        '--out',
        zxpPath,
        '--evidence',
        zxpEvidencePath,
        ...(sourceStageSha256 ? ['--source-stage-sha256', sourceStageSha256] : []),
      ],
      label: 'sign-zxp',
      evidencePath: zxpEvidencePath,
      expectedStepIds: ['sign-zxp', 'verify-zxp'],
      envNames: [
        'AE_MCP_ZXP_CERT_FINGERPRINT_SHA256',
        'AE_MCP_ZXP_CERT_PASSWORD',
        'AE_MCP_ZXP_CERT_PATH',
        'AE_MCP_ZXP_SIGN_CMD',
        'AE_MCP_ZXP_SIGN_CMD_SHA256',
      ],
      output: { role: 'zxp', path: zxpPath },
    }),
  ]);
}

export function redactReleaseSigningCommand(commandValue) {
  if (!commandValue || typeof commandValue !== 'object' || !Array.isArray(commandValue.args)) {
    throw new Error('invalid release signing command');
  }
  const secretArgIndexes = commandValue.secretArgIndexes || [];
  if (!Array.isArray(secretArgIndexes) || secretArgIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= commandValue.args.length)) {
    throw new Error('invalid secret argument index');
  }
  const secretIndexes = new Set(secretArgIndexes);
  return {
    ...commandValue,
    args: commandValue.args.map((value, index) => (secretIndexes.has(index) ? '<redacted>' : value)),
    secretArgIndexes: [...secretArgIndexes],
  };
}

export function validateReleaseStepEvidence(plan, stepEvidence) {
  if (!plan || typeof plan !== 'object' || !PLATFORMS.has(plan.platform) || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('invalid foundation signing plan');
  }
  const foundationPlan = foundationBuildSigningPlan(plan.platform);
  if (JSON.stringify(plan.steps.map((step) => ({ id: step?.id, mutates: step?.mutates })))
      !== JSON.stringify(foundationPlan.steps.map((step) => ({ id: step.id, mutates: step.mutates })))) {
    throw new Error('invalid foundation signing plan');
  }
  if (!Array.isArray(stepEvidence) || stepEvidence.length !== foundationPlan.steps.length) {
    throw new Error('signing evidence step order does not match foundation plan');
  }

  let priorOutputSha256;
  for (let index = 0; index < foundationPlan.steps.length; index += 1) {
    const expected = foundationPlan.steps[index];
    const actual = stepEvidence[index];
    if (!expected || typeof expected.id !== 'string' || !actual || typeof actual !== 'object' || Array.isArray(actual) || actual.id !== expected.id) {
      throw new Error('signing evidence step order does not match foundation plan');
    }
    if (Object.keys(actual).some((key) => !STEP_EVIDENCE_KEYS.has(key))) {
      throw new Error(`signing evidence for ${expected.id} contains an unsupported field`);
    }
    if (!DIGEST.test(actual.inputSha256 || '') || !DIGEST.test(actual.outputSha256 || '')) {
      throw new Error(`signing evidence for ${expected.id} contains an invalid digest`);
    }
    if (actual.exitCode !== 0) {
      throw new Error(`signing evidence for ${expected.id} has non-zero exit code`);
    }
    if (index > 0 && actual.inputSha256 !== priorOutputSha256) {
      throw new Error(`signing evidence digest chain breaks before ${expected.id}`);
    }
    if (expected.mutates.length === 0 && actual.inputSha256 !== actual.outputSha256) {
      throw new Error(`signing evidence mutation boundary is invalid for ${expected.id}`);
    }
    priorOutputSha256 = actual.outputSha256;
  }
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ensureEmptySigningRoot(root) {
  const stat = await lstatIfPresent(root);
  if (!stat) {
    await mkdir(root, { mode: 0o700 });
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('signing root must be a real directory');
  }
  if ((await readdir(root)).length !== 0) {
    throw new Error('signing root must be empty');
  }
}

async function ensureOutputRoot(root) {
  const stat = await lstatIfPresent(root);
  if (!stat) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('output root must be a real directory');
  }
}

async function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortCanonicalValue(value[key])]),
    );
  }
  return value;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertBoundedFileStat(stat, label, maxBytes) {
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.nlink !== 1n) throw new Error(`${label} hard link count must be one`);
  if (stat.size <= 0n || stat.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeds the size limit`);
  }
}

async function readStableBoundedFile(path, {
  afterOpen,
  label,
  maxBytes,
}) {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error(`invalid ${label} path`);
  const before = await lstat(path, { bigint: true });
  assertBoundedFileStat(before, label, maxBytes);

  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${label} failed nofollow validation`);
    throw new Error(`unable to open ${label}`);
  }

  try {
    const opened = await handle.stat({ bigint: true });
    assertBoundedFileStat(opened, label, maxBytes);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`${label} identity changed while opening`);
    }
    if (afterOpen) await afterOpen();

    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (bytesRead === 0) throw new Error(`${label} changed while reading`);
      position += bytesRead;
    }

    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameFileState(opened, afterDescriptor) || !sameFileState(opened, afterPath)) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readCanonicalSigningEvidence(path, { afterOpen } = {}) {
  const bytes = await readStableBoundedFile(path, {
    afterOpen,
    label: 'signing evidence',
    maxBytes: MAX_SIGNING_EVIDENCE_BYTES,
  });
  let raw;
  let value;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(raw);
  } catch {
    throw new Error('signing evidence is not valid UTF-8 JSON');
  }
  if (raw !== `${JSON.stringify(sortCanonicalValue(value))}\n`) {
    throw new Error('signing evidence is not canonical JSON');
  }
  return value;
}

export async function readStableSigningManifest(path, { afterOpen } = {}) {
  return readStableBoundedFile(path, {
    afterOpen,
    label: 'signing manifest',
    maxBytes: MAX_SIGNING_MANIFEST_BYTES,
  });
}

export function validateReleaseEvidenceEnvelope(value, { platform, sourceStageSha256 }) {
  const expectedKeys = [
    'platform',
    'schemaVersion',
    'sourceStageSha256',
    'steps',
    'verifiedIdentity',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('invalid signing evidence envelope');
  }
  if (value.schemaVersion !== 1 || value.platform !== platform
      || value.sourceStageSha256 !== sourceStageSha256
      || !Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error('signing evidence identity mismatch');
  }
  if (!value.verifiedIdentity || typeof value.verifiedIdentity !== 'object'
      || Array.isArray(value.verifiedIdentity)) {
    throw new Error('signing evidence requires structured verified identity');
  }
  return value.verifiedIdentity;
}

function mergeIdentity(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(target, key) && target[key] !== value) {
      throw new Error(`conflicting verified signing identity field: ${key}`);
    }
    target[key] = value;
  }
}

function sanitizedExecutionError(label, error) {
  const exitCode = Number.isInteger(error?.code)
    ? error.code
    : Number.isInteger(error?.exitCode)
      ? error.exitCode
      : 1;
  return new Error(`signing step ${label} failed with exit code ${exitCode}`);
}

function commandEnvironment(commandValue, environment) {
  const allowed = new Set([...BASE_COMMAND_ENV_NAMES, ...commandValue.envNames]);
  const result = Object.create(null);
  for (const name of [...allowed].sort()) {
    const value = environment[name];
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

async function executeCommand(commandValue, execFileImpl, environment) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(sanitizedExecutionError(commandValue.label, error));
      else resolve();
    };

    let result;
    try {
      result = execFileImpl(
        commandValue.file,
        [...commandValue.args],
        {
          encoding: 'utf8',
          env: commandEnvironment(commandValue, environment),
          maxBuffer: 1024 * 1024,
          shell: false,
          windowsHide: true,
        },
        finish,
      );
    } catch (error) {
      finish(error);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(() => finish(), (error) => finish(error));
    } else if (execFileImpl.length < 4 && result === undefined) {
      finish();
    }
  });
}

function manifestEntryMap(entries) {
  return new Map(entries.map((entry) => [entry.path, JSON.stringify(entry)]));
}

function changedManifestPaths(beforeEntries, afterEntries) {
  const before = manifestEntryMap(beforeEntries);
  const after = manifestEntryMap(afterEntries);
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((relative) => before.get(relative) !== after.get(relative))
    .sort();
}

function assertReviewedMutations(beforeEntries, afterEntries, allowedPaths, label) {
  const allowed = new Set(allowedPaths);
  const unexpected = changedManifestPaths(beforeEntries, afterEntries)
    .filter((relative) => !allowed.has(relative));
  if (unexpected.length > 0) {
    throw new Error(`${label} changed bytes outside the reviewed mutation set`);
  }
}

function lastOutputSha256(envelope) {
  return envelope.steps.at(-1).outputSha256;
}

export async function copyVerifiedStage({
  stageRoot,
  signingRoot,
  platform,
  version,
  candidateSha,
  verifyPlatformBundleImpl = foundationVerifyPlatformBundle,
  copyTreeImpl = copyTree,
}) {
  const verification = {
    platform,
    version,
    sourceCommitSha: candidateSha,
  };
  await verifyPlatformBundleImpl({ root: stageRoot, ...verification });
  await copyTreeImpl(stageRoot, signingRoot);
  await verifyPlatformBundleImpl({ root: signingRoot, ...verification });
}

async function requireUnusedCommandPaths(commands) {
  for (const commandValue of commands) {
    for (const path of [commandValue.evidencePath, commandValue.output?.path].filter(Boolean)) {
      if (await lstatIfPresent(path)) throw new Error('signing output path already exists');
    }
  }
}

export async function runReleaseSigning(input, dependencies = {}) {
  const validated = validateReleaseSigningInput(input);
  const pathApi = platformPath(validated.platform);
  const buildSigningPlan = dependencies.buildSigningPlanImpl || foundationBuildSigningPlan;
  const validateSigningSliceEvidence = dependencies.validateSigningSliceEvidenceImpl
    || foundationValidateSigningSliceEvidence;
  const verifyPlatformBundle = dependencies.verifyPlatformBundleImpl
    || foundationVerifyPlatformBundle;
  const freezeSignedManifests = dependencies.freezeSignedManifestsImpl
    || foundationFreezeSignedManifests;
  const sha256Directory = dependencies.sha256DirectoryImpl || foundationSha256Directory;
  const collectEntries = dependencies.collectManifestEntriesImpl || collectManifestEntries;
  const plan = await buildSigningPlan(validated.platform);
  if (!plan || plan.platform !== validated.platform || !Array.isArray(plan.steps)) {
    throw new Error('foundation signing plan platform mismatch');
  }

  await ensureEmptySigningRoot(validated.signingRoot);
  await ensureOutputRoot(validated.outRoot);

  const manifestPath = pathApi.join(validated.stageRoot, 'bundle-manifest.json');
  let manifestBytes;
  try {
    manifestBytes = await readStableSigningManifest(manifestPath);
  } catch {
    throw new Error('verified bundle manifest is missing or untrusted');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('verified bundle manifest is invalid JSON');
  }
  if (manifest?.schemaVersion !== 1 || manifest?.platform !== validated.platform || manifest?.version !== validated.version || manifest?.sourceCommitSha !== validated.candidateSha) {
    throw new Error('verified bundle manifest identity mismatch');
  }
  const sourceStageSha256 = await sha256Bytes(manifestBytes);
  const commands = buildReleaseSigningCommands(validated, { sourceStageSha256 });
  await requireUnusedCommandPaths(commands);

  try {
    await copyVerifiedStage({
      stageRoot: validated.stageRoot,
      signingRoot: validated.signingRoot,
      platform: validated.platform,
      version: validated.version,
      candidateSha: validated.candidateSha,
      verifyPlatformBundleImpl: verifyPlatformBundle,
      copyTreeImpl: dependencies.copyTreeImpl || copyTree,
    });
  } catch {
    throw new Error('copied unsigned stage failed verification');
  }
  let copiedManifestBytes;
  try {
    copiedManifestBytes = await readStableSigningManifest(
      pathApi.join(validated.signingRoot, 'bundle-manifest.json'),
    );
  } catch {
    throw new Error('copied bundle manifest is untrusted');
  }
  if ((await sha256Bytes(copiedManifestBytes)) !== sourceStageSha256) {
    throw new Error('copied bundle manifest digest mismatch');
  }

  const readEvidence = dependencies.readEvidence || readCanonicalSigningEvidence;
  const execFileImpl = dependencies.execFileImpl || nodeExecFile;
  const environment = dependencies.environment || process.env;
  const stepEvidence = [];
  const identity = Object.create(null);
  const nestedCommand = commands[0];
  const beforeNestedEntries = await collectEntries(validated.signingRoot);
  const beforeNestedSha256 = await sha256Directory(validated.signingRoot);
  await executeCommand(nestedCommand, execFileImpl, environment);
  let nestedEnvelope;
  try {
    nestedEnvelope = await readEvidence(nestedCommand.evidencePath);
    await validateSigningSliceEvidence({
      evidence: nestedEnvelope,
      platform: validated.platform,
      expectedStepIds: nestedCommand.expectedStepIds,
      expectedInputSha256: beforeNestedSha256,
      expectedStageSha256: sourceStageSha256,
    });
    mergeIdentity(identity, validateReleaseEvidenceEnvelope(nestedEnvelope, {
      platform: validated.platform,
      sourceStageSha256,
    }));
  } catch {
    throw new Error(`signing step ${nestedCommand.label} produced invalid evidence`);
  }
  const afterNestedEntries = await collectEntries(validated.signingRoot);
  assertReviewedMutations(
    beforeNestedEntries,
    afterNestedEntries,
    plan.steps
      .filter((step) => nestedCommand.expectedStepIds.includes(step.id))
      .flatMap((step) => step.mutates),
    nestedCommand.label,
  );
  const afterNestedSha256 = await sha256Directory(validated.signingRoot);
  if (lastOutputSha256(nestedEnvelope) !== afterNestedSha256) {
    throw new Error(`signing step ${nestedCommand.label} produced invalid evidence`);
  }
  stepEvidence.push(...nestedEnvelope.steps);

  const freezePlanStep = plan.steps.find((step) => step.id === 'freeze-signed-manifests');
  if (!freezePlanStep) throw new Error('foundation signing plan is missing the freeze step');
  const beforeFreezeEntries = afterNestedEntries;
  let frozen;
  try {
    frozen = await freezeSignedManifests({
      root: validated.signingRoot,
      platform: validated.platform,
      version: validated.version,
      sourceCommitSha: validated.candidateSha,
      sourceStageSha256,
    });
  } catch {
    throw new Error('signed manifest freeze failed verification');
  }
  if (!frozen || frozen.sourceStageSha256 !== sourceStageSha256
      || !DIGEST.test(frozen.signedBundleManifestSha256 || '')
      || !DIGEST.test(frozen.finalRootSha256 || '')) {
    throw new Error('signed manifest freeze produced invalid identity');
  }
  const afterFreezeEntries = await collectEntries(validated.signingRoot);
  assertReviewedMutations(
    beforeFreezeEntries,
    afterFreezeEntries,
    freezePlanStep.mutates,
    freezePlanStep.id,
  );
  const finalRootSha256 = await sha256Directory(validated.signingRoot);
  if (frozen.finalRootSha256 !== finalRootSha256) {
    throw new Error('signed manifest freeze root digest mismatch');
  }
  const signedManifestBytes = await readStableSigningManifest(
    pathApi.join(validated.signingRoot, 'bundle-manifest.json'),
  );
  if ((await sha256Bytes(signedManifestBytes)) !== frozen.signedBundleManifestSha256) {
    throw new Error('signed manifest freeze manifest digest mismatch');
  }
  stepEvidence.push({
    id: freezePlanStep.id,
    inputSha256: afterNestedSha256,
    outputSha256: finalRootSha256,
    exitCode: 0,
  });

  let expectedCommandInputSha256 = finalRootSha256;
  for (const commandValue of commands.slice(1)) {
    const beforeRootEntries = await collectEntries(validated.signingRoot);
    const beforeRootSha256 = await sha256Directory(validated.signingRoot);
    if (beforeRootSha256 !== finalRootSha256) {
      throw new Error(`signing root changed before ${commandValue.label}`);
    }
    await executeCommand(commandValue, execFileImpl, environment);
    try {
      const envelope = await readEvidence(commandValue.evidencePath);
      await validateSigningSliceEvidence({
        evidence: envelope,
        platform: validated.platform,
        expectedStepIds: commandValue.expectedStepIds,
        expectedInputSha256: expectedCommandInputSha256,
        expectedStageSha256: sourceStageSha256,
      });
      mergeIdentity(identity, validateReleaseEvidenceEnvelope(envelope, {
        platform: validated.platform,
        sourceStageSha256,
      }));
      stepEvidence.push(...envelope.steps);
      expectedCommandInputSha256 = lastOutputSha256(envelope);
    } catch {
      throw new Error(`signing step ${commandValue.label} produced invalid evidence`);
    }
    const afterRootEntries = await collectEntries(validated.signingRoot);
    assertReviewedMutations(beforeRootEntries, afterRootEntries, [], commandValue.label);
    if (await sha256Directory(validated.signingRoot) !== finalRootSha256) {
      throw new Error(`signing root changed during ${commandValue.label}`);
    }
  }
  validateReleaseStepEvidence(plan, stepEvidence);

  try {
    await verifyPlatformBundle({
      root: validated.stageRoot,
      platform: validated.platform,
      version: validated.version,
      sourceCommitSha: validated.candidateSha,
    });
  } catch {
    throw new Error('unsigned source stage changed during signing');
  }

  let sourceManifestAfterSigning;
  try {
    sourceManifestAfterSigning = await readStableSigningManifest(manifestPath);
  } catch {
    throw new Error('unsigned source stage changed during signing');
  }
  if ((await sha256Bytes(sourceManifestAfterSigning)) !== sourceStageSha256) {
    throw new Error('unsigned source stage changed during signing');
  }

  const outputs = commands
    .filter((commandValue) => commandValue.output)
    .map((commandValue) => ({ ...commandValue.output }));
  const { buildSigningReport } = await import('./signing-report.mjs');
  return buildSigningReport({
    platform: validated.platform,
    candidateSha: validated.candidateSha,
    sourceStageSha256,
    signedBundleManifestSha256: frozen.signedBundleManifestSha256,
    finalRootSha256,
    plan,
    stepEvidence,
    outputs,
    identity,
  });
}
