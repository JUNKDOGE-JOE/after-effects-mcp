import { createNdjsonReader } from '../lib/ndjson.js';
import { claudeChannelEnv } from '../lib/claudeChannel.js';
import { createDeltaRedactor, redactValue } from '../lib/exactSecretRedaction.js';
import { createPlatformAdapter } from './platform/index.js';
import {
  normalizeTurnInput,
  withAttachmentManifest,
} from '../../../shared/chat-attachments.mjs';
import { isCoreAuthorizedDynamicCall } from '../../../shared/tool-approval.mjs';
import {
  answersForAskUserQuestion,
  displayAnswers,
  questionsFromAskUserQuestion,
} from '../lib/questionForm.js';

export const CLAUDE_MINIMUM_VERSION = '2.0.0';

const STDERR_TAIL_LIMIT = 4096;
const DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'PowerShell',
  'Task',
  'WebFetch',
  'WebSearch',
];
const ATTACHMENT_READ_RULE = [
  'Read may be used only for exact paths listed in the current',
  '<ae_mcp_attachments> manifest.',
].join(' ');

const SYSTEM_PROMPTS = {
  zh: [
    '你是 After Effects 面板内的助手。只使用 ae_ 前缀工具操作 After Effects。回答简短，' +
      '优先直接完成用户请求。',
    '',
    '工作方式：',
    '- 优先使用工具列表里的结构化工具（读取优先 ae_read 这类读工具；已存工具用 ' +
      'ae_toolSearch 找、ae_toolUse 执行）；没有对应工具时才用 ae_exec 写脚本。',
    '- 写脚本前先用读工具确认结构，不要凭记忆猜测工程内容。',
    '- ae_exec 没有 comp_id 等定位参数——目标定位写在脚本里。',
    '- MCP/面板通道不可用时，Do not switch to OS screenshots、桌面自动化或' +
      '外部临时脚本；report the MCP failure 给用户。',
    '- 生成文件和 temporary files 放在 project workspace 或用户明确同意的输出目录，' +
      '不要散落到工作区外。',
    '',
    'ExtendScript 高频陷阱（务必遵守）：',
    '- setTemporalEaseAtKey 的缓动数组长度必须等于属性维度（一维如 Opacity=1；' +
      'Scale 三维=3；空间属性如 Position=1）。直接用 AEMCP.easeKeys(prop) 自动处理。',
    '- 任何 byName / 索引查找都可能返回 null，使用前必须判空；或用 ' +
      'AEMCP.mustFind(value, "名字") 让错误自带名字。',
    '- 不存在的 API 不要臆造（如 items.byName 不存在）；不确定就先用读工具或遍历。',
    '- 本机可能是本地化（中文）AE：显示名是翻译过的，匹配属性优先用 matchName。',
    '- AEMCP 助手（safeValue / easeKeys / mustFind / compById / layerById）已注入，' +
      '可直接调用；layerById 等用数字 id。',
  ].join('\n'),
  en: [
    'You are an assistant inside an After Effects panel. Use only ae_ prefixed tools to ' +
      'operate After Effects. Keep replies brief and focus on completing the user request.',
    '',
    'Working mode:',
    '- Prefer the structured tools in your tool list (reads via ae_read-style read ' +
      'tools; stored tools via ae_toolSearch / ae_toolUse); use ae_exec scripts only ' +
      'when no tool fits.',
    '- Before scripting, inspect with read tools to confirm structure instead of ' +
      'guessing project contents.',
    '- ae_exec has no comp_id or other targeting parameters. Put target lookup inside ' +
      'the script.',
    '- If the MCP/panel path is unavailable, do not switch to OS screenshots, desktop ' +
      'automation, or ad-hoc external scripts; report the MCP failure to the user.',
    '- Keep generated files and temporary files in the project workspace or a ' +
      'user-approved output directory; do not scatter files outside it.',
    '',
    'ExtendScript scripting pitfalls (must follow):',
    '- setTemporalEaseAtKey ease arrays must match the property dimension (1D like ' +
      'Opacity=1; Scale 3D=3; spatial properties like Position=1). Use ' +
      'AEMCP.easeKeys(prop) to size them automatically.',
    '- Any byName / index lookup may return null; check before use, or call ' +
      'AEMCP.mustFind(value, "name") so the error names the missing target.',
    '- Do not invent APIs that do not exist (for example items.byName); if unsure, use ' +
      'read tools or iterate.',
    '- AE may be localized (Chinese): display names are translated, so prefer matchName ' +
      'for property matching.',
    '- AEMCP helpers (safeValue / easeKeys / mustFind / compById / layerById) are ' +
      'injected and available; layerById and similar helpers expect numeric ids.',
  ].join('\n'),
};

