import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createToolLibraryApi,
  executeToolLibraryAction,
  filterToolLibraryItems,
  groupToolLibraryItems,
  mergeToolLibraryItems,
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
      { id: 'deprecated', status: 'deprecated' },
      { id: 'wrong', status: 'candidate' },
    ],
  });
  assert.deepEqual(rows.candidates.map((item) => item.id), ['candidate']);
  assert.deepEqual(rows.artifacts.map((item) => item.id), ['saved', 'pinned', 'archived', 'deprecated']);
  assert.deepEqual(toolLibraryActions('candidate'), ['promote', 'delete']);
  assert.deepEqual(toolLibraryActions('saved'), ['pin', 'archive', 'export']);
  assert.deepEqual(toolLibraryActions('pinned'), ['restore', 'archive', 'export']);
  assert.deepEqual(toolLibraryActions('archived'), ['restore', 'delete']);
});

test('tool library merge and grouping keep managed status visible', () => {
  const rows = mergeToolLibraryItems(
    [{ id: 'saved', name: 'Saved', status: 'saved' }, { id: 'pinned', status: 'pinned' }],
    {
      candidates: [{ id: 'candidate', name: 'Candidate', status: 'candidate' }],
      artifacts: [
        { id: 'saved', name: 'Saved', status: 'saved' },
        { id: 'archived', name: 'Archived', status: 'archived' },
        { id: 'deprecated', name: 'Deprecated', status: 'deprecated' },
      ],
    },
  );
  assert.deepEqual(groupToolLibraryItems(rows).map((group) => ({
    status: group.status,
    ids: group.items.map((item) => item.id),
  })), [
    { status: 'pinned', ids: ['pinned'] },
    { status: 'saved', ids: ['saved'] },
    { status: 'candidate', ids: ['candidate'] },
    { status: 'archived', ids: ['archived', 'deprecated'] },
  ]);
  assert.deepEqual(filterToolLibraryItems(rows, 'deprecated').map((item) => item.id), ['deprecated']);
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

test('tool library action mapping calls the matching management endpoint', async () => {
  const calls = [];
  const api = Object.fromEntries([
    ['promote', 'promote'],
    ['pin', 'pin'],
    ['archive', 'archive'],
    ['restore', 'restore'],
    ['remove', 'remove'],
    ['exportArtifact', 'export'],
  ].map(([method, action]) => [method, async (id) => { calls.push([action, id]); return { ok: true }; }]));
  for (const action of ['promote', 'pin', 'archive', 'restore', 'delete', 'export']) {
    await executeToolLibraryAction(api, action, 'user:1');
  }
  assert.deepEqual(calls, [
    ['promote', 'user:1'], ['pin', 'user:1'], ['archive', 'user:1'],
    ['restore', 'user:1'], ['remove', 'user:1'], ['export', 'user:1'],
  ]);
});
