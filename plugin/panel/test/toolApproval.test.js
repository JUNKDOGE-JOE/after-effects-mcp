import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PLAN_SCHEMA_KEY,
  approvalResult,
  decideToolPlan,
  extractToolPlan,
  isCoreAuthorizedDynamicCall,
  normalizeMcpToolName,
  planSessionKey,
} from '../../shared/tool-approval.mjs';

const BASE = {
  artifactId: 'user:123',
  contentHash: 'a'.repeat(64),
  operation: 'execute',
  normalizedArgs: {},
  target: { compId: '7' },
  planHash: 'b'.repeat(64),
  risk: 'write',
  expiresAt: 9999999999999,
};

test('four tiers enforce the server minimum', () => {
  assert.equal(decideToolPlan({ tier: 'readonly', plan: BASE }).decision, 'deny');
  assert.equal(decideToolPlan({ tier: 'manual', plan: BASE }).decision, 'ask');
  assert.equal(decideToolPlan({ tier: 'auto', plan: BASE }).decision, 'allow');
  assert.equal(decideToolPlan({ tier: 'none', plan: BASE }).decision, 'allow');

  for (const tier of ['manual', 'auto', 'none']) {
    const high = decideToolPlan({
      tier,
      plan: { ...BASE, risk: 'external' },
    });
    assert.equal(high.decision, 'ask');
    assert.equal(high.allowSession, false);
  }
});

test('read plans always allow and session allowance is write-only', () => {
  assert.deepEqual(decideToolPlan({ tier: 'readonly', plan: { ...BASE, risk: 'read' } }), {
    decision: 'allow', risk: 'read', allowSession: false, sessionKey: null,
  });
  const manual = decideToolPlan({ tier: 'manual', plan: BASE });
  assert.equal(manual.allowSession, true);
  assert.equal(manual.sessionKey, planSessionKey(BASE));
  assert.equal(decideToolPlan({ tier: 'manual', plan: BASE, sessionAllowed: true }).decision, 'allow');
  assert.equal(decideToolPlan({ tier: 'none', plan: { ...BASE, risk: 'destructive' }, sessionAllowed: true }).decision, 'ask');
  assert.deepEqual(decideToolPlan({ tier: 'manual', plan: { ...BASE, risk: 'bogus' } }), {
    decision: 'deny', risk: 'unknown', allowSession: false, sessionKey: null,
  });
  assert.deepEqual(decideToolPlan({ tier: 'invalid', plan: BASE }), {
    decision: 'deny', risk: 'write', allowSession: false, sessionKey: null,
  });
});

test('session key is canonical and binds artifact hash operation and target but not args', () => {
  const expectedPayload = JSON.stringify({
    artifactId: BASE.artifactId,
    contentHash: BASE.contentHash,
    normalizedTarget: BASE.target,
    operation: BASE.operation,
  });
  const expected = createHash('sha256').update(expectedPayload).digest('hex');
  assert.equal(planSessionKey(BASE), expected);
  assert.equal(planSessionKey(BASE), planSessionKey({ ...BASE, normalizedArgs: { changed: true } }));
  assert.notEqual(planSessionKey(BASE), planSessionKey({ ...BASE, artifactId: 'user:456' }));
  assert.notEqual(planSessionKey(BASE), planSessionKey({ ...BASE, contentHash: 'c'.repeat(64) }));
  assert.notEqual(planSessionKey(BASE), planSessionKey({ ...BASE, operation: 'apply' }));
  assert.notEqual(planSessionKey(BASE), planSessionKey({ ...BASE, target: { compId: '8' } }));
});

test('extractToolPlan validates and freezes unexpired plan schemas', () => {
  const schema = { type: 'object', [PLAN_SCHEMA_KEY]: BASE };
  const plan = extractToolPlan(schema, 1000);
  assert.deepEqual(plan, BASE);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.target), true);

  for (const invalid of [
    null,
    [],
    {},
    { ...BASE, artifactId: '' },
    { ...BASE, contentHash: 'A'.repeat(64) },
    { ...BASE, planHash: 'short' },
    { ...BASE, operation: 'call' },
    { ...BASE, risk: 'unknown' },
    { ...BASE, normalizedArgs: [] },
    { ...BASE, target: null },
    { ...BASE, expiresAt: 1000 },
  ]) {
    const requestedSchema = invalid && invalid.artifactId !== undefined
      ? { [PLAN_SCHEMA_KEY]: invalid }
      : invalid;
    assert.equal(extractToolPlan(requestedSchema, 1000), null);
  }
});

test('extractToolPlan preserves hostile JSON keys without prototype mutation', () => {
  const target = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}');
  const plan = extractToolPlan({ [PLAN_SCHEMA_KEY]: { ...BASE, target } }, 1000);

  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(plan.target, '__proto__'), true);
  assert.deepEqual(plan.target.__proto__, { polluted: true });
  assert.equal(plan.target.constructor, 'value');
});

test('approvalResult rejects unauthorized session decisions', () => {
  assert.deepEqual(approvalResult('deny', { allowSession: true }), { action: 'decline', content: {} });
  assert.deepEqual(approvalResult('once', { allowSession: false }), { action: 'accept', content: { decision: 'once' } });
  assert.deepEqual(approvalResult('session', { allowSession: true }), { action: 'accept', content: { decision: 'session' } });
  assert.deepEqual(approvalResult('session', { allowSession: false }), { action: 'decline', content: {} });
  assert.deepEqual(approvalResult('unexpected', { allowSession: true }), { action: 'decline', content: {} });
});

test('dynamic staged calls are delegated to core authorization', () => {
  for (const name of ['ae.toolUse', 'ae_toolUse', 'mcp__ae__ae_toolUse']) {
    assert.equal(normalizeMcpToolName(name), 'ae.toolUse');
    for (const action of ['render', 'prepare', 'grant', 'execute']) {
      assert.equal(isCoreAuthorizedDynamicCall(name, { action }), true);
    }
  }
  for (const name of ['ae.skillUse', 'ae_skillUse', 'mcp__ae__ae_skillUse']) {
    assert.equal(isCoreAuthorizedDynamicCall(name, { execute: true, name: 'legacy' }), true);
    assert.equal(isCoreAuthorizedDynamicCall(name, { execute: false, name: 'legacy' }), true);
  }
  assert.equal(isCoreAuthorizedDynamicCall('mcp__other__ae_toolUse', { action: 'grant' }), false);
  assert.equal(isCoreAuthorizedDynamicCall('mcp__ae__ae_toolUse', { action: 'delete' }), false);
  assert.equal(isCoreAuthorizedDynamicCall('mcp__ae__ae_skillUse', { execute: 'true' }), false);
  assert.equal(isCoreAuthorizedDynamicCall('mcp__ae__ae_exec', { code: 'return 1;' }), false);
});
