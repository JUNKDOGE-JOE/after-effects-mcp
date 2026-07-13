import { containsExactSecret, redactText, redactValue } from '../lib/exactSecretRedaction.js';
import {
  anthropicMessageToResponse,
  chatCompletionToMessages,
  messagesBodyToChatBody,
  messagesBodyToResponsesBody,
  responseToMessages,
  responsesBodyToMessagesBody,
} from '../lib/providerMessagesCodec.js';
import {
  createChatSseCollector,
  createMessagesSseCollector,
  createResponsesSseCollector,
  messagesSseEvents,
  responsesSseEvents,
} from '../lib/providerSseCodec.js';
import {
  collectCodexHeaders,
  filterUpstreamResponseHeaders,
  mergeUpstreamHeaders,
} from '../lib/providerHeaders.js';
import { createCodexResponsesRoute } from './codexResponsesRoute.js';
import {
  generateRouteToken,
  parseRouteToken,
  routeTokenMatches,
} from './providerRouteAuth.js';
import { createReasoningCapsule } from './reasoningCapsule.js';
import { requireCredentialFreeSse } from '../lib/providerSseSecretGuard.js';

const LOCAL_ORIGIN = 'http://127.0.0.1';
const PROTOCOLS = new Set(['responses', 'chat', 'messages']);
const DEFAULT_LIMITS = Object.freeze({
  requestBodyBytes: 16 * 1024 * 1024,
  responseBodyBytes: 16 * 1024 * 1024,
  errorBodyBytes: 64 * 1024,
  concurrent: 4,
  connectTimeoutMs: 15_000,
  totalTimeoutMs: 30 * 60_000,
});

function getCepRequire() {
  if (globalThis.window?.cep_node?.require) return globalThis.window.cep_node.require;
  if (globalThis.window?.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function resolvedLimits(overrides = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([name, maximum]) => {
    const value = Number(overrides[name]);
    return [name, Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.floor(value)) : maximum];
  }));
}

function envelope(type, code, message, extra = {}) {
  return { error: { type, code, message, ...extra } };
}

function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function writeSse(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

function conversionUnavailable(res, clientProtocol, upstreamProtocol, param = null) {
  sendJson(res, 501, envelope(
    'invalid_request_error',
    'provider_conversion_unsupported',
    'Cannot safely convert ' + clientProtocol + ' to ' + upstreamProtocol + '.',
    param ? { param } : {},
  ));
}

function parseLocalUrl(rawUrl) {
  const raw = String(rawUrl || '/');
  if (/\\|%5c|%2f|%00/i.test(raw)) throw Object.assign(new Error('Invalid local path.'), { code: 'invalid_path' });
  const url = new URL(raw, LOCAL_ORIGIN);
  if (url.origin !== LOCAL_ORIGIN || url.username || url.password || url.hash) {
    throw Object.assign(new Error('Invalid local path.'), { code: 'invalid_path' });
  }
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch {
    throw Object.assign(new Error('Invalid local path.'), { code: 'invalid_path' });
  }
  if (decoded.split('/').some((part) => part === '..' || part === '.')) {
    throw Object.assign(new Error('Invalid local path.'), { code: 'invalid_path' });
  }
  return url;
}

function readBody(req, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maximum) {
        fail(Object.assign(new Error('Request body is too large.'), {
          code: 'request_body_too_large',
          status: 413,
        }));
        req.destroy();
        return;
      }
      chunks.push(value);
    });
    req.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.once('error', fail);
  });
}

function requestEnvelope(buffer) {
  let body;
  try { body = JSON.parse(buffer.toString('utf8')); } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), {
      code: 'invalid_request_body',
      status: 400,
    });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Request body must be an object.'), {
      code: 'invalid_request_body',
      status: 400,
    });
  }
  const modelId = typeof body.model === 'string' ? body.model.trim() : '';
  if (!modelId) throw Object.assign(new Error('Request model is required.'), { code: 'invalid_model', status: 400 });
  return { body, modelId };
}

