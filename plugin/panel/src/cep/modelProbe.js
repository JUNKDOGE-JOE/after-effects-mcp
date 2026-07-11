import { validateProviderBaseUrl } from '../lib/providerProfile.js';

function getCepRequire() {
  if (globalThis.window?.cep_node?.require) return globalThis.window.cep_node.require;
  if (globalThis.window?.require) return globalThis.window.require;
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
    .map((model) => {
      const id = model && (model.id || model.model || model.name);
      if (!id) return null;
      return { id: String(id), label: String(model.display_name || model.displayName || id) };
    })
    .filter(Boolean);
}

function modelsEndpoint(baseUrl, allowInsecureHttp) {
  const approved = validateProviderBaseUrl(baseUrl, {
    allowInsecureHttp,
    requireTransportApproval: true,
  });
  const endpoint = new URL(approved);
  let prefix = endpoint.pathname.replace(/\/+$/, '');
  if (/\/v1$/i.test(prefix)) prefix = prefix.slice(0, -3);
  endpoint.pathname = `${prefix === '/' ? '' : prefix}/v1/models`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

function resolvedProfileHeaders(profile) {
  const headers = {};
  for (const header of profile.extraHeaders || []) {
    headers[String(header.name).toLowerCase()] = String(header.value);
  }
  if (profile.auth?.kind === 'header') {
    headers[String(profile.auth.name).toLowerCase()] = String(profile.auth.value);
  }
  return headers;
}

function networkFailure() {
  return {
    ok: false,
    status: 0,
    models: [],
    detail: 'Network error while probing provider models',
  };
}

function resultFromResponse(status, body, sensitiveValues = []) {
  if (status !== 200) {
    return { ok: false, status, models: [], detail: 'HTTP ' + status + ' from provider' };
  }
  try {
    const models = parseModelsList(JSON.parse(body));
    const serialized = JSON.stringify(models);
    if (sensitiveValues.some((value) => value && serialized.includes(value))) {
      return { ok: false, status: 200, models: [], detail: 'Provider model metadata was rejected' };
    }
    return models.length
      ? { ok: true, status: 200, models, detail: '' }
      : { ok: false, status: 200, models: [], detail: 'Empty model list' };
  } catch {
    return { ok: false, status: 200, models: [], detail: 'Response was not valid JSON' };
  }
}

function requestWithTransport({ endpoint, headers, sensitiveValues, httpsImpl, timeoutMs }) {
  let transport;
  try {
    transport = httpsImpl || getCepRequire()(endpoint.protocol === 'http:' ? 'http' : 'https');
  } catch {
    return Promise.resolve(networkFailure());
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = transport.request({
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      protocol: endpoint.protocol,
      path: endpoint.pathname + endpoint.search,
      method: 'GET',
      headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += String(chunk); });
      res.on('end', () => finish(resultFromResponse(res.statusCode || 0, body, sensitiveValues)));
    });
    req.on('error', () => finish(networkFailure()));
    if (req.setTimeout) {
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(); } catch { /* timeout teardown is best effort */ }
        finish({ ok: false, status: 0, models: [], detail: 'timeout' });
      });
    }
    req.end();
  });
}

export async function probeProviderModels({
  requestProfile,
  baseUrl,
  apiKey,
  protocol = 'openai-compatible',
  dialect,
  authScheme,
  allowInsecureHttp = false,
  requestImpl,
  httpsImpl,
  timeoutMs = 8000,
} = {}) {
  const profile = requestProfile && typeof requestProfile === 'object' ? requestProfile : null;
  const selectedBaseUrl = profile ? profile.baseUrl : baseUrl;
  const selectedAllowInsecureHttp = profile ? profile.allowInsecureHttp === true : allowInsecureHttp;
  let endpoint;
  try {
    endpoint = modelsEndpoint(selectedBaseUrl, selectedAllowInsecureHttp);
  } catch (error) {
    if (error?.code === 'provider_insecure_http_forbidden') {
      return {
        ok: false,
        status: 0,
        models: [],
        detail: 'Insecure provider HTTP is not approved',
      };
    }
    return { ok: false, status: 0, models: [], detail: 'Invalid base URL' };
  }

  const headers = profile
    ? resolvedProfileHeaders(profile)
    : probeHeaders(protocol, apiKey, dialect || authScheme);
  const sensitiveValues = [];
  if (profile?.auth?.kind === 'header' && profile.auth.value) {
    const value = String(profile.auth.value);
    sensitiveValues.push(value);
    const bearer = /^Bearer\s+(.+)$/i.exec(value);
    if (bearer?.[1]) sensitiveValues.push(bearer[1]);
  } else if (apiKey) {
    sensitiveValues.push(String(apiKey));
  }
  for (const header of profile?.extraHeaders || []) {
    if (header.source === 'secret' && header.value) sensitiveValues.push(String(header.value));
  }
  if (typeof requestImpl === 'function') {
    try {
      const response = await requestImpl({
        url: endpoint.toString(),
        method: 'GET',
        headers,
        timeoutMs,
      });
      const status = Number.isInteger(response?.status) ? response.status : 0;
      if (status === 0) return networkFailure();
      return resultFromResponse(
        status,
        typeof response?.body === 'string' ? response.body : '',
        sensitiveValues,
      );
    } catch {
      return networkFailure();
    }
  }
  return requestWithTransport({ endpoint, headers, sensitiveValues, httpsImpl, timeoutMs });
}
