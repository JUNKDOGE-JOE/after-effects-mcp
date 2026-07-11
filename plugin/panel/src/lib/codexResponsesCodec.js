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
]);

const MESSAGE_FIELDS = new Set(['type', 'role', 'content']);
const TEXT_PART_FIELDS = new Set(['type', 'text']);
const FUNCTION_CALL_FIELDS = new Set(['type', 'call_id', 'name', 'arguments']);
const FUNCTION_OUTPUT_FIELDS = new Set(['type', 'call_id', 'output']);
const FUNCTION_TOOL_FIELDS = new Set([
  'type',
  'name',
  'description',
  'parameters',
  'strict',
]);
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
const CHAT_MESSAGE_FIELDS = new Set(['role', 'content', 'tool_calls', 'refusal']);
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
const CHAT_DELTA_FIELDS = new Set(['role', 'content', 'tool_calls']);
const CHAT_TOOL_DELTA_FIELDS = new Set(['index', 'id', 'type', 'function']);
const CHAT_FUNCTION_DELTA_FIELDS = new Set(['name', 'arguments']);
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
    status: 400,
    code: 'unsupported_responses_field',
    param,
    message: `Unsupported Responses field: ${param}`,
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
  if (!isObject(value)) throw unsupportedResponsesField(param);
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
    throw unsupportedResponsesField(param);
  }
  return value;
}

function requestFunctionName(value, param) {
  const name = requestString(value, param, false);
  if (!FUNCTION_NAME.test(name)) throw unsupportedResponsesField(param);
  return name;
}

function cloneRequestJson(value, param, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw unsupportedResponsesField(param);
    return value;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    throw unsupportedResponsesField(param);
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
    throw unsupportedResponsesField(param);
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
    throw unsupportedResponsesField(param);
  }
  if (!isObject(parsed)) throw unsupportedResponsesField(param);
  return raw;
}

function messageText(content, param) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw unsupportedResponsesField(param);
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
    throw unsupportedResponsesField(`${path}.type`);
  }
  if (!['user', 'assistant', 'system'].includes(message.role)) {
    throw unsupportedResponsesField(`${path}.role`);
  }
  if (!Object.hasOwn(message, 'content')) {
    throw unsupportedResponsesField(`${path}.content`);
  }
  return {
    role: message.role,
    content: messageText(message.content, `${path}.content`),
  };
}

function responseFunctionCallToChat(item, path) {
  const call = requestExact(item, FUNCTION_CALL_FIELDS, path);
  if (call.type !== 'function_call') throw unsupportedResponsesField(`${path}.type`);
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
    throw unsupportedResponsesField(`${path}.type`);
  }
  const callId = requestString(output.call_id, `${path}.call_id`, false);
  if (!knownCallIds.has(callId) || usedCallIds.has(callId)) {
    throw unsupportedResponsesField(`${path}.call_id`);
  }
  usedCallIds.add(callId);
  return {
    role: 'tool',
    tool_call_id: callId,
    content: requestString(output.output, `${path}.output`),
  };
}

function responsesInputToMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) {
    throw unsupportedResponsesField('input');
  }

  const messages = [];
  const knownCallIds = new Set();
  const usedCallIds = new Set();
  let pendingCalls = [];

  function flushCalls() {
    if (pendingCalls.length === 0) return;
    messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = [];
  }

  input.forEach((rawItem, index) => {
    const path = `input[${index}]`;
    if (!isObject(rawItem)) throw unsupportedResponsesField(path);
    if (rawItem.type === 'function_call') {
      const call = responseFunctionCallToChat(rawItem, path);
      if (knownCallIds.has(call.id)) throw unsupportedResponsesField(`${path}.call_id`);
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
      messages.push(responseMessageToChat(rawItem, path));
      return;
    }
    throw unsupportedResponsesField(`${path}.type`);
  });
  flushCalls();
  return messages;
}

function responseToolToChat(rawTool, index) {
  const path = `tools[${index}]`;
  const tool = requestExact(rawTool, FUNCTION_TOOL_FIELDS, path);
  if (tool.type !== 'function') throw unsupportedResponsesField(`${path}.type`);
  const fn = {
    name: requestFunctionName(tool.name, `${path}.name`),
    parameters: cloneRequestJson(tool.parameters, `${path}.parameters`),
  };
  if (!isObject(fn.parameters)) throw unsupportedResponsesField(`${path}.parameters`);
  if (tool.description !== undefined) {
    fn.description = requestString(tool.description, `${path}.description`);
  }
  if (tool.strict !== undefined) {
    if (typeof tool.strict !== 'boolean') throw unsupportedResponsesField(`${path}.strict`);
    fn.strict = tool.strict;
  }
  return { type: 'function', function: fn };
}

