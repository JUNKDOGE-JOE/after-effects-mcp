const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_URL_TIMEOUT_MS = 20 * 1000;
const URL_PATTERN = /https:\/\/[^\s<>"'`]+/;

function loginError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function startCodexLogin({
  adapter,
  codexHome,
  onUrl = () => {},
  onDone = () => {},
  timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  urlTimeoutMs = DEFAULT_URL_TIMEOUT_MS,
} = {}) {
  if (!adapter || typeof adapter.resolveExecutable !== 'function' || typeof adapter.spawn !== 'function') {
    throw new TypeError('A platform adapter is required');
  }
  if (!codexHome) throw new TypeError('codexHome is required');

  let child = null;
  let settled = false;
  let cancelled = false;
  let sawUrl = false;
  let resolvePromise;
  let rejectPromise;
  let overallTimer = null;
  let urlTimer = null;
  const lineBuffers = { stdout: '', stderr: '' };

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  function killChild() {
    if (!child || typeof child.kill !== 'function') return;
    try { child.kill(); } catch {}
  }

  function clearTimers() {
    if (overallTimer) clearTimeout(overallTimer);
    if (urlTimer) clearTimeout(urlTimer);
    overallTimer = null;
    urlTimer = null;
  }

  function finishError(error, { kill = true } = {}) {
    if (settled) return;
    settled = true;
    clearTimers();
    if (kill) killChild();
    rejectPromise(error);
  }

  function finishSuccess(result) {
    if (settled) return;
    settled = true;
    clearTimers();
    try {
      onDone(result);
    } catch (error) {
      rejectPromise(error);
      return;
    }
    resolvePromise(result);
  }

  function inspectLine(line) {
    if (sawUrl) return;
    const match = String(line || '').match(URL_PATTERN);
    if (!match) return;
    sawUrl = true;
    if (urlTimer) clearTimeout(urlTimer);
    urlTimer = null;
    try {
      onUrl(match[0]);
    } catch (error) {
      finishError(error);
    }
  }

  function readLines(streamName, chunk, flush = false) {
    lineBuffers[streamName] += String(chunk || '');
    const lines = lineBuffers[streamName].split(/\r?\n/);
    if (!flush) lineBuffers[streamName] = lines.pop() || '';
    else lineBuffers[streamName] = '';
    for (const line of lines) inspectLine(line);
  }

  function handleExit(code, signal) {
    if (settled) return;
    readLines('stdout', '', true);
    readLines('stderr', '', true);
    if (code !== 0) {
      finishError(loginError(
        'CODEX_LOGIN_EXITED',
        `codex login exited with ${code === null || code === undefined ? signal || 'an unknown status' : `code ${code}`}`,
      ), { kill: false });
      return;
    }
    if (!sawUrl) {
      finishError(loginError('CODEX_LOGIN_URL_MISSING', 'codex login exited without a sign-in URL'), { kill: false });
      return;
    }
    finishSuccess({ exitCode: 0, urlSeen: true });
  }

  overallTimer = setTimeout(() => {
    finishError(loginError('CODEX_LOGIN_TIMEOUT', 'codex login timed out'));
  }, Math.max(0, Number(timeoutMs)));

  (async () => {
    try {
      const env = adapter.completeSpawnEnv({}, { CODEX_HOME: codexHome });
      const executable = await adapter.resolveExecutable('codex', { env });
      if (cancelled || settled) return;
      if (!executable || executable.ok !== true) {
        finishError(loginError(
          executable?.code || 'CODEX_LOGIN_RESOLUTION_FAILED',
          executable?.detail || 'Codex CLI could not be resolved',
        ), { kill: false });
        return;
      }
      child = adapter.spawn(executable, ['login'], {
        stdio: 'pipe',
        windowsHide: true,
        env,
      });
      child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');
      child.stdout?.on?.('data', (chunk) => readLines('stdout', chunk));
      child.stderr?.on?.('data', (chunk) => readLines('stderr', chunk));
      child.on?.('error', (error) => finishError(error));
      child.on?.('exit', handleExit);
      child.on?.('close', handleExit);
      urlTimer = setTimeout(() => {
        finishError(loginError('CODEX_LOGIN_URL_TIMEOUT', 'codex login did not provide a sign-in URL'));
      }, Math.max(0, Number(urlTimeoutMs)));
    } catch (error) {
      finishError(error);
    }
  })();

  return {
    promise,
    cancel() {
      if (settled) return;
      cancelled = true;
      finishError(loginError('CODEX_LOGIN_CANCELLED', 'codex login was cancelled'));
    },
  };
}
