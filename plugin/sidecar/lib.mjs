const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

const DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'PowerShell',
  'Task',
  'WebFetch',
  'WebSearch'
]

const AUTH_RE = /\/login|logged|credential|authentication/i

const SYSTEM_PROMPTS = {
  zh: `你是 After Effects 面板内的助手。只使用 ae_ 前缀工具操作 After Effects。回答简短，优先直接完成用户请求。

工作方式：
- 优先使用 typed 工具（ae_createLayer / ae_setProperty / ae_readProps 等）；只有没有对应工具时才用 ae_exec 写脚本。
- 写脚本前先用读工具（ae_overview / ae_layers / ae_readProps）确认结构，不要凭记忆猜测工程内容。
- ae_exec 只接受 code 与 undoGroup 两个参数，没有 comp_id 等定位参数——目标定位写在脚本里。

ExtendScript 高频陷阱（务必遵守）：
- setTemporalEaseAtKey 的缓动数组长度必须等于属性维度（一维如 Opacity=1；Scale 三维=3；空间属性如 Position=1）。直接用 AEMCP.easeKeys(prop) 自动处理。
- 任何 byName / 索引查找都可能返回 null，使用前必须判空；或用 AEMCP.mustFind(value, "名字") 让错误自带名字。
- 不存在的 API 不要臆造（如 items.byName 不存在）；不确定就先用读工具或遍历。
- 本机可能是本地化（中文）AE：显示名是翻译过的，匹配属性优先用 matchName。
- AEMCP 助手（safeValue / easeKeys / mustFind / compById / layerById）已注入，可直接调用；layerById 等用数字 id。`,
  en: `You are an assistant inside an After Effects panel. Use only ae_ prefixed tools to operate After Effects. Keep replies brief and focus on completing the user request.

Working mode:
- Prefer typed tools (ae_createLayer / ae_setProperty / ae_readProps, etc.); use ae_exec scripts only when no typed tool fits.
- Before scripting, inspect with read tools (ae_overview / ae_layers / ae_readProps) to confirm structure instead of guessing project contents.
- ae_exec accepts only code and undoGroup; it has no comp_id or other targeting parameters. Put target lookup inside the script.

ExtendScript scripting pitfalls (must follow):
- setTemporalEaseAtKey ease arrays must match the property dimension (1D like Opacity=1; Scale 3D=3; spatial properties like Position=1). Use AEMCP.easeKeys(prop) to size them automatically.
- Any byName / index lookup may return null; check before use, or call AEMCP.mustFind(value, "name") so the error names the missing target.
- Do not invent APIs that do not exist (for example items.byName); if unsure, use read tools or iterate.
- AE may be localized (Chinese): display names are translated, so prefer matchName for property matching.
- AEMCP helpers (safeValue / easeKeys / mustFind / compById / layerById) are injected and available; layerById and similar helpers expect numeric ids.`
}

