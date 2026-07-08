function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function normalizeOpenAiRoot(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
}

function authHeaders(authScheme, apiKey) {
  if (authScheme === 'x-api-key') return { 'x-api-key': String(apiKey || '') };
  if (authScheme === 'none') return {};
  return { Authorization: 'Bearer ' + String(apiKey || '') };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    if (part.text !== undefined) return String(part.text || '');
    if (part.content !== undefined) return String(part.content || '');
    return '';
  }).join('');
}

function toolArguments(value) {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (e) { return '{}'; }
}

function responsesToolToChatTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const type = String(tool.type || 'function');
  if (type !== 'function') return null;
  if (tool.function && typeof tool.function === 'object') {
    const fn = {
      name: String(tool.function.name || tool.name || ''),
      description: tool.function.description !== undefined ? tool.function.description : tool.description,
      parameters: tool.function.parameters !== undefined ? tool.function.parameters : (tool.parameters || {}),
    };
    if (tool.function.strict !== undefined || tool.strict !== undefined) {
      fn.strict = tool.function.strict !== undefined ? tool.function.strict : tool.strict;
    }
    return { type: 'function', function: fn };
  }
  const name = String(tool.name || '');
  if (!name) return null;
  const fn = {
    name,
    description: tool.description,
    parameters: tool.parameters || {},
  };
  if (tool.strict !== undefined) fn.strict = tool.strict;
  return { type: 'function', function: fn };
}

function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(responsesToolToChatTool).filter(Boolean);
}

function responsesToolChoiceToChat(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
  if (toolChoice.type === 'function') {
    return { type: 'function', function: { name: String(toolChoice.name || (toolChoice.function && toolChoice.function.name) || '') } };
  }
  return toolChoice;
}

function functionCallToChatToolCall(item) {
  const callId = String(item.call_id || item.id || '');
  return {
    id: callId,
    type: 'function',
    function: {
      name: String(item.name || ''),
      arguments: toolArguments(item.arguments),
    },
  };
}

function inputToMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: String(input || '') }];
  const messages = [];
  let pendingToolCalls = [];

  function flushToolCalls() {
    if (!pendingToolCalls.length) return;
    messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '');
    if (type === 'function_call') {
      pendingToolCalls.push(functionCallToChatToolCall(item));
      continue;
    }
    if (type === 'function_call_output') {
      flushToolCalls();
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id || item.id || ''),
        content: typeof item.output === 'string' ? item.output : toolArguments(item.output),
      });
      continue;
    }
    if (type === 'reasoning') continue;
    flushToolCalls();
    if (type === 'message' || item.role || item.content !== undefined || item.text !== undefined) {
      const role = item.role === 'assistant' || item.role === 'system' ? item.role : 'user';
      const content = textFromContent(item.content !== undefined ? item.content : item.text);
      if (content || role === 'assistant') messages.push({ role, content: content || '' });
    }
  }
  flushToolCalls();
  return messages.length ? messages : [{ role: 'user', content: '' }];
}

export function responsesBodyToChatBody(body = {}) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  messages.push(...inputToMessages(body.input));
  const chat = {
    model: body.model,
    messages,
    stream: body.stream !== false,
  };
  const maxTokens = body.max_output_tokens || body.max_tokens;
  if (maxTokens !== undefined) chat.max_tokens = maxTokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  const tools = responsesToolsToChatTools(body.tools);
  if (tools.length) chat.tools = tools;
  if (body.tool_choice !== undefined && tools.length) chat.tool_choice = responsesToolChoiceToChat(body.tool_choice);
  if (body.parallel_tool_calls !== undefined && tools.length) chat.parallel_tool_calls = body.parallel_tool_calls;
  return chat;
}

function responseId() {
  return 'resp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sse(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify({ type: event, ...data }) + '\n\n');
}

function chatToolCallsToResponseOutput(message) {
  const toolCalls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
  return toolCalls.map((toolCall, index) => {
    const callId = String((toolCall && toolCall.id) || ('call_' + index));
    const fn = (toolCall && toolCall.function) || {};
    return {
      type: 'function_call',
      id: 'fc_' + callId,
      call_id: callId,
      name: String(fn.name || ''),
      arguments: toolArguments(fn.arguments),
      status: 'completed',
    };
  }).filter((item) => item.name);
}

function messageOutputItem(id, text) {
  return {
    id: 'msg_' + id.slice(5),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: String(text || '') }],
  };
}

