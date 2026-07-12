import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import * as crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createCodexResponsesRoute } from '../src/cep/codexResponsesRoute.js';
import {
  providerFixture,
  requestText,
  resolvedModelProfile,
  routeFixture,
  routeHeaders,
} from './helpers/providerRouteFixtures.js';

test('missing and wrong tokens return 401 before URL, secret, DNS, or upstream work', async () => {
  const counts = { resolve: 0, request: 0, dns: 0 };
  const route = routeFixture({
    provider: providerFixture({ baseUrl: 'not a URL' }),
    resolveRequestProfile: async () => { counts.resolve += 1; return resolvedModelProfile(); },
    createUpstreamRequest: () => { counts.request += 1; throw new Error('unexpected upstream'); },
    lookupImpl: () => { counts.dns += 1; throw new Error('unexpected DNS'); },
  });
  try {
    const local = await route.start();
    for (const headers of [
      {},
      { 'x-ae-mcp-route-token': 'wrong-token' },
      { 'x-ae-mcp-route-token': ['wrong-one', 'wrong-two'] },
    ]) {
      const result = await requestText(local.baseUrl + '/%2e%2e/unknown', { method: 'POST', headers, body: '{}' });
      assert.equal(result.status, 401);
      assert.equal(result.headers['www-authenticate'], undefined);
      assert.equal(JSON.parse(result.body).error.code, 'invalid_route_token');
    }
    assert.deepEqual(counts, { resolve: 0, request: 0, dns: 0 });
  } finally {
    await route.close();
  }
});

test('correct dedicated token ignores unrelated Authorization fields', async () => {
  const route = routeFixture();
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/unknown', {
      headers: routeHeaders(local.routeToken, {
        authorization: ['Bearer unrelated-one', 'Bearer unrelated-two'],
      }),
    });
    assert.equal(result.status, 404);
  } finally {
    await route.close();
  }
});

test('route rotates the ephemeral token after close and restart', async () => {
  let byte = 0x10;
  const route = routeFixture({
    cryptoImpl: {
      randomBytes: (size) => Buffer.alloc(size, byte++),
      createHash,
      timingSafeEqual,
    },
  });
  const first = await route.start();
  const firstToken = first.routeToken;
  await route.close();
  try {
    const second = await route.start();
    assert.notEqual(second.routeToken, firstToken);
    const denied = await requestText(second.baseUrl + '/unknown', { headers: routeHeaders(firstToken) });
    assert.equal(denied.status, 401);
    const accepted = await requestText(second.baseUrl + '/unknown', { headers: routeHeaders(second.routeToken) });
    assert.equal(accepted.status, 404);
  } finally {
    await route.close();
  }
});

test('route safely loads Node crypto when no test crypto implementation is injected', async () => {
  const route = createCodexResponsesRoute({
    provider: providerFixture(),
    resolveRequestProfile: async () => resolvedModelProfile(),
    requireImpl: (name) => ({ http, https, crypto })[name],
  });
  try {
    const local = await route.start();
    assert.match(local.routeToken, /^[A-Za-z0-9_-]{43}$/);
  } finally {
    await route.close();
  }
});
