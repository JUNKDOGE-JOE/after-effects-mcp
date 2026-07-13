const SUPPORTED_RESPONSE_FIELDS = new Set([
  'model',
  'instructions',
  'input',
  'max_output_tokens',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'stream',
  'reasoning',
  'include',
  'store',
  'prompt_cache_key',
  'client_metadata',
]);

const MESSAGE_FIELDS = new Set(['type', 'role', 'content']);
const TEXT_PART_FIELDS = new Set(['type', 'text']);
const FUNCTION_CALL_FIELDS = new Set(['type', 'id', 'call_id', 'name', 'arguments', 'status']);
const FUNCTION_OUTPUT_FIELDS = new Set(['type', 'id', 'call_id', 'output', 'status']);
const REASONING_ITEM_FIELDS = new Set(['type', 'id', 'summary', 'encrypted_content', 'status']);
const FUNCTION_TOOL_FIELDS = new Set([
  'type',
  'name',
  'description',
  'parameters',
  'strict',
]);
const NAMESPACE_TOOL_FIELDS = new Set(['type', 'name', 'description', 'tools']);
const FUNCTION_CHOICE_FIELDS = new Set(['type', 'name']);
const CHAT_COMPLETION_FIELDS = new Set([
  'id',
  'object',
  'created',
  'model',
  'choices',
  'usage',
  'system_fingerprint',
  'service_tier',
]);
const CHAT_CHOICE_FIELDS = new Set([
  'index',
  'message',
  'finish_reason',
  'logprobs',
]);
const CHAT_MESSAGE_FIELDS = new Set(['role', 'content', 'tool_calls', 'refusal', 'reasoning_content']);
const CHAT_TOOL_CALL_FIELDS = new Set(['id', 'type', 'function']);
const CHAT_FUNCTION_FIELDS = new Set(['name', 'arguments']);
const CHAT_CHUNK_FIELDS = new Set([
  'id',
  'object',
  'created',
  'model',
  'choices',
  'usage',
  'system_fingerprint',
  'service_tier',
]);
const CHAT_STREAM_CHOICE_FIELDS = new Set([
  'index',
  'delta',
  'finish_reason',
  'logprobs',
]);
const CHAT_DELTA_FIELDS = new Set(['role', 'content', 'tool_calls', 'reasoning_content']);
const CHAT_TOOL_DELTA_FIELDS = new Set(['index', 'id', 'type', 'function']);
const CHAT_FUNCTION_DELTA_FIELDS = new Set(['name', 'arguments']);
const UNSUPPORTED_TOKEN_PARAMETER_CODES = new Set([
  'unsupported_parameter',
  'unknown_parameter',
  'unrecognized_parameter',
]);
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class ResponsesCompatibilityError extends Error {
  constructor({ status, code, param, message }) {
    super(message);
    this.name = 'ResponsesCompatibilityError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

function unsupportedResponsesField(param) {
  return new ResponsesCompatibilityError({
    status: 501,
    code: 'unsupported_responses_field',
    param,
    message: `Unsupported Responses field: ${param}`,
  });
}

function invalidResponsesField(param) {
  return new ResponsesCompatibilityError({
    status: 400,
    code: 'invalid_responses_field',
    param,
    message: `Invalid Responses field: ${param}`,
  });
}

function invalidChatCompletion(param) {
  return new ResponsesCompatibilityError({
    status: 502,
    code: 'invalid_chat_completion',
    param,
    message: `Invalid Chat completion field: ${param}`,
  });
}

function invalidChatSse(param) {
  return new ResponsesCompatibilityError({
    status: 502,
    code: 'upstream_sse_malformed',
    param,
    message: `Malformed upstream Chat SSE: ${param}`,
  });
}

function oversizedChatSse() {
  return new ResponsesCompatibilityError({
    status: 502,
    code: 'upstream_sse_frame_too_large',
    param: 'sse',
    message: 'Upstream Chat SSE frame exceeds the configured limit.',
  });
}

function isObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKey(value, allowed) {
  return Object.keys(value).find((key) => !allowed.has(key)) || null;
}

function requestObject(value, param) {
  if (!isObject(value)) throw invalidResponsesField(param);
  return value;
}

function requestExact(value, allowed, param) {
  const object = requestObject(value, param);
  const key = unknownKey(object, allowed);
  if (key !== null) throw unsupportedResponsesField(param ? `${param}.${key}` : key);
  return object;
}

function requestString(value, param, allowEmpty = true) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw invalidResponsesField(param);
  }
  return value;
}

function requestFunctionName(value, param) {
  const name = requestString(value, param, false);
  if (!FUNCTION_NAME.test(name)) throw invalidResponsesField(param);
  return name;
}

