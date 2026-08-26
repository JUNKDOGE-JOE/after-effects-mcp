import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeChannels,
  codexChannels,
  migrateBackendPref,
  openCodeChannels,
} from '../src/lib/channels.js';
import { ERROR_CODES } from '../src/lib/errorCodes.js';

test('Claude and Codex expose one CLI-owned channel each', () => {
  assert.deepEqual(
    claudeChannels({ probe: { loggedIn: true } }).map((item) => item.channel),
    ['subscription'],
  );
  assert.deepEqual(
    codexChannels({ codexProbe: { loggedIn: true } }).map((item) => item.channel),
    ['cli'],
  );
});

test('OpenCode needs a configured provider and healthy CLI probe', () => {
  const channels = openCodeChannels({
    probe: { loggedIn: true },
    providers: [{ id: 'aemcp-example', needsApiKey: false }],
  });
  assert.equal(channels[0].ok, true);
});

test('Codex exposes failed probe detail instead of only successful identity fields', () => {
  const channels = codexChannels({
    codexProbe: { loggedIn: false, detail: 'probe timeout: account/read' },
  });
  assert.equal(channels[0].detail, 'probe timeout: account/read');
});

test('Codex logged-out guidance exposes one-click isolated login', () => {
  const channel = codexChannels({
    codexProbe: {
      loggedIn: false,
      runtimeOk: true,
      codexHome: 'C:\\Users\\test\\.ae-mcp\\codex-home',
      platformId: 'windows-x64',
    },
  })[0];
  assert.match(channel.fixHint.zh, /C:\\Users\\test\\\.ae-mcp\\codex-home/);
  assert.match(channel.fixHint.en, /C:\\Users\\test\\\.ae-mcp\\codex-home/);
  assert.equal(channel.copyAction, undefined);
  assert.deepEqual(channel.loginAction, {
    label: { zh: '一键登录', en: 'One-click sign-in' },
    kind: 'headless',
  });
});

test('Codex automatic-login fallback exposes the isolated Windows command', () => {
  const channel = codexChannels({
    codexProbe: {
      loggedIn: false,
      runtimeOk: true,
      codexHome: 'C:\\Users\\test\\.ae-mcp\\codex-home',
      platformId: 'windows-x64',
    },
    loginFallback: true,
  })[0];
  const command = "$env:CODEX_HOME='C:\\Users\\test\\.ae-mcp\\codex-home'; codex login";
  assert.deepEqual(channel.copyAction, {
    label: { zh: '复制登录命令', en: 'Copy login command' },
    text: command,
  });
});

test('Codex logged-out guidance uses POSIX syntax on macOS', () => {
  const channel = codexChannels({
    codexProbe: {
      loggedIn: false,
      runtimeOk: true,
      codexHome: '/Users/t/.ae-mcp/codex-home',
      platformId: 'macos-arm64',
    },
    loginFallback: true,
  })[0];
  assert.equal(
    channel.copyAction.text,
    "CODEX_HOME='/Users/t/.ae-mcp/codex-home' codex login",
  );
});

test('Codex runtime failures retain CLI setup guidance without a copy action', () => {
  const channel = codexChannels({
    codexProbe: {
      loggedIn: false,
      runtimeOk: false,
      codexHome: 'C:\\Users\\test\\.ae-mcp\\codex-home',
      platformId: 'windows-x64',
    },
  })[0];
  assert.match(channel.fixHint.zh, /AE_MCP_CODEX_CLI/);
  assert.match(channel.fixHint.en, /AE_MCP_CODEX_CLI/);
  assert.equal(channel.copyAction, undefined);
});

test('Codex successful and pending probes do not expose copy actions', () => {
  assert.equal(codexChannels({
    codexProbe: {
      loggedIn: true,
      runtimeOk: true,
      codexHome: 'C:\\Users\\test\\.ae-mcp\\codex-home',
      platformId: 'windows-x64',
    },
  })[0].copyAction, undefined);
  assert.equal(codexChannels({ codexProbe: null })[0].copyAction, undefined);
  assert.equal(codexChannels({ codexProbe: null })[0].loginAction, undefined);
});

test('Claude auth-required channel opens a login window from the card', () => {
  const channel = claudeChannels({
    probe: { loggedIn: false, cliOk: true, reason: 'not-logged-in' },
  })[0];
  assert.deepEqual(channel.loginAction, {
    label: { zh: '打开登录窗口', en: 'Open sign-in window' },
    kind: 'terminal',
  });
  assert.equal(channel.fixHint.zh, '在打开的窗口中输入 /login 完成登录，本页会自动刷新。');
});

test('Claude hides login action when the platform cannot open a terminal', () => {
  const channel = claudeChannels({
    probe: { loggedIn: false, cliOk: true, reason: 'not-logged-in' },
    canOpenLoginTerminal: false,
  })[0];
  assert.equal(channel.loginAction, undefined);
  assert.match(channel.fixHint.zh, /OpenCode Provider/);
});

test('Claude probe timeout guidance is different from not-logged-in guidance', () => {
  const timeout = claudeChannels({
    probe: { loggedIn: false, cliOk: true, reason: 'probe-timeout' },
  })[0].fixHint;
  const loggedOut = claudeChannels({
    probe: { loggedIn: false, cliOk: true, reason: 'not-logged-in' },
  })[0].fixHint;
  assert.notEqual(timeout.zh, loggedOut.zh);
  assert.notEqual(timeout.en, loggedOut.en);
  assert.match(timeout.zh, /诊断/);
  assert.match(timeout.en, /Diagnostics/);
});

test('unknown persisted backend choices reset to subscription', () => {
  const values = new Map([['ae_mcp_backend', 'legacy-provider']]);
  const storage = {
    getItem: (key) => values.get(key) || '',
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const migrated = migrateBackendPref(storage);
  assert.equal(migrated.pref, 'subscription');
  assert.equal(values.get('ae_mcp_backend'), 'subscription');
});

test('fresh installs default to OpenCode while stored subscription remains unchanged', () => {
  const freshValues = new Map();
  const fresh = {
    getItem: (key) => freshValues.get(key) ?? null,
    setItem: (key, value) => freshValues.set(key, value),
    removeItem: (key) => freshValues.delete(key),
  };
  assert.equal(migrateBackendPref(fresh).pref, 'opencode');

  const storedValues = new Map([['ae_mcp_backend', 'subscription']]);
  const stored = {
    getItem: (key) => storedValues.get(key) ?? null,
    setItem: (key, value) => storedValues.set(key, value),
    removeItem: (key) => storedValues.delete(key),
  };
  assert.equal(migrateBackendPref(stored).pref, 'subscription');
  assert.equal(storedValues.get('ae_mcp_backend'), 'subscription');
});

test('channel and error guidance never leaves a terminal instruction without an action', () => {
  const channels = [
    ...claudeChannels({ probe: { loggedIn: false, cliOk: true, reason: 'not-logged-in' } }),
    ...codexChannels({
      codexProbe: {
        loggedIn: false,
        runtimeOk: true,
        codexHome: 'C:\\isolated-codex-home',
        platformId: 'windows-x64',
      },
      loginFallback: true,
    }),
    ...openCodeChannels({ probe: { loggedIn: false }, providers: [{ needsApiKey: false }] }),
  ];
  for (const channel of channels) {
    const hasTerminalInstruction = /在终端/.test(channel.fixHint?.zh || '');
    assert.ok(!hasTerminalInstruction || channel.copyAction || channel.loginAction, channel.channel);
  }
  for (const item of Object.values(ERROR_CODES)) {
    assert.doesNotMatch(item.hint.zh, /在终端/, item.code);
  }
});
