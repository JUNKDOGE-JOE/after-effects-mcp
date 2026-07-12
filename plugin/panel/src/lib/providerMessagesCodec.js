const MESSAGE_BODY_FIELDS = new Set([
  'model',
  'max_tokens',
  'messages',
  'system',
  'stream',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
  'thinking',
  'output_config',
  'context_management',
]);
const MESSAGE_FIELDS = new Set(['role', 'content']);
const TEXT_BLOCK_FIELDS = new Set(['type', 'text', 'cache_control', 'citations']);
const IMAGE_BLOCK_FIELDS = new Set(['type', 'source', 'cache_control']);
const IMAGE_SOURCE_BASE64_FIELDS = new Set(['type', 'media_type', 'data']);
const IMAGE_SOURCE_URL_FIELDS = new Set(['type', 'url']);
const TOOL_USE_FIELDS = new Set(['type', 'id', 'name', 'input', 'cache_control', 'caller']);
const TOOL_RESULT_FIELDS = new Set(['type', 'tool_use_id', 'content', 'is_error', 'cache_control']);
const THINKING_BLOCK_FIELDS = new Set(['type', 'thinking', 'signature']);
const REDACTED_THINKING_FIELDS = new Set(['type', 'data']);
const CACHE_CONTROL_FIELDS = new Set(['type', 'ttl']);
const TOOL_FIELDS = new Set(['name', 'description', 'input_schema', 'strict', 'type', 'cache_control']);
const TOOL_CHOICE_AUTO_FIELDS = new Set(['type', 'disable_parallel_tool_use']);
const TOOL_CHOICE_TOOL_FIELDS = new Set(['type', 'name', 'disable_parallel_tool_use']);
const CONTEXT_MANAGEMENT_FIELDS = new Set(['edits']);
const CLEAR_THINKING_FIELDS = new Set(['type', 'keep']);
const METADATA_FIELDS = new Set(['user_id']);
const OUTPUT_CONFIG_FIELDS = new Set(['effort']);
const THINKING_ADAPTIVE_FIELDS = new Set(['type', 'display']);
const THINKING_DISABLED_FIELDS = new Set(['type']);
const RESPONSES_BODY_FIELDS = new Set([
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
const RESPONSES_MESSAGE_FIELDS = new Set(['type', 'id', 'status', 'role', 'content']);
const RESPONSES_TEXT_PART_FIELDS = new Set(['type', 'text']);
const RESPONSES_IMAGE_PART_FIELDS = new Set(['type', 'image_url', 'file_id', 'detail']);
const RESPONSES_FUNCTION_CALL_FIELDS = new Set(['type', 'id', 'call_id', 'name', 'arguments', 'status']);
const RESPONSES_FUNCTION_OUTPUT_FIELDS = new Set(['type', 'id', 'call_id', 'output', 'status']);
const RESPONSES_REASONING_FIELDS = new Set(['type', 'id', 'summary', 'encrypted_content', 'status']);
const RESPONSES_TOOL_FIELDS = new Set(['type', 'name', 'description', 'parameters', 'strict']);
const RESPONSES_NAMESPACE_TOOL_FIELDS = new Set(['type', 'name', 'description', 'tools']);
const RESPONSES_TOOL_CHOICE_FIELDS = new Set(['type', 'name']);
const RESPONSES_REASONING_CONFIG_FIELDS = new Set(['effort', 'summary']);
const CHAT_COMPLETION_FIELDS = new Set([
  'id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier',
]);
const CHAT_CHOICE_FIELDS = new Set(['index', 'message', 'finish_reason', 'logprobs']);
const CHAT_MESSAGE_FIELDS = new Set(['role', 'content', 'tool_calls', 'refusal', 'reasoning', 'reasoning_content']);
const CHAT_TOOL_CALL_FIELDS = new Set(['id', 'type', 'function']);
const CHAT_FUNCTION_FIELDS = new Set(['name', 'arguments']);
const CHAT_USAGE_FIELDS = new Set([
  'prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details',
  'input_tokens', 'output_tokens', 'input_tokens_details',
  'claude_cache_creation_5_m_tokens', 'claude_cache_creation_1_h_tokens',
]);
const CHAT_PROMPT_DETAILS_FIELDS = new Set(['cached_tokens', 'text_tokens', 'audio_tokens', 'image_tokens']);
const CHAT_COMPLETION_DETAILS_FIELDS = new Set([
  'reasoning_tokens', 'text_tokens', 'audio_tokens', 'image_tokens',
  'accepted_prediction_tokens', 'rejected_prediction_tokens',
]);
const CHAT_INPUT_DETAILS_FIELDS = new Set(['cached_tokens']);
const RESPONSE_FIELDS = new Set([
  'id',
  'object',
  'status',
  'model',
  'output',
  'usage',
  'incomplete_details',
  'error',
  'created_at',
  'completed_at',
  'instructions',
  'metadata',
  'parallel_tool_calls',
  'temperature',
  'tool_choice',
  'tools',
  'top_p',
  'max_output_tokens',
  'previous_response_id',
  'reasoning',
  'service_tier',
  'store',
  'text',
  'truncation',
  'user',
]);
const RESPONSE_MESSAGE_FIELDS = new Set(['id', 'type', 'status', 'role', 'content']);
const RESPONSE_OUTPUT_TEXT_FIELDS = new Set(['type', 'text', 'annotations', 'logprobs']);
const RESPONSE_REFUSAL_FIELDS = new Set(['type', 'refusal']);
const RESPONSE_REASONING_ITEM_FIELDS = new Set(['type', 'id', 'summary', 'encrypted_content', 'status']);
const RESPONSE_SUMMARY_FIELDS = new Set(['type', 'text']);
const RESPONSE_FUNCTION_CALL_FIELDS = new Set(['type', 'id', 'call_id', 'name', 'arguments', 'status']);
const RESPONSE_USAGE_FIELDS = new Set([
  'input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details',
]);
const RESPONSE_INPUT_DETAILS_FIELDS = new Set(['cached_tokens']);
const RESPONSE_OUTPUT_DETAILS_FIELDS = new Set(['reasoning_tokens']);
const RESPONSE_INCOMPLETE_FIELDS = new Set(['reason']);
const ANTHROPIC_RESPONSE_FIELDS = new Set([
  'id',
  'type',
  'role',
  'model',
  'content',
  'stop_reason',
  'stop_sequence',
  'usage',
  'container',
  'context_management',
  'diagnostics',
  'stop_details',
]);
const ANTHROPIC_TEXT_RESPONSE_FIELDS = new Set(['type', 'text', 'citations']);
const ANTHROPIC_TOOL_RESPONSE_FIELDS = new Set(['type', 'id', 'name', 'input', 'caller']);
const ANTHROPIC_USAGE_FIELDS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cache_creation',
  'inference_geo',
  'iterations',
  'output_tokens_details',
  'server_tool_use',
  'service_tier',
  'speed',
]);
const ANTHROPIC_CACHE_CREATION_FIELDS = new Set([
  'ephemeral_1h_input_tokens',
  'ephemeral_5m_input_tokens',
]);
const ANTHROPIC_OUTPUT_DETAILS_FIELDS = new Set(['thinking_tokens']);
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const DEFAULT_MESSAGES_MAX_TOKENS = 32000;

export class ProviderMessagesCompatibilityError extends Error {
  constructor({ status, code, param, message }) {
    super(message);
    this.name = 'ProviderMessagesCompatibilityError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

function compatibilityError(status, code, param, label) {
  return new ProviderMessagesCompatibilityError({
    status,
    code,
    param,
    message: `${label}: ${param || 'body'}`,
  });
}

function invalidMessages(param) {
  return compatibilityError(400, 'invalid_messages_field', param, 'Invalid Messages field');
}

function unsupportedMessages(param) {
  return compatibilityError(501, 'unsupported_messages_field', param, 'Unsupported Messages field');
}

function invalidResponses(param) {
  return compatibilityError(400, 'invalid_responses_field', param, 'Invalid Responses field');
}

function unsupportedResponses(param) {
  return compatibilityError(501, 'unsupported_responses_field', param, 'Unsupported Responses field');
}

function invalidUpstream(protocol, param) {
  return compatibilityError(502, `invalid_${protocol}_response`, param, `Invalid ${protocol} response field`);
}

function unsupportedUpstream(protocol, param) {
  return compatibilityError(
    501,
    `unsupported_${protocol}_response_field`,
    param,
    `Unsupported ${protocol} response field`,
  );
}

function isObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKey(value, allowed) {
  return Object.keys(value).find((key) => !allowed.has(key)) || null;
}

function exactRequest(value, allowed, path, invalid, unsupported) {
  if (!isObject(value)) throw invalid(path);
  const key = unknownKey(value, allowed);
  if (key !== null) throw unsupported(path ? `${path}.${key}` : key);
  return value;
}

function exactUpstream(value, allowed, protocol, path) {
  if (!isObject(value)) throw invalidUpstream(protocol, path);
  const key = unknownKey(value, allowed);
  if (key !== null) throw invalidUpstream(protocol, path ? `${path}.${key}` : key);
  return value;
}

function nonemptyString(value, path, invalid) {
  if (typeof value !== 'string' || value.length === 0) throw invalid(path);
  return value;
}

function finiteNumber(value, path, invalid, predicate = () => true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !predicate(value)) throw invalid(path);
  return value;
}

function cloneJson(value, path, invalid, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(path);
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw invalid(path);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) => cloneJson(item, `${path}[${index}]`, invalid, seen));
  } else if (isObject(value)) {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = cloneJson(item, path ? `${path}.${key}` : key, invalid, seen);
    }
  } else {
    throw invalid(path);
  }
  seen.delete(value);
  return result;
}

