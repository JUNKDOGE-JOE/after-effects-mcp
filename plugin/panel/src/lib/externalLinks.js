const ALLOWED_PROTOCOLS = new Set(['https:']);
const DEFAULT_EVAL_SCRIPT_TIMEOUT_MS = 3000;
export const EVAL_SCRIPT_SUCCESS_MARKER = 'AE_MCP_OPEN_EXTERNAL_OK';
const EVAL_SCRIPT_FAILURE_MARKER = 'AE_MCP_OPEN_EXTERNAL_FAIL:';

export const REPO_URL = 'https://github.com/JUNKDOGE-JOE/after-effects-mcp';
export const DOCS_URL_ZH = `${REPO_URL}#readme`;
export const DOCS_URL_EN = `${REPO_URL}#readme`;

export function docsUrlForLocale(locale) {
  return String(locale || '').toLowerCase().startsWith('zh') ? DOCS_URL_ZH : DOCS_URL_EN;
}

export function normalizeExternalUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('External URL must be a clean https URL');
  }
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor !== 'function') throw new Error('URL validation is unavailable');
  const parsed = new URLConstructor(value);
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error('Only public https URLs can be opened');
  }
  return parsed.href;
}

export function buildExternalOpenScript(url) {
  const normalizedUrl = normalizeExternalUrl(url);
  const scriptUrl = JSON.stringify(normalizedUrl);
  return [
    '(function () {',
    '  try {',
    `    var url = ${scriptUrl};`,
    '    var os = String($.os || "");',
    '    var command;',
    '    if (/^win/i.test(os)) {',
    '      var windowsUrl = url.replace(/([&|<>^])/g, "^$1").replace(/%/g, "%%").replace(/!/g, "^!");',
    '      command = "cmd /d /c start \\"\\" \\"" + windowsUrl + "\\"";',
    '    } else {',
    '      var macUrl = url.replace(/(["\\\\$`])/g, "\\\\$1");',
    '      command = "open \\"" + macUrl + "\\"";',
    '    }',
    '    var output = system.callSystem(command);',
    `    return ${JSON.stringify(EVAL_SCRIPT_SUCCESS_MARKER)} + String(output == null ? "" : output);`,
    '  } catch (error) {',
    `    return ${JSON.stringify(EVAL_SCRIPT_FAILURE_MARKER)} + String(error);`,
    '  }',
    '}());',
  ].join('\n');
}

function currentWindow(windowObject) {
  if (windowObject) return windowObject;
  return typeof globalThis.window === 'object' ? globalThis.window : null;
}

function logAttempt(logger, attempt) {
  if (typeof logger !== 'function') return;
  try { logger(attempt); } catch (error) { return; }
}

async function runAttempt(method, operation, logger) {
  try {
    const returnValue = await operation();
    const success = returnValue !== false;
    const attempt = { method, status: success ? 'success' : 'failed', returnValue };
    logAttempt(logger, attempt);
    return attempt;
  } catch (error) {
    const attempt = { method, status: 'failed', error: String(error && error.message ? error.message : error) };
    logAttempt(logger, attempt);
    return attempt;
  }
}

function unavailableAttempt(method, logger, reason) {
  const attempt = { method, status: 'unavailable', error: reason };
  logAttempt(logger, attempt);
  return attempt;
}

function resolveCSInterface(windowObject, provided) {
  if (provided) return provided;
  const Constructor = windowObject && windowObject.CSInterface;
  if (typeof Constructor !== 'function') return null;
  return new Constructor();
}

function evalScriptResult(result) {
  const text = String(result == null ? '' : result);
  if (text.startsWith(EVAL_SCRIPT_SUCCESS_MARKER)) return { success: true, returnValue: result };
  return { success: false, error: text || 'ExtendScript returned no success marker' };
}

function runEvalScript(csInterface, script, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`ExtendScript timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    try {
      csInterface.evalScript(script, finish((result) => {
        const parsed = evalScriptResult(result);
        if (parsed.success) resolve(parsed.returnValue);
        else reject(new Error(parsed.error));
      }));
    } catch (error) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}

export async function openExternal(url, options = {}) {
  const attempts = [];
  const logger = options.logger || ((attempt) => {
    if (attempt.status === 'success') console.info(`[external-link] ${attempt.method}`, attempt.returnValue);
    else console.warn(`[external-link] ${attempt.method}`, attempt.error || attempt.returnValue);
  });
  let normalizedUrl;
  try {
    normalizedUrl = normalizeExternalUrl(url);
  } catch (error) {
    const attempt = { method: 'validation', status: 'failed', error: String(error.message || error) };
    attempts.push(attempt);
    logAttempt(logger, attempt);
    const failure = { ok: false, url: String(url || ''), attempts };
    if (typeof options.onFailure === 'function') options.onFailure(failure);
    return failure;
  }

  const win = currentWindow(options.windowObject);
  const cepOpen = win && win.cep && win.cep.util && win.cep.util.openURLInDefaultBrowser;
  if (typeof cepOpen === 'function') {
    const attempt = await runAttempt('cep.util.openURLInDefaultBrowser', () => cepOpen.call(win.cep.util, normalizedUrl), logger);
    attempts.push(attempt);
    if (attempt.status === 'success') return { ok: true, method: attempt.method, url: normalizedUrl, attempts };
  } else {
    attempts.push(unavailableAttempt('cep.util.openURLInDefaultBrowser', logger, 'CEP URL opener is unavailable'));
  }

  let csInterface = options.csInterface || null;
  let csInterfaceResolutionFailed = false;
  if (!csInterface) {
    try {
      csInterface = resolveCSInterface(win, null);
    } catch (error) {
      csInterfaceResolutionFailed = true;
      const attempt = { method: 'CSInterface.openURLInDefaultBrowser', status: 'failed', error: String(error.message || error) };
      attempts.push(attempt);
      logAttempt(logger, attempt);
    }
  }
  if (csInterface && typeof csInterface.openURLInDefaultBrowser === 'function') {
    const attempt = await runAttempt('CSInterface.openURLInDefaultBrowser', () => csInterface.openURLInDefaultBrowser(normalizedUrl), logger);
    attempts.push(attempt);
    if (attempt.status === 'success') return { ok: true, method: attempt.method, url: normalizedUrl, attempts };
  } else if (!csInterfaceResolutionFailed) {
    attempts.push(unavailableAttempt('CSInterface.openURLInDefaultBrowser', logger, 'CSInterface URL opener is unavailable'));
  }

  if (csInterface && typeof csInterface.evalScript === 'function') {
    const script = buildExternalOpenScript(normalizedUrl);
    const attempt = await runAttempt('CSInterface.evalScript', () => runEvalScript(
      csInterface,
      script,
      options.evalScriptTimeoutMs || DEFAULT_EVAL_SCRIPT_TIMEOUT_MS,
    ), logger);
    attempts.push(attempt);
    if (attempt.status === 'success') return { ok: true, method: attempt.method, url: normalizedUrl, attempts };
  } else {
    attempts.push(unavailableAttempt('CSInterface.evalScript', logger, 'CSInterface evalScript is unavailable'));
  }

  const failure = { ok: false, url: normalizedUrl, attempts };
  if (typeof options.onFailure === 'function') options.onFailure(failure);
  return failure;
}