function cloneRequestJson(value, param, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidResponsesField(param);
    return value;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    throw invalidResponsesField(param);
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => cloneRequestJson(item, param, seen));
  } else if (isObject(value)) {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = cloneRequestJson(item, param, seen);
    }
  } else {
    throw invalidResponsesField(param);
  }
  seen.delete(value);
  return result;
}

function requestJsonArguments(value, param) {
  const raw = requestString(value, param);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidResponsesField(param);
  }
  if (!isObject(parsed)) throw invalidResponsesField(param);
  return raw;
}

function messageText(content, param) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalidResponsesField(param);
  return content.map((rawPart, index) => {
    const partPath = `${param}[${index}]`;
    const part = requestObject(rawPart, partPath);
    if (part.type !== 'input_text' && part.type !== 'output_text') {
      throw unsupportedResponsesField(`${partPath}.type`);
    }
    requestExact(part, TEXT_PART_FIELDS, partPath);
    return requestString(part.text, `${partPath}.text`);
  }).join('');
}

function responseMessageToChat(item, path) {
  const message = requestExact(item, MESSAGE_FIELDS, path);
  if (message.type !== undefined && message.type !== 'message') {
    throw invalidResponsesField(`${path}.type`);
  }
  if (!['user', 'assistant', 'system', 'developer'].includes(message.role)) {
    throw unsupportedResponsesField(`${path}.role`);
  }
  if (!Object.hasOwn(message, 'content')) {
    throw invalidResponsesField(`${path}.content`);
  }
  return {
    role: message.role,
    content: messageText(message.content, `${path}.content`),
  };
}

function responseFunctionCallToChat(item, path) {
  const call = requestExact(item, FUNCTION_CALL_FIELDS, path);
  if (call.type !== 'function_call') throw invalidResponsesField(`${path}.type`);
  if (call.status !== undefined && !['completed', 'incomplete'].includes(call.status)) {
    throw invalidResponsesField(`${path}.status`);
  }
  return {
    id: requestString(call.call_id, `${path}.call_id`, false),
    type: 'function',
    function: {
      name: requestFunctionName(call.name, `${path}.name`),
      arguments: requestJsonArguments(call.arguments, `${path}.arguments`),
    },
  };
}

function responseFunctionOutputToChat(item, path, knownCallIds, usedCallIds) {
  const output = requestExact(item, FUNCTION_OUTPUT_FIELDS, path);
  if (output.type !== 'function_call_output') {
    throw invalidResponsesField(`${path}.type`);
  }
  if (output.status !== undefined && !['completed', 'incomplete'].includes(output.status)) {
    throw invalidResponsesField(`${path}.status`);
  }
  const callId = requestString(output.call_id, `${path}.call_id`, false);
  if (!knownCallIds.has(callId) || usedCallIds.has(callId)) {
    throw invalidResponsesField(`${path}.call_id`);
  }
  usedCallIds.add(callId);
  return {
    role: 'tool',
    tool_call_id: callId,
    content: requestString(output.output, `${path}.output`),
  };
}

function responsesInputToMessages(input, { openReasoning } = {}) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidResponsesField('input');
  }

  const messages = [];
  const knownCallIds = new Set();
  const usedCallIds = new Set();
  let pendingCalls = [];
  let pendingReasoning = null;

  function flushCalls() {
    if (pendingCalls.length === 0) return;
    const assistant = { role: 'assistant', content: null, tool_calls: pendingCalls };
    if (pendingReasoning !== null) assistant.reasoning_content = pendingReasoning;
    messages.push(assistant);
    pendingCalls = [];
    pendingReasoning = null;
  }

  input.forEach((rawItem, index) => {
    const path = `input[${index}]`;
    if (!isObject(rawItem)) throw invalidResponsesField(path);
    if (rawItem.type === 'reasoning') {
      if (typeof openReasoning !== 'function') throw unsupportedResponsesField(`${path}.type`);
      if (pendingReasoning !== null || pendingCalls.length > 0) {
        throw invalidResponsesField(path);
      }
      const reasoning = requestExact(rawItem, REASONING_ITEM_FIELDS, path);
      if (!Array.isArray(reasoning.summary)) throw invalidResponsesField(`${path}.summary`);
      if (reasoning.summary.length > 0) throw unsupportedResponsesField(`${path}.summary`);
      const encrypted = requestString(reasoning.encrypted_content, `${path}.encrypted_content`, false);
      let opened;
      try { opened = openReasoning(encrypted, { sourceProtocol: 'chat' }); } catch {
        throw unsupportedResponsesField(`${path}.encrypted_content`);
      }
      if (typeof opened?.item !== 'string') throw unsupportedResponsesField(`${path}.encrypted_content`);
      pendingReasoning = opened.item;
      return;
    }
    if (rawItem.type === 'function_call') {
      const call = responseFunctionCallToChat(rawItem, path);
      if (knownCallIds.has(call.id)) throw invalidResponsesField(`${path}.call_id`);
      knownCallIds.add(call.id);
      pendingCalls.push(call);
      return;
    }
    if (rawItem.type === 'function_call_output') {
      flushCalls();
      messages.push(responseFunctionOutputToChat(
        rawItem,
        path,
        knownCallIds,
        usedCallIds,
      ));
      return;
    }
    if (rawItem.type === undefined || rawItem.type === 'message') {
      flushCalls();
      const message = responseMessageToChat(rawItem, path);
      if (pendingReasoning !== null) {
        if (message.role !== 'assistant') throw invalidResponsesField(path);
        message.reasoning_content = pendingReasoning;
        pendingReasoning = null;
      }
      messages.push(message);
      return;
    }
    throw unsupportedResponsesField(`${path}.type`);
  });
  flushCalls();
  if (pendingReasoning !== null) throw invalidResponsesField('input');
  return messages;
}

