import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_CODE_HISTORY_GUARD_MARKER,
  guardOpenCodeOutboundMessages,
  isOpenCodeAeExecToolName,
  openCodeHistoryGuardPluginSource,
} from '../src/cep/openCodeHistoryGuard.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toolPart(tool, status, input, extras = {}) {
  return {
    id: 'part-' + tool + '-' + status,
    type: 'tool',
    tool,
    callID: 'call-' + tool + '-' + status,
    state: {
      status,
      input,
      ...extras,
    },
  };
}

test('history guard matches only exact AE exec and recovery tool names', () => {
  assert.equal(
    OPEN_CODE_HISTORY_GUARD_MARKER,
    '/* executed AE script omitted from prior model history */',
  );
  assert.doesNotThrow(() => new Function(OPEN_CODE_HISTORY_GUARD_MARKER));
  for (const name of [
    'ae_exec',
    'ae_execRecover',
    'ae_ae_exec',
    'ae_ae_execRecover',
    'mcp__ae__ae_exec',
    'mcp__ae__ae_execRecover',
  ]) {
    assert.equal(isOpenCodeAeExecToolName(name), true, name);
  }
  for (const name of [
    'ae_ae_read',
    'mcp__ae__ae_nativeExec',
    'bash',
    'other_ae_exec',
    'ae_ae_execSomethingElse',
    '',
    null,
  ]) {
    assert.equal(isOpenCodeAeExecToolName(name), false, String(name));
  }
});

test('history guard changes only outbound completed or errored AE scripts', () => {
  const databaseMessages = [{
    info: { id: 'message-1', role: 'assistant' },
    parts: [
      toolPart('ae_ae_exec', 'completed', { code: 'app.project.item(1).remove();', timeout_sec: 30 }, {
        title: 'Remove item', output: '{"ok":true}', metadata: { retained: true },
      }),
      toolPart('mcp__ae__ae_execRecover', 'error', { recoveryId: 'abc123', code: 'throw new Error("x")' }, {
        error: 'ExtendScript error', metadata: { retained: true },
      }),
      toolPart('ae_ae_exec', 'pending', { code: 'pending-source' }, { raw: '{}' }),
      toolPart('ae_ae_execRecover', 'running', { code: 'running-source', recoveryId: 'def456' }),
      toolPart('bash', 'completed', { code: 'echo keep-me' }, { output: 'keep-me' }),
      toolPart('ae_ae_exec', 'completed', { timeout_sec: 10 }, { output: 'no-code' }),
      { id: 'text-1', type: 'text', text: 'unchanged' },
    ],
  }];
  const databaseBefore = clone(databaseMessages);
  const outboundMessages = clone(databaseMessages);
  const outboundReference = outboundMessages;
  const completedReference = outboundMessages[0].parts[0];

  assert.equal(guardOpenCodeOutboundMessages(outboundMessages), 2);
  assert.strictEqual(outboundMessages, outboundReference);
  assert.strictEqual(outboundMessages[0].parts[0], completedReference);
  assert.equal(outboundMessages[0].parts[0].state.input.code, OPEN_CODE_HISTORY_GUARD_MARKER);
  assert.equal(outboundMessages[0].parts[1].state.input.code, OPEN_CODE_HISTORY_GUARD_MARKER);
  assert.equal(outboundMessages[0].parts[2].state.input.code, 'pending-source');
  assert.equal(outboundMessages[0].parts[3].state.input.code, 'running-source');
  assert.equal(outboundMessages[0].parts[4].state.input.code, 'echo keep-me');
  assert.deepEqual(outboundMessages[0].parts[5].state.input, { timeout_sec: 10 });

  assert.equal(outboundMessages[0].parts[0].callID, databaseBefore[0].parts[0].callID);
  assert.equal(outboundMessages[0].parts[0].state.output, '{"ok":true}');
  assert.equal(outboundMessages[0].parts[1].callID, databaseBefore[0].parts[1].callID);
  assert.equal(outboundMessages[0].parts[1].state.error, 'ExtendScript error');
  assert.deepEqual(databaseMessages, databaseBefore, 'the persisted message copy must stay untouched');
});

test('generated OpenCode plugin is dependency-free, executable, and mutates hook output in place', async () => {
  const source = openCodeHistoryGuardPluginSource();
  assert.doesNotMatch(source, /(?:from\s+['"]|require\s*\()/);
  const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
  const plugin = await import(url);
  const hooks = await plugin.AeMcpHistoryGuard({});
  const hook = hooks['experimental.chat.messages.transform'];
  assert.equal(typeof hook, 'function');

  const storedPart = toolPart('mcp__ae__ae_execRecover', 'completed', {
    recoveryId: 'abc123', code: 'fixed-script-source',
  }, { output: '{"ok":true}', title: 'Recovered' });
  const storedMessages = [{ info: { id: 'message-2' }, parts: [storedPart] }];
  const storedBefore = clone(storedMessages);
  const messages = clone(storedMessages);
  const part = messages[0].parts[0];
  const output = { messages };
  await hook({}, output);

  assert.strictEqual(output.messages, messages);
  assert.strictEqual(output.messages[0].parts[0], part);
  assert.equal(part.state.input.code, OPEN_CODE_HISTORY_GUARD_MARKER);
  assert.equal(part.callID, 'call-mcp__ae__ae_execRecover-completed');
  assert.equal(part.state.output, '{"ok":true}');
  assert.deepEqual(storedMessages, storedBefore, 'the plugin must not mutate persisted history');
});
