import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolsApi, parseMcpPayload } from '../src/cep/toolsApi.js';

function response(value, isError = false) {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

test('Tools API maps folded Tool Library semantics to the host 11-tool surface', async () => {
  const calls = [];
  const api = createToolsApi({
    async callTool(name, args) {
      calls.push({ name, args });
      return response({ ok: true });
    },
  });

  await api.index({ statuses: ['saved'], limit: 100 });
  await api.search({ query: ' wiggle ', kinds: ['jsx'], offset: 2, limit: 20 });
  await api.inspect('user:1');
  await api.executeTool('user:1', { amount: 2 });
  await api.listSkills({ includeTemplates: true });
  await api.renderSkill('ease-and-timing', { amount: 2 });
  await api.executeSkill('run-script', {});

  assert.deepEqual(calls, [
    { name: 'ae_toolSearch', args: { limit: 100 } },
    { name: 'ae_toolSearch', args: { query: 'wiggle', offset: 2, limit: 20 } },
    { name: 'ae_toolSearch', args: { name: 'user:1' } },
    { name: 'ae_toolUse', args: { name: 'user:1', args: { amount: 2 } } },
    { name: 'ae_skillUse', args: { include_templates: true } },
    {
      name: 'ae_skillUse',
      args: { name: 'ease-and-timing', args: { amount: 2 }, execute: false },
    },
    { name: 'ae_skillUse', args: { name: 'run-script', args: {}, execute: true } },
  ]);
  assert.equal(calls.some((call) => [
    'ae_toolIndex',
    'ae_toolInspect',
    'ae_skillList',
  ].includes(call.name)), false);
});

test('parseMcpPayload joins text blocks and preserves structured errors', () => {
  assert.deepEqual(parseMcpPayload({
    isError: false,
    content: [
      { type: 'image', data: 'ignored' },
      { type: 'text', text: '{"ok":' },
      { type: 'text', text: 'true,"value":1}' },
    ],
  }), { ok: true, value: 1 });

  assert.throws(
    () => parseMcpPayload(response({
      ok: false,
      error: 'tool_stale',
      message: 'Refresh',
    }, true)),
    (error) => error.message === 'tool_stale'
      && error.code === 'tool_stale'
      && error.payload.message === 'Refresh',
  );
});

test('parseMcpPayload rejects non-JSON Tool Library responses', () => {
  assert.throws(
    () => parseMcpPayload({ content: [{ type: 'text', text: 'not json' }] }),
    /Invalid Tool Library response/,
  );
});
