import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_SCHEMA_KEY } from '../../shared/tool-approval.mjs';
import { createElicitationCoordinator } from '../src/lib/elicitationCoordinator.js';

const PLAN = {
  artifactId: 'user:123',
  contentHash: 'a'.repeat(64),
  operation: 'execute',
  normalizedArgs: {},
  target: {},
  planHash: 'b'.repeat(64),
  risk: 'write',
  expiresAt: 9999999999999,
};

function planRequest(message) {
  return {
    message,
    mode: 'form',
    requestedSchema: { type: 'object', [PLAN_SCHEMA_KEY]: PLAN },
  };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('coordinator exposes one immutable request and advances FIFO', async () => {
  const snapshots = [];
  const coordinator = createElicitationCoordinator({
    resolveApproval: () => ({ decision: 'ask', allowSession: true }),
    presentGenericForm: () => null,
  });
  coordinator.subscribe((snapshot) => snapshots.push(snapshot));
  const first = coordinator.handle(planRequest('first'), {});
  const second = coordinator.handle(planRequest('second'), {});
  await tick();

  const visible = coordinator.snapshot();
  assert.equal(visible.request.message, 'first');
  assert.equal(Object.isFrozen(visible), true);
  assert.equal(Object.isFrozen(visible.request), true);
  assert.throws(() => { visible.request.message = 'changed'; }, TypeError);
  assert.equal(coordinator.resolveVisible({ id: 'not-visible', decision: 'once' }), false);
  assert.equal(coordinator.resolveVisible({ id: visible.id, decision: 'once' }), true);
  assert.deepEqual(await first, { action: 'accept', content: { decision: 'once' } });
  assert.equal(coordinator.snapshot().request.message, 'second');

  const secondVisible = coordinator.snapshot();
  coordinator.resolveVisible({ id: secondVisible.id, decision: 'session' });
  assert.deepEqual(await second, { action: 'accept', content: { decision: 'session' } });
  assert.equal(coordinator.snapshot(), null);
  assert.ok(snapshots.length >= 3);
});

test('aborted queued requests are removed without becoming visible', async () => {
  const coordinator = createElicitationCoordinator({
    resolveApproval: () => ({ decision: 'ask', allowSession: true }),
    presentGenericForm: () => null,
  });
  const queuedController = new AbortController();
  const first = coordinator.handle(planRequest('first'), {});
  const queued = coordinator.handle(planRequest('queued'), { signal: queuedController.signal });
  const third = coordinator.handle(planRequest('third'), {});
  await tick();

  queuedController.abort();
  assert.deepEqual(await queued, { action: 'cancel', content: {} });
  assert.equal(coordinator.snapshot().request.message, 'first');
  const visible = coordinator.snapshot();
  coordinator.resolveVisible({ id: visible.id, decision: 'deny' });
  assert.deepEqual(await first, { action: 'decline', content: {} });
  assert.equal(coordinator.snapshot().request.message, 'third');
  coordinator.dispose();
  assert.deepEqual(await third, { action: 'cancel', content: {} });
  assert.equal(coordinator.snapshot(), null);
});

test('malformed or expired plan elicitation declines without generic fallback', async () => {
  let approvalCalls = 0;
  let genericCalls = 0;
  const coordinator = createElicitationCoordinator({
    resolveApproval: () => { approvalCalls += 1; },
    presentGenericForm: () => { genericCalls += 1; },
    now: () => Date.now(),
  });
  const malformed = planRequest('bad');
  malformed.requestedSchema[PLAN_SCHEMA_KEY] = { ...PLAN, expiresAt: 1 };

  assert.deepEqual(await coordinator.handle(malformed, {}), { action: 'decline', content: {} });
  assert.equal(approvalCalls, 0);
  assert.equal(genericCalls, 0);
  assert.equal(coordinator.snapshot(), null);
});

test('automatic policy settles immediately and high risk cannot gain session scope', async () => {
  const auto = createElicitationCoordinator({
    resolveApproval: () => ({ decision: 'allow', allowSession: false }),
    presentGenericForm: () => null,
  });
  assert.deepEqual(await auto.handle(planRequest('auto'), {}), {
    action: 'accept', content: { decision: 'once' },
  });
  assert.equal(auto.snapshot(), null);

  const high = createElicitationCoordinator({
    resolveApproval: () => ({ decision: 'ask', allowSession: false }),
    presentGenericForm: () => null,
  });
  const pending = high.handle(planRequest('high'), {});
  await tick();
  const visible = high.snapshot();
  high.resolveVisible({
    id: visible.id,
    action: 'accept',
    content: { decision: 'session' },
  });
  assert.deepEqual(await pending, { action: 'decline', content: {} });
});

test('async presentation classification preserves arrival order', async () => {
  let releaseFirst;
  const firstReady = new Promise((resolve) => { releaseFirst = resolve; });
  const coordinator = createElicitationCoordinator({
    resolveApproval: () => ({ decision: 'ask', allowSession: true }),
    presentGenericForm: async (request) => {
      if (request.message === 'first') await firstReady;
      return { title: request.message };
    },
  });
  const first = coordinator.handle({ message: 'first', requestedSchema: { type: 'object' } }, {});
  const second = coordinator.handle({ message: 'second', requestedSchema: { type: 'object' } }, {});
  await tick();
  assert.equal(coordinator.snapshot().request.message, 'first');
  assert.equal(coordinator.snapshot().presentation, undefined);
  releaseFirst();
  await tick();
  assert.equal(coordinator.snapshot().request.message, 'first');
  let visible = coordinator.snapshot();
  coordinator.resolveVisible({ id: visible.id, action: 'decline', content: {} });
  assert.deepEqual(await first, { action: 'decline', content: {} });
  assert.equal(coordinator.snapshot().request.message, 'second');
  visible = coordinator.snapshot();
  coordinator.resolveVisible({ id: visible.id, action: 'decline', content: {} });
  assert.deepEqual(await second, { action: 'decline', content: {} });
});

test('generic presenter waits until an earlier plan is no longer visible', async () => {
  let genericCalls = 0;
  const coordinator = createElicitationCoordinator({
    resolveApproval: () => ({ decision: 'ask', allowSession: true }),
    presentGenericForm: (request) => {
      genericCalls += 1;
      return { title: request.message };
    },
  });
  const planPending = coordinator.handle(planRequest('plan'), {});
  const genericPending = coordinator.handle({
    message: 'generic',
    requestedSchema: { type: 'object', properties: {} },
  }, {});
  await tick();

  assert.equal(coordinator.snapshot().request.message, 'plan');
  assert.equal(genericCalls, 0);
  let visible = coordinator.snapshot();
  coordinator.resolveVisible({ id: visible.id, decision: 'once' });
  assert.deepEqual(await planPending, { action: 'accept', content: { decision: 'once' } });
  await tick();
  assert.equal(genericCalls, 1);
  assert.equal(coordinator.snapshot().request.message, 'generic');
  visible = coordinator.snapshot();
  coordinator.resolveVisible({ id: visible.id, action: 'decline', content: {} });
  assert.deepEqual(await genericPending, { action: 'decline', content: {} });
});

test('generic forms share the same FIFO and unsubscribe stops notifications', async () => {
  const coordinator = createElicitationCoordinator({
    resolveApproval: () => ({ decision: 'ask', allowSession: true }),
    presentGenericForm: (request) => ({ title: request.message }),
  });
  let calls = 0;
  const unsubscribe = coordinator.subscribe(() => { calls += 1; });
  const pending = coordinator.handle({
    message: 'pick',
    requestedSchema: { type: 'object', properties: { value: { type: 'string' } } },
  }, {});
  await tick();
  const visible = coordinator.snapshot();
  assert.deepEqual(visible.presentation, { title: 'pick' });
  unsubscribe();
  coordinator.resolveVisible({ id: visible.id, action: 'accept', content: { value: 'x' } });
  assert.deepEqual(await pending, { action: 'accept', content: { value: 'x' } });
  const before = calls;
  coordinator.dispose();
  assert.equal(calls, before);
});

test('dispose aborts a request still resolving policy', async () => {
  let observedSignal;
  const coordinator = createElicitationCoordinator({
    resolveApproval: async (_request, { signal }) => {
      observedSignal = signal;
      await new Promise(() => {});
    },
    presentGenericForm: () => null,
  });
  const pending = coordinator.handle(planRequest('resolving'), {});
  await tick();
  coordinator.dispose();

  assert.deepEqual(await pending, { action: 'cancel', content: {} });
  assert.equal(observedSignal.aborted, true);
  assert.equal(coordinator.snapshot(), null);
});
