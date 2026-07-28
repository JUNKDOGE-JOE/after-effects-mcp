const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    prepareMacosHelperRegistration,
} = require('./platform-helper-registration');

const HELPER_ID = 'com.junkdoge.ae-mcp.platform-helper';
const MACOS_FILES = Object.freeze([
    ['bin/ae-mcp-platform-helper', 'macho-arm64'],
    ['bin/ae-mcp', 'script'],
    ['lib/ae-mcp-platform-helper-transport.node', 'macho-arm64'],
    ['xpc/com.junkdoge.ae-mcp.platform-helper.xpc/Contents/MacOS/ae-mcp-platform-helper', 'macho-arm64'],
    ['xpc/com.junkdoge.ae-mcp.platform-helper.xpc/Contents/Info.plist', 'data'],
    ['metadata/PlatformHelper.entitlements', 'data'],
    ['launchd/com.junkdoge.ae-mcp.platform-helper.plist', 'data'],
]);

function sha256(contents) {
    return crypto.createHash('sha256').update(contents).digest('hex');
}

function writeMacosFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-helper-registration-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const helperRoot = path.join(root, 'platform', 'macos-arm64');
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });

    const records = MACOS_FILES.map(function ([relative, architecture], index) {
        const target = path.join(helperRoot, ...relative.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const contents = relative.startsWith('launchd/')
            ? [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<plist version="1.0"><dict>',
                '<key>Label</key><string>com.junkdoge.ae-mcp.platform-helper</string>',
                '<key>ProgramArguments</key><array>',
                '<string>__AE_MCP_HELPER_EXECUTABLE__</string>',
                '</array></dict></plist>',
                '',
            ].join('\n')
            : `fixture-${index}-${relative}\n`;
        fs.writeFileSync(target, contents);
        return {
            path: relative,
            architecture,
            sha256: sha256(contents),
        };
    });
    fs.writeFileSync(path.join(helperRoot, 'helper-manifest.json'), JSON.stringify({
        schemaVersion: 1,
        platform: 'macos-arm64',
        helperId: HELPER_ID,
        entrypoints: {
            helper: 'bin/ae-mcp-platform-helper',
            launcher: 'bin/ae-mcp',
        },
        files: records,
    }));
    return {
        addonPath: path.join(
            helperRoot,
            'lib',
            'ae-mcp-platform-helper-transport.node',
        ),
        helperPath: path.join(helperRoot, 'bin', 'ae-mcp-platform-helper'),
        helperRoot,
        home,
        stateRoot: path.join(
            home,
            'Library',
            'Application Support',
            'AfterEffectsMCP',
            'platform-helper-v1',
        ),
    };
}

function manifestPath(fixture) {
    return path.join(fixture.helperRoot, 'helper-manifest.json');
}

function registrationFor(fixture, execFile, overrides) {
    return prepareMacosHelperRegistration({
        addonPath: fixture.addonPath,
        execFile,
        homedir: function () { return fixture.home; },
        getuid: function () { return 501; },
        processId: 42,
        ...overrides,
    });
}

test('macOS registration verifies the payload and bootstraps the exact helper before use', async (t) => {
    const fixture = writeMacosFixture(t);
    const calls = [];
    const mkdirCalls = [];
    const writeFileCalls = [];
    const chmodCalls = [];
    let generatedPlist = null;
    let generatedContents = null;
    const service = `gui/501/${HELPER_ID}`;
    const fsImpl = {
        ...fs,
        mkdirSync(target, options) {
            mkdirCalls.push([target, options]);
            return fs.mkdirSync(target, options);
        },
        writeFileSync(target, contents, options) {
            writeFileCalls.push([target, options]);
            return fs.writeFileSync(target, contents, options);
        },
        chmodSync(target, mode) {
            chmodCalls.push([target, mode]);
            return fs.chmodSync(target, mode);
        },
    };

    function execFile(file, args, options, callback) {
        calls.push([file, [...args]]);
        assert.equal(options.encoding, 'utf8');
        assert.equal(options.timeout, 5000);
        assert.equal(options.windowsHide, true);
        assert.equal(options.maxBuffer, 65536);
        if (args[0] === 'print' && calls.length === 1) {
            const error = Object.assign(new Error('service absent'), { code: 113 });
            queueMicrotask(() => callback(error, '', 'service absent'));
            return;
        }
        if (args[0] === 'bootstrap') {
            generatedPlist = args[2];
            generatedContents = fs.readFileSync(generatedPlist, 'utf8');
            queueMicrotask(() => callback(null, '', ''));
            return;
        }
        queueMicrotask(() => callback(
            null,
            `${service} = {\n\tprogram = ${fixture.helperPath}\n}\n`,
            '',
        ));
    }

    const registration = registrationFor(fixture, execFile, { fsImpl });
    await registration.ensureRegistered();

    assert.equal(registration.helperPath, fixture.helperPath);
    assert.deepEqual(calls, [
        ['/bin/launchctl', ['print', service]],
        ['/bin/launchctl', ['bootstrap', 'gui/501', generatedPlist]],
        ['/bin/launchctl', ['print', service]],
    ]);
    assert.equal(generatedContents.includes('__AE_MCP_HELPER_EXECUTABLE__'), false);
    assert.equal(generatedContents.includes(fixture.helperPath), true);
    assert.deepEqual(
        mkdirCalls.find(([target]) => target === fixture.stateRoot),
        [fixture.stateRoot, { recursive: true, mode: 0o700 }],
    );
    const temporaryWrite = writeFileCalls.find(
        ([target]) => target.startsWith(generatedPlist + '.tmp.'),
    );
    assert.ok(temporaryWrite);
    assert.deepEqual(
        temporaryWrite[1],
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    assert.deepEqual(chmodCalls, [
        [fixture.stateRoot, 0o700],
        [generatedPlist, 0o600],
    ]);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(fixture.stateRoot).mode & 0o077, 0);
        assert.equal(fs.statSync(generatedPlist).mode & 0o177, 0);
    }
});

