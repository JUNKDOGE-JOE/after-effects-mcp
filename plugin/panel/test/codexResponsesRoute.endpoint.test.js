import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  closeServer,
  listen,
  providerFixture,
  requestText,
  resolvedModelProfile,
  routeFixture,
  routeHeaders,
} from './helpers/providerRouteFixtures.js';

test('route preserves provider base path and inbound models query', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'up-1', 'Set-Cookie': 'drop=1' });
    res.end('{"object":"list","data":[]}');
  });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}/openai`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
  });
  try {
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/models?after=m1&limit=10`, {
      headers: routeHeaders(local.routeToken),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(seen, [{ method: 'GET', url: '/openai/v1/models?after=m1&limit=10' }]);
    assert.equal(result.headers['x-request-id'], 'up-1');
    assert.equal(result.headers['set-cookie'], undefined);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('route dispatches exact endpoint and method pairs without upstream fallback', async () => {
  let resolves = 0;
  let upstream = 0;
  const route = routeFixture({
    resolveRequestProfile: async () => { resolves += 1; return resolvedModelProfile(); },
    createUpstreamRequest: () => { upstream += 1; throw new Error('unexpected upstream'); },
  });
  try {
    const local = await route.start();
    const headers = routeHeaders(local.routeToken);
    const cases = [
      ['/responses', 'GET', 405, 'POST'],
      ['/models', 'POST', 405, 'GET'],
      ['/chat/completions', 'POST', 404, undefined],
      ['/unknown', 'GET', 404, undefined],
    ];
    for (const [path, method, status, allow] of cases) {
      const result = await requestText(local.baseUrl + path, { method, headers });
      assert.equal(result.status, status);
      assert.equal(result.headers.allow, allow);
    }
    assert.deepEqual({ resolves, upstream }, { resolves: 0, upstream: 0 });
  } finally {
    await route.close();
  }
});
