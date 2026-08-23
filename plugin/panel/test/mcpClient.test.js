import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpClient, PANEL_VERSION } from '../src/cep/mcpClient.js';

const TOOL_NAMES = [
  'ae_status',
  'ae_exec',
  'ae_execRecover',
  'ae_read',
  'ae_previewFrame',
  'ae_checkpoint',
  'ae_revert',
  'ae_validateExpressions',
  'ae_nativeExec',
  'ae_toolSearch',
  'ae_toolUse',
  'ae_skillUse',
];

function rpcResult(message, result) {
  return { jsonrpc: '2.0', id: message.id, result };
}

function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function makeMounted() {
  const calls = [];
  const deleted = [];
  let sessionSequence = 0;
  const mounted = {
    sessions: {
      delete(id) {
        deleted.push(id);
        return true;
      },
    },
    async dispatch(request, message, conversation) {
      calls.push({
        message,
        conversation,
        sessionId: request.get('mcp-session-id'),
        protocol: request.get('mcp-protocol-version'),
        port: request.socket.localPort,
      });
      if (message.method === 'initialize') {
        const session = { id: 'session-' + (++sessionSequence) };
        return {
          status: 200,
          session,
          response: rpcResult(message, {
            protocolVersion: '2025-06-18',
            instructions: 'HOST_INSTRUCTIONS',
            serverInfo: { name: 'ae-mcp-host', version: PANEL_VERSION },
          }),
        };
      }
      if (message.method === 'notifications/initialized') {
        return { status: 202, response: null };
      }
      if (message.method === 'tools/list') {
        return {
          status: 200,
          response: rpcResult(message, {
            tools: TOOL_NAMES.map((name) => ({ name, inputSchema: { type: 'object' } })),
          }),
        };
      }
      const args = message.params.arguments;
      if (message.params.name === 'ae_toolSearch') {
        const value = args.name
          ? { ok: true, artifact: { id: args.name, name: 'Fade' } }
          : { ok: true, artifacts: [{ id: 'user:fade', name: 'Fade' }] };
        return { status: 200, response: rpcResult(message, textResult(value)) };
      }
      if (message.params.name === 'ae_skillUse') {
        const value = args.name
          ? { ok: true, name: args.name, rendered: 'rendered skill' }
          : { ok: true, skills: [{ name: 'ease-and-timing' }] };
        return { status: 200, response: rpcResult(message, textResult(value)) };
      }
      return {
        status: 200,
        response: rpcResult(message, textResult({ ok: true, tool: message.params.name })),
      };
    },
  };
  return { mounted, calls, deleted };
}

test('createMcpClient prefers the mounted host handle and lists all 12 tools', async () => {
  const fixture = makeMounted();
  let fetchCalls = 0;
  const conversation = { id: 'conversation-1', path: '/mcp/c/token-1' };
  const client = createMcpClient({
    getHost: () => ({ mcp: fixture.mounted }),
    getConversation: () => conversation,
    getPort: () => 11488,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('HTTP fallback should not run');
    },
  });

  assert.deepEqual((await client.listTools()).map((tool) => tool.name), TOOL_NAMES);
  assert.equal(client.state().transport, 'in-process');
  assert.equal(fetchCalls, 0);
  assert.equal(client.getServerInstructions(), 'HOST_INSTRUCTIONS');
  assert.deepEqual(client.getServerInfo(), {
    name: 'ae-mcp-host',
    version: PANEL_VERSION,
  });
  assert.deepEqual(fixture.calls[0].message.params.clientInfo, {
    name: 'ae-mcp-panel',
    version: PANEL_VERSION,
  });
  assert.equal(fixture.calls[0].conversation, conversation);
  assert.equal(fixture.calls[0].port, 11488);
  assert.equal(fixture.calls[1].sessionId, 'session-1');
  client.stop();
  assert.deepEqual(fixture.deleted, ['session-1']);
});

