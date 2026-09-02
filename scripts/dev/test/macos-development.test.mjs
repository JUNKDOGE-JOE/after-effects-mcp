import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  executeDevelopmentPlan,
  inspectDevelopmentEnvironment,
  launchDevelopmentAe,
} from '../macos-development.mjs';
import { skipUnlessMacOS } from '../../package/test/helpers/symlink-support.mjs';

async function writeFile(root, relative, contents = '', mode = 0o644) {
  const target = path.join(root, ...relative.split('/'));
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, contents, { mode });
  await fs.promises.chmod(target, mode);
  return target;
}

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-dev-doctor-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const formalAeApp = path.join(root, 'Adobe After Effects 2026.app');
  const cepRoot = path.join(
    home,
    'Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel',
  );
  await writeFile(repoRoot, 'pyproject.toml', '[tool.uv.workspace]\n');
  await writeFile(
    repoRoot,
    'packages/core/ae_mcp/__main__.py',
    'print("fixture")\n',
  );
  await writeFile(repoRoot, 'packages/core/ae_mcp/__init__.py', '');
  await writeFile(repoRoot, 'packages/bridge/ae_mcp_bridge/__init__.py', '');
  const interpreterTarget = await writeFile(
    repoRoot,
    '.venv/bin/python3.13',
    '#!/bin/sh\nexit 0\n',
    0o755,
  );
  const interpreter = path.join(repoRoot, '.venv', 'bin', 'python3');
  await fs.promises.symlink(path.basename(interpreterTarget), interpreter);
  await writeFile(cepRoot, '.debug', '<ExtensionList />\n');
  await writeFile(
    formalAeApp,
    'Contents/Info.plist',
    '<plist><dict></dict></plist>\n',
  );
  const formalAeExecutable = await writeFile(
    formalAeApp,
    'Contents/MacOS/After Effects',
    '#!/bin/sh\nexit 0\n',
    0o755,
  );

  const calls = [];
  const execFile = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === '/usr/bin/plutil') {
      const key = args[1];
      const values = {
        CFBundleExecutable: 'After Effects',
        CFBundleShortVersionString: '26.3.0',
        CFBundleVersion: '26.3.0.87',
      };
      return { stdout: `${values[key]}\n`, stderr: '' };
    }
    if (file.includes('/.venv/bin/python3')) {
      return {
        stdout: [
          await fs.promises.realpath(
            path.join(repoRoot, 'packages/core/ae_mcp/__init__.py'),
          ),
          await fs.promises.realpath(
            path.join(repoRoot, 'packages/bridge/ae_mcp_bridge/__init__.py'),
          ),
        ].join('\n'),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
  return {
    root,
    repoRoot,
    home,
    formalAeApp,
    formalAeExecutable,
    interpreter,
    calls,
    dependencies: {
      execFile,
      spawn() {
        throw new Error('spawn not expected');
      },
      processInspector: {
        async afterEffectsRunning() {
          return false;
        },
      },
    },
  };
}

test('doctor returns the closed read-only development report', async (t) => {
  if (skipUnlessMacOS(t)) return;
  const h = await fixture(t);
  const report = await inspectDevelopmentEnvironment({
    repoRoot: h.repoRoot,
    home: h.home,
    formalAeApp: h.formalAeApp,
    dependencies: h.dependencies,
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.profile, 'development');
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  const canonicalRepo = await fs.promises.realpath(h.repoRoot);
  const venvEntrypoint = path.join(canonicalRepo, '.venv/bin/python3');
  assert.equal(report.checkoutPath, canonicalRepo);
  assert.equal(report.interpreterPath, venvEntrypoint);
  assert.equal(
    report.checks.find((check) => check.id === 'core-interpreter').resolvedPath,
    await fs.promises.realpath(h.interpreter),
  );
  assert.equal(
    h.calls.some((call) => call.file === venvEntrypoint),
    true,
  );
  assert.equal(report.formalAeApp, await fs.promises.realpath(h.formalAeApp));
  assert.equal(
    report.formalAeExecutable,
    await fs.promises.realpath(h.formalAeExecutable),
  );
  assert.deepEqual(report.checks.map((check) => check.id), [
    'checkout',
    'core-entrypoint',
    'core-interpreter',
    'core-import',
    'cep-development-marker',
    'cep-release-manifest-absent',
    'formal-ae-app',
    'formal-ae-executable',
  ]);
  assert.equal(report.checks.every((check) => check.ok), true);
  assert.deepEqual(report.blockers, []);
  assert.equal(
    h.calls.some((call) => call.file.includes('/.venv/bin/python3')
      && call.args.slice(0, 3).join(' ') === '-B -I -c'
      && call.args[3].includes('sys.path.insert(0,sys.argv[1])')
      && call.args[3].includes('sys.path.insert(0,sys.argv[2])')
      && call.args.at(-2) === path.join(report.checkoutPath, 'packages', 'core')
      && call.args.at(-1) === path.join(report.checkoutPath, 'packages', 'bridge')),
    true,
  );
  assert.equal(
    report.checks.find((check) => check.id === 'core-import').bridgePath,
    path.join(report.checkoutPath, 'packages/bridge/ae_mcp_bridge/__init__.py'),
  );
});

test('doctor reports a missing Core interpreter without writing', async (t) => {
  if (skipUnlessMacOS(t)) return;
  const h = await fixture(t);
  await fs.promises.unlink(h.interpreter);
  const writes = [];
  const readOnlyFs = new Proxy(fs.promises, {
    get(target, property) {
      if (['mkdir', 'writeFile', 'rename', 'unlink', 'rm'].includes(property)) {
        return async (...args) => {
          writes.push({ property, args });
          throw new Error('doctor attempted a write');
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const report = await inspectDevelopmentEnvironment({
    repoRoot: h.repoRoot,
    home: h.home,
    formalAeApp: h.formalAeApp,
    dependencies: { ...h.dependencies, fs: readOnlyFs },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers.map((item) => item.code), [
    'DEV_CORE_INTERPRETER_MISSING',
  ]);
  assert.equal(writes.length, 0);
});

test('doctor checks CEP source dependencies only when CEP is selected', async (t) => {
  if (skipUnlessMacOS(t)) return;
  const h = await fixture(t);
  const core = await inspectDevelopmentEnvironment({
    repoRoot: h.repoRoot,
    home: h.home,
    formalAeApp: h.formalAeApp,
    components: ['core'],
    dependencies: h.dependencies,
  });
  const cep = await inspectDevelopmentEnvironment({
    repoRoot: h.repoRoot,
    home: h.home,
    formalAeApp: h.formalAeApp,
    components: ['cep'],
    dependencies: h.dependencies,
  });

  assert.equal(core.blockers.some((item) => item.code === 'DEV_CEP_DEPENDENCIES_MISSING'), false);
  assert.equal(cep.blockers.filter(
    (item) => item.code === 'DEV_CEP_DEPENDENCIES_MISSING',
  ).length, 3);
});

test('launch doctor reuses and validates the active RuntimeManager Node without installing', async (t) => {
  if (skipUnlessMacOS(t)) return;
  const h = await fixture(t);
  const runtimeRoot = path.join(h.home, '.ae-mcp', 'runtime');
  const relative = 'generations/g-0123456789abcdef';
  const nodePath = await writeFile(
    runtimeRoot,
    `${relative}/runtime/node/bin/node`,
    '#!/bin/sh\nexit 0\n',
    0o755,
  );
  await writeFile(runtimeRoot, 'current', `${relative}\n`);
  const canonicalNode = await fs.promises.realpath(nodePath);
  const originalExecFile = h.dependencies.execFile;
  h.dependencies.execFile = async (file, args, options) => {
    if (file === canonicalNode) {
      h.calls.push({ file, args, options });
      return { stdout: 'v24.17.0 arm64\n', stderr: '' };
    }
    return originalExecFile(file, args, options);
  };

  const report = await inspectDevelopmentEnvironment({
    repoRoot: h.repoRoot,
    home: h.home,
    formalAeApp: h.formalAeApp,
    requireNode: true,
    dependencies: h.dependencies,
  });

  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.nodePath, canonicalNode);
  assert.deepEqual(
    report.checks.find((check) => check.id === 'development-node'),
    {
      id: 'development-node',
      ok: true,
      path: canonicalNode,
      version: '24.17.0',
      arch: 'arm64',
      source: 'active-runtime',
    },
  );
  assert.equal(
    h.calls.some((call) => call.file === canonicalNode
      && call.args.join(' ') === '-p process.version + " " + process.arch'),
    true,
  );
});

test('launch doctor fails closed when no compatible development Node is available', async (t) => {
  if (skipUnlessMacOS(t)) return;
  const h = await fixture(t);
  const report = await inspectDevelopmentEnvironment({
    repoRoot: h.repoRoot,
    home: h.home,
    formalAeApp: h.formalAeApp,
    requireNode: true,
    environment: {},
    dependencies: h.dependencies,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers.map((item) => item.code), [
    'DEV_NODE_RUNTIME_MISSING',
  ]);
});

test('launch refuses a running AE and otherwise spawns only the exact formal executable', async (t) => {
  if (skipUnlessMacOS(t)) return;
  const h = await fixture(t);
  const nodePath = await writeFile(
    h.root,
    'node-v24/bin/node',
    '#!/bin/sh\nexit 0\n',
    0o755,
  );
  const originalExecFile = h.dependencies.execFile;
  const canonicalNode = await fs.promises.realpath(nodePath);
  h.dependencies.execFile = async (file, args, options) => {
    if (file === canonicalNode) {
      h.calls.push({ file, args, options });
      return { stdout: 'v24.17.0 arm64\n', stderr: '' };
    }
    return originalExecFile(file, args, options);
  };
  const report = await inspectDevelopmentEnvironment({
    repoRoot: h.repoRoot,
    home: h.home,
    formalAeApp: h.formalAeApp,
    requireNode: true,
    environment: { AE_MCP_NODE_CLI: nodePath },
    dependencies: h.dependencies,
  });
  let spawned = null;
  const spawn = (file, args, options) => {
    spawned = { file, args, options, unrefCalls: 0 };
    return {
      pid: 4242,
      unref() {
        spawned.unrefCalls += 1;
      },
    };
  };

  await assert.rejects(
    launchDevelopmentAe(report, {
      processInspector: { async afterEffectsRunning() { return true; } },
      spawn,
      environment: {},
    }),
    (error) => error.code === 'DEV_AE_ALREADY_RUNNING',
  );
  assert.equal(spawned, null);

  const receipt = await launchDevelopmentAe(report, {
    processInspector: { async afterEffectsRunning() { return false; } },
    spawn,
    environment: { SENTINEL: 'kept' },
    now: () => new Date('2026-07-28T00:00:00.000Z'),
  });
  assert.equal(spawned.file, report.formalAeExecutable);
  assert.deepEqual(spawned.args, []);
  assert.equal(spawned.options.cwd, path.dirname(report.formalAeExecutable));
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.stdio, 'ignore');
  assert.equal(spawned.options.shell, false);
  assert.equal(spawned.options.env.SENTINEL, 'kept');
  assert.equal(spawned.options.env.AE_MCP_DEV_RUNTIME, report.checkoutPath);
  assert.equal(spawned.options.env.AE_MCP_NODE_CLI, report.nodePath);
  assert.equal(spawned.unrefCalls, 1);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    profile: 'development',
    pid: 4242,
    formalAeExecutable: report.formalAeExecutable,
    checkoutPath: report.checkoutPath,
    launchedAt: '2026-07-28T00:00:00.000Z',
  });
});

test('plan execution uses execFile and reports bounded invocation counts', async () => {
  const calls = [];
  const plan = {
    action: 'sync',
    components: ['cep'],
    steps: [{
      id: 'cep-build',
      component: 'cep',
      kind: 'build',
      executable: '/node',
      args: ['build.mjs'],
      cwd: '/checkout/plugin/panel',
    }],
    actions: [],
    dependencyBootstrapInvocations: 0,
    releasePackagingInvocations: 0,
  };
  const receipt = await executeDevelopmentPlan(plan, {
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: 'ok', stderr: '' };
    },
    environment: { HOME: '/private/home' },
  });

  assert.equal(calls[0].file, '/node');
  assert.deepEqual(calls[0].args, ['build.mjs']);
  assert.equal(calls[0].options.cwd, '/checkout/plugin/panel');
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    profile: 'development',
    action: 'sync',
    components: ['cep'],
    steps: [{ id: 'cep-build', component: 'cep', kind: 'build', exitCode: 0 }],
    actions: [],
    dependencyBootstrapInvocations: 0,
    releasePackagingInvocations: 0,
  });
});

test('daily execution refuses dependency installation even for a forged plan', async () => {
  await assert.rejects(
    executeDevelopmentPlan({
      action: 'sync',
      components: ['cep'],
      steps: [{
        id: 'forbidden',
        component: 'cep',
        kind: 'dependency-install',
        executable: '/npm',
        args: ['ci'],
        cwd: '/checkout',
      }],
      actions: [],
      dependencyBootstrapInvocations: 1,
      releasePackagingInvocations: 0,
    }, {
      execFile: async () => {
        throw new Error('must not execute');
      },
    }),
    (error) => error.code === 'DEV_IMPLICIT_BOOTSTRAP_FORBIDDEN',
  );
});
