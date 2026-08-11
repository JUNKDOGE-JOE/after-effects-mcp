const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
    createPlatformHelperTransport,
    windowsEndpointGeneration,
    windowsPipeName,
} = require('./platform-helper-transport');

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

function nextTurn() {
    return new Promise(function (resolve) { setImmediate(resolve); });
}

function macOptions(overrides) {
    return {
        runtime: { platform: 'darwin', arch: 'arm64' },
        prepareMacosHelperRegistration: function () {
            return {
                helperPath: '/verified/ae-mcp-platform-helper',
                ensureRegistered: async function () {},
                repairRegistered: async function () {},
            };
        },
        ...overrides,
    };
}

function windowsOptions(overrides) {
    return {
        runtime: { platform: 'win32', arch: 'x64' },
        verifyWindowsPayload: function () {
            return {
                path: 'C:\\verified\\ae-mcp-platform-helper.exe',
                sha256: 'a'.repeat(64),
            };
        },
        ...overrides,
    };
}

test('only Windows loads the in-process N-API addon', async () => {
    const loaded = [];
    const transport = createPlatformHelperTransport(windowsOptions({
        loadAddon: function (addonPath) {
            loaded.push(addonPath);
            return { createTransport: function () { return fakeNativeTransport(); } };
        },
    }));
    assert.equal(loaded.length, 1);
    assert.match(
        loaded[0],
        /platform[\\/]windows-x64[\\/]lib[\\/]ae-mcp-platform-helper-transport\.node$/,
    );
    assert.equal(await transport.request('{"ok":true}'), '{"ok":true}');
    await transport.close();
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

test('Windows transport fails closed when the addon or N-API result violates the contract', async () => {
    const runtime = { platform: 'win32', arch: 'x64' };
    assert.throws(() => createPlatformHelperTransport(macOptions({
        runtime,
        verifyWindowsPayload: windowsOptions().verifyWindowsPayload,
        loadAddon: function () { return {}; },
    })), { code: 'PLATFORM_HELPER_REPAIR_REQUIRED' });
    const transport = createPlatformHelperTransport(macOptions({
        runtime,
        verifyWindowsPayload: windowsOptions().verifyWindowsPayload,
        loadAddon: function () {
            return { createTransport: function () { return { request: async function () {} }; } };
        },
    }));
    await assert.rejects(transport.request('{}'), { code: 'PLATFORM_HELPER_REPAIR_REQUIRED' });
    await transport.close();
});

test('Windows transport rejects a path-only identity before loading native code', () => {
    let loads = 0;
    assert.throws(() => createPlatformHelperTransport({
        runtime: { platform: 'win32', arch: 'x64' },
        verifyWindowsPayload: function () { return 'C:\\untrusted\\helper.exe'; },
        loadAddon: function () { loads += 1; },
    }), { code: 'PLATFORM_HELPER_REPAIR_REQUIRED' });
    assert.equal(loads, 0);
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
                createTransport: function (identity) {
                    opens += 1;
                    assert.deepEqual(identity, {
                        expectedServerPath: 'C:\\verified\\ae-mcp-platform-helper.exe',
                        expectedServerSha256: 'a'.repeat(64),
                        // #216: the endpoint is generation-namespaced from the
                        // verified payload identity.
                        pipeName: windowsPipeName({
                            path: 'C:\\verified\\ae-mcp-platform-helper.exe',
                            sha256: 'a'.repeat(64),
                        }),
                    });
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

test('macOS uses the verified stdio broker and never loads the addon', async () => {
    const events = [];
    const transport = createPlatformHelperTransport(macOptions({
        loadAddon: function () {
            throw new Error('macOS must not load the addon');
        },
        createMacosBrokerTransport: function ({ helperPath }) {
            events.push(`broker:${helperPath}`);
            return fakeNativeTransport();
        },
    }));
    assert.equal(await transport.request('stdio'), 'stdio');
    assert.deepEqual(events, ['broker:/verified/ae-mcp-platform-helper']);
    await transport.close();
});

test('macOS repair transport replaces registration before opening the broker', async () => {
    const events = [];
    const transport = createPlatformHelperTransport(macOptions({
        repairRegistration: true,
        prepareMacosHelperRegistration: function () {
            return {
                helperPath: '/verified/platform/helper',
                ensureRegistered: async function () {
                    events.push('ensure');
                },
                repairRegistered: async function () {
                    events.push('repair');
                },
            };
        },
        createMacosBrokerTransport: function () {
            events.push('broker');
            return {
                request: async function () { return 'ready'; },
                close: async function () {},
            };
        },
    }));

    assert.equal(await transport.request('request'), 'ready');
    assert.deepEqual(events, ['repair', 'broker']);
    await transport.close();
});

test('macOS registration completes before the stdio broker starts or sends a request', async () => {
    const events = [];
    let releaseRegistration;
    const registrationGate = new Promise(function (resolve) {
        releaseRegistration = resolve;
    });
    const transport = createPlatformHelperTransport({
        runtime: { platform: 'darwin', arch: 'arm64' },
        prepareMacosHelperRegistration: function () {
            return {
                helperPath: '/verified/ae-mcp-platform-helper',
                ensureRegistered: async function () {
                    events.push('register:start');
                    await registrationGate;
                    events.push('register:done');
                },
                repairRegistered: async function () {},
            };
        },
        loadAddon: function () {
            throw new Error('macOS must not load the addon');
        },
        createMacosBrokerTransport: function () {
            events.push('broker:createTransport');
            return {
                request: async function (jsonUtf8) {
                    events.push('broker:request');
                    return jsonUtf8;
                },
                close: async function () {},
            };
        },
    });

    const request = transport.request('xpc');
    try {
        await nextTurn();
        assert.deepEqual(events, ['register:start']);
    } finally {
        releaseRegistration();
    }
    assert.equal(await request, 'xpc');
    assert.deepEqual(events, [
        'register:start',
        'register:done',
        'broker:createTransport',
        'broker:request',
    ]);
    await transport.close();
});

test('concurrent macOS requests share one registration and one native transport', async () => {
    let registrations = 0;
    let nativeTransports = 0;
    const transport = createPlatformHelperTransport(macOptions({
        prepareMacosHelperRegistration: function () {
            return {
                helperPath: '/verified/ae-mcp-platform-helper',
                ensureRegistered: async function () {
                    registrations += 1;
                    await nextTurn();
                },
                repairRegistered: async function () {},
            };
        },
        createMacosBrokerTransport: function () {
            nativeTransports += 1;
            return fakeNativeTransport();
        },
    }));

    assert.deepEqual(await Promise.all([
        transport.request('one'),
        transport.request('two'),
    ]), ['one', 'two']);
    assert.equal(registrations, 1);
    assert.equal(nativeTransports, 1);
    await transport.close();
});

test('macOS registration lifecycle errors remain bounded and block native XPC', async () => {
    for (const fixture of [
        { code: 'HELPER_START_FAILED', retryable: true },
        { code: 'PLATFORM_HELPER_REPAIR_REQUIRED', retryable: false },
    ]) {
        let nativeTransports = 0;
        const transport = createPlatformHelperTransport(macOptions({
            prepareMacosHelperRegistration: function () {
                return {
                    helperPath: '/verified/ae-mcp-platform-helper',
                    ensureRegistered: async function () {
                        throw Object.assign(new Error('sensitive local detail'), fixture);
                    },
                    repairRegistered: async function () {},
                };
            },
            createMacosBrokerTransport: function () {
                nativeTransports += 1;
                return fakeNativeTransport();
            },
        }));
        await assert.rejects(transport.request('{}'), fixture);
        assert.equal(nativeTransports, 0);
        await transport.close();
    }
});

test('Windows never constructs the macOS registrar', async () => {
    let macosRegistrars = 0;
    const transport = createPlatformHelperTransport(windowsOptions({
        prepareMacosHelperRegistration: function () {
            macosRegistrars += 1;
            throw new Error('must not run');
        },
        loadAddon: function () {
            return { createTransport: function () { return fakeNativeTransport(); } };
        },
    }));
    assert.equal(await transport.request('windows'), 'windows');
    assert.equal(macosRegistrars, 0);
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

test('process launch is isolated to the verified platform Helper JS boundaries', () => {
    const hostSource = fs.readFileSync(path.join(__dirname, 'platform-helper-transport.js'), 'utf8');
    assert.match(hostSource, /require\('child_process'\)\.spawn/);
    assert.match(hostSource, /windowsHide:\s*true/);
    assert.match(hostSource, /authenticated AE owner monitor, not CEP teardown/);
    assert.match(hostSource, /detached:\s*true/);
    assert.match(hostSource, /shell:\s*false/);
    assert.match(hostSource, /stdio:\s*'ignore'/);
    assert.doesNotMatch(
        hostSource,
        /require\('child_process'\)\.execFile|\bexec\s*\(|ShellExecute|stdio:\s*'inherit'/i,
    );

    const productionHostFiles = fs.readdirSync(__dirname)
        .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'));
    const processBoundaryFiles = new Set([
        'platform-helper-transport.js',
        'platform-helper-registration.js',
        'platform-helper-stdio-transport.js',
    ]);
    for (const name of productionHostFiles) {
        const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
        if (processBoundaryFiles.has(name)) continue;
        assert.doesNotMatch(source, /process\.(?:platform|arch)/, name);
        assert.doesNotMatch(source, /child_process|execFile|spawn\s*\(/i, name);
    }
    const registrationSource = fs.readFileSync(
        path.join(__dirname, 'platform-helper-registration.js'),
        'utf8',
    );
    assert.match(registrationSource, /\/bin\/launchctl/);
    assert.match(registrationSource, /require\('child_process'\)\.execFile/);
    assert.doesNotMatch(
        registrationSource,
        /shell:\s*true|\bexec\s*\(|\bspawn\s*\(|\bkill\b|stdio:\s*'inherit'/i,
    );
    const stdioSource = fs.readFileSync(
        path.join(__dirname, 'platform-helper-stdio-transport.js'),
        'utf8',
    );
    assert.match(stdioSource, /\['--client-stdio'\]/);
    assert.match(stdioSource, /shell:\s*false/);
    assert.match(stdioSource, /stdio:\s*\['pipe',\s*'pipe',\s*'pipe'\]/);
    assert.doesNotMatch(
        stdioSource,
        /shell:\s*true|\bexec\s*\(|\bexecFile\s*\(|\bkill\s*\(|stdio:\s*'inherit'/i,
    );

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
    // #216: no fixed full endpoint may exist in the addon — only the
    // generation prefix; the caller supplies the namespaced pipe name.
    assert.equal(
        windowsSource.includes(String.raw`LR"(\\.\pipe\com.junkdoge.ae-mcp.platform-helper.)"`),
        true,
    );
    assert.equal(
        windowsSource.includes(String.raw`LR"(\\.\pipe\com.junkdoge.ae-mcp.platform-helper)"`),
        false,
    );
    assert.match(windowsSource, /options\.pipe_name/);
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

test('endpoint generation namespaces installs and stays deterministic (#216)', () => {
    const identity = { path: String.raw`C:\A\ext\bin\helper.exe`, sha256: 'a'.repeat(64) };
    // Deterministic and versioned.
    assert.equal(windowsEndpointGeneration(identity), windowsEndpointGeneration(identity));
    assert.match(windowsEndpointGeneration(identity), /^v1-[0-9a-f]{16}$/);
    assert.equal(
        windowsPipeName(identity),
        String.raw`\\.\pipe\com.junkdoge.ae-mcp.platform-helper.` + windowsEndpointGeneration(identity),
    );
    // Loose normalization: case, separators, and the long-path prefix collapse.
    assert.equal(
        windowsEndpointGeneration({ path: String.raw`\\?\C:/a/EXT/bin/HELPER.exe`, sha256: 'A'.repeat(64) }),
        windowsEndpointGeneration(identity),
    );
    // A different payload hash or install path is a different generation, so an
    // old install can never occupy the new install's endpoint.
    assert.notEqual(
        windowsEndpointGeneration({ ...identity, sha256: 'b'.repeat(64) }),
        windowsEndpointGeneration(identity),
    );
    assert.notEqual(
        windowsEndpointGeneration({ ...identity, path: String.raw`C:\B\ext\bin\helper.exe` }),
        windowsEndpointGeneration(identity),
    );
});
