import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectCodexHeaders,
  filterUpstreamResponseHeaders,
  mergeUpstreamHeaders,
} from '../src/lib/providerHeaders.js';

function hasCode(code) {
  return (error) => Boolean(error && error.code === code);
}

test('collectCodexHeaders forwards only exact metadata and bounded prefixes', () => {
  assert.deepEqual(collectCodexHeaders([
    'Host', '127.0.0.1:1234',
    'Authorization', 'Bearer unrelated-login-token',
    'Authorization', 'Bearer unrelated-provider-token',
    'X-AE-MCP-Route-Token', 'local-route-token',
    'User-Agent', 'codex/1.2.3',
    'X-Codex-Version', '1.2.3',
    'X-Stainless-Lang', 'js',
    'X-Stainless', 'not-a-prefix-match',
    'X-Unknown', 'drop-me',
  ]), [
    { name: 'user-agent', value: 'codex/1.2.3' },
    { name: 'x-codex-version', value: '1.2.3' },
    { name: 'x-stainless-lang', value: 'js' },
  ]);
});

test('local route tokens cannot be configured or forwarded as provider headers', () => {
  assert.deepEqual(collectCodexHeaders([
    'X-AE-MCP-Route-Token', 'local-route-token',
    'X-Request-Id', 'request-1',
  ]), [{ name: 'x-request-id', value: 'request-1' }]);
  assert.throws(() => mergeUpstreamHeaders({
    rawHeaders: [],
    providerHeaders: [{ name: 'x-ae-mcp-route-token', value: 'secret', source: 'secret' }],
    auth: { kind: 'none' },
  }), hasCode('provider_header_forbidden'));
  assert.throws(() => mergeUpstreamHeaders({
    rawHeaders: [],
    providerHeaders: [],
    auth: { kind: 'header', name: 'x-ae-mcp-route-token', value: 'secret' },
  }), hasCode('provider_header_forbidden'));
});

test('mergeUpstreamHeaders applies Codex, provider, then auth precedence', () => {
  const merged = mergeUpstreamHeaders({
    rawHeaders: ['User-Agent', 'codex/1.2.3', 'X-Codex-Version', '1.2.3', 'Content-Type', 'application/json'],
    providerHeaders: [
      { name: 'user-agent', value: 'provider-agent', source: 'literal' },
      { name: 'x-provider-feature', value: 'enabled', source: 'literal' },
    ],
    auth: { kind: 'header', name: 'x-api-key', value: 'provider-secret' },
    contentType: 'application/json',
  });
  assert.equal(merged['user-agent'], 'provider-agent');
  assert.equal(merged['x-codex-version'], '1.2.3');
  assert.equal(merged['x-provider-feature'], 'enabled');
  assert.equal(merged['x-api-key'], 'provider-secret');
  assert.equal(Object.hasOwn(merged, 'authorization'), false);
});

test('header policy rejects duplicates, unsafe provider names, and literal credentials', () => {
  assert.throws(() => collectCodexHeaders(['X-Request-Id', 'one', 'x-request-id', 'two']), hasCode('provider_header_duplicate'));
  assert.throws(() => collectCodexHeaders(['X-Codex-Api-Key', 'second-auth']), hasCode('provider_header_forbidden'));
  assert.throws(() => collectCodexHeaders(['X-Stainless-Token', 'second-auth']), hasCode('provider_header_forbidden'));
  assert.throws(() => mergeUpstreamHeaders({
    rawHeaders: [],
    providerHeaders: [{ name: 'Host', value: 'relay.example', source: 'literal' }],
    auth: { kind: 'none' },
    contentType: 'application/json',
  }), hasCode('provider_header_forbidden'));
  assert.throws(() => mergeUpstreamHeaders({
    rawHeaders: [],
    providerHeaders: [{ name: 'x-provider-token', value: 'sk-1234567890', source: 'literal' }],
    auth: { kind: 'none' },
    contentType: 'application/json',
  }), hasCode('provider_header_secret_reference_required'));
});

test('header policy accepts JSON media types and enforces exact byte/count boundaries', () => {
  assert.equal(mergeUpstreamHeaders({
    rawHeaders: ['Content-Type', 'application/vnd.example+json; charset=UTF-8'],
    providerHeaders: [],
    auth: { kind: 'none' },
    contentType: 'application/vnd.example+json; charset=UTF-8',
  })['content-type'], 'application/vnd.example+json; charset=UTF-8');
  assert.throws(() => collectCodexHeaders(['X-Request-Id', '12345'], {
    maxValueBytes: 4,
    maxTotalBytes: 64,
    maxCount: 4,
  }), hasCode('provider_header_value_too_large'));
  assert.throws(() => collectCodexHeaders(['A', '1', 'B', '2', 'C', '3'], {
    maxValueBytes: 8,
    maxTotalBytes: 64,
    maxCount: 2,
  }), hasCode('provider_header_count_exceeded'));
  assert.throws(() => mergeUpstreamHeaders({
    rawHeaders: ['X-Request-Id', '1'],
    providerHeaders: [],
    auth: { kind: 'none' },
    contentType: 'application/json',
    limits: { maxValueBytes: 32, maxTotalBytes: 64, maxCount: 1 },
  }), hasCode('provider_header_count_exceeded'));
});

test('filterUpstreamResponseHeaders retains only the response allowlist', () => {
  assert.deepEqual(filterUpstreamResponseHeaders([
    'Content-Type', 'application/json',
    'Retry-After', '2',
    'X-Request-Id', 'req-1',
    'RateLimit-Remaining', '3',
    'X-RateLimit-Limit', '4',
    'Set-Cookie', 'secret=1',
    'WWW-Authenticate', 'Bearer realm=provider',
    'X-Provider-Auth', 'secret',
  ]), {
    'content-type': 'application/json',
    'retry-after': '2',
    'x-request-id': 'req-1',
    'ratelimit-remaining': '3',
    'x-ratelimit-limit': '4',
  });
});
