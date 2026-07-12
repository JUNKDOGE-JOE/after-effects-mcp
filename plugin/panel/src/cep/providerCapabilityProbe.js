import { probeProviderModels } from './modelProbe.js';
import { chatErrorRequestsMaxCompletionTokens } from '../lib/codexResponsesCodec.js';
import { buildProtocolAuthCandidates } from '../lib/providerProbeAuth.js';
import { buildProviderEndpointCandidates } from '../lib/providerUrl.js';
import { normalizeBaseUrl } from '../lib/providerProfile.js';
import {
  createChatSseCollector,
  createMessagesSseCollector,
  createResponsesSseCollector,
} from '../lib/providerSseCodec.js';

const OUTPUT_BUDGETS = Object.freeze([16, 64, 128]);
const TOOL_OUTPUT_BUDGETS = Object.freeze([...OUTPUT_BUDGETS, 256, 512]);
const MAX_RESPONSE_BYTES = 512 * 1024;
const SUCCESS_TTL_MS = 86_400_000;
const TRANSIENT_TTL_MS = 60_000;
const INVALID_TTL_MS = 300_000;
const PROTOCOL_ORDER = Object.freeze(['responses', 'messages', 'chat']);
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const ALWAYS_TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 504]);
const UNSUPPORTED_CODES = new Set([
  'convert_request_failed',
  'not_implemented',
  'not_supported',
  'unsupported_endpoint',
  'unsupported_operation',
]);

function getCepRequire() {
  if (globalThis.window?.cep_node?.require) return globalThis.window.cep_node.require;
  if (globalThis.window?.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
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

function sseTerminalObserved(protocol, value) {
  const normalized = String(value || '').replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  if (!normalized.endsWith('\n\n')) frames.pop();
  for (const frame of frames) {
    let event = '';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join('\n').trim();
    if (protocol === 'chat' && data === '[DONE]') return true;
    let parsed = null;
    try { parsed = data ? JSON.parse(data) : null; } catch {}
    const type = String(parsed?.type || event || '');
    if (type === 'error' || parsed?.error) return true;
    if (protocol === 'responses' && ['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
      return true;
    }
    if (protocol === 'messages' && type === 'message_stop') return true;
    if (protocol === 'chat' && Array.isArray(parsed?.choices)
        && parsed.choices.some((choice) => typeof choice?.finish_reason === 'string' && choice.finish_reason)) {
      return true;
    }
  }
  return false;
}

function utf8ByteLength(value) {
  const BufferImpl = globalThis.Buffer || getCepRequire()('buffer')?.Buffer;
  if (!BufferImpl || typeof BufferImpl.byteLength !== 'function') {
    throw new Error('provider request setup failed');
  }
  return BufferImpl.byteLength(value, 'utf8');
}

function defaultRequest({ url, method, headers, body, timeoutMs, streamProtocol }) {
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
    const requestHeaders = { ...headers };
    if (payload !== null && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'content-length')) {
      requestHeaders['content-length'] = String(utf8ByteLength(payload));
    }
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
      headers: requestHeaders,
      agent: false,
    }, (res) => {
      let responseBody = '';
      let responseBytes = 0;
      res.on('data', (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          try { req.destroy(); } catch {}
          finish(reject, new Error('provider response too large'));
          return;
        }
        responseBody += String(chunk);
        if (['responses', 'chat', 'messages'].includes(streamProtocol)
            && sseTerminalObserved(streamProtocol, responseBody)) {
          finish(resolve, {
            status: res.statusCode || 0,
            headers: normalizedHeaders(res.headers),
            body: responseBody,
          });
          try { res.destroy(); } catch {}
          try { req.destroy(); } catch {}
        }
      });
      res.on('end', () => finish(resolve, {
        status: res.statusCode || 0,
        headers: normalizedHeaders(res.headers),
        body: responseBody,
      }));
    });
    req.on('error', () => finish(reject, new Error('provider request failed')));
    if (req.setTimeout) {
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(); } catch {}
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

function errorFacts(result) {
  const parsed = parsedJson(result);
  const raw = parsed?.error && typeof parsed.error === 'object'
    ? parsed.error
    : parsed || {};
  return {
    code: String(raw.code || raw.type || '').trim().toLowerCase(),
    param: String(raw.param || '').trim().toLowerCase(),
    message: String(raw.message || parsed?.message || '').trim().toLowerCase(),
  };
}

function explicitlyUnsupported(result) {
  const facts = errorFacts(result);
  if (UNSUPPORTED_CODES.has(facts.code)) return true;
  return /\bconvert_request_failed\b|\bnot implemented\b|\boperation is unsupported\b|\bendpoint\b.{0,32}\bnot supported\b/.test(facts.message);
}

function modelRejected(result) {
  const facts = errorFacts(result);
  return facts.param === 'model'
    || /\bmodel\b.{0,32}\b(?:not found|does not exist|unavailable|unsupported)\b/.test(facts.message);
}

