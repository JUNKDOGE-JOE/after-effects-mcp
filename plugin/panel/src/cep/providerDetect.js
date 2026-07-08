import { parseModelsList } from './modelProbe.js';

// Detects OpenAI-compatible provider dialects without binding callers to a
// specific backend: prefer Responses for richer capability, and treat a JSON
// 400 error as endpoint presence because parameter details vary by provider.
function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function normalizeRoot(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

function authHeaders(authScheme, apiKey) {
  if (authScheme === 'bearer') return { Authorization: 'Bearer ' + String(apiKey || '') };
  if (authScheme === 'x-api-key') return { 'x-api-key': String(apiKey || '') };
  return {};
}

function authCandidates(apiKey) {
  return String(apiKey || '') ? ['bearer', 'x-api-key', 'none'] : ['none'];
}

function safeDetail(message) {
  return String(message || 'request failed');
}

function parseJson(value) {
  try {
    return { ok: true, value: JSON.parse(value || '') };
  } catch (e) {
    return { ok: false, value: null };
  }
}

function isJsonErrorObject(body) {
  const parsed = parseJson(body);
  return parsed.ok
    && parsed.value
    && typeof parsed.value === 'object'
    && parsed.value.error
    && typeof parsed.value.error === 'object'
    && !Array.isArray(parsed.value.error);
}

function requestProvider({ url, method, headers, body, httpsImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let endpoint;
    try {
      endpoint = new URL(url);
    } catch (e) {
      resolve({ ok: false, network: true, status: 0, body: '', detail: 'Invalid base URL' });
      return;
    }

    let https;
    try {
      https = httpsImpl || getCepRequire()(endpoint.protocol === 'http:' ? 'http' : 'https');
    } catch (e) {
      resolve({ ok: false, network: true, status: 0, body: '', detail: safeDetail(e.message) });
      return;
    }

    const payload = body === undefined ? null : JSON.stringify(body);
    const reqHeaders = Object.assign({}, headers || {});
    if (payload !== null) {
      reqHeaders['Content-Type'] = 'application/json';
    }

    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const req = https.request({
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      protocol: endpoint.protocol,
      path: endpoint.pathname + endpoint.search,
      method,
      headers: reqHeaders,
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => finish({
        ok: true,
        network: false,
        status: res.statusCode || 0,
        body: responseBody,
        detail: '',
      }));
    });
    req.on('error', (err) => finish({
      ok: false,
      network: true,
      status: 0,
      body: '',
      detail: err && err.message ? err.message : 'request failed',
    }));
    if (req.setTimeout) {
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(); } catch (e) { /* noop */ }
        finish({ ok: false, network: true, status: 0, body: '', detail: 'timeout' });
      });
    }
    if (payload !== null && req.write) req.write(payload);
    req.end();
  });
}

async function detectAuth({ root, apiKey, httpsImpl, timeoutMs, tried }) {
  let saw200WithoutModels = false;
  let sawNonAuthStatus = false;
  for (const candidate of authCandidates(apiKey)) {
    const result = await requestProvider({
      url: root + '/v1/models',
      method: 'GET',
      headers: authHeaders(candidate, apiKey),
      httpsImpl,
      timeoutMs,
    });
    if (result.network) {
      tried.push({ step: 'auth', candidate, status: 0, outcome: 'network' });
      return { ok: false, reason: 'network', detail: 'Network error while probing provider models' };
    }
    if (result.status === 200) {
      const parsed = parseJson(result.body);
      const models = parsed.ok ? parseModelsList(parsed.value) : [];
      if (models.length) {
        tried.push({ step: 'auth', candidate, status: 200, outcome: 'accepted' });
        return { ok: true, authScheme: candidate, models };
      }
      saw200WithoutModels = true;
      tried.push({ step: 'auth', candidate, status: 200, outcome: 'no-models' });
    } else if (result.status === 401 || result.status === 403) {
      tried.push({ step: 'auth', candidate, status: result.status, outcome: 'rejected' });
    } else {
      sawNonAuthStatus = true;
      tried.push({ step: 'auth', candidate, status: result.status, outcome: 'rejected' });
    }
  }

  if (saw200WithoutModels) {
    return { ok: false, reason: 'no-models', detail: 'Provider model endpoint did not return a usable model list' };
  }
  return {
    ok: false,
    reason: 'auth',
    detail: sawNonAuthStatus
      ? 'No authentication scheme returned a usable provider model list'
      : 'Provider rejected all applicable authentication schemes',
  };
}

function wireRequest(wireApi, model) {
  if (wireApi === 'responses') {
    return {
      path: '/v1/responses',
      body: { model, input: 'ping', max_output_tokens: 16, stream: false },
    };
  }
  return {
    path: '/v1/chat/completions',
    body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false },
  };
}

async function detectWire({ root, apiKey, authScheme, model, httpsImpl, timeoutMs, tried }) {
  for (const candidate of ['responses', 'chat']) {
    const wire = wireRequest(candidate, model);
    const result = await requestProvider({
      url: root + wire.path,
      method: 'POST',
      headers: authHeaders(authScheme, apiKey),
      body: wire.body,
      httpsImpl,
      timeoutMs,
    });
    if (result.network) {
      tried.push({ step: 'wire', candidate, status: 0, outcome: 'network' });
      return { ok: false, reason: 'network', detail: 'Network error while probing provider wire API' };
    }
    if (result.status === 200 || (result.status === 400 && isJsonErrorObject(result.body))) {
      tried.push({ step: 'wire', candidate, status: result.status, outcome: 'accepted' });
      return { ok: true, wireApi: candidate };
    }
    if (result.status === 401 || result.status === 403) {
      tried.push({ step: 'wire', candidate, status: result.status, outcome: 'auth-mismatch' });
      return { ok: false, reason: 'auth-mismatch', detail: 'Provider wire API rejected the authentication scheme accepted by the model endpoint' };
    }
    tried.push({ step: 'wire', candidate, status: result.status, outcome: 'rejected' });
  }
  return { ok: false, reason: 'wire-undetected', detail: 'Provider did not accept the supported Responses or Chat wire APIs' };
}

export async function detectProviderDialect({
  baseUrl,
  apiKey,
  protocol = 'openai-compatible',
  httpsImpl,
  timeoutMs = 8000,
  now = Date.now,
} = {}) {
  const tried = [];
  try {
    if (protocol === 'anthropic') {
      return { ok: false, reason: 'not-applicable', tried, detail: 'Anthropic providers use a fixed dialect and do not need detection' };
    }

    let root;
    try {
      root = normalizeRoot(baseUrl);
      new URL(root + '/v1/models');
    } catch (e) {
      return { ok: false, reason: 'network', tried, detail: 'Invalid base URL' };
    }

    const auth = await detectAuth({ root, apiKey, httpsImpl, timeoutMs, tried });
    if (!auth.ok) return Object.assign({ tried }, auth);

    const model = auth.models[0] && auth.models[0].id;
    if (!model) {
      return { ok: false, reason: 'no-models', tried, detail: 'Provider model endpoint did not return a usable model list' };
    }

    const wire = await detectWire({ root, apiKey, authScheme: auth.authScheme, model, httpsImpl, timeoutMs, tried });
    if (!wire.ok) return Object.assign({ tried }, wire);

    return {
      ok: true,
      dialect: {
        wireApi: wire.wireApi,
        authScheme: auth.authScheme,
        source: 'detected',
        updatedAt: now(),
      },
      models: auth.models,
      tried,
    };
  } catch (e) {
    return { ok: false, reason: 'network', tried, detail: safeDetail(e && e.message ? e.message : 'Provider detection failed') };
  }
}
