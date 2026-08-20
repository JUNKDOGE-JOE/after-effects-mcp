import React from 'react';
import {
  buildInstallCommands,
  commandPreview,
  detectTool,
  runAction,
} from '../cep/wizardActions.js';
import {
  CLI_STEPS,
  HOST_STEPS,
  OPTIONAL_CLIENT_STEPS,
  initialStepStates,
  stepReducer,
} from '../lib/wizardSteps.js';

export function useWizardWiring({
  port = 11488,
  fetchImpl,
  platform,
} = {}) {
  const [stepStates, dispatch] = React.useReducer(stepReducer, null, initialStepStates);
  const commands = React.useMemo(
    () => buildInstallCommands({ platform }),
    [platform],
  );
  const commandPreviews = React.useMemo(() => ({
    node: commandPreview(commands.node),
  }), [commands]);

  const detect = React.useCallback(async (id) => {
    dispatch({ type: 'detect-start', id });
    const result = await detectTool(id, {
      platform,
      port,
      fetchImpl,
    });
    dispatch({
      type: 'detect-result',
      id,
      ok: result.ok,
      version: result.version || '',
      detail: result.detail || '',
    });
    return result;
  }, [fetchImpl, platform, port]);

  const install = React.useCallback(async (id) => {
    const command = commands[id];
    if (!command) return { ok: false, output: 'No install command configured for ' + id };
    dispatch({ type: 'run-start', id });
    const result = await runAction({
      ...command,
      platform,
      onChunk: (text) => dispatch({ type: 'run-chunk', id, text }),
    });
    dispatch({ type: 'run-done', id, ok: result.ok, output: result.output });
    await detect(id);
    return result;
  }, [commands, detect, platform]);

  const bootDetectRef = React.useRef(false);
  React.useEffect(() => {
    if (bootDetectRef.current) return;
    bootDetectRef.current = true;
    [...HOST_STEPS, ...CLI_STEPS, ...OPTIONAL_CLIENT_STEPS].forEach((id) => {
      detect(id);
    });
  }, [detect]);

  return {
    stepStates,
    props: {
      stepStates,
      commandPreviews,
      onDetect: detect,
      onInstall: install,
    },
  };
}
