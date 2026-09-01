import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWindowsAdapter } from '../src/cep/platform/windows.js';

function adapterFor(steps) {
  const calls = [];
  const adapter = createWindowsAdapter({
    platform: 'win32',
    arch: 'x64',
    pid: 1,
    home: 'C:\\Users\\a',
    temp: 'C:\\Temp',
    env: { SystemRoot: 'C:\\Windows' },
    extensionRoot: 'C:\\Extension',
    fs: {},
    now: () => 0,
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const step = steps.shift() || {};
      queueMicrotask(() => {
        if (step.stdout) child.stdout.emit('data', step.stdout);
        if (step.stderr) child.stderr.emit('data', step.stderr);
        if (step.error) child.emit('error', step.error);
        else child.emit('close', step.code ?? 0);
      });
      return child;
    },
  });
  return Object.assign(Object.create(adapter), { calls });
}

test('readUserPath parses REG_SZ values', async () => {
  const adapter = adapterFor([
    { stdout: '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\Tools;C:\\Other\r\n' },
  ]);

  assert.deepEqual(await adapter.readUserPath(), {
    value: 'C:\\Tools;C:\\Other',
    type: 'REG_SZ',
  });
});

test('readUserPath parses REG_EXPAND_SZ values and defaults missing values', async () => {
  const expanded = adapterFor([
    { stdout: '    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin\r\n' },
  ]);
  assert.deepEqual(await expanded.readUserPath(), {
    value: '%USERPROFILE%\\.local\\bin',
    type: 'REG_EXPAND_SZ',
  });

  const missing = adapterFor([{ code: 1, stderr: 'ERROR: The system was unable to find the specified registry key.' }]);
  assert.deepEqual(await missing.readUserPath(), { value: '', type: 'REG_EXPAND_SZ' });
});

test('addUserPathEntry deduplicates case-insensitively and ignores trailing slashes', async () => {
  const adapter = adapterFor([
    { stdout: '    Path    REG_SZ    C:\\Tools\\;C:\\Other\r\n' },
  ]);

  assert.deepEqual(await adapter.addUserPathEntry('c:/tools'), { changed: false });
  assert.equal(adapter.calls.length, 1);
});

test('addUserPathEntry preserves type, raw variables, semicolon joining, and broadcasts', async () => {
  const adapter = adapterFor([
    { stdout: '    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools\r\n' },
    {},
    {},
  ]);

  assert.equal(
    adapter.userPathIncludes('%USERPROFILE%\\.local\\bin', 'C:\\Users\\a\\.local\\bin'),
    true,
  );
  assert.deepEqual(await adapter.addUserPathEntry('C:\\New Tools'), { changed: true });
  assert.equal(adapter.calls.length, 3);
  assert.match(adapter.calls[0].file, /System32\\reg\.exe$/i);
  assert.deepEqual(adapter.calls[0].args, ['query', 'HKCU\\Environment', '/v', 'Path']);
  assert.match(adapter.calls[1].file, /System32\\reg\.exe$/i);
  assert.deepEqual(adapter.calls[1].args, [
    'add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ',
    '/d', '%USERPROFILE%\\.local\\bin;C:\\Tools;C:\\New Tools', '/f',
  ]);
  assert.match(adapter.calls[2].file, /powershell\.exe$/i);
  assert.equal(adapter.calls[2].args[0], '-NoProfile');
  assert.equal(adapter.calls[2].args[1], '-Command');
  assert.match(adapter.calls[2].args[2], /HWND_BROADCAST/);
  assert.match(adapter.calls[2].args[2], /WM_SETTINGCHANGE/);
  assert.match(adapter.calls[2].args[2], /SMTO_ABORTIFHUNG/);
  assert.match(adapter.calls[2].args[2], /SendMessageTimeout/);
  assert.equal(adapter.calls.some((call) => call.args.some((arg) => /setx/i.test(arg))), false);
});

test('broadcast failure does not turn a completed user PATH write into a failure', async () => {
  const adapter = adapterFor([
    { stdout: '    Path    REG_SZ    C:\\Tools\r\n' },
    {},
    { code: 1, stderr: 'broadcast failed' },
  ]);

  assert.deepEqual(await adapter.addUserPathEntry('C:\\New'), { changed: true });
});