export function parseArgv(argv) {
  const options = {
    probe: false,
    model: DEFAULT_MODEL,
    lang: 'zh',
    mcp: null,
    allowedTools: [],
    annotations: {}
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--probe') {
      options.probe = true
    } else if (arg === '--mcp') {
      options.mcp = parseJsonArg(argv[++i], '--mcp')
    } else if (arg === '--allowed-tools') {
      options.allowedTools = parseJsonArg(argv[++i], '--allowed-tools')
    } else if (arg === '--annotations') {
      options.annotations = parseJsonArg(argv[++i], '--annotations')
    } else if (arg === '--model') {
      options.model = argv[++i] || DEFAULT_MODEL
    } else if (arg === '--lang') {
      const lang = argv[++i]
      options.lang = lang === 'en' ? 'en' : 'zh'
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

export function createSidecar({ queryFn, writeLine, argvOptions, env, now = Date.now }) {
  if (typeof queryFn !== 'function') {
    throw new Error('queryFn is required')
  }
  if (typeof writeLine !== 'function') {
    throw new Error('writeLine is required')
  }

  const options = normalizeOptions(argvOptions)
  const baseEnv = cleanEnv(env || {})
  const approvals = new Map()
  const sessionAllowedTools = new Set()
  const toolUses = []
  const ignoredToolUseIds = new Set()
  let sessionId = null
  let approvalSeq = 0
  let activeTurn = null

  if (!options.probe) {
    writeLine({ t: 'ready' })
  }

  function emitEvent(event) {
    writeLine({ t: 'event', event })
  }

  function handleLine(line) {
    const trimmed = String(line || '').trim()
    if (!trimmed) {
      return
    }

    let message
    try {
      message = JSON.parse(trimmed)
    } catch (error) {
      emitEvent({ type: 'error', kind: 'network', message: `Invalid JSON: ${truncateDetail(error)}` })
      return
    }

    if (message.t === 'user') {
      startTurn(message)
    } else if (message.t === 'approve') {
      handleApproval(message)
    } else if (message.t === 'stop') {
      stopTurn()
    }
  }

  function startTurn(message) {
    const controller = new AbortController()
    const turn = {
      permissionMode: normalizePermissionMode(message.permissionMode),
      effort: typeof message.effort === 'string' && message.effort ? message.effort : 'high',
      thinking: message.thinking === 'adaptive' ? { type: 'adaptive' } : null,
      controller,
      stopRequested: false,
      abortedEventSent: false
    }
    activeTurn = turn

    toolUses.length = 0
    ignoredToolUseIds.clear()

    emitEvent({ type: 'turn-start' })

    runTurn(message, turn).finally(() => {
      drainApprovals('Turn ended.')
      if (activeTurn === turn) {
        activeTurn = null
      }
    })
  }

  async function runTurn(message, turn) {
    try {
      const model = typeof message.model === 'string' && message.model ? message.model : options.model
      const queryOptions = buildTurnOptions({ model, turn })

      for await (const sdkMessage of queryFn({
        prompt: String(message.text || ''),
        options: queryOptions
      })) {
        handleSdkMessage(sdkMessage, turn)
      }
    } catch (error) {
      if (turn.stopRequested) {
        emitAbortedOnce(turn)
        return
      }
      emitEvent({ type: 'error', kind: classifyError(error), message: truncateDetail(error) })
    }
  }

  function buildTurnOptions({ model, turn }) {
    const tiered = tierTools(turn.permissionMode)
    const queryOptions = {
      model,
      mcpServers: buildMcpServers(),
      allowedTools: tiered.allowedTools,
      disallowedTools: DISALLOWED_TOOLS,
      settingSources: [],
      agents: buildAgents(),
      agent: 'ae',
      canUseTool: async (toolName, input) => canUseTool(toolName, input, turn),
      env: baseEnv,
      abortController: turn.controller,
      effort: turn.effort
    }

    if (tiered.permissionMode) {
      queryOptions.permissionMode = tiered.permissionMode
    }
    if (turn.thinking) {
      queryOptions.thinking = turn.thinking
    }
    if (sessionId) {
      queryOptions.resume = sessionId
    }

    return queryOptions
  }

  function tierTools(tier) {
    const names = Object.keys(options.annotations)
    const readOnly = names.filter((name) => options.annotations[name].readOnly === true)
    const nonDestructive = names.filter((name) => options.annotations[name].destructive !== true)
    if (tier === 'readonly') return { allowedTools: readOnly, permissionMode: 'dontAsk' }
    if (tier === 'none') return { allowedTools: names, permissionMode: 'dontAsk' }
    if (tier === 'auto') return { allowedTools: uniqueToolList([...readOnly, ...nonDestructive]) }
    return { allowedTools: options.allowedTools }
  }

  function buildMcpServers() {
    if (!options.mcp) {
      return {}
    }

    return {
      ae: {
        type: 'stdio',
        command: options.mcp.command,
        args: Array.isArray(options.mcp.args) ? options.mcp.args : [],
        env: {
          ...(isPlainObject(options.mcp.env) ? options.mcp.env : {}),
          AE_MCP_BACKEND: 'ae-mcp'
        }
      }
    }
  }

  function buildAgents() {
    return {
      ae: {
        description: 'After Effects panel assistant',
        prompt: SYSTEM_PROMPTS[options.lang],
        tools: uniqueToolList([
          ...Object.keys(options.annotations),
          ...options.allowedTools
        ])
      }
    }
  }

  function handleSdkMessage(message, turn) {
    if (!message || typeof message !== 'object') {
      return
    }

    if (message.type === 'assistant') {
      for (const block of getContentBlocks(message)) {
        if (block && block.type === 'text') {
          emitEvent({ type: 'text-delta', text: String(block.text || '') })
        } else if (block && block.type === 'tool_use') {
          const toolUseId = String(block.id || '')
          const name = String(block.name || '')
          if (!name.startsWith('mcp__ae__')) {
            if (toolUseId) {
              ignoredToolUseIds.add(toolUseId)
            }
            continue
          }

          toolUses.push({
            id: toolUseId,
            name,
            startedAt: now(),
            claimed: false
          })
          emitEvent({
            type: 'tool-start',
            toolUseId,
            name,
            input: normalizeInput(block.input)
          })
        }
      }
    } else if (message.type === 'user') {
      for (const block of getContentBlocks(message)) {
        if (block && block.type === 'tool_result') {
          const toolUseId = String(block.tool_use_id || '')
          if (ignoredToolUseIds.has(toolUseId)) {
            continue
          }

          const toolUse = toolUses.find((item) => item.id === toolUseId)
          emitEvent({
            type: 'tool-result',
            toolUseId,
            ok: block.is_error !== true,
            text: toolResultText(block.content),
            durationMs: toolUse ? Math.max(0, now() - toolUse.startedAt) : 0
          })
        }
      }
    } else if (message.type === 'result') {
      if (message.session_id) {
        sessionId = message.session_id
      }

      if (turn.stopRequested) {
        emitAbortedOnce(turn)
      } else if (message.is_error) {
        emitEvent({
          type: 'error',
          kind: classifyError(message.result || message),
          message: truncateDetail(message.result || message)
        })
      } else {
        emitEvent({
          type: 'turn-end',
          stopReason: message.subtype === 'success' ? 'end_turn' : String(message.subtype || 'end_turn')
        })
      }
    }
  }

  async function canUseTool(toolName, input, turn) {
    const name = String(toolName || '')
    if (!name.startsWith('mcp__ae__')) {
      return {
        behavior: 'deny',
        message: 'Only After Effects (mcp__ae__*) tools are available in this panel.'
      }
    }

    if (sessionAllowedTools.has(name)) {
      return { behavior: 'allow', updatedInput: input }
    }

    const annotation = options.annotations[name] || {}
    const destructive = annotation.destructive === true
    if (turn.permissionMode === 'none' || (turn.permissionMode === 'auto' && !destructive)) {
      return { behavior: 'allow', updatedInput: input }
    }

    const toolUseId = claimToolUseId(name)
    const risk = destructive ? 'destructive' : 'write'

    emitEvent({
      type: 'approval-required',
      toolUseId,
      name,
      input: normalizeInput(input),
      risk
    })

    return await new Promise((resolve) => {
      approvals.set(toolUseId, {
        name,
        input,
        resolve
      })
    })
  }

  function claimToolUseId(name) {
    const toolUse = toolUses.find((item) => item.name === name && !item.claimed)
    if (toolUse) {
      toolUse.claimed = true
      return toolUse.id
    }

    approvalSeq += 1
    return `appr-${approvalSeq}`
  }

  function handleApproval(message) {
    const id = String(message.id || '')
    const pending = approvals.get(id)
    if (!pending) {
      return
    }
    approvals.delete(id)

    if (message.decision === 'allow' || message.decision === 'allow-session') {
      if (message.decision === 'allow-session') {
        sessionAllowedTools.add(pending.name)
      }
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
    } else {
      emitEvent({ type: 'tool-denied', toolUseId: id })
      pending.resolve({ behavior: 'deny', message: 'User denied this action.' })
    }
  }

  function stopTurn() {
    if (!activeTurn) {
      return
    }

    activeTurn.stopRequested = true
    activeTurn.controller.abort()
    drainApprovals('Turn was stopped.')
    emitAbortedOnce(activeTurn)
  }

  function drainApprovals(message) {
    for (const [id, pending] of approvals) {
      approvals.delete(id)
      emitEvent({ type: 'tool-denied', toolUseId: id })
      pending.resolve({ behavior: 'deny', message })
    }
  }

  function emitAbortedOnce(turn) {
    if (turn.abortedEventSent) {
      return
    }
    turn.abortedEventSent = true
    emitEvent({ type: 'error', kind: 'aborted', message: 'Turn aborted.' })
  }

  async function runProbe() {
    try {
      let sawResult = false
      for await (const message of queryFn({
        prompt: 'Reply with exactly: pong',
        options: {
          model: options.model,
          maxTurns: 1,
          allowedTools: [],
          disallowedTools: DISALLOWED_TOOLS,
          settingSources: [],
          env: baseEnv
        }
      })) {
        if (message && message.type === 'result') {
          sawResult = true
          if (message.is_error) {
            const detail = truncateDetail(message.result || message)
            const auth = AUTH_RE.test(detail)
            writeLine({
              t: 'probe-result',
              ok: false,
              loggedIn: false,
              reason: auth ? 'not-logged-in' : 'query-failed',
              detail
            })
            return auth ? 2 : 3
          }
        }
      }

      if (sawResult) {
        writeLine({ t: 'probe-result', ok: true, loggedIn: true, reason: null, detail: '' })
        return 0
      }

      writeLine({
        t: 'probe-result',
        ok: false,
        loggedIn: true,
        reason: 'query-failed',
        detail: 'query completed without result'
      })
      return 3
    } catch (error) {
      const detail = truncateDetail(error)
      const auth = AUTH_RE.test(detail)
      writeLine({
        t: 'probe-result',
        ok: false,
        loggedIn: !auth,
        reason: auth ? 'not-logged-in' : 'query-failed',
        detail
      })
      return auth ? 2 : 3
    }
  }

  return { handleLine, runProbe }
}

function normalizeOptions(argvOptions = {}) {
  return {
    probe: argvOptions.probe === true,
    model: argvOptions.model || DEFAULT_MODEL,
    lang: argvOptions.lang === 'en' ? 'en' : 'zh',
    mcp: argvOptions.mcp || null,
    allowedTools: Array.isArray(argvOptions.allowedTools) ? argvOptions.allowedTools : [],
    annotations: isPlainObject(argvOptions.annotations) ? argvOptions.annotations : {}
  }
}

function parseJsonArg(value, name) {
  if (typeof value !== 'string') {
    throw new Error(`${name} requires a JSON value`)
  }
  return JSON.parse(value)
}

function cleanEnv(inputEnv) {
  const output = { ...inputEnv }
  delete output.ANTHROPIC_API_KEY
  return output
}

function normalizePermissionMode(mode) {
  if (mode === 'manual' || mode === 'auto' || mode === 'none' || mode === 'readonly') {
    return mode
  }
  return 'manual'
}

function getContentBlocks(message) {
  const content = message && message.message && message.message.content
  return Array.isArray(content) ? content : []
}

function toolResultText(content) {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && item.type === 'text')
      .map((item) => String(item.text || ''))
      .join('')
  }
  return ''
}

function uniqueToolList(items) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    if (typeof item !== 'string' || seen.has(item)) {
      continue
    }
    seen.add(item)
    result.push(item)
  }
  return result
}

function normalizeInput(input) {
  return isPlainObject(input) ? input : {}
}

function classifyError(error) {
  const detail = truncateDetail(error)
  const MODEL_RE = /not_found|model.*(unavailable|not available|does not exist)/i
  if (AUTH_RE.test(detail)) return 'auth'
  if (MODEL_RE.test(detail)) return 'model'
  return 'network'
}

function truncateDetail(error) {
  let detail
  if (typeof error === 'string') {
    detail = error
  } else if (error && typeof error.message === 'string') {
    detail = error.message
  } else {
    try {
      detail = JSON.stringify(error)
    } catch {
      detail = String(error)
    }
  }
  return String(detail || '').slice(0, 500)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
