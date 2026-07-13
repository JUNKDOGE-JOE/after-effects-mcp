import {
  chatBodyWithDeveloperRoleAsSystem,
  chatBodyWithMaxCompletionTokens,
  chatCompletionToResponse,
  chatErrorRequestsMaxCompletionTokens,
  createChatSseToResponses,
  responsesBodyToChatBody,
} from '../lib/codexResponsesCodec.js';
import {
  collectCodexHeaders,
  filterUpstreamResponseHeaders,
  mergeUpstreamHeaders,
  validateProviderRequestConfiguration,
} from '../lib/providerHeaders.js';
import { buildProviderEndpoint } from '../lib/providerUrl.js';
import {
  containsExactSecret,
  containsExactSecretAcrossBoundary,
  createByteRedactor,
  redactText,
  redactValue,
} from '../lib/exactSecretRedaction.js';
import { requireCredentialFreeSse } from '../lib/providerSseSecretGuard.js';
import {
  generateRouteToken,
  parseRouteToken,
  routeTokenMatches,
} from './providerRouteAuth.js';
import { createReasoningCapsule } from './reasoningCapsule.js';

export { responsesBodyToChatBody } from '../lib/codexResponsesCodec.js';

export const DEFAULT_ROUTE_LIMITS = Object.freeze({
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

const LOCAL_ORIGIN = 'http://127.0.0.1';

function getCepRequire() {
  if (globalThis.window?.cep_node?.require) return globalThis.window.cep_node.require;
  if (globalThis.window?.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function supportsReasoningCapsule(crypto) {
  return typeof crypto?.createCipheriv === 'function'
    && typeof crypto?.createDecipheriv === 'function';
}

function routeLimits(overrides = {}) {
  const limits = {};
  for (const [name, maximum] of Object.entries(DEFAULT_ROUTE_LIMITS)) {
    const value = Number(overrides[name]);
    limits[name] = Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.floor(value)) : maximum;
  }
  return Object.freeze(limits);
}

function headerLimits(limits) {
  return {
    maxValueBytes: limits.headerValueBytes,
    maxTotalBytes: limits.headerTotalBytes,
    maxCount: limits.headerCount,
  };
}

function envelope(type, code, message, extra = {}) {
  return { error: { type, code, message, ...extra } };
}

function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function writeSse(res, name, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function localPathHasTraversal(rawUrl) {
  const path = String(rawUrl || '').split(/[?#]/, 1)[0];
  let current = path;
  for (let layer = 0; layer < 4; layer += 1) {
    if (current.split('/').some((segment) => segment === '.' || segment === '..')) return true;
    let decoded;
    try { decoded = decodeURIComponent(current); } catch { return true; }
    if (decoded === current) return false;
    current = decoded;
  }
  return current.split('/').some((segment) => segment === '.' || segment === '..');
}

function parseLocalUrl(rawUrl) {
  const raw = String(rawUrl || '');
  if (!raw.startsWith('/') || raw.includes('#') || localPathHasTraversal(raw)) {
    const error = new Error('Local provider route URL is invalid.');
    error.code = 'invalid_route_url';
    throw error;
  }
  let parsed;
  try { parsed = new URL(raw, LOCAL_ORIGIN); } catch {
    const error = new Error('Local provider route URL is invalid.');
    error.code = 'invalid_route_url';
    throw error;
  }
  if (parsed.origin !== LOCAL_ORIGIN) {
    const error = new Error('Local provider route URL is invalid.');
    error.code = 'invalid_route_url';
    throw error;
  }
  return parsed;
}

function rawResponseHeaders(upstream) {
  if (Array.isArray(upstream?.rawHeaders)) return upstream.rawHeaders;
  const raw = [];
  for (const [name, value] of Object.entries(upstream?.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) raw.push(name, String(item));
    } else if (value !== undefined) raw.push(name, String(value));
  }
  return raw;
}

function destroyOnce(context) {
  if (context.upstreamDestroyed) return;
  context.upstreamDestroyed = true;
  for (const stream of [context.upstreamRequest, context.upstreamResponse]) {
    if (stream && typeof stream.destroy === 'function' && !stream.destroyed) {
      try { stream.destroy(); } catch { /* destruction is best effort after ownership is fenced */ }
    }
  }
}

function finishOnce(context) {
  if (context.finished) return false;
  context.finished = true;
  if (context.cancelBodyRead) context.cancelBodyRead();
  clearTimeout(context.connectTimer);
  clearTimeout(context.idleTimer);
  clearTimeout(context.totalTimer);
  context.req.off('aborted', context.onClientAbort);
  context.res.off('close', context.onClientClose);
  context.gate.release();
  context.owner.delete(context);
  return true;
}

function streamFailure(context, error) {
  if (context.finished) return;
  destroyOnce(context);
  const code = String(error?.code || 'provider_error');
  const message = String(error?.message || 'Provider stream failed.');
  if (!context.res.headersSent) {
    finishOnce(context);
    sendJson(context.res, Number(error?.status) || 502, envelope('provider_protocol_error', code, message));
    return;
  }
  writeSse(context.res, 'error', {
    type: 'error',
    error: { type: 'provider_protocol_error', code, message },
  });
  finishOnce(context);
  context.res.end();
}

function timeoutRequest(context, code, message) {
  if (context.finished) return;
  destroyOnce(context);
  if (context.res.headersSent) {
    streamFailure(context, { status: 504, code, message });
    return;
  }
  finishOnce(context);
  sendJson(context.res, 504, envelope('provider_timeout_error', code, message));
}

function resetIdleTimer(context) {
  clearTimeout(context.idleTimer);
  context.idleTimer = setTimeout(() => timeoutRequest(
    context,
    'provider_idle_timeout',
    'Provider response became idle.',
  ), context.limits.idleTimeoutMs);
}

function requestIdFromHeaders(headers) {
  const item = headers.find((header) => header.name === 'x-client-request-id' || header.name === 'x-request-id');
  return item ? item.value : `route-${Date.now().toString(36)}`;
}

function readRequestBody(req, maximum, context) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      if (context.cancelBodyRead === cancel) context.cancelBodyRead = null;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maximum) {
        const error = new Error('Request body is too large.');
        error.code = 'request_body_too_large';
        fail(error);
        req.resume();
        return;
      }
      chunks.push(value);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = () => {
      const error = new Error('Request body could not be read.');
      error.code = 'invalid_request_body';
      fail(error);
    };
    const cancel = () => {
      const error = new Error('Request body was cancelled.');
      error.code = 'request_body_cancelled';
      fail(error);
    };
    context.cancelBodyRead = cancel;
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function parseJsonBody(buffer) {
  try { return JSON.parse(buffer.length ? buffer.toString('utf8') : '{}'); } catch {
    const error = new Error('Request body must be valid JSON.');
    error.code = 'invalid_json';
    throw error;
  }
}

function secretValues(profile) {
  const values = [];
  if (profile?.auth?.kind === 'header' && profile.auth.value) {
    const value = String(profile.auth.value);
    values.push(value);
    const match = value.match(/^(?:Bearer|Basic)\s+(.+)$/i);
    if (match) values.push(match[1]);
  }
  for (const header of profile?.extraHeaders || []) {
    if (header?.value) values.push(String(header.value));
  }
  return [...new Set(values.filter(Boolean))].sort((left, right) => right.length - left.length);
}

function sanitizedProviderMessage(buffer, truncated, secrets) {
  if (truncated) return 'Provider request failed with a bounded error response.';
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { return 'Provider request failed.'; }
  let message = parsed?.error?.message ?? parsed?.message;
  if (typeof message !== 'string' || !message) return 'Provider request failed.';
  message = redactText(message, secrets);
  return message.replace(/[\r\n\0]+/g, ' ').slice(0, 256);
}

function explicitlyRejectsDeveloperRole(status, buffer) {
  if (status !== 400 && status !== 422) return false;
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { return false; }
  const message = parsed?.error?.message ?? parsed?.message;
  if (typeof message !== 'string') return false;
  const normalized = message.toLowerCase();
  if (!/(^|[^a-z])developer([^a-z]|$)/.test(normalized)) return false;
  if (!/(^|[^a-z])roles?([^a-z]|$)/.test(normalized)) return false;
  return /\b(unexpected|unsupported|invalid|disallowed|forbidden)\b/.test(normalized)
    || /\bunknown\s+variant\b/.test(normalized)
    || /\bexpected\s+one\s+of\b/.test(normalized)
    || /\bnot\s+(?:supported|allowed|accepted)\b/.test(normalized)
    || /\ballowed\s+roles?\b/.test(normalized);
}

function withoutSecretBearingHeaders(headers, secrets) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    const text = String(value);
    if (containsExactSecret(text, secrets)) continue;
    output[name] = text;
  }
  return containsExactSecret(output, secrets) ? {} : output;
}

function withoutHeadersCompletedByPayload(headers, payload, secrets) {
  const entries = Object.entries(headers);
  const seeds = [
    ...entries.flat(),
    entries.map(([name]) => name).join(''),
    entries.map(([, value]) => value).join(''),
    entries.flat().join(''),
  ];
  if (containsExactSecretAcrossBoundary(seeds, payload, secrets)) return {};
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => (
    !containsExactSecretAcrossBoundary([name, value], payload, secrets)
  )));
}

