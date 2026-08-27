const DIAGNOSTIC_GUIDANCE = Object.freeze({
  zh: '可在“设置 → 诊断”查看通道状态；导出日志时请附上类别码。',
  en: 'Check Settings → Diagnostics for channel status, and include the category code with exported logs.',
});

function entry(code, kind, zh, en) {
  return Object.freeze({
    code,
    kind,
    hint: Object.freeze({
      zh: `${zh}${DIAGNOSTIC_GUIDANCE.zh}`,
      en: `${en} ${DIAGNOSTIC_GUIDANCE.en}`,
    }),
  });
}

export const ERROR_CODES = Object.freeze({
  CLI_MISSING: entry('CLI_MISSING', 'backend', '请安装对应 CLI，并确认面板进程能从 PATH 找到它。', 'Install the CLI and make sure it is visible on the panel PATH.'),
  CLI_TOO_OLD: entry('CLI_TOO_OLD', 'backend', '请升级对应 CLI 后重新检测。', 'Upgrade the CLI and re-check.'),
  CLI_ARCH_MISMATCH: entry('CLI_ARCH_MISMATCH', 'backend', '请安装与当前 After Effects 主机架构一致的 CLI。', 'Install a CLI build matching the After Effects host architecture.'),
  CLI_PROBE_FAILED: entry('CLI_PROBE_FAILED', 'backend', 'CLI 已找到但探针失败；请回到“设置 → AI”使用通道卡上的操作重试。', 'The CLI was found but its probe failed. Return to Settings → AI and retry from the channel card.'),
  SPAWN_FAILED: entry('SPAWN_FAILED', 'backend', '请检查 CLI 路径、执行权限和安全软件拦截。', 'Check the CLI path, execute permission, and security-software blocks.'),
  PROCESS_EXITED: entry('PROCESS_EXITED', 'backend', '请查看折叠详情中的退出信息与 stderr 尾部。', 'Inspect the exit information and stderr tail in the collapsed details.'),
  AUTH_REQUIRED: entry('AUTH_REQUIRED', 'auth', '请按「设置 → AI」通道卡上的登录指引完成对应 CLI 登录后重新检测。', 'Follow the sign-in guidance on the channel card under Settings → AI for this CLI, then re-check.'),
  MCP_UNREACHABLE: entry('MCP_UNREACHABLE', 'mcp', '请保持面板宿主运行，并检查本机会话 MCP 状态。', 'Keep the panel host running and check the local conversation MCP status.'),
  AE_MCP_REBUILD_FAILED: entry('AE_MCP_REBUILD_FAILED', 'network', '与 AE 宿主的连接重建失败。请重载面板或新建会话后再试。', 'The connection to the AE host could not be rebuilt. Reload the panel or start a new session, then try again.'),
  SESSION_START_FAILED: entry('SESSION_START_FAILED', 'backend', '会话尚未创建；可修复通道状态后安全重试。', 'The session was not created; retry after fixing the channel state.'),
  TURN_START_FAILED: entry('TURN_START_FAILED', 'backend', '发送可能已经开始；请先按详情中的派发状态核对再重试。', 'Sending may have started; check the dispatch state before retrying.'),
  RPC_TIMEOUT: entry('RPC_TIMEOUT', 'network', '请求等待超时；请检查通道进程与网络后再试。', 'The request timed out; check the channel process and network before retrying.'),
  UPSTREAM_HTTP: entry('UPSTREAM_HTTP_<status>', 'network', '上游返回了 HTTP 错误；请按状态码检查登录、额度或中转服务。', 'The upstream returned an HTTP error; use the status code to check auth, quota, or relay service.'),
  UPSTREAM_ERROR: entry('UPSTREAM_ERROR', 'model', '上游或模型返回失败；请检查模型可用性与服务状态。', 'The upstream or model failed; check model availability and service status.'),
  UPSTREAM_CONNECTION_CLOSED: entry('UPSTREAM_CONNECTION_CLOSED', 'network', '上游连接在返回错误时被中断；本轮不会自动重发，下一条消息将使用新会话。', 'The upstream connection closed while returning an error. This turn is not retried automatically; the next message uses a fresh session.'),
  EVENT_STREAM_FAILED: entry('EVENT_STREAM_FAILED', 'network', '事件流已断开；请检查 OpenCode 进程与本地网络。', 'The event stream disconnected; check the OpenCode process and local network.'),
  PROVIDER_STREAM_STALLED: entry('PROVIDER_STREAM_STALLED', 'network', '提供方流超过 5 分钟没有响应，本回合已停止；请检查中转或代理连通性后重试。', 'The provider stream was silent for over five minutes, so the turn was stopped; check relay or proxy connectivity and retry.'),
  TURN_INPUT_INVALID: entry('TURN_INPUT_INVALID', 'attachment', '请移除不可用附件或重新选择文件。', 'Remove unavailable attachments or select the files again.'),
  TURN_ABORTED: entry('TURN_ABORTED', 'aborted', '本回合已停止，可在确认没有未决写入后重新发送。', 'The turn was stopped; resend after confirming there is no unresolved write.'),
  CANCELLED: entry('CANCELLED', 'backend', '后端取消了请求；请确认会话仍可用后重试。', 'The backend cancelled the request; confirm the session is still usable before retrying.'),
  TRANSPORT_UNCERTAIN: entry('TRANSPORT_UNCERTAIN', 'backend', '传输结果不确定；请先核对 AE 状态，避免盲目重试。', 'The transport outcome is uncertain; inspect AE state before retrying.'),
  BACKEND_UNAVAILABLE: entry('BACKEND_UNAVAILABLE', 'backend', '请先在设置中启用一个可用聊天通道。', 'Enable an available chat channel in Settings first.'),
  BACKEND_ERROR: entry('BACKEND_ERROR', 'backend', '请查看折叠详情与导出日志定位后端错误。', 'Inspect the collapsed details and exported logs for the backend failure.'),
});

