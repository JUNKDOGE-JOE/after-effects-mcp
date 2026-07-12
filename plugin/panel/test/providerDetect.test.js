import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectProviderDialect,
  effectiveProviderDialect,
  probeProviderCapabilities,
} from '../src/cep/providerDetect.js';

function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2',
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
    headers: [],
    dialect: { override: null, detected: [] },
    probedModels: [],
    probedAt: 0,
  }, overrides);
}

function jsonResult(status, value, headers = { 'content-type': 'application/json' }) {
  return { status, headers, body: JSON.stringify(value) };
}

function responsesResult({ status = 'completed', text = 'OK' } = {}) {
  return jsonResult(200, {
    id: 'resp_1',
    object: 'response',
    status,
    output: status === 'completed'
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
      : [],
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  });
}

function chatResult({ finishReason = 'stop', text = 'OK' } = {}) {
  return jsonResult(200, {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: finishReason,
    }],
  });
}

function messagesResult({ stopReason = 'end_turn', text = 'OK' } = {}) {
  return jsonResult(200, {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'model-explicit',
    content: text ? [{ type: 'text', text }] : [],
    stop_reason: stopReason,
  });
}

function unsupported(message = 'not implemented', code = 'not_implemented', status = 400) {
  return jsonResult(status, { error: { code, message } });
}

function sseResult(body) {
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, body };
}