function responseToolToChat(rawTool, path, namespaceDescription = '') {
  const tool = requestExact(rawTool, FUNCTION_TOOL_FIELDS, path);
  if (tool.type !== 'function') throw unsupportedResponsesField(`${path}.type`);
  const fn = {
    name: requestFunctionName(tool.name, `${path}.name`),
    parameters: cloneRequestJson(tool.parameters, `${path}.parameters`),
  };
  if (!isObject(fn.parameters)) throw invalidResponsesField(`${path}.parameters`);
  const description = tool.description === undefined
    ? ''
    : requestString(tool.description, `${path}.description`);
  if (namespaceDescription || description) {
    fn.description = [namespaceDescription, description].filter(Boolean).join('\n\n');
  }
  if (tool.strict !== undefined) {
    if (typeof tool.strict !== 'boolean') throw invalidResponsesField(`${path}.strict`);
    fn.strict = tool.strict;
  }
  return { type: 'function', function: fn };
}

function responseToolsToChat(rawTools) {
  const converted = [];
  rawTools.forEach((rawTool, index) => {
    const path = `tools[${index}]`;
    const tool = requestObject(rawTool, path);
    if (tool.type === 'function') {
      converted.push(responseToolToChat(tool, path));
      return;
    }
    if (tool.type !== 'namespace') throw unsupportedResponsesField(`${path}.type`);
    const namespace = requestExact(tool, NAMESPACE_TOOL_FIELDS, path);
    const namespaceName = requestFunctionName(namespace.name, `${path}.name`);
    const namespaceDescription = namespace.description === undefined
      ? namespaceName
      : requestString(namespace.description, `${path}.description`);
    if (!Array.isArray(namespace.tools) || namespace.tools.length === 0) {
      throw invalidResponsesField(`${path}.tools`);
    }
    namespace.tools.forEach((child, childIndex) => {
      converted.push(responseToolToChat(
        child,
        `${path}.tools[${childIndex}]`,
        namespaceDescription,
      ));
    });
  });
  return converted;
}

function responseToolChoiceToChat(rawChoice, toolNames) {
  if (typeof rawChoice === 'string') {
    if (!['auto', 'none', 'required'].includes(rawChoice)) {
      throw invalidResponsesField('tool_choice');
    }
    return rawChoice;
  }
  const choice = requestExact(rawChoice, FUNCTION_CHOICE_FIELDS, 'tool_choice');
  if (choice.type !== 'function') throw unsupportedResponsesField('tool_choice.type');
  const name = requestFunctionName(choice.name, 'tool_choice.name');
  if (!toolNames.has(name)) throw invalidResponsesField('tool_choice.name');
  return { type: 'function', function: { name } };
}

function optionalNumber(value, param, predicate) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !predicate(value)) {
    throw invalidResponsesField(param);
  }
  return value;
}

