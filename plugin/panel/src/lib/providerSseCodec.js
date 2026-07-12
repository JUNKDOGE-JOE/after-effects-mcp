function streamError(code, param) {
  const error = new Error('Provider SSE stream is invalid.');
  error.name = 'ProviderStreamError';
  error.status = 502;
  error.code = code;
  error.param = param;
  return error;
}

function isObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function strictParser({ maxFrameBytes, onFrame }) {
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new TypeError('maxFrameBytes must be a positive integer');
  }
  if (typeof onFrame !== 'function') throw new TypeError('onFrame is required');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let ended = false;

  function processFrame(frame) {
    if (byteLength(frame) > maxFrameBytes) throw streamError('upstream_sse_frame_too_large', 'sse');
    let event = '';
    const data = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(':')) continue;
      if (rawLine.startsWith('event:')) {
        if (event) throw streamError('upstream_sse_malformed', 'sse.event');
        event = rawLine.slice(6).replace(/^ /, '');
        continue;
      }
      if (rawLine.startsWith('data:')) {
        data.push(rawLine.slice(5).replace(/^ /, ''));
        continue;
      }
      throw streamError('upstream_sse_malformed', 'sse');
    }
    if (data.length === 0) return;
    const rawData = data.join('\n');
    if (rawData === '[DONE]') {
      onFrame({ event, done: true, data: null });
      return;
    }
    let value;
    try { value = JSON.parse(rawData); } catch {
      throw streamError('upstream_sse_malformed', 'sse.data');
    }
    onFrame({ event, done: false, data: value });
  }

  function drain() {
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      processFrame(frame);
    }
    if (byteLength(buffer) > maxFrameBytes) throw streamError('upstream_sse_frame_too_large', 'sse');
  }

  return {
    feed(chunk) {
      if (ended) throw streamError('upstream_sse_malformed', 'sse');
      try {
        if (typeof chunk === 'string') buffer += chunk;
        else if (chunk instanceof Uint8Array) buffer += decoder.decode(chunk, { stream: true });
        else throw streamError('upstream_sse_malformed', 'sse.chunk');
        drain();
      } catch (error) {
        if (error?.code) throw error;
        throw streamError('upstream_sse_malformed', 'sse.chunk');
      }
    },
    end() {
      if (ended) throw streamError('upstream_sse_malformed', 'sse');
      ended = true;
      try {
        buffer += decoder.decode();
        drain();
      } catch (error) {
        if (error?.code) throw error;
        throw streamError('upstream_sse_malformed', 'sse.chunk');
      }
      if (buffer.trim()) throw streamError('upstream_sse_truncated', 'sse');
    },
  };
}

export function createResponsesSseCollector({ maxFrameBytes = 1024 * 1024 } = {}) {
  let terminal = null;
  let sawDone = false;
  const parser = strictParser({
    maxFrameBytes,
    onFrame({ event, done, data }) {
      if (done) {
        if (!terminal || sawDone) throw streamError('upstream_sse_malformed', 'sse.done');
        sawDone = true;
        return;
      }
      if (!isObject(data) || typeof data.type !== 'string') {
        throw streamError('upstream_sse_malformed', 'sse.data.type');
      }
      if (event && event !== data.type) throw streamError('upstream_sse_malformed', 'sse.event');
      if (terminal) throw streamError('upstream_sse_malformed', 'sse.after_terminal');
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(data.type)) {
        if (!isObject(data.response)) throw streamError('upstream_sse_malformed', 'sse.data.response');
        const expected = data.type.slice('response.'.length);
        if (data.response.status !== expected) {
          throw streamError('upstream_sse_malformed', 'sse.data.response.status');
        }
        terminal = data.response;
      }
    },
  });
  return {
    feed: parser.feed,
    end() {
      parser.end();
      if (!terminal) throw streamError('upstream_sse_terminal_missing', 'sse');
      return terminal;
    },
  };
}

