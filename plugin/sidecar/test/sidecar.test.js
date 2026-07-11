import test from 'node:test'
import assert from 'node:assert/strict'

import { createSidecar, parseArgv } from '../lib.mjs'

const defaultOptions = {
  probe: false,
  model: 'test-model',
  lang: 'zh',
  mcp: {
    command: 'uv',
    args: ['run', 'ae-mcp'],
    env: { EXTRA: '1' }
  },
  allowedTools: ['mcp__ae__ae_ping'],
  annotations: {}
}

const WRITE_PLAN = {
  artifactId: 'user:123',
  contentHash: 'a'.repeat(64),
  operation: 'execute',
  normalizedArgs: {},
  target: { compId: '7' },
  planHash: 'b'.repeat(64),
  risk: 'write',
  expiresAt: 9999999999999
}

function planRequest(plan) {
  return {
    serverName: 'ae',
    message: 'Approve artifact plan?',
    requestedSchema: {
      type: 'object',
      'x-ae-mcp-plan': plan
    }
  }
}

test('maps user turn, text, tool_use, tool_result, and result events', async () => {
  const writes = []
  let tick = 100
  const sidecar = createSidecar({
    queryFn: async function * () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 'tool-1', name: 'mcp__ae__ae_ping', input: { ok: true } }
          ]
        }
      }
      yield {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [{ type: 'text', text: 'pong' }],
              is_error: false
            }
          ]
        }
      }
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {},
    now: () => {
      tick += 50
      return tick
    }
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'ping', permissionMode: 'none' }))
  await waitFor(() => events(writes).some((event) => event.type === 'turn-end'))

  assert.deepEqual(writes[0], { t: 'ready' })
  assert.deepEqual(events(writes), [
    { type: 'turn-start' },
    { type: 'text-delta', text: 'hello' },
    { type: 'tool-start', toolUseId: 'tool-1', name: 'mcp__ae__ae_ping', input: { ok: true } },
    { type: 'tool-result', toolUseId: 'tool-1', ok: true, text: 'pong', durationMs: 50 },
    { type: 'turn-end', stopReason: 'end_turn' }
  ])
})

test('passes session resume on the second user turn', async () => {
  const writes = []
  const seenOptions = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      seenOptions.push(options)
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {},
    now: () => 10
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'one', permissionMode: 'none' }))
  await waitFor(() => events(writes).filter((event) => event.type === 'turn-end').length === 1)
  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'two', permissionMode: 'none' }))
  await waitFor(() => events(writes).filter((event) => event.type === 'turn-end').length === 2)

  assert.equal(seenOptions[0].resume, undefined)
  assert.equal(seenOptions[1].resume, 'sess-1')
})

test('pins turn options to ae agent with annotations and allowed tools whitelist', async () => {
  const writes = []
  let seenOptions
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      seenOptions = options
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: {
      ...defaultOptions,
      allowedTools: ['mcp__ae__ae_ping', 'mcp__ae__ae_overview'],
      annotations: {
        mcp__ae__ae_ping: { readOnly: true, destructive: false },
        mcp__ae__ae_write: { readOnly: false, destructive: true }
      }
    },
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'options', permissionMode: 'none' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.equal(seenOptions.agent, 'ae')
  assert.deepEqual(seenOptions.agents.ae.tools, [
    'mcp__ae__ae_ping',
    'mcp__ae__ae_write',
    'mcp__ae__ae_overview'
  ])
  assert.equal(typeof seenOptions.agents.ae.prompt, 'string')
  assert.notEqual(seenOptions.agents.ae.prompt.length, 0)
  assert.equal(Object.hasOwn(seenOptions, 'systemPrompt'), false)
})

test('agent prompts include ExtendScript pitfall anchors in both languages', async () => {
  const zhPrompt = await captureAgentPrompt('zh')
  const enPrompt = await captureAgentPrompt('en')

  for (const prompt of [zhPrompt, enPrompt]) {
    assert.match(prompt, /AEMCP\.easeKeys/)
    assert.match(prompt, /mustFind/)
    assert.match(prompt, /matchName/)
  }
})

test('agent prompts forbid fallback screenshots and external temp-file sprawl', async () => {
  const zhPrompt = await captureAgentPrompt('zh')
  const enPrompt = await captureAgentPrompt('en')

  for (const prompt of [zhPrompt, enPrompt]) {
    assert.match(prompt, /Do not switch to OS screenshots/)
    assert.match(prompt, /report the MCP failure/)
    assert.match(prompt, /project workspace/)
    assert.match(prompt, /temporary files/)
  }
})

