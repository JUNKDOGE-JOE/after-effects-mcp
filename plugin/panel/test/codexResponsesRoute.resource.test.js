import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DEFAULT_ROUTE_LIMITS } from '../src/cep/codexResponsesRoute.js';
import {
  closeServer,
  listen,
  providerFixture,
  requestText,
  resolvedModelProfile,
  routeFixture,
  routeHeaders,
  waitFor,
} from './helpers/providerRouteFixtures.js';

const TEST_LIMITS = {
  requestBodyBytes: 32,
  responseBodyBytes: 8192,
  sseFrameBytes: 24,
  concurrent: 2,
  connectTimeoutMs: 25,
  idleTimeoutMs: 30,
  totalTimeoutMs: 60,
  errorBodyBytes: 40,
  headerValueBytes: 64,
  headerTotalBytes: 256,
  headerCount: 8,
};

class FakeUpstreamRequest extends EventEmitter {
  destroyCalls = 0;
  write() {}
  end() {}
  destroy() {
    if (this.destroyCalls > 0) return;
    this.destroyCalls += 1;
    this.emit('destroyed');
  }
}

test('production route limits match the locked safety contract', () => {
  assert.deepEqual(DEFAULT_ROUTE_LIMITS, {
    requestBodyBytes: 16 * 1024 * 1024,
    responseBodyBytes: 16 * 1024 * 1024,
    sseFrameBytes: 1024 * 1024,
    concurrent: 4,
    connectTimeoutMs: 15_000,
    idleTimeoutMs: 120_000,
    totalTimeoutMs: 30 * 60_000,
    errorBodyBytes: 64 * 1024,
    headerValueBytes: 8 * 1024,
    headerTotalBytes: 32 * 1024,
    headerCount: 64,
  });
});