function readProviderError(
  context,
  upstream,
  status,
  responseHeaders,
  secrets,
  retryCompatibility,
) {
  const chunks = [];
  let bytes = 0;
  let settled = false;
  const finish = (truncated) => {
    if (settled || context.finished) return;
    settled = true;
    const buffer = Buffer.concat(chunks);
    if (
      !truncated
      && typeof retryCompatibility === 'function'
      && retryCompatibility(status, buffer)
    ) return;
    let message = sanitizedProviderMessage(buffer, truncated, secrets);
    let requestId = responseHeaders['x-request-id']
      || responseHeaders['request-id']
      || responseHeaders['openai-request-id'];
    let extra = requestId ? { request_id: requestId } : {};
    let outputHeaders = requestId ? { 'x-request-id': requestId } : {};
    const errorPayload = { message, ...extra };
    outputHeaders = withoutHeadersCompletedByPayload(outputHeaders, errorPayload, secrets);
    if (!Object.keys(outputHeaders).length && requestId) {
      message = 'Provider request failed.';
      requestId = null;
      extra = {};
      outputHeaders = {};
    }
    finishOnce(context);
    sendJson(
      context.res,
      status >= 400 && status < 500 ? status : 502,
      envelope('provider_error', 'provider_error', message, extra),
      outputHeaders,
    );
  };
  upstream.on('data', (chunk) => {
    if (settled) return;
    resetIdleTimer(context);
    const value = Buffer.from(chunk);
    const remaining = context.limits.errorBodyBytes + 1 - bytes;
    if (remaining > 0) chunks.push(value.subarray(0, remaining));
    bytes += value.length;
    if (bytes > context.limits.errorBodyBytes) {
      if (typeof upstream.destroy === 'function') upstream.destroy();
      finish(true);
    }
  });
  upstream.on('end', () => finish(false));
  upstream.on('error', () => finish(bytes > context.limits.errorBodyBytes));
}

