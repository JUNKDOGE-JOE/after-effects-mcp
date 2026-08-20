import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDescriptor, reconcileModelPref } from '../src/lib/descriptorSelect.js';
import {
  claudeSubDescriptor,
  codexStaticDescriptor,
  openCodeStaticDescriptor,
} from '../src/lib/backendCapabilities.js';

test('Codex uses its CLI model inventory when it is available', () => {
  const descriptor = selectDescriptor({
    effectiveBackend: 'codex',
    backendPref: 'codex',
    baseDescriptor: codexStaticDescriptor(),
    codexCachedModels: [{ id: 'gpt-live', isDefault: true }],
  });
  assert.equal(descriptor.defaultModelId, 'gpt-live');
  assert.ok(descriptor.models.some((model) => model.id === 'gpt-5.6-terra'));
});

test('OpenCode derives models from the Provider Manager registry', () => {
  const descriptor = selectDescriptor({
    effectiveBackend: 'opencode',
    backendPref: 'opencode',
    baseDescriptor: openCodeStaticDescriptor(),
    openCodeProviders: [{
      id: 'aemcp-example',
      name: 'Example',
      modelIds: ['model-a'],
      needsApiKey: false,
    }],
  });
  assert.deepEqual(descriptor.models.map((model) => model.id), ['aemcp-example/model-a']);
});

test('subscription keeps its base descriptor', () => {
  const base = claudeSubDescriptor();
  assert.equal(selectDescriptor({ baseDescriptor: base }), base);
});

test('reconcileModelPref resets stale models but waits for pending facts', () => {
  const descriptor = { models: [{ id: 'a' }, { id: 'b' }], defaultModelId: 'a' };
  assert.equal(reconcileModelPref('b', descriptor), 'b');
  assert.equal(reconcileModelPref('missing', descriptor), 'a');
  assert.equal(
    reconcileModelPref('missing', descriptor, { providerFactsPending: true }),
    'missing',
  );
});