function collector() {
  const paths = new Set();
  return {
    add(path) { paths.add(path); },
    values() { return Array.from(paths).sort(); },
  };
}

function consumeCacheControl(value, path, consumed, invalid = invalidMessages, unsupported = unsupportedMessages) {
  if (value === undefined) return;
  if (value === null) {
    consumed.add(path);
    return;
  }
  const cache = exactRequest(value, CACHE_CONTROL_FIELDS, path, invalid, unsupported);
  if (cache.type !== 'ephemeral') throw invalid(`${path}.type`);
  if (cache.ttl !== undefined && cache.ttl !== '5m' && cache.ttl !== '1h') {
    throw invalid(`${path}.ttl`);
  }
  consumed.add(path);
}

function validateFunctionName(value, path, invalid) {
  const name = nonemptyString(value, path, invalid);
  if (!FUNCTION_NAME.test(name)) throw invalid(path);
  return name;
}

function parseContextManagement(value, consumed) {
  if (value === undefined) return;
  const context = exactRequest(
    value,
    CONTEXT_MANAGEMENT_FIELDS,
    'context_management',
    invalidMessages,
    unsupportedMessages,
  );
  if (!Array.isArray(context.edits) || context.edits.length !== 1) {
    throw unsupportedMessages('context_management.edits');
  }
  const edit = exactRequest(
    context.edits[0],
    CLEAR_THINKING_FIELDS,
    'context_management.edits[0]',
    invalidMessages,
    unsupportedMessages,
  );
  if (typeof edit.type !== 'string') throw invalidMessages('context_management.edits[0].type');
  if (edit.type !== 'clear_thinking_20251015') {
    throw unsupportedMessages('context_management.edits[0].type');
  }
  if (edit.keep !== 'all') throw unsupportedMessages('context_management.edits[0].keep');
  consumed.add('context_management');
}

function parseMetadata(value, consumed) {
  if (value === undefined) return;
  const metadata = exactRequest(value, METADATA_FIELDS, 'metadata', invalidMessages, unsupportedMessages);
  if (metadata.user_id !== undefined && metadata.user_id !== null && typeof metadata.user_id !== 'string') {
    throw invalidMessages('metadata.user_id');
  }
  consumed.add('metadata');
}

function toOpenAiEffort(value, path, invalid) {
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw invalid(path);
  return value === 'max' ? 'xhigh' : value;
}

function toMessagesEffort(value, path) {
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
    throw invalidResponses(path);
  }
  if (value === 'none') return null;
  if (value === 'minimal') return 'low';
  return value === 'xhigh' ? 'max' : value;
}

function parseMessagesReasoning(request) {
  let enabled = null;
  let effort = null;
  if (request.thinking !== undefined) {
    if (!isObject(request.thinking)) throw invalidMessages('thinking');
    if (request.thinking.type === 'adaptive') {
      const thinking = exactRequest(
        request.thinking,
        THINKING_ADAPTIVE_FIELDS,
        'thinking',
        invalidMessages,
        unsupportedMessages,
      );
      if (thinking.display !== undefined && thinking.display !== null && thinking.display !== 'summarized') {
        throw unsupportedMessages('thinking.display');
      }
      enabled = true;
    } else if (request.thinking.type === 'disabled') {
      exactRequest(
        request.thinking,
        THINKING_DISABLED_FIELDS,
        'thinking',
        invalidMessages,
        unsupportedMessages,
      );
      enabled = false;
    } else if (typeof request.thinking.type !== 'string') {
      throw invalidMessages('thinking.type');
    } else {
      throw unsupportedMessages('thinking.type');
    }
  }
  if (request.output_config !== undefined) {
    const config = exactRequest(
      request.output_config,
      OUTPUT_CONFIG_FIELDS,
      'output_config',
      invalidMessages,
      unsupportedMessages,
    );
    if (config.effort !== undefined && config.effort !== null) {
      effort = toOpenAiEffort(config.effort, 'output_config.effort', invalidMessages);
      if (enabled === false) throw unsupportedMessages('output_config.effort');
      enabled = true;
    }
  }
  if (enabled === null) return null;
  return { enabled, effort: effort || (enabled ? 'high' : 'none') };
}

function parseAnthropicImage(block, path, consumed) {
  const image = exactRequest(block, IMAGE_BLOCK_FIELDS, path, invalidMessages, unsupportedMessages);
  if (image.type !== 'image') throw invalidMessages(`${path}.type`);
  consumeCacheControl(image.cache_control, `${path}.cache_control`, consumed);
  if (!isObject(image.source)) throw invalidMessages(`${path}.source`);
  if (image.source.type === 'base64') {
    const source = exactRequest(
      image.source,
      IMAGE_SOURCE_BASE64_FIELDS,
      `${path}.source`,
      invalidMessages,
      unsupportedMessages,
    );
    if (!IMAGE_MEDIA_TYPES.has(source.media_type)) throw invalidMessages(`${path}.source.media_type`);
    const data = nonemptyString(source.data, `${path}.source.data`, invalidMessages);
    return { kind: 'image', url: `data:${source.media_type};base64,${data}` };
  }
  if (image.source.type === 'url') {
    const source = exactRequest(
      image.source,
      IMAGE_SOURCE_URL_FIELDS,
      `${path}.source`,
      invalidMessages,
      unsupportedMessages,
    );
    return { kind: 'image', url: nonemptyString(source.url, `${path}.source.url`, invalidMessages) };
  }
  if (typeof image.source.type !== 'string') throw invalidMessages(`${path}.source.type`);
  throw unsupportedMessages(`${path}.source.type`);
}

function parseToolResultContent(value, path, consumed) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw invalidMessages(path);
  return value.map((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(raw)) throw invalidMessages(itemPath);
    if (raw.type !== 'text') throw unsupportedMessages(`${itemPath}.type`);
    const block = exactRequest(raw, TEXT_BLOCK_FIELDS, itemPath, invalidMessages, unsupportedMessages);
    consumeCacheControl(block.cache_control, `${itemPath}.cache_control`, consumed);
    if (block.citations !== undefined && block.citations !== null && block.citations.length !== 0) {
      throw unsupportedMessages(`${itemPath}.citations`);
    }
    if (block.citations !== undefined) consumed.add(`${itemPath}.citations`);
    if (typeof block.text !== 'string') throw invalidMessages(`${itemPath}.text`);
    return block.text;
  }).join('');
}

function openReasoningBlock(block, path, sourceProtocol, openReasoning) {
  let token;
  let visibleThinking = null;
  if (block.type === 'thinking') {
    const thinking = exactRequest(
      block,
      THINKING_BLOCK_FIELDS,
      path,
      invalidMessages,
      unsupportedMessages,
    );
    visibleThinking = nonemptyString(thinking.thinking, `${path}.thinking`, invalidMessages);
    token = nonemptyString(thinking.signature, `${path}.signature`, invalidMessages);
  } else {
    const redacted = exactRequest(
      block,
      REDACTED_THINKING_FIELDS,
      path,
      invalidMessages,
      unsupportedMessages,
    );
    token = nonemptyString(redacted.data, `${path}.data`, invalidMessages);
  }
  if (typeof openReasoning !== 'function') throw unsupportedMessages(`${path}.type`);
  let opened;
  try { opened = openReasoning(token, { sourceProtocol }); } catch { throw unsupportedMessages(`${path}.${block.type === 'thinking' ? 'signature' : 'data'}`); }
  if (!isObject(opened) || opened.sourceProtocol !== sourceProtocol) {
    throw unsupportedMessages(`${path}.type`);
  }
  if (sourceProtocol === 'chat') {
    if (typeof opened.item !== 'string') throw unsupportedMessages(`${path}.type`);
    if (visibleThinking !== null && visibleThinking !== opened.item) throw invalidMessages(`${path}.thinking`);
    return { kind: 'reasoning', value: opened.item };
  }
  if (!isObject(opened.item) || opened.item.type !== 'reasoning') {
    throw unsupportedMessages(`${path}.type`);
  }
  if (visibleThinking !== null) {
    const summary = Array.isArray(opened.item.summary)
      ? opened.item.summary
        .filter((item) => isObject(item) && item.type === 'summary_text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n')
      : '';
    if (summary !== visibleThinking) throw invalidMessages(`${path}.thinking`);
  }
  return { kind: 'reasoning', value: cloneJson(opened.item, path, invalidMessages) };
}

