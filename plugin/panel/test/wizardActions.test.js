import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstallCommands,
  commandPreview,
  detectTool,
  runAction,
} from '../src/cep/wizardActions.js';

function platform(resolutions = {}, id = 'windows-x64') {
  const calls = [];
  return {
    id,
    calls,
    resolveExecutable: async (id, options) => {
      calls.push({ kind: 'resolve', id, options });
      return resolutions[id] || {
        ok: false,
        id,
        code: 'NOT_FOUND',
        attempts: [],
      };
    },
    spawn: (executable, args, options) => {
      calls.push({ kind: 'spawn', executable, args, options });
      const handlers = {};
      const child = {
        stdout: {
          on: (event, handler) => {
            if (event === 'data') handlers.stdout = handler;
          },
        },
        stderr: {
          on: (event, handler) => {
            if (event === 'data') handlers.stderr = handler;
          },
        },
        on: (event, handler) => {
          handlers[event] = handler;
        },
      };
      setImmediate(() => {
        handlers.stdout?.('hello world');
        handlers.close?.(0);
      });
      return child;
    },
    legacyWizardInstallCommands: () => ({
      node: {
        file: 'winget',
        executableId: 'winget',
        args: ['install', '--id', 'OpenJS.NodeJS.LTS'],
      },
    }),
  };
}

test('detectTool checks the CEP host /health endpoint', async () => {
  const calls = [];
  const result = await detectTool('host', {
    port: 12000,
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ({ ok: true, pluginVersion: '0.9.6', port: 12000 }),
      };
    },
  });
  assert.deepEqual(calls, ['http://127.0.0.1:12000/health']);
  assert.deepEqual(result, {
    ok: true,
    version: 'Host 0.9.6',
    detail: '127.0.0.1:12000',
  });
});

test('detectTool uses existing platform probes for all three AI CLIs', async () => {
  const p = platform({
    claude: {
      ok: true,
      path: 'C:\\Tools\\claude.exe',
      source: 'path',
      version: '2.1.0',
    },
    codex: {
      ok: true,
      path: 'C:\\Tools\\codex.exe',
      source: 'path',
      version: '1.2.0',
    },
    opencode: {
      ok: true,
      path: 'C:\\Tools\\opencode.exe',
      source: 'path',
      version: '1.0.0',
    },
    node: {
      ok: true,
      path: 'C:\\Tools\\node.exe',
      source: 'path',
      version: '24.0.0',
    },
  });
  for (const id of ['claude', 'codex', 'opencode', 'node']) {
    assert.equal((await detectTool(id, { platform: p })).ok, true);
  }
  assert.deepEqual(p.calls.map((call) => call.id), [
    'claude',
    'codex',
    'opencode',
    'node',
  ]);
  assert.deepEqual(p.calls[0].options, { minimumVersion: '2.0.0' });
  assert.deepEqual(p.calls[3].options, { minimumVersion: '18.0.0' });
});

test('buildInstallCommands includes the official Claude installer on Windows', () => {
  const commands = buildInstallCommands({ platform: platform() });
  assert.deepEqual(Object.keys(commands), ['node', 'claude']);
  assert.deepEqual(commands.node.args, ['install', '--id', 'OpenJS.NodeJS.LTS']);
  assert.deepEqual(commands.claude, {
    file: 'powershell',
    executableId: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'],
  });
  assert.equal(
    commandPreview(commands.claude),
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"',
  );
});

test('buildInstallCommands omits the Windows-only Claude installer on macOS', () => {
  const commands = buildInstallCommands({ platform: platform({}, 'macos-arm64') });
  assert.deepEqual(Object.keys(commands), ['node']);
});

test('runAction resolves the fixed installer and retains streamed output', async () => {
  const p = platform({
    winget: {
      ok: true,
      id: 'winget',
      path: 'C:\\Windows\\winget.exe',
      source: 'path',
    },
  });
  const chunks = [];
  const result = await runAction({
    file: 'winget',
    executableId: 'winget',
    args: ['install', 'node'],
    platform: p,
    onChunk: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, 'hello world');
  assert.deepEqual(chunks, ['hello world']);
  assert.deepEqual(p.calls.map((call) => call.kind), ['resolve', 'spawn']);
});

test('runAction fails closed when the installer executable cannot be resolved', async () => {
  const p = platform();
  const result = await runAction({
    file: 'winget',
    executableId: 'winget',
    args: ['install', 'node'],
    platform: p,
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /NOT_FOUND/);
  assert.deepEqual(p.calls.map((call) => call.kind), ['resolve']);
});

test('commandPreview quotes arguments containing spaces', () => {
  assert.equal(
    commandPreview({ file: 'node', args: ['C:\\Program Files\\shim.js'] }),
    'node "C:\\Program Files\\shim.js"',
  );
});
