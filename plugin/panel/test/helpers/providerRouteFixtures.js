import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createCodexResponsesRoute } from '../../src/cep/codexResponsesRoute.js';

export function deterministicCrypto(byte = 0x5a) {
  return {
    randomBytes: (size) => Buffer.alloc(size, byte),
    createHash,
    timingSafeEqual,
  };
}

export function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2',
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
    headers: [],
    dialect: { override: null, detected: null },
    probedModels: [],
    probedAt: 0,
  }, overrides);
}

export function resolvedModelProfile(overrides = {}) {
  return Object.assign({
    providerId: 'provider-1',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    auth: { kind: 'none' },
    extraHeaders: [],
    authProfileRevision: 1,
  }, overrides);
}

export function routeFixture(overrides = {}) {
  return createCodexResponsesRoute(Object.assign({
    provider: providerFixture(),
    resolveRequestProfile: async () => resolvedModelProfile(),
    requireImpl: (name) => name === 'http' ? http : https,
    cryptoImpl: deterministicCrypto(),
  }, overrides));
}

export function routeHeaders(routeToken, extra = {}) {
  return { authorization: `Bearer ${routeToken}`, ...extra };
}

export function requestText(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const req = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname + endpoint.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

export async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
