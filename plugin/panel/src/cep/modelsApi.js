// /v1/models via cep_node's Node https. Browser fetch is CORS-blocked in CEP
// (verified note at App.jsx:91); the Node channel has no CORS.
const CACHE_KEY = 'ae_mcp_byok_models';
const TTL_MS = 24 * 60 * 60 * 1000;

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

export function fetchAnthropicModels({ apiKey, httpsImpl, timeoutMs = 8000 } = {}) {
  const https = httpsImpl || getCepRequire()('https');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/models?limit=100',
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const parsed = JSON.parse(body);
          const list = Array.isArray(parsed.data) ? parsed.data : [];
          resolve(list.filter((m) => String(m.id || '').startsWith('claude-')));
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    if (req.setTimeout) req.setTimeout(timeoutMs, () => resolve(null));
    req.end();
  });
}

export async function cachedByokModels({ apiKey, fetcher, storage, now = Date.now } = {}) {
  const store = storage || globalThis.localStorage;
  const keyTag = String(apiKey || '').slice(-6);
  try {
    const raw = store.getItem(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.keyTag === keyTag && now() - cached.at < TTL_MS) return cached.models;
    }
  } catch (e) { /* cache is best-effort */ }
  const run = fetcher || (() => fetchAnthropicModels({ apiKey }));
  const models = await run();
  if (models) {
    try { store.setItem(CACHE_KEY, JSON.stringify({ keyTag, at: now(), models })); } catch (e) { /* ignore */ }
  }
  return models;
}
