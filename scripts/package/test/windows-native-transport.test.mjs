import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const SOURCES = Object.freeze([
  'native/ae-plugin/src/platform/windows/endpoint_registry_windows.cpp',
  'native/ae-plugin/src/platform/windows/win_ipc_server.cpp',
  'native/ae-plugin/src/platform/windows/transport_io_windows.cpp',
  'native/ae-plugin/src/platform/windows/secure_random_windows.cpp',
  'native/ae-plugin/src/core/transport_auth.cpp',
  'native/ae-plugin/tests/win_ipc_server_windows_test.cpp',
]);

function responseArgument(argument) {
  return /[\s"]/u.test(argument)
    ? `"${argument.replaceAll('"', '\\"')}"`
    : argument;
}

function findVisualStudio() {
  const programFilesX86 = process.env['ProgramFiles(x86)']
    ?? 'C:\\Program Files (x86)';
  const vswhere = path.join(
    programFilesX86,
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  assert.ok(fs.existsSync(vswhere), 'vswhere.exe is required on the Windows runner');
  const installation = execFileSync(vswhere, [
    '-latest',
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
  assert.ok(installation, 'Visual Studio with the x64 C++ toolchain is required');
  const vcvars64 = path.join(
    installation,
    'VC',
    'Auxiliary',
    'Build',
    'vcvars64.bat',
  );
  assert.ok(fs.existsSync(vcvars64), 'vcvars64.bat is required on the Windows runner');
  return vcvars64;
}

test(
  'Windows native transport compiles and passes the real named-pipe lifecycle test',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const temporary = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'ae-mcp-native-transport-'),
    );
    t.after(() => fs.promises.rm(temporary, { force: true, recursive: true }));
    const executable = path.join(temporary, 'win-ipc-server-test.exe');
    const responseFile = path.join(temporary, 'compile.rsp');
    const argumentsList = [
      '/nologo',
      '/std:c++20',
      '/EHsc',
      '/W4',
      '/WX',
      '/utf-8',
      // Keep the CRT model in lockstep with the shipped AEX (build-windows.mjs
      // compiles /MT for the AE 2023/2024 host-runtime baseline) so this
      // lifecycle test exercises the same runtime configuration users receive.
      '/MT',
      '/permissive-',
      '/DWIN32',
      '/D_WINDOWS',
      '/DUNICODE',
      '/D_UNICODE',
      '/DNOMINMAX',
      '/D_CRT_SECURE_NO_WARNINGS',
      `/I${path.join(REPO_ROOT, 'native', 'ae-plugin', 'include')}`,
      `/I${path.join(REPO_ROOT, 'native', 'ae-plugin', 'src', 'platform', 'windows')}`,
      ...SOURCES.map((source) => path.join(REPO_ROOT, source)),
      `/Fe:${executable}`,
      'advapi32.lib',
      'bcrypt.lib',
    ];
    await fs.promises.writeFile(
      responseFile,
      `${argumentsList.map(responseArgument).join('\r\n')}\r\n`,
      { flag: 'wx' },
    );

    const vcvars64 = findVisualStudio();
    const commandFile = path.join(temporary, 'compile.cmd');
    await fs.promises.writeFile(
      commandFile,
      `@echo off\r\ncall "${vcvars64}" >nul\r\n`
        + 'if errorlevel 1 exit /b %errorlevel%\r\n'
        + `cl.exe @"${responseFile}"\r\n`,
      { flag: 'wx' },
    );
    execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/c', path.basename(commandFile)],
      {
        cwd: temporary,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        windowsHide: true,
      },
    );
    const output = execFileSync(executable, [], {
      cwd: temporary,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
    });
    assert.match(output, /win_ipc_server_windows_test: PASS/u);
  },
);