export function responsesBodyToChatBody(body, { openReasoning } = {}) {
  const request = requestExact(body, SUPPORTED_RESPONSE_FIELDS, '');
  const model = requestString(request.model, 'model', false);
  if (!Object.hasOwn(request, 'input')) throw invalidResponsesField('input');

  const messages = [];
  if (request.instructions !== undefined) {
    messages.push({
      role: 'system',
      content: requestString(request.instructions, 'instructions'),
    });
  }
  messages.push(...responsesInputToMessages(request.input, { openReasoning }));

  const chat = {
    model,
    messages,
    stream: request.stream === true,
  };
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    throw invalidResponsesField('stream');
  }
  if (request.max_output_tokens !== undefined) {
    chat.max_tokens = optionalNumber(
      request.max_output_tokens,
      'max_output_tokens',
      (value) => Number.isInteger(value) && value > 0,
    );
  }
  if (request.temperature !== undefined) {
    chat.temperature = optionalNumber(
      request.temperature,
      'temperature',
      (value) => value >= 0 && value <= 2,
    );
  }
  if (request.top_p !== undefined) {
    chat.top_p = optionalNumber(
      request.top_p,
      'top_p',
      (value) => value >= 0 && value <= 1,
    );
  }
  if (request.reasoning !== undefined && request.reasoning !== null) {
    throw unsupportedResponsesField('reasoning');
  }
  if (request.include !== undefined) {
    if (!Array.isArray(request.include)) throw invalidResponsesField('include');
    const supported = typeof openReasoning === 'function'
      && request.include.length === 1
      && request.include[0] === 'reasoning.encrypted_content';
    if (request.include.length > 0 && !supported) throw unsupportedResponsesField('include');
  }
  if (request.store !== undefined) {
    if (typeof request.store !== 'boolean') throw invalidResponsesField('store');
    if (request.store) throw unsupportedResponsesField('store');
  }
  if (request.prompt_cache_key !== undefined) {
    chat.prompt_cache_key = requestString(request.prompt_cache_key, 'prompt_cache_key', false);
  }
  if (request.client_metadata !== undefined) {
    const metadata = cloneRequestJson(request.client_metadata, 'client_metadata');
    if (!isObject(metadata)) throw invalidResponsesField('client_metadata');
    chat.client_metadata = metadata;
  }

  let tools;
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) throw invalidResponsesField('tools');
    tools = responseToolsToChat(request.tools);
    const names = tools.map((tool) => tool.function.name);
    if (new Set(names).size !== names.length) throw invalidResponsesField('tools');
    chat.tools = tools;
  }
  if (request.tool_choice !== undefined) {
    const toolNames = new Set((tools || []).map((tool) => tool.function.name));
    if (toolNames.size === 0) throw invalidResponsesField('tool_choice');
    chat.tool_choice = responseToolChoiceToChat(request.tool_choice, toolNames);
  }
  if (request.parallel_tool_calls !== undefined) {
    if (typeof request.parallel_tool_calls !== 'boolean' || !tools || tools.length === 0) {
      throw invalidResponsesField('parallel_tool_calls');
    }
    chat.parallel_tool_calls = request.parallel_tool_calls;
  }
  return chat;
}

export function chatBodyWithDeveloperRoleAsSystem(chatBody) {
  if (!isObject(chatBody) || !Array.isArray(chatBody.messages)) return null;
  let changed = false;
  const messages = chatBody.messages.map((message) => {
    if (!isObject(message) || message.role !== 'developer') return message;
    changed = true;
    return { ...message, role: 'system' };
  });
  return changed ? { ...chatBody, messages } : null;
}

export function chatBodyWithMaxCompletionTokens(chatBody) {
  if (
    !isObject(chatBody)
    || !Object.hasOwn(chatBody, 'max_tokens')
    || Object.hasOwn(chatBody, 'max_completion_tokens')
  ) return null;
  const converted = {};
  for (const [name, value] of Object.entries(chatBody)) {
    converted[name === 'max_tokens' ? 'max_completion_tokens' : name] = value;
  }
  return converted;
}

export function chatErrorRequestsMaxCompletionTokens(status, payload) {
  if (status !== 400 && status !== 422) return false;
  const envelope = isObject(payload) ? payload : null;
  const error = isObject(envelope?.error) ? envelope.error : envelope;
  if (!error) return false;

  const param = String(error.param || '').trim().toLowerCase();
  const code = String(error.code || '').trim().toLowerCase();
  const message = String(error.message || '').toLowerCase();
  const targetsMaxTokens = param === 'max_tokens' || param === 'body.max_tokens';
  const explicitCode = UNSUPPORTED_TOKEN_PARAMETER_CODES.has(code);
  const explicitMessage = message.includes('max_tokens') && (
    message.includes('max_completion_tokens')
    || /\b(?:unsupported|unrecognized|unknown|unexpected|disallowed|forbidden)\b/.test(message)
    || /\bnot\s+(?:supported|allowed|accepted|permitted)\b/.test(message)
  );
  return explicitMessage || (targetsMaxTokens && explicitCode);
}

function chatObject(value, param) {
  if (!isObject(value)) throw invalidChatCompletion(param);
  return value;
}

function chatExact(value, allowed, param) {
  const object = chatObject(value, param);
  const key = unknownKey(object, allowed);
  if (key !== null) throw invalidChatCompletion(param ? `${param}.${key}` : key);
  return object;
}

