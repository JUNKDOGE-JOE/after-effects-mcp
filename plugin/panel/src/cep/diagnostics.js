import { createPlatformAdapter } from './platform/index.js';

const HINTS = {
  'host-listening': {
    zh: '确认 ae-mcp 面板已打开；如端口被占用，请在设置里换端口并重启宿主。',
    en: 'Keep the ae-mcp panel open. If the port is busy, change it in Settings and restart the host.',
  },
  'token-file': {
    zh: '重启 After Effects 面板以重新生成 ~/.ae-mcp/auth-token。',
    en: 'Restart the After Effects panel to regenerate ~/.ae-mcp/auth-token.',
  },
  'mcp-session': {
    zh: '从面板对话或外部客户端发起一次 MCP 请求；外部客户端应连接宿主 /mcp URL。',
    en: 'Send an MCP request from panel chat or an external client connected to the host /mcp URL.',
  },
  'ae-project': {
    zh: '确认 After Effects 允许脚本访问，并保持面板宿主运行。',
    en: 'Confirm After Effects allows script access and keep the panel host running.',
  },
  'extendscript-ping': {
    zh: '重启面板宿主；如果仍失败，请重启 After Effects 后再试。',
    en: 'Restart the panel host. If it still fails, restart After Effects and try again.',
  },
  claude: {
    zh: 'Claude CLI 为可选项；如需该通道，请安装并完成登录。',
    en: 'Claude CLI is optional. Install it and sign in to use that channel.',
  },
  codex: {
    zh: 'Codex CLI 为可选项；如需该通道，请安装并完成登录。',
    en: 'Codex CLI is optional. Install it and sign in to use that channel.',
  },
  opencode: {
    zh: 'opencode CLI 为可选项；如需自定义 provider 通道，请安装并配置它。',
    en: 'The opencode CLI is optional. Install and configure it for custom providers.',
  },
};

function tokenPath(platform) {
  return platform.paths.join([platform.paths.configRoot, 'auth-token']);
}

async function readJson(response) {
  if (response && response.json) return response.json();
  return {};
}

function tokenHeaders(token) {
  return {
    'content-type': 'application/json',
    'x-ae-mcp-token': token,
    'x-ae-mcp-client': 'panel-diagnostics/internal',
  };
}

async function execCode(fetchImpl, port, token, code) {
  const response = await fetchImpl('http://127.0.0.1:' + port + '/exec', {
    method: 'POST',
    headers: tokenHeaders(token),
    body: JSON.stringify({ code }),
  });
  return { response, body: await readJson(response) };
}

function recentMcpSession(getHost) {
  const host = getHost && getHost();
  const sessions = host && typeof host.getMcpSessions === 'function'
    ? host.getMcpSessions()
    : [];
  const latest = sessions.reduce((value, session) => (
    Math.max(value, Number(session.lastActivityAt) || 0)
  ), 0);
  const age = latest ? Date.now() - latest : Infinity;
  return {
    ok: age < 10 * 60 * 1000,
    detail: latest
      ? 'Last MCP session activity ' + Math.round(age / 1000) + 's ago'
      : 'No MCP session activity yet',
  };
}

export async function runDiagnostics({
  getHost,
  port,
  fs,
  fetchImpl,
  platform,
}) {
  const adapter = platform || createPlatformAdapter();
  const fileSystem = fs || adapter.fs;
  const fetcher = fetchImpl || globalThis.fetch;
  const items = [];
  let token = '';

  try {
    const response = await fetcher('http://127.0.0.1:' + port + '/health');
    const body = await readJson(response);
    const ok = response && response.ok !== false && body.ok === true;
    items.push({
      id: 'host-listening',
      ok,
      detail: ok
        ? 'Host v' + (body.pluginVersion || 'unknown') + ' on port ' + (body.port || port)
        : 'Host did not return ok',
      fixHint: HINTS['host-listening'],
    });
  } catch (error) {
    items.push({
      id: 'host-listening',
      ok: false,
      detail: error.message,
      fixHint: HINTS['host-listening'],
    });
  }

  try {
    const file = tokenPath(adapter);
    const exists = fileSystem && fileSystem.existsSync && fileSystem.existsSync(file);
    token = exists && fileSystem.readFileSync
      ? String(fileSystem.readFileSync(file, 'utf8')).trim()
      : '';
    items.push({
      id: 'token-file',
      ok: exists && token.length === 64,
      detail: exists ? 'Token length ' + token.length : 'Token file missing',
      fixHint: HINTS['token-file'],
    });
  } catch (error) {
    items.push({
      id: 'token-file',
      ok: false,
      detail: error.message,
      fixHint: HINTS['token-file'],
    });
  }

  try {
    items.push({
      id: 'mcp-session',
      ...recentMcpSession(getHost),
      fixHint: HINTS['mcp-session'],
    });
  } catch (error) {
    items.push({
      id: 'mcp-session',
      ok: false,
      detail: error.message,
      fixHint: HINTS['mcp-session'],
    });
  }

  try {
    const code = 'app.project && app.project.file ? app.project.file.name '
      + ': (app.project ? "unsaved" : "none")';
    const { response, body } = await execCode(fetcher, port, token, code);
    const ok = response && response.ok !== false && body.ok !== false;
    const project = body.result || 'none';
    items.push({
      id: 'ae-project',
      ok,
      detail: project === 'unsaved' ? 'Project unsaved' : 'Project ' + project,
      fixHint: HINTS['ae-project'],
    });
  } catch (error) {
    items.push({
      id: 'ae-project',
      ok: false,
      detail: error.message,
      fixHint: HINTS['ae-project'],
    });
  }

  try {
    const { response, body } = await execCode(fetcher, port, token, '"pong"');
    const ok = response && response.ok !== false && body.ok !== false && body.result === 'pong';
    items.push({
      id: 'extendscript-ping',
      ok,
      detail: ok ? 'pong' : 'Unexpected result: ' + String(body.result || body.error || ''),
      fixHint: HINTS['extendscript-ping'],
    });
  } catch (error) {
    items.push({
      id: 'extendscript-ping',
      ok: false,
      detail: error.message,
      fixHint: HINTS['extendscript-ping'],
    });
  }

  for (const id of ['claude', 'codex', 'opencode']) {
    const options = id === 'claude' ? { minimumVersion: '2.0.0' } : {};
    const result = await adapter.resolveExecutable(id, options);
    items.push({
      id,
      ok: result.ok,
      detail: result.ok
        ? [result.version, result.path].filter(Boolean).join(' · ')
        : [
          result.code,
          Array.isArray(result.attempts) && result.attempts.length
            ? 'tried: ' + result.attempts.slice(0, 3).map((attempt) => attempt.path).filter(Boolean).join('; ')
            : '',
        ].filter(Boolean).join('\n'),
      fixHint: HINTS[id],
      ...(id === 'opencode'
        ? {}
        : { action: { kind: 'open-login-terminal', tool: id } }),
    });
  }

  return items;
}
