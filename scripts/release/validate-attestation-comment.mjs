import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { parseArgs, TextDecoder } from 'node:util';

import { canonicalStringify } from './artifact-manifest.mjs';
import { validateAttestation } from './attestation.mjs';
import { decodeAttestationComment } from './comment-marker.mjs';

const MAX_INPUT_BYTES = 128 * 1024;
const DECIMAL = /^\d+$/;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

const { values } = parseArgs({
  strict: true,
  allowPositionals: false,
  options: Object.fromEntries([
    'comment',
    'report',
    'platform',
    'candidate-sha',
    'run-id',
    'artifact-id',
    'artifact-name',
    'artifact-sha256',
    'verifier-exit',
  ].map((name) => [name, { type: 'string' }])),
});

function required(name) {
  const value = String(values[name] ?? '');
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function unchanged(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readStrictUtf8(path, label) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size <= 0n || before.size > BigInt(MAX_INPUT_BYTES)) {
    throw new Error(`${label} is not one bounded regular file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !unchanged(before, opened)) {
      throw new Error(`${label} changed identity before reading`);
    }
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== bytes.length || !unchanged(opened, after)) {
      throw new Error(`${label} changed while reading`);
    }
    return { bytes, text: STRICT_UTF8.decode(bytes) };
  } finally {
    await handle.close();
  }
}

const comment = await readStrictUtf8(required('comment'), 'comment file');
const reportFile = await readStrictUtf8(required('report'), 'attestation report');
const report = JSON.parse(reportFile.text);
if (!Buffer.from(canonicalStringify(report), 'utf8').equals(reportFile.bytes)) {
  throw new Error('attestation report is not canonical');
}

const decoded = decodeAttestationComment(comment.text);
if (canonicalStringify(decoded) !== reportFile.text) {
  throw new Error('comment body does not equal the attestation report');
}

const verifierExitText = required('verifier-exit');
if (!DECIMAL.test(verifierExitText)) throw new Error('verifier exit is invalid');
const verifierExit = Number(verifierExitText);
if (!Number.isSafeInteger(verifierExit) || verifierExit > 2147483647) {
  throw new Error('verifier exit is invalid');
}

const errors = validateAttestation(decoded, {
  platform: required('platform'),
  candidateSha: required('candidate-sha'),
  workflowRunId: required('run-id'),
  artifactId: required('artifact-id'),
  artifactName: required('artifact-name'),
  artifactSha256: required('artifact-sha256'),
});
if (errors.length) throw new Error(errors.join('; '));
if (verifierExit !== 0 && decoded.result !== 'FAIL') {
  throw new Error('a nonzero verifier exit may publish only a complete canonical FAIL');
}