function pathRejected(result) {
  if (result.redirected || (result.status >= 300 && result.status < 400)) return true;
  return [404, 405, 501].includes(result.status) && !modelRejected(result);
}

function authenticationRejected(result) {
  return result.status === 401 || result.status === 403;
}

function developerRoleRejected(result) {
  if (![400, 422, 500].includes(result.status)) return false;
  const facts = errorFacts(result);
  const text = `${facts.code} ${facts.param} ${facts.message}`;
  const roleContext = facts.param.includes('role')
    || /\brole\b.{0,80}\bdeveloper\b|\bunknown variant\b.{0,48}\bdeveloper\b|\bdeveloper\b.{0,80}\b(?:role|unknown variant|expected one of)\b/.test(text);
  return roleContext
    && /(^|[^a-z])developer([^a-z]|$)/.test(text)
    && (/\bunknown variant\b|\bexpected one of\b|\b(?:unsupported|invalid|disallowed|forbidden)\b|\bnot (?:supported|allowed|accepted|permitted)\b/.test(text));
}

const AGENT_FEATURE_NAMES = Object.freeze([
  'stream',
  'terminal',
  'tools',
  'compact',
  'continuation',
  'namespaceTools',
  'reasoningReplay',
  'countTokens',
]);

function unknownAgentFeatures() {
  return Object.fromEntries(AGENT_FEATURE_NAMES.map((name) => [name, 'unknown']));
}

function unknownAgentFeatureEvidence() {
  return Object.fromEntries(AGENT_FEATURE_NAMES.map((name) => [name, 'not-probed']));
}

function featureResult(status, evidence) {
  return { status, evidence };
}

function setFeature(capability, name, result) {
  return {
    ...capability,
    agentFeatures: { ...capability.agentFeatures, [name]: result.status },
    agentFeatureEvidence: { ...capability.agentFeatureEvidence, [name]: result.evidence },
  };
}

function baseCapability(protocol) {
  return {
    protocol,
    support: 'invalid',
    apiRoot: null,
    authScheme: null,
    schema: { nonStreaming: 'not-tested', evidence: 'not-tested' },
    stream: { support: 'not-probed', terminal: null, evidence: 'not-probed' },
    tool: { support: 'not-probed', evidence: 'not-probed' },
    agentFeatures: unknownAgentFeatures(),
    agentFeatureEvidence: unknownAgentFeatureEvidence(),
    terminal: { kind: null, budgetLimited: false },
    compatibility: {
      instructionRole: protocol === 'chat' ? 'developer' : protocol === 'messages' ? 'system' : null,
      tokenField: protocol === 'responses' ? 'max_output_tokens' : 'max_tokens',
      outputBudget: null,
    },
    errorClass: null,
    ttl: {
      class: 'invalid',
      maxAgeMs: INVALID_TTL_MS,
      evidence: 'not-tested',
      invalidatedBy: ['provider-config', 'auth-profile', 'model-inventory'],
    },
  };
}

function withEndpoint(capability, endpoint, authScheme) {
  return {
    ...capability,
    apiRoot: endpoint?.apiRoot?.toString().replace(/\/$/, '') || null,
    authScheme: authScheme || null,
  };
}

function supportedCapability(protocol, endpoint, authScheme, schema, compatibility) {
  const capability = withEndpoint(baseCapability(protocol), endpoint, authScheme);
  return {
    ...capability,
    support: 'supported',
    schema: { nonStreaming: 'valid', evidence: schema.evidence },
    terminal: { kind: schema.terminal, budgetLimited: schema.budgetLimited },
    compatibility: { ...capability.compatibility, ...compatibility },
    ttl: {
      class: 'success',
      maxAgeMs: SUCCESS_TTL_MS,
      evidence: schema.budgetLimited ? 'verified-valid-budget-terminal' : 'verified-success-schema',
      invalidatedBy: ['provider-config', 'auth-profile', 'model-inventory'],
    },
  };
}

function failedCapability(protocol, endpoint, authScheme, errorClass, evidence) {
  const capability = withEndpoint(baseCapability(protocol), endpoint, authScheme);
  let support = 'invalid';
  let ttlClass = 'invalid';
  let maxAgeMs = INVALID_TTL_MS;
  if (errorClass === 'authentication') {
    support = 'authentication';
    ttlClass = 'authentication';
    maxAgeMs = 0;
  } else if (errorClass === 'network' || errorClass === 'rate-limited' || errorClass === 'upstream-transient') {
    support = 'transient';
    ttlClass = 'transient';
    maxAgeMs = TRANSIENT_TTL_MS;
  } else if (errorClass === 'endpoint-unsupported' || errorClass === 'protocol-unsupported' || errorClass === 'model-unsupported') {
    support = 'unsupported';
    ttlClass = 'unsupported';
    maxAgeMs = null;
  }
  return {
    ...capability,
    support,
    schema: { nonStreaming: errorClass === 'invalid-schema' ? 'invalid' : 'not-tested', evidence },
    errorClass,
    ttl: {
      class: ttlClass,
      maxAgeMs,
      evidence,
      invalidatedBy: ['provider-config', 'auth-profile', 'model-inventory'],
    },
  };
}

