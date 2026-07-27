import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DAILY_ACTIONS,
  developmentError,
} from './profile-contract.mjs';

const execFileAsync = promisify(childProcess.execFile);
const CORE_IMPORT_PROBE = [
  'import pathlib,sys',
  'sys.path.insert(0,sys.argv[1])',
  'sys.path.insert(0,sys.argv[2])',
  'import ae_mcp,ae_mcp_bridge',
  'print(pathlib.Path(ae_mcp.__file__).resolve())',
  'print(pathlib.Path(ae_mcp_bridge.__file__).resolve())',
].join(';');

function frozenCheck(id, ok, pathValue, code, details = {}) {
  return Object.freeze({
    id,
    ok,
    path: pathValue,
    ...(ok ? {} : { code }),
    ...details,
  });
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function ordinaryPath(dependencies, target, {
  directory = false,
  executable = false,
  allowSymlink = false,
} = {}) {
  const linkInfo = await dependencies.fs.lstat(target);
  if (linkInfo.isSymbolicLink() && !allowSymlink) throw new Error('symbolic path refused');
  const resolved = await dependencies.realpath(target);
  const info = linkInfo.isSymbolicLink()
    ? await dependencies.fs.stat(resolved)
    : linkInfo;
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error(directory ? 'not a directory' : 'not a file');
  }
  if (executable && (info.mode & 0o111) === 0) throw new Error('not executable');
  return resolved;
}

async function inspectPath(checks, dependencies, {
  id,
  target,
  code,
  directory = false,
  executable = false,
  allowSymlink = false,
  preservePath = false,
  absent = false,
}) {
  if (absent) {
    try {
      await dependencies.fs.lstat(target);
      checks.push(frozenCheck(id, false, target, code));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        checks.push(frozenCheck(id, true, target));
      } else {
        checks.push(frozenCheck(id, false, target, code));
      }
    }
    return target;
  }
  try {
    const resolved = await ordinaryPath(
      dependencies,
      target,
      { directory, executable, allowSymlink },
    );
    const reported = preservePath ? target : resolved;
    checks.push(frozenCheck(
      id,
      true,
      reported,
      undefined,
      preservePath ? { resolvedPath: resolved } : {},
    ));
    return reported;
  } catch {
    checks.push(frozenCheck(id, false, target, code));
    return target;
  }
}

