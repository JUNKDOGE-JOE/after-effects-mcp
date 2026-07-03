// Spec A/D: unified per-backend credential channels.
// ChannelProbe: { channel, source:{zh,en}, checking, ok, detail, fixHint:{zh,en} }
// Order in each array IS the priority order (channel (1) first).

export function claudeChannels({ probe, apiProvider } = {}) {
  const sub = {
    channel: 'subscription',
    source: { zh: '订阅登录', en: 'Subscription login' },
    checking: probe === null,
    ok: Boolean(probe && probe.nodeOk !== false && probe.loggedIn),
    detail: (probe && probe.detail) || '',
    fixHint: probe && probe.nodeOk === false
      ? { zh: '内嵌对话需要系统 Node 18+：安装 Node.js LTS 后重新检测；或使用下方「API 直连」通道（无 Node 时自动降级为直连 HTTP）。', en: 'Embedded chat needs system Node 18+: install Node.js LTS and re-check, or use the API direct channel below (falls back to direct HTTP without Node).' }
      : { zh: '订阅未登录：在终端运行 claude /login 完成登录后重新检测；或改用下方「API 直连」通道。', en: 'Not logged in: run claude /login in a terminal and re-check, or switch to the API direct channel below.' },
  };
  const api = {
    channel: 'api',
    source: { zh: '面板配置 · API 直连', en: 'Panel config · API direct' },
    checking: false,
    ok: Boolean(apiProvider && apiProvider.baseUrl && apiProvider.apiKey),
    detail: apiProvider && apiProvider.baseUrl ? apiProvider.baseUrl : '',
    fixHint: { zh: '在「Provider 管理」新增/选择一个 Anthropic 协议 provider（Base URL + Key/Token），或一键导入 ~/.claude/settings.json。Claude-3p 桌面版凭据无法自动读取，请手动填一次。', en: 'Add or pick an Anthropic-protocol provider (base URL + key/token) in Provider Manager, or import from ~/.claude/settings.json. Claude-3p desktop credentials cannot be read automatically; paste them once.' },
  };
  return [sub, api];
}

export function codexChannels({ codexProbe, customProvider, cliConfig, cliConfigApiKey } = {}) {
  const cli = {
    channel: 'cli',
    source: { zh: 'Codex CLI 登录态', en: 'Codex CLI login' },
    checking: codexProbe === null,
    ok: Boolean(codexProbe && codexProbe.loggedIn),
    detail: codexProbe ? [codexProbe.email, codexProbe.planType, codexProbe.cliPath, codexProbe.cliVersion].filter(Boolean).join(' · ') : '',
    fixHint: { zh: '在终端完成 codex 登录后重新检测；若 codex 不在面板 PATH 上，设置环境变量 AE_MCP_CODEX_CLI 指向 codex 可执行文件后重启 AE。', en: 'Sign in with codex in a terminal and re-check; if codex is not on the panel PATH, set AE_MCP_CODEX_CLI to the codex executable and restart AE.' },
  };
  // Spec A extension: inherit a custom model_provider declared in
  // ~/.codex/config.toml (mirrors zcodeChannels' 'cli-config' pattern).
  const runtimeOk = Boolean(!codexProbe || codexProbe.runtimeOk !== false);
  const hasProvider = Boolean(cliConfig && cliConfig.provider);
  const hasKey = Boolean(cliConfigApiKey);
  const cliConfigChannel = {
    channel: 'cli-config',
    source: { zh: '继承自 Codex CLI 配置', en: 'Inherited from Codex CLI config' },
    checking: false,
    ok: hasProvider && hasKey && runtimeOk,
    detail: hasProvider ? [cliConfig.providerId, cliConfig.model, cliConfig.provider.baseUrl].filter(Boolean).join(' · ') : '',
    fixHint: !hasProvider
      ? { zh: '未找到 ~/.codex/config.toml 的可用 provider：先在 Codex CLI 里配置 model_provider。', en: 'No usable provider in ~/.codex/config.toml: configure model_provider in the Codex CLI first.' }
      : !hasKey
        ? { zh: '检测到 Codex CLI provider「' + cliConfig.providerId + '」，但其 API Key 环境变量（' + (cliConfig.provider.envKey || '-') + '）没有被面板继承。在下方粘贴一次 Key（保存到本机 ~/.ae-mcp/codex-key）即可使用。', en: 'Found Codex CLI provider "' + cliConfig.providerId + '", but its API key env (' + (cliConfig.provider.envKey || '-') + ') is not inherited by the panel. Paste the key once below (stored at ~/.ae-mcp/codex-key).' }
        : { zh: 'Codex 运行时不可用：请检查 Codex CLI 安装后重新检测。', en: 'Codex runtime unavailable: check the Codex CLI install and re-check.' },
  };
  const custom = {
    channel: 'custom',
    source: { zh: '自定义 provider', en: 'Custom provider' },
    checking: false,
    ok: Boolean(customProvider && customProvider.baseUrl && customProvider.apiKey && (!codexProbe || codexProbe.runtimeOk !== false)),
    detail: customProvider && customProvider.baseUrl ? customProvider.baseUrl : '',
    fixHint: { zh: '在「Provider 管理」新增/选择一个 OpenAI 兼容 provider（Base URL + Key）。', en: 'Add or pick an OpenAI-compatible provider (base URL + key) in Provider Manager.' },
  };
  return [cli, cliConfigChannel, custom];
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
        ? { zh: '检测到 ZCode CLI provider「' + summary.cli.providerId + '」，但其 API Key 环境变量（' + (summary.cli.apiKeyEnv || '-') + '）没有被面板继承。在下方粘贴一次 Key（保存到本机 ~/.ae-mcp/zcode-key）即可使用。', en: 'Found ZCode CLI provider "' + summary.cli.providerId + '", but its API key env (' + (summary.cli.apiKeyEnv || '-') + ') is not inherited by the panel. Paste the key once below (stored at ~/.ae-mcp/zcode-key).' }
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

export function pickChannel(channels, lockedChannel = '') {
  const list = Array.isArray(channels) ? channels : [];
  if (lockedChannel) {
    const locked = list.find((c) => c && c.channel === lockedChannel);
    if (locked) return locked;
  }
  return list.find((c) => c && c.ok) || null;
}

// Legacy pref migration: 'byok' collapses into Claude's api channel (spec:
// BYOK 并入 Claude); 'opencode' was never exposed in the 3-way UI.
export function migrateBackendPref(storage) {
  let pref = 'subscription';
  let lockedChannel = '';
  try {
    const raw = storage.getItem('ae_mcp_backend') || 'subscription';
    lockedChannel = storage.getItem('ae_mcp_channel_lock') || '';
    if (raw === 'byok') {
      pref = 'subscription';
      lockedChannel = 'api';
      storage.setItem('ae_mcp_backend', pref);
      storage.setItem('ae_mcp_channel_lock', lockedChannel);
    } else if (raw === 'opencode') {
      pref = 'subscription';
      storage.setItem('ae_mcp_backend', pref);
    } else if (raw === 'codex' || raw === 'zcode' || raw === 'subscription') {
      pref = raw;
    }
  } catch (e) { /* storage unavailable -> defaults */ }
  return { pref, lockedChannel };
}