function pipeModels(context, upstream, status, headers, secrets) {
  const chunks = [];
  let bytes = 0;
  upstream.on('data', (chunk) => {
    if (context.finished) return;
    resetIdleTimer(context);
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > context.limits.responseBodyBytes) {
      streamFailure(context, {
        status: 502,
        code: 'provider_response_too_large',
        message: 'Provider model response was too large.',
      });
      return;
    }
    chunks.push(value);
  });
  upstream.on('end', () => {
    if (context.finished) return;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (containsExactSecret(parsed, secrets)) throw new Error('credential reflection');
      parsed = redactValue(parsed, secrets);
    } catch {
      streamFailure(context, {
        status: 502,
        code: 'provider_model_metadata_rejected',
        message: 'Provider model metadata was rejected.',
      });
      return;
    }
    const outputHeaders = withoutHeadersCompletedByPayload(headers, parsed, secrets);
    if (!finishOnce(context)) return;
    sendJson(context.res, status, parsed, outputHeaders);
  });
  upstream.on('error', () => {
    streamFailure(context, {
      status: 502,
      code: 'provider_error',
      message: 'Provider response stream failed.',
    });
  });
}

function readNonStreamingResponse(context, upstream, status, headers, chatBody, secrets) {
  const chunks = [];
  let bytes = 0;
  upstream.on('data', (chunk) => {
    if (context.finished) return;
    resetIdleTimer(context);
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > context.limits.responseBodyBytes) {
      streamFailure(context, {
        status: 502,
        code: 'provider_response_too_large',
        message: 'Provider response body is too large.',
      });
      return;
    }
    chunks.push(value);
  });
  upstream.on('end', () => {
    if (context.finished) return;
    let parsed;
    let response;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response = chatCompletionToResponse(
        parsed,
        { id: context.responseId, model: String(chatBody.model || '') },
        { sealReasoning: context.reasoningCapsule?.seal },
      );
      response = redactValue(response, secrets);
    } catch {
      streamFailure(context, {
        status: 502,
        code: 'invalid_chat_completion',
        message: 'Provider returned an invalid Chat Completion.',
      });
      return;
    }
    const outputHeaders = withoutHeadersCompletedByPayload(headers, response, secrets);
    finishOnce(context);
    sendJson(context.res, status, response, outputHeaders);
  });
  upstream.on('error', () => streamFailure(context, {
    status: 502,
    code: 'provider_error',
    message: 'Provider response body failed.',
  }));
}