async function plistValue(dependencies, infoPlist, key) {
  const result = await dependencies.execFile(
    '/usr/bin/plutil',
    ['-extract', key, 'raw', infoPlist],
    { shell: false, encoding: 'utf8' },
  );
  const value = String(result.stdout || '').trim();
  if (!value || value.includes('/') || value.includes('\0')) {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

async function inspectRequiredPaths({
  checkoutPath,
  home,
  formalAeApp,
  components,
  environment,
  dependencies,
}) {
  const checks = [];
  const manifest = path.join(checkoutPath, 'pyproject.toml');
  let checkoutOk = false;
  try {
    await ordinaryPath(dependencies, checkoutPath, { directory: true });
    await ordinaryPath(dependencies, manifest);
    checkoutOk = true;
  } catch {
    // The closed check below carries the only public diagnostic for this boundary.
  }
  checks.push(frozenCheck(
    'checkout',
    checkoutOk,
    checkoutPath,
    'DEV_CHECKOUT_INVALID',
  ));

  const coreRoot = path.join(checkoutPath, 'packages', 'core');
  const bridgeRoot = path.join(checkoutPath, 'packages', 'bridge');
  const coreEntrypoint = path.join(coreRoot, 'ae_mcp', '__main__.py');
  await inspectPath(checks, dependencies, {
    id: 'core-entrypoint',
    target: coreEntrypoint,
    code: 'DEV_CORE_ENTRYPOINT_MISSING',
  });
  const interpreterCandidate = path.join(checkoutPath, '.venv', 'bin', 'python3');
  const interpreterPath = await inspectPath(checks, dependencies, {
    id: 'core-interpreter',
    target: interpreterCandidate,
    code: 'DEV_CORE_INTERPRETER_MISSING',
    executable: true,
    allowSymlink: true,
    preservePath: true,
  });
  const interpreterCheck = checks.at(-1);
  if (interpreterCheck.ok) {
    try {
      const result = await dependencies.execFile(
        interpreterPath,
        ['-B', '-I', '-c', CORE_IMPORT_PROBE, coreRoot, bridgeRoot],
        {
          cwd: checkoutPath,
          env: environment,
          shell: false,
          encoding: 'utf8',
        },
      );
      const importedPaths = String(result.stdout || '').trim().split(/\r?\n/);
      if (importedPaths.length !== 2) throw new Error('import probe was incomplete');
      const canonicalImported = await dependencies.realpath(importedPaths[0]);
      const canonicalBridge = await dependencies.realpath(importedPaths[1]);
      if (!inside(canonicalImported, coreRoot)
          || !inside(canonicalBridge, bridgeRoot)) {
        throw new Error('import escaped checkout');
      }
      checks.push(frozenCheck(
        'core-import',
        true,
        canonicalImported,
        undefined,
        { interpreterPath, bridgePath: canonicalBridge },
      ));
    } catch {
      checks.push(frozenCheck(
        'core-import',
        false,
        coreRoot,
        'DEV_CORE_IMPORT_FAILED',
        { interpreterPath },
      ));
    }
  } else {
    checks.push(frozenCheck(
      'core-import',
      true,
      coreRoot,
      undefined,
      { skipped: true, reason: 'core-interpreter unavailable' },
    ));
  }

  const cepRootCandidate = path.join(
    home,
    'Library',
    'Application Support',
    'Adobe',
    'CEP',
    'extensions',
    'com.aemcp.panel',
  );
  let cepRoot = cepRootCandidate;
  try {
    cepRoot = await dependencies.realpath(cepRootCandidate);
  } catch {
    // The marker check below reports an absent install without creating it.
  }
  await inspectPath(checks, dependencies, {
    id: 'cep-development-marker',
    target: path.join(cepRoot, '.debug'),
    code: 'DEV_CEP_MARKER_MISSING',
  });
  await inspectPath(checks, dependencies, {
    id: 'cep-release-manifest-absent',
    target: path.join(cepRoot, 'bundle-manifest.json'),
    code: 'DEV_CEP_RELEASE_MANIFEST_PRESENT',
    absent: true,
  });

  let canonicalApp = formalAeApp;
  let appOk = false;
  try {
    canonicalApp = await ordinaryPath(dependencies, formalAeApp, { directory: true });
    appOk = true;
  } catch {
    // Reported in the formal app check.
  }
  checks.push(frozenCheck(
    'formal-ae-app',
    appOk,
    canonicalApp,
    'DEV_FORMAL_AE_APP_INVALID',
  ));

  let formalAeExecutable = path.join(canonicalApp, 'Contents', 'MacOS', 'After Effects');
  if (appOk) {
    const infoPlist = path.join(canonicalApp, 'Contents', 'Info.plist');
    try {
      await ordinaryPath(dependencies, infoPlist);
      const [executableName, productVersion, buildVersion] = await Promise.all([
        plistValue(dependencies, infoPlist, 'CFBundleExecutable'),
        plistValue(dependencies, infoPlist, 'CFBundleShortVersionString'),
        plistValue(dependencies, infoPlist, 'CFBundleVersion'),
      ]);
      formalAeExecutable = path.join(canonicalApp, 'Contents', 'MacOS', executableName);
      const canonicalExecutable = await ordinaryPath(
        dependencies,
        formalAeExecutable,
        { executable: true },
      );
      if (!inside(canonicalExecutable, canonicalApp)) throw new Error('executable escaped app');
      formalAeExecutable = canonicalExecutable;
      checks.push(frozenCheck(
        'formal-ae-executable',
        true,
        canonicalExecutable,
        undefined,
        { productVersion, buildVersion },
      ));
    } catch {
      checks.push(frozenCheck(
        'formal-ae-executable',
        false,
        formalAeExecutable,
        'DEV_FORMAL_AE_EXECUTABLE_INVALID',
      ));
    }
  } else {
    checks.push(frozenCheck(
      'formal-ae-executable',
      true,
      formalAeExecutable,
      undefined,
      { skipped: true, reason: 'formal AE app unavailable' },
    ));
  }

  if (components.includes('cep')) {
    for (const packageName of ['host', 'sidecar', 'panel']) {
      await inspectPath(checks, dependencies, {
        id: `cep-${packageName}-dependencies`,
        target: path.join(checkoutPath, 'plugin', packageName, 'node_modules'),
        code: 'DEV_CEP_DEPENDENCIES_MISSING',
        directory: true,
      });
    }
  }
  if (components.includes('native')) {
    await inspectPath(checks, dependencies, {
      id: 'native-sdk-archive',
      target: environment.AE_MCP_SDK_ARCHIVE || '',
      code: 'DEV_NATIVE_SDK_ARCHIVE_MISSING',
    });
    await inspectPath(checks, dependencies, {
      id: 'native-sdk-root',
      target: environment.AE_MCP_SDK_ROOT || '',
      code: 'DEV_NATIVE_SDK_ROOT_MISSING',
      directory: true,
    });
  }

  return checks;
}

export function createDefaultMacosDependencies() {
  const execFile = (file, args, options = {}) => execFileAsync(file, args, options);
  const runInteractive = (file, args, options = {}) => new Promise(
    (resolve, reject) => {
      const child = childProcess.spawn(file, args, {
        ...options,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = signal ? `signal ${signal}` : `exit ${code}`;
        reject(new Error(`interactive process failed with ${detail}`));
      });
    },
  );
  return Object.freeze({
    fs: fs.promises,
    realpath: fs.promises.realpath.bind(fs.promises),
    execFile,
    runInteractive,
    spawn: childProcess.spawn,
    processInspector: Object.freeze({
      async afterEffectsRunning() {
        try {
          await execFile('/usr/bin/pgrep', ['-f', 'Adobe After Effects|AfterFX'], {
            shell: false,
            encoding: 'utf8',
          });
          return true;
        } catch (error) {
          if (error?.code === 1) return false;
          throw developmentError(
            'DEV_AE_PROCESS_INSPECTION_FAILED',
            'could not determine whether formal After Effects is running',
          );
        }
      },
    }),
  });
}

export async function inspectDevelopmentEnvironment({
  repoRoot,
  home,
  formalAeApp,
  components = ['core'],
  environment = process.env,
  dependencies = createDefaultMacosDependencies(),
}) {
  const merged = {
    ...createDefaultMacosDependencies(),
    ...dependencies,
    fs: dependencies.fs || fs.promises,
    realpath: dependencies.realpath || fs.promises.realpath.bind(fs.promises),
  };
  let checkoutPath = repoRoot;
  try {
    checkoutPath = await merged.realpath(repoRoot);
  } catch {
    // The closed checkout check reports the invalid root.
  }
  const checks = await inspectRequiredPaths({
    checkoutPath,
    home,
    formalAeApp,
    components,
    environment,
    dependencies: merged,
  });
  const blockers = checks.filter((check) => check.ok === false);
  return Object.freeze({
    schemaVersion: 1,
    profile: 'development',
    ok: blockers.length === 0,
    checkoutPath,
    interpreterPath: checks.find((check) => check.id === 'core-interpreter').path,
    formalAeApp: checks.find((check) => check.id === 'formal-ae-app').path,
    formalAeExecutable: checks.find((check) => check.id === 'formal-ae-executable').path,
    checks: Object.freeze(checks),
    blockers: Object.freeze(blockers),
  });
}

export async function launchDevelopmentAe(report, {
  processInspector,
  spawn,
  environment = process.env,
  now = () => new Date(),
}) {
  if (!report?.ok || report.profile !== 'development') {
    throw developmentError(
      'DEV_DOCTOR_BLOCKED',
      'development environment must pass doctor before launch',
    );
  }
  if (await processInspector.afterEffectsRunning()) {
    throw developmentError(
      'DEV_AE_ALREADY_RUNNING',
      'formal After Effects is already running',
    );
  }
  const child = spawn(report.formalAeExecutable, [], {
    cwd: path.dirname(report.formalAeExecutable),
    detached: true,
    stdio: 'ignore',
    shell: false,
    env: { ...environment, AE_MCP_DEV_RUNTIME: report.checkoutPath },
  });
  child.unref();
  return Object.freeze({
    schemaVersion: 1,
    profile: 'development',
    pid: child.pid,
    formalAeExecutable: report.formalAeExecutable,
    checkoutPath: report.checkoutPath,
    launchedAt: now().toISOString(),
  });
}

export async function executeDevelopmentPlan(plan, {
  execFile = createDefaultMacosDependencies().execFile,
  runInteractive = createDefaultMacosDependencies().runInteractive,
  environment = process.env,
} = {}) {
  if (DAILY_ACTIONS.includes(plan.action)
      && (plan.dependencyBootstrapInvocations !== 0
        || plan.steps.some((step) => step.kind === 'dependency-install'))) {
    throw developmentError(
      'DEV_IMPLICIT_BOOTSTRAP_FORBIDDEN',
      `${plan.action} may not install dependencies`,
    );
  }
  if (DAILY_ACTIONS.includes(plan.action)
      && (plan.releasePackagingInvocations !== 0
        || plan.steps.some((step) => step.kind === 'release-package'))) {
    throw developmentError(
      'DEV_RELEASE_PACKAGING_FORBIDDEN',
      `${plan.action} may not create release packages`,
    );
  }

  const stepReceipts = [];
  for (const step of plan.steps) {
    try {
      const executeStep = step.kind === 'public-smoke'
        ? runInteractive
        : execFile;
      await executeStep(step.executable, step.args, {
        cwd: step.cwd,
        env: environment,
        shell: false,
        encoding: 'utf8',
      });
      stepReceipts.push(Object.freeze({
        id: step.id,
        component: step.component,
        kind: step.kind,
        exitCode: 0,
      }));
    } catch (error) {
      throw developmentError(
        'DEV_STEP_FAILED',
        `development step ${step.id} failed`,
        {
          stepId: step.id,
          privateReceipt: {
            executable: step.executable,
            args: [...step.args],
            cwd: step.cwd,
            cause: String(error?.message || error),
          },
        },
      );
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    profile: 'development',
    action: plan.action,
    components: [...plan.components],
    steps: Object.freeze(stepReceipts),
    actions: Object.freeze([...(plan.actions || [])]),
    dependencyBootstrapInvocations: plan.dependencyBootstrapInvocations,
    releasePackagingInvocations: plan.releasePackagingInvocations,
  });
}
