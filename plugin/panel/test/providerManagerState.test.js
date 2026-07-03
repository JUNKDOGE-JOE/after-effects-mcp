import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDraft, draftFromEntry, validateDraft, draftToEntry } from '../src/lib/providerManagerState.js';

test('emptyDraft returns a blank openai-compatible draft', () => {
  const d = emptyDraft();
  assert.equal(d.id, '');
  assert.equal(d.name, '');
  assert.equal(d.protocol, 'openai-compatible');
  assert.equal(d.baseUrl, '');
  assert.equal(d.apiKey, '');
});

test('draftFromEntry copies the editable fields from a stored provider entry', () => {
  const entry = { id: 'p1', name: 'Provider 1', protocol: 'anthropic', baseUrl: 'https://x.example.com', apiKey: 'k', probedModels: [{ id: 'm' }], probedAt: 123 };
  const d = draftFromEntry(entry);
  assert.deepEqual(d, { id: 'p1', name: 'Provider 1', protocol: 'anthropic', baseUrl: 'https://x.example.com', apiKey: 'k' });
});

test('validateDraft requires a name or id', () => {
  const msg = validateDraft({ id: '', name: '', protocol: 'openai-compatible', baseUrl: 'https://x.example.com', apiKey: '' });
  assert.ok(msg);
});

test('validateDraft requires an http(s) base URL', () => {
  const msg = validateDraft({ id: '', name: 'Foo', protocol: 'openai-compatible', baseUrl: 'ftp://x.example.com', apiKey: '' });
  assert.ok(msg);
  assert.equal(validateDraft({ id: '', name: 'Foo', protocol: 'openai-compatible', baseUrl: 'https://x.example.com', apiKey: '' }), '');
  assert.equal(validateDraft({ id: '', name: 'Foo', protocol: 'openai-compatible', baseUrl: 'http://x.example.com', apiKey: '' }), '');
});

test('draftToEntry derives a slug id from the name when no id is set', () => {
  const entry = draftToEntry({ id: '', name: 'My Cool Provider!', protocol: 'openai-compatible', baseUrl: 'https://x.example.com', apiKey: 'k' });
  assert.equal(entry.id, 'my-cool-provider-');
  assert.equal(entry.name, 'My Cool Provider!');
});

test('draftToEntry preserves an existing id on edit', () => {
  const entry = draftToEntry({ id: 'existing-id', name: 'Renamed', protocol: 'anthropic', baseUrl: 'https://x.example.com', apiKey: '' });
  assert.equal(entry.id, 'existing-id');
  assert.equal(entry.name, 'Renamed');
  assert.equal(entry.protocol, 'anthropic');
});
