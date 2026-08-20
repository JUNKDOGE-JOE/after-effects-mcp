// Credential channels share one shape so backend selection can compare them.
// ChannelProbe: { channel, source:{zh,en}, checking, ok, detail, fixHint:{zh,en} }

export function claudeChannels({
  probe,
} = {}) {
  const sub = {
    channel: 'subscription',
    source: { zh: '订阅登录', en: 'Subscription login' },
    checking: probe === null,
    ok: Boolean(probe && probe.cliOk !== false && probe.loggedIn),
    detail: (probe && probe.detail) || '',
    fixHint: probe?.reason === 'cli-too-old'
      ? {
        zh: 'Claude CLI 版本过旧：请升级 Claude CLI 到 2.x 或更高版本后重新检测。',
        en: 'Claude CLI is too old. Upgrade Claude CLI to version 2.x or newer, then re-check.',
      }
      : probe && probe.cliOk === false
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
  };
  return [sub];
}

export function codexChannels({
  codexProbe,
  cliConfig,
  cliCredentialAvailable,
} = {}) {
  const cli = {
    channel: 'cli',
    source: { zh: 'Codex CLI 登录态', en: 'Codex CLI login' },
    checking: codexProbe === null,
    ok: Boolean(codexProbe && codexProbe.loggedIn),
    detail: codexProbe ? [codexProbe.email, codexProbe.planType, codexProbe.cliPath, codexProbe.cliVersion].filter(Boolean).join(' · ') : '',
    fixHint: { zh: '在终端完成 codex 登录后重新检测；若 codex 不在面板 PATH 上，设置环境变量 AE_MCP_CODEX_CLI 指向 codex 可执行文件后重启 AE。', en: 'Sign in with codex in a terminal and re-check; if codex is not on the panel PATH, set AE_MCP_CODEX_CLI to the codex executable and restart AE.' },
  };
  // Reuse a Codex CLI model_provider when the panel has no explicit provider.
  const runtimeOk = Boolean(!codexProbe || codexProbe.runtimeOk !== false);
  const hasProvider = Boolean(cliConfig && cliConfig.provider);
  const hasKey = Boolean(cliCredentialAvailable);
  const cliConfigChannel = {
    channel: 'cli-config',
    source: { zh: '继承自 Codex CLI 配置', en: 'Inherited from Codex CLI config' },
    checking: false,
    ok: hasProvider && hasKey && runtimeOk,
    detail: hasProvider ? [cliConfig.providerId, cliConfig.model, cliConfig.provider.baseUrl].filter(Boolean).join(' · ') : '',
    fixHint: !hasProvider
      ? { zh: '未找到 ~/.codex/config.toml 的可用 provider：先在 Codex CLI 里配置 model_provider。', en: 'No usable provider in ~/.codex/config.toml: configure model_provider in the Codex CLI first.' }
      : !hasKey
        ? {
          zh: '检测到 Codex CLI provider「' + cliConfig.providerId + '」，但没有可用凭据。请在 Codex CLI 中设置其环境变量。',
          en: 'Found Codex CLI provider "' + cliConfig.providerId + '", but no credential is '
            + 'available. Set its environment variable in the Codex CLI environment.',
        }
        : { zh: 'Codex 运行时不可用：请检查 Codex CLI 安装后重新检测。', en: 'Codex runtime unavailable: check the Codex CLI install and re-check.' },
  };
  // Display order is fixed (#229): routing never derives from row order —
  // the user's explicit channel choice decides — so rows stay put in the UI.
  return [cli, cliConfigChannel];
}

export function openCodeChannels({ probe, providers = [] } = {}) {
  const configured = providers.some((provider) => provider && provider.needsApiKey !== true);
  return [{
    channel: 'provider',
    source: { zh: 'Provider 管理 · OpenCode', en: 'Provider Manager · OpenCode' },
    checking: probe === null,
    ok: configured && Boolean(probe?.loggedIn),
    detail: probe?.detail || '',
    fixHint: configured
      ? {
        zh: 'OpenCode 未能启动：安装或更新 OpenCode CLI 后重新检测。',
        en: 'OpenCode could not start. Install or update the OpenCode CLI, then re-check.',
      }
      : {
        zh: '在 Provider 管理中填写 Base URL、API Key 和模型；旧 Provider 需要重新填写 key。',
        en: 'Add a Base URL, API key, and model in Provider Manager. '
          + 'Older providers require their key again.',
      },
  }];
}

