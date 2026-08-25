export const OPEN_CODE_HISTORY_GUARD_FILENAME = 'ae-mcp-history-guard.js';
export const OPEN_CODE_HISTORY_GUARD_MARKER = '/* ae-mcp: script body hidden from history to save tokens. Never send this comment back as code — write the full script again, or rerun the stored script via ae_execRecover with its recoveryId. */';

const AE_EXEC_TOOL_NAMES = Object.freeze([
  'ae_exec',
  'ae_execRecover',
  'ae_ae_exec',
  'ae_ae_execRecover',
  'mcp__ae__ae_exec',
  'mcp__ae__ae_execRecover',
]);

export function isOpenCodeAeExecToolName(value) {
  return typeof value === 'string' && AE_EXEC_TOOL_NAMES.includes(value);
}

export function guardOpenCodeOutboundMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let changed = 0;
  for (const message of messages) {
    if (!message || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!part || part.type !== 'tool' || !isOpenCodeAeExecToolName(part.tool)) continue;
      const state = part.state;
      if (!state || (state.status !== 'completed' && state.status !== 'error')) continue;
      const input = state.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
      if (typeof input.code !== 'string' || input.code.length === 0) continue;
      input.code = OPEN_CODE_HISTORY_GUARD_MARKER;
      changed += 1;
    }
  }
  return changed;
}

export function openCodeHistoryGuardPluginSource() {
  const names = JSON.stringify(AE_EXEC_TOOL_NAMES);
  const marker = JSON.stringify(OPEN_CODE_HISTORY_GUARD_MARKER);
  return [
    `const AE_EXEC_TOOL_NAMES = new Set(${names});`,
    `const MARKER = ${marker};`,
    'function guard(messages) {',
    '  if (!Array.isArray(messages)) return;',
    '  for (const message of messages) {',
    '    if (!message || !Array.isArray(message.parts)) continue;',
    '    for (const part of message.parts) {',
    '      if (!part || part.type !== "tool" || !AE_EXEC_TOOL_NAMES.has(part.tool)) continue;',
    '      const state = part.state;',
    '      if (!state || (state.status !== "completed" && state.status !== "error")) continue;',
    '      const input = state.input;',
    '      if (!input || typeof input !== "object" || Array.isArray(input)) continue;',
    '      if (typeof input.code !== "string" || input.code.length === 0) continue;',
    '      input.code = MARKER;',
    '    }',
    '  }',
    '}',
    'export const AeMcpHistoryGuard = async () => {',
    '  return {',
    '    "experimental.chat.messages.transform": async (_input, output) => {',
    '      guard(output && output.messages);',
    '    },',
    '  };',
    '};',
    '',
  ].join('\n');
}