function providerEndpoint(apiRoot, suffix, search, allowInsecureHttp) {
  const root = new URL(String(apiRoot));
  if (root.username || root.password || root.search || root.hash) throw new Error('Invalid Provider API root.');
  const loopback = root.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(root.hostname);
  if (root.protocol !== 'https:' && !(loopback || allowInsecureHttp === true)) {
    throw new Error('Provider transport is not allowed.');
  }
  if (!['https:', 'http:'].includes(root.protocol)) throw new Error('Provider transport is not allowed.');
  const endpoint = new URL(root.toString());
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + suffix;
  endpoint.search = search || '';
  if (endpoint.origin !== root.origin) throw new Error('Provider endpoint origin changed.');
  return endpoint;
}

function oneHeader(rawHeaders, wanted) {
  const values = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === wanted) values.push(String(rawHeaders[index + 1]));
  }
  if (values.length > 1) throw Object.assign(new Error('Duplicate client header.'), { code: 'provider_header_duplicate' });
  const value = values[0];
  if (value !== undefined && (/[\r\n\0]/.test(value) || Buffer.byteLength(value, 'utf8') > 8192)) {
    throw Object.assign(new Error('Invalid client header.'), { code: 'provider_header_invalid_value' });
  }
  return value;
}

function nativeHeaders(req, profile, clientProtocol) {
  const headers = mergeUpstreamHeaders({
    rawHeaders: clientProtocol === 'responses' ? req.rawHeaders || [] : [],
    providerHeaders: profile.extraHeaders || [],
    auth: profile.auth || { kind: 'none' },
    contentType: 'application/json',
  });
  if (clientProtocol === 'messages') {
    headers['anthropic-version'] = oneHeader(req.rawHeaders || [], 'anthropic-version') || '2023-06-01';
    const beta = oneHeader(req.rawHeaders || [], 'anthropic-beta');
    if (beta) headers['anthropic-beta'] = beta;
  }
  return headers;
}

function profileSecrets(profile) {
  const values = [];
  if (profile?.auth?.kind === 'header') {
    const value = String(profile.auth.value || '');
    if (value) values.push(value);
    const match = value.match(/^(?:Bearer|Basic)\s+(.+)$/i);
    if (match?.[1]) values.push(match[1]);
  }
  for (const header of profile?.extraHeaders || []) {
    if (header?.value) values.push(String(header.value));
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function withoutSecretBearingHeaders(headers, secrets) {
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => (
    !containsExactSecret(String(value), secrets)
  )));
}

function sanitizedError(buffer, secrets) {
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { return 'Provider request failed.'; }
  const source = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const message = typeof source?.message === 'string' ? source.message : 'Provider request failed.';
  return redactText(message, secrets).replace(/[\r\n\0]+/g, ' ').slice(0, 256);
}

