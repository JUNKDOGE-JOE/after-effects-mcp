const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { createPlatformHelperTransport } = require('./platform-helper-transport');

function fakeNativeTransport() {
    return {
        request: async function (jsonUtf8) { return jsonUtf8; },
        close: async function () {},
    };
}

function fakeChild() {
    const child = new EventEmitter();
    child.unref = function () {};
    return child;
}

function windowsOptions(overrides) {
    return {
        runtime: { platform: 'win32', arch: 'x64' },
        verifyWindowsPayload: function () { return 'C:\\verified\\ae-mcp-platform-helper.exe'; },
        ...overrides,
    };
}

test('transport loads the in-process N-API addon for only the two supported targets', async () => {
    for (const fixture of [
        { platform: 'darwin', arch: 'arm64', platformId: 'macos-arm64' },
        { platform: 'win32', arch: 'x64', platformId: 'windows-x64' },
    ]) {
        const loaded = [];
        const native = fakeNativeTransport();
        const transport = createPlatformHelperTransport({
            runtime: { platform: fixture.platform, arch: fixture.arch },
            verifyWindowsPayload: function () { return 'C:\\verified\\ae-mcp-platform-helper.exe'; },
            loadAddon: function (addonPath) {
                loaded.push(addonPath);
                return { createTransport: function () { return native; } };
            },
        });
        assert.equal(loaded.length, 1);
        assert.match(
            loaded[0],
            new RegExp(`platform[\\\\/]${fixture.platformId}[\\\\/]lib[\\\\/]ae-mcp-platform-helper-transport\\.node$`),
        );
        assert.equal(await transport.request('{"ok":true}'), '{"ok":true}');
        await transport.close();
    }
});

test('transport rejects unsupported OS/architecture pairs before loading native code', () => {
    for (const runtime of [
        { platform: 'darwin', arch: 'x64' },
        { platform: 'win32', arch: 'arm64' },
        { platform: 'linux', arch: 'x64' },
    ]) {
        let loads = 0;
        assert.throws(() => createPlatformHelperTransport({
            runtime,
            loadAddon: function () { loads += 1; },
        }), { code: 'HELPER_UNAVAILABLE' });
        assert.equal(loads, 0);
    }
});

test('transport fails closed when the addon or N-API result violates the contract', async () => {
    const runtime = { platform: 'darwin', arch: 'arm64' };
    assert.throws(() => createPlatformHelperTransport({
        runtime,
        loadAddon: function () { return {}; },
    }), { code: 'PLATFORM_HELPER_REPAIR_REQUIRED' });
    const transport = createPlatformHelperTransport({
        runtime,
        loadAddon: function () {
            return { createTransport: function () { return { request: async function () {} }; } };
        },
    });
    await assert.rejects(transport.request('{}'), { code: 'PLATFORM_HELPER_REPAIR_REQUIRED' });
    await transport.close();
});

test('Windows transport starts the verified Helper once and retries the named pipe', async () => {
    let opens = 0;
    let spawns = 0;
    let unrefs = 0;
    let sleeps = 0;
    const native = fakeNativeTransport();
    const transport = createPlatformHelperTransport(windowsOptions({
        loadAddon: function () {
            return {
                createTransport: function () {
                    opens += 1;
                    if (opens < 3) throw new Error('pipe absent');
                    return native;
                },
            };
        },
        spawnHelper: function (helperPath) {
            spawns += 1;
            assert.equal(helperPath, 'C:\\verified\\ae-mcp-platform-helper.exe');
            const child = fakeChild();
            child.unref = function () { unrefs += 1; };
            return child;
        },
        sleep: async function () { sleeps += 1; },
    }));

    assert.deepEqual(await Promise.all([transport.request('one'), transport.request('two')]), ['one', 'two']);
    assert.equal(spawns, 1);
    assert.equal(unrefs, 1);
    assert.equal(sleeps, 2);
    assert.equal(opens, 3);
    await transport.close();
});

test('Windows transport reports a bounded startup failure without falling back', async () => {
    let clock = 0;
    const transport = createPlatformHelperTransport(windowsOptions({
        loadAddon: function () {
            return { createTransport: function () { throw new Error('pipe absent'); } };
        },
        spawnHelper: function () { return fakeChild(); },
        connectTimeoutMs: 3,
        connectRetryMs: 1,
        now: function () { return clock; },
        sleep: async function () { clock += 1; },
    }));
    await assert.rejects(transport.request('{}'), {
        code: 'HELPER_START_FAILED',
        retryable: true,
    });
    await transport.close();
});

test('macOS relies on XPC activation and never invokes the Windows launcher', async () => {
    let spawns = 0;
    const transport = createPlatformHelperTransport({
        runtime: { platform: 'darwin', arch: 'arm64' },
        loadAddon: function () {
            return { createTransport: function () { return fakeNativeTransport(); } };
        },
        spawnHelper: function () { spawns += 1; return fakeChild(); },
    });
    assert.equal(await transport.request('xpc'), 'xpc');
    assert.equal(spawns, 0);
    await transport.close();
});

