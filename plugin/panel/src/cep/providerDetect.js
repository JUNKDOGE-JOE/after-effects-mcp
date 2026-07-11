import { parseModelsList } from './modelProbe.js';
import {
  effectiveProviderDialect as selectEffectiveProviderDialect,
  normalizeBaseUrl,
} from '../lib/providerProfile.js';
import { buildProviderEndpoint } from '../lib/providerUrl.js';

export const effectiveProviderDialect = selectEffectiveProviderDialect;

function getCepRequire() {
  if (globalThis.window?.cep_node?.require) return globalThis.window.cep_node.require;
  if (globalThis.window?.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function endpointUrl(profile, resource) {
  return buildProviderEndpoint({
    baseUrl: profile.baseUrl,
    resource: resource === 'chat' ? 'chat-completions' : resource,
    allowInsecureHttp: profile.allowInsecureHttp === true,
  });
}

function normalizedHeaders(value) {
  const output = {};
  if (!value || typeof value !== 'object') return output;
  for (const [name, headerValue] of Object.entries(value)) {
    if (headerValue === undefined || headerValue === null) continue;
    output[String(name).toLowerCase()] = Array.isArray(headerValue)
      ? headerValue.map(String).join(', ')
      : String(headerValue);
  }
  return output;
}

function requestHeaders(profile, contentType = false) {
  const headers = {};
  for (const header of profile.extraHeaders || []) {
    headers[String(header.name).toLowerCase()] = String(header.value);
  }
  if (profile.auth?.kind === 'header') {
    headers[String(profile.auth.name).toLowerCase()] = String(profile.auth.value);
  }
  if (contentType) headers['content-type'] = 'application/json';
  return headers;
}

function defaultRequest({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let endpoint;
    let transport;
    try {
      endpoint = new URL(url);
      transport = getCepRequire()(endpoint.protocol === 'http:' ? 'http' : 'https');
    } catch {
      reject(new Error('provider request setup failed'));
      return;
    }

    const payload = body === undefined ? null : JSON.stringify(body);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const req = transport.request({
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      protocol: endpoint.protocol,
      path: endpoint.pathname + endpoint.search,
      method,
      headers,
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += String(chunk); });
      res.on('end', () => finish(resolve, {
        status: res.statusCode || 0,
        headers: normalizedHeaders(res.headers),
        body: responseBody,
      }));
    });
    req.on('error', () => finish(reject, new Error('provider request failed')));
    if (req.setTimeout) {
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(); } catch { /* timeout teardown is best effort */ }
        finish(reject, new Error('provider request timed out'));
      });
    }
    if (payload !== null && req.write) req.write(payload);
    req.end();
  });
}

function safeResult(raw) {
  const result = raw && typeof raw === 'object' ? raw : {};
  return {
    status: Number.isInteger(result.status) ? result.status : 0,
    headers: normalizedHeaders(result.headers),
    body: typeof result.body === 'string' ? result.body : '',
    redirected: result.redirected === true,
  };
}

async function requestStep({ step, profile, resource, method, body, requestImpl, timeoutMs, tried }) {
  let url;
  try {
    url = endpointUrl(profile, resource);
  } catch {
    return { configuration: true };
  }
  const headers = requestHeaders(profile, body !== undefined);
  const audit = {
    step,
    method,
    path: url.pathname + url.search,
    headerNames: Object.keys(headers).sort(),
  };
  try {
    const result = safeResult(await requestImpl({
      url: url.toString(),
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      timeoutMs,
    }));
    tried.push({ ...audit, status: result.status, outcome: 'received' });
    return result;
  } catch {
    tried.push({ ...audit, status: 0, outcome: 'network' });
    return { network: true, status: 0, headers: {}, body: '', redirected: false };
  }
}