function chatString(value, param, allowEmpty = true) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw invalidChatCompletion(param);
  }
  return value;
}

function chatArguments(value, param) {
  const raw = chatString(value, param);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidChatCompletion(param);
  }
  if (!isObject(parsed)) throw invalidChatCompletion(param);
  return raw;
}

function messageItemId(responseId) {
  const suffix = responseId.startsWith('resp_') ? responseId.slice(5) : responseId;
  return `msg_${suffix}`;
}

function reasoningItemId(responseId) {
  const suffix = responseId.startsWith('resp_') ? responseId.slice(5) : responseId;
  return `rs_${suffix}`;
}

function sealedChatReasoning(responseId, value, sealReasoning, invalid) {
  if (typeof value !== 'string' || value.length === 0 || typeof sealReasoning !== 'function') {
    throw invalid();
  }
  let encrypted;
  try { encrypted = sealReasoning({ sourceProtocol: 'chat', item: value }); } catch { throw invalid(); }
  if (typeof encrypted !== 'string' || encrypted.length === 0) throw invalid();
  return {
    id: reasoningItemId(responseId),
    type: 'reasoning',
    summary: [],
    encrypted_content: encrypted,
  };
}

function completedMessageItem(responseId, text, status = 'completed') {
  return {
    id: messageItemId(responseId),
    type: 'message',
    status,
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

function completedToolItem(rawCall, path, usedIds) {
  const call = chatExact(rawCall, CHAT_TOOL_CALL_FIELDS, path);
  const id = chatString(call.id, `${path}.id`, false);
  if (usedIds.has(id)) throw invalidChatCompletion(`${path}.id`);
  usedIds.add(id);
  if (call.type !== 'function') throw invalidChatCompletion(`${path}.type`);
  const fn = chatExact(call.function, CHAT_FUNCTION_FIELDS, `${path}.function`);
  const name = chatString(fn.name, `${path}.function.name`, false);
  if (!FUNCTION_NAME.test(name)) throw invalidChatCompletion(`${path}.function.name`);
  return {
    type: 'function_call',
    id: `fc_${id}`,
    call_id: id,
    name,
    arguments: chatArguments(fn.arguments, `${path}.function.arguments`),
    status: 'completed',
  };
}

function validateResponseContext(context) {
  if (!isObject(context)) throw invalidChatCompletion('context');
  return {
    id: chatString(context.id, 'context.id', false),
    model: chatString(context.model, 'context.model', false),
  };
}

export function chatCompletionToResponse(chat, context, { sealReasoning } = {}) {
  const completion = chatExact(chat, CHAT_COMPLETION_FIELDS, '');
  if (completion.object !== 'chat.completion') throw invalidChatCompletion('object');
  if (!Array.isArray(completion.choices) || completion.choices.length !== 1) {
    throw invalidChatCompletion('choices');
  }
  if (completion.usage !== undefined && !isObject(completion.usage)) {
    throw invalidChatCompletion('usage');
  }
  const choice = chatExact(completion.choices[0], CHAT_CHOICE_FIELDS, 'choices[0]');
  if (choice.index !== 0) throw invalidChatCompletion('choices[0].index');
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    throw invalidChatCompletion('choices[0].logprobs');
  }
  const message = chatExact(choice.message, CHAT_MESSAGE_FIELDS, 'choices[0].message');
  if (message.role !== 'assistant') throw invalidChatCompletion('choices[0].message.role');
  if (message.refusal !== undefined && message.refusal !== null) {
    throw invalidChatCompletion('choices[0].message.refusal');
  }
  if (message.content !== null && typeof message.content !== 'string') {
    throw invalidChatCompletion('choices[0].message.content');
  }
  if (message.reasoning_content !== undefined && message.reasoning_content !== null
    && typeof message.reasoning_content !== 'string') {
    throw invalidChatCompletion('choices[0].message.reasoning_content');
  }
  const rawCalls = message.tool_calls === undefined ? [] : message.tool_calls;
  if (!Array.isArray(rawCalls)) throw invalidChatCompletion('choices[0].message.tool_calls');
  const usedIds = new Set();
  const toolItems = rawCalls.map((call, index) => completedToolItem(
    call,
    `choices[0].message.tool_calls[${index}]`,
    usedIds,
  ));
  if (choice.finish_reason === 'tool_calls' && toolItems.length === 0) {
    throw invalidChatCompletion('choices[0].finish_reason');
  }
  if (choice.finish_reason === 'stop' && toolItems.length !== 0) {
    throw invalidChatCompletion('choices[0].finish_reason');
  }
  if (choice.finish_reason === 'length' && toolItems.length !== 0) {
    throw invalidChatCompletion('choices[0].finish_reason');
  }
  if (!['stop', 'tool_calls', 'length'].includes(choice.finish_reason)) {
    throw invalidChatCompletion('choices[0].finish_reason');
  }

  const responseContext = validateResponseContext(context);
  const incomplete = choice.finish_reason === 'length';
  const itemStatus = incomplete ? 'incomplete' : 'completed';
  const output = [];
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
    output.push(sealedChatReasoning(
      responseContext.id,
      message.reasoning_content,
      sealReasoning,
      () => invalidChatCompletion('choices[0].message.reasoning_content'),
    ));
  }
  if (typeof message.content === 'string' && message.content.length > 0) {
    output.push(completedMessageItem(responseContext.id, message.content, itemStatus));
  }
  output.push(...toolItems);
  if (output.length === 0) output.push(completedMessageItem(responseContext.id, '', itemStatus));
  const response = {
    id: responseContext.id,
    object: 'response',
    status: incomplete ? 'incomplete' : 'completed',
    model: responseContext.model,
    output,
  };
  if (incomplete) response.incomplete_details = { reason: 'max_output_tokens' };
  return response;
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function sseObject(value, param) {
  if (!isObject(value)) throw invalidChatSse(param);
  return value;
}

function sseExact(value, allowed, param) {
  const object = sseObject(value, param);
  const key = unknownKey(object, allowed);
  if (key !== null) throw invalidChatSse(param ? `${param}.${key}` : key);
  return object;
}

function sseString(value, param, allowEmpty = true) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw invalidChatSse(param);
  }
  return value;
}

