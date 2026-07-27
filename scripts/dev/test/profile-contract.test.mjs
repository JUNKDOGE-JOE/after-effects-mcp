import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertDailyPlanSafe,
  buildDevelopmentPlan,
  parseDevelopmentCommand,
} from '../profile-contract.mjs';

const DEFAULTS = Object.freeze({
  repoRoot: '/repo',
  home: '/Users/developer',
  formalAeApp: '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
});

const PATHS = Object.freeze({
  repoRoot: '/repo',
  uv: '/usr/local/bin/uv',
  npm: '/usr/local/bin/npm',
  node: '/runtime/node',
  python: '/repo/.venv/bin/python3',
  hostRoot: '/repo/plugin/host',
  sidecarRoot: '/repo/plugin/sidecar',
  panelRoot: '/repo/plugin/panel',
  cepInstaller: '/repo/scripts/install-plugin-dev-macos.sh',
  nativeBuilder: '/repo/native/ae-plugin/build-macos.mjs',
  nativeInstaller: '/repo/native/ae-plugin/install-dev-macos.mjs',
  sdkArchive: '/inputs/AfterEffectsSDK.zip',
  sdkRoot: '/inputs/AfterEffectsSDK',
  nativeOutput: '/private/tmp/ae-mcp-native-dev-test/artifact',
  developmentSmoke: '/repo/scripts/hardware/development_smoke.py',
});

test('parseDevelopmentCommand normalizes one explicit sync component', () => {
  const parsed = parseDevelopmentCommand(
    ['sync', '--component', 'cep'],
    DEFAULTS,
  );

  assert.deepEqual(parsed, {
    action: 'sync',
    components: ['cep'],
    repoRoot: '/repo',
    home: '/Users/developer',
    formalAeApp: '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
  });
});

test('parseDevelopmentCommand expands all and preserves ordered smoke components', () => {
  assert.deepEqual(
    parseDevelopmentCommand(
      ['bootstrap', '--component', 'all'],
      DEFAULTS,
    ).components,
    ['core', 'cep', 'native'],
  );
  const smoke = parseDevelopmentCommand([
    'smoke',
    '--component', 'core',
    '--component', 'cep',
    '--scenario', 'core-native-write-undo@1',
    '--fixture-path', '/fixtures/hdev.aep',
    '--recovery-archive-root', '/fixtures/recovery',
    '--evidence-dir', '/evidence/hdev',
  ], DEFAULTS);
  assert.deepEqual(smoke.components, ['core', 'cep']);
  assert.equal(smoke.scenario, 'core-native-write-undo@1');
  assert.equal(smoke.fixturePath, '/fixtures/hdev.aep');
  assert.equal(smoke.recoveryRoot, '/fixtures/recovery');
  assert.equal(smoke.evidenceDir, '/evidence/hdev');
});

test('parseDevelopmentCommand rejects unsafe or ambiguous arguments', () => {
  for (const argv of [
    ['sync', '--component', 'unknown'],
    ['sync', '--component', 'core', '--component', 'core'],
    ['sync', '--component', 'all', '--component', 'core'],
    ['sync', '--repo-root', 'relative', '--component', 'core'],
    ['smoke', '--component', 'core'],
    ['unknown', '--component', 'core'],
  ]) {
    assert.throws(
      () => parseDevelopmentCommand(argv, DEFAULTS),
      (error) => error?.code === 'DEV_ARGUMENT_INVALID',
      argv.join(' '),
    );
  }
});

test('buildDevelopmentPlan syncs only the selected CEP component without bootstrap', () => {
  const command = parseDevelopmentCommand(['sync', '--component', 'cep'], DEFAULTS);
  const plan = buildDevelopmentPlan(command, PATHS);

  assert.equal(plan.action, 'sync');
  assert.deepEqual(plan.components, ['cep']);
  assert.deepEqual(plan.reused, ['core', 'native']);
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'cep-panel-build',
    'cep-development-install',
  ]);
  assert.equal(plan.dependencyBootstrapInvocations, 0);
  assert.equal(plan.releasePackagingInvocations, 0);
});

test('buildDevelopmentPlan keeps Core live and makes bootstrap explicit', () => {
  const core = buildDevelopmentPlan(
    parseDevelopmentCommand(['sync', '--component', 'core'], DEFAULTS),
    PATHS,
  );
  assert.deepEqual(core.steps, []);
  assert.deepEqual(core.actions, [{
    component: 'core',
    action: 'restart-mcp-session',
    reason: 'live checkout requires no copy or RuntimeManager generation',
  }]);

  const bootstrap = buildDevelopmentPlan(
    parseDevelopmentCommand(['bootstrap', '--component', 'all'], DEFAULTS),
    PATHS,
  );
  assert.equal(bootstrap.dependencyBootstrapInvocations, 4);
  assert.equal(bootstrap.releasePackagingInvocations, 0);
  assert.deepEqual(
    bootstrap.steps.filter((step) => step.kind === 'dependency-install')
      .map((step) => step.id),
    ['core-uv-sync', 'host-npm-ci', 'sidecar-npm-ci', 'panel-npm-ci'],
  );
});

test('buildDevelopmentPlan passes closed component disposition to HDEV', () => {
  const command = parseDevelopmentCommand([
    'smoke',
    '--component', 'core',
    '--component', 'cep',
    '--scenario', 'core-native-write-undo@1',
    '--fixture-path', '/fixtures/hdev.aep',
    '--recovery-archive-root', '/fixtures/recovery',
    '--evidence-dir', '/evidence/hdev',
  ], DEFAULTS);
  const plan = buildDevelopmentPlan(command, PATHS);

  assert.deepEqual(plan.components, ['core', 'cep']);
  assert.deepEqual(plan.reused, ['native']);
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'hdev-core-native-write-undo',
  ]);
  assert.deepEqual(plan.steps[0].args.slice(0, 10), [
    '-B', '-I',
    '/repo/scripts/hardware/development_smoke.py',
    '--scenario', 'core-native-write-undo@1',
    '--selected-components', 'core,cep',
    '--reused-components', 'native',
    '--checkout',
  ]);
  assert.equal(plan.dependencyBootstrapInvocations, 0);
});

test('assertDailyPlanSafe rejects an implicit dependency install', () => {
  assert.throws(
    () => assertDailyPlanSafe({
      action: 'sync',
      steps: [{
        id: 'forbidden-npm-ci',
        component: 'cep',
        kind: 'dependency-install',
        executable: '/usr/local/bin/npm',
        args: ['ci'],
        cwd: '/repo/plugin/panel',
      }],
    }),
    (error) => error?.code === 'DEV_IMPLICIT_BOOTSTRAP_FORBIDDEN',
  );
});
