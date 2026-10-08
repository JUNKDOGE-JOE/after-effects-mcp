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

test('host conversations retain the explicit instance and work directory at creation', () => {
  let input;
  const manager = createHostConversation({
    getHost: () => ({ mcp: { conversations: { create: (value) => { input = value; return { id: 'conversation' }; } } } }),
    getWorkContext: () => ({ instanceId: 'main-a', workDir: '/projects/a' }),
  });
  manager.ensureConversation({ label: 'chat-one', approvalTier: 'manual' });
  assert.equal(input.instanceId, 'main-a');
  assert.equal(input.workDir, '/projects/a');
});

test('host conversation explicitly reports a failed rebind after the host MCP API disappears', () => {
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
  assert.throws(() => manager.ensureConversation({ label: 'chat-0' }), {
    code: 'CEP_HOST_CONVERSATION_REBIND_FAILED',
  });
  assert.equal(manager.currentPath(), '/mcp/c/token-1');
});

test('host conversation rebinds by id when the host API object changes', () => {
  const first = {
    create: () => ({ id: 'conversation-1', path: '/mcp/c/token-1', policy: {} }),
  };
  const second = {
    getById: (id) => ({ id, path: '/mcp/c/token-2', policy: { approvalTier: 'manual' } }),
    update: (id, patch) => ({ id, path: '/mcp/c/token-2', policy: patch }),
    close: () => true,
  };
  let api = first;
  const manager = createHostConversation({ getHost: () => ({ mcp: { conversations: api } }) });
  manager.ensureConversation({ label: 'chat-0' });
  api = second;
  assert.equal(manager.ensureConversation({ label: 'chat-0' }).path, '/mcp/c/token-2');
  assert.equal(manager.updatePolicy({ approvalTier: 'auto' }).policy.approvalTier, 'auto');
});

test('turn acquisition is awaited, prevents navigation, and cannot be released by an old turn', async () => {
  let accept;
  const releases = [];
  const conversation = { id: 'conversation-1', path: '/mcp/c/one' };
  const conversations = {
    create: () => conversation,
    startTurn: (_id, turnId) => turnId === 'first'
      ? new Promise((resolve) => { accept = () => resolve(conversation); }) : conversation,
    endTurn: async (id, turnId) => { releases.push([id, turnId]); return true; },
    close: () => true,
  };
  const manager = createHostConversation({ getHost: () => ({ mcp: { conversations } }) });
  manager.ensureConversation();
  let ready = false;
  const pending = manager.startTurn('first').then((turn) => { ready = true; return turn; });
  await Promise.resolve();
  assert.equal(ready, false);
  assert.throws(() => manager.closeConversation(), { code: 'TURN_STILL_ACTIVE' });
  await assert.rejects(manager.startTurn('second'), { code: 'TURN_STILL_ACTIVE' });
  accept();
  const first = await pending;
  await Promise.all([manager.endTurn(first), manager.endTurn(first)]);
  assert.deepEqual(releases, [['conversation-1', 'first']]);
  const second = await manager.startTurn('second');
  assert.equal(await manager.endTurn(first), false);
  assert.equal(manager.currentTurn(), second);
  await manager.endTurn(second);
  assert.equal(manager.closeConversation(), true);
});

test('failed acquisition clears its token but an unconfirmed release retains the turn', async () => {
  let unavailable = true;
  let ended = false;
  const conversation = { id: 'conversation-1' };
  const conversations = {
    create: () => conversation,
    startTurn: async () => {
      if (unavailable) throw Object.assign(new Error('busy'), { code: 'WORKSPACE_BUSY' });
      return conversation;
    },
    endTurn: async () => ended,
  };
  const manager = createHostConversation({ getHost: () => ({ mcp: { conversations } }) });
  manager.ensureConversation();
  await assert.rejects(manager.startTurn('blocked'), { code: 'WORKSPACE_BUSY' });
  assert.equal(manager.currentTurn(), null);
  unavailable = false;
  const turn = await manager.startTurn('active');
  await assert.rejects(manager.endTurn(turn), { code: 'TURN_STILL_ACTIVE' });
  assert.equal(manager.currentTurn(), turn);
  ended = true;
  assert.equal(await manager.endTurn(turn), true);
});