export function zcodeChannels({ zcodeProbe, configSummary } = {}) {
  const summary = configSummary || {};
  const runtimeOk = Boolean(zcodeProbe && zcodeProbe.runtimeOk !== false);
  const runtimeHint = { zh: 'ZCode 运行时不可用：安装 ZCode、确认系统 Node 可用，或设置 AE_MCP_ZCODE_CLI 后重新检测。', en: 'ZCode runtime unavailable: install ZCode, confirm system Node, or set AE_MCP_ZCODE_CLI, then re-check.' };
  const cli = {
    channel: 'cli-config',
    source: { zh: '继承自 ZCode CLI', en: 'Inherited from ZCode CLI' },
    checking: zcodeProbe === null,
    ok: Boolean(summary.cli && summary.cli.hasCredential && runtimeOk),
    detail: summary.cli ? (summary.cli.model || summary.cli.providerId) : '',
    fixHint: !runtimeOk && summary.cli ? runtimeHint
      : summary.cli && !summary.cli.hasCredential
        ? { zh: '检测到 ZCode CLI provider「' + summary.cli.providerId + '」，但其 API Key 环境变量（' + (summary.cli.apiKeyEnv || '-') + '）没有被面板继承。在下方粘贴一次 Key（保存到系统安全凭据库）即可使用。', en: 'Found ZCode CLI provider "' + summary.cli.providerId + '", but its API key env (' + (summary.cli.apiKeyEnv || '-') + ') is not inherited by the panel. Paste the key once below; it will be stored in the protected system credential store.' }
        : { zh: '未找到 ~/.zcode/cli/config.json 的可用 provider：先在 ZCode CLI 里配置 provider 与默认模型。', en: 'No usable provider in ~/.zcode/cli/config.json: configure a provider and default model in the ZCode CLI first.' },
  };
  const desktop = {
    channel: 'desktop',
    source: { zh: '继承自 ZCode 桌面版', en: 'Inherited from ZCode desktop' },
    checking: zcodeProbe === null,
    ok: Boolean(summary.desktop && runtimeOk),
    detail: summary.desktop ? summary.desktop.providerId : '',
    fixHint: !runtimeOk && summary.desktop ? runtimeHint
      : { zh: '打开 ZCode 桌面版并选择一个 provider/model，然后重新检测。', en: 'Open ZCode desktop, pick a provider/model, then re-check.' },
  };
  const startPlan = {
    channel: 'start-plan',
    source: { zh: '官方托管计划', en: 'Official hosted plan' },
    checking: false,
    ok: Boolean(summary.startPlan && summary.startPlan.hasCredential && runtimeOk),
    detail: summary.startPlan ? summary.startPlan.providerId : '',
    fixHint: { zh: '官方托管计划需要 ZCode 桌面验证码桥接（面板尚未实现）：检测到有效凭据前不可选。请使用 CLI 配置或桌面版通道。', en: 'The hosted plan needs the ZCode desktop captcha bridge (not implemented in the panel yet) and stays unavailable until valid credentials are detected. Use the CLI-config or desktop channel instead.' },
  };
  return [cli, desktop, startPlan];
}

const CLAUDE_CHANNEL_IDS = ['subscription'];
const CODEX_CHANNEL_IDS = ['cli', 'cli-config'];

// Legacy pref migration (#229): `byok` collapses into Claude's API channel;
// OpenCode and ZCode remain internal adapters, not choices in the built-in
// two-way UI. Channels are user-enabled per backend (no auto-pick, no lock):
// the old `ae_mcp_channel_lock` value and a previously selected codex custom
// provider migrate onto the new explicit per-backend choice keys once.
export function migrateBackendPref(storage) {
  let pref = 'subscription';
  const channelChoices = { claude: 'subscription', codex: 'cli', opencode: 'provider' };
  try {
    const raw = storage.getItem('ae_mcp_backend') || 'subscription';
    const legacyLock = storage.getItem('ae_mcp_channel_lock') || '';
    const storedClaude = storage.getItem('ae_mcp_channel_claude') || '';
    const storedCodex = storage.getItem('ae_mcp_channel_codex') || '';
    if (raw === 'opencode') {
      pref = 'opencode';
    } else if (raw === 'byok' || raw === 'zcode') {
      pref = 'subscription';
      storage.setItem('ae_mcp_backend', pref);
    } else if (raw === 'codex' || raw === 'subscription') {
      pref = raw;
    }
    if (CLAUDE_CHANNEL_IDS.includes(storedClaude)) channelChoices.claude = storedClaude;
    else if (legacyLock === 'api') channelChoices.claude = 'subscription';
    if (CODEX_CHANNEL_IDS.includes(storedCodex)) channelChoices.codex = storedCodex;
    else if (legacyLock === 'custom') channelChoices.codex = 'cli';
    storage.setItem('ae_mcp_channel_claude', channelChoices.claude);
    storage.setItem('ae_mcp_channel_codex', channelChoices.codex);
    storage.setItem('ae_mcp_channel_opencode', channelChoices.opencode);
    storage.removeItem('ae_mcp_channel_lock');
  } catch (e) { /* storage unavailable -> defaults */ }
  return { pref, channelChoices };
}
