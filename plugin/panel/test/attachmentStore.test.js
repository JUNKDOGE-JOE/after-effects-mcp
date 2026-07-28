import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMacosAdapter } from '../src/cep/platform/macos.js';
import { createAttachmentStore } from '../src/cep/attachmentStore.js';
import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_CLIPBOARD_ITEM_BYTES,
  MAX_CLIPBOARD_TURN_BYTES,
} from '../../shared/chat-attachments.mjs';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-attachments-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makePlatform(tempRoot, overrides = {}) {
  const platform = createMacosAdapter({
    platform: 'darwin',
    arch: 'arm64',
    home: path.join(tempRoot, 'home'),
    temp: tempRoot,
    env: {},
    fs,
    spawnImpl() {
      throw new Error('not expected');
    },
    now: () => 0,
  });
  if (!Object.keys(overrides).length) return platform;
  return {
    ...platform,
    paths: { ...platform.paths, ...overrides },
  };
}

function makeStore(root, overrides = {}) {
  let sequence = 0;
  return createAttachmentStore({
    platform: makePlatform(root, overrides.pathOverrides),
    randomUUID: () => 'attachment-' + (++sequence),
    readBlobChunk: (slice) => slice.arrayBuffer(),
    ...overrides,
  });
}

function namedBlob(contents, name = 'clip.bin', type = 'application/octet-stream') {
  const blob = new Blob([contents], { type });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

function allFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test('path-backed originals remain user-owned and are never deleted', async (t) => {
  const root = makeRoot(t);
  const original = path.join(root, 'original.mov');
  fs.writeFileSync(original, Buffer.from('video'));
  const store = makeStore(root);

  const ref = await store.prepare(
    { name: 'original.mov', size: 5, type: 'video/quicktime', path: original },
    { sessionId: 's1', pondId: 'p1' },
  );

  assert.equal(ref.temporary, false);
  assert.equal(ref.localPath, original);
  store.release(ref.id);
  store.release(ref.id);
  assert.equal(fs.readFileSync(original, 'utf8'), 'video');
});

test('pathless blob is staged atomically and removed with its session', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(root, { chunkBytes: 2 });
  const ref = await store.prepare(
    namedBlob(Buffer.from('abc')),
    { sessionId: 's1', pondId: 'p1' },
  );

  assert.equal(ref.temporary, true);
  assert.equal(fs.readFileSync(ref.localPath, 'utf8'), 'abc');
  assert.equal(path.basename(ref.localPath), 'attachment-1-clip.bin');
  assert.equal(allFiles(root).some((file) => file.endsWith('.part')), false);

  store.releaseSession('s1');
  store.releaseSession('s1');
  assert.equal(fs.existsSync(ref.localPath), false);
});

test('staged names strip both path separator styles', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(root);
  const ref = await store.prepare(
    namedBlob(Buffer.from('abc'), '../../nested\\secret.bin'),
    { sessionId: 's1', pondId: 'p1' },
  );

  assert.equal(path.basename(ref.localPath), 'attachment-1-secret.bin');
  assert.equal(ref.name, 'secret.bin');
});

test('store refuses a thirty-third attachment before touching disk', async (t) => {
  const root = makeRoot(t);
  const original = path.join(root, 'original.txt');
  fs.writeFileSync(original, 'x');
  const store = makeStore(root);
  for (let index = 0; index < MAX_ATTACHMENTS_PER_TURN; index += 1) {
    await store.prepare(
      { name: 'original.txt', size: 1, type: 'text/plain', path: original },
      { sessionId: 's1', pondId: 'p' + index },
    );
  }

  await assert.rejects(
    store.prepare(
      { name: 'original.txt', size: 1, type: 'text/plain', path: original },
      { sessionId: 's1', pondId: 'overflow' },
    ),
    (error) => error.code === 'ATTACHMENT_COUNT_LIMIT',
  );
  assert.deepEqual(allFiles(root), [original]);
});

test('pathless staging enforces per-item and per-turn byte limits', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(root, {
    chunkBytes: MAX_CLIPBOARD_ITEM_BYTES,
    readBlobChunk: async () => new Uint8Array(),
  });
  const fakeBlob = (size, name) => ({
    name,
    size,
    type: 'application/octet-stream',
    slice() {
      return {};
    },
  });

  await assert.rejects(
    store.prepare(
      fakeBlob(MAX_CLIPBOARD_ITEM_BYTES + 1, 'too-large.bin'),
      { sessionId: 's1', pondId: 'p0' },
    ),
    (error) => error.code === 'ATTACHMENT_ITEM_TOO_LARGE',
  );

  await store.prepare(
    fakeBlob(MAX_CLIPBOARD_ITEM_BYTES, 'one.bin'),
    { sessionId: 's1', pondId: 'p1' },
  );
  await store.prepare(
    fakeBlob(MAX_CLIPBOARD_TURN_BYTES - MAX_CLIPBOARD_ITEM_BYTES, 'two.bin'),
    { sessionId: 's1', pondId: 'p2' },
  );
  await assert.rejects(
    store.prepare(
      fakeBlob(1, 'overflow.bin'),
      { sessionId: 's1', pondId: 'p3' },
    ),
    (error) => error.code === 'ATTACHMENT_TURN_TOO_LARGE',
  );
});

test('partial staging failure removes the part file and record', async (t) => {
  const root = makeRoot(t);
  let reads = 0;
  const store = makeStore(root, {
    chunkBytes: 2,
    async readBlobChunk(slice) {
      reads += 1;
      if (reads === 2) throw new Error('reader failed');
      return slice.arrayBuffer();
    },
  });

  await assert.rejects(
    store.prepare(
      namedBlob(Buffer.from('abcd')),
      { sessionId: 's1', pondId: 'p1' },
    ),
    (error) => error.code === 'ATTACHMENT_STAGING_FAILED',
  );
  assert.deepEqual(allFiles(root), []);
  assert.doesNotThrow(() => store.releaseSession('s1'));
});

test('cleanup refuses to unlink when containment cannot be proven', async (t) => {
  const root = makeRoot(t);
  let containmentAvailable = true;
  const store = makeStore(root, {
    pathOverrides: {
      contains() {
        return containmentAvailable;
      },
    },
  });
  const ref = await store.prepare(
    namedBlob(Buffer.from('abc')),
    { sessionId: 's1', pondId: 'p1' },
  );

  containmentAvailable = false;
  store.release(ref.id);
  assert.equal(fs.existsSync(ref.localPath), true);
});

test('dispose removes every managed temporary and preserves originals', async (t) => {
  const root = makeRoot(t);
  const original = path.join(root, 'original.txt');
  fs.writeFileSync(original, 'original');
  const store = makeStore(root);
  await store.prepare(
    { name: 'original.txt', size: 8, type: 'text/plain', path: original },
    { sessionId: 's1', pondId: 'p1' },
  );
  const temporary = await store.prepare(
    namedBlob(Buffer.from('temp')),
    { sessionId: 's2', pondId: 'p2' },
  );

  store.dispose();
  store.dispose();

  assert.equal(fs.readFileSync(original, 'utf8'), 'original');
  assert.equal(fs.existsSync(temporary.localPath), false);
});
