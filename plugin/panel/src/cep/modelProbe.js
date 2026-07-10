// Custom-provider model discovery: GET {baseUrl}/v1/models (spec A2).
// openai-compatible -> Authorization: Bearer; anthropic -> x-api-key +
// anthropic-version (Anthropic officially serves GET /v1/models too).
// Uses cep_node https (browser fetch is CORS-blocked in CEP, see modelsApi.js).
import { validateProviderBaseUrl } from '../lib/providerProfile.js';

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function authSchemeFromDialect(dialect) {
  if (!dialect) return '';
  if (typeof dialect === 'string') return dialect;
  return String(dialect.authScheme || '').trim();
}

export function probeHeaders(protocol, apiKey, dialect) {
  if (protocol === 'anthropic') {
    return { 'x-api-key': String(apiKey || ''), 'anthropic-version': '2023-06-01' };
  }
  const authScheme = authSchemeFromDialect(dialect);
  if (authScheme === 'x-api-key') return { 'x-api-key': String(apiKey || '') };
  if (authScheme === 'none') return {};
  return { Authorization: 'Bearer ' + String(apiKey || '') };
}

export function parseModelsList(json) {
  const list = Array.isArray(json) ? json
    : json && Array.isArray(json.data) ? json.data
    : json && Array.isArray(json.models) ? json.models
    : [];
  return list
    .map((m) => {
      const id = m && (m.id || m.model || m.name);
      if (!id) return null;
      return { id: String(id), label: String(m.display_name || m.displayName || id) };
    })
    .filter(Boolean);
}

export function probeProviderModels({
  baseUrl,
  apiKey,
  protocol = 'openai-compatible',
  dialect,
  authScheme,
  allowInsecureHttp = false,
  httpsImpl,
  timeoutMs = 8000,
} = {}) {
  let endpoint;
  try {
    const approvedBaseUrl = validateProviderBaseUrl(baseUrl, {
      allowInsecureHttp,
      requireTransportApproval: true,
    });
    const root = approvedBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    endpoint = new URL(root + '/v1/models');
  } catch (e) {
    if (e?.code === 'provider_insecure_http_forbidden') {
      return Promise.resolve({
        ok: false,
        status: 0,
        models: [],
        detail: 'Insecure provider HTTP is not approved',
      });
    }
    return Promise.resolve({ ok: false, status: 0, models: [], detail: 'Invalid base URL' });
  }
  let https;
  try {
    https = httpsImpl || getCepRequire()(endpoint.protocol === 'http:' ? 'http' : 'https');
  } catch (e) {
    return Promise.resolve({ ok: false, status: 0, models: [], detail: e.message });
  }
  return new Promise((resolve) => {
    const req = https.request({
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      protocol: endpoint.protocol,
      path: endpoint.pathname + endpoint.search,
      method: 'GET',
      headers: probeHeaders(protocol, apiKey, dialect || authScheme),
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, status: res.statusCode, models: [], detail: 'HTTP ' + res.statusCode + ' from provider' });
          return;
        }
        try {
          const models = parseModelsList(JSON.parse(body));
          resolve(models.length
            ? { ok: true, status: 200, models, detail: '' }
            : { ok: false, status: 200, models: [], detail: 'Empty model list' });
        } catch (e) {
          resolve({ ok: false, status: 200, models: [], detail: 'Response was not valid JSON' });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, models: [], detail: err && err.message ? err.message : 'request failed' }));
    if (req.setTimeout) req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (e) { /* noop */ } resolve({ ok: false, status: 0, models: [], detail: 'timeout' }); });
    req.end();
  });
}