const CHAT_CHUNK_FIELDS = new Set([
  'id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier',
]);
const CHAT_CHOICE_FIELDS = new Set(['index', 'delta', 'finish_reason', 'logprobs']);
const CHAT_DELTA_FIELDS = new Set(['role', 'content', 'reasoning', 'reasoning_content', 'tool_calls']);
const CHAT_TOOL_DELTA_FIELDS = new Set(['index', 'id', 'type', 'function']);
const CHAT_FUNCTION_DELTA_FIELDS = new Set(['name', 'arguments']);

function exactStream(value, allowed, path) {
  if (!isObject(value)) throw streamError('upstream_sse_malformed', path);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw streamError('upstream_sse_malformed', path ? path + '.' + unknown : unknown);
  return value;
}

export function createChatSseCollector({ maxFrameBytes = 1024 * 1024 } = {}) {
  let id = '';
  let model = '';
  let created = 0;
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage;
  let doneMarker = false;
  const tools = new Map();
  const parser = strictParser({
    maxFrameBytes,
    onFrame({ done, data }) {
      if (done) {
        if (doneMarker || !finishReason) throw streamError('upstream_sse_malformed', 'sse.done');
        doneMarker = true;
        return;
      }
      const chunk = exactStream(data, CHAT_CHUNK_FIELDS, 'data');
      if (chunk.object !== 'chat.completion.chunk') throw streamError('upstream_sse_malformed', 'data.object');
      if (typeof chunk.id === 'string' && chunk.id) {
        if (id && id !== chunk.id) throw streamError('upstream_sse_malformed', 'data.id');
        id = chunk.id;
      }
      if (typeof chunk.model === 'string' && chunk.model) {
        if (model && model !== chunk.model) throw streamError('upstream_sse_malformed', 'data.model');
        model = chunk.model;
      }
      if (chunk.created !== undefined) {
        if (!Number.isInteger(chunk.created) || chunk.created < 0) {
          throw streamError('upstream_sse_malformed', 'data.created');
        }
        created = chunk.created;
      }
      if (!Array.isArray(chunk.choices)) throw streamError('upstream_sse_malformed', 'data.choices');
      if (chunk.choices.length === 0) {
        if (!finishReason || usage !== undefined || !isObject(chunk.usage)) {
          throw streamError('upstream_sse_malformed', 'data.usage');
        }
        usage = chunk.usage;
        return;
      }
      if (finishReason) throw streamError('upstream_sse_malformed', 'sse.after_terminal');
      if (chunk.choices.length !== 1) throw streamError('upstream_sse_malformed', 'data.choices');
      const choice = exactStream(chunk.choices[0], CHAT_CHOICE_FIELDS, 'choices[0]');
      if (choice.index !== 0) throw streamError('upstream_sse_malformed', 'choices[0].index');
      if (choice.logprobs !== undefined && choice.logprobs !== null) {
        throw streamError('upstream_sse_malformed', 'choices[0].logprobs');
      }
      const delta = exactStream(choice.delta, CHAT_DELTA_FIELDS, 'choices[0].delta');
      if (delta.role !== undefined && delta.role !== 'assistant') {
        throw streamError('upstream_sse_malformed', 'choices[0].delta.role');
      }
      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== 'string') throw streamError('upstream_sse_malformed', 'choices[0].delta.content');
        content += delta.content;
      }
      const reasoningValues = [delta.reasoning, delta.reasoning_content]
        .filter((value) => value !== undefined && value !== null);
      if (reasoningValues.length > 1 || reasoningValues.some((value) => typeof value !== 'string')) {
        throw streamError('upstream_sse_malformed', 'choices[0].delta.reasoning_content');
      }
      if (reasoningValues.length === 1) reasoning += reasoningValues[0];
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) {
          throw streamError('upstream_sse_malformed', 'choices[0].delta.tool_calls');
        }
        delta.tool_calls.forEach((raw, index) => {
          const path = 'choices[0].delta.tool_calls[' + index + ']';
          const part = exactStream(raw, CHAT_TOOL_DELTA_FIELDS, path);
          if (!Number.isInteger(part.index) || part.index < 0) {
            throw streamError('upstream_sse_malformed', path + '.index');
          }
          const state = tools.get(part.index) || { id: '', name: '', arguments: '' };
          if (part.id !== undefined) {
            if (typeof part.id !== 'string' || !part.id || (state.id && state.id !== part.id)) {
              throw streamError('upstream_sse_malformed', path + '.id');
            }
            state.id = part.id;
          }
          if (part.type !== undefined && part.type !== 'function') {
            throw streamError('upstream_sse_malformed', path + '.type');
          }
          if (part.function !== undefined) {
            const fn = exactStream(part.function, CHAT_FUNCTION_DELTA_FIELDS, path + '.function');
            if (fn.name !== undefined) {
              if (typeof fn.name !== 'string' || !fn.name || (state.name && state.name !== fn.name)) {
                throw streamError('upstream_sse_malformed', path + '.function.name');
              }
              state.name = fn.name;
            }
            if (fn.arguments !== undefined) {
              if (typeof fn.arguments !== 'string') {
                throw streamError('upstream_sse_malformed', path + '.function.arguments');
              }
              state.arguments += fn.arguments;
            }
          }
          tools.set(part.index, state);
        });
      }
      if (choice.finish_reason !== null) {
        if (!['stop', 'tool_calls', 'function_call', 'length', 'content_filter'].includes(choice.finish_reason)) {
          throw streamError('upstream_sse_malformed', 'choices[0].finish_reason');
        }
        finishReason = choice.finish_reason;
      }
    },
  });
  return {
    feed: parser.feed,
    end() {
      parser.end();
      if (!finishReason || !id || !model) throw streamError('upstream_sse_terminal_missing', 'sse');
      const toolCalls = [...tools.entries()].sort(([left], [right]) => left - right).map(([index, state]) => {
        if (!state.id || !state.name) {
          throw streamError('upstream_sse_truncated', 'choices[0].delta.tool_calls[' + index + ']');
        }
        let args;
        try { args = JSON.parse(state.arguments || '{}'); } catch {
          throw streamError('upstream_sse_truncated', 'choices[0].delta.tool_calls[' + index + '].function.arguments');
        }
        if (!isObject(args)) {
          throw streamError('upstream_sse_truncated', 'choices[0].delta.tool_calls[' + index + '].function.arguments');
        }
        return {
          id: state.id,
          type: 'function',
          function: { name: state.name, arguments: state.arguments || '{}' },
        };
      });
      if (['tool_calls', 'function_call'].includes(finishReason) !== (toolCalls.length > 0)) {
        throw streamError('upstream_sse_malformed', 'choices[0].finish_reason');
      }
      const message = { role: 'assistant', content: content || null };
      if (reasoning) message.reasoning_content = reasoning;
      if (toolCalls.length) message.tool_calls = toolCalls;
      return {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: finishReason,
          logprobs: null,
        }],
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}

