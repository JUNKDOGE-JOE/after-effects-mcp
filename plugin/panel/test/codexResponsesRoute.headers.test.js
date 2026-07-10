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

test('route selects one scoped profile and never forwards local route auth', async () => {
  const seen = [];
  const scopes = [];
  const audits = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"object":"list","data":[]}');
  });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async (_provider, { scope }) => {
      scopes.push(scope);
      return resolvedModelProfile({
        baseUrl,
        auth: { kind: 'header', name: 'x-probe-auth', value: 'probe-secret' },
        extraHeaders: [{ name: 'x-probe-feature', value: 'enabled', source: 'literal' }],
      });
    },
    onAudit: (record) => audits.push(record),
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/models', {
      headers: routeHeaders(local.routeToken, { 'x-codex-version': '1.2.3', 'x-unknown': 'drop' }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(scopes, ['probe']);
    assert.equal(seen[0]['x-codex-version'], '1.2.3');
    assert.equal(seen[0]['x-probe-feature'], 'enabled');
    assert.equal(seen[0]['x-probe-auth'], 'probe-secret');
    assert.equal(seen[0].authorization, undefined);
    assert.equal(seen[0]['x-unknown'], undefined);
    assert.equal(JSON.stringify(audits).includes('probe-secret'), false);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('invalid custom auth names fail before secret resolution or upstream creation', async () => {
  const counts = { resolve: 0, upstream: 0 };
  const secretRef = { kind: 'secret', reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model-a/v1', revision: 1 };
  const route = routeFixture({
    provider: providerFixture({
      auth: { model: { kind: 'custom', headerName: 'Proxy-Authorization', valueRef: secretRef }, probe: { kind: 'inherit-model' } },
    }),
    resolveRequestProfile: async () => { counts.resolve += 1; return resolvedModelProfile(); },
    createUpstreamRequest: () => { counts.upstream += 1; throw new Error('unexpected upstream'); },
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/models', { headers: routeHeaders(local.routeToken) });
    assert.equal(result.status, 400);
    assert.deepEqual(counts, { resolve: 0, upstream: 0 });
  } finally {
    await route.close();
  }
});
