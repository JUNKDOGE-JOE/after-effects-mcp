import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerDialectBadge } from '../src/lib/providerDialectBadge.js';

test('providerDialectBadge formats wire and auth labels', () => {
  assert.deepEqual(
    providerDialectBadge({ wireApi: 'chat', authScheme: 'x-api-key', source: 'detected' }, 'zh'),
    { label: 'chat · x-api-key', title: '自动检测' },
  );
});

test('providerDialectBadge maps source titles by language', () => {
  assert.equal(providerDialectBadge({ wireApi: 'responses', authScheme: 'bearer', source: 'ccswitch-import' }, 'zh').title, '来自 cc-switch');
  assert.equal(providerDialectBadge({ wireApi: 'responses', authScheme: 'bearer', source: 'ccswitch-import' }, 'en').title, 'from cc-switch');
  assert.equal(providerDialectBadge({ wireApi: 'responses', authScheme: 'bearer', source: 'manual' }, 'zh').title, '手动设置');
  assert.equal(providerDialectBadge({ wireApi: 'responses', authScheme: 'bearer', source: 'manual' }, 'en').title, 'manual');
});

test('providerDialectBadge omits incomplete dialects', () => {
  assert.equal(providerDialectBadge(null), null);
  assert.equal(providerDialectBadge({ wireApi: 'chat' }), null);
  assert.equal(providerDialectBadge({ authScheme: 'bearer' }), null);
});