function messageBlockStart(block, index) {
  if (!isObject(block) || typeof block.type !== 'string') {
    throw streamError('upstream_sse_malformed', 'content_block_start.content_block');
  }
  if (block.type === 'text') return { index, type: 'text', text: String(block.text || ''), stopped: false };
  if (block.type === 'tool_use') {
    if (typeof block.id !== 'string' || typeof block.name !== 'string' || !isObject(block.input || {})) {
      throw streamError('upstream_sse_malformed', 'content_block_start.content_block');
    }
    return {
      index,
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input || {},
      inputJson: '',
      stopped: false,
    };
  }
  if (block.type === 'thinking') {
    return {
      index,
      type: 'thinking',
      thinking: String(block.thinking || ''),
      signature: String(block.signature || ''),
      stopped: false,
    };
  }
  if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
    return { index, type: 'redacted_thinking', data: block.data, stopped: false };
  }
  throw streamError('upstream_sse_malformed', 'content_block_start.content_block.type');
}

function applyMessageDelta(block, delta) {
  if (!isObject(delta) || typeof delta.type !== 'string') {
    throw streamError('upstream_sse_malformed', 'content_block_delta.delta');
  }
  if (block.type === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
    block.text += delta.text;
    return;
  }
  if (block.type === 'tool_use' && delta.type === 'input_json_delta'
    && typeof delta.partial_json === 'string') {
    block.inputJson += delta.partial_json;
    return;
  }
  if (block.type === 'thinking' && delta.type === 'thinking_delta'
    && typeof delta.thinking === 'string') {
    block.thinking += delta.thinking;
    return;
  }
  if (block.type === 'thinking' && delta.type === 'signature_delta'
    && typeof delta.signature === 'string') {
    block.signature += delta.signature;
    return;
  }
  throw streamError('upstream_sse_malformed', 'content_block_delta.delta.type');
}