function parseMessageContent(content, path, role, sourceProtocol, openReasoning, consumed) {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) throw invalidMessages(path);
  return content.map((rawBlock, index) => {
    const blockPath = `${path}[${index}]`;
    if (!isObject(rawBlock)) throw invalidMessages(blockPath);
    if (rawBlock.type === 'text') {
      const block = exactRequest(rawBlock, TEXT_BLOCK_FIELDS, blockPath, invalidMessages, unsupportedMessages);
      consumeCacheControl(block.cache_control, `${blockPath}.cache_control`, consumed);
      if (block.citations !== undefined && block.citations !== null && block.citations.length !== 0) {
        throw unsupportedMessages(`${blockPath}.citations`);
      }
      if (block.citations !== undefined) consumed.add(`${blockPath}.citations`);
      return { kind: 'text', text: typeof block.text === 'string' ? block.text : (() => { throw invalidMessages(`${blockPath}.text`); })() };
    }
    if (rawBlock.type === 'image') {
      if (role !== 'user') throw unsupportedMessages(`${blockPath}.type`);
      return parseAnthropicImage(rawBlock, blockPath, consumed);
    }
    if (rawBlock.type === 'tool_use') {
      if (role !== 'assistant') throw invalidMessages(`${blockPath}.type`);
      const block = exactRequest(rawBlock, TOOL_USE_FIELDS, blockPath, invalidMessages, unsupportedMessages);
      if (block.caller !== undefined) throw unsupportedMessages(`${blockPath}.caller`);
      consumeCacheControl(block.cache_control, `${blockPath}.cache_control`, consumed);
      const id = nonemptyString(block.id, `${blockPath}.id`, invalidMessages);
      const name = validateFunctionName(block.name, `${blockPath}.name`, invalidMessages);
      const input = cloneJson(block.input, `${blockPath}.input`, invalidMessages);
      if (!isObject(input)) throw invalidMessages(`${blockPath}.input`);
      return { kind: 'tool_use', id, name, input };
    }
    if (rawBlock.type === 'tool_result') {
      if (role !== 'user') throw invalidMessages(`${blockPath}.type`);
      const block = exactRequest(rawBlock, TOOL_RESULT_FIELDS, blockPath, invalidMessages, unsupportedMessages);
      consumeCacheControl(block.cache_control, `${blockPath}.cache_control`, consumed);
      const id = nonemptyString(block.tool_use_id, `${blockPath}.tool_use_id`, invalidMessages);
      if (block.is_error !== undefined && typeof block.is_error !== 'boolean') {
        throw invalidMessages(`${blockPath}.is_error`);
      }
      if (block.is_error !== undefined) consumed.add(`${blockPath}.is_error`);
      const output = parseToolResultContent(block.content, `${blockPath}.content`, consumed);
      return {
        kind: 'tool_result',
        id,
        output: block.is_error === true ? `[tool_error]\n${output}` : output,
      };
    }
    if (rawBlock.type === 'thinking' || rawBlock.type === 'redacted_thinking') {
      if (role !== 'assistant') throw invalidMessages(`${blockPath}.type`);
      return openReasoningBlock(rawBlock, blockPath, sourceProtocol, openReasoning);
    }
    if (typeof rawBlock.type !== 'string') throw invalidMessages(`${blockPath}.type`);
    throw unsupportedMessages(`${blockPath}.type`);
  });
}

function parseSystem(value, consumed) {
  if (value === undefined) return [];
  if (typeof value === 'string') return [{ role: 'system', blocks: [{ kind: 'text', text: value }] }];
  if (!Array.isArray(value)) throw invalidMessages('system');
  return value.map((raw, index) => {
    const path = `system[${index}]`;
    if (!isObject(raw)) throw invalidMessages(path);
    if (raw.type !== 'text') {
      if (typeof raw.type !== 'string') throw invalidMessages(`${path}.type`);
      throw unsupportedMessages(`${path}.type`);
    }
    const block = exactRequest(raw, TEXT_BLOCK_FIELDS, path, invalidMessages, unsupportedMessages);
    consumeCacheControl(block.cache_control, `${path}.cache_control`, consumed);
    if (block.citations !== undefined && block.citations !== null && block.citations.length !== 0) {
      throw unsupportedMessages(`${path}.citations`);
    }
    if (block.citations !== undefined) consumed.add(`${path}.citations`);
    if (typeof block.text !== 'string') throw invalidMessages(`${path}.text`);
    return {
      role: 'system',
      blocks: [{ kind: 'text', text: block.text }],
    };
  });
}

function parseMessages(value, sourceProtocol, openReasoning, consumed) {
  if (!Array.isArray(value) || value.length === 0) throw invalidMessages('messages');
  return value.map((raw, index) => {
    const path = `messages[${index}]`;
    const message = exactRequest(raw, MESSAGE_FIELDS, path, invalidMessages, unsupportedMessages);
    if (!['user', 'assistant', 'system'].includes(message.role)) throw invalidMessages(`${path}.role`);
    if (!Object.hasOwn(message, 'content')) throw invalidMessages(`${path}.content`);
    return {
      role: message.role,
      path,
      blocks: parseMessageContent(
        message.content,
        `${path}.content`,
        message.role,
        sourceProtocol,
        openReasoning,
        consumed,
      ),
    };
  });
}

function parseTools(value, consumed) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidMessages('tools');
  const names = new Set();
  return value.map((raw, index) => {
    const path = `tools[${index}]`;
    const tool = exactRequest(raw, TOOL_FIELDS, path, invalidMessages, unsupportedMessages);
    if (tool.type !== undefined && tool.type !== null && tool.type !== 'custom') {
      throw unsupportedMessages(`${path}.type`);
    }
    const name = validateFunctionName(tool.name, `${path}.name`, invalidMessages);
    if (names.has(name)) throw invalidMessages(`${path}.name`);
    names.add(name);
    const schema = cloneJson(tool.input_schema, `${path}.input_schema`, invalidMessages);
    if (!isObject(schema)) throw invalidMessages(`${path}.input_schema`);
    if (tool.description !== undefined && typeof tool.description !== 'string') {
      throw invalidMessages(`${path}.description`);
    }
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean') throw invalidMessages(`${path}.strict`);
    consumeCacheControl(tool.cache_control, `${path}.cache_control`, consumed);
    return {
      name,
      description: tool.description,
      parameters: schema,
      strict: tool.strict,
    };
  });
}

function parseToolChoice(value, toolNames) {
  if (value === undefined) return { choice: undefined, parallel: undefined };
  if (!isObject(value)) throw invalidMessages('tool_choice');
  let choice;
  if (value.type === 'auto' || value.type === 'any') {
    const selected = exactRequest(
      value,
      TOOL_CHOICE_AUTO_FIELDS,
      'tool_choice',
      invalidMessages,
      unsupportedMessages,
    );
    choice = value.type === 'any' ? 'required' : 'auto';
    if (selected.disable_parallel_tool_use !== undefined
      && typeof selected.disable_parallel_tool_use !== 'boolean') {
      throw invalidMessages('tool_choice.disable_parallel_tool_use');
    }
    return {
      choice,
      parallel: selected.disable_parallel_tool_use === undefined
        ? undefined
        : !selected.disable_parallel_tool_use,
    };
  }
  if (value.type === 'none') {
    exactRequest(value, new Set(['type']), 'tool_choice', invalidMessages, unsupportedMessages);
    return { choice: 'none', parallel: undefined };
  }
  if (value.type === 'tool') {
    const selected = exactRequest(
      value,
      TOOL_CHOICE_TOOL_FIELDS,
      'tool_choice',
      invalidMessages,
      unsupportedMessages,
    );
    const name = validateFunctionName(selected.name, 'tool_choice.name', invalidMessages);
    if (!toolNames.has(name)) throw invalidMessages('tool_choice.name');
    if (selected.disable_parallel_tool_use !== undefined
      && typeof selected.disable_parallel_tool_use !== 'boolean') {
      throw invalidMessages('tool_choice.disable_parallel_tool_use');
    }
    return {
      choice: { type: 'function', name },
      parallel: selected.disable_parallel_tool_use === undefined
        ? undefined
        : !selected.disable_parallel_tool_use,
    };
  }
  if (typeof value.type !== 'string') throw invalidMessages('tool_choice.type');
  throw unsupportedMessages('tool_choice.type');
}

function normalizeMessagesRequest(body, sourceProtocol, openReasoning) {
  const consumed = collector();
  const request = exactRequest(body, MESSAGE_BODY_FIELDS, '', invalidMessages, unsupportedMessages);
  const model = nonemptyString(request.model, 'model', invalidMessages);
  const maxTokens = finiteNumber(
    request.max_tokens,
    'max_tokens',
    invalidMessages,
    (value) => Number.isInteger(value) && value > 0,
  );
  if (request.stream !== undefined && typeof request.stream !== 'boolean') throw invalidMessages('stream');
  if (request.temperature !== undefined) finiteNumber(request.temperature, 'temperature', invalidMessages, (v) => v >= 0 && v <= 2);
  if (request.top_p !== undefined) finiteNumber(request.top_p, 'top_p', invalidMessages, (v) => v >= 0 && v <= 1);
  if (request.top_k !== undefined) throw unsupportedMessages('top_k');
  if (request.stop_sequences !== undefined) {
    if (!Array.isArray(request.stop_sequences)) throw invalidMessages('stop_sequences');
    request.stop_sequences.forEach((value, index) => nonemptyString(value, `stop_sequences[${index}]`, invalidMessages));
  }
  parseContextManagement(request.context_management, consumed);
  parseMetadata(request.metadata, consumed);
  const system = parseSystem(request.system, consumed);
  const messages = parseMessages(request.messages, sourceProtocol, openReasoning, consumed);
  const tools = parseTools(request.tools, consumed);
  const toolChoice = parseToolChoice(request.tool_choice, new Set(tools.map((tool) => tool.name)));
  if (request.tool_choice !== undefined && tools.length === 0) throw invalidMessages('tool_choice');
  return {
    request,
    model,
    maxTokens,
    system,
    messages,
    tools,
    toolChoice,
    reasoning: parseMessagesReasoning(request),
    consumed,
  };
}

function chatContent(blocks) {
  const contentBlocks = blocks.filter((block) => block.kind === 'text' || block.kind === 'image');
  if (!contentBlocks.some((block) => block.kind === 'image')) {
    return contentBlocks.map((block) => block.text).join('');
  }
  return contentBlocks.map((block) => block.kind === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'image_url', image_url: { url: block.url } });
}

function responsesMessage(role, blocks) {
  const parts = blocks
    .filter((block) => block.kind === 'text' || block.kind === 'image')
    .map((block) => {
      if (block.kind === 'image') return { type: 'input_image', image_url: block.url };
      return { type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text };
    });
  return { type: 'message', role, content: parts };
}

