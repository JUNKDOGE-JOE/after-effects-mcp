import { chmod, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseArgs, TextDecoder } from 'node:util';
import {
  canonicalStringify,
  MAX_ARTIFACT_MANIFEST_BYTES,
  serializeArtifactManifest,
  sha256File,
} from './artifact-manifest.mjs';
import { validateAttestation } from './attestation.mjs';
import { encodeAttestationComment } from './comment-marker.mjs';

const { values } = parseArgs({
  strict: true,
  options: Object.fromEntries([
    'platform', 'candidate-sha', 'run-id', 'artifact-id', 'artifact', 'manifest',
    'os-version', 'codex-version', 'ae25-version', 'ae25-result',
    'ae26-version', 'ae26-result', 'commands-json', 'failures-json', 'out',
    'comment-out',
  ].map((name) => [name, { type: 'string' }])),
});

function required(name) {
  const value = String(values[name] || '');
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

const manifestBytes = await readFile(required('manifest'));
if (manifestBytes.length === 0 || manifestBytes.length > MAX_ARTIFACT_MANIFEST_BYTES) {
  throw new Error('artifact manifest is not one bounded file');
}
const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
const manifest = JSON.parse(manifestText);
if (!serializeArtifactManifest(manifest).equals(manifestBytes)) {
  throw new Error('artifact manifest is not canonical');
}
const artifactPath = required('artifact');
const artifactName = basename(artifactPath);
const artifactId = required('artifact-id');
const entry = (manifest.artifacts || []).find(
  (item) => item.name === artifactName && String(item.artifactId) === artifactId,
);
if (!entry) throw new Error('artifact is not present in manifest');

const digest = await sha256File(artifactPath);
if (digest !== entry.sha256) throw new Error('local artifact digest does not match manifest');

const commands = JSON.parse(required('commands-json'));
const failures = JSON.parse(required('failures-json'));
const ae = [
  { major: 25, version: required('ae25-version'), result: required('ae25-result') },
  { major: 26, version: required('ae26-version'), result: required('ae26-result') },
];
const result = ae.every((item) => item.result === 'PASS') && failures.length === 0
  ? 'PASS'
  : 'FAIL';
const report = {
  schemaVersion: 1,
  platform: required('platform'),
  result,
  candidateSha: required('candidate-sha'),
  workflowRunId: required('run-id'),
  artifactId,
  artifactName,
  artifactSha256: digest,
  osVersion: required('os-version'),
  codexVersion: required('codex-version'),
  ae,
  commands,
  failures,
};
const errors = validateAttestation(report, {
  platform: entry.platform,
  candidateSha: manifest.candidateSha,
  workflowRunId: manifest.workflowRunId,
  artifactId: entry.artifactId,
  artifactName: entry.name,
  artifactSha256: entry.sha256,
});
if (errors.length) throw new Error(errors.join('; '));

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`output already exists: ${path}`);
}

async function applyPrivateMode(path) {
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows ACL is enforced by the wrapper.
  }
}

const out = required('out');
const commentOut = String(values['comment-out'] || '');
if (commentOut && resolve(commentOut) === resolve(out)) {
  throw new Error('--out and --comment-out must identify distinct files');
}

const reportBytes = Buffer.from(canonicalStringify(report), 'utf8');
const commentBytes = Buffer.from(encodeAttestationComment(report), 'utf8');
await assertAbsent(out);
if (commentOut) await assertAbsent(commentOut);

let reportCreated = false;
let commentCreated = false;
try {
  await writeFile(out, reportBytes, { flag: 'wx', mode: 0o600 });
  reportCreated = true;
  await applyPrivateMode(out);

  if (commentOut) {
    await writeFile(commentOut, commentBytes, { flag: 'wx', mode: 0o600 });
    commentCreated = true;
    await applyPrivateMode(commentOut);
  }
} catch (error) {
  if (commentCreated) await rm(commentOut, { force: true });
  if (reportCreated) await rm(out, { force: true });
  throw error;
}

process.stdout.write(commentBytes);
