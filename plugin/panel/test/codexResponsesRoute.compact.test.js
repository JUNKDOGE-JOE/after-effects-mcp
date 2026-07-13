import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestText,
  resolvedModelProfile,
  routeFixture,
  routeHeaders,
} from './helpers/providerRouteFixtures.js';

test('chat-only compact returns 501 without body, secret, or upstream side effects', async () => {
  const counts = { resolve: 0, upstream: 0 };
  const route = routeFixture({
    resolveRequestProfile: async () => { counts.resolve += 1; return resolvedModelProfile(); },
    createUpstreamRequest: () => { counts.upstream += 1; throw new Error('compact reached upstream creation'); },
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/responses/compact', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: 'not-json-and-must-not-be-read',
    });
    assert.equal(result.status, 501);
    assert.deepEqual(JSON.parse(result.body), {
      error: {
        type: 'provider_compaction_unsupported',
        code: 'provider_compaction_unsupported',
        message: 'This chat-only provider cannot compact Responses context.',
      },
    });
    assert.deepEqual(counts, { resolve: 0, upstream: 0 });
  } finally {
    await route.close();
  }
});