function streamChatResponse(context, upstream, status, headers, chatBody, secrets) {
  const chunks = [];
  let bytes = 0;
  upstream.on('data', (chunk) => {
    if (context.finished) return;
    resetIdleTimer(context);
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > context.limits.responseBodyBytes) {
      streamFailure(context, {
        status: 502,
        code: 'provider_response_too_large',
        message: 'Provider response stream was too large.',
      });
      return;
    }
    chunks.push(value);
  });
  upstream.on('end', () => {
    if (context.finished) return;
    const transcript = Buffer.concat(chunks);
    let outputHeaders = headers;
    try {
      requireCredentialFreeSse(transcript, secrets, {
        maxFrameBytes: context.limits.sseFrameBytes,
        seedValues: [
          ...Object.entries(headers).flat(),
          Object.keys(headers).join(''),
          Object.values(headers).join(''),
          Object.entries(headers).flat().join(''),
        ],
      });
    } catch (error) {
      try {
        requireCredentialFreeSse(transcript, secrets, {
          maxFrameBytes: context.limits.sseFrameBytes,
        });
        outputHeaders = {};
      } catch {
        streamFailure(context, error);
        return;
      }
    }
    context.res.writeHead(status, {
      ...outputHeaders,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': outputHeaders['cache-control'] || 'no-cache',
    });
    const responseRedactor = createByteRedactor(secrets, (chunk) => context.res.write(chunk));
    const failAdapter = () => {
      responseRedactor.discard();
      streamFailure(context, {
        status: 502,
        code: 'invalid_chat_completion',
        message: 'Provider returned an invalid Chat Completion stream.',
      });
    };
    const adapter = createChatSseToResponses({
      id: context.responseId,
      model: String(chatBody.model || ''),
      maxFrameBytes: context.limits.sseFrameBytes,
      writeEvent: (name, payload) => responseRedactor.feed(Buffer.from(
        `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`,
        'utf8',
      )),
      fail: failAdapter,
      sealReasoning: context.reasoningCapsule?.seal,
    });
    try {
      adapter.feed(transcript);
      if (!context.finished) adapter.end();
    } catch {
      failAdapter();
      return;
    }
    if (context.finished) return;
    responseRedactor.flush();
    if (!finishOnce(context)) return;
    context.res.end();
  });
  upstream.on('error', () => {
    streamFailure(context, {
      status: 502,
      code: 'provider_error',
      message: 'Provider response stream failed.',
    });
  });
}

