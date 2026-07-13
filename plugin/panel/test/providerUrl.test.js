import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProviderApiBaseCandidates,
  buildProviderApiBaseUrl,
  buildProviderEndpoint,
  buildProviderEndpointCandidates,
} from '../src/lib/providerUrl.js';

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

test('buildProviderApiBaseUrl gives Codex the same canonical v1 prefix used by probes', () => {
  assert.equal(buildProviderApiBaseUrl({
    baseUrl: 'https://relay.example',
  }).toString(), 'https://relay.example/v1');
  assert.equal(buildProviderApiBaseUrl({
    baseUrl: 'https://relay.example/openai/',
  }).toString(), 'https://relay.example/openai/v1');
  assert.equal(buildProviderApiBaseUrl({
    baseUrl: 'https://relay.example/openai/v1',
  }).toString(), 'https://relay.example/openai/v1');
  assert.equal(buildProviderApiBaseUrl({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  }).toString(), 'https://generativelanguage.googleapis.com/v1beta/openai');
});

test('candidate builders preserve configured roots and add at most one same-origin v1 fallback', () => {
  assert.deepEqual(buildProviderApiBaseCandidates({
    baseUrl: 'https://relay.example/proxy/openai',
  }).map((entry) => [entry.id, entry.url.toString()]), [
    ['configured-root', 'https://relay.example/proxy/openai'],
    ['plus-v1', 'https://relay.example/proxy/openai/v1'],
  ]);
  assert.deepEqual(buildProviderApiBaseCandidates({
    baseUrl: 'https://relay.example/proxy/openai/v1',
  }).map((entry) => [entry.id, entry.url.toString()]), [
    ['configured-root', 'https://relay.example/proxy/openai/v1'],
  ]);
  assert.deepEqual(buildProviderEndpointCandidates({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    resource: 'messages',
  }).map((entry) => entry.url.pathname), [
    '/v1beta/openai/messages',
    '/v1beta/openai/v1/messages',
  ]);
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