function defaultAdvancedProbeResult(input) {
  const path = new URL(input.url).pathname;
  const body = input.body || {};
  if (path.endsWith('/responses/compact')) {
    return jsonResult(200, { id: 'cmp_1', object: 'response.compaction' });
  }
  if (path.endsWith('/messages/count_tokens')) {
    return jsonResult(200, { input_tokens: 2 });
  }
  if (path.endsWith('/responses') && body.store === true && !body.previous_response_id) {
    return responsesResult();
  }
  if (body.previous_response_id) return responsesResult();
  if (body.tools?.[0]?.type === 'namespace') return responsesResult();
  if (body.stream === true && path.endsWith('/responses')) {
    return sseResult('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","object":"response","status":"completed","model":"model-explicit","output":[]}}\n\n');
  }
  if (body.stream === true && path.endsWith('/chat/completions')) {
    return sseResult('data: {"id":"chat_stream","object":"chat.completion.chunk","created":1,"model":"model-explicit","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop","logprobs":null}]}\n\ndata: [DONE]\n\n');
  }
  if (body.stream === true && path.endsWith('/messages')) {
    return sseResult([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","model":"model-explicit","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n'));
  }
  if (Array.isArray(body.tools) && body.tools.length > 0 && path.endsWith('/responses')) {
    return jsonResult(200, {
      id: 'resp_tool',
      object: 'response',
      status: 'completed',
      output: [{ type: 'function_call', name: 'noop', arguments: '{"value":"ok"}' }],
    });
  }
  if (Array.isArray(body.tools) && body.tools.length > 0 && path.endsWith('/chat/completions')) {
    return jsonResult(200, {
      id: 'chat_tool',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'noop', arguments: '{"value":"ok"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  }
  if (Array.isArray(body.tools) && body.tools.length > 0 && path.endsWith('/messages')) {
    return jsonResult(200, {
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      model: 'model-explicit',
      content: [{ type: 'tool_use', id: 'call_1', name: 'noop', input: { value: 'ok' } }],
      stop_reason: 'tool_use',
    });
  }
  return null;
}

function sequenceRequest(results) {
  const queue = results.slice();
  const calls = [];
  const request = async (input) => {
    calls.push(input);
    const advanced = defaultAdvancedProbeResult(input);
    if (advanced) return advanced;
    if (queue.length === 0) throw new Error('unexpected provider request');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  request.calls = calls;
  return request;
}

function semanticSuccessResult(input) {
  if (input.method === 'GET') return jsonResult(200, { data: [{ id: 'model-explicit' }] });
  const advanced = defaultAdvancedProbeResult(input);
  if (advanced) return advanced;
  const path = new URL(input.url).pathname;
  if (path.endsWith('/responses')) return responsesResult();
  if (path.endsWith('/chat/completions')) return chatResult();
  if (path.endsWith('/messages')) return messagesResult();
  throw new Error(`unexpected provider request: ${path}`);
}

function routedRequest(handler = semanticSuccessResult) {
  const calls = [];
  const request = async (input) => {
    calls.push(input);
    return handler(input);
  };
  request.calls = calls;
  return request;
}

function resolvedProfiles({ probeSecret = 'probe-value', modelSecret = 'model-value' } = {}) {
  return async (provider, { scope }) => ({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    allowInsecureHttp: provider.allowInsecureHttp,
    auth: scope === 'probe'
      ? { kind: 'header', name: 'x-probe-token', value: probeSecret }
      : { kind: 'header', name: 'Authorization', value: `Bearer ${modelSecret}` },
    extraHeaders: scope === 'probe'
      ? [{ name: 'x-probe-feature', value: 'probe-enabled', source: 'literal' }]
      : [{ name: 'x-model-feature', value: 'model-enabled', source: 'literal' }],
    authProfileRevision: provider.authProfileRevision,
  });
}

test('probes Responses, Chat, and Messages independently with strict success schemas', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-explicit', output_modalities: ['text'] }] }),
    responsesResult(),
    chatResult(),
    messagesResult(),
  ]);
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
    now: () => 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.preferredProtocol, 'responses');
  assert.deepEqual(Object.fromEntries(Object.entries(result.capabilities).map(([key, value]) => [key, value.support])), {
    responses: 'supported',
    chat: 'supported',
    messages: 'supported',
  });
  assert.equal(result.capabilities.responses.schema.nonStreaming, 'valid');
  assert.equal(result.capabilities.chat.terminal.kind, 'stop');
  assert.equal(result.capabilities.messages.terminal.kind, 'end_turn');
  assert.deepEqual(result.capabilities.responses.stream, {
    support: 'supported',
    terminal: 'valid',
    evidence: 'responses-stream-terminal-valid',
  });
  assert.deepEqual(result.capabilities.responses.tool, {
    support: 'supported',
    evidence: 'responses-tool-call-valid',
  });
  assert.deepEqual(result.modelListProbe, {
    status: 'supported',
    apiRoot: 'https://provider.example/v1',
    authScheme: 'custom',
    models: [{ id: 'model-explicit', label: 'model-explicit' }],
    inventory: [{
      id: 'model-explicit',
      label: 'model-explicit',
      metadata: {
        task: null,
        inputModalities: [],
        outputModalities: ['text'],
        capabilities: [],
      },
    }],
  });
  assert.deepEqual(Object.keys(result.modelListProbe).sort(), [
    'apiRoot',
    'authScheme',
    'inventory',
    'models',
    'status',
  ]);
  assert.equal(requestImpl.calls.length, 15);
  const responsesCall = requestImpl.calls.find((call) => (
    new URL(call.url).pathname.endsWith('/responses')
    && call.body?.stream === false
    && !call.body?.tools
  ));
  const messagesCall = requestImpl.calls.find((call) => (
    new URL(call.url).pathname.endsWith('/messages')
    && call.body?.stream === false
    && !call.body?.tools
  ));
  assert.equal(Object.hasOwn(responsesCall.headers, 'authorization'), true);
  assert.equal(Object.hasOwn(responsesCall.headers, 'x-api-key'), false);
  assert.equal(Object.hasOwn(messagesCall.headers, 'authorization'), true);
  assert.equal(Object.hasOwn(messagesCall.headers, 'x-api-key'), false);
  assert.equal(messagesCall.headers['anthropic-version'], '2023-06-01');
});

test('v2 adapter selects Responses without hiding the independently observed matrix', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [] }),
    responsesResult(),
    chatResult(),
    messagesResult(),
  ]);
  const result = await detectProviderDialect({
    provider: providerFixture(),
    modelId: 'target-model',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
    now: () => 1500,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.dialect, {
    modelId: 'target-model',
    wireApi: 'responses',
    baseUrl: 'https://provider.example/v1',
    authProfileRevision: 1,
    detectedAt: 1500,
    evidence: 'responses-success-schema',
  });
  assert.equal(result.capabilities.chat.support, 'supported');
  assert.equal(result.capabilities.messages.support, 'supported');
  assert.equal(requestImpl.calls[1].body.model, 'target-model');
});

test('configured-root is tried before plus-v1 without rewriting Google-compatible prefixes', async () => {
  const provider = providerFixture({ baseUrl: 'https://provider.example/v1beta/openai' });
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-explicit' }] }),
    jsonResult(404, { error: { message: 'path missing' } }),
    responsesResult(),
    chatResult(),
    messagesResult(),
  ]);
  const result = await probeProviderCapabilities({
    provider,
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.responses.apiRoot, 'https://provider.example/v1beta/openai/v1');
  const semanticCalls = requestImpl.calls.filter((call) => (
    call.body?.stream === false
    && !call.body?.tools
    && !call.body?.previous_response_id
  ));
  assert.equal(new URL(semanticCalls[0].url).pathname, '/v1beta/openai/responses');
  assert.equal(new URL(semanticCalls[1].url).pathname, '/v1beta/openai/v1/responses');
  assert.equal(new URL(semanticCalls[2].url).pathname, '/v1beta/openai/chat/completions');
});