test('filters non ae tool_use and tool_result events while preserving ae tools', async () => {
  const writes = []
  const sidecar = createSidecar({
    queryFn: async function * () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-search-1', name: 'ToolSearch', input: { query: 'ae' } },
            { type: 'tool_use', id: 'tool-ae-1', name: 'mcp__ae__ae_ping', input: { ok: true } }
          ]
        }
      }
      yield {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-search-1',
              content: [{ type: 'text', text: 'search result' }],
              is_error: false
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-ae-1',
              content: [{ type: 'text', text: 'pong' }],
              is_error: false
            }
          ]
        }
      }
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {},
    now: () => 10
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'filter', permissionMode: 'none' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.equal(events(writes).some((event) => event.name === 'ToolSearch'), false)
  assert.equal(events(writes).some((event) => event.toolUseId === 'tool-search-1'), false)
  assert.deepEqual(events(writes).filter((event) => event.type === 'tool-start'), [
    { type: 'tool-start', toolUseId: 'tool-ae-1', name: 'mcp__ae__ae_ping', input: { ok: true } }
  ])
  assert.deepEqual(events(writes).filter((event) => event.type === 'tool-result'), [
    { type: 'tool-result', toolUseId: 'tool-ae-1', ok: true, text: 'pong', durationMs: 0 }
  ])
})

test('manual approval allow and deny resolve canUseTool correctly', async () => {
  const writes = []
  const decisions = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__ae__write', input: { a: 1 } }] }
      }
      decisions.push(await options.canUseTool('mcp__ae__write', { a: 1 }))
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-2', name: 'mcp__ae__write', input: { a: 2 } }] }
      }
      decisions.push(await options.canUseTool('mcp__ae__write', { a: 2 }))
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'write', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 1)
  assert.deepEqual(lastEvent(writes), {
    type: 'approval-required',
    toolUseId: 'tool-1',
    name: 'mcp__ae__write',
    input: { a: 1 },
    risk: 'write'
  })

  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'tool-1', decision: 'allow' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 2)
  assert.deepEqual(decisions[0], { behavior: 'allow', updatedInput: { a: 1 } })

  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'tool-2', decision: 'deny' }))
  await waitFor(() => eventCount(writes, 'tool-denied') === 1)
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.deepEqual(decisions[1], { behavior: 'deny', message: 'User denied this action.' })
  assert.deepEqual(events(writes).find((event) => event.type === 'tool-denied'), {
    type: 'tool-denied',
    toolUseId: 'tool-2'
  })
})

test('allow-session permits the same tool name without another approval', async () => {
  const writes = []
  const decisions = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__ae__write', input: {} }] }
      }
      decisions.push(await options.canUseTool('mcp__ae__write', {}))
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-2', name: 'mcp__ae__write', input: {} }] }
      }
      decisions.push(await options.canUseTool('mcp__ae__write', {}))
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'write', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 1)
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'tool-1', decision: 'allow-session' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.equal(eventCount(writes, 'approval-required'), 1)
  assert.deepEqual(decisions, [
    { behavior: 'allow', updatedInput: {} },
    { behavior: 'allow', updatedInput: {} }
  ])
})

test('auto mode allows non-destructive tools and requests approval for destructive tools', async () => {
  const writes = []
  const decisions = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      decisions.push(await options.canUseTool('mcp__ae__read', { read: true }))
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__ae__delete', input: { id: 1 } }] }
      }
      decisions.push(await options.canUseTool('mcp__ae__delete', { id: 1 }))
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: {
      ...defaultOptions,
      annotations: {
        mcp__ae__read: { readOnly: true, destructive: false },
        mcp__ae__delete: { readOnly: false, destructive: true }
      }
    },
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'auto', permissionMode: 'auto' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 1)
  assert.deepEqual(lastEvent(writes), {
    type: 'approval-required',
    toolUseId: 'tool-1',
    name: 'mcp__ae__delete',
    input: { id: 1 },
    risk: 'destructive'
  })
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'tool-1', decision: 'allow' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.deepEqual(decisions, [
    { behavior: 'allow', updatedInput: { read: true } },
    { behavior: 'allow', updatedInput: { id: 1 } }
  ])
  assert.equal(eventCount(writes, 'approval-required'), 1)
})

test('non ae tool is denied without panel approval events', async () => {
  const writes = []
  const decisions = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      decisions.push(await options.canUseTool('Bash', { command: 'date' }))
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'bad', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.deepEqual(decisions, [
    { behavior: 'deny', message: 'Only After Effects (mcp__ae__*) tools are available in this panel.' }
  ])
  assert.equal(eventCount(writes, 'approval-required'), 0)
  assert.equal(eventCount(writes, 'tool-denied'), 0)
})

