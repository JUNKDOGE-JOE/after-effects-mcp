import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderEndpoint } from '../src/lib/providerUrl.js';

function hasCode(code) {
  return (error) => Boolean(error && error.code === code);
}

test('buildProviderEndpoint preserves base paths, one v1 segment, and ordered query pairs', () => {
  assert.equal(buildProviderEndpoint({
    baseUrl: 'https://relay.example/openai/',
    resource: 'models',
    inboundSearch: '?after=m1&limit=10&after=m2',
  }).toString(), 'https://relay.example/openai/v1/models?after=m1&limit=10&after=m2');
  assert.equal(buildProviderEndpoint({
    baseUrl: 'https://relay.example/openai/v1',
    resource: 'chat-completions',
    inboundSearch: '?api-version=2026-01-01',
  }).toString(), 'https://relay.example/openai/v1/chat/completions?api-version=2026-01-01');
});

test('buildProviderEndpoint rejects userinfo, fragments, traversal, and protocol-relative URLs', () => {
  assert.throws(() => buildProviderEndpoint({ baseUrl: 'https://user:pass@relay.example/v1', resource: 'models' }), hasCode('provider_url_userinfo_forbidden'));
  assert.throws(() => buildProviderEndpoint({ baseUrl: 'https://relay.example/v1#frag', resource: 'models' }), hasCode('provider_url_fragment_forbidden'));
  assert.throws(() => buildProviderEndpoint({ baseUrl: 'https://relay.example/openai/%2e%2e/private', resource: 'models' }), hasCode('provider_url_traversal_forbidden'));
  assert.throws(() => buildProviderEndpoint({ baseUrl: '//relay.example/v1', resource: 'models' }), hasCode('provider_url_invalid'));
});

test('buildProviderEndpoint permits HTTP loopback but gates other HTTP origins', () => {
  for (const baseUrl of [
    'http://127.20.30.40/openai',
    'http://localhost/openai',
    'http://route.localhost/openai',
    'http://[::1]/openai',
    'http://[::ffff:127.0.0.1]/openai',
  ]) {
    assert.equal(buildProviderEndpoint({ baseUrl, resource: 'models' }).protocol, 'http:');
  }
  assert.throws(() => buildProviderEndpoint({ baseUrl: 'http://relay.example/v1', resource: 'models' }), hasCode('provider_insecure_http_forbidden'));
  assert.equal(buildProviderEndpoint({
    baseUrl: 'http://relay.example/openai',
    resource: 'models',
    allowInsecureHttp: true,
  }).toString(), 'http://relay.example/openai/v1/models');
});

test('buildProviderEndpoint rejects request-controlled search fragments', () => {
  assert.throws(() => buildProviderEndpoint({
    baseUrl: 'https://relay.example/v1',
    resource: 'models',
    inboundSearch: '?ok=1#other-origin',
  }), hasCode('provider_url_invalid_search'));
});