function requiredArchitecture(adapter) {
  if (adapter.id === 'macos-arm64') return 'arm64';
  if (adapter.id === 'windows-x64') return 'x64';
  return undefined;
}

function cliResolutionMessage(code, lang) {
  if (code === 'VERSION_TOO_OLD') {
    return lang === 'zh'
      ? 'Claude CLI 版本过旧，请升级 Claude CLI 到 2.x 或更高版本。'
      : 'Claude CLI is too old. Upgrade Claude CLI to version 2.x or newer.';
  }
  return lang === 'zh'
    ? '未找到 Claude CLI。请安装 Claude Code 2.x，并确保 claude 在 PATH 中。'
    : 'Claude CLI was not found. Install Claude Code 2.x and put claude on PATH.';
}

export async function resolveClaudeCli({ platform, env, lang = 'zh' } = {}) {
  const adapter = platform || createPlatformAdapter();
  const arch = requiredArchitecture(adapter);
  const options = {
    minimumVersion: CLAUDE_MINIMUM_VERSION,
    ...(arch ? { requiredArch: arch } : {}),
    ...(env === undefined ? {} : { env }),
  };
  const resolved = await adapter.resolveExecutable('claude', options);
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      detail: cliResolutionMessage(resolved.code, lang),
      resolution: resolved,
    };
  }
  return {
    ok: true,
    cliPath: resolved.path,
    displayPath: resolved.displayPath || resolved.path,
    version: resolved.version || '',
    executable: resolved,
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function appendTail(tail, chunk) {
  const next = tail + String(chunk || '');
  return next.length > STDERR_TAIL_LIMIT
    ? next.slice(next.length - STDERR_TAIL_LIMIT)
    : next;
}

function randomTempName() {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2);
  return `ae-claude-${stamp}-${random}`;
}

function normalizePermissionMode(mode) {
  if (['manual', 'auto', 'none', 'readonly'].includes(mode)) return mode;
  return 'manual';
}

function cancelledStartError() {
  const error = new Error('Claude CLI start was cancelled');
  error.code = 'CLAUDE_AGENT_START_CANCELLED';
  return error;
}

