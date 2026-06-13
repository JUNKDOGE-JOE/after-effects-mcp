import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revertToPreviousCheckpoint } from '../src/lib/activityModel.js';

function makeMcp(checkpoints) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'ae.checkpoint') {
        return { ok: true, checkpoints };
      }
      return { ok: true, reverted: true };
    },
  };
}

test('revertToPreviousCheckpoint lists the latest checkpoint then reverts to its id', async () => {
  const mcp = makeMcp([{ id: 'cp-latest', label: 'Before edit' }]);

  const result = await revertToPreviousCheckpoint(mcp);

  assert.deepEqual(result, { ok: true, reverted: true });
  assert.deepEqual(mcp.calls, [
    { name: 'ae.checkpoint', args: { action: 'list', limit: 1 } },
    { name: 'ae.revert', args: { checkpoint_id: 'cp-latest', branch_before_revert: true } },
  ]);
});

test('revertToPreviousCheckpoint reads checkpoint lists from MCP text content', async () => {
  const calls = [];
  const mcp = {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'ae.checkpoint') {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, checkpoints: [{ id: 'cp-text' }] }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, reverted: true }) }] };
    },
  };

  await revertToPreviousCheckpoint(mcp, { branchBeforeRevert: false });

  assert.deepEqual(calls, [
    { name: 'ae.checkpoint', args: { action: 'list', limit: 1 } },
    { name: 'ae.revert', args: { checkpoint_id: 'cp-text', branch_before_revert: false } },
  ]);
});

test('revertToPreviousCheckpoint rejects when no checkpoint exists', async () => {
  const mcp = makeMcp([]);

  await assert.rejects(
    revertToPreviousCheckpoint(mcp),
    /No checkpoint available/,
  );
  assert.deepEqual(mcp.calls, [
    { name: 'ae.checkpoint', args: { action: 'list', limit: 1 } },
  ]);
});
