import path from 'node:path';

export const COMPONENTS = Object.freeze(['core', 'cep', 'native']);
export const DAILY_ACTIONS = Object.freeze(['doctor', 'launch-ae', 'sync']);

const ACTIONS = new Set(['bootstrap', ...DAILY_ACTIONS]);
const PATH_OPTIONS = new Map([
  ['--repo-root', 'repoRoot'],
  ['--home', 'home'],
  ['--formal-ae-app', 'formalAeApp'],
  ['--sdk-archive', 'sdkArchive'],
  ['--sdk-root', 'sdkRoot'],
]);
const PATH_MEMBERS = new Set(PATH_OPTIONS.values());

export function developmentError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function invalid(message) {
  throw developmentError('DEV_ARGUMENT_INVALID', message);
}

function requireAbsolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    invalid(`${name} must be absolute`);
  }
  return path.normalize(value);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    invalid(`${name} must be a nonempty string`);
  }
  return value;
}

function normalizedComponents(values, action) {
  if (values.length === 0) {
    if (action === 'doctor' || action === 'launch-ae') return ['core'];
    invalid(`${action} requires --component`);
  }
  if (new Set(values).size !== values.length) invalid('--component values must be unique');
  if (values.includes('all')) {
    if (values.length !== 1) invalid('all cannot be combined with another component');
    return [...COMPONENTS];
  }
  if (values.some((value) => !COMPONENTS.includes(value))) {
    invalid('--component must be core, cep, native, or all');
  }
  return [...values];
}

export function parseDevelopmentCommand(argv, defaults) {
  if (!Array.isArray(argv) || !ACTIONS.has(argv[0])) invalid('unknown development action');
  const action = argv[0];
  const optionValues = new Map();
  const components = [];

  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (typeof name !== 'string' || !name.startsWith('--') || value === undefined) {
      invalid('options require name/value pairs');
    }
    if (name === '--component') {
      components.push(requiredString(value, name));
      continue;
    }
    const member = PATH_OPTIONS.get(name);
    if (!member) invalid(`unsupported option ${name}`);
    if (optionValues.has(member)) invalid(`${name} may be supplied only once`);
    optionValues.set(member, value);
  }

  const result = {
    action,
    components: Object.freeze(normalizedComponents(components, action)),
    repoRoot: requireAbsolute(optionValues.get('repoRoot') ?? defaults?.repoRoot, '--repo-root'),
    home: requireAbsolute(optionValues.get('home') ?? defaults?.home, '--home'),
    formalAeApp: requireAbsolute(
      optionValues.get('formalAeApp') ?? defaults?.formalAeApp,
      '--formal-ae-app',
    ),
  };
  for (const [member, value] of optionValues) {
    if (member in result) continue;
    result[member] = PATH_MEMBERS.has(member)
      ? requireAbsolute(value, member)
      : requiredString(value, member);
  }
  return Object.freeze(result);
}

function processStep(id, component, kind, executable, args, cwd) {
  return Object.freeze({
    id,
    component,
    kind,
    executable,
    args: Object.freeze([...args]),
    cwd,
  });
}

export function assertDailyPlanSafe(plan) {
  if (!DAILY_ACTIONS.includes(plan.action)) return plan;
  const forbidden = plan.steps.find(
    (step) => step.kind === 'dependency-install' || step.kind === 'release-package',
  );
  if (forbidden) {
    throw developmentError(
      'DEV_IMPLICIT_BOOTSTRAP_FORBIDDEN',
      `${plan.action} may not execute ${forbidden.id}`,
    );
  }
  return plan;
}

function cepSteps(paths, { bootstrap }) {
  const steps = [];
  if (bootstrap) {
    steps.push(
      processStep(
        'host-npm-ci', 'cep', 'dependency-install',
        paths.npm, ['ci'], paths.hostRoot,
      ),
      processStep(
        'sidecar-npm-ci', 'cep', 'dependency-install',
        paths.npm, ['ci'], paths.sidecarRoot,
      ),
      processStep(
        'panel-npm-ci', 'cep', 'dependency-install',
        paths.npm, ['ci'], paths.panelRoot,
      ),
    );
  }
  steps.push(
    processStep(
      'cep-panel-build', 'cep', 'build',
      paths.node, ['build.mjs'], paths.panelRoot,
    ),
    processStep(
      'cep-development-install', 'cep', 'development-install',
      '/bin/bash', [paths.cepInstaller], paths.repoRoot,
    ),
  );
  return steps;
}

function nativeSteps(paths) {
  return [
    processStep(
      'native-build', 'native', 'build',
      paths.node,
      [
        paths.nativeBuilder,
        '--sdk-archive', paths.sdkArchive,
        '--sdk-root', paths.sdkRoot,
        '--output', paths.nativeOutput,
      ],
      paths.repoRoot,
    ),
    processStep(
      'native-development-install', 'native', 'development-install',
      paths.node,
      [
        paths.nativeInstaller,
        'install', '--artifact-dir', paths.nativeOutput,
        '--profile', 'development',
      ],
      paths.repoRoot,
    ),
  ];
}

export function buildDevelopmentPlan(command, paths) {
  const steps = [];
  const actions = [];
  const bootstrap = command.action === 'bootstrap';
  const reused = COMPONENTS.filter((component) => !command.components.includes(component));

  if (command.action === 'sync' || bootstrap) {
    for (const component of command.components) {
      if (component === 'core') {
        if (bootstrap) {
          steps.push(processStep(
            'core-uv-sync', 'core', 'dependency-install',
            paths.uv, ['sync', '--all-packages', '--group', 'dev'], paths.repoRoot,
          ));
        }
        actions.push(Object.freeze({
          component: 'core',
          action: 'restart-mcp-session',
          reason: 'live checkout requires no copy or RuntimeManager generation',
        }));
      } else if (component === 'cep') {
        steps.push(...cepSteps(paths, { bootstrap }));
      } else if (component === 'native') {
        steps.push(...nativeSteps(paths));
      }
    }
  }

  const plan = Object.freeze({
    schemaVersion: 1,
    profile: 'development',
    action: command.action,
    components: Object.freeze([...command.components]),
    reused: Object.freeze(reused),
    steps: Object.freeze(steps),
    actions: Object.freeze(actions),
    dependencyBootstrapInvocations: steps.filter(
      (step) => step.kind === 'dependency-install',
    ).length,
    releasePackagingInvocations: steps.filter(
      (step) => step.kind === 'release-package',
    ).length,
  });
  return assertDailyPlanSafe(plan);
}
