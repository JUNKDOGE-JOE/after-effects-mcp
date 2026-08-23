import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElicitationCoordinator } from '../src/lib/elicitationCoordinator.js';
import { approvalRequestFor, createHostApprovalBridge } from '../src/lib/hostApprovalBridge.js';

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
    resolveApproval: () => ({ decision: 'ask', risk: 'destructive', allowSession: false }),
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
    tool: 'ae_execRecover',
    risk: 'destructive',
    summary: {
      code: 'app.project.item(1).remove();',
      undo_group_name: 'Remove layer',
      checkpoint_label: 'before-remove',
      recoveryId: 'abc123',
      retryMode: 'restore',
      restoreCheckpointId: 'checkpoint-7',
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
  assert.match(visible.request.message, /Approve After Effects tool action ae_execRecover \(destructive\)\?/);
  assert.match(visible.request.message, /Code: app\.project\.item\(1\)\.remove\(\);/);
  assert.match(visible.request.message, /Retry: abc123 \(restore checkpoint checkpoint-7\)/);
  assert.ok(visible.plan);
  assert.ok(visible.request.requestedSchema['x-ae-mcp-plan']);
  coordinator.resolveVisible({ id: visible.id, action: 'accept', content: { decision: 'once' } });
  await tick();

  assert.deepEqual(resolutions, [['approval-1', 'accept']]);
  bridge.detach();
  coordinator.dispose();
});

test('host approval decline resolves decline and other conversations are ignored', async () => {
  const { approvals, coordinator, bridge, resolutions } = harness();
  approvals.emit('request', { ...request('ignored'), conversationId: 'conversation-2' });
  await tick();
  assert.equal(coordinator.snapshot(), null);

  approvals.emit('request', request('approval-2'));
  await tick();
  let visible = coordinator.snapshot();
  coordinator.resolveVisible({ id: visible.id, action: 'decline', content: {} });
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

test('host approval maps cancellation distinctly', async () => {
  const { approvals, coordinator, bridge, resolutions } = harness();
  approvals.emit('request', request('approval-cancel'));
  await tick();
  const visible = coordinator.snapshot();
  coordinator.resolveVisible({ id: visible.id, action: 'cancel', content: {} });
  await tick();

  assert.deepEqual(resolutions, [['approval-cancel', 'cancel']]);
  bridge.detach();
  coordinator.dispose();
});

test('detaching the bridge cancels a visible host approval immediately', async () => {
  const { approvals, coordinator, bridge, resolutions } = harness();
  approvals.emit('request', request('approval-detach'));
  await tick();
  assert.ok(coordinator.snapshot());

  bridge.detach();
  await tick();

  assert.deepEqual(resolutions, [['approval-detach', 'cancel']]);
  coordinator.dispose();
});

test('host approval maps an approval strategy failure to unavailable', async () => {
  const approvals = new EventEmitter();
  const resolutions = [];
  approvals.resolve = (id, decision) => { resolutions.push([id, decision]); return true; };
  const coordinator = createElicitationCoordinator({
    resolveApproval: () => { throw new Error('policy service unavailable'); },
  });
  const bridge = createHostApprovalBridge();
  bridge.attach({
    approvals,
    coordinator,
    resolveConversationContext: () => ({ label: 'chat-1' }),
  });
  approvals.emit('request', request('approval-unavailable'));
  await tick();
  assert.deepEqual(resolutions, [['approval-unavailable', 'unavailable']]);
  bridge.detach();
  coordinator.dispose();
});

test('host approval retry summary renders continue without a checkpoint label', () => {
  const approval = approvalRequestFor({
    tool: 'ae_execRecover',
    risk: 'destructive',
    summary: { recoveryId: 'xyz789', retryMode: 'continue', restoreCheckpointId: 'ignored' },
  });
  assert.match(approval.message, /Retry: xyz789 \(continue\)/);
});

test('host approval cards do not offer a session grant the host cannot remember', async () => {
  const approvals = new EventEmitter();
  approvals.resolve = () => true;
  const coordinator = createElicitationCoordinator({
    resolveApproval: () => ({ decision: 'ask', risk: 'write', allowSession: true }),
  });
  const bridge = createHostApprovalBridge();
  bridge.attach({
    approvals,
    coordinator,
    resolveConversationContext: () => ({ label: 'chat-1' }),
  });
  approvals.emit('request', {
    ...request('approval-write'),
    tool: 'ae_checkpoint',
    risk: 'write',
  });
  await tick();

  assert.equal(coordinator.snapshot().policy.allowSession, false);
  bridge.detach();
  coordinator.dispose();
});