test('stop aborts active turn and emits aborted error', async () => {
  const writes = []
  let queryStarted
  const started = new Promise((resolve) => {
    queryStarted = resolve
  })
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      queryStarted()
      await new Promise((resolve, reject) => {
        options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted by test')))
      })
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'long', permissionMode: 'none' }))
  await started
  sidecar.handleLine(JSON.stringify({ t: 'stop' }))
  await waitFor(() => eventCount(writes, 'error') === 1)

  assert.deepEqual(events(writes).filter((event) => event.type === 'error'), [
    { type: 'error', kind: 'aborted', message: 'Turn aborted.' }
  ])
})

test('stop drains pending approval and stale allow-session does not affect later turns', async () => {
  const writes = []
  const decisions = []
  let callCount = 0
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      callCount += 1
      const id = callCount === 1 ? 'tool-1' : 'tool-2'
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: 'mcp__ae__write', input: {} }] }
      }
      decisions.push(await options.canUseTool('mcp__ae__write', {}))
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'first', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 1)
  sidecar.handleLine(JSON.stringify({ t: 'stop' }))
  await waitFor(() => eventCount(writes, 'tool-denied') === 1 && decisions.length === 1)
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'tool-1', decision: 'allow-session' }))
  await waitFor(() => eventCount(writes, 'error') === 1)

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'second', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 2)

  assert.deepEqual(decisions[0], { behavior: 'deny', message: 'Turn was stopped.' })
  assert.deepEqual(events(writes).filter((event) => event.type === 'tool-denied'), [
    { type: 'tool-denied', toolUseId: 'tool-1' }
  ])
  assert.deepEqual(events(writes).filter((event) => event.type === 'approval-required').map((event) => event.toolUseId), [
    'tool-1',
    'tool-2'
  ])
})

test('query failure drains pending approval', async () => {
  const writes = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__ae__write', input: {} }] }
      }
      options.canUseTool('mcp__ae__write', {})
      throw new Error('sdk failed')
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'fail', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'tool-denied') === 1)

  assert.deepEqual(events(writes).filter((event) => event.type === 'tool-denied'), [
    { type: 'tool-denied', toolUseId: 'tool-1' }
  ])
})

test('approval ids stay scoped to the current turn', async () => {
  const writes = []
  let callCount = 0
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      callCount += 1
      const id = callCount === 1 ? 'tool-1' : 'tool-2'
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: 'mcp__ae__write', input: {} }] }
      }
      await options.canUseTool('mcp__ae__write', {})
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'first', permissionMode: 'none' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'second', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 1)

  assert.deepEqual(events(writes).filter((event) => event.type === 'approval-required').map((event) => event.toolUseId), [
    'tool-2'
  ])

  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'tool-2', decision: 'allow' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 2)
})

test('query login failures map to auth errors', async () => {
  const writes = []
  const sidecar = createSidecar({
    queryFn: async function * () {
      throw new Error('Not logged in · Please run /login')
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'auth', permissionMode: 'none' }))
  await waitFor(() => eventCount(writes, 'error') === 1)

  assert.equal(events(writes).find((event) => event.type === 'error').kind, 'auth')
})

test('query options env removes ANTHROPIC_API_KEY', async () => {
  const writes = []
  let queryEnv
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      queryEnv = options.env
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {
      ANTHROPIC_API_KEY: 'secret',
      KEEP_ME: 'yes'
    }
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'env', permissionMode: 'none' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.equal(queryEnv.ANTHROPIC_API_KEY, undefined)
  assert.equal(queryEnv.KEEP_ME, 'yes')
})

test('turn options always carry explicit effort and adaptive thinking when provided', async () => {
  const writes = []
  const seen = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      seen.push(options)
      yield { type: 'result', subtype: 'success', is_error: false }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'hi', permissionMode: 'manual', effort: 'xhigh', thinking: 'adaptive' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.equal(seen[0].effort, 'xhigh')
  assert.deepEqual(seen[0].thinking, { type: 'adaptive' })
})

test('effort omitted defaults to high', async () => {
  const writes = []
  const seen = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      seen.push(options)
      yield { type: 'result', subtype: 'success', is_error: false }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'hi', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.equal(seen[0].effort, 'high')
  assert.equal(seen[0].thinking, undefined)
})

