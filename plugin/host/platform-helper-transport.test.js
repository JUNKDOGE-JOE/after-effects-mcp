const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createPlatformHelperTransport } = require('./platform-helper-transport');

function fakeNativeTransport() {
    return {
        request: async function (jsonUtf8) { return jsonUtf8; },
        close: async function () {},
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

test('transport fails closed when the addon or N-API result violates the contract', () => {
    const runtime = { platform: 'darwin', arch: 'arm64' };
    assert.throws(() => createPlatformHelperTransport({
        runtime,
        loadAddon: function () { return {}; },
    }), { code: 'HELPER_UNAVAILABLE' });
    assert.throws(() => createPlatformHelperTransport({
        runtime,
        loadAddon: function () {
            return { createTransport: function () { return { request: async function () {} }; } };
        },
    }), { code: 'HELPER_UNAVAILABLE' });
});

test('transport architecture is N-API over XPC/named pipes with no process or stdio fallback', () => {
    const hostSource = fs.readFileSync(path.join(__dirname, 'platform-helper-transport.js'), 'utf8');
    assert.match(hostSource, /process\.platform/);
    assert.match(hostSource, /process\.arch/);
    assert.doesNotMatch(hostSource, /child_process|execFile|spawn\s*\(|stdio/i);

    const productionHostFiles = fs.readdirSync(__dirname)
        .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'));
    for (const name of productionHostFiles) {
        const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
        if (name === 'platform-helper-transport.js') continue;
        assert.doesNotMatch(source, /process\.(?:platform|arch)/, name);
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
