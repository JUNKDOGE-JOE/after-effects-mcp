// Credential channels share one shape so backend selection can compare them.
// ChannelProbe: { channel, source:{zh,en}, checking, ok, detail, fixHint:{zh,en}, copyAction?:{label:{zh,en},text}, loginAction?:{label:{zh,en},kind} }

import { codexLoginCommand } from './codexLogin.js';

export function claudeChannels({ probe, canOpenLoginTerminal = true } = {}) {
  const probeFailed = ['probe-timeout', 'probe-failed'].includes(probe?.reason);
  const needsLogin = Boolean(
    probe
    && probe.cliOk === true
    && !probe.loggedIn
    && !probeFailed
    && probe.reason !== 'cli-too-old',
  );
  return [{
    channel: 'subscription',
    source: { zh: '订阅登录', en: 'Subscription login' },
    checking: probe === null,
    ok: Boolean(probe && probe.cliOk !== false && probe.loggedIn),
    detail: probe?.detail || '',
    fixHint: probeFailed
      ? {
        zh: probe?.reason === 'probe-timeout'
          ? 'Claude 登录探针超时。请在「设置 → 诊断」查看通道状态，并导出日志排查。'
          : 'Claude 登录探针失败。请在「设置 → 诊断」查看通道状态，并导出日志排查。',
        en: probe?.reason === 'probe-timeout'
          ? 'The Claude login probe timed out. Check Settings → Diagnostics and export logs for troubleshooting.'
          : 'The Claude login probe failed. Check Settings → Diagnostics and export logs for troubleshooting.',
      }
      : probe?.reason === 'cli-too-old'
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
          zh: canOpenLoginTerminal
            ? '在打开的窗口中输入 /login 完成登录，本页会自动刷新。'
            : '当前平台无法从面板打开 Claude 登录窗口，可改用 OpenCode Provider 通道。',
          en: canOpenLoginTerminal
            ? 'Enter /login in the window that opens. This page refreshes automatically after sign-in.'
            : 'This platform cannot open the Claude sign-in window from the panel. Use the OpenCode Provider channel instead.',
        },
    ...(needsLogin && canOpenLoginTerminal ? {
      loginAction: {
        label: { zh: '打开登录窗口', en: 'Open sign-in window' },
        kind: 'terminal',
      },
    } : {}),
  }];
}

export function codexChannels({ codexProbe, loginFallback = false } = {}) {
  const cliFixHint = {
    zh: '请先安装 Codex CLI；若 codex 不在面板 PATH 上，设置环境变量 '
      + 'AE_MCP_CODEX_CLI 指向 codex 可执行文件后重启 AE。',
    en: 'Install Codex CLI first. If codex is not on the panel PATH, set '
      + 'AE_MCP_CODEX_CLI to the codex executable and restart AE.',
  };
  const needsIsolatedLogin = Boolean(
    codexProbe
    && !codexProbe.loggedIn
    && codexProbe.runtimeOk !== false
    && codexProbe.codexHome,
  );
  const command = needsIsolatedLogin ? codexLoginCommand({
    codexHome: codexProbe.codexHome,
    platformId: codexProbe.platformId,
  }) : '';
  const channel = {
    channel: 'cli',
    source: { zh: 'Codex CLI 登录态', en: 'Codex CLI login' },
    checking: codexProbe === null,
    ok: Boolean(codexProbe?.loggedIn),
    detail: codexProbe
      ? (codexProbe.loggedIn ? [
        codexProbe.email,
        codexProbe.planType,
        codexProbe.cliPath,
        codexProbe.cliVersion,
      ].filter(Boolean).join(' · ') : (codexProbe.detail || ''))
      : '',
    fixHint: needsIsolatedLogin
      ? (loginFallback ? {
        zh: `自动登录未能打开验证页面。可重试「一键登录」；如仍失败，请复制登录命令完成面板隔离登录：\n${command}`,
        en: `Automatic sign-in could not open the verification page. Retry One-click sign-in; if it still fails, copy the command to sign in to the panel's isolated Codex home:\n${command}`,
      } : {
        zh: `面板的 Codex 运行在隔离目录 ${codexProbe.codexHome}（不读取 ~/.codex），系统登录态对面板无效。点击「一键登录」后在浏览器中完成验证，本页会自动刷新。`,
        en: `The panel runs Codex with its own CODEX_HOME at ${codexProbe.codexHome} (it never reads ~/.codex), so the system login does not apply. Choose One-click sign-in and finish verification in the browser; this page refreshes automatically.`,
      })
      : cliFixHint,
    ...(needsIsolatedLogin && loginFallback ? {
      copyAction: {
        label: { zh: '复制登录命令', en: 'Copy login command' },
        text: command,
      },
    } : {}),
    ...(needsIsolatedLogin ? {
      loginAction: {
        label: { zh: '一键登录', en: 'One-click sign-in' },
        kind: 'headless',
      },
    } : {}),
  };
  return [channel];
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
  let pref = 'opencode';
  const channelChoices = { claude: 'subscription', codex: 'cli', opencode: 'provider' };
  try {
    const storedBackend = storage.getItem('ae_mcp_backend');
    const raw = storedBackend || '';
    const storedClaude = storage.getItem('ae_mcp_channel_claude') || '';
    const storedCodex = storage.getItem('ae_mcp_channel_codex') || '';
    if (raw === 'opencode' || raw === 'codex' || raw === 'subscription') {
      pref = raw;
    } else if (raw) {
      pref = 'subscription';
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
