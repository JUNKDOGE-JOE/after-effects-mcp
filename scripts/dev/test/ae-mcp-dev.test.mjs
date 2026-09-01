import test from 'node:test';
import assert from 'node:assert/strict';

import { developmentError } from '../profile-contract.mjs';
import { main } from '../ae-mcp-dev.mjs';

const DEFAULTS = Object.freeze({
  repoRoot: '/checkout',
  home: '/Users/developer',
  formalAeApp: '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
});

function harness({
  report = {
    schemaVersion: 1,
    profile: 'development',
    ok: true,
    checkoutPath: '/checkout',
    interpreterPath: '/checkout/.venv/bin/python3',
    formalAeApp: DEFAULTS.formalAeApp,
    formalAeExecutable: `${DEFAULTS.formalAeApp}/Contents/MacOS/After Effects`,
    checks: [],
    blockers: [],
  },
  launchError = null,
} = {}) {
  const calls = [];
  const reports = Array.isArray(report) ? [...report] : null;
  const dependencies = {
    defaults: DEFAULTS,
    environment: { PATH: '/usr/bin:/bin' },
    async inspectDevelopmentEnvironment(options) {
      calls.push({ kind: 'doctor', options });
      return reports ? reports.shift() : report;
    },
    async launchDevelopmentAe(_report, options) {
      calls.push({ kind: 'launch', options });
      if (launchError) throw launchError;
      return {
        schemaVersion: 1,
        profile: 'development',
        pid: 1234,
        formalAeExecutable: report.formalAeExecutable,
        checkoutPath: report.checkoutPath,
        launchedAt: '2026-07-28T00:00:00.000Z',
      };
    },
    async executeDevelopmentPlan(plan) {
      calls.push({ kind: 'execute', plan });
      return {
        schemaVersion: 1,
        profile: 'development',
        action: plan.action,
        components: [...plan.components],
        steps: plan.steps.map((step) => ({
          id: step.id,
          component: step.component,
          kind: step.kind,
          exitCode: 0,
        })),
        actions: [...plan.actions],
        dependencyBootstrapInvocations: plan.dependencyBootstrapInvocations,
        releasePackagingInvocations: plan.releasePackagingInvocations,
      };
    },
    async mkdtemp(prefix) {
      calls.push({ kind: 'mkdtemp', prefix });
      return '/private/tmp/ae-mcp-native-dev-fixture';
    },
    calls,
  };
  return dependencies;
}

test('CLI doctor returns a development profile report', async () => {
  const h = harness();
  const result = await main(['doctor'], h);

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.ok, true);
  assert.equal(result.output.result.profile, 'development');
  assert.equal(h.calls[0].kind, 'doctor');
  assert.deepEqual(h.calls[0].options.components, ['core']);
});

test('CLI validates arguments before doctor or process execution', async () => {
  const h = harness();
  const result = await main(['unknown'], h);

  assert.equal(result.exitCode, 2);
  assert.equal(result.output.error.code, 'DEV_ARGUMENT_INVALID');
  assert.deepEqual(h.calls, []);
});

test('CLI returns a closed doctor blocker without exposing private paths in text', async () => {
  const h = harness({
    report: {
      schemaVersion: 1,
      profile: 'development',
      ok: false,
      checkoutPath: '/private/checkout',
      checks: [],
      blockers: [{
        id: 'core-interpreter',
        ok: false,
        code: 'DEV_CORE_INTERPRETER_MISSING',
        path: '/private/checkout/.venv/bin/python3',
      }],
    },
  });
  const result = await main(['sync', '--component', 'core'], h);

  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error.code, 'DEV_DOCTOR_BLOCKED');
  assert.equal(JSON.stringify(result.output.error).includes('/private/checkout'), false);
  assert.deepEqual(result.output.error.recovery, [{
    id: 'core-interpreter',
    code: 'DEV_CORE_INTERPRETER_MISSING',
  }]);
  assert.equal(h.calls.some((call) => call.kind === 'execute'), false);
});