function responseToolChoiceToChat(rawChoice, toolNames) {
  if (typeof rawChoice === 'string') {
    if (!['auto', 'none', 'required'].includes(rawChoice)) {
      throw unsupportedResponsesField('tool_choice');
    }
    return rawChoice;
  }
  const choice = requestExact(rawChoice, FUNCTION_CHOICE_FIELDS, 'tool_choice');
  if (choice.type !== 'function') throw unsupportedResponsesField('tool_choice.type');
  const name = requestFunctionName(choice.name, 'tool_choice.name');
  if (!toolNames.has(name)) throw unsupportedResponsesField('tool_choice.name');
  return { type: 'function', function: { name } };
}

function optionalNumber(value, param, predicate) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !predicate(value)) {
    throw unsupportedResponsesField(param);
  }
  return value;
}

export function responsesBodyToChatBody(body) {
  const request = requestExact(body, SUPPORTED_RESPONSE_FIELDS, '');
  const model = requestString(request.model, 'model', false);
  if (!Object.hasOwn(request, 'input')) throw unsupportedResponsesField('input');

  const messages = [];
  if (request.instructions !== undefined) {
    messages.push({
      role: 'system',
      content: requestString(request.instructions, 'instructions'),
    });
  }
  messages.push(...responsesInputToMessages(request.input));

  const chat = {
    model,
    messages,
    stream: request.stream === true,
  };
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    throw unsupportedResponsesField('stream');
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

  let tools;
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) throw unsupportedResponsesField('tools');
    tools = request.tools.map(responseToolToChat);
    const names = tools.map((tool) => tool.function.name);
    if (new Set(names).size !== names.length) throw unsupportedResponsesField('tools');
    chat.tools = tools;
  }
  if (request.tool_choice !== undefined) {
    const toolNames = new Set((tools || []).map((tool) => tool.function.name));
    if (toolNames.size === 0) throw unsupportedResponsesField('tool_choice');
    chat.tool_choice = responseToolChoiceToChat(request.tool_choice, toolNames);
  }
  if (request.parallel_tool_calls !== undefined) {
    if (typeof request.parallel_tool_calls !== 'boolean' || !tools || tools.length === 0) {
      throw unsupportedResponsesField('parallel_tool_calls');
    }
    chat.parallel_tool_calls = request.parallel_tool_calls;
  }
  return chat;
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

function completedMessageItem(responseId, text) {
  return {
    id: messageItemId(responseId),
    type: 'message',
    status: 'completed',
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

export function chatCompletionToResponse(chat, context) {
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
  if (!['stop', 'tool_calls'].includes(choice.finish_reason)) {
    throw invalidChatCompletion('choices[0].finish_reason');
  }

  const responseContext = validateResponseContext(context);
  const output = [];
  if (typeof message.content === 'string' && message.content.length > 0) {
    output.push(completedMessageItem(responseContext.id, message.content));
  }
  output.push(...toolItems);
  if (output.length === 0) output.push(completedMessageItem(responseContext.id, ''));
  return {
    id: responseContext.id,
    object: 'response',
    status: 'completed',
    model: responseContext.model,
    output,
  };
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
      if (!['stop', 'tool_calls'].includes(choice.finish_reason)) {
        throw invalidChatSse('choices[0].finish_reason');
      }
      choiceFinished = choice.finish_reason;
    }
  }

  function completedEntries() {
    const entries = [];
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
    ensureStarted();
    if (textOutputIndex === null && tools.size === 0) ensureTextItem();
    const entries = completedEntries();
    done = true;
    for (const entry of entries) {
      if (entry.kind === 'text') {
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
      } else {
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
    emit('response.completed', {
      response: {
        id,
        object: 'response',
        status: 'completed',
        model,
        output: entries.map((entry) => entry.item),
      },
    });
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
      if (!done || buffer.trim().length !== 0) throw invalidChatSse('sse');
    } catch (error) {
      failOnce(error instanceof ResponsesCompatibilityError ? error : invalidChatSse('chunk'));
    }
  }

  return { feed, end };
}

export { SUPPORTED_RESPONSE_FIELDS };
