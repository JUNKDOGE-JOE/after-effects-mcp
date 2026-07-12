import { validateProviderBaseUrl } from '../lib/providerProfile.js';
import { buildProtocolAuthCandidates } from '../lib/providerProbeAuth.js';
import { buildProviderEndpointCandidates } from '../lib/providerUrl.js';

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
  return parseProviderModelInventory(json).map(({ id, label }) => ({ id, label }));
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map(String)
    : [];
}

export function parseProviderModelInventory(json) {
  const list = Array.isArray(json) ? json
    : json && Array.isArray(json.data) ? json.data
      : json && Array.isArray(json.models) ? json.models
        : [];
  return list
    .map((model) => {
      const id = model && (model.id || model.model || model.name);
      if (!id) return null;
      return {
        id: String(id),
        label: String(model.display_name || model.displayName || id),
        metadata: {
          task: typeof model.task === 'string' ? model.task : null,
          inputModalities: stringList(model.input_modalities || model.inputModalities),
          outputModalities: stringList(model.output_modalities || model.outputModalities || model.modalities),
          capabilities: stringList(model.capabilities),
        },
      };
    })
    .filter(Boolean);
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
    const inventory = parseProviderModelInventory(JSON.parse(body));
    const models = inventory.map(({ id, label }) => ({ id, label }));
    const serialized = JSON.stringify(inventory);
    if (sensitiveValues.some((value) => value && serialized.includes(value))) {
      return { ok: false, status: 200, models: [], detail: 'Provider model metadata was rejected' };
    }
    return models.length
      ? { ok: true, status: 200, models, inventory, detail: '' }
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
  let endpoints;
  try {
    validateProviderBaseUrl(selectedBaseUrl, {
      allowInsecureHttp: selectedAllowInsecureHttp,
      requireTransportApproval: true,
    });
    endpoints = buildProviderEndpointCandidates({
      baseUrl: selectedBaseUrl,
      resource: 'models',
      allowInsecureHttp: selectedAllowInsecureHttp,
    });
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

  let authCandidates;
  try {
    authCandidates = profile
      ? buildProtocolAuthCandidates(profile, protocol === 'anthropic' ? 'messages' : 'models')
      : [{
        scheme: authSchemeFromDialect(dialect || authScheme) || (protocol === 'anthropic' ? 'x-api-key' : 'bearer'),
        headers: probeHeaders(protocol, apiKey, dialect || authScheme),
      }];
  } catch {
    return { ok: false, status: 0, models: [], detail: 'Invalid provider request profile' };
  }
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
  let lastResult = null;
  for (const endpoint of endpoints) {
    for (let authIndex = 0; authIndex < authCandidates.length; authIndex += 1) {
      const authCandidate = authCandidates[authIndex];
      let result;
      if (typeof requestImpl === 'function') {
        try {
          const response = await requestImpl({
            url: endpoint.url.toString(),
            method: 'GET',
            headers: authCandidate.headers,
            timeoutMs,
          });
          const status = Number.isInteger(response?.status) ? response.status : 0;
          result = status === 0
            ? networkFailure()
            : resultFromResponse(
              status,
              typeof response?.body === 'string' ? response.body : '',
              sensitiveValues,
            );
        } catch {
          result = networkFailure();
        }
      } else {
        result = await requestWithTransport({
          endpoint: endpoint.url,
          headers: authCandidate.headers,
          sensitiveValues,
          httpsImpl,
          timeoutMs,
        });
      }
      lastResult = {
        ...result,
        apiRoot: endpoint.apiRoot.toString().replace(/\/$/, ''),
        apiRootId: endpoint.id,
        authScheme: authCandidate.scheme,
      };
      if (result.ok) return lastResult;
      if ((result.status === 401 || result.status === 403) && authIndex + 1 < authCandidates.length) {
        continue;
      }
      break;
    }
    if (
      ![0, 401, 403, 404, 405].includes(lastResult?.status)
      && lastResult?.redirected !== true
    ) return lastResult;
  }
  return lastResult || networkFailure();
}