test('macOS registration rejects a tampered payload before launchctl', (t) => {
    const fixture = writeMacosFixture(t);
    fs.appendFileSync(fixture.helperPath, 'tampered');
    let launchctlCalls = 0;
    assert.throws(() => registrationFor(fixture, function () {
        launchctlCalls += 1;
    }), { code: 'PLATFORM_HELPER_REPAIR_REQUIRED', retryable: false });
    assert.equal(launchctlCalls, 0);
});

test('macOS registration rejects an expanded manifest before launchctl', (t) => {
    const fixture = writeMacosFixture(t);
    const manifest = JSON.parse(fs.readFileSync(manifestPath(fixture), 'utf8'));
    manifest.files.push({
        path: 'unexpected',
        architecture: 'data',
        sha256: 'a'.repeat(64),
    });
    fs.writeFileSync(manifestPath(fixture), JSON.stringify(manifest));
    let launchctlCalls = 0;
    assert.throws(() => registrationFor(fixture, function () {
        launchctlCalls += 1;
    }), { code: 'PLATFORM_HELPER_REPAIR_REQUIRED', retryable: false });
    assert.equal(launchctlCalls, 0);
});

test('macOS registration rejects a symbolic state root before bootstrap', async (t) => {
    const fixture = writeMacosFixture(t);
    const outside = path.join(path.dirname(fixture.home), 'outside-state');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.dirname(fixture.stateRoot), { recursive: true });
    fs.symlinkSync(outside, fixture.stateRoot);
    const calls = [];
    const registration = registrationFor(fixture, function (file, args, options, callback) {
        calls.push([file, [...args]]);
        queueMicrotask(() => callback(Object.assign(new Error('absent'), { code: 113 }), '', ''));
    });

    await assert.rejects(registration.ensureRegistered(), {
        code: 'PLATFORM_HELPER_REPAIR_REQUIRED',
        retryable: false,
    });
    assert.deepEqual(calls, [
        ['/bin/launchctl', ['print', `gui/501/${HELPER_ID}`]],
    ]);
});

test('macOS registration reuses only an already-loaded exact helper', async (t) => {
    const fixture = writeMacosFixture(t);
    const calls = [];
    const registration = registrationFor(fixture, function (file, args, options, callback) {
        calls.push([file, [...args]]);
        queueMicrotask(() => callback(
            null,
            `gui/501/${HELPER_ID} = {\n\tprogram = ${fixture.helperPath}\n}\n`,
            '',
        ));
    });

    await registration.ensureRegistered();
    assert.deepEqual(calls, [
        ['/bin/launchctl', ['print', `gui/501/${HELPER_ID}`]],
    ]);
    assert.equal(fs.existsSync(fixture.stateRoot), false);
});

test('macOS registration rejects an already-loaded different helper', async (t) => {
    const fixture = writeMacosFixture(t);
    const registration = registrationFor(fixture, function (file, args, options, callback) {
        queueMicrotask(() => callback(
            null,
            `gui/501/${HELPER_ID} = {\n\tprogram = /tmp/untrusted-helper\n}\n`,
            '',
        ));
    });

    await assert.rejects(registration.ensureRegistered(), {
        code: 'PLATFORM_HELPER_REPAIR_REQUIRED',
        retryable: false,
    });
});

test('macOS registration sanitizes bootstrap failures without fallback', async (t) => {
    const fixture = writeMacosFixture(t);
    let calls = 0;
    const registration = registrationFor(fixture, function (file, args, options, callback) {
        calls += 1;
        if (args[0] === 'print') {
            queueMicrotask(() => callback(Object.assign(new Error('absent'), { code: 113 }), '', ''));
            return;
        }
        const sensitive = `${fixture.home}/secret stderr`;
        queueMicrotask(() => callback(Object.assign(new Error(sensitive), { code: 5 }), '', sensitive));
    });

    await assert.rejects(registration.ensureRegistered(), function (error) {
        assert.equal(error.code, 'HELPER_START_FAILED');
        assert.equal(error.retryable, true);
        assert.equal(error.message.includes(fixture.home), false);
        assert.equal(error.message.includes('stderr'), false);
        return true;
    });
    assert.equal(calls, 2);
});

test('macOS registration is single-flight for concurrent callers', async (t) => {
    const fixture = writeMacosFixture(t);
    const calls = [];
    const service = `gui/501/${HELPER_ID}`;
    const registration = registrationFor(fixture, function (file, args, options, callback) {
        calls.push([file, [...args]]);
        if (args[0] === 'print' && calls.length === 1) {
            setImmediate(() => callback(Object.assign(new Error('absent'), { code: 113 }), '', ''));
            return;
        }
        if (args[0] === 'bootstrap') {
            setImmediate(() => callback(null, '', ''));
            return;
        }
        setImmediate(() => callback(
            null,
            `${service} = {\n\tprogram = ${fixture.helperPath}\n}\n`,
            '',
        ));
    });

    const first = registration.ensureRegistered();
    const second = registration.ensureRegistered();
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.deepEqual(calls.map(function (call) { return call[1][0]; }), [
        'print',
        'bootstrap',
        'print',
    ]);
});