test('route accepts the body limit and rejects one byte over before upstream creation', async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"chat-1","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}');
  });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
    limits: TEST_LIMITS,
  });
  try {
    const local = await route.start();
    const base = '{"model":"m","input":"","stream":false}'.padEnd(256, ' ');
    const smallLimits = { ...TEST_LIMITS, requestBodyBytes: Buffer.byteLength(base) };
    await route.close();
    const boundedRoute = routeFixture({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
      limits: smallLimits,
    });
    try {
      const bounded = await boundedRoute.start();
      const headers = routeHeaders(bounded.routeToken, { 'content-type': 'application/json' });
      const accepted = await requestText(bounded.baseUrl + '/responses', { method: 'POST', headers, body: base });
      assert.equal(accepted.status, 200, accepted.body);
      const rejected = await requestText(bounded.baseUrl + '/responses', { method: 'POST', headers, body: base + ' ' });
      assert.equal(rejected.status, 413);
      assert.equal(JSON.parse(rejected.body).error.code, 'request_body_too_large');
      assert.equal(upstreamCalls, 1);
    } finally {
      await boundedRoute.close();
    }
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('route applies an injected response body limit to non-streaming upstream responses', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('x'.repeat(65));
  });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
    limits: { ...TEST_LIMITS, requestBodyBytes: 64, responseBodyBytes: 64 },
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'm', input: 'x', stream: false },
    });
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error.code, 'provider_response_too_large');
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('route enforces concurrency and releases a slot when an upstream completes', async () => {
  const pending = [];
  const upstream = http.createServer((_req, res) => { pending.push(res); });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
    limits: { ...TEST_LIMITS, connectTimeoutMs: 200, idleTimeoutMs: 200, totalTimeoutMs: 500 },
  });
  try {
    const local = await route.start();
    const headers = routeHeaders(local.routeToken);
    const first = requestText(local.baseUrl + '/models', { headers });
    const second = requestText(local.baseUrl + '/models', { headers });
    await waitFor(() => pending.length === 2);
    const denied = await requestText(local.baseUrl + '/models', { headers });
    assert.equal(denied.status, 429);
    assert.equal(JSON.parse(denied.body).error.code, 'route_concurrency_limit');
    pending.shift().end('{}');
    await first;
    const next = requestText(local.baseUrl + '/models', { headers });
    await waitFor(() => pending.length === 2);
    for (const response of pending.splice(0)) response.end('{}');
    await Promise.all([second, next]);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('route maps a missing upstream response to the connect timeout and destroys once', async () => {
  let fake;
  const route = routeFixture({
    createUpstreamRequest: () => { fake = new FakeUpstreamRequest(); return fake; },
    limits: TEST_LIMITS,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/models', { headers: routeHeaders(local.routeToken) });
    assert.equal(result.status, 504);
    assert.equal(JSON.parse(result.body).error.code, 'provider_connect_timeout');
    assert.equal(fake.destroyCalls, 1);
  } finally {
    await route.close();
  }
});

test('route returns one bounded error when an upstream stream exceeds the idle timeout', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
  });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
    limits: { ...TEST_LIMITS, requestBodyBytes: 256, sseFrameBytes: 1024 },
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'm', input: 'x', stream: true },
    });
    assert.equal(result.status, 504, result.body);
    assert.equal((result.body.match(/provider_idle_timeout/g) || []).length, 1);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('continuous upstream bytes cannot extend the total timeout', async () => {
  const frame = 'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n';
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const timer = setInterval(() => res.write(frame), 10);
    res.on('close', () => clearInterval(timer));
  });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
    limits: {
      ...TEST_LIMITS,
      requestBodyBytes: 256,
      sseFrameBytes: 1024,
      connectTimeoutMs: 500,
      idleTimeoutMs: 500,
      totalTimeoutMs: 250,
    },
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'm', input: 'x', stream: true },
    });
    assert.equal(result.status, 504, result.body);
    assert.equal((result.body.match(/provider_total_timeout/g) || []).length, 1);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('an oversized SSE frame returns one bounded error and closes upstream', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${'x'.repeat(19)}\n\n`);
  });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
    limits: { ...TEST_LIMITS, requestBodyBytes: 256 },
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'm', input: 'x', stream: true },
    });
    assert.equal(result.status, 502);
    assert.equal((result.body.match(/provider_stream_frame_too_large/g) || []).length, 1);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('route blocks redirects and never exposes Location', async () => {
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls += 1;
    res.writeHead(302, { Location: 'https://other.example/secret' });
    res.end();
  });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
    limits: TEST_LIMITS,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/models', { headers: routeHeaders(local.routeToken) });
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error.code, 'provider_redirect_blocked');
    assert.equal(result.headers.location, undefined);
    assert.equal(calls, 1);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('route bounds and redacts provider error bodies', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json', 'X-Request-Id': 'sk-model-secret' });
    res.end(JSON.stringify({ error: { message: 'bad sk-model-secret x-provider-secret-value' } }));
  });
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = routeFixture({
    provider: providerFixture({ baseUrl }),
    resolveRequestProfile: async () => resolvedModelProfile({
      baseUrl,
      auth: { kind: 'header', name: 'authorization', value: 'Bearer sk-model-secret' },
      extraHeaders: [{ name: 'x-provider-feature', value: 'x-provider-secret-value', source: 'secret' }],
    }),
    limits: { ...TEST_LIMITS, errorBodyBytes: 128 },
  });
  try {
    const local = await route.start();
    const result = await requestText(local.baseUrl + '/models', { headers: routeHeaders(local.routeToken) });
    assert.equal(result.status, 502);
    const body = JSON.parse(result.body);
    assert.equal(body.error.code, 'provider_error');
    assert.doesNotMatch(result.body, /sk-model-secret|x-provider-secret-value/);
    assert.equal(result.headers['x-request-id'], undefined);
    assert.equal(Object.hasOwn(body.error, 'request_id'), false);
    assert.equal(result.body.length < 1024, true);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('client cancellation destroys upstream exactly once and releases concurrency', async () => {
  let fake;
  const route = routeFixture({
    createUpstreamRequest: (_options, onResponse) => {
      fake = new FakeUpstreamRequest();
      const response = new EventEmitter();
      response.statusCode = 200;
      response.rawHeaders = ['Content-Type', 'application/json'];
      response.headers = { 'content-type': 'application/json' };
      response.destroy = () => {};
      queueMicrotask(() => onResponse(response));
      return fake;
    },
    limits: { ...TEST_LIMITS, concurrent: 1, idleTimeoutMs: 200, totalTimeoutMs: 500 },
  });
  try {
    const local = await route.start();
    const endpoint = new URL(local.baseUrl + '/models');
    const client = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      headers: routeHeaders(local.routeToken),
    });
    client.on('error', () => {});
    client.end();
    await waitFor(() => Boolean(fake));
    client.destroy();
    await once(fake, 'destroyed');
    assert.equal(fake.destroyCalls, 1);
    const admitted = await requestText(local.baseUrl + '/models', { headers: routeHeaders(local.routeToken) });
    assert.notEqual(admitted.status, 429);
  } finally {
    await route.close();
  }
});

test('client cancellation while the profile resolves never opens upstream', async () => {
  let resolving = false;
  let releaseProfile;
  let upstreamCalls = 0;
  const profilePromise = new Promise((resolve) => { releaseProfile = resolve; });
  const route = routeFixture({
    resolveRequestProfile: async () => {
      resolving = true;
      return profilePromise;
    },
    createUpstreamRequest: () => {
      upstreamCalls += 1;
      return new FakeUpstreamRequest();
    },
    limits: { ...TEST_LIMITS, totalTimeoutMs: 500 },
  });
  try {
    const local = await route.start();
    const endpoint = new URL(local.baseUrl + '/models');
    const client = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      headers: routeHeaders(local.routeToken),
    });
    client.on('error', () => {});
    client.end();
    await waitFor(() => resolving);
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseProfile(resolvedModelProfile());
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(upstreamCalls, 0);
  } finally {
    releaseProfile(resolvedModelProfile());
    await route.close();
  }
});