test('Windows payload is hashed before native code is loaded or Helper is started', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-helper-transport-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const definitions = [
        ['bin/ae-mcp-platform-helper.exe', 'helper'],
        ['bin/ae-mcp.exe', 'launcher'],
        ['lib/ae-mcp-platform-helper-transport.node', 'addon'],
    ];
    const files = definitions.map(function ([relative, contents]) {
        const target = path.join(root, ...relative.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
        return {
            path: relative,
            architecture: 'pe-x64',
            sha256: crypto.createHash('sha256').update(contents).digest('hex'),
        };
    });
    fs.writeFileSync(path.join(root, 'helper-manifest.json'), JSON.stringify({
        schemaVersion: 1,
        platform: 'windows-x64',
        helperId: 'com.junkdoge.ae-mcp.platform-helper',
        entrypoints: {
            helper: 'bin/ae-mcp-platform-helper.exe',
            launcher: 'bin/ae-mcp.exe',
        },
        files,
    }));

    let loads = 0;
    const addonPath = path.join(root, 'lib', 'ae-mcp-platform-helper-transport.node');
    const transport = createPlatformHelperTransport({
        runtime: { platform: 'win32', arch: 'x64' },
        addonPath,
        loadAddon: function () {
            loads += 1;
            return { createTransport: function () { return fakeNativeTransport(); } };
        },
    });
    assert.equal(loads, 1);
    await transport.close();

    fs.writeFileSync(path.join(root, 'bin', 'ae-mcp-platform-helper.exe'), 'tampered');
    assert.throws(() => createPlatformHelperTransport({
        runtime: { platform: 'win32', arch: 'x64' },
        addonPath,
        loadAddon: function () { loads += 1; },
    }), { code: 'PLATFORM_HELPER_REPAIR_REQUIRED' });
    assert.equal(loads, 1);
});

test('process launch is isolated to the verified Windows JS boundary', () => {
    const hostSource = fs.readFileSync(path.join(__dirname, 'platform-helper-transport.js'), 'utf8');
    assert.match(hostSource, /require\('child_process'\)\.spawn/);
    assert.match(hostSource, /windowsHide:\s*true/);
    assert.match(hostSource, /authenticated AE owner monitor, not CEP teardown/);
    assert.match(hostSource, /detached:\s*true/);
    assert.match(hostSource, /shell:\s*false/);
    assert.match(hostSource, /stdio:\s*'ignore'/);
    assert.doesNotMatch(hostSource, /execFile|\bexec\s*\(|ShellExecute|stdio:\s*'inherit'/i);

    const productionHostFiles = fs.readdirSync(__dirname)
        .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'));
    for (const name of productionHostFiles) {
        const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
        if (name === 'platform-helper-transport.js') continue;
        assert.doesNotMatch(source, /process\.(?:platform|arch)/, name);
        assert.doesNotMatch(source, /child_process|execFile|spawn\s*\(/i, name);
    }

    const addonRoot = path.resolve(__dirname, '../../native/platform-helper/client-addon');
    const cmake = fs.readFileSync(path.join(addonRoot, 'CMakeLists.txt'), 'utf8');
    const commonHeader = fs.readFileSync(path.join(addonRoot, 'src/common.hpp'), 'utf8');
    const commonSource = fs.readFileSync(path.join(addonRoot, 'src/common.cpp'), 'utf8');
    const macSource = fs.readFileSync(path.join(addonRoot, 'src/addon_macos.mm'), 'utf8');
    const windowsSource = fs.readFileSync(path.join(addonRoot, 'src/addon_windows.cpp'), 'utf8');
    assert.match(cmake, /24\.17\.0/);
    assert.match(cmake, /NODE_INCLUDE_DIR/);
    assert.match(cmake, /MODULE/);
    assert.match(commonHeader, /napi_value\s+CreateTransport\s*\(/);
    assert.match(commonSource, /napi_create_promise/);
    assert.match(macSource, /NSXPCConnection/);
    assert.match(windowsSource, /#include <algorithm>/);
    assert.match(windowsSource, /CreateFileW/);
    assert.equal(
        windowsSource.includes(String.raw`LR"(\\.\pipe\com.junkdoge.ae-mcp.platform-helper)"`),
        true,
    );
    for (const source of [cmake, commonHeader, commonSource, macSource, windowsSource]) {
        assert.doesNotMatch(
            source,
            /child_process|CreateProcess|ShellExecute|\bpopen\b|\bsystem\s*\(|\bstdin\b|\bstdout\b/i,
        );
    }
});

test('Windows native transport uses cancellable overlapped I/O with a 10-second deadline', () => {
    const addonRoot = path.resolve(__dirname, '../../native/platform-helper/client-addon');
    const commonHeader = fs.readFileSync(path.join(addonRoot, 'src/common.hpp'), 'utf8');
    const commonSource = fs.readFileSync(path.join(addonRoot, 'src/common.cpp'), 'utf8');
    const macSource = fs.readFileSync(path.join(addonRoot, 'src/addon_macos.mm'), 'utf8');
    const windowsSource = fs.readFileSync(path.join(addonRoot, 'src/addon_windows.cpp'), 'utf8');

    assert.match(commonHeader, /virtual\s+void\s+Cancel\s*\(\s*\)/);
    assert.match(commonSource, /transport->Cancel\s*\(\s*\)[\s\S]*WorkOperation::kClose/);
    assert.match(macSource, /void\s+Cancel\s*\(\s*\)\s+override/);
    assert.match(windowsSource, /FILE_FLAG_OVERLAPPED/);
    assert.match(windowsSource, /CancelIoEx/);
    assert.match(windowsSource, /WaitForSingleObject/);
    assert.match(windowsSource, /kRequestTimeoutMs\s*=\s*10000/);
    assert.match(windowsSource, /std::timed_mutex\s+request_mutex_/);
    assert.match(
        windowsSource,
        /RequestDeadline\s+deadline[\s\S]*try_lock_until\s*\(\s*deadline\s*\)/,
    );
    assert.match(windowsSource, /request_mutex_/);
    assert.match(windowsSource, /state_mutex_/);
});
