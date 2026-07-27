#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildDevelopmentPlan,
  parseDevelopmentCommand,
} from './profile-contract.mjs';
import {
  createDefaultMacosDependencies,
  executeDevelopmentPlan,
  inspectDevelopmentEnvironment,
  launchDevelopmentAe,
} from './macos-development.mjs';

function defaultCommandValues() {
  return Object.freeze({
    repoRoot: process.cwd(),
    home: os.homedir(),
    formalAeApp: '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
  });
}

function publicRecovery(error) {
  const recovery = error?.recovery;
  if (!Array.isArray(recovery)) return undefined;
  return recovery.map((item) => ({
    id: item.id,
    code: item.code,
  }));
}

function failed(error) {
  const code = typeof error?.code === 'string' ? error.code : 'DEV_COMMAND_FAILED';
  return Object.freeze({
    exitCode: code === 'DEV_ARGUMENT_INVALID' ? 2 : 1,
    output: Object.freeze({
      ok: false,
      error: Object.freeze({
        code,
        message: String(error?.message || 'development command failed'),
        ...(publicRecovery(error) ? { recovery: publicRecovery(error) } : {}),
      }),
    }),
  });
}

function planPaths(command, report, dependencies, nativeOutput) {
  const commands = dependencies.commands || {};
  return Object.freeze({
    repoRoot: command.repoRoot,
    uv: commands.uv || 'uv',
    npm: commands.npm || 'npm',
    node: commands.node || process.execPath,
    python: report.interpreterPath,
    hostRoot: path.join(command.repoRoot, 'plugin', 'host'),
    sidecarRoot: path.join(command.repoRoot, 'plugin', 'sidecar'),
    panelRoot: path.join(command.repoRoot, 'plugin', 'panel'),
    cepInstaller: path.join(command.repoRoot, 'scripts', 'install-plugin-dev-macos.sh'),
    nativeBuilder: path.join(command.repoRoot, 'native', 'ae-plugin', 'build-macos.mjs'),
    nativeInstaller: path.join(
      command.repoRoot,
      'native',
      'ae-plugin',
      'install-dev-macos.mjs',
    ),
    nativeOutput,
    sdkArchive: command.sdkArchive
      || dependencies.environment?.AE_MCP_SDK_ARCHIVE,
    sdkRoot: command.sdkRoot || dependencies.environment?.AE_MCP_SDK_ROOT,
    developmentSmoke: path.join(
      command.repoRoot,
      'scripts',
      'hardware',
      'development_smoke.py',
    ),
  });
}

function executionResult(plan, receipt) {
  return Object.freeze({
    selected: [...plan.components],
    reused: [...plan.reused],
    restart: plan.actions
      .filter((item) => item.action === 'restart-mcp-session')
      .map(() => 'mcp-session'),
    steps: [...receipt.steps],
    dependencyBootstrapInvocations: receipt.dependencyBootstrapInvocations,
    releasePackagingInvocations: receipt.releasePackagingInvocations,
  });
}

function replaceableCepInstallState(command, report) {
  if (command.action !== 'sync' || !command.components.includes('cep')) return false;
  const allowed = new Set([
    'DEV_CEP_MARKER_MISSING',
    'DEV_CEP_RELEASE_MANIFEST_PRESENT',
  ]);
  return report.blockers.length > 0
    && report.blockers.every((item) => allowed.has(item.code));
}

export async function main(
  argv = process.argv.slice(2),
  dependencies = createDefaultMacosDependencies(),
) {
  try {
    const defaults = dependencies.defaults || defaultCommandValues();
    const command = parseDevelopmentCommand(argv, defaults);
    const environment = {
      ...(dependencies.environment || process.env),
      ...(command.sdkArchive ? { AE_MCP_SDK_ARCHIVE: command.sdkArchive } : {}),
      ...(command.sdkRoot ? { AE_MCP_SDK_ROOT: command.sdkRoot } : {}),
    };
    const inspect = dependencies.inspectDevelopmentEnvironment
      || inspectDevelopmentEnvironment;
    const report = await inspect({
      repoRoot: command.repoRoot,
      home: command.home,
      formalAeApp: command.formalAeApp,
      components: command.components,
      environment,
      dependencies,
    });
    const replacingCepInstall = replaceableCepInstallState(command, report);
    if (!report.ok && command.action !== 'bootstrap' && !replacingCepInstall) {
      const error = Object.assign(
        new Error('development doctor reported blockers'),
        {
          code: 'DEV_DOCTOR_BLOCKED',
          recovery: report.blockers,
        },
      );
      throw error;
    }

    if (command.action === 'doctor') {
      return Object.freeze({
        exitCode: 0,
        output: Object.freeze({ ok: true, result: report }),
      });
    }
    if (command.action === 'launch-ae') {
      const launch = dependencies.launchDevelopmentAe || launchDevelopmentAe;
      const result = await launch(report, {
        processInspector: dependencies.processInspector,
        spawn: dependencies.spawn,
        environment,
        now: dependencies.now,
      });
      return Object.freeze({
        exitCode: 0,
        output: Object.freeze({ ok: true, result }),
      });
    }

    let nativeOutput;
    if (command.components.includes('native')) {
      const mkdtemp = dependencies.mkdtemp || fs.promises.mkdtemp.bind(fs.promises);
      const buildRoot = await mkdtemp('/private/tmp/ae-mcp-native-dev-');
      nativeOutput = path.join(buildRoot, 'artifact');
    }
    const plan = buildDevelopmentPlan(
      command,
      planPaths(command, report, dependencies, nativeOutput),
    );
    const execute = dependencies.executeDevelopmentPlan || executeDevelopmentPlan;
    const receipt = await execute(plan, {
      execFile: dependencies.execFile,
      runInteractive: dependencies.runInteractive,
      environment,
    });
    if (command.action === 'sync' && command.components.includes('cep')) {
      const postSyncReport = await inspect({
        repoRoot: command.repoRoot,
        home: command.home,
        formalAeApp: command.formalAeApp,
        components: command.components,
        environment,
        dependencies,
      });
      if (!postSyncReport.ok) {
        throw Object.assign(
          new Error('development CEP sync did not pass post-install doctor'),
          {
            code: 'DEV_POST_SYNC_DOCTOR_BLOCKED',
            recovery: postSyncReport.blockers,
          },
        );
      }
    }
    return Object.freeze({
      exitCode: 0,
      output: Object.freeze({
        ok: true,
        result: executionResult(plan, receipt),
      }),
    });
  } catch (error) {
    return failed(error);
  }
}

function cliEntry() {
  main().then((result) => {
    const stream = result.output.ok ? process.stdout : process.stderr;
    stream.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify(failed(error).output)}\n`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliEntry();
}
