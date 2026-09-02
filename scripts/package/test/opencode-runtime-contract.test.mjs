import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyDownloadedArtifact, verifyExtractedBinary } from '../fetch-opencode-runtime.mjs';

async function writeFixtureFile(root, relative, value) {
  const target = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
  return target;
}

test('OpenCode runtime verification removes a hash-mismatched download', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-opencode-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = await writeFixtureFile(root, 'opencode.zip', Buffer.from('tiny'));
  const manifest = {
    version: 'v-test',
    url: 'https://example.invalid/opencode.zip',
    sizeBytes: 4,
    sha256: createHash('sha256').update('different').digest('hex'),
    binary: 'opencode.exe',
    binarySizeBytes: 6,
    binarySha256: createHash('sha256').update('binary').digest('hex'),
  };

  await assert.rejects(verifyDownloadedArtifact({ filePath: archive, manifest }), {
    code: 'OPENCODE_RUNTIME_HASH_MISMATCH',
  });
  await assert.rejects(fs.access(archive));
});

test('OpenCode runtime verification checks the extracted executable against the binary pins', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-opencode-binary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = await writeFixtureFile(root, 'opencode.exe', Buffer.from('binary'));
  const manifest = {
    version: 'v-test',
    url: 'https://example.invalid/opencode.zip',
    sizeBytes: 4,
    sha256: createHash('sha256').update('tiny').digest('hex'),
    binary: 'opencode.exe',
    binarySizeBytes: 6,
    binarySha256: createHash('sha256').update('binary').digest('hex'),
  };

  await verifyExtractedBinary({ filePath: binary, manifest });
  await assert.rejects(
    verifyExtractedBinary({ filePath: binary, manifest: { ...manifest, binarySizeBytes: 7 } }),
    { code: 'OPENCODE_RUNTIME_BINARY_SIZE_MISMATCH' },
  );
  await assert.rejects(
    verifyExtractedBinary({ filePath: binary, manifest: { ...manifest, binarySha256: '0'.repeat(64) } }),
    { code: 'OPENCODE_RUNTIME_BINARY_HASH_MISMATCH' },
  );
});