function usableResponsesOutput(output) {
  return output.some((item) => item && item.type === 'message' && Array.isArray(item.content)
    && item.content.some((part) => part && part.type === 'output_text' && typeof part.text === 'string' && part.text.length > 0));
}

function responsesSchema(result) {
  const parsed = parsedJson(result);
  if (result.status !== 200 || !parsed || parsed.object !== 'response'
      || typeof parsed.id !== 'string' || !parsed.id || !Array.isArray(parsed.output)
      || !['completed', 'incomplete', 'failed'].includes(parsed.status)) return null;
  if (parsed.status === 'completed' && !usableResponsesOutput(parsed.output)) return null;
  if (parsed.status === 'failed') return { failed: true, terminal: 'failed', budgetLimited: false, evidence: 'responses-failed-schema' };
  const budgetLimited = parsed.status === 'incomplete'
    && parsed.incomplete_details?.reason === 'max_output_tokens';
  return {
    terminal: parsed.status,
    budgetLimited,
    evidence: parsed.status === 'incomplete' ? 'responses-incomplete-schema' : 'responses-success-schema',
  };
}

function chatSchema(result) {
  const parsed = parsedJson(result);
  if (result.status !== 200 || !parsed || parsed.object !== 'chat.completion'
      || typeof parsed.id !== 'string' || !parsed.id || !Array.isArray(parsed.choices)
      || parsed.choices.length === 0) return null;
  const choice = parsed.choices[0];
  if (!choice || !Number.isInteger(choice.index) || !choice.message || choice.message.role !== 'assistant') return null;
  if (!['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(choice.finish_reason)) return null;
  const content = choice.message.content;
  const hasContent = typeof content === 'string' && content.length > 0;
  const hasTool = Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0;
  if (!hasContent && !hasTool && choice.finish_reason !== 'length' && choice.finish_reason !== 'content_filter') return null;
  return {
    terminal: choice.finish_reason,
    budgetLimited: choice.finish_reason === 'length',
    evidence: choice.finish_reason === 'length' ? 'chat-length-schema' : 'chat-success-schema',
  };
}

function messagesSchema(result) {
  const parsed = parsedJson(result);
  if (result.status !== 200 || !parsed || parsed.type !== 'message'
      || typeof parsed.id !== 'string' || !parsed.id || parsed.role !== 'assistant'
      || typeof parsed.model !== 'string' || !parsed.model || !Array.isArray(parsed.content)
      || !['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'].includes(parsed.stop_reason)) return null;
  const hasContent = parsed.content.some((part) => part && (
    part.type === 'tool_use'
    || (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
  ));
  if (!hasContent && parsed.stop_reason !== 'max_tokens') return null;
  return {
    terminal: parsed.stop_reason,
    budgetLimited: parsed.stop_reason === 'max_tokens',
    evidence: parsed.stop_reason === 'max_tokens' ? 'messages-max-tokens-schema' : 'messages-success-schema',
  };
}

function requestBody(protocol, modelId, budget, compatibility = {}) {
  if (protocol === 'responses') {
    return { model: modelId, input: 'OK', max_output_tokens: budget, stream: false };
  }
  if (protocol === 'messages') {
    return {
      model: modelId,
      system: 'Reply only OK.',
      messages: [{ role: 'user', content: 'OK' }],
      max_tokens: budget,
      stream: false,
    };
  }
  const role = compatibility.instructionRole || 'developer';
  const tokenField = compatibility.tokenField || 'max_tokens';
  return {
    model: modelId,
    messages: [
      { role, content: 'Reply only OK.' },
      { role: 'user', content: 'OK' },
    ],
    [tokenField]: budget,
    stream: false,
  };
}

function featureEndpoint(endpoint, suffix, id) {
  const apiRoot = new URL(endpoint.apiRoot.toString());
  apiRoot.pathname = apiRoot.pathname.replace(/\/+$/, '');
  const url = new URL(apiRoot.toString());
  url.pathname = apiRoot.pathname + suffix;
  return { id: `${endpoint.id}-${id}`, apiRoot, url };
}

function featureFailure(result, evidence) {
  if (!result || result.network || result.status === 0) {
    return featureResult('unknown', `${evidence}-network`);
  }
  if (authenticationRejected(result)) {
    return featureResult('unknown', `${evidence}-authentication`);
  }
  if (ALWAYS_TRANSIENT_STATUSES.has(result.status)) {
    return featureResult('unknown', `${evidence}-transient`);
  }
  if (result.status === 503) {
    if (modelRejected(result) || explicitlyUnsupported(result)) {
      return featureResult('unsupported', `${evidence}-rejected`);
    }
    return featureResult('unknown', `${evidence}-transient`);
  }
  return featureResult('unsupported', `${evidence}-rejected`);
}

function streamCollector(protocol) {
  if (protocol === 'responses') return createResponsesSseCollector();
  if (protocol === 'messages') return createMessagesSseCollector();
  return createChatSseCollector();
}

async function probeStreamFeature({
  protocol,
  modelId,
  endpoint,
  authCandidate,
  compatibility,
  requestImpl,
  timeoutMs,
  tried,
}) {
  const body = {
    ...requestBody(protocol, modelId, OUTPUT_BUDGETS[0], compatibility),
    stream: true,
  };
  const result = await requestStep({
    step: `${protocol}-stream`,
    endpoint,
    authCandidate,
    body,
    requestImpl,
    timeoutMs,
    tried,
  });
  if (result.status !== 200 || !String(result.headers?.['content-type'] || '').toLowerCase().includes('text/event-stream')) {
    return featureFailure(result, `${protocol}-stream`);
  }
  try {
    const collector = streamCollector(protocol);
    collector.feed(result.body);
    collector.end();
    return featureResult('supported', `${protocol}-stream-terminal-valid`);
  } catch {
    return featureResult('unsupported', `${protocol}-stream-terminal-invalid`);
  }
}

function toolChoiceCandidates(protocol) {
  if (protocol === 'messages') {
    return [
      { id: 'named', value: { type: 'tool', name: 'noop' } },
      { id: 'any', value: { type: 'any' } },
      { id: 'auto', value: { type: 'auto' } },
      { id: 'implicit', value: undefined },
    ];
  }
  const named = protocol === 'responses'
    ? { type: 'function', name: 'noop' }
    : { type: 'function', function: { name: 'noop' } };
  return [
    { id: 'named', value: named },
    { id: 'required', value: 'required' },
    { id: 'auto', value: 'auto' },
    { id: 'implicit', value: undefined },
  ];
}

function toolRequestBody(protocol, modelId, compatibility, budget, toolChoice) {
  const parameters = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  };
  const toolChoiceField = toolChoice === undefined ? {} : { tool_choice: toolChoice };
  if (protocol === 'responses') {
    return {
      model: modelId,
      input: 'Call the noop tool once with value "ok".',
      max_output_tokens: budget,
      stream: false,
      tools: [{ type: 'function', name: 'noop', description: 'Compatibility probe.', parameters }],
      ...toolChoiceField,
    };
  }
  if (protocol === 'messages') {
    return {
      model: modelId,
      system: 'Call the requested tool exactly once.',
      messages: [{ role: 'user', content: 'Call noop with value "ok".' }],
      max_tokens: budget,
      stream: false,
      tools: [{ name: 'noop', description: 'Compatibility probe.', input_schema: parameters }],
      ...toolChoiceField,
    };
  }
  const role = compatibility.instructionRole || 'developer';
  const tokenField = compatibility.tokenField || 'max_tokens';
  return {
    model: modelId,
    messages: [
      { role, content: 'Call the requested tool exactly once.' },
      { role: 'user', content: 'Call noop with value "ok".' },
    ],
    [tokenField]: budget,
    stream: false,
    tools: [{ type: 'function', function: { name: 'noop', description: 'Compatibility probe.', parameters } }],
    ...toolChoiceField,
  };
}

function jsonObjectText(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function validToolResponse(protocol, result) {
  const parsed = parsedJson(result);
  if (result.status !== 200 || !parsed) return false;
  if (protocol === 'responses') {
    return parsed.object === 'response' && Array.isArray(parsed.output)
      && parsed.output.some((item) => item?.type === 'function_call'
        && item.name === 'noop' && jsonObjectText(item.arguments));
  }
  if (protocol === 'messages') {
    return parsed.type === 'message' && Array.isArray(parsed.content)
      && parsed.content.some((item) => item?.type === 'tool_use'
        && item.name === 'noop' && item.input && typeof item.input === 'object' && !Array.isArray(item.input));
  }
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  return parsed.object === 'chat.completion' && Array.isArray(choice?.message?.tool_calls)
    && choice.message.tool_calls.some((item) => item?.type === 'function'
      && item.function?.name === 'noop' && jsonObjectText(item.function.arguments));
}

function retryToolBudget(protocol, schema) {
  return schema?.budgetLimited === true
    || (protocol === 'chat' && schema?.terminal === 'content_filter');
}

async function probeToolFeature({
  protocol,
  modelId,
  endpoint,
  authCandidate,
  compatibility,
  requestImpl,
  timeoutMs,
  tried,
}) {
  let result = null;
  for (const candidate of toolChoiceCandidates(protocol)) {
    for (const budget of TOOL_OUTPUT_BUDGETS) {
      for (let networkAttempt = 0; networkAttempt < 2; networkAttempt += 1) {
        result = await requestStep({
          step: candidate.id === 'named' ? `${protocol}-tool` : `${protocol}-tool-${candidate.id}`,
          endpoint,
          authCandidate,
          body: toolRequestBody(protocol, modelId, compatibility, budget, candidate.value),
          requestImpl,
          timeoutMs,
          tried,
        });
        if (!(result?.network || result?.status === 0)) break;
      }
      if (validToolResponse(protocol, result)) {
        return featureResult('supported', `${protocol}-tool-call-valid`);
      }
      const failure = featureFailure(result, `${protocol}-tool`);
      if (failure.status === 'unknown') return failure;
      const schema = protocol === 'responses'
        ? responsesSchema(result)
        : protocol === 'messages' ? messagesSchema(result) : chatSchema(result);
      if (!retryToolBudget(protocol, schema)) break;
    }
    if (result?.status !== 200 && ![400, 422].includes(result?.status)) break;
  }
  return featureFailure(result, `${protocol}-tool`);
}

async function enrichAgentFeatures({
  capability,
  protocol,
  modelId,
  endpoint,
  authCandidate,
  requestImpl,
  timeoutMs,
  tried,
}) {
  const compatibility = capability.compatibility || {};
  const stream = await probeStreamFeature({
    protocol,
    modelId,
    endpoint,
    authCandidate,
    compatibility,
    requestImpl,
    timeoutMs,
    tried,
  });
  let next = setFeature(capability, 'stream', stream);
  next = setFeature(next, 'terminal', stream.status === 'supported'
    ? featureResult('supported', stream.evidence)
    : stream);
  next = {
    ...next,
    stream: {
      support: stream.status,
      terminal: stream.status === 'supported' ? 'valid' : null,
      evidence: stream.evidence,
    },
  };

  const tools = await probeToolFeature({
    protocol,
    modelId,
    endpoint,
    authCandidate,
    compatibility,
    requestImpl,
    timeoutMs,
    tried,
  });
  next = setFeature(next, 'tools', tools);
  next = { ...next, tool: { support: tools.status, evidence: tools.evidence } };

  if (protocol === 'responses') {
    const features = await probeResponsesFeatures({
      modelId,
      endpoint,
      authCandidate,
      requestImpl,
      timeoutMs,
      tried,
    });
    for (const [name, result] of Object.entries(features)) next = setFeature(next, name, result);
  }
  if (protocol === 'messages') {
    next = setFeature(next, 'countTokens', await probeCountTokensFeature({
      modelId,
      endpoint,
      authCandidate,
      requestImpl,
      timeoutMs,
      tried,
    }));
  }
  return next;
}

function validResponseObject(result, object = 'response') {
  const parsed = parsedJson(result);
  return result.status === 200 && parsed?.object === object && typeof parsed.id === 'string' && Boolean(parsed.id);
}

async function probeResponsesFeatures({
  modelId,
  endpoint,
  authCandidate,
  requestImpl,
  timeoutMs,
  tried,
}) {
  const features = {};
  const seed = await requestStep({
    step: 'responses-continuation-seed',
    endpoint,
    authCandidate,
    body: {
      model: modelId,
      input: 'Reply exactly OK.',
      max_output_tokens: OUTPUT_BUDGETS.at(-1),
      store: true,
    },
    requestImpl,
    timeoutMs,
    tried,
  });
  const first = parsedJson(seed);
  if (validResponseObject(seed)) {
    const continuation = await requestStep({
      step: 'responses-continuation',
      endpoint,
      authCandidate,
      body: {
        model: modelId,
        input: 'Reply exactly OK.',
        max_output_tokens: OUTPUT_BUDGETS.at(-1),
        previous_response_id: first.id,
        store: false,
      },
      requestImpl,
      timeoutMs,
      tried,
    });
    features.continuation = validResponseObject(continuation)
      ? featureResult('supported', 'responses-continuation-valid')
      : featureFailure(continuation, 'responses-continuation');
  } else {
    features.continuation = featureFailure(seed, 'responses-continuation');
  }

  const namespace = await requestStep({
    step: 'responses-namespace-tools',
    endpoint,
    authCandidate,
    body: {
      model: modelId,
      input: 'Do not call tools. Reply exactly OK.',
      max_output_tokens: OUTPUT_BUDGETS.at(-1),
      tools: [{
        type: 'namespace',
        name: 'probe',
        description: 'Compatibility probe.',
        tools: [{
          type: 'function',
          name: 'noop',
          description: 'Unused compatibility probe.',
          parameters: { type: 'object', properties: {} },
          strict: false,
        }],
      }],
    },
    requestImpl,
    timeoutMs,
    tried,
  });
  features.namespaceTools = validResponseObject(namespace)
    ? featureResult('supported', 'responses-namespace-tools-valid')
    : featureFailure(namespace, 'responses-namespace-tools');

  const compact = await requestStep({
    step: 'responses-compact',
    endpoint: featureEndpoint(endpoint, '/responses/compact', 'responses-compact'),
    authCandidate,
    body: { model: modelId },
    requestImpl,
    timeoutMs,
    tried,
  });
  features.compact = validResponseObject(compact, 'response.compaction')
    ? featureResult('supported', 'responses-compact-valid')
    : featureFailure(compact, 'responses-compact');
  return features;
}

async function probeCountTokensFeature({
  modelId,
  endpoint,
  authCandidate,
  requestImpl,
  timeoutMs,
  tried,
}) {
  const result = await requestStep({
    step: 'messages-count-tokens',
    endpoint: featureEndpoint(endpoint, '/messages/count_tokens', 'messages-count-tokens'),
    authCandidate,
    body: {
      model: modelId,
      system: 'Reply only OK.',
      messages: [{ role: 'user', content: 'OK' }],
    },
    requestImpl,
    timeoutMs,
    tried,
  });
  const parsed = parsedJson(result);
  if (result.status === 200 && Number.isInteger(parsed?.input_tokens) && parsed.input_tokens >= 0) {
    return featureResult('supported', 'messages-count-tokens-valid');
  }
  return featureFailure(result, 'messages-count-tokens');
}

function failureClass(result) {
  if (result.network || result.status === 0) return 'network';
  if (authenticationRejected(result)) return 'authentication';
  if (ALWAYS_TRANSIENT_STATUSES.has(result.status)) {
    return result.status === 429 ? 'rate-limited' : 'upstream-transient';
  }
  if (result.status === 503 && !modelRejected(result) && !explicitlyUnsupported(result)) {
    return 'upstream-transient';
  }
  if (modelRejected(result)) return 'model-unsupported';
  if (explicitlyUnsupported(result)) return 'protocol-unsupported';
  if (pathRejected(result)) return 'endpoint-unsupported';
  if (TRANSIENT_STATUSES.has(result.status)) return 'upstream-transient';
  if (result.status === 200) return 'invalid-schema';
  return 'request-rejected';
}

function failureEvidence(errorClass) {
  const evidence = {
    authentication: 'authentication-rejected',
    network: 'network-transient',
    'rate-limited': 'rate-limited',
    'upstream-transient': 'upstream-transient',
    'endpoint-unsupported': 'verified-endpoint-unsupported',
    'protocol-unsupported': 'verified-protocol-unsupported',
    'model-unsupported': 'verified-model-unsupported',
    'invalid-schema': 'invalid-nonstream-schema',
    'request-rejected': 'provider-request-rejected',
  };
  return evidence[errorClass] || 'provider-request-failed';
}

async function requestStep({
  step,
  endpoint,
  authCandidate,
  body,
  requestImpl,
  timeoutMs,
  tried,
}) {
  const headers = {
    ...authCandidate.headers,
    accept: body?.stream === true ? 'text/event-stream' : 'application/json',
    'content-type': 'application/json',
  };
  const audit = {
    step,
    method: 'POST',
    path: endpoint.url.pathname + endpoint.url.search,
    apiRootId: endpoint.id,
    authScheme: authCandidate.scheme,
    headerNames: Object.keys(headers).sort(),
  };
  try {
    const result = safeResult(await requestImpl({
      url: endpoint.url.toString(),
      method: 'POST',
      headers,
      body,
      timeoutMs,
      streamProtocol: body?.stream === true ? String(step).split('-', 1)[0] : null,
    }));
    tried.push({ ...audit, status: result.status, outcome: 'received' });
    return result;
  } catch {
    tried.push({ ...audit, status: 0, outcome: 'network' });
    return { network: true, status: 0, headers: {}, body: '', redirected: false };
  }
}

async function probeBudgeted({
  protocol,
  modelId,
  endpoint,
  authCandidate,
  compatibility,
  requestImpl,
  timeoutMs,
  tried,
}) {
  const schemaFor = protocol === 'responses' ? responsesSchema : messagesSchema;
  let lastResult = null;
  for (const budget of OUTPUT_BUDGETS) {
    lastResult = await requestStep({
      step: `${protocol}-${budget}`,
      endpoint,
      authCandidate,
      body: requestBody(protocol, modelId, budget, compatibility),
      requestImpl,
      timeoutMs,
      tried,
    });
    if (authenticationRejected(lastResult) || pathRejected(lastResult)) {
      return { result: lastResult, capability: null };
    }
    const schema = schemaFor(lastResult);
    if (!schema) {
      const errorClass = failureClass(lastResult);
      return {
        result: lastResult,
        capability: failedCapability(protocol, endpoint, authCandidate.scheme, errorClass, failureEvidence(errorClass)),
      };
    }
    if (schema.failed) {
      return {
        result: lastResult,
        capability: failedCapability(protocol, endpoint, authCandidate.scheme, 'upstream-transient', schema.evidence),
      };
    }
    if (!schema.budgetLimited || budget === OUTPUT_BUDGETS.at(-1)) {
      return {
        result: lastResult,
        capability: supportedCapability(protocol, endpoint, authCandidate.scheme, schema, {
          ...compatibility,
          outputBudget: budget,
        }),
      };
    }
  }
  return { result: lastResult, capability: null };
}

async function probeChat({ modelId, endpoint, authCandidate, requestImpl, timeoutMs, tried }) {
  const compatibility = { instructionRole: 'developer', tokenField: 'max_tokens' };
  let result = null;
  let schema = null;
  let compatibilityAttempt = 0;
  while (compatibilityAttempt < 3) {
    compatibilityAttempt += 1;
    result = await requestStep({
      step: `chat-compat-${compatibilityAttempt}`,
      endpoint,
      authCandidate,
      body: requestBody('chat', modelId, OUTPUT_BUDGETS[0], compatibility),
      requestImpl,
      timeoutMs,
      tried,
    });
    if (authenticationRejected(result) || pathRejected(result)) return { result, capability: null };
    if (compatibility.instructionRole === 'developer' && developerRoleRejected(result)) {
      compatibility.instructionRole = 'system';
      continue;
    }
    if (compatibility.tokenField === 'max_tokens'
        && chatErrorRequestsMaxCompletionTokens(result.status, parsedJson(result))) {
      compatibility.tokenField = 'max_completion_tokens';
      continue;
    }
    schema = chatSchema(result);
    break;
  }
  if (!schema) {
    const errorClass = failureClass(result);
    return {
      result,
      capability: failedCapability('chat', endpoint, authCandidate.scheme, errorClass, failureEvidence(errorClass)),
    };
  }
  let budget = OUTPUT_BUDGETS[0];
  for (let index = 1; schema.budgetLimited && index < OUTPUT_BUDGETS.length; index += 1) {
    budget = OUTPUT_BUDGETS[index];
    result = await requestStep({
      step: `chat-budget-${budget}`,
      endpoint,
      authCandidate,
      body: requestBody('chat', modelId, budget, compatibility),
      requestImpl,
      timeoutMs,
      tried,
    });
    schema = chatSchema(result);
    if (!schema) {
      const errorClass = failureClass(result);
      return {
        result,
        capability: failedCapability('chat', endpoint, authCandidate.scheme, errorClass, failureEvidence(errorClass)),
      };
    }
  }
  return {
    result,
    capability: supportedCapability('chat', endpoint, authCandidate.scheme, schema, {
      ...compatibility,
      outputBudget: budget,
    }),
  };
}

async function probeProtocol({ protocol, profile, modelId, requestImpl, timeoutMs, tried }) {
  const resource = protocol === 'chat' ? 'chat-completions' : protocol;
  let endpoints;
  let authCandidates;
  try {
    endpoints = buildProviderEndpointCandidates({
      baseUrl: profile.baseUrl,
      resource,
      allowInsecureHttp: profile.allowInsecureHttp,
    });
    authCandidates = buildProtocolAuthCandidates(profile, protocol);
  } catch {
    return failedCapability(protocol, null, null, 'configuration', 'provider-configuration-invalid');
  }

  let last = null;
  let lastPrimary = null;
  for (const endpoint of endpoints) {
    for (let authIndex = 0; authIndex < authCandidates.length; authIndex += 1) {
      const authCandidate = authCandidates[authIndex];
      let outcome;
      for (let networkAttempt = 0; networkAttempt < 2; networkAttempt += 1) {
        outcome = protocol === 'chat'
          ? await probeChat({ modelId, endpoint, authCandidate, requestImpl, timeoutMs, tried })
          : await probeBudgeted({
            protocol,
            modelId,
            endpoint,
            authCandidate,
            compatibility: {},
            requestImpl,
            timeoutMs,
            tried,
          });
        if (authIndex !== 0 || !(outcome.result?.network || outcome.result?.status === 0)) break;
      }
      last = { ...outcome, endpoint, authCandidate };
      if (authIndex === 0) lastPrimary = last;
      if (outcome.capability?.support === 'supported') {
        return enrichAgentFeatures({
          capability: outcome.capability,
          protocol,
          modelId,
          endpoint,
          authCandidate,
          requestImpl,
          timeoutMs,
          tried,
        });
      }
      if ((
        authenticationRejected(outcome.result)
        || outcome.result?.network
        || outcome.result?.status === 0
      ) && authIndex + 1 < authCandidates.length) continue;
      break;
    }
  }
  const terminal = lastPrimary || last;
  const errorClass = failureClass(terminal?.result || { status: 0, network: true });
  return failedCapability(
    protocol,
    terminal?.endpoint || null,
    terminal?.authCandidate?.scheme || null,
    errorClass,
    failureEvidence(errorClass),
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

function containsSensitiveValue(value, sensitiveValues) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return true; }
  return sensitiveValues.some((secret) => serialized.includes(secret));
}

function capabilityFailure(reason, detail, tried, capabilities = null, modelListProbe = null) {
  return {
    ok: false,
    reason,
    detail,
    ...(capabilities ? { capabilities } : {}),
    preferredProtocol: null,
    preferredProtocolEvidence: 'none-supported',
    models: [],
    inventory: [],
    modelListProbe,
    tried,
  };
}

export async function probeProviderCapabilities({
  provider,
  resolveRequestProfile,
  requestImpl = defaultRequest,
  modelId,
  timeoutMs = 8000,
  now = Date.now,
} = {}) {
  const tried = [];
  if (!provider || !['openai-compatible', 'anthropic'].includes(provider.protocol)
      || typeof resolveRequestProfile !== 'function' || typeof requestImpl !== 'function') {
    return capabilityFailure('configuration', 'Provider capability detection is not configured', tried);
  }
  const selectedModel = typeof modelId === 'string' ? modelId.trim() : '';
  if (!selectedModel) return capabilityFailure('configuration', 'Provider detection needs a model id', tried);

  let probeProfile = null;
  let modelProfile = null;
  let models = [];
  let inventory = [];
  let modelListProbe = null;
  try {
    try { probeProfile = await resolveRequestProfile(provider, { scope: 'probe' }); } catch {}
    if (profileMatchesProvider(probeProfile, provider)) {
      const recordedRequest = async (input) => {
        const url = new URL(input.url);
        try {
          const result = safeResult(await requestImpl(input));
          tried.push({
            step: 'models',
            method: 'GET',
            path: url.pathname + url.search,
            apiRootId: null,
            authScheme: Object.hasOwn(input.headers || {}, 'authorization')
              ? 'bearer'
              : Object.hasOwn(input.headers || {}, 'x-api-key') ? 'x-api-key' : 'custom-or-none',
            headerNames: Object.keys(input.headers || {}).map((name) => name.toLowerCase()).sort(),
            status: result.status,
            outcome: 'received',
          });
          return result;
        } catch (error) {
          tried.push({
            step: 'models',
            method: 'GET',
            path: url.pathname + url.search,
            apiRootId: null,
            authScheme: 'unknown',
            headerNames: Object.keys(input.headers || {}).map((name) => name.toLowerCase()).sort(),
            status: 0,
            outcome: 'network',
          });
          throw error;
        }
      };
      const modelResult = await probeProviderModels({
        requestProfile: probeProfile,
        protocol: provider.protocol,
        requestImpl: recordedRequest,
        timeoutMs,
      });
      if (modelResult.ok) {
        const sensitiveValues = profileSensitiveValues(probeProfile);
        const candidate = {
          status: 'supported',
          apiRoot: modelResult.apiRoot,
          authScheme: modelResult.authScheme,
          models: modelResult.models,
          inventory: modelResult.inventory || [],
        };
        if (!containsSensitiveValue(candidate, sensitiveValues)) {
          models = candidate.models;
          inventory = candidate.inventory;
          modelListProbe = candidate;
        }
      }
    }

    try { modelProfile = await resolveRequestProfile(provider, { scope: 'model' }); } catch {
      return capabilityFailure(
        'configuration',
        'Provider model profile could not be resolved',
        tried,
        null,
        modelListProbe,
      );
    }
    if (!profileMatchesProvider(modelProfile, provider)) {
      return capabilityFailure(
        'configuration',
        'Provider model profile does not match the provider',
        tried,
        null,
        modelListProbe,
      );
    }

    const capabilities = {};
    for (const protocol of ['responses', 'chat', 'messages']) {
      capabilities[protocol] = await probeProtocol({
        protocol,
        profile: modelProfile,
        modelId: selectedModel,
        requestImpl,
        timeoutMs,
        tried,
      });
    }
    const supported = PROTOCOL_ORDER.filter((protocol) => capabilities[protocol].support === 'supported');
    let observedAt;
    try { observedAt = now(); } catch { observedAt = NaN; }
    if (!Number.isFinite(observedAt) || observedAt < 0) {
      return capabilityFailure(
        'configuration',
        'Provider detection clock is invalid',
        tried,
        capabilities,
        modelListProbe,
      );
    }
    return {
      ok: supported.length > 0,
      ...(supported.length === 0
        ? { reason: 'capability-incompatible', detail: 'Provider did not expose a verified Responses, Chat, or Messages API' }
        : {}),
      modelId: selectedModel,
      capabilities,
      preferredProtocol: supported[0] || null,
      preferredProtocolEvidence: supported.length ? 'observed-supported-protocol-order' : 'none-supported',
      observedAt,
      models,
      inventory,
      modelListProbe,
      tried,
    };
  } finally {
    probeProfile = null;
    modelProfile = null;
  }
}