test('mounted host round-trips search, detail, skill list, and skill render', async () => {
  const fixture = makeMounted();
  const client = createMcpClient({
    getHost: () => ({ mcp: fixture.mounted }),
    getConversation: () => ({ id: 'conversation-1' }),
  });

  const searched = await client.callTool('ae_toolSearch', { query: 'fade' });
  const inspected = await client.callTool('ae_toolSearch', { name: 'user:fade' });
  const skills = await client.callTool('ae_skillUse', { include_templates: true });
  const rendered = await client.callTool('ae_skillUse', {
    name: 'ease-and-timing',
    args: {},
    execute: false,
  });

  assert.deepEqual(searched.structuredContent.artifacts, [{ id: 'user:fade', name: 'Fade' }]);
  assert.equal(inspected.structuredContent.artifact.id, 'user:fade');
  assert.deepEqual(skills.structuredContent.skills, [{ name: 'ease-and-timing' }]);
  assert.equal(rendered.structuredContent.rendered, 'rendered skill');
  assert.deepEqual(
    fixture.calls.filter((call) => call.message.method === 'tools/call')
      .map((call) => call.message.params.name),
    ['ae_toolSearch', 'ae_toolSearch', 'ae_skillUse', 'ae_skillUse'],
  );
});

function httpResponse(body, sessionId = '') {
  return {
    ok: true,
    status: body === null ? 202 : 200,
    headers: { get: (name) => name.toLowerCase() === 'mcp-session-id' ? sessionId : null },
    text: async () => body === null ? '' : JSON.stringify(body),
  };
}

test('createMcpClient falls back to the host /mcp HTTP endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, payload });
    if (options.method === 'DELETE') return httpResponse(null);
    if (payload.method === 'initialize') {
      return httpResponse(rpcResult(payload, {
        instructions: 'HTTP_INSTRUCTIONS',
        serverInfo: { name: 'ae-mcp-host', version: '1' },
      }), 'http-session');
    }
    if (payload.method === 'notifications/initialized') return httpResponse(null);
    if (payload.method === 'tools/list') {
      return httpResponse(rpcResult(payload, { tools: [{ name: 'ae_toolSearch' }] }));
    }
    return httpResponse(rpcResult(payload, textResult({ ok: true })));
  };
  const client = createMcpClient({
    getHost: () => null,
    getPort: () => 12000,
    fetchImpl,
  });

  assert.deepEqual(await client.listTools(), [{ name: 'ae_toolSearch' }]);
  assert.equal(client.state().transport, 'http');
  await client.callTool('ae_toolSearch', {});
  assert.ok(calls.every((call) => call.url === 'http://127.0.0.1:12000/mcp'));
  assert.equal(calls[1].options.headers['mcp-session-id'], 'http-session');
  client.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.at(-1).options.method, 'DELETE');
});

test('a changed conversation reinitializes the in-process MCP session', async () => {
  const fixture = makeMounted();
  let conversation = { id: 'conversation-1' };
  const client = createMcpClient({
    getHost: () => ({ mcp: fixture.mounted }),
    getConversation: () => conversation,
  });
  await client.listTools();
  conversation = { id: 'conversation-2' };
  await client.listTools();

  const initializes = fixture.calls.filter((call) => call.message.method === 'initialize');
  assert.equal(initializes.length, 2);
  assert.deepEqual(fixture.deleted, ['session-1']);
});

test('JSON-RPC errors are exposed and invalidate the failed session', async () => {
  const fixture = makeMounted();
  fixture.mounted.dispatch = async (request, message) => {
    if (message.method === 'initialize') {
      return {
        session: { id: 'session-error' },
        response: rpcResult(message, {}),
      };
    }
    if (message.method === 'notifications/initialized') return { response: null };
    if (message.method === 'tools/list') {
      return { response: rpcResult(message, { tools: [] }) };
    }
    return {
      response: {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: 'bad arguments', data: { field: 'name' } },
      },
    };
  };
  const client = createMcpClient({ getHost: () => ({ mcp: fixture.mounted }) });

  await assert.rejects(
    client.callTool('ae_toolSearch', {}),
    (error) => error.code === -32602 && error.data.field === 'name',
  );
  assert.equal(client.state().status, 'error');
  assert.deepEqual(fixture.deleted, ['session-error']);
});