const FIXED_CODES = new Map(
  Object.values(ERROR_CODES)
    .filter((item) => !item.code.includes('<status>'))
    .map((item) => [item.code, item]),
);

const RESOLUTION_CODES = Object.freeze({
  NOT_FOUND: 'CLI_MISSING',
  VERSION_TOO_OLD: 'CLI_TOO_OLD',
  ARCH_MISMATCH: 'CLI_ARCH_MISMATCH',
  PROBE_FAILED: 'CLI_PROBE_FAILED',
});

const SPAWN_CODES = new Set([
  'E2BIG', 'EACCES', 'EAGAIN', 'EFAULT', 'EISDIR', 'ELOOP', 'EMFILE', 'ENFILE',
  'ENOENT', 'ENOEXEC', 'ENOMEM', 'ENOTDIR', 'EPERM', 'ETXTBSY', 'UNKNOWN',
]);

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.message === 'string') return value.message;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function codeKind(code) {
  const status = String(code || '').match(/^UPSTREAM_HTTP_(\d{3})$/);
  if (status) return ['401', '403'].includes(status[1]) ? 'auth' : 'network';
  return FIXED_CODES.get(String(code || ''))?.kind || null;
}

export function extractHttpStatus(value, { allowStandalone = true } = {}) {
  const direct = Number(value);
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  const text = textOf(value);
  const contextual = text.match(/(?:unexpected\s+status|http(?:\s+status)?|status(?:\s+code)?)[^0-9]{0,12}([1-5]\d{2})/i);
  if (contextual) return Number(contextual[1]);
  if (!allowStandalone) return null;
  const standalone = text.match(/(?:^|[^0-9])([45]\d{2})(?:[^0-9]|$)/);
  return standalone ? Number(standalone[1]) : null;
}

export function classifyErrorCode(input = {}) {
  const resolutionCode = input.resolutionCode || input.resolution?.code;
  if (RESOLUTION_CODES[resolutionCode]) {
    const code = RESOLUTION_CODES[resolutionCode];
    return { code, kind: codeKind(code) };
  }

  const explicitCode = typeof input.code === 'string' ? input.code : '';
  if (codeKind(explicitCode)) return { code: explicitCode, kind: codeKind(explicitCode) };

  const error = input.error;
  const errorCode = error && error.code;
  const combined = [
    textOf(error),
    textOf(input.upstreamText),
    textOf(input.stderrTail),
    textOf(input.message),
  ].filter(Boolean).join('\n');
  const httpStatus = extractHttpStatus(input.httpStatus)
    || extractHttpStatus(input.upstreamText)
    || extractHttpStatus(combined, { allowStandalone: false });
  if (httpStatus) {
    const code = `UPSTREAM_HTTP_${httpStatus}`;
    return { code, kind: codeKind(code) };
  }
  if (/(?:socket|connection).{0,32}(?:closed|reset|terminated)|ECONNRESET|UND_ERR_SOCKET/i.test(combined)) {
    return { code: 'UPSTREAM_CONNECTION_CLOSED', kind: 'network' };
  }
  if (/\b(?:cancelled|canceled|interrupted)\b/i.test(String(errorCode || ''))
      || /\b(?:cancelled|canceled|interrupted)\b/i.test(combined)) {
    return { code: 'CANCELLED', kind: 'backend' };
  }
  if (/(?:^|\s)\/login\b|not[- ]logged[- ]in|unauthori[sz]ed|authentication\s+(?:failed|required|error|expired)|auth required|invalid\s+(?:api[- ]?key|credential)|credential required/i.test(combined)) {
    return { code: 'AUTH_REQUIRED', kind: 'auth' };
  }
  if (input.method && /timed out|timeout/i.test(combined)) {
    return { code: 'RPC_TIMEOUT', kind: 'network' };
  }
  if (input.spawnError === true || SPAWN_CODES.has(String(errorCode || '').toUpperCase())) {
    return { code: 'SPAWN_FAILED', kind: 'backend' };
  }
  if (input.exitCode !== undefined || input.signal) {
    return { code: 'PROCESS_EXITED', kind: 'backend' };
  }
  if (input.upstream === true) return { code: 'UPSTREAM_ERROR', kind: 'model' };

  const fallbackCode = codeKind(input.fallbackCode) ? input.fallbackCode : 'BACKEND_ERROR';
  return { code: fallbackCode, kind: codeKind(fallbackCode) || 'backend' };
}

export function errorHint(code, lang = 'zh') {
  const key = /^UPSTREAM_HTTP_\d{3}$/.test(String(code || ''))
    ? 'UPSTREAM_HTTP'
    : String(code || 'BACKEND_ERROR');
  const item = ERROR_CODES[key] || ERROR_CODES.BACKEND_ERROR;
  return item.hint[lang] || item.hint.zh;
}

export function trimStderrTail(value, { maxLines = 12, maxChars = 1500 } = {}) {
  const lines = String(value || '').replace(/\r\n/g, '\n').split('\n').slice(-maxLines);
  const text = lines.join('\n').trim();
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

export function boundedResolution(resolution) {
  if (!resolution || typeof resolution !== 'object') return null;
  const attempts = Array.isArray(resolution.attempts)
    ? resolution.attempts.slice(0, 6).map((attempt) => ({
      path: String(attempt?.path || '').slice(0, 500),
      source: String(attempt?.source || '').slice(0, 100),
      detail: String(attempt?.detail || '').slice(0, 500),
    }))
    : [];
  return {
    code: String(resolution.code || ''),
    attempts,
  };
}
