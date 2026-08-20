// Credential channels share one shape so backend selection can compare them.
// ChannelProbe: { channel, source:{zh,en}, checking, ok, detail, fixHint:{zh,en} }

export function claudeChannels({ probe } = {}) {
  return [{
    channel: 'subscription',
    source: { zh: '订阅登录', en: 'Subscription login' },
    checking: probe === null,
    ok: Boolean(probe && probe.cliOk !== false && probe.loggedIn),
    detail: probe?.detail || '',
    fixHint: probe?.reason === 'cli-too-old'
      ? {
        zh: 'Claude CLI 版本过旧：请升级 Claude CLI 到 2.x 或更高版本后重新检测。',
        en: 'Claude CLI is too old. Upgrade Claude CLI to version 2.x or newer, then re-check.',
      }
      : probe?.cliOk === false
        ? {
          zh: '未找到 Claude CLI：请安装 Claude Code 2.x；若面板 PATH 不含 claude，可设置 '
            + 'AE_MCP_CLAUDE_CLI 后重启 AE。',
          en: 'Claude CLI was not found. Install Claude Code 2.x; if claude is not on the '
            + 'panel PATH, set AE_MCP_CLAUDE_CLI and restart AE.',
        }
        : {
          zh: '订阅未登录：在终端运行 claude /login 完成登录后重新检测；或改用 OpenCode Provider 通道。',
          en: 'Not logged in: run claude /login in a terminal and re-check, or use the '
            + 'OpenCode Provider channel.',
        },
  }];
}

export function codexChannels({ codexProbe } = {}) {
  return [{
    channel: 'cli',
    source: { zh: 'Codex CLI 登录态', en: 'Codex CLI login' },
    checking: codexProbe === null,
    ok: Boolean(codexProbe?.loggedIn),
    detail: codexProbe
      ? [
        codexProbe.email,
        codexProbe.planType,
        codexProbe.cliPath,
        codexProbe.cliVersion,
      ].filter(Boolean).join(' · ')
      : '',
    fixHint: {
      zh: '在终端完成 codex 登录后重新检测；若 codex 不在面板 PATH 上，设置环境变量 '
        + 'AE_MCP_CODEX_CLI 指向 codex 可执行文件后重启 AE。',
      en: 'Sign in with codex in a terminal and re-check; if codex is not on the panel '
        + 'PATH, set AE_MCP_CODEX_CLI to the codex executable and restart AE.',
    },
  }];
}

export function openCodeChannels({ probe, providers = [] } = {}) {
  const configured = providers.some((provider) => provider?.needsApiKey !== true);
  return [{
    channel: 'provider',
    source: { zh: 'Provider 管理 · OpenCode', en: 'Provider Manager · OpenCode' },
    checking: probe === null,
    ok: configured && Boolean(probe?.loggedIn),
    detail: probe?.detail || '',
    fixHint: configured
      ? {
        zh: 'OpenCode 未能启动：安装或更新 OpenCode CLI 后重新检测。',
        en: 'OpenCode could not start. Install or update OpenCode CLI, then re-check.',
      }
      : {
        zh: '在 Provider 管理中填写 Base URL、API Key 和模型；旧 Provider 需要重新填写 key。',
        en: 'Add a Base URL, API key, and model in Provider Manager. '
          + 'Older providers require their key again.',
      },
  }];
}

const CLAUDE_CHANNEL_IDS = ['subscription'];
const CODEX_CHANNEL_IDS = ['cli'];

export function migrateBackendPref(storage) {
  let pref = 'subscription';
  const channelChoices = { claude: 'subscription', codex: 'cli', opencode: 'provider' };
  try {
    const raw = storage.getItem('ae_mcp_backend') || 'subscription';
    const storedClaude = storage.getItem('ae_mcp_channel_claude') || '';
    const storedCodex = storage.getItem('ae_mcp_channel_codex') || '';
    if (raw === 'opencode' || raw === 'codex' || raw === 'subscription') {
      pref = raw;
    } else {
      storage.setItem('ae_mcp_backend', pref);
    }
    if (CLAUDE_CHANNEL_IDS.includes(storedClaude)) channelChoices.claude = storedClaude;
    if (CODEX_CHANNEL_IDS.includes(storedCodex)) channelChoices.codex = storedCodex;
    storage.setItem('ae_mcp_channel_claude', channelChoices.claude);
    storage.setItem('ae_mcp_channel_codex', channelChoices.codex);
    storage.setItem('ae_mcp_channel_opencode', channelChoices.opencode);
    storage.removeItem('ae_mcp_channel_lock');
  } catch (error) { /* storage unavailable -> defaults */ }
  return { pref, channelChoices };
}
