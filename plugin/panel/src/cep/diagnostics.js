const HINTS = {
  'host-listening': {
    zh: '确认 ae-mcp 面板已打开；如端口被占用，请在设置里换一个端口并重启服务。',
    en: 'Make sure the ae-mcp panel is open. If the port is busy, choose another port in Settings and restart the service.',
  },
  'token-file': {
    zh: '重启 After Effects 面板以重新生成 ~/.ae-mcp/auth-token，然后重启你的 AI 客户端。',
    en: 'Restart the After Effects panel to regenerate ~/.ae-mcp/auth-token, then restart your AI client.',
  },
  'python-seen': {
    zh: '运行你的 AI 客户端发起一次对话，或检查其 MCP 配置。',
    en: 'Start a conversation in your AI client, or check its MCP configuration.',
  },
  'ae-project': {
    zh: '确认 After Effects 允许脚本访问，并保持面板服务运行。',
    en: 'Confirm After Effects allows script access and keep the panel service running.',
  },
  'extendscript-ping': {
    zh: '重启面板服务；如果仍失败，请重启 After Effects 后再试。',
    en: 'Restart the panel service. If it still fails, restart After Effects and try again.',
  },
};

function tokenPath(os) {
  const home = os && os.homedir ? os.homedir() : '';
  return home.replace(/[\\/]$/, '') + '/.ae-mcp/auth-token';
}

async function readJson(response) {
  if (response && response.json) return response.json();
  return {};
}

function tokenHeaders(token) {
  return {
    'content-type': 'application/json',
    'x-ae-mcp-token': token,
    // Must match INTERNAL_CLIENT in plugin/host/server.js: panel-origin
    // probes are kept out of the client registry (and therefore out of
    // lastClientSeenAt) so running diagnostics can never green-light the
    // python-seen check or list a phantom client in Settings.
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

export async function runDiagnostics({ getHost, port, fs, os, fetchImpl }) {
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
      detail: ok ? 'Host v' + (body.pluginVersion || 'unknown') + ' on port ' + (body.port || port) : 'Host did not return ok',
      fixHint: HINTS['host-listening'],
    });
  } catch (e) {
    items.push({ id: 'host-listening', ok: false, detail: e.message, fixHint: HINTS['host-listening'] });
  }

  try {
    const file = tokenPath(os);
    const exists = fs && fs.existsSync && fs.existsSync(file);
    token = exists && fs.readFileSync ? String(fs.readFileSync(file, 'utf8')).trim() : '';
    items.push({
      id: 'token-file',
      ok: exists && token.length === 64,
      detail: exists ? 'Token length ' + token.length : 'Token file missing',
      fixHint: HINTS['token-file'],
    });
  } catch (e) {
    items.push({ id: 'token-file', ok: false, detail: e.message, fixHint: HINTS['token-file'] });
  }

  try {
    const host = getHost && getHost();
    const info = host && host.getConnectionInfo && host.getConnectionInfo();
    const lastPythonSeenAt = info ? Math.max(info.lastHealthAt || 0, info.lastClientSeenAt || 0) : 0;
    const age = lastPythonSeenAt ? Date.now() - lastPythonSeenAt : Infinity;
    const ok = age < 10 * 60 * 1000;
    items.push({
      id: 'python-seen',
      ok,
      detail: ok ? 'Last Python signal ' + Math.round(age / 1000) + 's ago' : 'No recent Python signal',
      fixHint: HINTS['python-seen'],
    });
  } catch (e) {
    items.push({ id: 'python-seen', ok: false, detail: e.message, fixHint: HINTS['python-seen'] });
  }

  try {
    const code = 'app.project && app.project.file ? app.project.file.name : (app.project ? "unsaved" : "none")';
    const { response, body } = await execCode(fetcher, port, token, code);
    const ok = response && response.ok !== false && body.ok !== false;
    const project = body.result || 'none';
    items.push({
      id: 'ae-project',
      ok,
      detail: project === 'unsaved' ? 'Project unsaved' : 'Project ' + project,
      fixHint: HINTS['ae-project'],
    });
  } catch (e) {
    items.push({ id: 'ae-project', ok: false, detail: e.message, fixHint: HINTS['ae-project'] });
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
  } catch (e) {
    items.push({ id: 'extendscript-ping', ok: false, detail: e.message, fixHint: HINTS['extendscript-ping'] });
  }

  return items;
}