function finalizedBlock(block) {
  if (block.type === 'tool_use') {
    let input = block.input;
    if (block.inputJson) {
      try { input = JSON.parse(block.inputJson); } catch {
        throw streamError('upstream_sse_malformed', 'content_block_delta.delta.partial_json');
      }
      if (!isObject(input)) throw streamError('upstream_sse_malformed', 'content_block_delta.delta.partial_json');
    }
    return { type: 'tool_use', id: block.id, name: block.name, input };
  }
  if (block.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: block.thinking,
      signature: block.signature,
    };
  }
  if (block.type === 'redacted_thinking') return { type: block.type, data: block.data };
  return { type: 'text', text: block.text };
}

export function createMessagesSseCollector({ maxFrameBytes = 1024 * 1024 } = {}) {
  let start = null;
  let stopReason = null;
  let stopSequence = null;
  let usage = null;
  let messageStop = false;
  let doneMarker = false;
  const blocks = new Map();
  const parser = strictParser({
    maxFrameBytes,
    onFrame({ event, done, data }) {
      if (done) {
        if (doneMarker) throw streamError('upstream_sse_malformed', 'sse.done');
        doneMarker = true;
        return;
      }
      if (!isObject(data) || typeof data.type !== 'string') {
        throw streamError('upstream_sse_malformed', 'sse.data.type');
      }
      if (event && event !== data.type) throw streamError('upstream_sse_malformed', 'sse.event');
      if (messageStop) throw streamError('upstream_sse_malformed', 'sse.after_terminal');
      if (data.type === 'ping') return;
      if (data.type === 'error') throw streamError('upstream_stream_error', 'sse.data.error');
      if (data.type === 'message_start') {
        if (start || !isObject(data.message)) throw streamError('upstream_sse_malformed', 'message_start.message');
        start = data.message;
        usage = isObject(start.usage) ? { ...start.usage } : {};
        return;
      }
      if (data.type === 'content_block_start') {
        if (!Number.isInteger(data.index) || data.index < 0 || blocks.has(data.index)) {
          throw streamError('upstream_sse_malformed', 'content_block_start.index');
        }
        blocks.set(data.index, messageBlockStart(data.content_block, data.index));
        return;
      }
      if (data.type === 'content_block_delta') {
        const block = blocks.get(data.index);
        if (!block || block.stopped) throw streamError('upstream_sse_malformed', 'content_block_delta.index');
        applyMessageDelta(block, data.delta);
        return;
      }
      if (data.type === 'content_block_stop') {
        const block = blocks.get(data.index);
        if (!block || block.stopped) throw streamError('upstream_sse_malformed', 'content_block_stop.index');
        block.stopped = true;
        return;
      }
      if (data.type === 'message_delta') {
        if (!isObject(data.delta) || typeof data.delta.stop_reason !== 'string') {
          throw streamError('upstream_sse_malformed', 'message_delta.delta.stop_reason');
        }
        stopReason = data.delta.stop_reason;
        stopSequence = data.delta.stop_sequence ?? null;
        if (data.usage !== undefined) {
          if (!isObject(data.usage)) throw streamError('upstream_sse_malformed', 'message_delta.usage');
          usage = { ...(usage || {}), ...data.usage };
        }
        return;
      }
      if (data.type === 'message_stop') {
        if (!start || !stopReason) throw streamError('upstream_sse_malformed', 'message_stop');
        messageStop = true;
        return;
      }
      throw streamError('upstream_sse_malformed', 'sse.data.type');
    },
  });
  return {
    feed: parser.feed,
    end() {
      parser.end();
      if (!start || !stopReason) throw streamError('upstream_sse_terminal_missing', 'sse');
      if ([...blocks.values()].some((block) => !block.stopped)) {
        throw streamError('upstream_sse_truncated', 'content_block_stop');
      }
      const content = [...blocks.values()]
        .sort((left, right) => left.index - right.index)
        .map(finalizedBlock);
      return {
        message: {
          id: String(start.id || ''),
          type: 'message',
          role: 'assistant',
          model: String(start.model || ''),
          content,
          stop_reason: stopReason,
          stop_sequence: stopSequence,
          usage: usage || {},
        },
        terminalMode: messageStop ? 'message_stop' : 'bounded_eof',
      };
    },
  };
}

