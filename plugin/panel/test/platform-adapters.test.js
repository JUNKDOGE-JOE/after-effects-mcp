import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacosAdapter } from '../src/cep/platform/macos.js';
import { createWindowsAdapter } from '../src/cep/platform/windows.js';

function makeProc(result, calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const listeners = {};
    const stream = () => ({ on(event, handler) { listeners[event] = handler; } });
    const proc = {
      stdout: stream(), stderr: stream(), stdin: { end() {} },
      on(event, handler) { listeners['proc:' + event] = handler; },
      kill() {},
    };
    queueMicrotask(() => {
      if (result.stdout && listeners.data) listeners.data(Buffer.from(result.stdout));
      listeners['proc:exit']?.(result.code ?? 0, null);
      listeners['proc:close']?.(result.code ?? 0, null);
    });
    return proc;
  };
}

test('reveal and login-terminal operations are represented as bounded platform process requests', async () => {
  const macCalls = [];
  const mac = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: {},
    fs: { existsSync: () => true, realpathSync: (v) => v, statSync: () => ({ isFile: () => true }), accessSync() {} },
    spawnImpl: makeProc({}, macCalls), now: () => 0,
  });
  await mac.revealFile('/Users/a/log file.txt');
  await mac.openLoginTerminal('codex');
  assert.deepEqual(macCalls[0].args, ['-R', '/Users/a/log file.txt']);
  assert.equal(macCalls[0].options.shell, false);
  assert.equal(macCalls[1].file, '/usr/bin/osascript');
  assert.match(macCalls[1].args.join(' '), /codex login/);

  const winCalls = [];
  const win = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: {},
    fs: { existsSync: () => true, realpathSync: (v) => v, statSync: () => ({ isFile: () => true }), accessSync() {} },
    spawnImpl: makeProc({}, winCalls), now: () => 0,
  });
  await win.revealFile('C:\\Users\\a\\log file.txt');
  assert.equal(winCalls[0].file.toLowerCase().endsWith('explorer.exe'), true);
  assert.deepEqual(winCalls[0].args, ['/select,', 'C:\\Users\\a\\log file.txt']);
  assert.equal(winCalls[0].options.shell, false);

  await win.openLoginTerminal('claude');
  assert.deepEqual(winCalls[1].args, ['/d', '/s', '/c', 'start', '', 'claude']);
});

test('spawn always composes a resolved prefix with caller arguments and shell false', () => {
  const calls = [];
  const mac = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: {}, fs: { existsSync: () => false },
    spawnImpl: makeProc({}, calls), now: () => 0,
  });
  mac.spawn({ ok: true, id: 'codex', path: '/bin/wrapper', argsPrefix: ['fixed'], source: 'standard', version: null, arch: null }, ['probe'], { cwd: '/tmp' });
  assert.deepEqual(calls[0].args, ['fixed', 'probe']);
  assert.equal(calls[0].options.shell, false);
});

test('Windows adapter operations look up SystemRoot case-insensitively', async () => {
  const calls = [];
  const win = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { systemroot: 'D:\\Windows' },
    fs: { existsSync: () => false }, spawnImpl: makeProc({}, calls), now: () => 0,
  });

  await win.revealFile('C:\\Users\\a\\log.txt');

  assert.equal(calls[0].file, 'D:\\Windows\\explorer.exe');
});
