import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAttestationComment, decodeAttestationComment } from '../comment-marker.mjs';

test('comment round-trips one canonical report and rejects extra markers', () => {
  const report = { schemaVersion: 1, platform: 'macos-arm64', result: 'PASS' };
  const body = encodeAttestationComment(report);
  assert.deepEqual(decodeAttestationComment(body), report);
  assert.throws(
    () => decodeAttestationComment(`${body}\n${body}`),
    /exactly one attestation marker/,
  );
  assert.throws(
    () => decodeAttestationComment(`<!-- ae-mcp-rc-attestation:v1 -->\n${body}`),
    /exactly one attestation marker/,
  );
});

test('comment parser rejects ambiguous fences and marker injection', () => {
  const report = { schemaVersion: 1, platform: 'macos-arm64', result: 'FAIL' };
  const body = encodeAttestationComment(report);
  assert.throws(
    () => decodeAttestationComment(`${body}\n\`\`\`json\n{}\n\`\`\``),
    /exactly one JSON fence/,
  );
  assert.throws(
    () => encodeAttestationComment({ ...report, failure: '<!-- ae-mcp-rc-attestation:v1 -->' }),
    /unsafe attestation marker content/,
  );
});
