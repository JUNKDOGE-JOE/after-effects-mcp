import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacosAdapter } from '../src/cep/platform/macos.js';
import { createWindowsAdapter } from '../src/cep/platform/windows.js';

function makeProc(result, calls) {
  return (file, args, options) => {
    const current = Array.isArray(result) ? (result[calls.length] || {}) : result;
    calls.push({ file, args, options });
    const listeners = {};
    const stdoutListeners = {};
    const stderrListeners = {};
    const stream = (target) => ({ on(event, handler) { target[event] = handler; } });
    const proc = {
      stdout: stream(stdoutListeners), stderr: stream(stderrListeners), stdin: { end() {} },
      on(event, handler) { listeners['proc:' + event] = handler; },
      kill() {},
    };
    queueMicrotask(() => {
      if (current.stdout && stdoutListeners.data) stdoutListeners.data(Buffer.from(current.stdout));
      if (current.stderr && stderrListeners.data) stderrListeners.data(Buffer.from(current.stderr));
      listeners['proc:exit']?.(current.code ?? 0, null);
      listeners['proc:close']?.(current.code ?? 0, null);
    });
    return proc;
  };
}

function makeResultProc(results, calls) {
  let index = 0;
  return (file, args, options) => {
    calls.push({ file, args, options });
    const result = results[Math.min(index, results.length - 1)] || {};
    index += 1;
    const listeners = {};
    const stdout = { on(event, handler) { listeners['stdout:' + event] = handler; } };
    const stderr = { on(event, handler) { listeners['stderr:' + event] = handler; } };
    const proc = {
      stdout,
      stderr,
      stdin: { end() {} },
      on(event, handler) { listeners['proc:' + event] = handler; },
      kill() {},
    };
    queueMicrotask(() => {
      if (result.stdout) listeners['stdout:data']?.(Buffer.from(result.stdout));
      if (result.stderr) listeners['stderr:data']?.(Buffer.from(result.stderr));
      listeners['proc:exit']?.(result.code ?? 0, null);
      listeners['proc:close']?.(result.code ?? 0, null);
    });
    return proc;
  };
}

test('Windows processAlive checks tasklist CSV output without throwing', async () => {
  const calls = [];
  const win = createWindowsAdapter({
    platform: 'win32', arch: 'x64', pid: 4001, home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { SystemRoot: 'D:\\Windows' }, fs: { existsSync: () => false },
    spawnImpl: makeResultProc([
      { stdout: '"opencode.exe","42","Console","1","10 K"\r\n' },
      { stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' },
    ], calls),
    now: () => 0,
  });

  assert.equal(win.pid, 4001);
  assert.equal(await win.processAlive({ pid: 42 }), true);
  assert.equal(await win.processAlive({ pid: 43 }), false);
  assert.equal(await win.processAlive({ pid: 0 }), false);
  assert.equal(calls[0].file, 'D:\\Windows\\System32\\tasklist.exe');
  assert.deepEqual(calls[0].args, ['/FI', 'PID eq 42', '/FO', 'CSV', '/NH']);
  assert.equal(calls.length, 2);
});

test('macOS processAlive checks ps pid output without throwing', async () => {
  const calls = [];
  const mac = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', pid: 4002, home: '/Users/a', temp: '/tmp', env: {},
    fs: { existsSync: () => false },
    spawnImpl: makeResultProc([
      { stdout: ' 42\n' },
      { stdout: '', code: 1 },
    ], calls),
    now: () => 0,
  });

  assert.equal(mac.pid, 4002);
  assert.equal(await mac.processAlive({ pid: 42 }), true);
  assert.equal(await mac.processAlive({ pid: 43 }), false);
  assert.equal(await mac.processAlive({ pid: -1 }), false);
  assert.equal(calls[0].file, '/bin/ps');
  assert.deepEqual(calls[0].args, ['-p', '42', '-o', 'pid=']);
  assert.equal(calls.length, 2);
});

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

test('Windows termination verifies the image before invoking taskkill', async () => {
  const create = (results) => {
    const calls = [];
    const adapter = createWindowsAdapter({
      platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
      env: { systemroot: 'D:\\Windows' }, fs: { existsSync: () => false },
      spawnImpl: makeProc(results, calls), now: () => 0,
    });
    return { adapter, calls };
  };

  const matched = create([
    { stdout: '"opencode.exe","321","Console","1","12 K"\r\n' },
    { code: 0 },
  ]);
  assert.deepEqual(await matched.adapter.terminateProcess({ pid: 321, executableName: 'opencode' }), {
    ok: true, matched: true, killed: true, detail: 'terminated',
  });
  assert.equal(matched.calls[0].file, 'D:\\Windows\\System32\\tasklist.exe');
  assert.deepEqual(matched.calls[0].args, ['/FI', 'PID eq 321', '/FO', 'CSV', '/NH']);
  assert.equal(matched.calls[1].file, 'D:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(matched.calls[1].args, ['/PID', '321', '/T', '/F']);

  const reused = create([{ stdout: '"AfterFX.exe","321","Console","1","12 K"\r\n' }]);
  assert.deepEqual(await reused.adapter.terminateProcess({ pid: 321, executableName: 'opencode' }), {
    ok: true, matched: false, killed: false, detail: 'pid reused by AfterFX.exe',
  });
  assert.equal(reused.calls.length, 1);

  const missing = create([{ stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' }]);
  assert.equal((await missing.adapter.terminateProcess({ pid: 321, executableName: 'opencode' })).matched, false);
  assert.equal(missing.calls.length, 1);
  assert.equal((await missing.adapter.terminateProcess({ pid: 0, executableName: 'opencode' })).detail, 'invalid pid');
});

test('macOS termination verifies the command basename before sending SIGKILL', async () => {
  const create = (results) => {
    const calls = [];
    const adapter = createMacosAdapter({
      platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: {},
      fs: { existsSync: () => false }, spawnImpl: makeProc(results, calls), now: () => 0,
    });
    return { adapter, calls };
  };

  const matched = create([{ stdout: '/opt/homebrew/bin/opencode\n' }, { code: 0 }]);
  assert.equal((await matched.adapter.terminateProcess({ pid: 42, executableName: 'opencode' })).killed, true);
  assert.equal(matched.calls[0].file, '/bin/ps');
  assert.deepEqual(matched.calls[0].args, ['-p', '42', '-o', 'comm=']);
  assert.equal(matched.calls[1].file, '/bin/kill');
  assert.deepEqual(matched.calls[1].args, ['-9', '42']);

  const reused = create([{ stdout: '/Applications/AfterFX\n' }]);
  assert.match((await reused.adapter.terminateProcess({ pid: 42, executableName: 'opencode' })).detail, /pid reused/);
  assert.equal(reused.calls.length, 1);

  const missing = create([{ stdout: '' }]);
  assert.equal((await missing.adapter.terminateProcess({ pid: 42, executableName: 'opencode' })).matched, false);
  assert.equal(missing.calls.length, 1);
});
