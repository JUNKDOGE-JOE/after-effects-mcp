import test from 'node:test'
import assert from 'node:assert/strict'

import { createSidecar } from '../lib.mjs'

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
    env: {}
  })

  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'one', permissionMode: 'none' }))
  await waitFor(() => events(writes).filter((event) => event.type === 'turn-end').length === 1)
  sidecar.handleLine(JSON.stringify({ t: 'user', text: 'two', permissionMode: 'none' }))
  await waitFor(() => events(writes).filter((event) => event.type === 'turn-end').length === 2)

  assert.equal(seenOptions[0].resume, undefined)
  assert.equal(seenOptions[1].resume, 'sess-1')
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

  assert.deepEqual(decisions, [{ behavior: 'deny', message: 'panel denied non-ae tool' }])
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
