import { createSseParser } from './sse.js';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

export function buildSystemPrompt(lang = 'zh') {
  if (lang === 'en') {
    return [
      'You are a concise After Effects assistant inside the AE MCP panel.',
      'Understand the user goal, then choose appropriate MCP tools before operating.',
      'Name target comps, layers, properties, or files in quotes before changing them.',
      'Prefer read-only inspection before edits when context is missing.',
      'Summarize tool results plainly and ask only when a required detail is missing.',
    ].join(' ');
  }
  return [
    '你是 AE MCP 面板内的简洁 After Effects 助手。',
    '先理解用户目标，再选择合适的 MCP 工具操作 AE。',
    '修改前用引号明示目标合成、图层、属性或文件。',
    '缺少上下文时优先用只读工具检查。',
    '用简明语言总结工具结果，只在缺少必要信息时追问。',
  ].join(' ');
}

export function mapMcpToolsToAnthropic(tools = []) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    input_schema: tool.inputSchema || tool.input_schema || {},
  }));
}

function classifyHttpError(status, fallbackMessage) {
  if (status === 401 || status === 403) return { kind: 'auth', message: 'Anthropic authentication failed.' };
  if (status === 429) return { kind: 'rate_limit', message: 'Anthropic rate limit reached.' };
  if (status === 529 || status >= 500) return { kind: 'overloaded', message: 'Anthropic service is overloaded.' };
  return { kind: 'network', message: fallbackMessage || 'Anthropic request failed.' };
}

function toError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function parseAnthropicEvent(data, state, onTextDelta) {
  if (data.type === 'content_block_start') {
    const block = data.content_block || {};
    if (block.type === 'text') {
      state.blocks.set(data.index, { type: 'text', text: block.text || '' });
    } else if (block.type === 'tool_use') {
      state.blocks.set(data.index, {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        inputJson: '',
        startInput: block.input || {},
      });
    }
  } else if (data.type === 'content_block_delta') {
    const block = state.blocks.get(data.index);
    if (!block || !data.delta) return;
    if (data.delta.type === 'text_delta') {
      const text = data.delta.text || '';
      block.text += text;
      if (text) onTextDelta(text);
    } else if (data.delta.type === 'input_json_delta') {
      block.inputJson += data.delta.partial_json || '';
    }
  } else if (data.type === 'message_delta' && data.delta) {
    state.stopReason = data.delta.stop_reason || state.stopReason;
  }
}

function finishBlocks(blocks) {
  return Array.from(blocks.values()).map((block) => {
    if (block.type === 'tool_use') {
      let input = block.startInput || {};
      if (block.inputJson) input = JSON.parse(block.inputJson);
      return { type: 'tool_use', id: block.id, name: block.name, input };
    }
    return block;
  });
}

export async function sendAnthropicMessage({
  apiKey,
  model = DEFAULT_MODEL,
  system = buildSystemPrompt('zh'),
  messages,
  tools,
  signal,
  fetchImpl = globalThis.fetch,
  onTextDelta = () => {},
} = {}) {
  if (!apiKey) throw toError('auth', 'Anthropic API key is missing.');
  if (!fetchImpl) throw toError('network', 'fetch is unavailable in this runtime.');

  let response;
  try {
    response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system,
        messages,
        tools: mapMcpToolsToAnthropic(tools),
        stream: true,
      }),
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw toError('network', e && e.message ? e.message : 'Anthropic network request failed.');
  }

  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch (e) { /* best effort */ }
    const classified = classifyHttpError(response.status, detail);
    throw toError(classified.kind, classified.message);
  }

  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) throw toError('network', 'Anthropic response body is not streamable.');

  const decoder = new TextDecoder();
  const state = { blocks: new Map(), stopReason: 'end_turn' };
  const parser = createSseParser(({ data }) => parseAnthropicEvent(data, state, onTextDelta));

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    parser.feed(decoder.decode(chunk.value, { stream: true }));
  }
  parser.feed(decoder.decode());

  return {
    assistantMessage: { role: 'assistant', content: finishBlocks(state.blocks) },
    stopReason: state.stopReason,
  };
}
