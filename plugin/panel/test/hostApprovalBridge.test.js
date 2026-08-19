import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElicitationCoordinator } from '../src/lib/elicitationCoordinator.js';
import { createHostApprovalBridge } from '../src/lib/hostApprovalBridge.js';

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness() {
  const approvals = new EventEmitter();
  const resolutions = [];
  approvals.resolve = (id, decision) => {
    resolutions.push([id, decision]);
    return true;
  };
  const coordinator = createElicitationCoordinator({
    presentGenericForm: (request) => ({ title: request.message }),
  });
  const bridge = createHostApprovalBridge();
  const resolveConversationContext = (conversationId) => (
    conversationId === 'conversation-1' ? { label: 'chat-1' } : null
  );
  bridge.attach({ approvals, coordinator, resolveConversationContext });
  // Repeating the exact attachment must not install a duplicate listener.
  bridge.attach({ approvals, coordinator, resolveConversationContext });
  return { approvals, coordinator, bridge, resolutions };
}

function request(id) {
  return {
    id,
    conversationId: 'conversation-1',
    sessionId: 'session-1',
    tool: 'ae_exec',
    risk: 'destructive',
    summary: {
      code: 'app.project.item(1).remove();',
      undo_group_name: 'Remove layer',
      checkpoint_label: 'before-remove',
    },
    createdAt: Date.now(),
  };
}

test('host approval request enters the elicitation card queue and accept resolves the host item', async () => {
  const { approvals, coordinator, bridge, resolutions } = harness();
  approvals.emit('request', request('approval-1'));
  await tick();

  const visible = coordinator.snapshot();
  assert.equal(visible.context.conversationId, 'conversation-1');
  assert.equal(visible.context.approvalId, 'approval-1');
  assert.match(visible.request.message, /Approve After Effects tool action ae_exec \(destructive\)\?/);
  assert.match(visible.request.message, /Code: app\.project\.item\(1\)\.remove\(\);/);
  assert.equal(visible.request.requestedSchema.properties.approve.type, 'boolean');
  coordinator.resolveVisible({ id: visible.id, action: 'accept', content: { approve: true } });
  await tick();

  assert.deepEqual(resolutions, [['approval-1', 'accept']]);
  bridge.detach();
  coordinator.dispose();
});

test('host approval false or decline resolves decline and other conversations are ignored', async () => {
  const { approvals, coordinator, bridge, resolutions } = harness();
  approvals.emit('request', { ...request('ignored'), conversationId: 'conversation-2' });
  await tick();
  assert.equal(coordinator.snapshot(), null);

  approvals.emit('request', request('approval-2'));
  await tick();
  let visible = coordinator.snapshot();
  coordinator.resolveVisible({ id: visible.id, action: 'accept', content: { approve: false } });
  await tick();

  approvals.emit('request', request('approval-3'));
  await tick();
  visible = coordinator.snapshot();
  coordinator.resolveVisible({ id: visible.id, action: 'decline', content: {} });
  await tick();

  assert.deepEqual(resolutions, [
    ['approval-2', 'decline'],
    ['approval-3', 'decline'],
  ]);
  bridge.detach();
  coordinator.dispose();
});