test('readonly tier maps to dontAsk with read-only allowlist', async () => {
  const writes = []
  const seen = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      seen.push(options)
      yield { type: 'result', subtype: 'success', is_error: false }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: {
      ...defaultOptions,
      annotations: {
        mcp__ae__r: { readOnly: true, destructive: false },
        mcp__ae__w: { readOnly: false, destructive: false },
        mcp__ae__x: { readOnly: false, destructive: true }
      }
    },
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'hi', permissionMode: 'readonly' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.equal(seen[0].permissionMode, 'dontAsk')
  assert.deepEqual(seen[0].allowedTools, ['mcp__ae__r'])
})

test('none tier maps to dontAsk with full ae allowlist', async () => {
  const writes = []
  const seen = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      seen.push(options)
      yield { type: 'result', subtype: 'success', is_error: false }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: {
      ...defaultOptions,
      annotations: {
        mcp__ae__r: { readOnly: true, destructive: false },
        mcp__ae__w: { readOnly: false, destructive: false },
        mcp__ae__x: { readOnly: false, destructive: true }
      }
    },
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'hi', permissionMode: 'none' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.equal(seen[0].permissionMode, 'dontAsk')
  assert.deepEqual(seen[0].allowedTools.sort(), ['mcp__ae__r', 'mcp__ae__w', 'mcp__ae__x'])
})

test('auto tier pre-allows non-destructive and keeps callback for destructive', async () => {
  const writes = []
  const seen = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      seen.push(options)
      const approval = options.canUseTool('mcp__ae__x', {})
      await waitFor(() => eventCount(writes, 'approval-required') === 1)
      sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'appr-1', decision: 'allow' }))
      await approval
      yield { type: 'result', subtype: 'success', is_error: false }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: {
      ...defaultOptions,
      annotations: {
        mcp__ae__r: { readOnly: true, destructive: false },
        mcp__ae__w: { readOnly: false, destructive: false },
        mcp__ae__x: { readOnly: false, destructive: true }
      }
    },
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'hi', permissionMode: 'auto' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.equal(seen[0].permissionMode, undefined)
  assert.deepEqual(seen[0].allowedTools.sort(), ['mcp__ae__r', 'mcp__ae__w'])
  assert.equal(eventCount(writes, 'approval-required'), 1)
})

test('query model failures map to model errors', async () => {
  const writes = []
  const sidecar = createSidecar({
    queryFn: async function * () {
      throw new Error('model claude-fable-5 not_found_error')
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'model', permissionMode: 'none' }))
  await waitFor(() => eventCount(writes, 'error') === 1)

  assert.equal(events(writes).find((event) => event.type === 'error').kind, 'model')
})

test('Claude none tier still asks for an external artifact plan', async () => {
  const writes = []
  const results = []
  const externalPlan = { ...WRITE_PLAN, risk: 'external' }
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      results.push(await options.onElicitation(
        planRequest(externalPlan),
        { signal: new AbortController().signal }
      ))
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'publish', permissionMode: 'none' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 1)
  const approval = lastEvent(writes)
  assert.deepEqual(approval, {
    type: 'approval-required',
    toolUseId: 'appr-1',
    name: 'mcp__ae__ae_toolUse',
    input: externalPlan,
    risk: 'external'
  })

  sidecar.handleLine(JSON.stringify({ t: 'approve', id: approval.toolUseId, decision: 'allow' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)
  assert.deepEqual(results, [{ action: 'accept', content: { decision: 'once' } }])
})

test('Claude auto accepts a write plan once and declines a malformed plan without cards', async () => {
  const writes = []
  const results = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      const signal = new AbortController().signal
      results.push(await options.onElicitation(planRequest(WRITE_PLAN), { signal }))
      results.push(await options.onElicitation(planRequest({ risk: 'write' }), { signal }))
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'apply', permissionMode: 'auto' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.deepEqual(results, [
    { action: 'accept', content: { decision: 'once' } },
    { action: 'decline', content: {} }
  ])
  assert.equal(eventCount(writes, 'approval-required'), 0)
})

test('Claude plan session approval is bound to content hash and target', async () => {
  const writes = []
  const results = []
  const changedHash = { ...WRITE_PLAN, contentHash: 'c'.repeat(64), planHash: 'd'.repeat(64) }
  const changedTarget = { ...WRITE_PLAN, target: { compId: '8' }, planHash: 'e'.repeat(64) }
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      const signal = new AbortController().signal
      for (const plan of [WRITE_PLAN, WRITE_PLAN, changedHash, changedTarget]) {
        results.push(await options.onElicitation(planRequest(plan), { signal }))
      }
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'apply plans', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 1)
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'appr-1', decision: 'allow-session' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 2)
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'appr-2', decision: 'allow' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 3)
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'appr-3', decision: 'allow' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.deepEqual(results, [
    { action: 'accept', content: { decision: 'session' } },
    { action: 'accept', content: { decision: 'once' } },
    { action: 'accept', content: { decision: 'once' } },
    { action: 'accept', content: { decision: 'once' } }
  ])
  assert.deepEqual(
    events(writes).filter((event) => event.type === 'approval-required').map((event) => event.input),
    [WRITE_PLAN, changedHash, changedTarget]
  )
})