export function messagesSseEvents(message) {
  if (!isObject(message) || message.type !== 'message' || !Array.isArray(message.content)) {
    throw streamError('invalid_messages_response', 'message');
  }
  const events = [[
    'message_start',
    {
      type: 'message_start',
      message: {
        id: message.id,
        type: 'message',
        role: 'assistant',
        model: message.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: message.usage || { input_tokens: 0, output_tokens: 0 },
      },
    },
  ]];
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      }]);
      if (block.text) events.push(['content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      }]);
    } else if (block.type === 'tool_use') {
      events.push(['content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      }]);
      events.push(['content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
      }]);
    } else if (block.type === 'thinking') {
      events.push(['content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }]);
      if (block.thinking) events.push(['content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      }]);
      if (block.signature) events.push(['content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      }]);
    } else if (block.type === 'redacted_thinking') {
      events.push(['content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'redacted_thinking', data: block.data },
      }]);
    } else {
      throw streamError('invalid_messages_response', 'message.content[' + index + '].type');
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason || 'end_turn',
      stop_sequence: message.stop_sequence ?? null,
    },
    usage: message.usage || {},
  }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}

export function responsesSseEvents(response) {
  if (!isObject(response) || response.object !== 'response' || !Array.isArray(response.output)) {
    throw streamError('invalid_responses_response', 'response');
  }
  const created = {
    ...response,
    status: 'in_progress',
    output: [],
  };
  const events = [['response.created', { type: 'response.created', response: created }]];
  response.output.forEach((item, outputIndex) => {
    const added = { ...item };
    if (Object.hasOwn(added, 'status')) added.status = 'in_progress';
    if (item.type === 'message') added.content = [];
    if (item.type === 'function_call') added.arguments = '';
    events.push(['response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: added,
    }]);
    if (item.type === 'message') {
      (item.content || []).forEach((part, contentIndex) => {
        if (part.type !== 'output_text') {
          throw streamError('invalid_responses_response', 'response.output[' + outputIndex + '].content[' + contentIndex + ']');
        }
        events.push(['response.content_part.added', {
          type: 'response.content_part.added',
          output_index: outputIndex,
          content_index: contentIndex,
          part: { type: 'output_text', text: '' },
        }]);
        if (part.text) events.push(['response.output_text.delta', {
          type: 'response.output_text.delta',
          output_index: outputIndex,
          content_index: contentIndex,
          delta: part.text,
        }]);
        events.push(['response.output_text.done', {
          type: 'response.output_text.done',
          output_index: outputIndex,
          content_index: contentIndex,
          text: part.text,
        }]);
        events.push(['response.content_part.done', {
          type: 'response.content_part.done',
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        }]);
      });
    } else if (item.type === 'function_call') {
      if (item.arguments) events.push(['response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      }]);
      events.push(['response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments || '{}',
      }]);
    } else if (item.type !== 'reasoning') {
      throw streamError('invalid_responses_response', 'response.output[' + outputIndex + '].type');
    }
    events.push(['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item,
    }]);
  });
  const status = response.status || 'completed';
  if (!['completed', 'incomplete', 'failed'].includes(status)) {
    throw streamError('invalid_responses_response', 'response.status');
  }
  events.push(['response.' + status, { type: 'response.' + status, response }]);
  return events;
}
