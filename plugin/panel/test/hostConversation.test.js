import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostConversation } from '../src/lib/hostConversation.js';

test('host conversation ensures once, updates policy, exposes path, and closes', () => {
  const calls = [];
  const conversations = {
    create(input) {
      calls.push(['create', input]);
      return {
        id: 'conversation-1',
        token: 'token-1',
        path: '/mcp/c/token-1',
        policy: input.policy,
      };
    },
    update(id, patch) {
      calls.push(['update', id, patch]);
      return {
        id,
        token: 'token-1',
        path: '/mcp/c/token-1',
        policy: { approvalTier: 'auto', expertGuidance: true },
      };
    },
    close(id) {
      calls.push(['close', id]);
      return true;
    },
  };
  const manager = createHostConversation({ getHost: () => ({ mcp: { conversations } }) });

  const first = manager.ensureConversation({
    label: 'chat-1',
    approvalTier: 'manual',
    expertGuidance: true,
  });
  assert.equal(manager.ensureConversation({ label: 'ignored' }), first);
  assert.equal(manager.currentPath(), '/mcp/c/token-1');
  assert.equal(manager.currentId(), 'conversation-1');
  assert.equal(manager.currentConversation(), first);
  assert.equal(manager.updatePolicy({ approvalTier: 'auto' }).policy.approvalTier, 'auto');
  assert.equal(manager.closeConversation(), true);
  assert.equal(manager.currentPath(), null);
  assert.equal(manager.currentId(), null);
  assert.deepEqual(calls, [
    ['create', {
      label: 'chat-1',
      policy: { approvalTier: 'manual', expertGuidance: true },
    }],
    ['update', 'conversation-1', { approvalTier: 'auto' }],
    ['close', 'conversation-1'],
  ]);
});

test('host conversation returns null without throwing before the host MCP API starts', () => {
  const manager = createHostConversation({ getHost: () => null });
  assert.equal(manager.ensureConversation({ label: 'chat-0' }), null);
  assert.equal(manager.updatePolicy({ approvalTier: 'readonly' }), null);
  assert.equal(manager.closeConversation(), false);
  assert.equal(manager.currentPath(), null);
});

test('host conversation does not return a stale path after the host MCP API disappears', () => {
  let host = {
    mcp: {
      conversations: {
        create: ({ policy }) => ({ id: 'conversation-1', path: '/mcp/c/token-1', policy }),
        update: () => null,
        close: () => true,
      },
    },
  };
  const manager = createHostConversation({ getHost: () => host });
  assert.equal(manager.ensureConversation({ label: 'chat-0' }).path, '/mcp/c/token-1');
  host = null;
  assert.equal(manager.ensureConversation({ label: 'chat-0' }), null);
  assert.equal(manager.currentPath(), null);
});
