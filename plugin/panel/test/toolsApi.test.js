import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolsApi,
  executeToolPlan,
  parseMcpPayload,
  startToolPlan,
  waitForToolExecution,
} from '../src/cep/toolsApi.js';

test('Tools API uses exact progressive and mutation tool names', async () => {
  const calls = [];
  const mcp = {
    async callTool(name, args) {
      calls.push({ name, args });
      return {
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      };
    },
  };
  const api = createToolsApi(mcp);
  await api.index({ include_candidates: true });
  await api.search({ query: 'wiggle' });
  await api.inspect('user:1');
  await api.create({ name: 'x' });
  await api.edit({ artifact_id: 'user:1' });
  await api.delete({ artifact_id: 'user:1' });
  await api.archive({ artifact_id: 'user:1' });
  await api.duplicate({ artifact_id: 'user:1' });
  await api.promoteFromHistory({ artifact_id: 'user:1' });
  await api.use({ action: 'render', artifact_id: 'user:1' });
  await api.previewImport('/tmp/in.aemcptools');
  await api.commitImport('import-1', { conflict: 'keep' });
  await api.discardImport('import-1');
  await api.exportPackage(['user:1'], '/tmp/out.aemcptools');

  assert.deepEqual(calls.map((call) => call.name), [
    'ae_toolIndex',
    'ae_toolSearch',
    'ae_toolInspect',
    'ae_toolCreate',
    'ae_toolEdit',
    'ae_toolDelete',
    'ae_toolArchive',
    'ae_toolDuplicate',
    'ae_toolPromoteFromHistory',
    'ae_toolUse',
    'ae_toolImport',
    'ae_toolImport',
    'ae_toolImport',
    'ae_toolExport',
  ]);
  assert.deepEqual(calls[2].args, { artifact_id: 'user:1' });
  assert.deepEqual(calls[10].args, { action: 'preview', path: '/tmp/in.aemcptools' });
  assert.deepEqual(calls[11].args, {
    action: 'commit', import_id: 'import-1', resolutions: { conflict: 'keep' },
  });
  assert.deepEqual(calls[12].args, { action: 'discard', import_id: 'import-1' });
  assert.deepEqual(calls[13].args, {
    artifact_ids: ['user:1'], out_path: '/tmp/out.aemcptools',
  });
});

test('startToolPlan uses once approval and returns one server job', async () => {
  const calls = [];
  const api = {
    async use(input) {
      calls.push(input);
      if (input.action === 'prepare') return { planHash: 'plan-1' };
      if (input.action === 'grant') return { grantId: 'grant-1' };
      return { executionId: 'execution-1', status: 'queued', terminal: false };
    },
  };
  const started = await startToolPlan(api, {
    artifactId: 'user:1', operation: 'execute', args: { amount: 2 }, target: {},
    operationId: 'operation-panel-0001',
  });
  assert.equal(started.executionId, 'execution-1');
  assert.deepEqual(calls.map((value) => value.action), ['prepare', 'grant', 'start']);
  assert.equal(calls[1].grant_scope, 'once');
  assert.equal(calls[2].operation_id, 'operation-panel-0001');
});

test('startToolPlan retries one lost start response with the same operation id', async () => {
  const starts = [];
  const api = {
    async use(input) {
      if (input.action === 'prepare') return { planHash: 'plan-1' };
      if (input.action === 'grant') return { grantId: 'grant-1' };
      starts.push(input);
      if (starts.length === 1) throw new Error('response lost');
      return { executionId: 'execution-1', operationId: input.operation_id };
    },
  };
  const result = await startToolPlan(api, {
    artifactId: 'user:1',
    operation: 'execute',
    operationId: 'operation-retry-0001',
  });
  assert.equal(result.executionId, 'execution-1');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].operation_id, starts[1].operation_id);
  assert.equal(starts[1].operation_id, 'operation-retry-0001');
});

test('developer discovery uses only the trusted panel channel', async () => {
  const publicCalls = [];
  const panelCalls = [];
  const api = createToolsApi({
    async callTool(name, args) {
      publicCalls.push({ name, args });
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
    async callPanelTool(name, args) {
      panelCalls.push({ name, args });
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
    newOperationId: () => 'operation-api-0001',
  });
  await api.developerIndex({ kinds: ['system-command'] });
  await api.developerSearch({ query: 'script' });
  await api.developerInspect('user:command');
  assert.equal(publicCalls.length, 0);
  assert.deepEqual(panelCalls.map((value) => value.name), [
    'ae_toolIndex', 'ae_toolSearch', 'ae_toolInspect',
  ]);
});

test('waitForToolExecution reports late terminal completion without a second start', async () => {
  const calls = [];
  const states = [
    { executionId: 'execution-1', status: 'running', progress: 25, terminal: false },
    { executionId: 'execution-1', status: 'succeeded', progress: 100, terminal: true },
  ];
  const progress = [];
  const result = await waitForToolExecution({
    async use(input) {
      calls.push(input);
      return states.shift();
    },
  }, { executionId: 'execution-1', status: 'queued', progress: 0, terminal: false }, {
    wait: async () => {}, onProgress: (value) => progress.push(value.status),
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(progress, ['queued', 'running', 'succeeded']);
  assert.deepEqual(calls, [
    { action: 'status', execution_id: 'execution-1' },
    { action: 'status', execution_id: 'execution-1' },
  ]);
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
    () => parseMcpPayload({
      isError: true,
      content: [{ type: 'text', text: '{"ok":false,"error":"tool_stale","message":"Refresh"}' }],
    }),
    (error) => error.message === 'tool_stale' && error.code === 'tool_stale'
      && error.payload.message === 'Refresh',
  );
});

test('executeToolPlan binds prepare, once grant, and execute in order', async () => {
  const calls = [];
  const api = {
    async use(input) {
      calls.push(input);
      if (input.action === 'prepare') return { planHash: 'plan-1' };
      if (input.action === 'grant') return { grantId: 'grant-1' };
      return { ok: true };
    },
  };
  assert.deepEqual(await executeToolPlan(api, {
    artifactId: 'user:1',
    operation: 'apply',
    args: { amount: 2 },
    target: { compId: '7', layerId: 1, path: 'Transform/Opacity' },
  }), { ok: true });
  assert.deepEqual(calls, [
    {
      artifact_id: 'user:1',
      action: 'prepare',
      operation: 'apply',
      args: { amount: 2 },
      target: { compId: '7', layerId: 1, path: 'Transform/Opacity' },
    },
    { action: 'grant', plan_hash: 'plan-1', grant_scope: 'once' },
    { action: 'execute', plan_hash: 'plan-1', grant_id: 'grant-1' },
  ]);
});
