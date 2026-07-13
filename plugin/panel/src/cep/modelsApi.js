// /v1/models via cep_node's Node https. Browser fetch is CORS-blocked in CEP
// (verified note at App.jsx:91); the Node channel has no CORS.
import { anthropicEndpoint, normalizeBaseUrl } from '../lib/providerProfile.js';
import { containsExactSecret } from '../lib/exactSecretRedaction.js';

const CACHE_KEY = 'ae_mcp_byok_models';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MODELS_RESPONSE_BYTES = 512 * 1024;

function containsResolvedCredential(models, requestProfile) {
  const values = [];
  if (typeof requestProfile?.auth?.value === 'string' && requestProfile.auth.value) {
    values.push(requestProfile.auth.value);
    const scheme = requestProfile.auth.value.match(/^(?:Bearer|Basic)\s+(.+)$/i);
    if (scheme?.[1]) values.push(scheme[1]);
  }
  for (const header of requestProfile?.extraHeaders || []) {
    if (typeof header?.value === 'string' && header.value) values.push(header.value);
  }
  return containsExactSecret(models, values);
}

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

export function fetchAnthropicModels({
  requestProfile,
  httpsImpl,
  timeoutMs = 8000,
  responseBodyBytes = MAX_MODELS_RESPONSE_BYTES,
} = {}) {
  const https = httpsImpl || getCepRequire()('https');
  const BufferImpl = globalThis.Buffer || getCepRequire()('buffer')?.Buffer;
  const maxResponseBytes = Number.isSafeInteger(responseBodyBytes) && responseBodyBytes > 0
    ? responseBodyBytes
    : MAX_MODELS_RESPONSE_BYTES;
  return new Promise((resolve) => {
    if (!BufferImpl || typeof BufferImpl.from !== 'function' || typeof BufferImpl.concat !== 'function') {
      resolve(null);
      return;
    }
    let endpoint;
    try {
      endpoint = new URL(anthropicEndpoint(requestProfile?.baseUrl || '', '/v1/models?limit=100'));
    } catch (e) {
      resolve(null);
      return;
    }
    const headers = { 'anthropic-version': '2023-06-01' };
    for (const header of requestProfile?.extraHeaders || []) {
      if (header && typeof header.name === 'string' && typeof header.value === 'string') headers[header.name] = header.value;
    }
    if (requestProfile?.auth?.kind === 'header') headers[requestProfile.auth.name] = requestProfile.auth.value;
    let settled = false;
    let req = null;
    let activeResponse = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const abort = () => {
      try { activeResponse?.destroy?.(); } catch {}
      try { req?.destroy?.(); } catch {}
    };
    req = https.request({
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      protocol: endpoint.protocol,
      path: endpoint.pathname + endpoint.search,
      method: 'GET',
      headers,
    }, (res) => {
      activeResponse = res;
      let chunks = [];
      let responseBytes = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        const bytes = BufferImpl.isBuffer?.(chunk) ? chunk : BufferImpl.from(chunk);
        responseBytes += bytes.length;
        if (responseBytes > maxResponseBytes) {
          chunks = [];
          finish(null);
          abort();
          return;
        }
        chunks.push(bytes);
      });
      res.on('end', () => {
        if (settled) return;
        if (res.statusCode !== 200) return finish(null);
        try {
          const body = BufferImpl.concat(chunks, responseBytes).toString('utf8');
          chunks = [];
          const parsed = JSON.parse(body);
          const list = Array.isArray(parsed.data) ? parsed.data : [];
          finish(list.filter((m) => String(m.id || '').startsWith('claude-')));
        } catch (e) { finish(null); }
      });
    });
    req.on('error', () => finish(null));
    if (req.setTimeout) {
      req.setTimeout(timeoutMs, () => {
        finish(null);
        abort();
      });
    }
    req.end();
  });
}

export async function cachedByokModels({
  providerId = '',
  baseUrl = '',
  authProfileRevision = 0,
  requestProfile,
  fetcher,
  storage,
  now = Date.now,
} = {}) {
  const store = storage || globalThis.localStorage;
  const keyTag = JSON.stringify([
    String(providerId || ''),
    normalizeBaseUrl(baseUrl),
    Number.isSafeInteger(authProfileRevision) ? authProfileRevision : 0,
  ]);
  try {
    const raw = store.getItem(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.keyTag === keyTag && now() - cached.at < TTL_MS && !containsResolvedCredential(cached.models, requestProfile)) return cached.models;
    }
  } catch (e) { /* cache is best-effort */ }
  const run = fetcher || (() => fetchAnthropicModels({ requestProfile }));
  const models = await run();
  if (models && containsResolvedCredential(models, requestProfile)) return null;
  if (models) {
    try { store.setItem(CACHE_KEY, JSON.stringify({ keyTag, at: now(), models })); } catch (e) { /* ignore */ }
  }
  return models;
}