function assertToolResultOrder(entry) {
  let sawOrdinary = false;
  for (let index = 0; index < entry.blocks.length; index += 1) {
    const block = entry.blocks[index];
    if (block.kind === 'tool_result' && sawOrdinary) {
      throw unsupportedMessages(`${entry.path}.content[${index}].type`);
    }
    if (block.kind !== 'tool_result') sawOrdinary = true;
  }
}

function chatToolDefinition(tool) {
  const fn = { name: tool.name, parameters: tool.parameters };
  if (tool.description !== undefined) fn.description = tool.description;
  if (tool.strict !== undefined) fn.strict = tool.strict;
  return { type: 'function', function: fn };
}

function responsesToolDefinition(tool) {
  const result = { type: 'function', name: tool.name, parameters: tool.parameters };
  if (tool.description !== undefined) result.description = tool.description;
  if (tool.strict !== undefined) result.strict = tool.strict;
  return result;
}

export function messagesBodyToChatBody(body, { openReasoning } = {}) {
  const normalized = normalizeMessagesRequest(body, 'chat', openReasoning);
  const messages = [];
  const knownCalls = new Set();
  for (const system of normalized.system) {
    messages.push({ role: 'system', content: chatContent(system.blocks) });
  }
  for (const entry of normalized.messages) {
    if (entry.role === 'system') {
      if (entry.blocks.some((block) => block.kind !== 'text')) throw unsupportedMessages(`${entry.path}.content`);
      messages.push({ role: 'system', content: chatContent(entry.blocks) });
      continue;
    }
    if (entry.role === 'assistant') {
      const reasoning = entry.blocks.filter((block) => block.kind === 'reasoning');
      if (reasoning.length > 1) throw unsupportedMessages(`${entry.path}.content`);
      const calls = entry.blocks.filter((block) => block.kind === 'tool_use').map((block) => {
        if (knownCalls.has(block.id)) throw invalidMessages(`${entry.path}.content`);
        knownCalls.add(block.id);
        return {
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        };
      });
      const unsupported = entry.blocks.find((block) => !['text', 'reasoning', 'tool_use'].includes(block.kind));
      if (unsupported) throw unsupportedMessages(`${entry.path}.content`);
      const chat = { role: 'assistant', content: chatContent(entry.blocks) || null };
      if (reasoning.length === 1) chat.reasoning_content = reasoning[0].value;
      if (calls.length) chat.tool_calls = calls;
      messages.push(chat);
      continue;
    }
    assertToolResultOrder(entry);
    const results = entry.blocks.filter((block) => block.kind === 'tool_result');
    for (const result of results) {
      if (!knownCalls.has(result.id)) throw invalidMessages(`${entry.path}.content`);
      messages.push({ role: 'tool', tool_call_id: result.id, content: result.output });
    }
    const ordinary = entry.blocks.filter((block) => block.kind !== 'tool_result');
    if (ordinary.length) messages.push({ role: 'user', content: chatContent(ordinary) });
  }

  const chat = {
    model: normalized.model,
    messages,
    max_tokens: normalized.maxTokens,
    stream: normalized.request.stream === true,
  };
  if (normalized.request.temperature !== undefined) chat.temperature = normalized.request.temperature;
  if (normalized.request.top_p !== undefined) chat.top_p = normalized.request.top_p;
  if (normalized.request.stop_sequences !== undefined && normalized.request.stop_sequences.length) {
    chat.stop = [...normalized.request.stop_sequences];
  }
  if (normalized.tools.length) chat.tools = normalized.tools.map(chatToolDefinition);
  if (normalized.toolChoice.choice !== undefined) {
    chat.tool_choice = isObject(normalized.toolChoice.choice)
      ? { type: 'function', function: { name: normalized.toolChoice.choice.name } }
      : normalized.toolChoice.choice;
  }
  if (normalized.toolChoice.parallel !== undefined) chat.parallel_tool_calls = normalized.toolChoice.parallel;
  if (normalized.reasoning) chat.reasoning_effort = normalized.reasoning.effort;
  return { body: chat, consumed: normalized.consumed.values() };
}

export function messagesBodyToResponsesBody(body, { openReasoning } = {}) {
  const normalized = normalizeMessagesRequest(body, 'responses', openReasoning);
  if (normalized.request.stop_sequences !== undefined && normalized.request.stop_sequences.length) {
    throw unsupportedMessages('stop_sequences');
  }
  const input = [];
  const knownCalls = new Set();
  for (const system of normalized.system) input.push(responsesMessage('system', system.blocks));
  for (const entry of normalized.messages) {
    if (entry.role === 'system') {
      if (entry.blocks.some((block) => block.kind !== 'text')) throw unsupportedMessages(`${entry.path}.content`);
      input.push(responsesMessage('system', entry.blocks));
      continue;
    }
    if (entry.role === 'assistant') {
      let textBlocks = [];
      const flushText = () => {
        if (!textBlocks.length) return;
        input.push(responsesMessage('assistant', textBlocks));
        textBlocks = [];
      };
      for (const block of entry.blocks) {
        if (block.kind === 'text') {
          textBlocks.push(block);
        } else if (block.kind === 'reasoning') {
          flushText();
          input.push(block.value);
        } else if (block.kind === 'tool_use') {
          flushText();
          if (knownCalls.has(block.id)) throw invalidMessages(`${entry.path}.content`);
          knownCalls.add(block.id);
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
            status: 'completed',
          });
        } else {
          throw unsupportedMessages(`${entry.path}.content`);
        }
      }
      flushText();
      continue;
    }
    assertToolResultOrder(entry);
    for (const block of entry.blocks.filter((item) => item.kind === 'tool_result')) {
      if (!knownCalls.has(block.id)) throw invalidMessages(`${entry.path}.content`);
      input.push({
        type: 'function_call_output',
        call_id: block.id,
        output: block.output,
        status: 'completed',
      });
    }
    const ordinary = entry.blocks.filter((block) => block.kind !== 'tool_result');
    if (ordinary.length) input.push(responsesMessage('user', ordinary));
  }
  const response = {
    model: normalized.model,
    input,
    max_output_tokens: normalized.maxTokens,
    stream: normalized.request.stream === true,
  };
  if (normalized.request.temperature !== undefined) response.temperature = normalized.request.temperature;
  if (normalized.request.top_p !== undefined) response.top_p = normalized.request.top_p;
  if (normalized.tools.length) response.tools = normalized.tools.map(responsesToolDefinition);
  if (normalized.toolChoice.choice !== undefined) response.tool_choice = normalized.toolChoice.choice;
  if (normalized.toolChoice.parallel !== undefined) response.parallel_tool_calls = normalized.toolChoice.parallel;
  if (normalized.reasoning) response.reasoning = { effort: normalized.reasoning.effort };
  return { body: response, consumed: normalized.consumed.values() };
}

function responseImageToAnthropic(part, path, consumed) {
  const image = exactRequest(
    part,
    RESPONSES_IMAGE_PART_FIELDS,
    path,
    invalidResponses,
    unsupportedResponses,
  );
  if (image.type !== 'input_image') throw invalidResponses(`${path}.type`);
  if (image.file_id !== undefined && image.file_id !== null) throw unsupportedResponses(`${path}.file_id`);
  if (image.file_id !== undefined) consumed.add(`${path}.file_id`);
  if (image.detail !== undefined && image.detail !== null) {
    if (!['auto', 'low', 'high'].includes(image.detail)) throw invalidResponses(`${path}.detail`);
    consumed.add(`${path}.detail`);
  }
  const url = nonemptyString(image.image_url, `${path}.image_url`, invalidResponses);
  const data = url.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (data) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: data[1], data: data[2] },
    };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function responsesMessageContent(content, path, role, consumed) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw invalidResponses(path);
  return content.map((raw, index) => {
    const partPath = `${path}[${index}]`;
    if (!isObject(raw)) throw invalidResponses(partPath);
    if (raw.type === 'input_text' || raw.type === 'output_text') {
      const part = exactRequest(
        raw,
        RESPONSES_TEXT_PART_FIELDS,
        partPath,
        invalidResponses,
        unsupportedResponses,
      );
      return { type: 'text', text: typeof part.text === 'string' ? part.text : (() => { throw invalidResponses(`${partPath}.text`); })() };
    }
    if (raw.type === 'input_image') {
      if (role !== 'user') throw unsupportedResponses(`${partPath}.type`);
      return responseImageToAnthropic(raw, partPath, consumed);
    }
    if (typeof raw.type !== 'string') throw invalidResponses(`${partPath}.type`);
    throw unsupportedResponses(`${partPath}.type`);
  });
}

function openMessagesReasoning(item, path, openReasoning, consumed) {
  const reasoning = exactRequest(
    item,
    RESPONSES_REASONING_FIELDS,
    path,
    invalidResponses,
    unsupportedResponses,
  );
  if (reasoning.type !== 'reasoning') throw invalidResponses(`${path}.type`);
  if (!Array.isArray(reasoning.summary)) throw invalidResponses(`${path}.summary`);
  if (reasoning.summary.length !== 0) throw unsupportedResponses(`${path}.summary`);
  const token = nonemptyString(reasoning.encrypted_content, `${path}.encrypted_content`, invalidResponses);
  if (typeof openReasoning !== 'function') throw unsupportedResponses(`${path}.encrypted_content`);
  let opened;
  try { opened = openReasoning(token, { sourceProtocol: 'messages' }); } catch {
    throw unsupportedResponses(`${path}.encrypted_content`);
  }
  if (!isObject(opened) || opened.sourceProtocol !== 'messages' || !isObject(opened.item)) {
    throw unsupportedResponses(`${path}.encrypted_content`);
  }
  const rawBlock = cloneJson(opened.item, path, invalidResponses);
  if (rawBlock.type === 'thinking') {
    exactRequest(rawBlock, THINKING_BLOCK_FIELDS, path, invalidResponses, unsupportedResponses);
    nonemptyString(rawBlock.thinking, `${path}.thinking`, invalidResponses);
    nonemptyString(rawBlock.signature, `${path}.signature`, invalidResponses);
  } else if (rawBlock.type === 'redacted_thinking') {
    exactRequest(rawBlock, REDACTED_THINKING_FIELDS, path, invalidResponses, unsupportedResponses);
    nonemptyString(rawBlock.data, `${path}.data`, invalidResponses);
  } else {
    throw unsupportedResponses(`${path}.encrypted_content`);
  }
  for (const field of ['id', 'status', 'summary']) {
    if (reasoning[field] !== undefined) consumed.add(`${path}.${field}`);
  }
  return rawBlock;
}

