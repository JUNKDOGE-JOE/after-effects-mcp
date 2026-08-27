import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCS_URL_EN,
  DOCS_URL_ZH,
  EVAL_SCRIPT_SUCCESS_MARKER,
  REPO_URL,
  buildExternalOpenScript,
  docsUrlForLocale,
  openExternal,
} from '../src/lib/externalLinks.js';

function withWindow(value, callback) {
  const previous = globalThis.window;
  globalThis.window = value;
  return Promise.resolve().then(callback).finally(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

test('docs links route by panel locale', () => {
  assert.equal(docsUrlForLocale('zh'), DOCS_URL_ZH);
  assert.equal(docsUrlForLocale('zh-CN'), DOCS_URL_ZH);
  assert.equal(docsUrlForLocale('en'), DOCS_URL_EN);
  assert.equal(docsUrlForLocale('en-US'), DOCS_URL_EN);
  assert.equal(REPO_URL, 'https://github.com/JUNKDOGE-JOE/after-effects-mcp');
});

test('CEP opener succeeds first and short-circuits later fallbacks', async () => {
  const calls = [];
  const logs = [];
  const csInterface = {
    openURLInDefaultBrowser() { calls.push('cs'); },
    evalScript() { calls.push('eval'); },
  };
  const result = await withWindow({
    cep: { util: { openURLInDefaultBrowser(url) { calls.push(['cep', url]); } } },
  }, () => openExternal(REPO_URL, { csInterface, logger: (entry) => logs.push(entry) }));
  assert.equal(result.ok, true);
  assert.equal(result.method, 'cep.util.openURLInDefaultBrowser');
  assert.deepEqual(calls, [['cep', REPO_URL]]);
  assert.deepEqual(logs.map((entry) => entry.method), ['cep.util.openURLInDefaultBrowser']);
});

test('CSInterface opener is used after CEP failure and short-circuits evalScript', async () => {
  const calls = [];
  const result = await withWindow({
    cep: { util: { openURLInDefaultBrowser() { throw new Error('cep unavailable'); } } },
  }, () => openExternal(REPO_URL, {
    csInterface: {
      openURLInDefaultBrowser() { calls.push('cs'); },
      evalScript() { calls.push('eval'); },
    },
    logger: () => {},
  }));
  assert.equal(result.ok, true);
  assert.equal(result.method, 'CSInterface.openURLInDefaultBrowser');
  assert.deepEqual(calls, ['cs']);
  assert.equal(result.attempts[0].status, 'failed');
});

test('evalScript fallback records the generated host command and succeeds', async () => {
  const scripts = [];
  const result = await withWindow({
    cep: { util: { openURLInDefaultBrowser() { return false; } } },
  }, () => openExternal('https://example.com/docs?a=1&b=%26', {
    csInterface: {
      openURLInDefaultBrowser() { throw new Error('CSInterface unavailable'); },
      evalScript(script, callback) { scripts.push(script); callback(EVAL_SCRIPT_SUCCESS_MARKER); },
    },
    logger: () => {},
  }));
  assert.equal(result.ok, true);
  assert.equal(result.method, 'CSInterface.evalScript');
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /cmd \/d \/c start/);
  assert.match(scripts[0], /open/);
  assert.match(scripts[0], /https:\/\/example\.com\/docs\?a=1&b=%26/);
});

test('all fallback failures trigger the caller failure handler and retain evidence', async () => {
  const logs = [];
  const failures = [];
  const result = await withWindow({
    cep: { util: { openURLInDefaultBrowser() { throw new Error('cep failed'); } } },
    CSInterface: class {
      openURLInDefaultBrowser() { return false; }
      evalScript(script, callback) { callback('EvalScript error.'); }
    },
  }, () => openExternal(REPO_URL, {
    logger: (entry) => logs.push(entry),
    onFailure: (failure) => failures.push(failure),
  }));
  assert.equal(result.ok, false);
  assert.equal(failures.length, 1);
  assert.deepEqual(result.attempts.map((entry) => entry.method), [
    'cep.util.openURLInDefaultBrowser',
    'CSInterface.openURLInDefaultBrowser',
    'CSInterface.evalScript',
  ]);
  assert.deepEqual(logs.map((entry) => entry.status), ['failed', 'failed', 'failed']);
  assert.match(result.attempts[2].error, /EvalScript error/);
});

test('only https URLs are accepted and shell-sensitive URL text is escaped', () => {
  assert.throws(() => buildExternalOpenScript('http://example.com'), /https/);
  assert.throws(() => buildExternalOpenScript('javascript:alert(1)'), /https/);
  const script = buildExternalOpenScript('https://example.com/path?q=$value&x=`tick`');
  assert.match(script, /replace\(\/\(\["\\\\\$`\]\)\/g/);
  assert.match(script, /replace\(\/\(\[&\|<>\^\]\)\/g/);
});