test('strict schemas reject empty Responses output, Chat choices, and Messages content', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [] }),
    jsonResult(200, { id: 'resp_1', object: 'response', status: 'completed', output: [] }),
    jsonResult(200, { id: 'chat_1', object: 'chat.completion', choices: [] }),
    jsonResult(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: 'end_turn' }),
  ]);
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.ok, false);
  for (const capability of Object.values(result.capabilities)) {
    assert.equal(capability.support, 'invalid');
    assert.equal(capability.errorClass, 'invalid-schema');
    assert.equal(capability.schema.nonStreaming, 'invalid');
  }
});

test('Chat composes developer-role and token-field fallbacks within three requests', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [] }),
    unsupported('convert_request_failed', 'convert_request_failed'),
    jsonResult(400, {
      error: {
        message: 'messages[0].role: unknown variant `developer`, expected one of `system`, `user`, `assistant`',
      },
    }),
    jsonResult(400, {
      error: {
        code: 'unsupported_parameter',
        param: 'max_tokens',
        message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
      },
    }),
    chatResult(),
    unsupported(),
  ]);
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  const chat = result.capabilities.chat;
  assert.equal(chat.support, 'supported');
  assert.deepEqual(chat.compatibility, {
    instructionRole: 'system',
    tokenField: 'max_completion_tokens',
    outputBudget: 16,
  });
  const chatCalls = requestImpl.calls.filter((call) => (
    new URL(call.url).pathname.endsWith('/chat/completions')
    && call.body?.stream === false
    && !call.body?.tools
  ));
  assert.equal(chatCalls.length, 3);
  assert.equal(chatCalls[0].body.messages[0].role, 'developer');
  assert.equal(chatCalls[1].body.messages[0].role, 'system');
  assert.equal(Object.hasOwn(chatCalls[1].body, 'max_tokens'), true);
  assert.equal(Object.hasOwn(chatCalls[2].body, 'max_completion_tokens'), true);
});

test('near-match role and token errors do not trigger compatibility retries', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [] }),
    unsupported(),
    jsonResult(400, { error: { message: 'developer quota is exhausted and token budget is invalid', param: 'tokens' } }),
    unsupported(),
  ]);
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.chat.support, 'invalid');
  const chatCalls = requestImpl.calls.filter((call) => new URL(call.url).pathname.endsWith('/chat/completions'));
  assert.equal(chatCalls.length, 1);
});

test('valid budget terminals re-probe at 16, 64, and 128 without becoming false negatives', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [] }),
    responsesResult({ status: 'incomplete', text: '' }),
    responsesResult({ status: 'incomplete', text: '' }),
    responsesResult(),
    chatResult({ finishReason: 'length', text: '' }),
    chatResult(),
    messagesResult({ stopReason: 'max_tokens', text: '' }),
    messagesResult(),
  ]);
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.responses.compatibility.outputBudget, 128);
  assert.equal(result.capabilities.chat.compatibility.outputBudget, 64);
  assert.equal(result.capabilities.messages.compatibility.outputBudget, 64);
  assert.deepEqual(
    requestImpl.calls.filter((call) => (
      new URL(call.url).pathname.endsWith('/responses')
      && call.body?.stream === false
      && !call.body?.tools
      && !call.body?.previous_response_id
    )).map((call) => call.body.max_output_tokens),
    [16, 64, 128],
  );
});