function responseToolToMessages(raw, path, namespaceDescription = '') {
  const tool = exactRequest(
    raw,
    RESPONSES_TOOL_FIELDS,
    path,
    invalidResponses,
    unsupportedResponses,
  );
  if (tool.type !== 'function') throw unsupportedResponses(`${path}.type`);
  const name = validateFunctionName(tool.name, `${path}.name`, invalidResponses);
  const schema = cloneJson(tool.parameters, `${path}.parameters`, invalidResponses);
  if (!isObject(schema)) throw invalidResponses(`${path}.parameters`);
  const result = { name, input_schema: schema };
  const description = tool.description === undefined
    ? ''
    : (() => {
      if (typeof tool.description !== 'string') throw invalidResponses(`${path}.description`);
      return tool.description;
    })();
  if (namespaceDescription || description) {
    result.description = [namespaceDescription, description].filter(Boolean).join('\n\n');
  }
  if (tool.strict !== undefined) {
    if (typeof tool.strict !== 'boolean') throw invalidResponses(`${path}.strict`);
    result.strict = tool.strict;
  }
  return result;
}

function responsesToolsToMessages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidResponses('tools');
  const names = new Set();
  const converted = [];
  const addTool = (raw, path, namespaceDescription = '') => {
    const result = responseToolToMessages(raw, path, namespaceDescription);
    const { name } = result;
    if (names.has(name)) throw invalidResponses(`${path}.name`);
    names.add(name);
    converted.push(result);
  };
  value.forEach((raw, index) => {
    const path = `tools[${index}]`;
    if (!isObject(raw)) throw invalidResponses(path);
    if (raw.type === 'function') {
      addTool(raw, path);
      return;
    }
    if (raw.type !== 'namespace') throw unsupportedResponses(`${path}.type`);
    const namespace = exactRequest(
      raw,
      RESPONSES_NAMESPACE_TOOL_FIELDS,
      path,
      invalidResponses,
      unsupportedResponses,
    );
    const namespaceName = validateFunctionName(namespace.name, `${path}.name`, invalidResponses);
    const namespaceDescription = namespace.description === undefined
      ? namespaceName
      : (() => {
        if (typeof namespace.description !== 'string') throw invalidResponses(`${path}.description`);
        return namespace.description;
      })();
    if (!Array.isArray(namespace.tools) || namespace.tools.length === 0) {
      throw invalidResponses(`${path}.tools`);
    }
    namespace.tools.forEach((child, childIndex) => addTool(
      child,
      `${path}.tools[${childIndex}]`,
      namespaceDescription,
    ));
  });
  return converted;
}

function responsesToolChoiceToMessages(value, parallel, toolNames) {
  let choice;
  if (value === undefined) {
    if (parallel === false) choice = { type: 'auto', disable_parallel_tool_use: true };
  } else if (typeof value === 'string') {
    if (!['auto', 'none', 'required'].includes(value)) throw invalidResponses('tool_choice');
    choice = { type: value === 'required' ? 'any' : value };
  } else {
    const selected = exactRequest(
      value,
      RESPONSES_TOOL_CHOICE_FIELDS,
      'tool_choice',
      invalidResponses,
      unsupportedResponses,
    );
    if (selected.type !== 'function') throw unsupportedResponses('tool_choice.type');
    const name = validateFunctionName(selected.name, 'tool_choice.name', invalidResponses);
    if (!toolNames.has(name)) throw invalidResponses('tool_choice.name');
    choice = { type: 'tool', name };
  }
  if (parallel !== undefined) {
    if (typeof parallel !== 'boolean') throw invalidResponses('parallel_tool_calls');
    if (!choice) choice = { type: 'auto' };
    choice.disable_parallel_tool_use = !parallel;
  }
  return choice;
}

function responsesReasoningToMessages(value, consumed) {
  if (value === undefined || value === null) return {};
  const reasoning = exactRequest(
    value,
    RESPONSES_REASONING_CONFIG_FIELDS,
    'reasoning',
    invalidResponses,
    unsupportedResponses,
  );
  if (reasoning.summary !== undefined && reasoning.summary !== null && reasoning.summary !== 'auto') {
    throw unsupportedResponses('reasoning.summary');
  }
  if (reasoning.summary !== undefined) consumed.add('reasoning.summary');
  if (reasoning.effort === undefined || reasoning.effort === null) {
    return { thinking: { type: 'adaptive' } };
  }
  const effort = toMessagesEffort(reasoning.effort, 'reasoning.effort');
  if (effort === null) return { thinking: { type: 'disabled' } };
  return {
    thinking: { type: 'adaptive' },
    output_config: { effort },
  };
}

function pushOrMergeMessage(messages, role, blocks) {
  if (!blocks.length) return;
  const previous = messages[messages.length - 1];
  if (previous && previous.role === role && Array.isArray(previous.content)) {
    previous.content.push(...blocks);
  } else {
    messages.push({ role, content: [...blocks] });
  }
}

export function responsesBodyToMessagesBody(body, { openReasoning } = {}) {
  const consumed = collector();
  const request = exactRequest(
    body,
    RESPONSES_BODY_FIELDS,
    '',
    invalidResponses,
    unsupportedResponses,
  );
  const model = nonemptyString(request.model, 'model', invalidResponses);
  if (!Object.hasOwn(request, 'input')) throw invalidResponses('input');
  if (request.stream !== undefined && typeof request.stream !== 'boolean') throw invalidResponses('stream');
  if (request.temperature !== undefined) finiteNumber(request.temperature, 'temperature', invalidResponses, (v) => v >= 0 && v <= 2);
  if (request.top_p !== undefined) finiteNumber(request.top_p, 'top_p', invalidResponses, (v) => v >= 0 && v <= 1);
  let maxTokens = DEFAULT_MESSAGES_MAX_TOKENS;
  if (request.max_output_tokens !== undefined) {
    maxTokens = finiteNumber(
      request.max_output_tokens,
      'max_output_tokens',
      invalidResponses,
      (value) => Number.isInteger(value) && value > 0,
    );
  }
  if (request.include !== undefined) {
    if (!Array.isArray(request.include)
      || request.include.some((item) => item !== 'reasoning.encrypted_content')) {
      throw unsupportedResponses('include');
    }
    consumed.add('include');
  }
  if (request.store !== undefined) {
    if (typeof request.store !== 'boolean') throw invalidResponses('store');
    if (request.store) throw unsupportedResponses('store');
    consumed.add('store');
  }
  if (request.prompt_cache_key !== undefined) {
    nonemptyString(request.prompt_cache_key, 'prompt_cache_key', invalidResponses);
    consumed.add('prompt_cache_key');
  }
  if (request.client_metadata !== undefined) {
    const metadata = cloneJson(request.client_metadata, 'client_metadata', invalidResponses);
    if (!isObject(metadata)) throw invalidResponses('client_metadata');
    consumed.add('client_metadata');
  }

  const system = [];
  if (request.instructions !== undefined) {
    if (typeof request.instructions !== 'string') throw invalidResponses('instructions');
    system.push({ type: 'text', text: request.instructions });
  }
  const messages = [];
  const knownCalls = new Set();
  let pendingAssistant = [];
  let pendingToolResults = [];
  const flushAssistant = () => {
    pushOrMergeMessage(messages, 'assistant', pendingAssistant);
    pendingAssistant = [];
  };
  const flushToolResults = () => {
    pushOrMergeMessage(messages, 'user', pendingToolResults);
    pendingToolResults = [];
  };

  const rawInput = typeof request.input === 'string'
    ? [{ type: 'message', role: 'user', content: request.input }]
    : request.input;
  if (!Array.isArray(rawInput) || rawInput.length === 0) throw invalidResponses('input');
  rawInput.forEach((rawItem, index) => {
    const path = `input[${index}]`;
    if (!isObject(rawItem)) throw invalidResponses(path);
    if (rawItem.type === 'reasoning') {
      flushToolResults();
      pendingAssistant.push(openMessagesReasoning(rawItem, path, openReasoning, consumed));
      return;
    }
    if (rawItem.type === 'function_call') {
      flushToolResults();
      const call = exactRequest(
        rawItem,
        RESPONSES_FUNCTION_CALL_FIELDS,
        path,
        invalidResponses,
        unsupportedResponses,
      );
      if (call.status !== undefined && call.status !== 'completed') throw unsupportedResponses(`${path}.status`);
      const id = nonemptyString(call.call_id, `${path}.call_id`, invalidResponses);
      if (knownCalls.has(id)) throw invalidResponses(`${path}.call_id`);
      knownCalls.add(id);
      const name = validateFunctionName(call.name, `${path}.name`, invalidResponses);
      const args = nonemptyString(call.arguments, `${path}.arguments`, invalidResponses);
      let input;
      try { input = JSON.parse(args); } catch { throw invalidResponses(`${path}.arguments`); }
      if (!isObject(input)) throw invalidResponses(`${path}.arguments`);
      pendingAssistant.push({ type: 'tool_use', id, name, input });
      if (call.id !== undefined) consumed.add(`${path}.id`);
      if (call.status !== undefined) consumed.add(`${path}.status`);
      return;
    }
    if (rawItem.type === 'function_call_output') {
      flushAssistant();
      const output = exactRequest(
        rawItem,
        RESPONSES_FUNCTION_OUTPUT_FIELDS,
        path,
        invalidResponses,
        unsupportedResponses,
      );
      if (output.status !== undefined && output.status !== 'completed') throw unsupportedResponses(`${path}.status`);
      const id = nonemptyString(output.call_id, `${path}.call_id`, invalidResponses);
      if (!knownCalls.has(id)) throw invalidResponses(`${path}.call_id`);
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: typeof output.output === 'string'
          ? output.output
          : JSON.stringify(cloneJson(output.output, `${path}.output`, invalidResponses)),
      });
      if (output.id !== undefined) consumed.add(`${path}.id`);
      if (output.status !== undefined) consumed.add(`${path}.status`);
      return;
    }
    if (rawItem.type === undefined || rawItem.type === 'message') {
      flushAssistant();
      flushToolResults();
      const message = exactRequest(
        rawItem,
        RESPONSES_MESSAGE_FIELDS,
        path,
        invalidResponses,
        unsupportedResponses,
      );
      if (!['user', 'assistant', 'system', 'developer'].includes(message.role)) {
        throw invalidResponses(`${path}.role`);
      }
      if (!Object.hasOwn(message, 'content')) throw invalidResponses(`${path}.content`);
      if (message.id !== undefined) {
        nonemptyString(message.id, `${path}.id`, invalidResponses);
        consumed.add(`${path}.id`);
      }
      if (message.status !== undefined) {
        if (!['completed', 'incomplete'].includes(message.status)) throw invalidResponses(`${path}.status`);
        if (message.status !== 'completed') throw unsupportedResponses(`${path}.status`);
        consumed.add(`${path}.status`);
      }
      const role = message.role === 'developer' ? 'system' : message.role;
      const content = responsesMessageContent(message.content, `${path}.content`, role, consumed);
      if (role === 'system' && messages.length === 0) system.push(...content);
      else pushOrMergeMessage(messages, role, content);
      return;
    }
    if (typeof rawItem.type !== 'string') throw invalidResponses(`${path}.type`);
    throw unsupportedResponses(`${path}.type`);
  });
  flushAssistant();
  flushToolResults();
  if (messages.length === 0) throw invalidResponses('input');

  const tools = responsesToolsToMessages(request.tools);
  const toolChoice = responsesToolChoiceToMessages(
    request.tool_choice,
    request.parallel_tool_calls,
    new Set(tools.map((tool) => tool.name)),
  );
  if (toolChoice && tools.length === 0) throw invalidResponses('tool_choice');
  const result = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: request.stream === true,
  };
  if (system.length) result.system = system;
  if (request.temperature !== undefined) result.temperature = request.temperature;
  if (request.top_p !== undefined) result.top_p = request.top_p;
  if (tools.length) result.tools = tools;
  if (toolChoice) result.tool_choice = toolChoice;
  Object.assign(result, responsesReasoningToMessages(request.reasoning, consumed));
  return { body: result, consumed: consumed.values() };
}

