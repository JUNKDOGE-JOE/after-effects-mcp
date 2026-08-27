import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createToolLibraryApi,
  parseToolLibraryImport,
  splitToolLibraryItems,
  toolLibraryActions,
} from './toolLibrary.js';

function platform() {
  return {
    paths: { configRoot: '/state', join: (parts) => parts.join('/') },
    fs: { readFileSync: () => 'test-token\n' },
  };
}

test('tool library model separates list rows and exposes each permitted action', () => {
  const rows = splitToolLibraryItems({
    candidates: [{ id: 'candidate', status: 'candidate' }, { id: 'wrong', status: 'saved' }],
    artifacts: [
      { id: 'saved', status: 'saved' },
      { id: 'pinned', status: 'pinned' },
      { id: 'archived', status: 'archived', lastUsedAt: undefined },
      { id: 'wrong', status: 'candidate' },
    ],
  });
  assert.deepEqual(rows.candidates.map((item) => item.id), ['candidate']);
  assert.deepEqual(rows.artifacts.map((item) => item.id), ['saved', 'pinned', 'archived']);
  assert.deepEqual(toolLibraryActions('candidate'), ['promote', 'delete']);
  assert.deepEqual(toolLibraryActions('saved'), ['pin', 'archive', 'export']);
  assert.deepEqual(toolLibraryActions('pinned'), ['restore', 'archive', 'export']);
  assert.deepEqual(toolLibraryActions('archived'), ['restore', 'delete']);
});

test('tool library import parsing provides visible errors for invalid JSON', () => {
  assert.deepEqual(parseToolLibraryImport('{"schemaVersion":1}'), { schemaVersion: 1 });
  assert.throws(() => parseToolLibraryImport('{'), /invalid/i);
  assert.throws(() => parseToolLibraryImport('[]'), /object/i);
});

test('tool library API sends token-authenticated operations and surfaces host failures', async () => {
  const requests = [];
  const api = createToolLibraryApi({
    port: 19001,
    platform: platform(),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, candidates: [], artifacts: [] }) };
    },
  });
  await api.list();
  await api.promote('user:abc');
  await api.importArtifact({ schemaVersion: 1 });
  assert.equal(requests[0].url, 'http://127.0.0.1:19001/tool-library');
  assert.equal(requests[0].options.headers['x-ae-mcp-token'], 'test-token');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[2].options.body, '{"wire":{"schemaVersion":1}}');

  const failing = createToolLibraryApi({
    platform: platform(),
    fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false, error: 'duplicate', existingId: 'user:existing' }) }),
  });
  await assert.rejects(failing.importArtifact({}), (error) => (
    error.message === 'duplicate' && error.existingId === 'user:existing'
  ));
});
