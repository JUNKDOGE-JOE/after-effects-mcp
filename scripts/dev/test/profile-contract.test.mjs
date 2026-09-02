import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  assertDailyPlanSafe,
  buildDevelopmentPlan,
  parseDevelopmentCommand,
} from '../profile-contract.mjs';

const VOLUME_ROOT = path.parse(process.cwd()).root;
const REPO_ROOT = path.join(VOLUME_ROOT, 'repo');
const HOME_ROOT = path.join(VOLUME_ROOT, 'Users', 'developer');
const FORMAL_AE_APP = path.join(
  VOLUME_ROOT,
  'Applications',
  'Adobe After Effects 2026',
  'Adobe After Effects 2026.app',
);

const DEFAULTS = Object.freeze({
  repoRoot: REPO_ROOT,
  home: HOME_ROOT,
  formalAeApp: FORMAL_AE_APP,
});

const PATHS = Object.freeze({
  repoRoot: REPO_ROOT,
  uv: path.join(VOLUME_ROOT, 'usr', 'local', 'bin', 'uv'),
  npm: path.join(VOLUME_ROOT, 'usr', 'local', 'bin', 'npm'),
  node: path.join(VOLUME_ROOT, 'runtime', 'node'),
  hostRoot: path.join(REPO_ROOT, 'plugin', 'host'),
  sidecarRoot: path.join(REPO_ROOT, 'plugin', 'sidecar'),
  panelRoot: path.join(REPO_ROOT, 'plugin', 'panel'),
  cepInstaller: path.join(REPO_ROOT, 'scripts', 'install-plugin-dev-macos.sh'),
  nativeBuilder: path.join(REPO_ROOT, 'native', 'ae-plugin', 'build-macos.mjs'),
  nativeInstaller: path.join(REPO_ROOT, 'native', 'ae-plugin', 'install-dev-macos.mjs'),
  sdkArchive: path.join(VOLUME_ROOT, 'inputs', 'AfterEffectsSDK.zip'),
  sdkRoot: path.join(VOLUME_ROOT, 'inputs', 'AfterEffectsSDK'),
  nativeOutput: path.join(VOLUME_ROOT, 'tmp', 'ae-mcp-native-dev-test', 'artifact'),
});

test('parseDevelopmentCommand normalizes one explicit sync component', () => {
  const parsed = parseDevelopmentCommand(
    ['sync', '--component', 'cep'],
    DEFAULTS,
  );

  assert.deepEqual(parsed, {
    action: 'sync',
    components: ['cep'],
    repoRoot: REPO_ROOT,
    home: HOME_ROOT,
    formalAeApp: FORMAL_AE_APP,
  });
});

test('parseDevelopmentCommand expands all components', () => {
  assert.deepEqual(
    parseDevelopmentCommand(
      ['bootstrap', '--component', 'all'],
      DEFAULTS,
    ).components,
    ['core', 'cep', 'native'],
  );
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

test('assertDailyPlanSafe rejects an implicit dependency install', () => {
  assert.throws(
    () => assertDailyPlanSafe({
      action: 'sync',
      steps: [{
        id: 'forbidden-npm-ci',
        component: 'cep',
        kind: 'dependency-install',
        executable: PATHS.npm,
        args: ['ci'],
        cwd: PATHS.panelRoot,
      }],
    }),
    (error) => error?.code === 'DEV_IMPLICIT_BOOTSTRAP_FORBIDDEN',
  );
});