function handleUpstreamResponse(
  context,
  upstream,
  kind,
  profile,
  chatBody,
  retryCompatibility,
) {
  if (context.finished) {
    if (typeof upstream.destroy === 'function') upstream.destroy();
    return;
  }
  context.upstreamResponse = upstream;
  clearTimeout(context.connectTimer);
  resetIdleTimer(context);
  const status = Number(upstream.statusCode) || 502;
  const secrets = secretValues(profile);
  const headers = withoutSecretBearingHeaders(
    filterUpstreamResponseHeaders(rawResponseHeaders(upstream)),
    secrets,
  );
  if (status >= 300 && status < 400) {
    destroyOnce(context);
    finishOnce(context);
    sendJson(context.res, 502, envelope(
      'provider_protocol_error',
      'provider_redirect_blocked',
      'Provider redirects are not followed.',
    ));
    return;
  }
  if (status >= 400) {
    readProviderError(
      context,
      upstream,
      status,
      headers,
      secrets,
      retryCompatibility,
    );
    return;
  }
  if (kind === 'models') {
    pipeModels(context, upstream, status, headers, secrets);
    return;
  }
  if (chatBody.stream === false) {
    readNonStreamingResponse(context, upstream, status, headers, chatBody, secrets);
    return;
  }
  streamChatResponse(context, upstream, status, headers, chatBody, secrets);
}

function openUpstream(context, {
  endpoint,
  method,
  headers,
  payload,
  kind,
  profile,
  chatBody,
  requireImpl,
  createUpstreamRequest,
  lookupImpl,
  allowDeveloperRoleRetry = false,
  allowMaxCompletionTokensRetry = false,
}) {
  if (context.finished) return;
  const options = {
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port || undefined,
    path: endpoint.pathname + endpoint.search,
    method,
    headers,
  };
  if (lookupImpl) options.lookup = lookupImpl;
  context.connectTimer = setTimeout(() => timeoutRequest(
    context,
    'provider_connect_timeout',
    'Provider connection timed out.',
  ), context.limits.connectTimeoutMs);

  let request;
  try {
    const requestFactory = createUpstreamRequest
      || requireImpl(endpoint.protocol === 'http:' ? 'http' : 'https').request.bind(
        requireImpl(endpoint.protocol === 'http:' ? 'http' : 'https'),
      );
    request = requestFactory(options, (upstream) => {
      const retryCompatibility = allowDeveloperRoleRetry || allowMaxCompletionTokensRetry
        ? (status, buffer) => {
          let retryBody = null;
          let retryDeveloperRole = allowDeveloperRoleRetry;
          let retryMaxCompletionTokens = allowMaxCompletionTokensRetry;
          if (retryDeveloperRole && explicitlyRejectsDeveloperRole(status, buffer)) {
            retryBody = chatBodyWithDeveloperRoleAsSystem(chatBody);
            if (retryBody) retryDeveloperRole = false;
          }
          if (!retryBody && retryMaxCompletionTokens) {
            let parsed = null;
            try { parsed = JSON.parse(buffer.toString('utf8')); } catch {}
            if (chatErrorRequestsMaxCompletionTokens(status, parsed)) {
              retryBody = chatBodyWithMaxCompletionTokens(chatBody);
              if (retryBody) retryMaxCompletionTokens = false;
            }
          }
          if (!retryBody || context.finished) return false;
          clearTimeout(context.idleTimer);
          context.idleTimer = null;
          context.upstreamRequest = null;
          context.upstreamResponse = null;
          // Each successful fallback consumes one flag and carries prior
          // transformations forward, bounding the route to three requests.
          openUpstream(context, {
            endpoint,
            method,
            headers,
            payload: Buffer.from(JSON.stringify(retryBody), 'utf8'),
            kind,
            profile,
            chatBody: retryBody,
            requireImpl,
            createUpstreamRequest,
            lookupImpl,
            allowDeveloperRoleRetry: retryDeveloperRole,
            allowMaxCompletionTokensRetry: retryMaxCompletionTokens,
          });
          return true;
        }
        : null;
      handleUpstreamResponse(
        context,
        upstream,
        kind,
        profile,
        chatBody,
        retryCompatibility,
      );
    });
    context.upstreamRequest = request;
    request.on('error', () => {
      if (context.finished || context.upstreamResponse) return;
      clearTimeout(context.connectTimer);
      finishOnce(context);
      sendJson(context.res, 502, envelope('provider_error', 'provider_error', 'Provider request failed.'));
    });
    if (payload) request.write(payload);
    request.end();
  } catch {
    clearTimeout(context.connectTimer);
    finishOnce(context);
    sendJson(context.res, 502, envelope('provider_error', 'provider_error', 'Provider request failed.'));
  }
}

