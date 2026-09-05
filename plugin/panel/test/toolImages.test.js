import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureToolImages, toolDisplayText } from '../src/cep/toolImages.js';
import { reduceEvent } from '../src/lib/chatEntries.js';
import { createSessionStore } from '../src/cep/sessionStore.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const mcp = { type: 'image', mimeType: 'image/png', data: png };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-images-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { id: process.platform === 'win32' ? 'windows-x64' : 'macos-arm64', fs,
    paths: { configRoot: root, join: (parts) => path.join(...parts) } };
}

test('MCP, Claude source and OpenCode file payloads preserve identical pixels without mutating model results', (t) => {
  const adapter = fixture(t);
  const content = [mcp, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    { type: 'file', mime: 'image/png', url: `data:image/png;base64,${png}` }];
  const original = JSON.stringify(content);
  const { images } = captureToolImages(content, adapter);
  assert.equal(images.length, 3);
  assert.equal(new Set(images.map((image) => image.src)).size, 3);
  for (const image of images) assert.equal(fs.readFileSync(fileURLToPath(image.src)).toString('base64'), png);
  assert.equal(JSON.stringify(content), original);
  assert.equal(JSON.stringify(images).includes(png), false);
});

test('out-of-order results stay with their call and historical transcripts contain only image references', (t) => {
  const adapter = fixture(t);
  let entries = reduceEvent([], { type: 'tool-start', toolUseId: 'a' });
  entries = reduceEvent(entries, { type: 'tool-start', toolUseId: 'b' });
  const a = captureToolImages([mcp], adapter);
  const b = captureToolImages([mcp, mcp], adapter);
  entries = reduceEvent(entries, { type: 'tool-result', toolUseId: 'b', ok: true, ...b });
  entries = reduceEvent(entries, { type: 'tool-result', toolUseId: 'a', ok: true, ...a });
  assert.deepEqual(entries.map((entry) => entry.images), [a.images, b.images]);
  const store = createSessionStore({ platform: adapter });
  store.saveTranscript('chat-test', entries);
  const restored = store.loadTranscript('chat-test');
  assert.equal(JSON.stringify(restored).includes(png), false);
  assert.ok(JSON.stringify(restored).length < 2000);
  assert.ok(fs.existsSync(fileURLToPath(restored.entries[0].images[0].src)));
  fs.unlinkSync(fileURLToPath(a.images[0].src));
  assert.deepEqual(store.loadTranscript('chat-test'), restored);
  assert.ok(!fs.existsSync(fileURLToPath(restored.entries[0].images[0].src)));
  assert.deepEqual(reduceEvent(entries, { type: 'tool-result', toolUseId: 'a', ok: false })[0].images, []);
  assert.equal(reduceEvent([], { type: 'tool-result', toolUseId: 'c', ok: true, ...b })[0].images.length, 2);
});

test('cache evicts only owned old files and enforces a byte budget', (t) => {
  const adapter = fixture(t);
  const cache = path.join(adapter.paths.configRoot, 'tool-images');
  fs.mkdirSync(cache);
  const old = path.join(cache, 'preview-old.png');
  fs.writeFileSync(old, 'old');
  fs.utimesSync(old, new Date(0), new Date(0));
  fs.writeFileSync(path.join(cache, 'keep.txt'), 'unrelated');
  const large = path.join(cache, 'preview-large.png');
  fs.writeFileSync(large, '');
  fs.truncateSync(large, 64 * 1024 * 1024);
  const { images } = captureToolImages([mcp], adapter);
  assert.ok(images[0].src);
  assert.ok(!fs.existsSync(old));
  assert.ok(!fs.existsSync(large));
  assert.equal(fs.readFileSync(path.join(cache, 'keep.txt'), 'utf8'), 'unrelated');
});

test('invalid, unavailable and excessive images remain explicit without throwing or exposing base64', (t) => {
  const adapter = fixture(t);
  assert.deepEqual(captureToolImages([{ ...mcp, data: '?' }], adapter).images, [{ unavailable: 'load' }]);
  assert.deepEqual(captureToolImages([{ ...mcp, mimeType: 'image/svg+xml' }], adapter).images, [{ unavailable: 'format' }]);
  assert.deepEqual(captureToolImages([{ ...mcp, data: 'AAAA'.repeat(1200000) }], adapter).images, [{ unavailable: 'limit' }]);
  assert.deepEqual(captureToolImages([mcp], {}).images, [{ unavailable: 'load' }]);
  assert.equal(captureToolImages(Array(34).fill(mcp), adapter).images.at(-1).unavailable, 'limit');
  assert.equal(toolDisplayText(`{"base64":"${png}"} data:image/png;base64,${png}`), '{"base64":"[image]"} [image]');
});