test('tool probing starts at 16 tokens and increases only after a valid budget terminal', async () => {
  const budgets = [];
  const requestImpl = routedRequest(async (input) => {
    const path = new URL(input.url).pathname;
    if (path.endsWith('/responses') && input.body?.tool_choice?.type === 'function') {
      budgets.push(input.body.max_output_tokens);
      if (input.body.max_output_tokens === 16) return responsesResult({ status: 'incomplete', text: '' });
    }
    return semanticSuccessResult(input);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.responses.agentFeatures.tools, 'supported');
  assert.deepEqual(budgets, [16, 64]);
});

test('tool probing bounds extended budgets for exhausted and empty filtered terminals', async () => {
  const budgets = [];
  const requestImpl = routedRequest(async (input) => {
    const path = new URL(input.url).pathname;
    if (path.endsWith('/chat/completions')
        && Array.isArray(input.body?.tools)
        && input.body?.tool_choice?.type === 'function') {
      const budget = input.body.max_tokens;
      budgets.push(budget);
      if (budget === 128) return chatResult({ finishReason: 'content_filter', text: '' });
      if (budget < 512) return chatResult({ finishReason: 'length', text: '' });
    }
    return semanticSuccessResult(input);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.chat.agentFeatures.tools, 'supported');
  assert.deepEqual(budgets, [16, 64, 128, 256, 512]);
});

test('tool probing uses bounded protocol-standard choice fallbacks for thinking models', async () => {
  const requestImpl = routedRequest(async (input) => {
    const path = new URL(input.url).pathname;
    const body = input.body || {};
    if (!Array.isArray(body.tools)) return semanticSuccessResult(input);
    if (path.endsWith('/responses')) {
      if (body.tool_choice === 'required') return semanticSuccessResult(input);
      return unsupported('Named tool forcing is unavailable', 'invalid_tool_choice');
    }
    if (path.endsWith('/chat/completions')) {
      if (body.tool_choice === 'auto') return semanticSuccessResult(input);
      return unsupported('Thinking mode does not support this tool_choice', 'invalid_request_error');
    }
    if (path.endsWith('/messages')) {
      if (body.tool_choice?.type === 'auto') return semanticSuccessResult(input);
      return unsupported('Thinking mode does not support this tool_choice', 'invalid_request_error');
    }
    return semanticSuccessResult(input);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.responses.agentFeatures.tools, 'supported');
  assert.equal(result.capabilities.chat.agentFeatures.tools, 'supported');
  assert.equal(result.capabilities.messages.agentFeatures.tools, 'supported');
  assert.deepEqual(
    result.tried.filter(({ step }) => /^(?:responses|chat|messages)-tool(?:-|$)/.test(step)).map(({ step }) => step),
    [
      'responses-tool',
      'responses-tool-required',
      'chat-tool',
      'chat-tool-required',
      'chat-tool-auto',
      'messages-tool',
      'messages-tool-any',
      'messages-tool-auto',
    ],
  );
});

test('tool probing can prove implicit auto selection without sending tool_choice', async () => {
  const requestImpl = routedRequest(async (input) => {
    const path = new URL(input.url).pathname;
    const body = input.body || {};
    if (path.endsWith('/chat/completions') && Array.isArray(body.tools)) {
      if (!Object.hasOwn(body, 'tool_choice')) return semanticSuccessResult(input);
      return unsupported('tool_choice is not accepted', 'invalid_tool_choice');
    }
    return semanticSuccessResult(input);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.chat.agentFeatures.tools, 'supported');
  const calls = requestImpl.calls.filter((call) => (
    new URL(call.url).pathname.endsWith('/chat/completions')
    && Array.isArray(call.body?.tools)
  ));
  assert.equal(calls.length, 4);
  assert.equal(Object.hasOwn(calls.at(-1).body, 'tool_choice'), false);
});

test('tool choice fallbacks never convert a text response into tool support', async () => {
  const requestImpl = routedRequest(async (input) => {
    const path = new URL(input.url).pathname;
    if (path.endsWith('/chat/completions') && Array.isArray(input.body?.tools)) {
      return chatResult();
    }
    return semanticSuccessResult(input);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.chat.agentFeatures.tools, 'unsupported');
  assert.equal(requestImpl.calls.filter((call) => (
    new URL(call.url).pathname.endsWith('/chat/completions')
    && Array.isArray(call.body?.tools)
  )).length, 4);
});

test('tool choice fallbacks stop on transient failures', async () => {
  const requestImpl = routedRequest(async (input) => {
    const path = new URL(input.url).pathname;
    if (path.endsWith('/chat/completions') && Array.isArray(input.body?.tools)) {
      return jsonResult(429, { error: { message: 'try later' } });
    }
    return semanticSuccessResult(input);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.chat.agentFeatures.tools, 'unknown');
  assert.equal(requestImpl.calls.filter((call) => (
    new URL(call.url).pathname.endsWith('/chat/completions')
    && Array.isArray(call.body?.tools)
  )).length, 1);
});

test('tool probing retries one network failure on the same bounded candidate', async () => {
  let toolAttempts = 0;
  const requestImpl = routedRequest(async (input) => {
    const path = new URL(input.url).pathname;
    if (path.endsWith('/chat/completions') && Array.isArray(input.body?.tools)) {
      toolAttempts += 1;
      if (toolAttempts === 1) throw new Error('network');
    }
    return semanticSuccessResult(input);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.chat.agentFeatures.tools, 'supported');
  assert.equal(toolAttempts, 2);
  assert.deepEqual(
    result.tried.filter(({ step }) => step === 'chat-tool').map(({ outcome }) => outcome),
    ['network', 'received'],
  );
});

test('explicit unsupported and transient failures receive distinct cache evidence', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [] }),
    unsupported('convert_request_failed: not implemented', 'new_api_error'),
    jsonResult(503, { error: { message: 'upstream temporarily unavailable' } }),
    jsonResult(404, { error: { message: 'path missing' } }),
  ]);
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.responses.support, 'unsupported');
  assert.equal(result.capabilities.responses.errorClass, 'protocol-unsupported');
  assert.equal(result.capabilities.responses.ttl.maxAgeMs, null);
  assert.equal(result.capabilities.responses.ttl.evidence, 'verified-protocol-unsupported');
  assert.equal(result.capabilities.chat.support, 'transient');
  assert.equal(result.capabilities.chat.ttl.maxAgeMs, 60_000);
  assert.equal(result.capabilities.chat.ttl.evidence, 'upstream-transient');
  assert.equal(result.capabilities.messages.support, 'unsupported');
  assert.equal(result.capabilities.messages.errorClass, 'endpoint-unsupported');
});

test('auth fallback changes schemes between requests but never sends both headers together', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [] }),
    jsonResult(401, { error: { message: 'bearer rejected' } }),
    responsesResult(),
    chatResult(),
    messagesResult(),
  ]);
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.responses.authScheme, 'x-api-key');
  for (const call of requestImpl.calls.slice(1)) {
    assert.equal(
      Object.hasOwn(call.headers, 'authorization') && Object.hasOwn(call.headers, 'x-api-key'),
      false,
    );
  }
});