function isJsonContentType(headers) {
  const value = String(headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  return value === 'application/json' || value.endsWith('+json');
}

function parsedJson(result) {
  if (!isJsonContentType(result.headers)) return null;
  try {
    const parsed = JSON.parse(result.body || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function endpointSemantic(result, expectedParam) {
  if (result.status !== 400 && result.status !== 422) return false;
  const parsed = parsedJson(result);
  return Boolean(parsed?.error && typeof parsed.error === 'object' && parsed.error.param === expectedParam);
}

function responsesSuccess(result) {
  if (result.status < 200 || result.status >= 300) return false;
  const parsed = parsedJson(result);
  return Boolean(
    parsed
    && parsed.object === 'response'
    && typeof parsed.id === 'string'
    && Array.isArray(parsed.output),
  );
}

function chatSuccess(result) {
  if (result.status < 200 || result.status >= 300) return false;
  const parsed = parsedJson(result);
  return Boolean(
    parsed
    && parsed.object === 'chat.completion'
    && typeof parsed.id === 'string'
    && Array.isArray(parsed.choices),
  );
}

function profileMatchesProvider(profile, provider) {
  return Boolean(
    profile
    && profile.providerId === provider.id
    && normalizeBaseUrl(profile.baseUrl) === normalizeBaseUrl(provider.baseUrl)
    && profile.allowInsecureHttp === provider.allowInsecureHttp
    && profile.authProfileRevision === provider.authProfileRevision
    && (profile.auth?.kind === 'none' || profile.auth?.kind === 'header')
    && Array.isArray(profile.extraHeaders),
  );
}

function profileSensitiveValues(profile) {
  const values = [];
  if (profile?.auth?.kind === 'header' && profile.auth.value) {
    const value = String(profile.auth.value);
    values.push(value);
    const bearer = /^Bearer\s+(.+)$/i.exec(value);
    if (bearer?.[1]) values.push(bearer[1]);
  }
  for (const header of profile?.extraHeaders || []) {
    if (header.source === 'secret' && header.value) values.push(String(header.value));
  }
  return [...new Set(values.filter(Boolean))];
}

function modelsContainSensitiveValue(models, values) {
  let serialized;
  try { serialized = JSON.stringify(models); } catch { return true; }
  return values.some((value) => serialized.includes(value));
}

function failure(reason, detail, tried) {
  return { ok: false, reason, detail, tried };
}

export async function detectProviderDialect({
  provider,
  resolveRequestProfile,
  requestImpl = defaultRequest,
  modelId,
  timeoutMs = 8000,
  now = Date.now,
} = {}) {
  const tried = [];
  if (
    !provider
    || provider.protocol !== 'openai-compatible'
    || typeof resolveRequestProfile !== 'function'
    || typeof requestImpl !== 'function'
  ) {
    return failure('configuration', 'Provider dialect detection is not configured', tried);
  }

  let probeProfile = null;
  let modelProfile = null;
  try {
    try {
      probeProfile = await resolveRequestProfile(provider, { scope: 'probe' });
    } catch {
      return failure('configuration', 'Provider probe profile could not be resolved', tried);
    }
    if (!profileMatchesProvider(probeProfile, provider)) {
      return failure('configuration', 'Provider probe profile does not match the provider', tried);
    }

    const modelsResult = await requestStep({
      step: 'models',
      profile: probeProfile,
      resource: 'models',
      method: 'GET',
      requestImpl,
      timeoutMs,
      tried,
    });
    if (modelsResult.configuration) {
      return failure('configuration', 'Provider models endpoint is invalid', tried);
    }
    if (modelsResult.network || modelsResult.status === 0) {
      return failure('network', 'Network error while probing provider models', tried);
    }
    if (modelsResult.status === 401 || modelsResult.status === 403) {
      return failure('authentication', 'Provider rejected the resolved probe profile', tried);
    }
    if (
      modelsResult.redirected
      || (modelsResult.status >= 300 && modelsResult.status < 400)
      || modelsResult.status === 404
      || modelsResult.status === 405
    ) {
      return failure('path-unsupported', 'Provider models endpoint is unavailable', tried);
    }
    const modelsJson = parsedJson(modelsResult);
    const models = modelsJson ? parseModelsList(modelsJson) : [];
    if (modelsResult.status !== 200 || models.length === 0) {
      return failure('path-unsupported', 'Provider models endpoint did not return a usable model list', tried);
    }
    if (modelsContainSensitiveValue(models, profileSensitiveValues(probeProfile))) {
      return failure('path-unsupported', 'Provider models endpoint returned unsafe metadata', tried);
    }

    try {
      modelProfile = await resolveRequestProfile(provider, { scope: 'model' });
    } catch {
      return failure('configuration', 'Provider model profile could not be resolved', tried);
    }
    if (!profileMatchesProvider(modelProfile, provider)) {
      return failure('configuration', 'Provider model profile does not match the provider', tried);
    }
    const selectedModel = String(modelId || models[0]?.id || '').trim();
    if (!selectedModel) return failure('configuration', 'Provider detection needs a model id', tried);

    const responses = await requestStep({
      step: 'responses',
      profile: modelProfile,
      resource: 'responses',
      method: 'POST',
      body: { model: selectedModel },
      requestImpl,
      timeoutMs,
      tried,
    });
    if (responses.configuration) {
      return failure('configuration', 'Provider Responses endpoint is invalid', tried);
    }
    if (responses.network || responses.status === 0) {
      return failure('network', 'Network error while probing provider wire API', tried);
    }
    if (responses.status === 401 || responses.status === 403) {
      return failure('authentication', 'Provider rejected the resolved model profile', tried);
    }
    let wireApi = '';
    let evidence = '';
    if (!responses.redirected && responsesSuccess(responses)) {
      wireApi = 'responses';
      evidence = 'responses-success-schema';
    } else if (!responses.redirected && endpointSemantic(responses, 'input')) {
      wireApi = 'responses';
      evidence = 'responses-missing-input';
    }

    if (!wireApi) {
      const chat = await requestStep({
        step: 'chat',
        profile: modelProfile,
        resource: 'chat-completions',
        method: 'POST',
        body: { model: selectedModel },
        requestImpl,
        timeoutMs,
        tried,
      });
      if (chat.configuration) return failure('configuration', 'Provider Chat endpoint is invalid', tried);
      if (chat.network || chat.status === 0) {
        return failure('network', 'Network error while probing provider wire API', tried);
      }
      if (chat.status === 401 || chat.status === 403) {
        return failure('authentication', 'Provider rejected the resolved model profile', tried);
      }
      if (!chat.redirected && chatSuccess(chat)) {
        wireApi = 'chat';
        evidence = 'chat-success-schema';
      } else if (!chat.redirected && endpointSemantic(chat, 'messages')) {
        wireApi = 'chat';
        evidence = 'chat-missing-messages';
      }
    }

    if (!wireApi) {
      return failure('dialect-incompatible', 'Provider did not expose a verified Responses or Chat API', tried);
    }
    let detectedAt;
    try { detectedAt = now(); } catch { detectedAt = NaN; }
    if (!Number.isFinite(detectedAt) || detectedAt < 0) {
      return failure('configuration', 'Provider detection clock is invalid', tried);
    }
    return {
      ok: true,
      dialect: {
        wireApi,
        baseUrl: normalizeBaseUrl(provider.baseUrl),
        authProfileRevision: provider.authProfileRevision,
        detectedAt,
        evidence,
      },
      models,
      tried,
    };
  } finally {
    probeProfile = null;
    modelProfile = null;
  }
}
