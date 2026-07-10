import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRepoRoot,
  detectTool,
  buildInstallCommands,
  openLoginTerminal,
  runAction,
} from '../src/cep/wizardActions.js';

function platform(resolutions = {}) {
  const calls = [];
  return {
    calls,
    paths: {
      join: (parts) => parts.join('\\'),
      resolve: (parts) => parts.join('\\').replace(/\//g, '\\'),
      dirname: (value) => String(value).replace(/\\[^\\]+$/, ''),
    },
    fs: { existsSync: () => false },
    completeSpawnEnv: (base = {}, additions = {}) => ({ ...base, ...additions }),
    resolveExecutable: async (id, options) => {
      calls.push({ kind: 'resolve', id, options });
      return resolutions[id] || { ok: false, id, code: 'NOT_FOUND', attempts: [] };
    },
    spawn: (executable, args, options) => {
      calls.push({ kind: 'spawn', executable, args, options });
      const handlers = {};
      const child = {
        stdout: { on: (event, handler) => { if (event === 'data') handlers.stdout = handler; } },
        stderr: { on: (event, handler) => { if (event === 'data') handlers.stderr = handler; } },
        on: (event, handler) => { handlers[event] = handler; },
      };
      setImmediate(() => {
        handlers.stdout?.('hello world');
        handlers.exit?.(0);
        handlers.close?.(0);
      });
      return child;
    },
    openLoginTerminal: async (tool) => {
      calls.push({ kind: 'login', tool });
      return { exitCode: 0 };
    },
    legacyWizardInstallCommands: ({ panelVersion, repoRoot, repo }) => {
      const src = (sub) => repoRoot ? `${repoRoot}\\packages\\${sub}` : `git+${repo}@v${panelVersion}#subdirectory=packages/${sub}`;
      return {
        uv: { file: 'winget', args: ['install', '--id', 'astral-sh.uv', '-e'] },
        uvFallback: { file: 'legacy-script-host', args: ['install-uv'] },
        node: { file: 'winget', args: ['install', '--id', 'OpenJS.NodeJS.LTS', '-e'] },
        claude: { file: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
        aeMcp: { file: 'uv', args: ['tool', 'install', '--force', '--from', src('core'), 'ae-mcp', '--with', src('bridge'), '--with', src('snapshot-mss')] },
      };
    },
  };
}

test('detectTool delegates version and architecture validation to the platform resolver', async () => {
  const p = platform({
    uv: { ok: true, id: 'uv', path: 'C:\\Tools\\uv.exe', argsPrefix: [], source: 'path', version: '0.7.2', arch: 'x64' },
    node: { ok: true, id: 'node', path: 'C:\\Runtime\\node.exe', argsPrefix: [], source: 'runtime', version: '24.17.0', arch: 'x64' },
  });
  assert.deepEqual(await detectTool('uv', { platform: p }), { ok: true, version: '0.7.2', path: 'C:\\Tools\\uv.exe', source: 'path' });
  assert.deepEqual(await detectTool('node', { platform: p }), { ok: true, version: '24.17.0', path: 'C:\\Runtime\\node.exe', source: 'runtime' });
  assert.equal((await detectTool('claude', { platform: p })).ok, false);
  assert.deepEqual(p.calls.map((call) => call.id), ['uv', 'node', 'claude']);
});

test('detectTool checks the stable ae-mcp launcher without direct system discovery', async () => {
  const p = platform({
    'ae-mcp': { ok: true, id: 'ae-mcp', path: 'C:\\Users\\X\\.ae-mcp\\bin\\ae-mcp.exe', argsPrefix: [], source: 'runtime', version: null, arch: 'x64' },
  });
  assert.deepEqual(await detectTool('aeMcp', { platform: p }), {
    ok: true,
    version: 'C:\\Users\\X\\.ae-mcp\\bin\\ae-mcp.exe',
    path: 'C:\\Users\\X\\.ae-mcp\\bin\\ae-mcp.exe',
    source: 'runtime',
  });
});

test('ae-mcp install command pins the release tag for end users', () => {
  const cmds = buildInstallCommands({ panelVersion: '0.5.0', repoRoot: '', platform: platform() });
  const joined = cmds.aeMcp.args.join(' ');
  assert.ok(joined.includes('git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.5.0#subdirectory=packages/core'));
  assert.ok(joined.includes('#subdirectory=packages/bridge'));
  assert.ok(joined.includes('#subdirectory=packages/snapshot-mss'));
});

test('ae-mcp install command uses local paths on a dev checkout', () => {
  const cmds = buildInstallCommands({ panelVersion: '0.5.0', repoRoot: 'E:\\repo', platform: platform() });
  const joined = cmds.aeMcp.args.join(' ');
  assert.ok(joined.includes('E:\\repo\\packages\\core'));
  assert.ok(!joined.includes('git+https'));
});

test('runAction resolves the fixed command and does not replace inherited env with an empty object', async () => {
  const p = platform({
    npm: { ok: true, id: 'npm', path: 'C:\\Tools\\npm.cmd', argsPrefix: [], source: 'path', version: '11.0.0', arch: null },
  });
  const events = [];
  const result = await runAction({ file: 'npm', executableId: 'npm', args: ['install', '-g', 'pkg'], platform: p, onChunk: (chunk) => events.push(chunk) });
  assert.equal(result.ok, true);
  assert.equal(result.output, 'hello world');
  assert.deepEqual(events, ['hello world']);
  assert.deepEqual(p.calls.map((call) => call.kind), ['resolve', 'spawn']);
  assert.equal(p.calls[0].id, 'npm');
  assert.equal(p.calls[1].executable.path, 'C:\\Tools\\npm.cmd');
  assert.equal(Object.hasOwn(p.calls[1].options, 'env'), false);
});

test('runAction waits for close and retains output delivered after exit', async () => {
  const handlers = {};
  const p = platform({
    brew: { ok: true, id: 'brew', path: '/opt/homebrew/bin/brew', argsPrefix: [], source: 'standard', version: '4.0.0', arch: null },
  });
  p.spawn = (executable, args, options) => {
    p.calls.push({ kind: 'spawn', executable, args, options });
    return {
      stdout: { on: (event, handler) => { if (event === 'data') handlers.stdout = handler; } },
      stderr: { on: (event, handler) => { if (event === 'data') handlers.stderr = handler; } },
      on: (event, handler) => { handlers[event] = handler; },
    };
  };

  const pending = runAction({ file: 'brew', executableId: 'brew', args: ['install', 'uv'], platform: p });
  await Promise.resolve();
  handlers.exit?.(0);
  handlers.stdout('late output');
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  handlers.close(0);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.output, 'late output');
});

test('runAction fails closed when the requested installer executable cannot be resolved', async () => {
  const p = platform();
  const result = await runAction({ file: 'winget', executableId: 'winget', args: ['install', 'pkg'], platform: p });
  assert.equal(result.ok, false);
  assert.match(result.output, /NOT_FOUND/);
  assert.deepEqual(p.calls.map((call) => call.kind), ['resolve']);
});

test('openLoginTerminal delegates fixed tool choices to the adapter', async () => {
  const p = platform();
  assert.equal(await openLoginTerminal({ tool: 'claude', platform: p }), true);
  assert.equal(await openLoginTerminal({ tool: 'codex', platform: p }), true);
  assert.deepEqual(p.calls, [{ kind: 'login', tool: 'claude' }, { kind: 'login', tool: 'codex' }]);
});

test('detectRepoRoot reuses the platform-native project root probe', () => {
  const p = platform();
  const root = detectRepoRoot({
    extRoot: 'E:\\repo\\plugin\\panel',
    platform: p,
    fsImpl: { existsSync: (candidate) => candidate === 'E:\\repo\\pyproject.toml' },
  });
  assert.equal(root, 'E:\\repo');
});