function sealCapsule(sealReasoning, sourceProtocol, item, protocol, path) {
  if (typeof sealReasoning !== 'function') throw unsupportedUpstream(protocol, path);
  let token;
  try { token = sealReasoning({ sourceProtocol, item }); } catch { throw invalidUpstream(protocol, path); }
  if (typeof token !== 'string' || token.length === 0) throw invalidUpstream(protocol, path);
  return token;
}

function integerUsage(value, path, protocol) {
  if (!Number.isInteger(value) || value < 0) throw invalidUpstream(protocol, path);
  return value;
}

function chatUsageToMessages(value) {
  if (value === undefined) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }
  const usage = exactUpstream(value, CHAT_USAGE_FIELDS, 'chat', 'usage');
  const prompt = integerUsage(usage.prompt_tokens, 'usage.prompt_tokens', 'chat');
  const completion = integerUsage(usage.completion_tokens, 'usage.completion_tokens', 'chat');
  if (usage.total_tokens !== undefined) {
    const total = integerUsage(usage.total_tokens, 'usage.total_tokens', 'chat');
    if (total !== prompt + completion) throw invalidUpstream('chat', 'usage.total_tokens');
  }
  for (const [name, primary] of [['input_tokens', prompt], ['output_tokens', completion]]) {
    if (usage[name] === undefined || usage[name] === null) continue;
    const alias = integerUsage(usage[name], `usage.${name}`, 'chat');
    if (alias !== 0 && alias !== primary) throw invalidUpstream('chat', `usage.${name}`);
  }
  let cached = 0;
  let cachedObserved = false;
  if (usage.prompt_tokens_details !== undefined && usage.prompt_tokens_details !== null) {
    const details = exactUpstream(
      usage.prompt_tokens_details,
      CHAT_PROMPT_DETAILS_FIELDS,
      'chat',
      'usage.prompt_tokens_details',
    );
    if (details.cached_tokens !== undefined) {
      cached = integerUsage(details.cached_tokens, 'usage.prompt_tokens_details.cached_tokens', 'chat');
      cachedObserved = true;
    }
    for (const key of ['text_tokens', 'audio_tokens', 'image_tokens']) {
      if (details[key] !== undefined && details[key] !== null) {
        integerUsage(details[key], `usage.prompt_tokens_details.${key}`, 'chat');
      }
    }
  }
  if (usage.input_tokens_details !== undefined && usage.input_tokens_details !== null) {
    const details = exactUpstream(
      usage.input_tokens_details,
      CHAT_INPUT_DETAILS_FIELDS,
      'chat',
      'usage.input_tokens_details',
    );
    if (details.cached_tokens !== undefined && details.cached_tokens !== null) {
      const alias = integerUsage(details.cached_tokens, 'usage.input_tokens_details.cached_tokens', 'chat');
      if (cachedObserved && alias !== 0 && alias !== cached) {
        throw invalidUpstream('chat', 'usage.input_tokens_details.cached_tokens');
      }
      if (!cachedObserved) cached = alias;
    }
  }
  const fiveMinutes = usage.claude_cache_creation_5_m_tokens === undefined
    || usage.claude_cache_creation_5_m_tokens === null
    ? 0
    : integerUsage(usage.claude_cache_creation_5_m_tokens, 'usage.claude_cache_creation_5_m_tokens', 'chat');
  const oneHour = usage.claude_cache_creation_1_h_tokens === undefined
    || usage.claude_cache_creation_1_h_tokens === null
    ? 0
    : integerUsage(usage.claude_cache_creation_1_h_tokens, 'usage.claude_cache_creation_1_h_tokens', 'chat');
  const cacheCreation = fiveMinutes + oneHour;
  if (cached + cacheCreation > prompt) throw invalidUpstream('chat', 'usage.prompt_tokens');
  let reasoningTokens;
  if (usage.completion_tokens_details !== undefined && usage.completion_tokens_details !== null) {
    const details = exactUpstream(
      usage.completion_tokens_details,
      CHAT_COMPLETION_DETAILS_FIELDS,
      'chat',
      'usage.completion_tokens_details',
    );
    for (const [key, detail] of Object.entries(details)) {
      if (detail !== undefined && detail !== null) integerUsage(detail, `usage.completion_tokens_details.${key}`, 'chat');
    }
    if (details.reasoning_tokens !== undefined && details.reasoning_tokens !== null) {
      reasoningTokens = details.reasoning_tokens;
      if (reasoningTokens > completion) {
        throw invalidUpstream('chat', 'usage.completion_tokens_details.reasoning_tokens');
      }
    }
  }
  const result = {
    input_tokens: prompt - cached - cacheCreation,
    output_tokens: completion,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cached,
  };
  if (usage.claude_cache_creation_5_m_tokens !== undefined
      || usage.claude_cache_creation_1_h_tokens !== undefined) {
    result.cache_creation = {
      ephemeral_5m_input_tokens: fiveMinutes,
      ephemeral_1h_input_tokens: oneHour,
    };
  }
  if (reasoningTokens !== undefined) {
    result.output_tokens_details = { thinking_tokens: reasoningTokens };
  }
  return result;
}

function parseChatToolCall(raw, path) {
  const call = exactUpstream(raw, CHAT_TOOL_CALL_FIELDS, 'chat', path);
  const id = nonemptyString(call.id, `${path}.id`, (param) => invalidUpstream('chat', param));
  if (call.type !== 'function') throw invalidUpstream('chat', `${path}.type`);
  const fn = exactUpstream(call.function, CHAT_FUNCTION_FIELDS, 'chat', `${path}.function`);
  const name = validateFunctionName(fn.name, `${path}.function.name`, (param) => invalidUpstream('chat', param));
  const args = nonemptyString(fn.arguments, `${path}.function.arguments`, (param) => invalidUpstream('chat', param));
  let input;
  try { input = JSON.parse(args); } catch { throw invalidUpstream('chat', `${path}.function.arguments`); }
  if (!isObject(input)) throw invalidUpstream('chat', `${path}.function.arguments`);
  return { type: 'tool_use', id, name, input };
}

