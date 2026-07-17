import React from 'react';
import { PANEL_VERSION } from '../cep/mcpClient.js';
import {
  buildInstallCommands,
  commandPreview,
  detectRepoRoot,
  detectTool,
  openLoginTerminal,
  runAction,
} from '../cep/wizardActions.js';
import { initialStepStates, LOCAL_STEPS, SUBSCRIPTION_STEPS, stepReducer } from '../lib/wizardSteps.js';

// App's claudeStatus shape is { state: 'checking'|'ready'|'not-logged-in'|'no-node',
// nodeVersion?, detail? } — see SettingsScreen's claudeState handling.
function isLoginOk(claudeStatus) {
  return Boolean(claudeStatus && claudeStatus.state === 'ready');
}

function versionFrom(status) {
  if (!status) return '';
  if (status.nodeVersion) return 'Node ' + String(status.nodeVersion).replace(/^v?/, 'v');
  return String(status.detail || '').trim();
}

function wingetMissing(output) {
  const text = String(output || '').toLowerCase();
  return text.includes('winget') && (
    text.includes('not recognized')
    || text.includes('not found')
    || text.includes('enoent')
    || text.includes('cannot find')
  );
}

// App.jsx接线（orchestrator合并时加）：
//   const wizard = useWizardWiring({ extRoot, lang }); // 内部 useReducer(stepReducer)
//   <WizardScreen {...现有props} {...wizard.props} />
export function useWizardWiring({ extRoot, lang, claudeStatus, recheckLogin, platform, runtimeManager } = {}) {
  const [stepStates, dispatch] = React.useReducer(stepReducer, null, initialStepStates);
  const [useUvFallback, setUseUvFallback] = React.useState(false);

  const repoRoot = React.useMemo(() => {
    try {
      return detectRepoRoot({ extRoot });
    } catch (e) {
      return '';
    }
  }, [extRoot]);

  const cmds = React.useMemo(() => buildInstallCommands({
    panelVersion: PANEL_VERSION,
    repoRoot,
    platform,
  }), [platform, repoRoot]);

  const localSteps = React.useMemo(
    () => (platform?.id === 'macos-arm64' && runtimeManager ? ['aeMcp'] : LOCAL_STEPS),
    [platform, runtimeManager],
  );

  const activeCmds = React.useMemo(() => ({
    ...cmds,
    uv: useUvFallback ? cmds.uvFallback : cmds.uv,
  }), [cmds, useUvFallback]);

  const commandPreviews = React.useMemo(() => ({
    uv: commandPreview(activeCmds.uv),
    aeMcp: platform?.id === 'macos-arm64' && runtimeManager
      ? (lang === 'zh' ? '验证并激活插件内置离线运行时' : 'Verify and activate the bundled offline runtime')
      : commandPreview(activeCmds.aeMcp),
    node: platform?.id === 'macos-arm64' && runtimeManager
      ? (lang === 'zh' ? '修复插件内置离线 Node 运行时' : 'Repair the bundled offline Node runtime')
      : commandPreview(activeCmds.node),
    claude: commandPreview(activeCmds.claude),
    login: 'claude',
  }), [activeCmds, lang, platform, runtimeManager]);

  const detect = React.useCallback(async (id) => {
    dispatch({ type: 'detect-start', id });
    if (id === 'login') {
      // 复检必须真正重跑登录探针——挂载时的探针可能瞬时失败，而设置页的
      // "重新检测"按钮在向导期间不可达；结果经 claudeStatus effect 回流。
      if (recheckLogin) {
        recheckLogin();
        return { ok: false, pending: true };
      }
      const ok = isLoginOk(claudeStatus);
      dispatch({ type: 'detect-result', id, ok, version: ok ? versionFrom(claudeStatus) : '' });
      return { ok, version: versionFrom(claudeStatus) };
    }
    const result = await detectTool(id, { platform, extRoot, runtimeManager });
    dispatch({ type: 'detect-result', id, ok: result.ok, version: result.version || '' });
    return result;
  }, [claudeStatus, extRoot, platform, recheckLogin, runtimeManager]);

  const install = React.useCallback(async (id) => {
    if (['aeMcp', 'node'].includes(id) && platform?.id === 'macos-arm64' && runtimeManager) {
      dispatch({ type: 'run-start', id });
      try {
        const repaired = await runtimeManager.repair();
        const output = `Offline runtime ${repaired.version} activated at ${repaired.launcher}`;
        dispatch({ type: 'run-done', id, ok: true, output });
        await detect(id);
        return { ok: true, output };
      } catch (error) {
        const output = `${error?.code || 'RUNTIME_MANAGER_FAILED'}: ${error?.message || error}`;
        dispatch({ type: 'run-done', id, ok: false, output });
        return { ok: false, output };
      }
    }
    const cmd = activeCmds[id];
    if (!cmd) return { ok: false, output: 'No command configured for ' + id };
    if (id === 'uv' && useUvFallback) {
      const msg = lang === 'zh'
        ? 'winget 不可用。是否改用 astral 官方 PowerShell 安装脚本？'
        : 'winget is unavailable. Use the official astral PowerShell installer instead?';
      if (globalThis.window && globalThis.window.confirm && !globalThis.window.confirm(msg)) {
        return { ok: false, output: 'uv fallback cancelled' };
      }
    }
    dispatch({ type: 'run-start', id });
    const result = await runAction({
      ...cmd,
      onChunk: (text) => dispatch({ type: 'run-chunk', id, text }),
    });
    if (id === 'uv' && !result.ok && !useUvFallback && wingetMissing(result.output)) {
      setUseUvFallback(true);
      dispatch({
        type: 'run-done',
        id,
        ok: false,
        output: result.output + '\nwinget was not found. Re-run Install to use the official astral PowerShell installer.',
      });
      return result;
    }
    dispatch({ type: 'run-done', id, ok: result.ok, output: result.output });
    await detect(id);
    return result;
  }, [activeCmds, detect, lang, platform, runtimeManager, useUvFallback]);

  const openLogin = React.useCallback(() => {
    openLoginTerminal({ tool: 'claude' });
    dispatch({ type: 'detect-result', id: 'login', ok: false });
  }, []);

  // 进入向导即自动检测全部工具行，免去逐行手点复检；login 行由下方
  // claudeStatus effect 驱动。ref 防依赖变化下的重复触发。
  const bootDetectRef = React.useRef(false);
  React.useEffect(() => {
    if (bootDetectRef.current) return;
    bootDetectRef.current = true;
    [...localSteps, ...SUBSCRIPTION_STEPS].forEach((id) => { detect(id); });
  }, [detect, localSteps]);

  React.useEffect(() => {
    if (!claudeStatus) return;
    if (claudeStatus.state === 'checking') {
      dispatch({ type: 'detect-start', id: 'login' });
      return;
    }
    const ok = isLoginOk(claudeStatus);
    dispatch({ type: 'detect-result', id: 'login', ok, version: ok ? versionFrom(claudeStatus) : '' });
  }, [claudeStatus]);

  return {
    stepStates,
    props: {
      stepStates,
      commandPreviews,
      localSteps,
      onDetect: detect,
      onInstall: install,
      onOpenLogin: openLogin,
    },
  };
}