function headersWithoutRejectedAnthropicBetas(headers, buffer) {
  const current = headers['anthropic-beta'];
  if (typeof current !== 'string' || !current.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { return null; }
  const source = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const message = typeof source?.message === 'string' ? source.message : '';
  const match = message.match(
    /^Unexpected value\(s\)\s+(.+?)\s+for the `anthropic-beta` header(?:\.|$)/,
  );
  if (!match) return null;
  const token = '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}';
  const listPattern = new RegExp('^`' + token + '`(?:\\s*(?:,|and)\\s*`' + token + '`)*$');
  if (!listPattern.test(match[1])) return null;
  const rejected = [...match[1].matchAll(/`([A-Za-z0-9][A-Za-z0-9._:-]{0,127})`/g)]
    .map((entry) => entry[1]);
  if (rejected.length === 0 || rejected.length > 16) return null;
  const values = current.split(',').map((value) => value.trim()).filter(Boolean);
  const currentValues = new Set(values);
  if (!rejected.every((value) => currentValues.has(value))) return null;
  const rejectedValues = new Set(rejected);
  const remaining = values.filter((value) => !rejectedValues.has(value));
  const next = { ...headers };
  if (remaining.length > 0) next['anthropic-beta'] = remaining.join(', ');
  else delete next['anthropic-beta'];
  return next;
}

function createGate(maximum) {
  let active = 0;
  return {
    acquire() {
      if (active >= maximum) return false;
      active += 1;
      return true;
    },
    release() { active = Math.max(0, active - 1); },
  };
}

export function createUniversalProviderRoute({
  provider,
  resolveCapability,
  resolveRequestProfile,
  getModels = () => provider?.modelList?.models || provider?.probedModels || [],
  requireImpl = getCepRequire(),
  createUpstreamRequest,
  lookupImpl,
  createChatRoute = createCodexResponsesRoute,
  limits: limitOverrides,
  onAudit = () => {},
} = {}) {
  if (!provider || typeof provider !== 'object') throw new TypeError('provider is required');
  if (typeof resolveCapability !== 'function') throw new TypeError('resolveCapability is required');
  if (typeof resolveRequestProfile !== 'function') throw new TypeError('resolveRequestProfile is required');
  const crypto = requireImpl('crypto');
  const http = requireImpl('http');
  const bounded = resolvedLimits(limitOverrides);
  const gate = createGate(bounded.concurrent);
  const activeRequests = new Set();
  let server = null;
  let routeToken = null;
  let origin = '';
  let startPromise = null;
  let chatRoute = null;
  let chatRouteInfo = null;
  let reasoningCapsule = null;
  let responseSequence = 0;

  const capabilityFor = async ({ modelId, clientProtocol, feature = 'generate' }) => {
    const capability = await resolveCapability({ provider, modelId, clientProtocol, feature });
    if (!capability || capability.ok !== true || !PROTOCOLS.has(capability.upstreamProtocol)) {
      const error = new Error('No verified Provider route is available.');
      error.code = 'provider_route_unavailable';
      error.status = 501;
      throw error;
    }
    return capability;
  };

  const profileFor = (modelId, capability) => resolveRequestProfile(provider, {
    scope: 'model',
    modelId,
    protocol: capability.upstreamProtocol,
    apiRoot: capability.apiRoot,
    authChoice: capability.auth || capability.authChoice,
  });

  const nestedProfile = async (_provider, details = {}) => {
    const capability = await capabilityFor({
      modelId: details.modelId,
      clientProtocol: 'responses',
    });
    if (capability.upstreamProtocol !== 'chat') throw new Error('Provider route changed during request.');
    return profileFor(details.modelId, capability);
  };

  const begin = (req, res) => {
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
      upstream: null,
      finished: false,
      timer: null,
      finish: null,
    };
    context.finish = () => {
      if (context.finished) return false;
      context.finished = true;
      clearTimeout(context.timer);
      activeRequests.delete(context);
      gate.release();
      return true;
    };
    context.timer = setTimeout(() => {
      if (!context.finish()) return;
      try { context.upstream?.destroy(); } catch {}
      sendJson(res, 504, envelope(
        'provider_error',
        'provider_total_timeout',
        'Provider request exceeded the total time limit.',
      ));
    }, bounded.totalTimeoutMs);
    const abort = () => {
      if (!context.finish()) return;
      try { context.upstream?.destroy(); } catch {}
    };
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableEnded) abort(); });
    activeRequests.add(context);
    return context;
  };

  const convertRequest = (clientProtocol, upstreamProtocol, body, capability) => {
    const options = { openReasoning: reasoningCapsule?.open };
    let converted;
    if (clientProtocol === 'messages' && upstreamProtocol === 'chat') {
      converted = messagesBodyToChatBody(body, options);
      const tokenField = capability.compatibility?.tokenField;
      if (tokenField === 'max_completion_tokens' && Object.hasOwn(converted.body, 'max_tokens')) {
        converted.body.max_completion_tokens = converted.body.max_tokens;
        delete converted.body.max_tokens;
      }
    } else if (clientProtocol === 'messages' && upstreamProtocol === 'responses') {
      converted = messagesBodyToResponsesBody(body, options);
    } else if (clientProtocol === 'responses' && upstreamProtocol === 'messages') {
      converted = responsesBodyToMessagesBody(body, options);
    } else {
      throw Object.assign(new Error('Provider conversion is unavailable.'), {
        status: 501,
        code: 'provider_conversion_unsupported',
      });
    }
    return {
      body: converted.body,
      consumed: [...converted.consumed],
    };
  };

  const collectorFor = (protocol) => {
    const options = { maxFrameBytes: 1024 * 1024 };
    if (protocol === 'chat') return createChatSseCollector(options);
    if (protocol === 'responses') return createResponsesSseCollector(options);
    if (protocol === 'messages') return createMessagesSseCollector(options);
    throw new Error('Unsupported Provider protocol.');
  };

  const convertCompletion = (source, upstreamProtocol, clientProtocol) => {
    const options = { sealReasoning: reasoningCapsule?.seal };
    if (clientProtocol === 'messages' && upstreamProtocol === 'chat') {
      return chatCompletionToMessages(source, options);
    }
    if (clientProtocol === 'messages' && upstreamProtocol === 'responses') {
      return responseToMessages(source, options);
    }
    if (clientProtocol === 'responses' && upstreamProtocol === 'messages') {
      responseSequence += 1;
      return anthropicMessageToResponse(source, {
        id: 'resp_route_' + Date.now().toString(36) + '_' + responseSequence.toString(36),
        sealReasoning: reasoningCapsule?.seal,
      });
    }
    throw Object.assign(new Error('Provider conversion is unavailable.'), {
      status: 501,
      code: 'provider_conversion_unsupported',
    });
  };

  const writeConverted = ({ context, value, clientProtocol, stream, responseHeaders, secrets }) => {
    const safeValue = redactValue(value, secrets);
    if (!stream) {
      if (!context.finish()) return;
      sendJson(context.res, 200, safeValue, responseHeaders);
      return;
    }
    const events = clientProtocol === 'messages'
      ? messagesSseEvents(safeValue)
      : responsesSseEvents(safeValue);
    if (!context.finish()) return;
    context.res.writeHead(200, {
      ...responseHeaders,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': responseHeaders['cache-control'] || 'no-cache',
    });
    for (const [event, data] of events) writeSse(context.res, event, data);
    context.res.end();
  };

  const readConvertedResponse = ({
    context,
    upstream,
    responseHeaders,
    clientProtocol,
    upstreamProtocol,
    stream,
    modelId,
    consumed,
    secrets,
  }) => {
    const chunks = [];
    const collector = stream ? collectorFor(upstreamProtocol) : null;
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { upstream.destroy(); } catch {}
      if (!context.finish()) return;
      const status = Number(error?.status) || 502;
      const rawCode = String(error?.code || 'provider_conversion_failed');
      const code = containsExactSecret(rawCode, secrets) ? 'provider_conversion_failed' : rawCode;
      const message = redactText(
        error?.message || 'Provider response conversion failed.',
        secrets,
      );
      const rawParam = typeof error?.param === 'string' ? error.param : '';
      const param = rawParam && !containsExactSecret(rawParam, secrets)
        ? redactText(rawParam, secrets)
        : 'provider_response';
      sendJson(context.res, status, envelope(
        status === 501 || status === 400 ? 'invalid_request_error' : 'provider_error',
        code,
        message,
        error?.param ? { param } : {},
      ));
    };
    upstream.on('data', (chunk) => {
      if (settled) return;
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > bounded.responseBodyBytes) {
        fail(Object.assign(new Error('Provider response is too large.'), {
          status: 502,
          code: 'provider_response_too_large',
        }));
        return;
      }
      try {
        if (collector) collector.feed(value);
        else chunks.push(value);
      } catch (error) { fail(error); }
    });
    upstream.once('end', () => {
      if (settled) return;
      let source;
      let converted;
      try {
        if (collector) {
          const collected = collector.end();
          source = upstreamProtocol === 'messages' ? collected.message : collected;
        } else {
          source = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        converted = convertCompletion(source, upstreamProtocol, clientProtocol);
        writeConverted({ context, value: converted, clientProtocol, stream, responseHeaders, secrets });
        settled = true;
        onAudit({
          event: 'provider_route',
          modelId,
          clientProtocol,
          upstreamProtocol,
          conversion: clientProtocol + '-to-' + upstreamProtocol,
          consumed,
          outcome: 'pass',
        });
      } catch (error) { fail(error); }
    });
    upstream.once('error', () => fail(Object.assign(new Error('Provider response stream failed.'), {
      status: 502,
      code: 'provider_stream_error',
    })));
  };

  const nativeProxy = async ({
    context,
    capability,
    clientProtocol,
    suffix,
    search,
    payload,
    modelId,
    conversion = null,
    stream = false,
  }) => {
    let profile;
    let endpoint;
    let headers;
    let secrets;
    try {
      profile = await profileFor(modelId, capability);
      if (context.finished) return;
      endpoint = providerEndpoint(
        profile.apiRoot || capability.apiRoot || profile.baseUrl,
        suffix,
        search,
        profile.allowInsecureHttp,
      );
      headers = nativeHeaders(context.req, profile, clientProtocol);
      headers['content-length'] = String(payload.length);
      secrets = profileSecrets(profile);
    } catch {
      if (!context.finish()) return;
      sendJson(context.res, 502, envelope(
        'provider_configuration_error',
        'provider_configuration_error',
        'Provider request configuration is invalid.',
      ));
      return;
    }
    const requestOptions = {
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
    };
    if (lookupImpl) requestOptions.lookup = lookupImpl;
    const sendAttempt = (attemptHeaders, allowBetaRetry) => {
      let connected = false;
      let requestSettled = false;
      let request = null;
      const connectTimer = setTimeout(() => {
        if (connected || context.finished) return;
        request?.destroy();
      }, bounded.connectTimeoutMs);
      try {
        const transport = requireImpl(endpoint.protocol === 'http:' ? 'http' : 'https');
        const factory = createUpstreamRequest || transport.request.bind(transport);
        request = factory({ ...requestOptions, headers: attemptHeaders }, (upstream) => {
          connected = true;
          requestSettled = true;
          clearTimeout(connectTimer);
          if (context.finished) {
            upstream.destroy();
            return;
          }
          const status = Number(upstream.statusCode || 0);
          if (status >= 300 && status < 400) {
            upstream.resume();
            if (!context.finish()) return;
            sendJson(context.res, 502, envelope(
              'provider_error',
              'provider_redirect_blocked',
              'Provider redirects are not followed.',
            ));
            return;
          }
          const responseHeaders = withoutSecretBearingHeaders(
            filterUpstreamResponseHeaders(upstream.rawHeaders || []),
            secrets,
          );
          if (status >= 400) {
            const chunks = [];
            let bytes = 0;
            let responseSettled = false;
            upstream.on('data', (chunk) => {
              const value = Buffer.from(chunk);
              const remaining = bounded.errorBodyBytes - bytes;
              if (remaining > 0) chunks.push(value.subarray(0, remaining));
              bytes += value.length;
              if (bytes > bounded.errorBodyBytes) upstream.destroy();
            });
            const finishError = () => {
              if (responseSettled || context.finished) return;
              responseSettled = true;
              const errorBody = Buffer.concat(chunks);
              const retryHeaders = allowBetaRetry && status === 400
                ? headersWithoutRejectedAnthropicBetas(attemptHeaders, errorBody)
                : null;
              if (retryHeaders) {
                onAudit({
                  event: 'provider_route_compat_retry',
                  modelId,
                  clientProtocol,
                  upstreamProtocol: capability.upstreamProtocol,
                  compatibility: 'anthropic-beta-rejected-values',
                  outcome: 'retry',
                });
                sendAttempt(retryHeaders, false);
                return;
              }
              if (!context.finish()) return;
              sendJson(
                context.res,
                status >= 400 && status < 500 ? status : 502,
                envelope(
                  'provider_error',
                  'provider_error',
                  sanitizedError(errorBody, profileSecrets(profile)),
                ),
                responseHeaders,
              );
            };
            upstream.once('end', finishError);
            upstream.once('error', finishError);
            return;
          }
          if (conversion) {
            readConvertedResponse({
              context,
              upstream,
              responseHeaders,
              clientProtocol: conversion.clientProtocol,
              upstreamProtocol: capability.upstreamProtocol,
              stream: conversion.stream,
              modelId,
              consumed: conversion.consumed,
              secrets,
            });
            return;
          }
          if (!stream) {
            const chunks = [];
            let bytes = 0;
            let settled = false;
            const failNative = () => {
              if (settled || context.finished) return;
              settled = true;
              try { upstream.destroy(); } catch {}
              if (!context.finish()) return;
              sendJson(context.res, 502, envelope(
                'provider_error',
                'provider_response_invalid',
                'Provider response is invalid.',
              ));
            };
            upstream.on('data', (chunk) => {
              if (settled) return;
              const value = Buffer.from(chunk);
              bytes += value.length;
              if (bytes > bounded.responseBodyBytes) {
                failNative();
                return;
              }
              chunks.push(value);
            });
            upstream.once('end', () => {
              if (settled || context.finished) return;
              let safeValue;
              try {
                safeValue = redactValue(JSON.parse(Buffer.concat(chunks).toString('utf8')), secrets);
              } catch {
                failNative();
                return;
              }
              settled = true;
              if (!context.finish()) return;
              context.res.writeHead(status || 200, responseHeaders);
              context.res.end(JSON.stringify(safeValue));
              onAudit({
                event: 'provider_route',
                modelId,
                clientProtocol,
                upstreamProtocol: capability.upstreamProtocol,
                conversion: 'native',
                outcome: 'pass',
              });
            });
            upstream.once('error', failNative);
            return;
          }
          const chunks = [];
          let bytes = 0;
          let settled = false;
          const failNativeStream = (error) => {
            if (settled || context.finished) return;
            settled = true;
            try { upstream.destroy(); } catch {}
            if (!context.finish()) return;
            sendJson(context.res, Number(error?.status) || 502, envelope(
              'provider_error',
              error?.code || 'provider_stream_error',
              error?.message || 'Provider response stream failed.',
            ));
          };
          upstream.on('data', (chunk) => {
            if (settled || context.finished) return;
            const value = Buffer.from(chunk);
            bytes += value.length;
            if (bytes > bounded.responseBodyBytes) {
              failNativeStream(Object.assign(new Error('Provider response is too large.'), {
                status: 502,
                code: 'provider_response_too_large',
              }));
              return;
            }
            chunks.push(value);
          });
          upstream.once('end', () => {
            if (settled || context.finished) return;
            const transcript = Buffer.concat(chunks);
            try {
              requireCredentialFreeSse(transcript, secrets, { maxFrameBytes: 1024 * 1024 });
            } catch (error) {
              failNativeStream(error);
              return;
            }
            settled = true;
            if (!context.finish()) return;
            context.res.writeHead(status || 200, responseHeaders);
            context.res.end(transcript);
            onAudit({
              event: 'provider_route',
              modelId,
              clientProtocol,
              upstreamProtocol: capability.upstreamProtocol,
              conversion: 'native',
              outcome: 'pass',
            });
          });
          upstream.once('error', () => {
            failNativeStream(Object.assign(new Error('Provider response stream failed.'), {
              status: 502,
              code: 'provider_stream_error',
            }));
          });
        });
        context.upstream = request;
        request.once('error', () => {
          clearTimeout(connectTimer);
          if (requestSettled || !context.finish()) return;
          sendJson(context.res, 502, envelope(
            'provider_error',
            'provider_error',
            'Provider request failed.',
          ));
        });
        request.end(payload);
      } catch {
        clearTimeout(connectTimer);
        if (!context.finish()) return;
        sendJson(context.res, 502, envelope(
          'provider_error',
          'provider_error',
          'Provider request failed.',
        ));
      }
    };
    sendAttempt(headers, true);
  };

  const forwardChatFacade = ({ context, payload, modelId }) => {
    const endpoint = new URL('responses', chatRouteInfo.baseUrl.replace(/\/+$/, '') + '/');
    const forwarded = Object.fromEntries(
      collectCodexHeaders(context.req.rawHeaders || []).map((header) => [header.name, header.value]),
    );
    forwarded['content-type'] = 'application/json';
    forwarded['content-length'] = String(payload.length);
    forwarded['x-ae-mcp-route-token'] = chatRouteInfo.routeToken;
    const request = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: forwarded,
    }, (response) => {
      if (context.finished) {
        response.destroy();
        return;
      }
      context.res.writeHead(
        response.statusCode || 502,
        filterUpstreamResponseHeaders(response.rawHeaders || []),
      );
      response.on('data', (chunk) => { if (!context.finished) context.res.write(chunk); });
      response.once('end', () => {
        if (!context.finish()) return;
        context.res.end();
        onAudit({
          event: 'provider_route',
          modelId,
          clientProtocol: 'responses',
          upstreamProtocol: 'chat',
          conversion: 'responses-to-chat',
          outcome: 'pass',
        });
      });
      response.once('error', () => {
        if (!context.finish()) return;
        context.res.destroy();
      });
    });
    context.upstream = request;
    request.once('error', () => {
      if (!context.finish()) return;
      sendJson(context.res, 502, envelope(
        'provider_error',
        'provider_error',
        'Local Provider facade failed.',
      ));
    });
    request.end(payload);
  };

  const handleGenerate = async (req, res, localUrl, clientProtocol) => {
    const context = begin(req, res);
    if (!context) return;
    let payload;
    let body;
    let modelId;
    try {
      payload = await readBody(req, bounded.requestBodyBytes);
      ({ body, modelId } = requestEnvelope(payload));
    } catch (error) {
      if (!context.finish()) return;
      sendJson(
        res,
        Number(error?.status) || 400,
        envelope(
          'invalid_request_error',
          error?.code || 'invalid_request_body',
          error?.message || 'Request body is invalid.',
        ),
      );
      return;
    }
    let capability;
    try {
      capability = await capabilityFor({ modelId, clientProtocol });
    } catch (error) {
      if (!context.finish()) return;
      sendJson(
        res,
        Number(error?.status) || 501,
        envelope(
          'invalid_request_error',
          error?.code || 'provider_route_unavailable',
          error?.message || 'No verified Provider route is available.',
        ),
      );
      return;
    }
    if (capability.upstreamProtocol === clientProtocol) {
      await nativeProxy({
        context,
        capability,
        clientProtocol,
        suffix: clientProtocol === 'responses' ? '/responses' : '/messages',
        search: clientProtocol === 'messages' ? localUrl.search : '',
        payload,
        modelId,
        stream: body.stream === true,
      });
      return;
    }
    if (clientProtocol === 'responses' && capability.upstreamProtocol === 'chat') {
      forwardChatFacade({ context, payload, modelId });
      return;
    }
    let converted;
    try {
      converted = convertRequest(clientProtocol, capability.upstreamProtocol, body, capability);
    } catch (error) {
      if (!context.finish()) return;
      const status = Number(error?.status) || 501;
      sendJson(res, status, envelope(
        'invalid_request_error',
        error?.code || 'provider_conversion_unsupported',
        error?.message || 'Provider conversion is unavailable.',
        error?.param ? { param: error.param } : {},
      ));
      return;
    }
    const upstreamProtocol = capability.upstreamProtocol;
    await nativeProxy({
      context,
      capability,
      clientProtocol: upstreamProtocol,
      suffix: upstreamProtocol === 'responses'
        ? '/responses'
        : upstreamProtocol === 'messages' ? '/messages' : '/chat/completions',
      search: '',
      payload: Buffer.from(JSON.stringify(converted.body), 'utf8'),
      modelId,
      conversion: {
        clientProtocol,
        stream: converted.body.stream === true,
        consumed: converted.consumed,
      },
    });
  };

  const handleFeature = async (req, res, localUrl, feature, clientProtocol, suffix) => {
    const context = begin(req, res);
    if (!context) return;
    let payload;
    let modelId;
    try {
      payload = await readBody(req, bounded.requestBodyBytes);
      ({ modelId } = requestEnvelope(payload));
    } catch (error) {
      if (!context.finish()) return;
      sendJson(
        res,
        Number(error?.status) || 400,
        envelope(
          'invalid_request_error',
          error?.code || 'invalid_request_body',
          error?.message || 'Request body is invalid.',
        ),
      );
      return;
    }
    const unsupportedCode = feature === 'compact'
      ? 'provider_compaction_unsupported'
      : 'provider_count_tokens_unsupported';
    let capability;
    try {
      capability = await capabilityFor({ modelId, clientProtocol, feature });
    } catch (error) {
      if (!context.finish()) return;
      sendJson(res, 501, envelope(
        'invalid_request_error',
        unsupportedCode,
        'Provider ' + feature + ' is unavailable for this model.',
      ));
      return;
    }
    if (capability.upstreamProtocol !== clientProtocol
      || capability.features?.[feature] !== 'supported') {
      if (!context.finish()) return;
      sendJson(res, 501, envelope(
        'invalid_request_error',
        unsupportedCode,
        'Provider ' + feature + ' is unavailable for this model.',
      ));
      return;
    }
    await nativeProxy({
      context,
      capability,
      clientProtocol,
      suffix,
      search: localUrl.search,
      payload,
      modelId,
    });
  };

  const handleModels = (res) => {
    const data = (getModels() || []).map((entry) => ({
      id: String(entry?.id || '').trim(),
      object: 'model',
      owned_by: 'custom-provider',
    })).filter((entry) => entry.id);
    sendJson(res, 200, { object: 'list', data });
  };

  const handleLocalRequest = (req, res) => {
    const candidate = parseRouteToken(req.rawHeaders || []);
    if (!candidate || !routeToken || !routeTokenMatches(candidate, routeToken, crypto)) {
      sendJson(res, 401, envelope(
        'authentication_error',
        'invalid_route_token',
        'Invalid local provider route token.',
      ));
      return;
    }
    let localUrl;
    try { localUrl = parseLocalUrl(req.url); } catch (error) {
      sendJson(res, 400, envelope(
        'invalid_request_error',
        error.code || 'invalid_path',
        error.message,
      ));
      return;
    }
    const method = String(req.method || '').toUpperCase();
    const pathname = localUrl.pathname;
    if (pathname === '/v1/models' && method === 'GET') {
      handleModels(res);
      return;
    }
    if (pathname === '/v1/responses' && method === 'POST') {
      void handleGenerate(req, res, localUrl, 'responses');
      return;
    }
    if (pathname === '/v1/messages' && method === 'POST') {
      void handleGenerate(req, res, localUrl, 'messages');
      return;
    }
    if (pathname === '/v1/responses/compact' && method === 'POST') {
      void handleFeature(req, res, localUrl, 'compact', 'responses', '/responses/compact');
      return;
    }
    if (pathname === '/v1/messages/count_tokens' && method === 'POST') {
      void handleFeature(req, res, localUrl, 'countTokens', 'messages', '/messages/count_tokens');
      return;
    }
    const known = [
      '/v1/models',
      '/v1/responses',
      '/v1/messages',
      '/v1/responses/compact',
      '/v1/messages/count_tokens',
    ];
    if (known.includes(pathname)) {
      sendJson(res, 405, envelope(
        'invalid_request_error',
        'method_not_allowed',
        'Method ' + method + ' is not allowed for ' + pathname + '.',
      ));
      return;
    }
    sendJson(res, 404, envelope(
      'invalid_request_error',
      'not_found',
      'Unknown local Provider route endpoint.',
    ));
  };

  function routeInfo() {
    return {
      origin,
      openaiBaseUrl: origin + '/v1',
      anthropicBaseUrl: origin,
      baseUrl: origin + '/v1',
      routeToken,
    };
  }

  return {
    async start() {
      if (server && routeToken && origin) return routeInfo();
      if (startPromise) return startPromise;
      startPromise = (async () => {
        reasoningCapsule = createReasoningCapsule({ crypto });
        chatRoute = createChatRoute({
          provider,
          resolveRequestProfile: nestedProfile,
          requireImpl,
          createUpstreamRequest,
          lookupImpl,
        });
        chatRouteInfo = await chatRoute.start();
        const next = http.createServer(handleLocalRequest);
        await new Promise((resolve, reject) => {
          next.once('error', reject);
          next.listen(0, '127.0.0.1', resolve);
        });
        server = next;
        routeToken = generateRouteToken(crypto);
        origin = 'http://127.0.0.1:' + server.address().port;
        return routeInfo();
      })().catch(async (error) => {
        await chatRoute?.close().catch(() => {});
        chatRoute = null;
        chatRouteInfo = null;
        reasoningCapsule?.destroy();
        reasoningCapsule = null;
        throw error;
      }).finally(() => { startPromise = null; });
      return startPromise;
    },

    async close() {
      if (startPromise) await startPromise.catch(() => {});
      for (const context of [...activeRequests]) {
        try { context.upstream?.destroy(); } catch {}
        if (context.finish()) context.res.end();
      }
      const closing = server;
      server = null;
      routeToken = null;
      origin = '';
      if (closing) await new Promise((resolve) => closing.close(resolve));
      await chatRoute?.close();
      chatRoute = null;
      chatRouteInfo = null;
      reasoningCapsule?.destroy();
      reasoningCapsule = null;
    },
  };
}