function uniqueToolList(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (typeof item !== 'string' || !item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInput(input) {
  return isPlainObject(input) ? input : {};
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && item.type === 'text')
    .map((item) => String(item.text || ''))
    .join('');
}

function classifyError(error) {
  const detail = truncateDetail(error);
  if (/\/login|logged|credential|authentication/i.test(detail)) return 'auth';
  if (/not_found|model.*(unavailable|not available|does not exist)/i.test(detail)) {
    return 'model';
  }
  return 'network';
}

function truncateDetail(error) {
  let detail;
  if (typeof error === 'string') detail = error;
  else if (error && typeof error.message === 'string') detail = error.message;
  else {
    try { detail = JSON.stringify(error); } catch { detail = String(error); }
  }
  return String(detail || '').slice(0, 500);
}

function normalizedThinking(value) {
  if (value === 'adaptive') return { type: 'adaptive' };
  if (!isPlainObject(value)) return null;
  if (value.type === 'adaptive' || value.type === 'disabled') {
    return { type: value.type };
  }
  if (value.type === 'enabled') {
    const budgetTokens = Number(value.budgetTokens);
    return Number.isFinite(budgetTokens) && budgetTokens >= 0
      ? { type: 'enabled', budgetTokens: Math.floor(budgetTokens) }
      : { type: 'enabled' };
  }
  return null;
}

function thinkingArgs(value) {
  const thinking = normalizedThinking(value);
  if (!thinking) return [];
  if (thinking.type === 'disabled') return ['--thinking', 'disabled'];
  if (thinking.type === 'enabled' && thinking.budgetTokens !== undefined) {
    return ['--max-thinking-tokens', String(thinking.budgetTokens)];
  }
  return ['--thinking', 'adaptive'];
}

function tierAllowedTools(meta, permissionMode, attachments) {
  const annotations = isPlainObject(meta?.annotations) ? meta.annotations : {};
  const names = Object.keys(annotations);
  const readOnly = names.filter((name) => annotations[name]?.readOnly === true);
  const nonDestructive = names.filter(
    (name) => annotations[name]?.destructive !== true,
  );
  let tools;
  if (permissionMode === 'readonly') tools = readOnly;
  else if (permissionMode === 'none') tools = names;
  else if (permissionMode === 'auto') tools = [...readOnly, ...nonDestructive];
  else tools = Array.isArray(meta?.allowedTools) ? meta.allowedTools : [];
  const attachmentRules = attachments.map(
    (attachment) => `Read(${attachment.localPath})`,
  );
  return uniqueToolList([...tools, ...attachmentRules]);
}

function agentDefinition(meta, attachments, lang) {
  const annotations = isPlainObject(meta?.annotations) ? meta.annotations : {};
  const attachmentTools = attachments.length ? ['Read'] : [];
  const prompt = attachments.length
    ? `${SYSTEM_PROMPTS[lang]}\n\n${ATTACHMENT_READ_RULE}`
    : SYSTEM_PROMPTS[lang];
  return {
    ae: {
      description: 'After Effects panel assistant',
      prompt,
      tools: uniqueToolList([
        ...Object.keys(annotations),
        ...(Array.isArray(meta?.allowedTools) ? meta.allowedTools : []),
        ...attachmentTools,
        'AskUserQuestion',
      ]),
    },
  };
}

function mcpConfigForSpec(spec) {
  return {
    mcpServers: {
      ae: { type: 'http', url: String(spec?.url || '') },
    },
  };
}

function processSettingsIdentity({ session, turn, meta, mcpSpec }) {
  return JSON.stringify({
    model: session.model,
    effort: session.effort,
    thinking: normalizedThinking(session.thinking),
    permissionMode: turn.permissionMode,
    attachments: turn.attachments.map((attachment) => attachment.localPath),
    meta,
    mcp: mcpConfigForSpec(mcpSpec),
  });
}

export function createClaudeAgentBackend({
  platform,
  resolveClaude = resolveClaudeCli,
  getMcpSpec,
  getToolMeta,
  getModel,
  getPermissionMode,
  getEffort,
  getThinking,
  onEvent,
  lang = 'zh',
  spawnImpl,
  fsImpl,
  tempDirName = randomTempName,
  now = Date.now,
  env,
} = {}) {
  const adapter = platform || createPlatformAdapter();
  const fs = fsImpl || adapter.fs;
  const spawnProcess = spawnImpl
    ? (executable, args, options) => spawnImpl(
      executable.path,
      [...(executable.argsPrefix || []), ...args],
      options,
    )
    : (executable, args, options) => adapter.spawn(executable, args, options);

  let proc = null;
  let startPromise = null;
  let stderrTail = '';
  let transcript = [];
  let activeRun = null;
  let activeResolve = null;
  let activeAssistantText = '';
  let activeTurn = null;
  let activeTurnAccepted = false;
  let activeTurnDispatched = false;
  let activeSawTextDelta = false;
  let activeAttachmentPaths = [];
  let processChannel = 'subscription';
  let processConversationIdentity = null;
  let processSettings = null;
  let sessionId = null;
  let runtimeGeneration = 0;
  let configDir = '';
  let providerSensitiveValues = [];
  let providerDeltaPhase;
  let thinkingActive = false;
  let providerDeltaRedactor = createDeltaRedactor([], () => {});
  const pendingApprovals = new Map();
  const pendingQuestions = new Map();
  const sessionAllowedTools = new Set();
  const startedTools = new Map();

  function emit(evt) {
    let event = evt;
    if (event?.type === 'error' && activeTurn?.turnId && !event.turnId) {
      event = {
        ...event,
        turnId: activeTurn.turnId,
        ...(!activeTurnAccepted ? {
          dispatchState: activeTurnDispatched ? 'uncertain' : 'not-started',
        } : {}),
      };
    }
    if (onEvent) {
      onEvent(redactValue(event, [
        ...providerSensitiveValues,
        ...activeAttachmentPaths,
      ]));
    }
  }

  function resetProviderDeltaRedactor() {
    providerDeltaRedactor.discard();
    providerDeltaPhase = undefined;
    providerDeltaRedactor = createDeltaRedactor([
      ...providerSensitiveValues,
      ...activeAttachmentPaths,
    ], (text) => {
      activeAssistantText += text;
      activeSawTextDelta = true;
      emit({
        type: 'text-delta',
        text,
        ...(providerDeltaPhase ? { phase: providerDeltaPhase } : {}),
      });
    });
  }

  function setProviderSensitiveValues(values) {
    providerSensitiveValues = Array.from(new Set((values || [])
      .filter((value) => typeof value === 'string' && value)))
      .sort((left, right) => right.length - left.length);
    resetProviderDeltaRedactor();
  }

  function clearProviderSensitiveValues() {
    providerDeltaRedactor.discard();
    providerSensitiveValues = [];
    providerDeltaPhase = undefined;
    providerDeltaRedactor = createDeltaRedactor(activeAttachmentPaths, () => {});
  }

  function setActiveAttachmentPaths(values) {
    activeAttachmentPaths = Array.from(new Set((values || [])
      .filter((value) => typeof value === 'string' && value)))
      .sort((left, right) => right.length - left.length);
    if (stderrTail) stderrTail = redactValue(stderrTail, activeAttachmentPaths);
    resetProviderDeltaRedactor();
  }

  function setThinking(active) {
    const next = Boolean(active);
    if (thinkingActive === next) return;
    thinkingActive = next;
    emit({ type: 'thinking', active: next });
  }

  function writeMessage(message) {
    if (!proc?.stdin?.write) return false;
    // Immediate input avoids the harmless -p idle-stdin warning observed after about 3 seconds.
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  function writeControlResponse(requestId, response) {
    return writeMessage({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response,
      },
    });
  }

  function denyControl(requestId, message) {
    writeControlResponse(requestId, {
      behavior: 'deny',
      message,
    });
  }

  function allowControl(requestId, input) {
    writeControlResponse(requestId, {
      behavior: 'allow',
      updatedInput: input,
    });
  }

  function drainControls(message, writeResponses = true) {
    for (const [toolUseId, pending] of pendingApprovals) {
      pendingApprovals.delete(toolUseId);
      if (writeResponses) denyControl(pending.requestId, message);
      emit({ type: 'tool-denied', toolUseId });
    }
    for (const [toolUseId, pending] of pendingQuestions) {
      pendingQuestions.delete(toolUseId);
      if (writeResponses) denyControl(pending.requestId, message);
      emit({ type: 'question-resolved', toolUseId, outcome: 'cancelled' });
    }
  }

  function finishActive() {
    const resolve = activeResolve;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    activeTurn = null;
    activeTurnAccepted = false;
    activeTurnDispatched = false;
    activeSawTextDelta = false;
    startedTools.clear();
    setActiveAttachmentPaths([]);
    if (resolve) resolve();
  }

  function answerQuestion(toolUseId, result) {
    const id = String(toolUseId || '');
    const pending = pendingQuestions.get(id);
    if (!pending) return false;
    pendingQuestions.delete(id);
    if (!result || result.action !== 'submit') {
      denyControl(pending.requestId, 'User dismissed the question.');
      emit({ type: 'question-resolved', toolUseId: id, outcome: 'cancelled' });
      return true;
    }
    const answers = answersForAskUserQuestion(pending.questions, result.values);
    allowControl(pending.requestId, {
      ...pending.input,
      questions: pending.originalQuestions,
      answers,
    });
    emit({
      type: 'question-resolved',
      toolUseId: id,
      outcome: 'answered',
      answers: displayAnswers(pending.questions, result.values),
    });
    return true;
  }

  function approve(toolUseId, decision) {
    const id = String(toolUseId || '');
    const pending = pendingApprovals.get(id);
    if (!pending) return false;
    pendingApprovals.delete(id);
    if (decision === 'allow' || decision === 'allow-session') {
      if (decision === 'allow-session') sessionAllowedTools.add(pending.name);
      allowControl(pending.requestId, pending.input);
      return true;
    }
    denyControl(pending.requestId, 'User denied this action.');
    emit({ type: 'tool-denied', toolUseId: id });
    return true;
  }

  function cleanupConfig() {
    const directory = configDir;
    configDir = '';
    if (!directory) return;
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }

  async function discardRuntime({
    clearTranscript = false,
    clearSession = false,
    finishRun = false,
    clearStderr = false,
  } = {}) {
    runtimeGeneration += 1;
    drainControls('Claude CLI session ended.');
    setThinking(false);
    const current = proc;
    proc = null;
    startPromise = null;
    processSettings = null;
    if (current) {
      try { current.kill(); } catch {}
    }
    cleanupConfig();
    if (clearTranscript) transcript = [];
    if (clearSession) {
      sessionId = null;
      processConversationIdentity = null;
      sessionAllowedTools.clear();
    }
    if (finishRun) finishActive();
    if (clearStderr) stderrTail = '';
    clearProviderSensitiveValues();
  }

  function handleProcessFailure(target, generation, message) {
    if (generation !== runtimeGeneration || proc !== target) return;
    runtimeGeneration += 1;
    proc = null;
    startPromise = null;
    processSettings = null;
    setThinking(false);
    drainControls('Claude CLI process ended.', false);
    cleanupConfig();
    if (activeRun) {
      providerDeltaRedactor.flush();
      emit({
        type: 'error',
        kind: 'mcp',
        message,
      });
      finishActive();
    }
    processChannel = 'subscription';
    clearProviderSensitiveValues();
  }

  function handleExit(target, generation, code, signal) {
    const suffix = signal ? `${code} ${signal}` : String(code);
    const detail = stderrTail ? `${suffix} ${stderrTail}` : suffix;
    handleProcessFailure(target, generation, `Claude CLI exited: ${detail}`);
  }

  function handleProcError(target, generation, error) {
    const message = error?.message || 'Claude CLI process error';
    handleProcessFailure(target, generation, message);
  }

  function markTurnAccepted() {
    if (!activeTurn || activeTurnAccepted) return;
    activeTurnAccepted = true;
    if (activeTurn.turnId) {
      emit({
        type: 'turn-accepted',
        turnId: activeTurn.turnId,
        transport: 'claude-cli-stream-json',
      });
    }
  }

  function handleAssistantMessage(message) {
    const blocks = Array.isArray(message?.message?.content)
      ? message.message.content
      : [];
    for (const block of blocks) {
      if (block?.type === 'text' && !activeSawTextDelta) {
        const text = String(block.text || '');
        if (text) providerDeltaRedactor.feed(text);
        continue;
      }
      if (block?.type !== 'tool_use') continue;
      const toolUseId = String(block.id || '');
      const name = String(block.name || '');
      if (!toolUseId || !name.startsWith('mcp__ae__')) continue;
      if (startedTools.has(toolUseId)) continue;
      startedTools.set(toolUseId, {
        name,
        startedAt: now(),
      });
      emit({
        type: 'tool-start',
        toolUseId,
        name,
        input: normalizeInput(block.input),
      });
    }
  }

  function handleUserMessage(message) {
    const blocks = Array.isArray(message?.message?.content)
      ? message.message.content
      : [];
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue;
      const toolUseId = String(block.tool_use_id || '');
      const tool = startedTools.get(toolUseId);
      if (!tool) continue;
      emit({
        type: 'tool-result',
        toolUseId,
        ok: block.is_error !== true,
        text: toolResultText(block.content),
        durationMs: Math.max(0, now() - tool.startedAt),
      });
    }
  }

  function readDecision(name, input, turn) {
    if (name === 'Read') {
      const filePath = input?.file_path;
      if (!turn.attachments.length || typeof filePath !== 'string') {
        return { behavior: 'deny', message: 'Read is limited to selected attachment files.' };
      }
      try {
        const realPath = String(fs.realpathSync(filePath));
        const selected = turn.attachments.some(
          (attachment) => attachment.localPath === realPath,
        );
        if (realPath !== filePath || !fs.statSync(realPath).isFile() || !selected) {
          throw new Error('attachment mismatch');
        }
        return { behavior: 'allow', updatedInput: input };
      } catch {
        return { behavior: 'deny', message: 'Read is limited to selected attachment files.' };
      }
    }
    return null;
  }

  function immediateToolDecision(name, input, turn) {
    const read = readDecision(name, input, turn);
    if (read) return read;
    if (!name.startsWith('mcp__ae__')) {
      return {
        behavior: 'deny',
        message: 'Only After Effects (mcp__ae__*) tools are available in this panel.',
      };
    }
    const annotation = turn.toolMeta.annotations[name] || {};
    if (turn.permissionMode === 'readonly') {
      return annotation.readOnly === true
        ? { behavior: 'allow', updatedInput: input }
        : {
          behavior: 'deny',
          message: 'This tool is unavailable in the read-only tier.',
        };
    }
    if (isCoreAuthorizedDynamicCall(name, input)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (sessionAllowedTools.has(name)) {
      return { behavior: 'allow', updatedInput: input };
    }
    const destructive = annotation.destructive === true;
    if (turn.permissionMode === 'none') {
      return { behavior: 'allow', updatedInput: input };
    }
    if (turn.permissionMode === 'auto' && !destructive) {
      return { behavior: 'allow', updatedInput: input };
    }
    return null;
  }

  function handleAskUserQuestion(requestId, request, input) {
    const originalQuestions = Array.isArray(input.questions) ? input.questions : [];
    if (!originalQuestions.length) {
      allowControl(requestId, { ...input, questions: originalQuestions, answers: {} });
      return;
    }
    const toolUseId = String(request.tool_use_id || requestId);
    const questions = questionsFromAskUserQuestion(input);
    pendingQuestions.set(toolUseId, {
      requestId,
      input,
      originalQuestions,
      questions,
    });
    emit({
      type: 'question-required',
      toolUseId,
      source: 'claude-ask-user-question',
      title: '',
      questions,
    });
  }

  function handleControlRequest(message) {
    const requestId = String(message?.request_id || '');
    const request = message?.request;
    if (!requestId || request?.subtype !== 'can_use_tool') return;
    const name = String(request.tool_name || '');
    const input = normalizeInput(request.input);
    if (name === 'AskUserQuestion') {
      handleAskUserQuestion(requestId, request, input);
      return;
    }
    if (!activeTurn) {
      denyControl(requestId, 'No active panel turn owns this tool request.');
      return;
    }
    const decision = immediateToolDecision(name, input, activeTurn);
    if (decision) {
      if (decision.behavior === 'allow') allowControl(requestId, decision.updatedInput);
      else denyControl(requestId, decision.message);
      return;
    }
    const toolUseId = String(request.tool_use_id || requestId);
    const annotation = activeTurn.toolMeta.annotations[name] || {};
    pendingApprovals.set(toolUseId, { requestId, name, input });
    emit({
      type: 'approval-required',
      toolUseId,
      name,
      input,
      risk: annotation.destructive === true ? 'destructive' : 'write',
    });
  }

  function handleStreamEvent(message) {
    const event = message?.event;
    if (!event) return;
    if (event.type === 'content_block_start') {
      const type = event.content_block?.type;
      if (type === 'thinking') setThinking(true);
      if (type === 'text' || type === 'tool_use') setThinking(false);
      return;
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta || {};
      if (delta.type === 'thinking_delta') {
        setThinking(true);
      } else if (delta.type === 'text_delta') {
        setThinking(false);
        activeSawTextDelta = true;
        providerDeltaRedactor.feed(String(delta.text || ''));
      }
      return;
    }
    if (event.type === 'message_stop') setThinking(false);
  }

  function handleResult(message) {
    if (!activeRun) return;
    markTurnAccepted();
    providerDeltaRedactor.flush();
    setThinking(false);
    drainControls('Claude CLI turn ended.');
    if (message.is_error) {
      emit({
        type: 'error',
        kind: classifyError(message.result || message),
        message: apiSafeErrorMessage(truncateDetail(message.result || message)),
      });
      finishActive();
      return;
    }
    if (!activeAssistantText && typeof message.result === 'string' && message.result) {
      providerDeltaRedactor.feed(message.result);
      providerDeltaRedactor.flush();
    }
    transcript.push({ role: 'assistant', text: activeAssistantText });
    emit({
      type: 'turn-end',
      stopReason: message.stop_reason
        || (message.subtype === 'success' ? 'end_turn' : String(message.subtype || 'end_turn')),
    });
    finishActive();
  }

  function handleCliMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.session_id) sessionId = String(message.session_id);
    if (message.type === 'system' && message.subtype === 'init') {
      markTurnAccepted();
      return;
    }
    if (message.type === 'stream_event') {
      handleStreamEvent(message);
      return;
    }
    if (message.type === 'assistant') {
      handleAssistantMessage(message);
      return;
    }
    if (message.type === 'user') {
      handleUserMessage(message);
      return;
    }
    if (message.type === 'control_request') {
      handleControlRequest(message);
      return;
    }
    if (message.type === 'result') handleResult(message);
  }

  function desiredSession() {
    const model = String(getModel ? getModel() : '').trim();
    const effort = String(getEffort ? getEffort() || '' : '').trim();
    const thinking = getThinking ? getThinking() : null;
    return {
      channel: 'subscription',
      model,
      effort,
      thinking,
      conversationIdentity: 'subscription',
    };
  }

  function canonicalTurn(input) {
    const normalized = normalizeTurnInput(input);
    const attachments = normalized.attachments.map((attachment) => {
      if (!adapter.paths.isAbsolute(attachment.localPath)) {
        throw new Error('attachment path must be absolute');
      }
      const realPath = String(fs.realpathSync(attachment.localPath));
      if (!adapter.paths.isAbsolute(realPath) || !fs.statSync(realPath).isFile()) {
        throw new Error('attachment path must resolve to a file');
      }
      return Object.freeze({ ...attachment, localPath: realPath });
    });
    return {
      ...normalized,
      attachments,
      permissionMode: normalizePermissionMode(getPermissionMode?.()),
      toolMeta: { allowedTools: [], annotations: {} },
    };
  }

  function writeMcpConfig(mcpSpec) {
    configDir = adapter.paths.join([adapter.paths.tempRoot, tempDirName()]);
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = adapter.paths.join([configDir, 'mcp.json']);
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(mcpConfigForSpec(mcpSpec), null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    try { fs.chmodSync?.(configPath, 0o600); } catch {}
    return configPath;
  }

  function buildCliArgs(session, turn, meta, mcpPath) {
    // Strict MCP tools may be deferred; a model ToolSearch hop before an AE call is expected.
    const allowedTools = tierAllowedTools(meta, turn.permissionMode, turn.attachments);
    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      session.model,
      '--mcp-config',
      mcpPath,
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--permission-prompt-tool',
      'stdio',
      '--disallowedTools',
      ...DISALLOWED_TOOLS,
    ];
    if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
    args.push(
      '--agents',
      JSON.stringify(agentDefinition(meta, turn.attachments, lang)),
      '--agent',
      'ae',
    );
    if (session.effort) args.push('--effort', session.effort);
    args.push(...thinkingArgs(session.thinking));
    if (sessionId) args.push('--resume', sessionId);
    return args;
  }

  async function startCli(session, turn, meta, mcpSpec, settingsIdentity) {
    if (proc && processSettings === settingsIdentity) return true;
    if (startPromise) return startPromise;
    const pendingStart = (async () => {
      const resolved = await resolveClaude({ platform: adapter, env, lang });
      if (activeRun === null) throw cancelledStartError();
      if (!resolved?.ok) {
        emit({
          type: 'error',
          kind: 'mcp',
          code: resolved?.code || 'NOT_FOUND',
          message: resolved?.detail || cliResolutionMessage(resolved?.code, lang),
        });
        return false;
      }
      setProviderSensitiveValues([]);
      const mcpPath = writeMcpConfig(mcpSpec);
      let spawnEnv = claudeChannelEnv(adapter.completeSpawnEnv(env || {}));
      stderrTail = '';
      processChannel = 'subscription';
      const executable = resolved.executable || {
        ok: true,
        id: 'claude',
        path: resolved.cliPath,
        argsPrefix: [],
        source: 'path',
        version: resolved.version || null,
        arch: null,
      };
      const args = buildCliArgs(session, turn, meta, mcpPath);
      let spawnedProc;
      try {
        spawnedProc = spawnProcess(executable, args, {
          stdio: 'pipe',
          windowsHide: true,
          env: spawnEnv,
        });
      } finally {
        if (spawnEnv) delete spawnEnv.ANTHROPIC_AUTH_TOKEN;
        spawnEnv = null;
      }
      runtimeGeneration += 1;
      const generation = runtimeGeneration;
      proc = spawnedProc;
      processSettings = settingsIdentity;
      const reader = createNdjsonReader((message) => {
        if (generation !== runtimeGeneration || proc !== spawnedProc) return;
        handleCliMessage(message);
      });
      spawnedProc.stdout?.on?.('data', reader);
      spawnedProc.stderr?.on?.('data', (chunk) => {
        if (generation !== runtimeGeneration || proc !== spawnedProc) return;
        const detail = redactValue(String(chunk), [
          ...providerSensitiveValues,
          ...activeAttachmentPaths,
        ]);
        stderrTail = appendTail(stderrTail, detail);
      });
      spawnedProc.on?.('exit', (code, signal) => {
        handleExit(spawnedProc, generation, code, signal);
      });
      spawnedProc.on?.('error', (error) => {
        handleProcError(spawnedProc, generation, error);
      });
      return true;
    })();
    startPromise = pendingStart;
    try {
      return await pendingStart;
    } catch (error) {
      cleanupConfig();
      clearProviderSensitiveValues();
      if (error?.code !== 'CLAUDE_AGENT_START_CANCELLED') {
        emit({
          type: 'error',
          kind: error?.kind || 'mcp',
          ...(error?.code ? { code: error.code } : {}),
          message: error?.message || 'Failed to start Claude CLI.',
        });
      }
      return false;
    } finally {
      if (startPromise === pendingStart) startPromise = null;
    }
  }

  async function ensureCli(runToken, turn) {
    try {
      const session = desiredSession();
      if (activeRun !== runToken) throw cancelledStartError();
      const meta = getToolMeta
        ? await getToolMeta()
        : { allowedTools: [], annotations: {} };
      const normalizedMeta = {
        allowedTools: Array.isArray(meta?.allowedTools) ? meta.allowedTools : [],
        annotations: isPlainObject(meta?.annotations) ? meta.annotations : {},
      };
      const mcpSpec = await getMcpSpec();
      if (activeRun !== runToken) throw cancelledStartError();
      turn.toolMeta = normalizedMeta;
      const nextSettings = processSettingsIdentity({
        session,
        turn,
        meta: normalizedMeta,
        mcpSpec,
      });
      if (
        processConversationIdentity !== null
        && processConversationIdentity !== session.conversationIdentity
      ) {
        await discardRuntime({
          clearTranscript: true,
          clearSession: true,
          clearStderr: true,
        });
      } else if (proc && processSettings !== nextSettings) {
        await discardRuntime();
      }
      if (activeRun !== runToken) throw cancelledStartError();
      processConversationIdentity = session.conversationIdentity;
      return await startCli(session, turn, normalizedMeta, mcpSpec, nextSettings);
    } catch (error) {
      if (activeRun === runToken) {
        await discardRuntime({ clearStderr: true });
      }
      if (error?.code !== 'CLAUDE_AGENT_START_CANCELLED') {
        emit({
          type: 'error',
          kind: error?.kind || 'mcp',
          ...(error?.code ? { code: error.code } : {}),
          message: error?.message || 'Failed to start Claude CLI.',
        });
      }
      return false;
    }
  }

  async function sendUser(input) {
    if (activeRun) return activeRun;
    let turn;
    try {
      turn = canonicalTurn(input);
    } catch (error) {
      const turnId = typeof input?.turnId === 'string' ? input.turnId : '';
      emit({
        type: 'error',
        kind: 'attachment',
        code: 'TURN_INPUT_INVALID',
        message: 'Selected attachment path is unavailable: [attachment-path]',
        ...(turnId ? { turnId, dispatchState: 'not-started' } : {}),
      });
      return;
    }
    activeAssistantText = '';
    activeSawTextDelta = false;
    activeTurn = turn;
    activeTurnAccepted = false;
    activeTurnDispatched = false;
    setActiveAttachmentPaths(turn.attachments.map((attachment) => attachment.localPath));
    resetProviderDeltaRedactor();
    activeRun = new Promise((resolve) => { activeResolve = resolve; });
    const run = activeRun;
    emit({ type: 'turn-start' });
    const ok = await ensureCli(run, turn);
    if (!ok || activeRun !== run || !proc) {
      if (activeRun === run) finishActive();
      return run;
    }
    const userText = withAttachmentManifest(turn.text, turn.attachments);
    transcript.push({ role: 'user', text: turn.text });
    activeTurnDispatched = true;
    writeMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: userText }],
      },
    });
    return run;
  }

  function stop() {
    if (!activeRun) return;
    providerDeltaRedactor.flush();
    setThinking(false);
    drainControls('Turn was stopped.');
    emit({ type: 'error', kind: 'aborted', message: 'Turn aborted.' });
    finishActive();
    void discardRuntime();
  }

  function reset() {
    void discardRuntime({
      clearTranscript: true,
      clearSession: true,
      finishRun: true,
      clearStderr: true,
    });
  }

  return {
    sendUser,
    approve,
    answerQuestion,
    stop,
    reset,
    getMessages: () => clone(transcript),
    getStderrTail: () => stderrTail,
  };
}
