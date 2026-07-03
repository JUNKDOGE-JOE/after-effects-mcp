import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDescriptor, isClaudeApiBackend } from '../src/lib/descriptorSelect.js';
import { byokStaticDescriptor, codexStaticDescriptor } from '../src/lib/backendCapabilities.js';

const probedProvider = { id: 'relay', probedModels: [{ id: 'glm-5.2', label: 'GLM 5.2' }, { id: 'deepseek-v4', label: 'Deepseek V4' }] };

test('isClaudeApiBackend covers claude-api and node-broken byok, nothing else', () => {
  assert.equal(isClaudeApiBackend('claude-api'), true);
  assert.equal(isClaudeApiBackend('byok'), true);
  assert.equal(isClaudeApiBackend('subscription'), false);
  assert.equal(isClaudeApiBackend('none'), false);
});

test('claude-api + provider probedModels drives the descriptor (regression: was gated on unreachable backendPref===byok)', () => {
  const base = byokStaticDescriptor();
  const d = selectDescriptor({ effectiveBackend: 'claude-api', backendPref: 'subscription', baseDescriptor: base, claudeApiProvider: probedProvider });
  assert.deepEqual(d.models.map((m) => m.id), ['glm-5.2', 'deepseek-v4']);
  assert.equal(d.defaultModelId, 'glm-5.2');
});

test('node-broken byok backend uses the same probed-models path', () => {
  const base = byokStaticDescriptor();
  const d = selectDescriptor({ effectiveBackend: 'byok', backendPref: 'subscription', baseDescriptor: base, claudeApiProvider: probedProvider });
  assert.equal(d.defaultModelId, 'glm-5.2');
});

test('claude-api without probed models falls back to fetched /v1/models list, then to curated base', () => {
  const base = byokStaticDescriptor();
  const fetched = selectDescriptor({ effectiveBackend: 'claude-api', baseDescriptor: base, byokApiModels: [{ id: 'claude-sonnet-5' }, { id: 'gw-custom' }] });
  assert.ok(fetched.models.some((m) => m.id === 'gw-custom'));
  assert.equal(selectDescriptor({ effectiveBackend: 'claude-api', baseDescriptor: base }), base, 'no provider facts -> curated fallback');
});

test('probed models take precedence over cached codex list; no provider -> cached; neither -> base', () => {
  const base = codexStaticDescriptor();
  const cached = [{ id: 'gpt-5.5', displayName: 'GPT-5.5' }];
  const probed = selectDescriptor({ effectiveBackend: 'codex', backendPref: 'codex', baseDescriptor: base, codexCustomProvider: probedProvider, codexCachedModels: cached });
  assert.equal(probed.defaultModelId, 'glm-5.2');
  const fromCache = selectDescriptor({ effectiveBackend: 'codex', backendPref: 'codex', baseDescriptor: base, codexCachedModels: cached });
  assert.deepEqual(fromCache.models.map((m) => m.id), ['gpt-5.5']);
  assert.equal(selectDescriptor({ effectiveBackend: 'codex', backendPref: 'codex', baseDescriptor: base }), base);
});

test('custom model id is honored on claude-api and codex paths', () => {
  const base = byokStaticDescriptor();
  const d = selectDescriptor({ effectiveBackend: 'claude-api', baseDescriptor: base, claudeApiProvider: probedProvider, customModel: 'my-model' });
  assert.equal(d.defaultModelId, 'my-model');
});

test('subscription / none backends keep the base descriptor untouched', () => {
  const base = byokStaticDescriptor();
  assert.equal(selectDescriptor({ effectiveBackend: 'subscription', backendPref: 'subscription', baseDescriptor: base, claudeApiProvider: probedProvider }), base);
  assert.equal(selectDescriptor({ effectiveBackend: 'none', backendPref: 'subscription', baseDescriptor: base }), base);
});