test('Claude rejects high-risk session approval and delegates only valid staged calls to core', async () => {
  const writes = []
  const elicitationResults = []
  const toolResults = []
  const destructivePlan = { ...WRITE_PLAN, risk: 'destructive' }
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      const signal = new AbortController().signal
      elicitationResults.push(await options.onElicitation(planRequest(destructivePlan), { signal }))
      toolResults.push(await options.canUseTool('mcp__ae__ae_toolUse', { action: 'prepare' }))
      toolResults.push(await options.canUseTool('mcp__ae__ae_toolUse', { action: 'invalid' }))
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'stage', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 1)
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'appr-1', decision: 'allow-session' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 2)
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'appr-2', decision: 'allow' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.deepEqual(elicitationResults, [{ action: 'decline', content: {} }])
  assert.deepEqual(toolResults, [
    { behavior: 'allow', updatedInput: { action: 'prepare' } },
    { behavior: 'allow', updatedInput: { action: 'invalid' } }
  ])
  assert.equal(events(writes).filter((event) => event.type === 'approval-required')[1].name, 'mcp__ae__ae_toolUse')
})

test('Claude stop drains plan approval and ignores a stale session decision', async () => {
  const writes = []
  const results = []
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      results.push(await options.onElicitation(
        planRequest(WRITE_PLAN),
        { signal: new AbortController().signal }
      ))
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'first', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 1)
  sidecar.handleLine(JSON.stringify({ t: 'stop' }))
  await waitFor(() => results.length === 1 && eventCount(writes, 'tool-denied') === 1)
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'appr-1', decision: 'allow-session' }))

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'second', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'approval-required') === 2)
  sidecar.handleLine(JSON.stringify({ t: 'approve', id: 'appr-2', decision: 'allow' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)

  assert.deepEqual(results, [
    { action: 'decline', content: {} },
    { action: 'accept', content: { decision: 'once' } }
  ])
})

test('Claude query failure drains a pending plan elicitation', async () => {
  const writes = []
  let pendingElicitation
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      pendingElicitation = options.onElicitation(
        planRequest(WRITE_PLAN),
        { signal: new AbortController().signal }
      )
      throw new Error('sdk failed')
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'fail', permissionMode: 'manual' }))
  await waitFor(() => eventCount(writes, 'error') === 1 && eventCount(writes, 'tool-denied') === 1)
  assert.deepEqual(await pendingElicitation, { action: 'decline', content: {} })
})

function events(writes) {
  return writes.filter((item) => item.t === 'event').map((item) => item.event)
}

function lastEvent(writes) {
  const all = events(writes)
  return all[all.length - 1]
}

function eventCount(writes, type) {
  return events(writes).filter((event) => event.type === type).length
}

async function waitFor(predicate) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function captureAgentPrompt(lang) {
  const writes = []
  let seenOptions
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      seenOptions = options
      yield { type: 'result', subtype: 'success', is_error: false }
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: { ...defaultOptions, lang },
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'prompt', permissionMode: 'none' }))
  await waitFor(() => eventCount(writes, 'turn-end') === 1)
  return seenOptions.agents.ae.prompt
}

test('parseArgv accepts --channel api and defaults to subscription', () => {
  assert.equal(parseArgv(['--channel', 'api']).channel, 'api')
  assert.equal(parseArgv([]).channel, 'subscription')
  assert.equal(parseArgv(['--channel', 'bogus']).channel, 'subscription')
})

test('api channel keeps injected anthropic env vars in query env', async () => {
  let queryEnv = null
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      queryEnv = options.env
      yield { type: 'result', subtype: 'success', is_error: false }
    },
    writeLine: () => {},
    argvOptions: { ...defaultOptions, channel: 'api' },
    env: { ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'tok' }
  })
  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'env', permissionMode: 'none' }))
  await waitFor(() => queryEnv !== null)
  assert.equal(queryEnv.ANTHROPIC_API_KEY, 'secret')
  assert.equal(queryEnv.ANTHROPIC_BASE_URL, 'https://relay.example')
  assert.equal(queryEnv.ANTHROPIC_AUTH_TOKEN, 'tok')
})
