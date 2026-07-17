import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTERNAL_CLIENTS, mcpConfigFor, expertGuidanceEnv } from '../src/cep/externalClients.js';

test('external client registry covers seeded clients with required fields', () => {
  const expectedIds = [
    'claude-desktop',
    'claude-code',
    'cursor',
    'openclaw',
    'astrbot',
    'gemini-antigravity',
    'opencode-external',
    'zcode',
  ];
  const ids = EXTERNAL_CLIENTS.map((client) => client.id);

  for (const id of expectedIds) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }

  for (const client of EXTERNAL_CLIENTS) {
    assert.equal(typeof client.name, 'string', `${client.id} name`);
    assert.ok(client.name.length > 0, `${client.id} name is empty`);
    assert.ok(['mcp-stdio', 'mcp-doc'].includes(client.kind), `${client.id} kind`);
    assert.equal(typeof client.installHint, 'string', `${client.id} installHint`);
    assert.ok(client.installHint.length > 0, `${client.id} installHint is empty`);
    assert.equal(typeof client.loginHint, 'string', `${client.id} loginHint`);
    assert.ok(client.loginHint.length > 0, `${client.id} loginHint is empty`);
    assert.equal(typeof client.docsUrl, 'string', `${client.id} docsUrl`);
    assert.ok(client.docsUrl.length > 0, `${client.id} docsUrl is empty`);
  }
});

test('IM bot clients are documentation-driven and warn about localhost reachability', () => {
  for (const id of ['openclaw', 'astrbot']) {
    const client = EXTERNAL_CLIENTS.find((item) => item.id === id);
    assert.equal(client.kind, 'mcp-doc');
    assert.match(client.networkNote, /127\.0\.0\.1:11488/);
    assert.match(client.networkNote, /(同机|same machine)/i);
  }
});

test('mcpConfigFor returns ae-mcp stdio config with panel plugin URL', () => {
  const config = mcpConfigFor({ kind: 'mcp-stdio' }, 11488);

  assert.deepEqual(config.mcpServers.ae, {
    command: 'ae-mcp',
    env: {
      AE_MCP_BACKEND: 'ae-mcp',
      AE_MCP_PLUGIN_URL: 'http://127.0.0.1:11488',
    },
  });
});

test('mcpConfigFor emits an expanded stable launcher when the panel supplies one', () => {
  const launcher = '/Users/测试 User/.ae-mcp/bin/ae-mcp';
  const standard = mcpConfigFor({ kind: 'mcp-stdio' }, 11488, true, launcher);
  const zcode = mcpConfigFor({ id: 'zcode' }, 11488, true, launcher);
  assert.equal(standard.mcpServers.ae.command, launcher);
  assert.equal(zcode.mcp.servers.ae.command, launcher);
});

test('mcpConfigFor emits ZCode mcp.servers format (object env, not array)', () => {
  const config = mcpConfigFor({ id: 'zcode' }, 11488);

  // ZCode reads ~/.zcode/cli/config.json -> mcp.servers.<name>, strict server
  // object {name, command, args, env} where env MUST be an object {KEY:VALUE}.
  // An array env corrupts via Object.entries -> value becomes an object (#36 saga).
  assert.deepEqual(config, {
    mcp: {
      servers: {
        ae: {
          name: 'ae',
          command: 'ae-mcp',
          args: [],
          env: {
            AE_MCP_BACKEND: 'ae-mcp',
            AE_MCP_PLUGIN_URL: 'http://127.0.0.1:11488',
          },
        },
      },
    },
  });
  // env is a plain object, not an array.
  assert.equal(Array.isArray(config.mcp.servers.ae.env), false);
});

test('mcpConfigFor ZCode honors expertGuidance off', () => {
  const off = mcpConfigFor({ id: 'zcode' }, 11488, false);
  assert.equal(off.mcp.servers.ae.env.AE_MCP_EXPERT_GUIDANCE, '0');
  const on = mcpConfigFor({ id: 'zcode' }, 11488, true);
  assert.equal('AE_MCP_EXPERT_GUIDANCE' in on.mcp.servers.ae.env, false);
});

test('expertGuidanceEnv: empty when on, sets 0 when off', () => {
  assert.deepEqual(expertGuidanceEnv(true), {});
  assert.deepEqual(expertGuidanceEnv(false), { AE_MCP_EXPERT_GUIDANCE: '0' });
});

test('mcpConfigFor omits guidance var when enabled (default + explicit), sets 0 when disabled', () => {
  // default (no third arg) is enabled -> no extra var, preserving existing output
  const dflt = mcpConfigFor('claude-desktop', 11488);
  const on = mcpConfigFor('claude-desktop', 11488, true);
  const off = mcpConfigFor('claude-desktop', 11488, false);

  assert.equal(JSON.stringify(dflt).includes('AE_MCP_EXPERT_GUIDANCE'), false);
  assert.equal(JSON.stringify(on).includes('AE_MCP_EXPERT_GUIDANCE'), false);
  assert.equal(JSON.stringify(off).includes('"AE_MCP_EXPERT_GUIDANCE":"0"'), true);
  // the disabled var sits next to AE_MCP_BACKEND in the ae server env
  assert.equal(off.mcpServers.ae.env.AE_MCP_BACKEND, 'ae-mcp');
  assert.equal(off.mcpServers.ae.env.AE_MCP_EXPERT_GUIDANCE, '0');
});
