import { DEFAULT_MODEL, buildSystemPrompt, sendAnthropicMessage } from './anthropic.js';

const MAX_TOOL_ROUNDS = 25;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toolText(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  const text = content.filter((item) => item && item.type === 'text').map((item) => item.text || '').join('\n');
  if (text) return text;
  if (result === undefined) return '';
  try {
    return JSON.stringify(result);
  } catch (e) {
    return String(result);
  }
}

function normalizeErrorKind(error) {
  if (error && error.name === 'AbortError') return 'aborted';
  return (error && error.kind) || 'network';
}

function shouldBypassApproval({ mode, tool, sessionAllowed }) {
  if (sessionAllowed) return true;
  if (mode === 'none') return true;
  const annotations = (tool && tool.annotations) || {};
  if (mode === 'manual') return annotations.readOnlyHint === true;
  if (mode === 'auto') return annotations.destructiveHint !== true;
  return false;
}

function approvalRisk(tool) {
  const annotations = (tool && tool.annotations) || {};
  return annotations.destructiveHint === true ? 'destructive' : 'write';
}

function getToolUses(message) {
  return ((message && message.content) || []).filter((block) => block && block.type === 'tool_use');
}

function makeToolResult(toolUseId, text, isError) {
  return { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: Boolean(isError) };
}

export function createAgentLoop({
  getApiKey,
  getModel,
  mcp,
  getPermissionMode,
  onEvent,
  anthropic = sendAnthropicMessage,
  maxToolRounds = MAX_TOOL_ROUNDS,
  lang = 'zh',
}) {
  let messages = [];
  let activeController = null;
  let activeRun = null;
  const pendingApprovals = new Map();
  const sessionAllowedTools = new Set();

  function emit(evt) {
    if (onEvent) onEvent(evt);
  }

  function resetPendingApprovals() {
    for (const [id, pending] of pendingApprovals) {
      pendingApprovals.delete(id);
      emit({ type: 'tool-denied', toolUseId: id });
      pending.resolve({ decision: 'abort' });
    }
  }

  async function waitForApproval(toolUse) {
    return await new Promise((resolve) => {
      pendingApprovals.set(toolUse.id, { name: toolUse.name, resolve });
    });
  }

  async function executeTool(toolUse) {
    const start = Date.now();
    try {
      const result = await mcp.callTool(toolUse.name, toolUse.input || {});
      const text = toolText(result);
      const isError = Boolean(result && result.isError);
      emit({ type: 'tool-result', toolUseId: toolUse.id, ok: !isError, text, durationMs: Date.now() - start });
      return makeToolResult(toolUse.id, text, isError);
    } catch (e) {
      const text = e && e.message ? e.message : 'MCP tool call failed.';
      emit({ type: 'tool-result', toolUseId: toolUse.id, ok: false, text, durationMs: Date.now() - start });
      return makeToolResult(toolUse.id, text, true);
    }
  }

  async function handleToolUse(toolUse, toolByName) {
    emit({ type: 'tool-start', toolUseId: toolUse.id, name: toolUse.name, input: clone(toolUse.input || {}) });

    const tool = toolByName.get(toolUse.name) || {};
    const mode = (getPermissionMode && getPermissionMode()) || 'manual';
    const sessionAllowed = sessionAllowedTools.has(toolUse.name);
    if (!shouldBypassApproval({ mode, tool, sessionAllowed })) {
      emit({
        type: 'approval-required',
        toolUseId: toolUse.id,
        name: toolUse.name,
        input: clone(toolUse.input || {}),
        risk: approvalRisk(tool),
      });
      const approved = await waitForApproval(toolUse);
      pendingApprovals.delete(toolUse.id);
      if (approved.decision === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (approved.decision === 'deny') {
        emit({ type: 'tool-denied', toolUseId: toolUse.id });
        return makeToolResult(toolUse.id, 'User denied this action.', true);
      }
      if (approved.decision === 'allow-session') sessionAllowedTools.add(toolUse.name);
    }

    return await executeTool(toolUse);
  }

  async function sendUser(text) {
    if (activeRun) return activeRun;

    const userMessage = { role: 'user', content: String(text || '') };
    messages.push(userMessage);
    emit({ type: 'turn-start' });

    const controller = new AbortController();
    activeController = controller;

    activeRun = (async () => {
      try {
        const tools = await mcp.listTools();
        const toolByName = new Map((tools || []).map((tool) => [tool.name, tool]));
        let toolRounds = 0;

        while (true) {
          if (toolRounds >= maxToolRounds) {
            emit({ type: 'error', kind: 'mcp', message: 'Stopped after 25 consecutive tool rounds.' });
            return;
          }

          const result = await anthropic({
            apiKey: getApiKey && getApiKey(),
            model: (getModel && getModel()) || DEFAULT_MODEL,
            system: buildSystemPrompt(lang),
            messages: clone(messages),
            tools,
            signal: controller.signal,
            onTextDelta: (delta) => emit({ type: 'text-delta', text: delta }),
          });

          const assistantMessage = result.assistantMessage || { role: 'assistant', content: [] };
          messages.push(assistantMessage);

          const toolUses = getToolUses(assistantMessage);
          if (result.stopReason !== 'tool_use' || toolUses.length === 0) {
            emit({ type: 'turn-end', stopReason: result.stopReason || 'end_turn' });
            return;
          }

          toolRounds += 1;
          const toolResults = [];
          for (const toolUse of toolUses) {
            toolResults.push(await handleToolUse(toolUse, toolByName));
          }
          messages.push({ role: 'user', content: toolResults });
        }
      } catch (e) {
        const kind = normalizeErrorKind(e);
        // If we bailed out after the assistant's tool_use message entered the
        // history but before its tool_results did (abort during an approval
        // wait is the concrete case), the next request would be rejected by
        // the API, which requires a tool_result for every tool_use. Close the
        // gap with synthetic cancelled results so the conversation stays
        // continuable.
        repairDanglingToolUses();
        emit({ type: 'error', kind, message: e && e.message ? e.message : 'Agent loop failed.' });
      } finally {
        activeController = null;
        activeRun = null;
      }
    })();

    return await activeRun;
  }

  function repairDanglingToolUses() {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const uses = getToolUses(last);
    if (!uses.length) return;
    messages.push({
      role: 'user',
      content: uses.map((use) => makeToolResult(use.id, 'Cancelled by user.', true)),
    });
  }

  function approve(toolUseId, decision) {
    const pending = pendingApprovals.get(toolUseId);
    if (!pending) return;
    pending.resolve({ decision });
  }

  function stop() {
    if (activeController) activeController.abort();
    resetPendingApprovals();
  }

  function reset() {
    stop();
    messages = [];
    sessionAllowedTools.clear();
  }

  return {
    sendUser,
    approve,
    stop,
    reset,
    getMessages: () => clone(messages),
  };
}