function createGate(maximum) {
  let active = 0;
  return {
    acquire() {
      if (active >= maximum) return false;
      active += 1;
      return true;
    },
    release() {
      if (active > 0) active -= 1;
    },
  };
}

function compactResponse(res) {
  sendJson(res, 501, envelope(
    'provider_compaction_unsupported',
    'provider_compaction_unsupported',
    'This chat-only provider cannot compact Responses context.',
  ));
}

function methodNotAllowed(res, method, pathname, allowed) {
  sendJson(res, 405, envelope(
    'invalid_request_error',
    'method_not_allowed',
    `Method ${method} is not allowed for ${pathname}.`,
  ), { allow: allowed });
}

export function createCodexResponsesRoute({
  provider,
  resolveRequestProfile,
  requireImpl = getCepRequire(),
  createUpstreamRequest,
  lookupImpl,
  cryptoImpl,
  limits: limitOverrides,
  onAudit = () => {},
} = {}) {
  if (!provider || typeof provider !== 'object') throw new TypeError('provider is required');
  if (typeof resolveRequestProfile !== 'function') throw new TypeError('resolveRequestProfile is required');
  const crypto = cryptoImpl || requireImpl('crypto');
  if (
    !crypto
    || typeof crypto.randomBytes !== 'function'
    || typeof crypto.createHash !== 'function'
    || typeof crypto.timingSafeEqual !== 'function'
  ) throw new TypeError('crypto implementation is required');

  const limits = routeLimits(limitOverrides);
  const headersLimit = headerLimits(limits);
  const gate = createGate(limits.concurrent);
  const contexts = new Set();
  let server = null;
  let baseUrl = '';
  let routeToken = null;
  let reasoningCapsule = null;
  let startPromise = null;
  let responseSequence = 0;

  const admit = (req, res) => {
    if (!gate.acquire()) {
      sendJson(res, 429, envelope(
        'rate_limit_error',
        'route_concurrency_limit',
        'Local provider route concurrency limit reached.',
      ));
      return null;
    }
    const context = {
      req,
      res,
      gate,
      owner: contexts,
      limits,
      finished: false,
      upstreamDestroyed: false,
      upstreamRequest: null,
      upstreamResponse: null,
      connectTimer: null,
      idleTimer: null,
      totalTimer: null,
      responseId: `resp_route_${Date.now().toString(36)}_${(responseSequence += 1).toString(36)}`,
      cancelBodyRead: null,
      onClientAbort: null,
      onClientClose: null,
      reasoningCapsule,
    };
    context.onClientAbort = () => {
      if (context.finished) return;
      destroyOnce(context);
      finishOnce(context);
    };
    context.onClientClose = () => {
      if (context.finished) return;
      destroyOnce(context);
      finishOnce(context);
    };
    req.on('aborted', context.onClientAbort);
    res.on('close', context.onClientClose);
    context.totalTimer = setTimeout(() => timeoutRequest(
      context,
      'provider_total_timeout',
      'Provider request exceeded the total time limit.',
    ), limits.totalTimeoutMs);
    contexts.add(context);
    return context;
  };

  const resolveProfile = async (scope, details = {}) => {
    validateProviderRequestConfiguration(provider, scope, headersLimit);
    return resolveRequestProfile(provider, { scope, ...details });
  };

  const prepareHeaders = (req, profile, contentType) => {
    const merged = mergeUpstreamHeaders({
      rawHeaders: req.rawHeaders || [],
      providerHeaders: profile.extraHeaders,
      auth: profile.auth,
      contentType,
      limits: headersLimit,
    });
    const codex = collectCodexHeaders(req.rawHeaders || [], headersLimit);
    const requestId = requestIdFromHeaders(codex);
    onAudit({
      event: 'provider_headers',
      requestId,
      forwardedNames: codex.map((header) => header.name),
      providerNames: (profile.extraHeaders || []).map((header) => String(header.name).toLowerCase()),
      authName: profile.auth?.kind === 'header' ? String(profile.auth.name).toLowerCase() : null,
      decision: 'allowed',
    });
    return merged;
  };

  const handleModels = async (req, res, localUrl) => {
    try { collectCodexHeaders(req.rawHeaders || [], headersLimit); } catch (error) {
      sendJson(res, 400, envelope('invalid_request_error', error.code, error.message));
      return;
    }
    try { validateProviderRequestConfiguration(provider, 'probe', headersLimit); } catch (error) {
      sendJson(res, 400, envelope('invalid_request_error', error.code, error.message));
      return;
    }
    const context = admit(req, res);
    if (!context) return;
    let profile;
    let endpoint;
    let headers;
    try {
      profile = await resolveProfile('probe');
      if (context.finished) return;
      endpoint = buildProviderEndpoint({
        baseUrl: profile.baseUrl,
        resource: 'models',
        inboundSearch: localUrl.search,
        allowInsecureHttp: profile.allowInsecureHttp,
      });
      headers = prepareHeaders(req, profile);
    } catch (error) {
      if (context.finished) return;
      finishOnce(context);
      sendJson(res, error?.code?.startsWith('provider_header_') ? 400 : 502, envelope(
        'provider_configuration_error',
        error?.code || 'provider_configuration_error',
        'Provider request configuration is invalid.',
      ));
      return;
    }
    openUpstream(context, {
      endpoint,
      method: 'GET',
      headers,
      payload: null,
      kind: 'models',
      profile,
      chatBody: null,
      requireImpl,
      createUpstreamRequest,
      lookupImpl,
    });
  };

  const handleResponses = async (req, res, localUrl) => {
    try { collectCodexHeaders(req.rawHeaders || [], headersLimit); } catch (error) {
      sendJson(res, 400, envelope('invalid_request_error', error.code, error.message));
      return;
    }
    try { validateProviderRequestConfiguration(provider, 'model', headersLimit); } catch (error) {
      sendJson(res, 400, envelope('invalid_request_error', error.code, error.message));
      return;
    }
    const context = admit(req, res);
    if (!context) return;

    let requestBody;
    let chatBody;
    try {
      requestBody = await readRequestBody(req, limits.requestBodyBytes, context);
      if (context.finished) return;
      chatBody = responsesBodyToChatBody(parseJsonBody(requestBody), {
        openReasoning: reasoningCapsule?.open,
      });
    } catch (error) {
      if (context.finished) return;
      finishOnce(context);
      const status = error?.code === 'request_body_too_large' ? 413 : Number(error?.status) || 400;
      sendJson(res, status, envelope(
        'invalid_request_error',
        error?.code || 'invalid_request_body',
        error?.message || 'Request body is invalid.',
        error?.param ? { param: error.param } : {},
      ));
      return;
    }

    let profile;
    let endpoint;
    let headers;
    let payload;
    try {
      profile = await resolveProfile('model', {
        modelId: String(chatBody.model || ''),
        protocol: 'chat',
      });
      if (context.finished) return;
      endpoint = buildProviderEndpoint({
        baseUrl: profile.baseUrl,
        resource: 'chat-completions',
        inboundSearch: localUrl.search,
        allowInsecureHttp: profile.allowInsecureHttp,
      });
      headers = prepareHeaders(req, profile, 'application/json');
      payload = Buffer.from(JSON.stringify(chatBody), 'utf8');
    } catch (error) {
      if (context.finished) return;
      finishOnce(context);
      sendJson(res, error?.code?.startsWith('provider_header_') ? 400 : 502, envelope(
        'provider_configuration_error',
        error?.code || 'provider_configuration_error',
        'Provider request configuration is invalid.',
      ));
      return;
    }
    openUpstream(context, {
      endpoint,
      method: 'POST',
      headers,
      payload,
      kind: 'responses',
      profile,
      chatBody,
      requireImpl,
      createUpstreamRequest,
      lookupImpl,
      allowDeveloperRoleRetry: true,
      allowMaxCompletionTokensRetry: true,
    });
  };

  const handleLocalRequest = (req, res) => {
    const candidate = parseRouteToken(req.rawHeaders || []);
    const authorized = routeTokenMatches(candidate || '', routeToken || '', crypto);
    if (!candidate || !routeToken || !authorized) {
      sendJson(res, 401, envelope(
        'authentication_error',
        'invalid_route_token',
        'Invalid local provider route token.',
      ));
      return;
    }

    let localUrl;
    try { localUrl = parseLocalUrl(req.url); } catch (error) {
      sendJson(res, 400, envelope('invalid_request_error', error.code, error.message));
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = localUrl.pathname;
    if (pathname === '/v1/responses/compact') {
      if (method !== 'POST') methodNotAllowed(res, method, pathname, 'POST');
      else compactResponse(res);
      return;
    }
    if (pathname === '/v1/models') {
      if (method !== 'GET') methodNotAllowed(res, method, pathname, 'GET');
      else void handleModels(req, res, localUrl);
      return;
    }
    if (pathname === '/v1/responses') {
      if (method !== 'POST') methodNotAllowed(res, method, pathname, 'POST');
      else void handleResponses(req, res, localUrl);
      return;
    }
    sendJson(res, 404, envelope(
      'invalid_request_error',
      'not_found',
      'Unknown local provider route endpoint.',
    ));
  };

  return {
    async start() {
      if (server && baseUrl && routeToken) return { baseUrl, routeToken };
      if (startPromise) return startPromise;
      if (!reasoningCapsule && supportsReasoningCapsule(crypto)) {
        reasoningCapsule = createReasoningCapsule({ crypto });
      }
      startPromise = new Promise((resolve, reject) => {
        const http = requireImpl('http');
        const nextServer = http.createServer(handleLocalRequest);
        const onError = (error) => {
          nextServer.off('listening', onListening);
          server = null;
          baseUrl = '';
          routeToken = null;
          reasoningCapsule?.destroy();
          reasoningCapsule = null;
          reject(error);
        };
        const onListening = () => {
          nextServer.off('error', onError);
          const address = nextServer.address();
          server = nextServer;
          routeToken = generateRouteToken(crypto);
          baseUrl = `http://127.0.0.1:${address.port}/v1`;
          resolve({ baseUrl, routeToken });
        };
        nextServer.once('error', onError);
        nextServer.once('listening', onListening);
        nextServer.listen(0, '127.0.0.1');
      }).finally(() => { startPromise = null; });
      return startPromise;
    },

    async close() {
      if (startPromise) {
        try { await startPromise; } catch { return; }
      }
      if (!server) {
        routeToken = null;
        baseUrl = '';
        reasoningCapsule?.destroy();
        reasoningCapsule = null;
        return;
      }
      const closing = server;
      server = null;
      baseUrl = '';
      for (const context of [...contexts]) {
        destroyOnce(context);
        finishOnce(context);
        if (!context.res.writableEnded) context.res.end();
      }
      await new Promise((resolve) => closing.close(resolve));
      routeToken = null;
      reasoningCapsule?.destroy();
      reasoningCapsule = null;
    },
  };
}