function validateCompletedArguments(value, param) {
  const raw = value || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidChatSse(param);
  }
  if (!isObject(parsed)) throw invalidChatSse(param);
  return raw;
}

export function createChatSseToResponses({
  id,
  model,
  maxFrameBytes,
  writeEvent,
  fail,
  sealReasoning,
}) {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('id must be a non-empty string');
  if (typeof model !== 'string' || model.length === 0) throw new TypeError('model must be a non-empty string');
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new TypeError('maxFrameBytes must be a positive integer');
  }
  if (typeof writeEvent !== 'function') throw new TypeError('writeEvent must be a function');
  if (typeof fail !== 'function') throw new TypeError('fail must be a function');
  if (typeof TextDecoder !== 'function') throw new TypeError('TextDecoder is unavailable');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let failed = false;
  let done = false;
  let ended = false;
  let started = false;
  let choiceFinished = null;
  let nextOutputIndex = 0;
  let textOutputIndex = null;
  let text = '';
  let reasoningOutputIndex = null;
  let reasoning = '';
  const tools = new Map();
  const callIds = new Map();

  function failOnce(error) {
    if (failed || done) return;
    failed = true;
    buffer = '';
    fail(error);
  }

  function emit(event, data) {
    writeEvent(event, { type: event, ...data });
  }

  function ensureStarted() {
    if (started) return;
    started = true;
    emit('response.created', {
      response: {
        id,
        object: 'response',
        status: 'in_progress',
        model,
        output: [],
      },
    });
  }

  function ensureTextItem() {
    ensureStarted();
    if (textOutputIndex !== null) return textOutputIndex;
    textOutputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    emit('response.output_item.added', {
      output_index: textOutputIndex,
      item: {
        id: messageItemId(id),
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    emit('response.content_part.added', {
      output_index: textOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    });
    return textOutputIndex;
  }

  function ensureReasoningItem() {
    ensureStarted();
    if (reasoningOutputIndex !== null) return reasoningOutputIndex;
    reasoningOutputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    emit('response.output_item.added', {
      output_index: reasoningOutputIndex,
      item: {
        id: reasoningItemId(id),
        type: 'reasoning',
        summary: [],
      },
    });
    return reasoningOutputIndex;
  }

  function addTextDelta(delta) {
    if (delta.length === 0) return;
    const outputIndex = ensureTextItem();
    text += delta;
    emit('response.output_text.delta', {
      output_index: outputIndex,
      content_index: 0,
      delta,
    });
  }

  function addReasoningDelta(delta) {
    if (delta.length === 0) return;
    ensureReasoningItem();
    reasoning += delta;
  }

  function addToolDelta(rawDelta, path) {
    const delta = sseExact(rawDelta, CHAT_TOOL_DELTA_FIELDS, path);
    if (!Number.isInteger(delta.index) || delta.index < 0) {
      throw invalidChatSse(`${path}.index`);
    }
    let state = tools.get(delta.index);
    if (!state) {
      state = {
        chatIndex: delta.index,
        callId: '',
        name: '',
        arguments: '',
        outputIndex: null,
        itemId: '',
        added: false,
      };
      tools.set(delta.index, state);
    }
    if (delta.id !== undefined) {
      const callId = sseString(delta.id, `${path}.id`, false);
      const otherIndex = callIds.get(callId);
      if ((state.callId && state.callId !== callId)
        || (otherIndex !== undefined && otherIndex !== delta.index)) {
        throw invalidChatSse(`${path}.id`);
      }
      state.callId = callId;
      callIds.set(callId, delta.index);
    }
    if (delta.type !== undefined && delta.type !== 'function') {
      throw invalidChatSse(`${path}.type`);
    }
    let argumentDelta = '';
    if (delta.function !== undefined) {
      const fn = sseExact(delta.function, CHAT_FUNCTION_DELTA_FIELDS, `${path}.function`);
      if (fn.name !== undefined) {
        const name = sseString(fn.name, `${path}.function.name`, false);
        if (!FUNCTION_NAME.test(name) || (state.name && state.name !== name)) {
          throw invalidChatSse(`${path}.function.name`);
        }
        state.name = name;
      }
      if (fn.arguments !== undefined) {
        argumentDelta = sseString(fn.arguments, `${path}.function.arguments`);
        state.arguments += argumentDelta;
      }
      if (fn.name === undefined && fn.arguments === undefined) {
        throw invalidChatSse(`${path}.function`);
      }
    }
    if (delta.id === undefined && delta.type === undefined && delta.function === undefined) {
      throw invalidChatSse(path);
    }

    if (!state.added && state.callId && state.name) {
      ensureStarted();
      state.added = true;
      state.outputIndex = nextOutputIndex;
      nextOutputIndex += 1;
      state.itemId = `fc_${state.callId}`;
      emit('response.output_item.added', {
        output_index: state.outputIndex,
        item: {
          type: 'function_call',
          id: state.itemId,
          call_id: state.callId,
          name: state.name,
          arguments: '',
          status: 'in_progress',
        },
      });
      if (state.arguments.length > 0) {
        emit('response.function_call_arguments.delta', {
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta: state.arguments,
        });
      }
      return;
    }
    if (state.added && argumentDelta.length > 0) {
      emit('response.function_call_arguments.delta', {
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: argumentDelta,
      });
    }
  }

  function processChatChunk(rawChunk) {
    const chunk = sseExact(rawChunk, CHAT_CHUNK_FIELDS, 'data');
    if (chunk.object !== 'chat.completion.chunk') throw invalidChatSse('data.object');
    if (!Array.isArray(chunk.choices)) throw invalidChatSse('data.choices');
    if (chunk.choices.length === 0) {
      if (!isObject(chunk.usage)) throw invalidChatSse('data.choices');
      return;
    }
    if (chunk.choices.length !== 1 || choiceFinished !== null) {
      throw invalidChatSse('data.choices');
    }
    const choice = sseExact(chunk.choices[0], CHAT_STREAM_CHOICE_FIELDS, 'choices[0]');
    if (choice.index !== 0) throw invalidChatSse('choices[0].index');
    if (choice.logprobs !== undefined && choice.logprobs !== null) {
      throw invalidChatSse('choices[0].logprobs');
    }
    const delta = sseExact(choice.delta, CHAT_DELTA_FIELDS, 'choices[0].delta');
    if (delta.role !== undefined && delta.role !== 'assistant') {
      throw invalidChatSse('choices[0].delta.role');
    }
    if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
      addReasoningDelta(sseString(
        delta.reasoning_content,
        'choices[0].delta.reasoning_content',
      ));
    }
    if (delta.content !== undefined && delta.content !== null) {
      addTextDelta(sseString(delta.content, 'choices[0].delta.content'));
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) {
        throw invalidChatSse('choices[0].delta.tool_calls');
      }
      delta.tool_calls.forEach((toolDelta, index) => addToolDelta(
        toolDelta,
        `choices[0].delta.tool_calls[${index}]`,
      ));
    }
    if (choice.finish_reason !== null) {
      if (!['stop', 'tool_calls', 'length'].includes(choice.finish_reason)) {
        throw invalidChatSse('choices[0].finish_reason');
      }
      choiceFinished = choice.finish_reason;
    }
  }

  function completedEntries() {
    const entries = [];
    if (reasoningOutputIndex !== null) {
      entries.push({
        outputIndex: reasoningOutputIndex,
        kind: 'reasoning',
        item: sealedChatReasoning(
          id,
          reasoning,
          sealReasoning,
          () => invalidChatSse('choices[0].delta.reasoning_content'),
        ),
      });
    }
    if (textOutputIndex !== null) {
      entries.push({
        outputIndex: textOutputIndex,
        kind: 'text',
        item: completedMessageItem(id, text),
      });
    }
    for (const state of tools.values()) {
      if (!state.added || !state.callId || !state.name || state.outputIndex === null) {
        throw invalidChatSse(`choices[0].delta.tool_calls[${state.chatIndex}]`);
      }
      const argsParam = `choices[0].delta.tool_calls[${state.chatIndex}].function.arguments`;
      const args = validateCompletedArguments(state.arguments, argsParam);
      entries.push({
        outputIndex: state.outputIndex,
        kind: 'tool',
        state,
        item: {
          type: 'function_call',
          id: state.itemId,
          call_id: state.callId,
          name: state.name,
          arguments: args,
          status: 'completed',
        },
      });
    }
    entries.sort((left, right) => left.outputIndex - right.outputIndex);
    return entries;
  }

  function complete() {
    if (choiceFinished === null) throw invalidChatSse('choices[0].finish_reason');
    if (choiceFinished === 'tool_calls' && tools.size === 0) {
      throw invalidChatSse('choices[0].finish_reason');
    }
    if (choiceFinished === 'stop' && tools.size !== 0) {
      throw invalidChatSse('choices[0].finish_reason');
    }
    if (choiceFinished === 'length' && tools.size !== 0) {
      throw invalidChatSse('choices[0].finish_reason');
    }
    const incomplete = choiceFinished === 'length';
    ensureStarted();
    if (textOutputIndex === null && reasoningOutputIndex === null && tools.size === 0) ensureTextItem();
    const entries = completedEntries();
    done = true;
    for (const entry of entries) {
      if (entry.kind === 'text') {
        if (incomplete) entry.item.status = 'incomplete';
        emit('response.output_text.done', {
          output_index: entry.outputIndex,
          content_index: 0,
          text,
        });
        emit('response.content_part.done', {
          output_index: entry.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text },
        });
      } else if (entry.kind === 'tool') {
        emit('response.function_call_arguments.done', {
          item_id: entry.item.id,
          output_index: entry.outputIndex,
          arguments: entry.item.arguments,
        });
      }
      emit('response.output_item.done', {
        output_index: entry.outputIndex,
        item: entry.item,
      });
    }
    const response = {
        id,
        object: 'response',
        status: incomplete ? 'incomplete' : 'completed',
        model,
        output: entries.map((entry) => entry.item),
    };
    if (incomplete) response.incomplete_details = { reason: 'max_output_tokens' };
    emit(incomplete ? 'response.incomplete' : 'response.completed', { response });
  }

  function processFrame(frame) {
    if (utf8ByteLength(frame) > maxFrameBytes) throw oversizedChatSse();
    const dataLines = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (rawLine.startsWith(':')) continue;
      if (rawLine.startsWith('data:')) {
        const data = rawLine.slice(5);
        dataLines.push(data.startsWith(' ') ? data.slice(1) : data);
        continue;
      }
      if (rawLine.trim().length !== 0) throw invalidChatSse('sse');
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      complete();
      return;
    }
    if (done) throw invalidChatSse('sse');
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw invalidChatSse('data');
    }
    processChatChunk(chunk);
  }

  function drainFrames() {
    while (!failed) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      processFrame(frame);
    }
    if (!failed && !done && utf8ByteLength(buffer) > maxFrameBytes) {
      throw oversizedChatSse();
    }
    if (done && buffer.trim().length !== 0) throw invalidChatSse('sse');
  }

  function feed(chunk) {
    if (failed || ended) return;
    if (done) {
      if ((typeof chunk === 'string' ? chunk : '').trim().length !== 0) {
        failOnce(invalidChatSse('sse'));
      }
      return;
    }
    try {
      if (typeof chunk === 'string') buffer += chunk;
      else if (chunk instanceof Uint8Array) buffer += decoder.decode(chunk, { stream: true });
      else throw invalidChatSse('chunk');
      drainFrames();
    } catch (error) {
      failOnce(error instanceof ResponsesCompatibilityError ? error : invalidChatSse('chunk'));
    }
  }

  function end() {
    if (failed || ended) return;
    ended = true;
    try {
      if (!done) {
        buffer += decoder.decode();
        drainFrames();
      }
      if (!done && buffer.trim().length === 0 && choiceFinished !== null) complete();
      if (!done || buffer.trim().length !== 0) throw invalidChatSse('sse');
    } catch (error) {
      failOnce(error instanceof ResponsesCompatibilityError ? error : invalidChatSse('chunk'));
    }
  }

  return { feed, end };
}

export { SUPPORTED_RESPONSE_FIELDS };