export function chatCompletionToMessages(completion, { sealReasoning } = {}) {
  const chat = exactUpstream(completion, CHAT_COMPLETION_FIELDS, 'chat', '');
  if (chat.object !== 'chat.completion') throw invalidUpstream('chat', 'object');
  const id = nonemptyString(chat.id, 'id', (param) => invalidUpstream('chat', param));
  const model = nonemptyString(chat.model, 'model', (param) => invalidUpstream('chat', param));
  if (!Array.isArray(chat.choices) || chat.choices.length !== 1) throw invalidUpstream('chat', 'choices');
  const choice = exactUpstream(chat.choices[0], CHAT_CHOICE_FIELDS, 'chat', 'choices[0]');
  if (choice.index !== 0) throw invalidUpstream('chat', 'choices[0].index');
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    throw unsupportedUpstream('chat', 'choices[0].logprobs');
  }
  const message = exactUpstream(choice.message, CHAT_MESSAGE_FIELDS, 'chat', 'choices[0].message');
  if (message.role !== 'assistant') throw invalidUpstream('chat', 'choices[0].message.role');
  if (message.content !== null && typeof message.content !== 'string') {
    throw invalidUpstream('chat', 'choices[0].message.content');
  }
  if (message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== 'string') {
    throw invalidUpstream('chat', 'choices[0].message.refusal');
  }
  const reasoningValues = [message.reasoning, message.reasoning_content]
    .filter((value) => value !== undefined && value !== null);
  if (reasoningValues.length > 1 || reasoningValues.some((value) => typeof value !== 'string')) {
    throw invalidUpstream('chat', 'choices[0].message.reasoning_content');
  }
  const content = [];
  if (reasoningValues.length === 1 && reasoningValues[0].length > 0) {
    content.push({
      type: 'thinking',
      thinking: reasoningValues[0],
      signature: sealCapsule(
        sealReasoning,
        'chat',
        reasoningValues[0],
        'chat',
        'choices[0].message.reasoning_content',
      ),
    });
  }
  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content });
  }
  if (typeof message.refusal === 'string' && message.refusal.length > 0) {
    content.push({ type: 'text', text: message.refusal });
  }
  const rawCalls = message.tool_calls === undefined ? [] : message.tool_calls;
  if (!Array.isArray(rawCalls)) throw invalidUpstream('chat', 'choices[0].message.tool_calls');
  const used = new Set();
  rawCalls.forEach((raw, index) => {
    const call = parseChatToolCall(raw, `choices[0].message.tool_calls[${index}]`);
    if (used.has(call.id)) throw invalidUpstream('chat', `choices[0].message.tool_calls[${index}].id`);
    used.add(call.id);
    content.push(call);
  });
  const stopMap = {
    stop: 'end_turn',
    tool_calls: 'tool_use',
    function_call: 'tool_use',
    length: 'max_tokens',
    content_filter: 'refusal',
  };
  const stopReason = stopMap[choice.finish_reason];
  if (!stopReason) throw invalidUpstream('chat', 'choices[0].finish_reason');
  if (stopReason === 'tool_use' && rawCalls.length === 0) throw invalidUpstream('chat', 'choices[0].finish_reason');
  if (stopReason !== 'tool_use' && rawCalls.length !== 0) throw invalidUpstream('chat', 'choices[0].finish_reason');
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: chatUsageToMessages(chat.usage),
  };
}

function responseUsageToMessages(value) {
  if (value === undefined || value === null) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }
  const usage = exactUpstream(value, RESPONSE_USAGE_FIELDS, 'responses', 'usage');
  const input = integerUsage(usage.input_tokens, 'usage.input_tokens', 'responses');
  const output = integerUsage(usage.output_tokens, 'usage.output_tokens', 'responses');
  if (usage.total_tokens !== undefined) integerUsage(usage.total_tokens, 'usage.total_tokens', 'responses');
  let cached = 0;
  if (usage.input_tokens_details !== undefined && usage.input_tokens_details !== null) {
    const details = exactUpstream(
      usage.input_tokens_details,
      RESPONSE_INPUT_DETAILS_FIELDS,
      'responses',
      'usage.input_tokens_details',
    );
    if (details.cached_tokens !== undefined) {
      cached = integerUsage(details.cached_tokens, 'usage.input_tokens_details.cached_tokens', 'responses');
    }
  }
  if (cached > input) throw invalidUpstream('responses', 'usage.input_tokens_details.cached_tokens');
  if (usage.output_tokens_details !== undefined && usage.output_tokens_details !== null) {
    const details = exactUpstream(
      usage.output_tokens_details,
      RESPONSE_OUTPUT_DETAILS_FIELDS,
      'responses',
      'usage.output_tokens_details',
    );
    if (details.reasoning_tokens !== undefined) {
      integerUsage(details.reasoning_tokens, 'usage.output_tokens_details.reasoning_tokens', 'responses');
    }
  }
  return {
    input_tokens: input - cached,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

function responseReasoningSummary(item, path) {
  if (!Array.isArray(item.summary)) throw invalidUpstream('responses', `${path}.summary`);
  return item.summary.map((raw, index) => {
    const summaryPath = `${path}.summary[${index}]`;
    const summary = exactUpstream(raw, RESPONSE_SUMMARY_FIELDS, 'responses', summaryPath);
    if (summary.type !== 'summary_text') throw unsupportedUpstream('responses', `${summaryPath}.type`);
    return nonemptyString(summary.text, `${summaryPath}.text`, (param) => invalidUpstream('responses', param));
  }).join('\n');
}

export function responseToMessages(response, { sealReasoning } = {}) {
  const source = exactUpstream(response, RESPONSE_FIELDS, 'responses', '');
  if (source.object !== 'response') throw invalidUpstream('responses', 'object');
  const id = nonemptyString(source.id, 'id', (param) => invalidUpstream('responses', param));
  const model = nonemptyString(source.model, 'model', (param) => invalidUpstream('responses', param));
  if (!['completed', 'incomplete'].includes(source.status)) throw invalidUpstream('responses', 'status');
  if (source.error !== undefined && source.error !== null) throw invalidUpstream('responses', 'error');
  if (!Array.isArray(source.output)) throw invalidUpstream('responses', 'output');
  const content = [];
  let refusal = false;
  let sawTool = false;
  const usedCalls = new Set();
  source.output.forEach((rawItem, index) => {
    const path = `output[${index}]`;
    if (!isObject(rawItem)) throw invalidUpstream('responses', path);
    if (rawItem.type === 'message') {
      const message = exactUpstream(rawItem, RESPONSE_MESSAGE_FIELDS, 'responses', path);
      if (message.role !== 'assistant') throw invalidUpstream('responses', `${path}.role`);
      if (message.status !== undefined && !['completed', 'incomplete'].includes(message.status)) {
        throw invalidUpstream('responses', `${path}.status`);
      }
      if (!Array.isArray(message.content)) throw invalidUpstream('responses', `${path}.content`);
      message.content.forEach((rawPart, partIndex) => {
        const partPath = `${path}.content[${partIndex}]`;
        if (!isObject(rawPart)) throw invalidUpstream('responses', partPath);
        if (rawPart.type === 'output_text') {
          const part = exactUpstream(rawPart, RESPONSE_OUTPUT_TEXT_FIELDS, 'responses', partPath);
          if (part.annotations !== undefined && part.annotations !== null && part.annotations.length !== 0) {
            throw unsupportedUpstream('responses', `${partPath}.annotations`);
          }
          if (part.logprobs !== undefined && part.logprobs !== null && part.logprobs.length !== 0) {
            throw unsupportedUpstream('responses', `${partPath}.logprobs`);
          }
          content.push({
            type: 'text',
            text: typeof part.text === 'string'
              ? part.text
              : (() => { throw invalidUpstream('responses', `${partPath}.text`); })(),
          });
        } else if (rawPart.type === 'refusal') {
          const part = exactUpstream(rawPart, RESPONSE_REFUSAL_FIELDS, 'responses', partPath);
          content.push({
            type: 'text',
            text: nonemptyString(part.refusal, `${partPath}.refusal`, (param) => invalidUpstream('responses', param)),
          });
          refusal = true;
        } else if (typeof rawPart.type !== 'string') {
          throw invalidUpstream('responses', `${partPath}.type`);
        } else {
          throw unsupportedUpstream('responses', `${partPath}.type`);
        }
      });
      return;
    }
    if (rawItem.type === 'reasoning') {
      const item = exactUpstream(rawItem, RESPONSE_REASONING_ITEM_FIELDS, 'responses', path);
      const summary = responseReasoningSummary(item, path);
      const capsule = sealCapsule(
        sealReasoning,
        'responses',
        cloneJson(item, path, (param) => invalidUpstream('responses', param)),
        'responses',
        path,
      );
      content.push(summary
        ? { type: 'thinking', thinking: summary, signature: capsule }
        : { type: 'redacted_thinking', data: capsule });
      return;
    }
    if (rawItem.type === 'function_call') {
      const call = exactUpstream(rawItem, RESPONSE_FUNCTION_CALL_FIELDS, 'responses', path);
      if (call.status !== undefined && call.status !== 'completed') {
        throw unsupportedUpstream('responses', `${path}.status`);
      }
      const callId = nonemptyString(call.call_id, `${path}.call_id`, (param) => invalidUpstream('responses', param));
      if (usedCalls.has(callId)) throw invalidUpstream('responses', `${path}.call_id`);
      usedCalls.add(callId);
      const name = validateFunctionName(call.name, `${path}.name`, (param) => invalidUpstream('responses', param));
      const args = nonemptyString(call.arguments, `${path}.arguments`, (param) => invalidUpstream('responses', param));
      let input;
      try { input = JSON.parse(args); } catch { throw invalidUpstream('responses', `${path}.arguments`); }
      if (!isObject(input)) throw invalidUpstream('responses', `${path}.arguments`);
      content.push({ type: 'tool_use', id: callId, name, input });
      sawTool = true;
      return;
    }
    if (typeof rawItem.type !== 'string') throw invalidUpstream('responses', `${path}.type`);
    throw unsupportedUpstream('responses', `${path}.type`);
  });
  if (content.length === 0) content.push({ type: 'text', text: '' });

  let stopReason;
  if (source.status === 'completed') {
    stopReason = refusal ? 'refusal' : (sawTool ? 'tool_use' : 'end_turn');
  } else {
    const details = exactUpstream(source.incomplete_details, RESPONSE_INCOMPLETE_FIELDS, 'responses', 'incomplete_details');
    const mapping = {
      max_output_tokens: 'max_tokens',
      content_filter: 'refusal',
      model_context_window_exceeded: 'model_context_window_exceeded',
    };
    stopReason = mapping[details.reason];
    if (!stopReason) throw unsupportedUpstream('responses', 'incomplete_details.reason');
  }
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: responseUsageToMessages(source.usage),
  };
}

