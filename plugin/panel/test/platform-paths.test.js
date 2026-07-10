import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacosAdapter } from '../src/cep/platform/macos.js';
import { createWindowsAdapter } from '../src/cep/platform/windows.js';
import { createPlatformAdapter, defaultPlatformDependencies, PlatformCapabilityError } from '../src/cep/platform/index.js';
import * as pathBoundary from '../src/cep/platform/paths.js';

function inertDeps(overrides = {}) {
  return {
    fs: { existsSync: () => false },
    spawnImpl: () => { throw new Error('not expected'); },
    env: {},
    now: () => 0,
    ...overrides,
  };
}

test('path catalog uses native separators and stable runtime locations', () => {
  const mac = createMacosAdapter(inertDeps({ platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/private/tmp' }));
  const win = createWindowsAdapter(inertDeps({ platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp' }));

  assert.equal(mac.paths.runtimeRoot, '/Users/a/.ae-mcp/runtime');
  assert.equal(mac.paths.toolsRoot, '/Users/a/.ae-mcp/tools');
  assert.equal(mac.paths.legacySkillsRoot, '/Users/a/.ae-mcp/skills');
  assert.equal(mac.paths.launcher, '/Users/a/.ae-mcp/bin/ae-mcp');
  assert.equal(mac.paths.currentPointer, '/Users/a/.ae-mcp/runtime/current');
  assert.equal(mac.paths.captureSpool, '/Users/a/.ae-mcp/capture-spool');

  assert.equal(win.paths.runtimeRoot, 'C:\\Users\\a\\.ae-mcp\\runtime');
  assert.equal(win.paths.toolsRoot, 'C:\\Users\\a\\.ae-mcp\\tools');
  assert.equal(win.paths.legacySkillsRoot, 'C:\\Users\\a\\.ae-mcp\\skills');
  assert.equal(win.paths.launcher, 'C:\\Users\\a\\.ae-mcp\\bin\\ae-mcp.exe');
  assert.equal(win.paths.currentPointer, 'C:\\Users\\a\\.ae-mcp\\runtime\\current');
  assert.equal(win.paths.captureSpool, 'C:\\Users\\a\\.ae-mcp\\capture-spool');
});

test('catalog handles spaces and exposes native path and containment operations', () => {
  const mac = createMacosAdapter(inertDeps({ platform: 'darwin', arch: 'arm64', home: '/Users/A Person', temp: '/private/tmp/A Temp' }));
  const win = createWindowsAdapter(inertDeps({ platform: 'win32', arch: 'x64', home: 'D:\\A Person', temp: 'D:\\A Temp' }));

  assert.equal(mac.paths.join(['/Users/A Person', 'a', 'b']), '/Users/A Person/a/b');
  assert.equal(mac.paths.resolve(['/Users/A Person', 'a', '..', 'b']), '/Users/A Person/b');
  assert.equal(mac.paths.dirname('/Users/A Person/b.txt'), '/Users/A Person');
  assert.equal(mac.paths.basename('/Users/A Person/b.txt'), 'b.txt');
  assert.equal(mac.paths.isAbsolute('/Users/A Person/b.txt'), true);
  assert.equal(mac.paths.isAbsolute('../b.txt'), false);
  assert.equal(mac.paths.contains('/Users/A Person/app', '/Users/A Person/app/runtime/node'), true);
  assert.equal(mac.paths.contains('/Users/A Person/app', '/Users/A Person/application'), false);
  assert.equal(mac.paths.contains('/', '/Users/A Person/app'), true);
  assert.equal(mac.paths.same('/Users/A Person/app/../app', '/Users/A Person/app'), true);
  assert.equal(mac.paths.join(['/Users/A Person', 'literal\\name']), '/Users/A Person/literal\\name');
  assert.equal(mac.paths.resolve(['/Users/A Person', 'literal\\name']), '/Users/A Person/literal\\name');
  assert.equal(
    mac.paths.contains('/Users/A Person/literal\\root', '/Users/A Person/literal\\root/child'),
    true,
  );
  assert.equal(
    mac.paths.contains('/Users/A Person/literal\\root', '/Users/A Person/literal/root/child'),
    false,
  );
  assert.equal(mac.paths.same('/Users/A Person/literal\\name', '/Users/A Person/literal\\name'), true);
  assert.equal(win.paths.join(['D:\\A Person', 'a', 'b']), 'D:\\A Person\\a\\b');
  assert.equal(win.paths.resolve(['D:\\A Person', 'a', '..', 'b']), 'D:\\A Person\\b');
  assert.equal(win.paths.dirname('D:\\A Person\\b.txt'), 'D:\\A Person');
  assert.equal(win.paths.basename('D:\\A Person\\b.txt'), 'b.txt');
  assert.equal(win.paths.isAbsolute('D:\\A Person\\b.txt'), true);
  assert.equal(win.paths.isAbsolute('D:relative'), false);
  assert.equal(win.paths.contains('D:\\A Person\\App', 'd:\\a person\\app\\runtime\\node'), true);
  assert.equal(win.paths.contains('D:\\A Person\\App', 'D:\\A Person\\Application'), false);
  assert.equal(win.paths.contains('D:\\', 'D:\\A Person\\App'), true);
  assert.equal(win.paths.same('D:\\A Person\\APP', 'd:\\a person\\app'), true);
});

test('Windows resolve preserves drive roots and handles drive-relative paths explicitly', () => {
  const win = createWindowsAdapter(inertDeps({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
  }));

  assert.equal(win.paths.resolve(['C:\\']), 'C:\\');
  assert.equal(win.paths.resolve(['C:relative']), 'C:\\Users\\a\\relative');
  assert.equal(win.paths.resolve(['C:\\base', 'C:relative']), 'C:\\base\\relative');
  assert.equal(win.paths.resolve(['C:\\base', 'D:relative']), 'D:\\relative');
});

test('Windows resolve keeps a rooted segment on the active UNC share', () => {
  const win = createWindowsAdapter(inertDeps({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
  }));

  assert.equal(
    win.paths.resolve(['\\\\server\\share\\base', '\\root', 'child']),
    '\\\\server\\share\\root\\child',
  );
});

test('adapter selection rejects unsupported or incomplete platform identities', () => {
  assert.equal(createPlatformAdapter(inertDeps({ platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp' })).id, 'macos-arm64');
  assert.equal(createPlatformAdapter(inertDeps({ platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp' })).id, 'windows-x64');
  assert.throws(
    () => createPlatformAdapter(inertDeps({ platform: 'darwin', arch: 'x64', home: '/Users/a', temp: '/tmp' })),
    (error) => error instanceof PlatformCapabilityError && error.code === 'UNSUPPORTED_PLATFORM',
  );
  assert.throws(
    () => createMacosAdapter(inertDeps({ platform: 'darwin', arch: 'arm64', home: '', temp: '/tmp' })),
    /home/i,
  );
});

test('environment completion supplies a stable home and prepends the private bin directory', () => {
  const mac = createMacosAdapter(inertDeps({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: { LANG: 'en_US.UTF-8' },
  }));
  const win = createWindowsAdapter(inertDeps({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { SystemRoot: 'C:\\Windows' },
  }));

  assert.deepEqual(mac.completeSpawnEnv({ PATH: '/usr/bin' }, { EXTRA: 'yes' }), {
    LANG: 'en_US.UTF-8', HOME: '/Users/a', PATH: '/Users/a/.ae-mcp/bin:/usr/bin', EXTRA: 'yes',
  });
  const completed = win.completeSpawnEnv({ Path: 'C:\\Windows\\System32' }, { EXTRA: 'yes' });
  assert.equal(completed.SystemRoot, 'C:\\Windows');
  assert.equal(completed.USERPROFILE, 'C:\\Users\\a');
  assert.equal(completed.HOME, 'C:\\Users\\a');
  assert.equal(completed.Path, 'C:\\Users\\a\\.ae-mcp\\bin;C:\\Windows\\System32');
  assert.equal(completed.APPDATA, 'C:\\Users\\a\\AppData\\Roaming');
  assert.equal(completed.LOCALAPPDATA, 'C:\\Users\\a\\AppData\\Local');
  assert.equal(completed.EXTRA, 'yes');

  const completedAgain = win.completeSpawnEnv(completed);
  assert.equal(completedAgain.Path.split(';').filter((entry) => entry === win.paths.binRoot).length, 1);
});

test('Windows environment completion merges and reads keys case-insensitively', () => {
  const win = createWindowsAdapter(inertDeps({
    platform: 'win32', arch: 'x64', home: 'D:\\Users\\caller', temp: 'D:\\Temp',
    env: { path: 'C:\\Inherited', userprofile: 'C:\\Users\\inherited', systemroot: 'D:\\Windows' },
  }));

  const completed = win.completeSpawnEnv(
    { PATH: 'C:\\Explicit', UserProfile: 'D:\\Users\\caller' },
    { pAtH: 'E:\\Final' },
  );
  const entries = Object.entries(completed);
  const value = (name) => entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

  assert.equal(entries.filter(([key]) => key.toLowerCase() === 'path').length, 1);
  assert.equal(value('PATH'), 'D:\\Users\\caller\\.ae-mcp\\bin;E:\\Final');
  assert.equal(entries.filter(([key]) => key.toLowerCase() === 'userprofile').length, 1);
  assert.equal(value('USERPROFILE'), 'D:\\Users\\caller');
  assert.equal(value('HOME'), 'D:\\Users\\caller');
  assert.equal(value('SystemRoot'), 'D:\\Windows');
});

test('default Windows dependencies find USERPROFILE case-insensitively', (t) => {
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const fs = { existsSync: () => false };
  const spawn = () => { throw new Error('not expected'); };
  globalThis.window = {
    cep_node: {
      process: { platform: 'win32', arch: 'x64', env: { userprofile: 'D:\\Users\\lowercase' } },
      require(name) {
        if (name === 'os') return { homedir: () => 'C:\\Fallback', tmpdir: () => 'D:\\Temp' };
        if (name === 'fs') return fs;
        if (name === 'child_process') return { spawn };
        throw new Error('unexpected require: ' + name);
      },
    },
  };

  const deps = defaultPlatformDependencies();

  assert.equal(deps.home, 'D:\\Users\\lowercase');
});

test('CEP path normalization decodes file URLs once and leaves native percent paths untouched', () => {
  const mac = createMacosAdapter(inertDeps({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp',
  }));
  assert.equal(typeof pathBoundary.normalizeCepSystemPath, 'function');
  assert.equal(
    pathBoundary.normalizeCepSystemPath('file:///Applications/AE%20MCP%23Dev', mac),
    '/Applications/AE MCP#Dev',
  );
  assert.equal(
    pathBoundary.normalizeCepSystemPath('/Applications/100% AE/%23-literal', mac),
    '/Applications/100% AE/%23-literal',
  );
  assert.equal(
    pathBoundary.normalizeCepSystemPath('file:///Applications/literal%5Cname', mac),
    '/Applications/literal\\name',
  );
});

test('CEP path normalization preserves a Windows file URL authority as UNC', () => {
  const win = createWindowsAdapter(inertDeps({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
  }));
  assert.equal(typeof pathBoundary.normalizeCepSystemPath, 'function');
  assert.equal(
    pathBoundary.normalizeCepSystemPath('file://server/share/AE%20MCP', win),
    '\\\\server\\share\\AE MCP',
  );
});

test('CEP system-path reader prefers the raw CEP URI so encoding is decoded exactly once', () => {
  const mac = createMacosAdapter(inertDeps({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp',
  }));
  assert.equal(typeof pathBoundary.readCepSystemPath, 'function');
  const result = pathBoundary.readCepSystemPath({
    pathType: 'extension',
    platform: mac,
    cep: { getSystemPath: () => 'file:///Applications/Literal%2523/Hash%23' },
    cs: { getSystemPath: () => '/Applications/Literal%23/Hash%23' },
  });
  assert.equal(result, '/Applications/Literal%23/Hash#');
});