function chatMessageToResponseOutput(id, message) {
  const output = [];
  const text = message && typeof message.content === 'string' ? message.content : '';
  if (text) output.push(messageOutputItem(id, text));
  output.push(...chatToolCallsToResponseOutput(message));
  if (!output.length) output.push(messageOutputItem(id, ''));
  return output;
}

function createStreamState(res, id, model) {
  let started = false;
  let nextOutputIndex = 0;
  let textIndex = null;
  let text = '';
  const tools = new Map();
  const completed = [];

  function ensureStarted() {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    sse(res, 'response.created', { response: { id, object: 'response', status: 'in_progress', model, output: [] } });
  }

  function ensureTextItem() {
    ensureStarted();
    if (textIndex !== null) return textIndex;
    textIndex = nextOutputIndex++;
    const item = { id: 'msg_' + id.slice(5), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    sse(res, 'response.output_item.added', { output_index: textIndex, item });
    sse(res, 'response.content_part.added', { output_index: textIndex, content_index: 0, part: { type: 'output_text', text: '' } });
    return textIndex;
  }

  function pushTextDelta(delta) {
    if (!delta) return;
    const outputIndex = ensureTextItem();
    text += String(delta);
    sse(res, 'response.output_text.delta', { output_index: outputIndex, content_index: 0, delta: String(delta) });
  }

  function pushToolCallDelta(toolCall) {
    ensureStarted();
    const chatIndex = Number.isFinite(toolCall && toolCall.index) ? toolCall.index : 0;
    const fn = (toolCall && toolCall.function) || {};
    let state = tools.get(chatIndex);
    if (!state) {
      state = { callId: '', name: '', arguments: '', outputIndex: null, itemId: '', added: false };
      tools.set(chatIndex, state);
    }
    if (toolCall && toolCall.id) state.callId = String(toolCall.id);
    if (fn.name) state.name = String(fn.name);
    if (fn.arguments) state.arguments += String(fn.arguments);

    if (!state.added && state.callId && state.name) {
      state.added = true;
      state.outputIndex = nextOutputIndex++;
      state.itemId = 'fc_' + state.callId;
      const item = {
        type: 'function_call',
        id: state.itemId,
        call_id: state.callId,
        name: state.name,
        arguments: '',
        status: 'in_progress',
      };
      sse(res, 'response.output_item.added', { output_index: state.outputIndex, item });
      if (state.arguments) {
        sse(res, 'response.function_call_arguments.delta', {
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta: state.arguments,
        });
      }
      return;
    }

    if (state.added && fn.arguments) {
      sse(res, 'response.function_call_arguments.delta', {
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: String(fn.arguments),
      });
    }
  }

  function finish() {
    ensureStarted();
    if (textIndex !== null) {
      const item = messageOutputItem(id, text);
      sse(res, 'response.output_text.done', { output_index: textIndex, content_index: 0, text });
      sse(res, 'response.content_part.done', { output_index: textIndex, content_index: 0, part: item.content[0] });
      sse(res, 'response.output_item.done', { output_index: textIndex, item });
      completed.push(item);
    }
    for (const state of tools.values()) {
      if (!state.added || !state.name) continue;
      const item = {
        type: 'function_call',
        id: state.itemId || ('fc_' + state.callId),
        call_id: state.callId || state.itemId,
        name: state.name,
        arguments: state.arguments || '{}',
        status: 'completed',
      };
      sse(res, 'response.function_call_arguments.done', {
        item_id: item.id,
        output_index: state.outputIndex,
        arguments: item.arguments,
      });
      sse(res, 'response.output_item.done', { output_index: state.outputIndex, item });
      completed.push(item);
    }
    if (!completed.length) completed.push(messageOutputItem(id, ''));
    sse(res, 'response.completed', {
      response: { id, object: 'response', status: 'completed', model, output: completed },
    });
    res.end();
  }

  return { pushTextDelta, pushToolCallDelta, finish, ensureStarted };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function requestUpstream({ requireImpl, upstreamBaseUrl, apiKey, authScheme, path, method, body, onResponse }) {
  return new Promise((resolve, reject) => {
    let endpoint;
    try {
      endpoint = new URL(normalizeOpenAiRoot(upstreamBaseUrl) + path);
    } catch (e) {
      reject(new Error('Invalid upstream base URL'));
      return;
    }
    const reqImpl = requireImpl(endpoint.protocol === 'http:' ? 'http' : 'https');
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { ...authHeaders(authScheme, apiKey) };
    if (payload !== null) headers['Content-Type'] = 'application/json';
    const req = reqImpl.request({
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      protocol: endpoint.protocol,
      path: endpoint.pathname + endpoint.search,
      method,
      headers,
    }, async (upstream) => {
      try {
        await onResponse(upstream);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function proxyModels({ req, res, requireImpl, upstreamBaseUrl, apiKey, authScheme }) {
  return requestUpstream({
    requireImpl,
    upstreamBaseUrl,
    apiKey,
    authScheme,
    path: '/models',
    method: 'GET',
    onResponse: async (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers || {});
      upstream.on('data', (chunk) => res.write(chunk));
      upstream.on('end', () => res.end());
    },
  }).catch((e) => sendJson(res, 502, { error: { message: e.message || 'Provider route failed' } }));
}

async function handleResponses({ req, res, requireImpl, upstreamBaseUrl, apiKey, authScheme }) {
  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch (e) {
    sendJson(res, 400, { error: { message: 'Invalid JSON request body' } });
    return;
  }
  const chatBody = responsesBodyToChatBody(body);
  const id = responseId();

  if (chatBody.stream === false) {
    await requestUpstream({
      requireImpl,
      upstreamBaseUrl,
      apiKey,
      authScheme,
      path: '/chat/completions',
      method: 'POST',
      body: chatBody,
      onResponse: async (upstream) => {
        let text = '';
        upstream.on('data', (chunk) => { text += chunk; });
        upstream.on('end', () => {
          if ((upstream.statusCode || 0) >= 300) {
            sendJson(res, upstream.statusCode || 502, { error: { message: 'Upstream chat completion failed' } });
            return;
          }
          let message = { content: '' };
          try {
            const parsed = JSON.parse(text);
            message = (parsed.choices && parsed.choices[0] && parsed.choices[0].message) || message;
          } catch (e) { message = { content: '' }; }
          sendJson(res, 200, {
            id,
            object: 'response',
            status: 'completed',
            model: chatBody.model,
            output: chatMessageToResponseOutput(id, message),
          });
        });
      },
    }).catch((e) => sendJson(res, 502, { error: { message: e.message || 'Provider route failed' } }));
    return;
  }

  const stream = createStreamState(res, id, chatBody.model);
  await requestUpstream({
    requireImpl,
    upstreamBaseUrl,
    apiKey,
    authScheme,
    path: '/chat/completions',
    method: 'POST',
    body: chatBody,
    onResponse: async (upstream) => {
      if ((upstream.statusCode || 0) >= 300) {
        let detail = '';
        upstream.on('data', (chunk) => { detail += chunk; });
        upstream.on('end', () => sendJson(res, upstream.statusCode || 502, { error: { message: 'Upstream chat completion failed', detail: detail.slice(0, 512) } }));
        return;
      }
      stream.ensureStarted();
      let buffer = '';
      upstream.on('data', (chunk) => {
        buffer += String(chunk || '');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (!delta) continue;
            if (delta.content) stream.pushTextDelta(delta.content);
            if (Array.isArray(delta.tool_calls)) {
              for (const toolCall of delta.tool_calls) stream.pushToolCallDelta(toolCall);
            }
          } catch (e) { /* ignore malformed upstream SSE frames */ }
        }
      });
      upstream.on('end', () => stream.finish());
    },
  }).catch((e) => {
    if (!res.headersSent) sendJson(res, 502, { error: { message: e.message || 'Provider route failed' } });
    else res.end();
  });
}

export function createCodexResponsesRoute({ upstreamBaseUrl, apiKey, authScheme = 'bearer', requireImpl } = {}) {
  const reqImpl = requireImpl || getCepRequire();
  let server = null;
  let baseUrl = '';
  const token = 'ae-mcp-route-' + Math.random().toString(36).slice(2);

  return {
    async start() {
      if (server && baseUrl) return { baseUrl, apiKey: token };
      const http = reqImpl('http');
      server = http.createServer((req, res) => {
        const path = String(req.url || '').split('?')[0].replace(/^\/v1/, '') || '/';
        if (req.method === 'GET' && path === '/models') {
          proxyModels({ req, res, requireImpl: reqImpl, upstreamBaseUrl, apiKey, authScheme });
          return;
        }
        if (req.method === 'POST' && (path === '/responses' || path === '/responses/compact')) {
          handleResponses({ req, res, requireImpl: reqImpl, upstreamBaseUrl, apiKey, authScheme });
          return;
        }
        sendJson(res, 404, { error: { message: 'Unknown Codex provider route path' } });
      });
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      baseUrl = 'http://127.0.0.1:' + address.port;
      return { baseUrl, apiKey: token };
    },
    async close() {
      if (!server) return;
      const closing = server;
      server = null;
      baseUrl = '';
      await new Promise((resolve) => closing.close(resolve));
    },
  };
}