test('CLI reports an already-running AE without spawning another host', async () => {
  const h = harness({
    launchError: developmentError(
      'DEV_AE_ALREADY_RUNNING',
      'formal After Effects is already running',
    ),
  });
  const result = await main(['launch-ae'], h);

  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error.code, 'DEV_AE_ALREADY_RUNNING');
});

test('CLI launch requires doctor to resolve a compatible development Node', async () => {
  const h = harness();
  const result = await main(['launch-ae'], h);

  assert.equal(result.exitCode, 0);
  assert.equal(h.calls[0].kind, 'doctor');
  assert.equal(h.calls[0].options.requireNode, true);
});

test('Core-only sync has zero process steps and ignores CEP source dependency state', async () => {
  const h = harness();
  const result = await main(['sync', '--component', 'core'], h);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output.result, {
    selected: ['core'],
    reused: ['cep', 'native'],
    restart: ['mcp-session'],
    steps: [],
    dependencyBootstrapInvocations: 0,
    releasePackagingInvocations: 0,
  });
  const doctor = h.calls.find((call) => call.kind === 'doctor');
  assert.deepEqual(doctor.options.components, ['core']);
});

test('CEP sync stops when component-scoped doctor finds missing dependencies', async () => {
  const h = harness({
    report: {
      schemaVersion: 1,
      profile: 'development',
      ok: false,
      checkoutPath: '/checkout',
      checks: [],
      blockers: [{
        id: 'cep-panel-dependencies',
        ok: false,
        code: 'DEV_CEP_DEPENDENCIES_MISSING',
        path: '/checkout/plugin/panel/node_modules',
      }],
    },
  });
  const result = await main(['sync', '--component', 'cep'], h);

  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error.code, 'DEV_DOCTOR_BLOCKED');
  assert.deepEqual(result.output.error.recovery, [{
    id: 'cep-panel-dependencies',
    code: 'DEV_CEP_DEPENDENCIES_MISSING',
  }]);
});

test('CEP sync may replace only a packaged install and must pass post-sync doctor', async () => {
  const packaged = {
    schemaVersion: 1,
    profile: 'development',
    ok: false,
    checkoutPath: '/checkout',
    interpreterPath: '/checkout/.venv/bin/python3',
    formalAeExecutable: '/Applications/After Effects',
    checks: [],
    blockers: [
      {
        id: 'cep-development-marker',
        ok: false,
        code: 'DEV_CEP_MARKER_MISSING',
        path: '/installed/.debug',
      },
      {
        id: 'cep-release-manifest-absent',
        ok: false,
        code: 'DEV_CEP_RELEASE_MANIFEST_PRESENT',
        path: '/installed/bundle-manifest.json',
      },
    ],
  };
  const development = {
    ...packaged,
    ok: true,
    blockers: [],
  };
  const h = harness({ report: [packaged, development] });
  const result = await main(['sync', '--component', 'cep'], h);

  assert.equal(result.exitCode, 0, JSON.stringify(result.output));
  assert.equal(h.calls.filter((call) => call.kind === 'doctor').length, 2);
  assert.equal(h.calls.filter((call) => call.kind === 'execute').length, 1);
  assert.equal(result.output.result.dependencyBootstrapInvocations, 0);
  assert.equal(result.output.result.releasePackagingInvocations, 0);
});

test('every daily plan preserves zero dependency and release invocations', async () => {
  const cases = [
    ['doctor'],
    ['launch-ae'],
    ['sync', '--component', 'core'],
  ];
  for (const argv of cases) {
    const h = harness();
    const result = await main(argv, h);
    assert.equal(result.exitCode, 0, JSON.stringify(result.output));
    assert.equal(
      result.output.result.dependencyBootstrapInvocations ?? 0,
      0,
    );
    assert.equal(result.output.result.releasePackagingInvocations ?? 0, 0);
  }
});

test('only literal bootstrap can produce dependency-install steps', async () => {
  const h = harness();
  const result = await main(['bootstrap', '--component', 'core'], h);

  assert.equal(result.exitCode, 0);
  const execution = h.calls.find((call) => call.kind === 'execute');
  assert.equal(execution.plan.action, 'bootstrap');
  assert.deepEqual(execution.plan.steps.map((step) => step.kind), [
    'dependency-install',
  ]);
});