test('the resolved auth scheme gets one bounded network retry before auth fallback', async () => {
  let primaryResponsesAttempts = 0;
  const requestImpl = routedRequest(async (input) => {
    const path = new URL(input.url).pathname;
    const isBasicResponses = path.endsWith('/responses')
      && input.body?.stream === false
      && !input.body?.tools
      && !input.body?.previous_response_id;
    if (isBasicResponses && Object.hasOwn(input.headers, 'authorization')) {
      primaryResponsesAttempts += 1;
      if (primaryResponsesAttempts === 1) throw new Error('network');
    }
    return semanticSuccessResult(input);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.responses.support, 'supported');
  assert.equal(result.capabilities.responses.authScheme, 'bearer');
  assert.equal(primaryResponsesAttempts, 2);
});

test('a fallback auth rejection cannot overwrite a primary network failure', async () => {
  const requestImpl = routedRequest(async (input) => {
    if (input.method === 'GET') return jsonResult(200, { data: [{ id: 'model-explicit' }] });
    const path = new URL(input.url).pathname;
    if (path.endsWith('/responses')) {
      if (Object.hasOwn(input.headers, 'authorization')) throw new Error('network');
      return jsonResult(401, { error: { message: 'fallback rejected' } });
    }
    return unsupported('convert_request_failed: not implemented', 'convert_request_failed', 400);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.responses.support, 'transient');
  assert.equal(result.capabilities.responses.errorClass, 'network');
  assert.equal(result.capabilities.responses.authScheme, 'bearer');
});

test('supported protocols prove legal stream terminals, tool calls, and protocol-specific agent features', async () => {
  const probeSecret = 'probe-secret-must-not-be-audited';
  const modelSecret = 'model-secret-must-not-be-audited';
  const requestImpl = routedRequest();
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles({ probeSecret, modelSecret }),
    requestImpl,
  });

  assert.deepEqual(result.capabilities.responses.agentFeatures, {
    stream: 'supported',
    terminal: 'supported',
    tools: 'supported',
    compact: 'supported',
    continuation: 'supported',
    namespaceTools: 'supported',
    reasoningReplay: 'unknown',
    countTokens: 'unknown',
  });
  assert.deepEqual(result.capabilities.chat.agentFeatures, {
    stream: 'supported',
    terminal: 'supported',
    tools: 'supported',
    compact: 'unknown',
    continuation: 'unknown',
    namespaceTools: 'unknown',
    reasoningReplay: 'unknown',
    countTokens: 'unknown',
  });
  assert.deepEqual(result.capabilities.messages.agentFeatures, {
    stream: 'supported',
    terminal: 'supported',
    tools: 'supported',
    compact: 'unknown',
    continuation: 'unknown',
    namespaceTools: 'unknown',
    reasoningReplay: 'unknown',
    countTokens: 'supported',
  });
  assert.deepEqual(result.tried.map(({ step }) => step), [
    'models',
    'responses-16',
    'responses-stream',
    'responses-tool',
    'responses-continuation-seed',
    'responses-continuation',
    'responses-namespace-tools',
    'responses-compact',
    'chat-compat-1',
    'chat-stream',
    'chat-tool',
    'messages-16',
    'messages-stream',
    'messages-tool',
    'messages-count-tokens',
  ]);
  assert.equal(JSON.stringify(result).includes(probeSecret), false);
  assert.equal(JSON.stringify(result).includes(modelSecret), false);
  assert.equal(result.tried.every((entry) => !Object.hasOwn(entry, 'headers') && !Object.hasOwn(entry, 'body')), true);
  const continuationSeed = requestImpl.calls.find((call) => (
    new URL(call.url).pathname.endsWith('/responses')
    && call.body?.store === true
    && !call.body?.previous_response_id
  ));
  const continuation = requestImpl.calls.find((call) => call.body?.previous_response_id === 'resp_1');
  assert.equal(continuationSeed.body.store, true);
  assert.equal(Object.hasOwn(continuationSeed.body, 'previous_response_id'), false);
  assert.equal(continuation.body.previous_response_id, 'resp_1');
  assert.equal(continuation.body.store, false);
  const responseStream = requestImpl.calls.find((call) => (
    new URL(call.url).pathname.endsWith('/responses') && call.body?.stream === true
  ));
  const responseTool = requestImpl.calls.find((call) => (
    new URL(call.url).pathname.endsWith('/responses')
    && call.body?.tool_choice?.type === 'function'
  ));
  const chatStream = requestImpl.calls.find((call) => (
    new URL(call.url).pathname.endsWith('/chat/completions') && call.body?.stream === true
  ));
  const messagesStream = requestImpl.calls.find((call) => (
    new URL(call.url).pathname.endsWith('/messages') && call.body?.stream === true
  ));
  assert.equal(responseStream.body.max_output_tokens, 16);
  assert.equal(responseTool.body.max_output_tokens, 16);
  assert.equal(chatStream.body.max_tokens, 16);
  assert.equal(messagesStream.body.max_tokens, 16);
  assert.equal(requestImpl.calls.some((call) => call.body?.tools?.[0]?.type === 'namespace'), true);
  assert.equal(requestImpl.calls.some((call) => new URL(call.url).pathname.endsWith('/responses/compact')), true);
  assert.equal(requestImpl.calls.some((call) => new URL(call.url).pathname.endsWith('/messages/count_tokens')), true);
});

