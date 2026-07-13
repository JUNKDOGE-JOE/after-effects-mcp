// Credential channels share one shape so backend selection can compare them.
// ChannelProbe: { channel, source:{zh,en}, checking, ok, detail, fixHint:{zh,en} }
// Order in each array IS the priority order (channel (1) first).

function providerHasCredentialPolicy(provider) {
  const credential = provider?.credential;
  if (credential?.preferredAuth) {
    const scheme = credential.preferredAuth.scheme;
    if (scheme === 'auto' || scheme === 'none') return true;
    return Boolean(credential.valueRef?.kind === 'secret');
  }
  const policy = provider?.auth?.model;
  return Boolean(policy && (policy.kind === 'none' || policy.valueRef?.kind === 'secret'));
}

export function claudeChannels({
  probe,
  apiProvider,
  apiProviderSelected,
  providerAvailable,
  providerCredentialResolverReady,
  providerChecking = false,
} = {}) {
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
  const selected = apiProviderSelected === undefined ? Boolean(apiProvider) : Boolean(apiProviderSelected);
  const resolverReady = providerCredentialResolverReady === undefined
    ? (providerAvailable === undefined ? providerHasCredentialPolicy(apiProvider) : providerAvailable)
    : providerCredentialResolverReady;
  const canPreflight = Boolean(
    !providerChecking
    && selected
    && apiProvider?.baseUrl
    && resolverReady,
  );
  const api = {
    channel: 'api',
    source: { zh: '面板配置 · 通用 Provider', en: 'Panel config · Universal Provider' },
    selected,
    canPreflight,
    checking: Boolean(providerChecking),
    ok: canPreflight,
    detail: apiProvider && apiProvider.baseUrl ? apiProvider.baseUrl : '',
    fixHint: apiProvider && resolverReady !== true && !providerChecking
      ? { zh: '系统凭据库不可用：Helper 会随 AE 自动启动，请先重新打开面板或重启 AE；仍失败时再修复当前安装。不会回退读取明文 provider 文件。', en: 'The system credential store is unavailable. Helper starts with AE; reopen the panel or restart AE first, then repair the current install if it still fails. Plaintext provider fallback is disabled.' }
      : { zh: '在「Provider 管理」新增或选择一个通用 Provider（Base URL + API Key）。系统会按模型自动选择 Messages、Responses 或 Chat 路由。', en: 'Add or select a universal Provider (base URL + API key) in Provider Manager. Messages, Responses, or Chat routing is selected per model.' },
  };
  api.directHttp = false;
  return [sub, api];
}

export function codexChannels({
  codexProbe,
  customProvider,
  customProviderSelected,
  customProviderAvailable,
  customProviderCredentialResolverReady = false,
  providerChecking = false,
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
        ? { zh: '检测到 Codex CLI provider「' + cliConfig.providerId + '」，但没有可用凭据。请设置其环境变量或在 Provider 管理中配置。', en: 'Found Codex CLI provider "' + cliConfig.providerId + '", but no credential is available. Set its environment variable or configure it in Provider Manager.' }
        : { zh: 'Codex 运行时不可用：请检查 Codex CLI 安装后重新检测。', en: 'Codex runtime unavailable: check the Codex CLI install and re-check.' },
  };
  const customCanPreflight = Boolean(
    !providerChecking
    && (customProviderSelected === undefined ? customProvider : customProviderSelected)
    && customProvider?.baseUrl
    && (customProviderAvailable === undefined ? providerHasCredentialPolicy(customProvider) : customProviderAvailable)
    && customProviderCredentialResolverReady === true
    && (!codexProbe || codexProbe.runtimeOk !== false),
  );
  const custom = {
    channel: 'custom',
    source: { zh: '自定义 provider', en: 'Custom provider' },
    selected: customProviderSelected === undefined ? Boolean(customProvider) : Boolean(customProviderSelected),
    canPreflight: customCanPreflight,
    checking: Boolean(providerChecking),
    ok: Boolean(
      customCanPreflight
    ),
    detail: customProvider && customProvider.baseUrl ? customProvider.baseUrl : '',
    fixHint: customProvider && customProviderAvailable === false && !providerChecking
      ? { zh: '系统凭据库不可用：Helper 会随 AE 自动启动，请先重新打开面板或重启 AE；仍失败时再修复当前安装。不会回退读取明文 provider 文件。', en: 'The system credential store is unavailable. Helper starts with AE; reopen the panel or restart AE first, then repair the current install if it still fails. Plaintext provider fallback is disabled.' }
      : customProvider && customProviderCredentialResolverReady !== true
        ? { zh: '系统凭据库尚未就绪；Helper 会随 AE 自动启动，请重新打开面板或重启 AE 后检测，持续失败时再修复安装。', en: 'The system credential store is not ready. Helper starts with AE; reopen the panel or restart AE, and repair the install only if the failure persists.' }
        : { zh: '在「Provider 管理」新增或选择一个通用 Provider（Base URL + API Key）。协议路由会在发送前按当前模型预检。', en: 'Add or select a universal Provider (base URL + API key) in Provider Manager. Its protocol route is preflighted for the current model before sending.' },
  };
  // An explicitly-configured custom provider always outranks the inherited
  // cli-config one when both are simultaneously usable (ok). zcode has no
  // equivalent "explicit custom provider" channel to conflict with cli-config,
  // so there's no existing precedent to mirror there; this ordering rule is
  // specific to codex's cli-config-vs-custom overlap.
  return custom.ok ? [cli, custom, cliConfigChannel] : [cli, cliConfigChannel, custom];
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

export function pickChannel(channels, lockedChannel = '') {
  const list = Array.isArray(channels) ? channels : [];
  if (lockedChannel) {
    const locked = list.find((c) => c && c.channel === lockedChannel);
    if (locked) return locked;
  }
  return list.find((c) => c && c.ok) || null;
}

export function codexProviderChannelLock(lockedChannel = '', providerId = '') {
  if (String(providerId || '').trim()) return 'custom';
  return lockedChannel === 'custom' ? '' : lockedChannel;
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
