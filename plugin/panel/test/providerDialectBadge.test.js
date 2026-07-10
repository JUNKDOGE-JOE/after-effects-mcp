import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerDialectBadge } from '../src/lib/providerDialectBadge.js';

function providerFixture(overrides = {}) {
  return Object.assign({
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    authProfileRevision: 1,
    dialect: { override: null, detected: null },
  }, overrides);
}

test('providerDialectBadge formats explicit override and detected cache sources', () => {
  const manual = providerFixture({
    dialect: {
      override: { wireApi: 'chat', source: 'manual', updatedAt: 1 },
      detected: null,
    },
  });
  assert.deepEqual(providerDialectBadge(manual, 'zh'), { label: 'chat', title: '手动设置' });

  const imported = providerFixture({
    dialect: {
      override: { wireApi: 'responses', source: 'ccswitch-import', updatedAt: 1 },
      detected: null,
    },
  });
  assert.deepEqual(providerDialectBadge(imported, 'en'), { label: 'responses', title: 'from cc-switch' });

  const detected = providerFixture({
    dialect: {
      override: null,
      detected: {
        wireApi: 'responses',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 999,
        evidence: 'responses-success-schema',
      },
    },
  });
  assert.deepEqual(providerDialectBadge(detected, 'zh', undefined, { now: () => 1000 }), {
    label: 'responses',
    title: '自动检测',
  });
});

test('providerDialectBadge shows unconfirmed for missing, stale, or mismatched detected state', () => {
  const unconfirmed = { label: 'unconfirmed', title: '未确认' };
  assert.deepEqual(providerDialectBadge(providerFixture(), 'zh'), unconfirmed);

  const stale = providerFixture({
    dialect: {
      override: null,
      detected: {
        wireApi: 'chat',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1,
        evidence: 'chat-success-schema',
      },
    },
  });
  assert.deepEqual(providerDialectBadge(stale, 'zh', undefined, { now: () => 86_400_002 }), unconfirmed);

  const mismatched = providerFixture({
    authProfileRevision: 2,
    dialect: stale.dialect,
  });
  assert.deepEqual(providerDialectBadge(mismatched, 'en', undefined, { now: () => 2 }), {
    label: 'unconfirmed',
    title: 'unconfirmed',
  });
});

test('providerDialectBadge omits non-OpenAI-compatible providers', () => {
  assert.equal(providerDialectBadge(providerFixture({ protocol: 'anthropic' })), null);
});