test('a supported non-streaming protocol does not infer stream support without a legal terminal', async () => {
  const requestImpl = routedRequest((input) => {
    const path = new URL(input.url).pathname;
    if (input.method === 'GET') return jsonResult(200, { data: [] });
    if (path.endsWith('/responses') && input.body?.stream === true) {
      return sseResult('event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress"}}\n\n');
    }
    if (path.endsWith('/responses')) {
      return defaultAdvancedProbeResult(input) || responsesResult();
    }
    return unsupported('feature endpoint is not supported', 'not_supported');
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.equal(result.capabilities.responses.support, 'supported');
  assert.equal(result.capabilities.responses.agentFeatures.stream, 'unsupported');
  assert.equal(result.capabilities.responses.agentFeatures.terminal, 'unsupported');
  assert.equal(result.capabilities.responses.agentFeatures.tools, 'supported');
  assert.equal(result.capabilities.responses.stream.terminal, null);
});

test('transient feature responses remain unknown while stable feature rejections become unsupported', async () => {
  const requestImpl = routedRequest((input) => {
    const path = new URL(input.url).pathname;
    const body = input.body || {};
    if (input.method === 'GET') return jsonResult(200, { data: [] });
    if (path.endsWith('/responses/compact')) {
      return jsonResult(503, {
        error: { code: 'model_not_found', param: 'model', message: 'compact model is not available' },
      });
    }
    if (path.endsWith('/messages/count_tokens')) {
      return unsupported('temporary count_tokens implementation failure', 'not_implemented', 425);
    }
    if (path.endsWith('/responses')) {
      if (body.stream === true) return unsupported('temporary stream implementation failure', 'not_implemented', 500);
      if (body.previous_response_id) {
        return jsonResult(502, { error: { code: 'model_not_found', param: 'model', message: 'model temporarily unavailable' } });
      }
      if (body.tools?.[0]?.type === 'namespace') {
        return unsupported('temporary namespace implementation failure', 'not_implemented', 504);
      }
      if (Array.isArray(body.tools)) return unsupported('tool probe rate limited', 'not_implemented', 429);
      return responsesResult();
    }
    if (path.endsWith('/chat/completions')) return unsupported('chat is not supported', 'not_supported');
    if (path.endsWith('/messages')) {
      if (body.stream === true) {
        return jsonResult(408, { error: { code: 'model_not_found', param: 'model', message: 'stream timed out' } });
      }
      if (Array.isArray(body.tools)) return unsupported('Messages tools are not supported', 'not_supported');
      return messagesResult();
    }
    throw new Error(`unexpected provider request: ${path}`);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.deepEqual({
    stream: result.capabilities.responses.agentFeatures.stream,
    tools: result.capabilities.responses.agentFeatures.tools,
    continuation: result.capabilities.responses.agentFeatures.continuation,
    namespaceTools: result.capabilities.responses.agentFeatures.namespaceTools,
    compact: result.capabilities.responses.agentFeatures.compact,
    messagesStream: result.capabilities.messages.agentFeatures.stream,
    messagesTerminal: result.capabilities.messages.agentFeatures.terminal,
    messagesTools: result.capabilities.messages.agentFeatures.tools,
    countTokens: result.capabilities.messages.agentFeatures.countTokens,
  }, {
    stream: 'unknown',
    tools: 'unknown',
    continuation: 'unknown',
    namespaceTools: 'unknown',
    compact: 'unsupported',
    messagesStream: 'unknown',
    messagesTerminal: 'unknown',
    messagesTools: 'unsupported',
    countTokens: 'unknown',
  });
});

test('semantic probes keep structured 503 rejection stable but treat 429 and 500 as transient', async () => {
  const requestImpl = routedRequest((input) => {
    const path = new URL(input.url).pathname;
    if (input.method === 'GET') return jsonResult(200, { data: [] });
    if (path.endsWith('/responses')) {
      return jsonResult(503, { error: { code: 'model_not_found', param: 'model', message: 'model temporarily unavailable' } });
    }
    if (path.endsWith('/chat/completions')) return unsupported('rate limited while converting request', 'not_implemented', 429);
    if (path.endsWith('/messages')) return unsupported('temporary conversion implementation failure', 'convert_request_failed', 500);
    throw new Error(`unexpected provider request: ${path}`);
  });
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
  });

  assert.deepEqual(Object.fromEntries(Object.entries(result.capabilities).map(([protocol, capability]) => [
    protocol,
    { support: capability.support, ttl: capability.ttl.class, maxAgeMs: capability.ttl.maxAgeMs },
  ])), {
    responses: { support: 'unsupported', ttl: 'unsupported', maxAgeMs: null },
    chat: { support: 'transient', ttl: 'transient', maxAgeMs: 60_000 },
    messages: { support: 'transient', ttl: 'transient', maxAgeMs: 60_000 },
  });
});

test('default transport finishes a strict SSE probe at its terminal frame without waiting for socket EOF', async () => {
  const destroyedPaths = [];
  const transport = {
    request(options, callback) {
      let payload = '';
      let timeoutCallback = null;
      let requestDestroyed = false;
      const request = {
        on() { return request; },
        setTimeout(_timeoutMs, listener) { timeoutCallback = listener; },
        write(chunk) { payload += String(chunk); },
        destroy() {
          requestDestroyed = true;
          destroyedPaths.push(options.path);
        },
        end() {
          const body = payload ? JSON.parse(payload) : null;
          const emit = (statusCode, value, headers = { 'content-type': 'application/json' }, end = true) => {
            const listeners = {};
            let responseDestroyed = false;
            const response = {
              statusCode,
              headers,
              on(name, listener) {
                listeners[name] = listener;
                return response;
              },
              destroy() { responseDestroyed = true; },
            };
            callback(response);
            queueMicrotask(() => {
              const text = typeof value === 'string' ? value : JSON.stringify(value);
              listeners.data?.(Buffer.from(text));
              if (end) listeners.end?.();
              else if (!requestDestroyed && !responseDestroyed) timeoutCallback?.();
            });
          };
          if (options.path === '/v1/models') {
            emit(200, { data: [{ id: 'model-explicit' }] });
          } else if (options.path === '/v1/responses/compact') {
            emit(200, { id: 'cmp_1', object: 'response.compaction' });
          } else if (options.path === '/v1/responses' && body?.stream === true) {
            emit(200,
              'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","object":"response","status":"completed","model":"model-explicit","output":[]}}\n\n',
              { 'content-type': 'text/event-stream' }, false);
          } else if (options.path === '/v1/responses' && body?.tool_choice?.type === 'function') {
            emit(200, {
              id: 'resp_tool',
              object: 'response',
              status: 'completed',
              output: [{ type: 'function_call', name: 'noop', arguments: '{"value":"ok"}' }],
            });
          } else if (options.path === '/v1/responses') {
            emit(200, JSON.parse(responsesResult().body));
          } else {
            emit(400, { error: { code: 'convert_request_failed', message: 'not implemented' } });
          }
        },
      };
      return request;
    },
  };
  const previousWindow = globalThis.window;
  globalThis.window = { cep_node: { require: () => transport } };
  try {
    const result = await probeProviderCapabilities({
      provider: providerFixture(),
      modelId: 'model-explicit',
      resolveRequestProfile: resolvedProfiles(),
      timeoutMs: 50,
    });
    assert.equal(result.capabilities.responses.support, 'supported');
    assert.equal(result.capabilities.responses.agentFeatures.stream, 'supported');
    assert.equal(destroyedPaths.includes('/v1/responses'), true);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('default transport aborts all probe responses above 512 KiB without retaining their bodies', async () => {
  const destroyedPaths = [];
  const requestOptions = [];
  const transport = {
    request(options, callback) {
      requestOptions.push(options);
      const requestListeners = {};
      const request = {
        on(name, listener) {
          requestListeners[name] = listener;
          return request;
        },
        setTimeout() {},
        write() {},
        destroy() {
          destroyedPaths.push(options.path);
        },
        end() {
          const responseListeners = {};
          const response = {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            on(name, listener) {
              responseListeners[name] = listener;
              return response;
            },
          };
          callback(response);
          responseListeners.data(Buffer.alloc((512 * 1024) + 1, 120));
          responseListeners.end();
        },
      };
      return request;
    },
  };
  const previousWindow = globalThis.window;
  globalThis.window = { cep_node: { require: () => transport } };
  try {
    const result = await probeProviderCapabilities({
      provider: providerFixture(),
      modelId: 'model-explicit',
      resolveRequestProfile: resolvedProfiles(),
    });
    assert.deepEqual([...new Set(destroyedPaths)].sort(), [
      '/v1/chat/completions',
      '/v1/messages',
      '/v1/models',
      '/v1/responses',
    ]);
    assert.equal(destroyedPaths.length, 10);
    const semanticOptions = requestOptions.filter((options) => options.path !== '/v1/models');
    assert.equal(semanticOptions.every((options) => options.agent === false), true);
    assert.equal(semanticOptions.every((options) => options.headers.accept === 'application/json'), true);
    assert.equal(semanticOptions.every((options) => options.headers['content-type'] === 'application/json'), true);
    assert.equal(semanticOptions.every((options) => /^[1-9]\d*$/.test(options.headers['content-length'])), true);
    assert.equal(Object.values(result.capabilities).every((capability) => capability.support === 'transient'), true);
    assert.equal(result.modelListProbe, null);
    assert.equal(JSON.stringify(result).includes('x'.repeat(1024)), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('messages-only evidence remains available while the v2 adapter fails closed', async () => {
  const neutralRequest = sequenceRequest([
    jsonResult(200, { data: [] }),
    unsupported(),
    unsupported(),
    messagesResult(),
  ]);
  const neutral = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl: neutralRequest,
  });
  assert.equal(neutral.ok, true);
  assert.equal(neutral.preferredProtocol, 'messages');

  const adapterRequest = sequenceRequest([
    jsonResult(200, { data: [] }),
    unsupported(),
    unsupported(),
    messagesResult(),
  ]);
  const adapted = await detectProviderDialect({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles(),
    requestImpl: adapterRequest,
  });
  assert.equal(adapted.ok, false);
  assert.equal(adapted.reason, 'dialect-incompatible');
  assert.equal(adapted.capabilities.messages.support, 'supported');
  assert.equal(Object.hasOwn(adapted, 'dialect'), false);
});

test('model listing is optional and credential values never enter the result', async () => {
  const probeSecret = 'probe-secret-exact';
  const modelSecret = 'model-secret-exact';
  const requestImpl = sequenceRequest([
    new Error(`models failed ${probeSecret}`),
    responsesResult(),
    chatResult(),
    messagesResult(),
  ]);
  const result = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'model-explicit',
    resolveRequestProfile: resolvedProfiles({ probeSecret, modelSecret }),
    requestImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, []);
  assert.equal(result.modelListProbe, null);
  assert.equal(JSON.stringify(result).includes(probeSecret), false);
  assert.equal(JSON.stringify(result).includes(modelSecret), false);
});

test('missing model and mismatched profiles fail before semantic requests', async () => {
  let resolves = 0;
  const missing = await probeProviderCapabilities({
    provider: providerFixture(),
    resolveRequestProfile: async () => { resolves += 1; },
    requestImpl: sequenceRequest([]),
  });
  assert.equal(missing.reason, 'configuration');
  assert.equal(resolves, 0);

  const mismatch = await probeProviderCapabilities({
    provider: providerFixture(),
    modelId: 'm',
    resolveRequestProfile: async (provider, { scope }) => ({
      ...(await resolvedProfiles()(provider, { scope })),
      providerId: 'other-provider',
    }),
    requestImpl: sequenceRequest([]),
  });
  assert.equal(mismatch.reason, 'configuration');
});

test('v2 adapter rejects non-OpenAI provider types without resolving credentials', async () => {
  let resolves = 0;
  const result = await detectProviderDialect({
    provider: providerFixture({ protocol: 'anthropic' }),
    modelId: 'm',
    resolveRequestProfile: async () => { resolves += 1; },
    requestImpl: sequenceRequest([]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'configuration');
  assert.equal(resolves, 0);
});

test('effectiveProviderDialect prefers override and validates detected cache identity and age', () => {
  const nowMs = 100_000_000;
  const detected = {
    modelId: 'model-a',
    wireApi: 'chat',
    baseUrl: 'https://provider.example/v1/',
    authProfileRevision: 1,
    detectedAt: nowMs - 86_400_000,
    evidence: 'chat-success-schema',
  };
  const base = providerFixture({ dialect: { override: null, detected: [detected] } });

  assert.equal(effectiveProviderDialect(base, { modelId: 'model-a', now: () => nowMs }), 'chat');
  assert.equal(effectiveProviderDialect(base, { modelId: 'model-b', now: () => nowMs }), null);
  assert.equal(effectiveProviderDialect({ ...base, baseUrl: 'https://other.example/v1' }, { modelId: 'model-a', now: () => nowMs }), null);
  assert.equal(effectiveProviderDialect({ ...base, authProfileRevision: 2 }, { modelId: 'model-a', now: () => nowMs }), null);
});