function anthropicUsageToResponse(value) {
  const usage = exactUpstream(value, ANTHROPIC_USAGE_FIELDS, 'messages', 'usage');
  const input = integerUsage(usage.input_tokens, 'usage.input_tokens', 'messages');
  const output = integerUsage(usage.output_tokens, 'usage.output_tokens', 'messages');
  const creation = usage.cache_creation_input_tokens === undefined || usage.cache_creation_input_tokens === null
    ? 0
    : integerUsage(usage.cache_creation_input_tokens, 'usage.cache_creation_input_tokens', 'messages');
  const cached = usage.cache_read_input_tokens === undefined || usage.cache_read_input_tokens === null
    ? 0
    : integerUsage(usage.cache_read_input_tokens, 'usage.cache_read_input_tokens', 'messages');
  if (usage.cache_creation !== undefined && usage.cache_creation !== null) {
    const breakdown = exactUpstream(
      usage.cache_creation,
      ANTHROPIC_CACHE_CREATION_FIELDS,
      'messages',
      'usage.cache_creation',
    );
    const oneHour = integerUsage(
      breakdown.ephemeral_1h_input_tokens,
      'usage.cache_creation.ephemeral_1h_input_tokens',
      'messages',
    );
    const fiveMinutes = integerUsage(
      breakdown.ephemeral_5m_input_tokens,
      'usage.cache_creation.ephemeral_5m_input_tokens',
      'messages',
    );
    if (oneHour + fiveMinutes !== creation) {
      throw invalidUpstream('messages', 'usage.cache_creation');
    }
  }
  for (const key of ['inference_geo', 'iterations', 'server_tool_use', 'speed']) {
    if (usage[key] !== undefined && usage[key] !== null) throw unsupportedUpstream('messages', `usage.${key}`);
  }
  let reasoningTokens;
  if (usage.output_tokens_details !== undefined && usage.output_tokens_details !== null) {
    const details = exactUpstream(
      usage.output_tokens_details,
      ANTHROPIC_OUTPUT_DETAILS_FIELDS,
      'messages',
      'usage.output_tokens_details',
    );
    reasoningTokens = integerUsage(details.thinking_tokens, 'usage.output_tokens_details.thinking_tokens', 'messages');
  }
  const responseUsage = {
    input_tokens: input + creation + cached,
    output_tokens: output,
    total_tokens: input + creation + cached + output,
    input_tokens_details: { cached_tokens: cached },
  };
  if (reasoningTokens !== undefined) responseUsage.output_tokens_details = { reasoning_tokens: reasoningTokens };
  return responseUsage;
}

function responseIdFromMessage(messageId) {
  const suffix = messageId.startsWith('msg_') ? messageId.slice(4) : messageId;
  return `resp_${suffix}`;
}

export function anthropicMessageToResponse(message, { id, sealReasoning } = {}) {
  const source = exactUpstream(message, ANTHROPIC_RESPONSE_FIELDS, 'messages', '');
  if (source.type !== 'message') throw invalidUpstream('messages', 'type');
  if (source.role !== 'assistant') throw invalidUpstream('messages', 'role');
  const messageId = nonemptyString(source.id, 'id', (param) => invalidUpstream('messages', param));
  const model = nonemptyString(source.model, 'model', (param) => invalidUpstream('messages', param));
  for (const key of ['container', 'context_management', 'diagnostics', 'stop_details']) {
    if (source[key] !== undefined && source[key] !== null) throw unsupportedUpstream('messages', key);
  }
  if (source.stop_sequence !== undefined && source.stop_sequence !== null) {
    throw unsupportedUpstream('messages', 'stop_sequence');
  }
  if (!Array.isArray(source.content)) throw invalidUpstream('messages', 'content');
  const responseId = id === undefined
    ? responseIdFromMessage(messageId)
    : nonemptyString(id, 'context.id', (param) => invalidUpstream('messages', param));
  const output = [];
  const sourceIncomplete = ['max_tokens', 'refusal', 'model_context_window_exceeded'].includes(source.stop_reason);
  let sawTool = false;
  let textParts = [];
  let outputIndex = 0;
  const flushText = () => {
    if (!textParts.length) return;
    output.push({
      id: `msg_${responseId.replace(/^resp_/, '')}_${outputIndex}`,
      type: 'message',
      status: sourceIncomplete ? 'incomplete' : 'completed',
      role: 'assistant',
      content: textParts,
    });
    outputIndex += 1;
    textParts = [];
  };
  source.content.forEach((rawBlock, index) => {
    const path = `content[${index}]`;
    if (!isObject(rawBlock)) throw invalidUpstream('messages', path);
    if (rawBlock.type === 'text') {
      const block = exactUpstream(rawBlock, ANTHROPIC_TEXT_RESPONSE_FIELDS, 'messages', path);
      if (block.citations !== undefined && block.citations !== null && block.citations.length !== 0) {
        throw unsupportedUpstream('messages', `${path}.citations`);
      }
      textParts.push({
        type: 'output_text',
        text: typeof block.text === 'string'
          ? block.text
          : (() => { throw invalidUpstream('messages', `${path}.text`); })(),
      });
      return;
    }
    if (rawBlock.type === 'thinking' || rawBlock.type === 'redacted_thinking') {
      flushText();
      const allowed = rawBlock.type === 'thinking' ? THINKING_BLOCK_FIELDS : REDACTED_THINKING_FIELDS;
      const block = exactUpstream(rawBlock, allowed, 'messages', path);
      if (block.type === 'thinking') {
        nonemptyString(block.thinking, `${path}.thinking`, (param) => invalidUpstream('messages', param));
        nonemptyString(block.signature, `${path}.signature`, (param) => invalidUpstream('messages', param));
      } else {
        nonemptyString(block.data, `${path}.data`, (param) => invalidUpstream('messages', param));
      }
      const capsule = sealCapsule(
        sealReasoning,
        'messages',
        cloneJson(block, path, (param) => invalidUpstream('messages', param)),
        'messages',
        path,
      );
      output.push({
        id: `rs_${responseId.replace(/^resp_/, '')}_${outputIndex}`,
        type: 'reasoning',
        summary: [],
        encrypted_content: capsule,
        status: 'completed',
      });
      outputIndex += 1;
      return;
    }
    if (rawBlock.type === 'tool_use') {
      flushText();
      const block = exactUpstream(rawBlock, ANTHROPIC_TOOL_RESPONSE_FIELDS, 'messages', path);
      if (block.caller !== undefined) throw unsupportedUpstream('messages', `${path}.caller`);
      const callId = nonemptyString(block.id, `${path}.id`, (param) => invalidUpstream('messages', param));
      const name = validateFunctionName(block.name, `${path}.name`, (param) => invalidUpstream('messages', param));
      const input = cloneJson(block.input, `${path}.input`, (param) => invalidUpstream('messages', param));
      if (!isObject(input)) throw invalidUpstream('messages', `${path}.input`);
      output.push({
        id: `fc_${callId}`,
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(input),
        status: 'completed',
      });
      sawTool = true;
      outputIndex += 1;
      return;
    }
    if (typeof rawBlock.type !== 'string') throw invalidUpstream('messages', `${path}.type`);
    throw unsupportedUpstream('messages', `${path}.type`);
  });
  flushText();
  if (output.length === 0) {
    textParts = [{ type: 'output_text', text: '' }];
    flushText();
  }

  const completedReasons = new Set(['end_turn', 'tool_use', 'stop_sequence']);
  const incompleteMap = {
    max_tokens: 'max_output_tokens',
    refusal: 'content_filter',
    model_context_window_exceeded: 'model_context_window_exceeded',
  };
  let status;
  let incompleteReason;
  if (completedReasons.has(source.stop_reason)) {
    status = 'completed';
  } else if (incompleteMap[source.stop_reason]) {
    status = 'incomplete';
    incompleteReason = incompleteMap[source.stop_reason];
  } else {
    throw unsupportedUpstream('messages', 'stop_reason');
  }
  if ((source.stop_reason === 'tool_use') !== sawTool) {
    throw invalidUpstream('messages', 'stop_reason');
  }
  const response = {
    id: responseId,
    object: 'response',
    status,
    model,
    output,
    usage: anthropicUsageToResponse(source.usage),
  };
  if (incompleteReason) response.incomplete_details = { reason: incompleteReason };
  if (source.usage?.service_tier !== undefined && source.usage.service_tier !== null) {
    response.service_tier = source.usage.service_tier;
  }
  return response;
}
