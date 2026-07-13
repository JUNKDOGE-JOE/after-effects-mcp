'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WINDOWS_PAYLOAD_FILES = Object.freeze([
    'bin/ae-mcp-platform-helper.exe',
    'bin/ae-mcp.exe',
    'lib/ae-mcp-platform-helper-transport.node',
]);
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_RETRY_MS = 50;

function helperError(code, message, retryable, cause) {
    const error = new Error(message);
    error.code = code;
    error.retryable = Boolean(retryable);
    if (cause !== undefined) error.cause = cause;
    return error;
}

function unavailable(message, cause) {
    return helperError('HELPER_UNAVAILABLE', message, true, cause);
}

function repairRequired(message, cause) {
    return helperError('PLATFORM_HELPER_REPAIR_REQUIRED', message, false, cause);
}

function startFailed(message, cause) {
    return helperError('HELPER_START_FAILED', message, true, cause);
}

function platformIdFor(runtime) {
    if (runtime && runtime.platform === 'darwin' && runtime.arch === 'arm64') {
        return 'macos-arm64';
    }
    if (runtime && runtime.platform === 'win32' && runtime.arch === 'x64') {
        return 'windows-x64';
    }
    throw unavailable(
        'platform helper supports only macOS arm64 and Windows x64',
    );
}

function defaultAddonPath(platformId) {
    return path.join(
        __dirname,
        '..',
        'platform',
        platformId,
        'lib',
        'ae-mcp-platform-helper-transport.node',
    );
}

function regularFile(filePath, fsImpl) {
    let stat;
    try {
        stat = fsImpl.lstatSync(filePath);
    } catch (cause) {
        throw repairRequired('platform helper payload is incomplete', cause);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw repairRequired('platform helper payload contains an invalid file');
    }
}

function verifyWindowsPayload(addonPath, input) {
    const fsImpl = input.fsImpl || fs;
    const createHash = input.createHash || crypto.createHash;
    const helperRoot = path.resolve(path.dirname(addonPath), '..');
    const manifestPath = path.join(helperRoot, 'helper-manifest.json');
    regularFile(manifestPath, fsImpl);

    let manifest;
    try {
        manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
    } catch (cause) {
        throw repairRequired('platform helper manifest is invalid', cause);
    }
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const paths = files.map(function (record) { return record && record.path; });
    if (manifest.schemaVersion !== 1
        || manifest.platform !== 'windows-x64'
        || manifest.helperId !== 'com.junkdoge.ae-mcp.platform-helper'
        || !manifest.entrypoints
        || manifest.entrypoints.helper !== WINDOWS_PAYLOAD_FILES[0]
        || manifest.entrypoints.launcher !== WINDOWS_PAYLOAD_FILES[1]
        || paths.length !== WINDOWS_PAYLOAD_FILES.length
        || WINDOWS_PAYLOAD_FILES.some(function (file) { return !paths.includes(file); })) {
        throw repairRequired('platform helper manifest identity is invalid');
    }

    const rootPrefix = helperRoot + path.sep;
    for (const record of files) {
        if (!record
            || !WINDOWS_PAYLOAD_FILES.includes(record.path)
            || typeof record.sha256 !== 'string'
            || !/^[0-9a-f]{64}$/i.test(record.sha256)) {
            throw repairRequired('platform helper manifest inventory is invalid');
        }
        const filePath = path.resolve(helperRoot, ...record.path.split('/'));
        if (!filePath.startsWith(rootPrefix)) {
            throw repairRequired('platform helper payload path is invalid');
        }
        regularFile(filePath, fsImpl);
        let digest;
        try {
            digest = createHash('sha256').update(fsImpl.readFileSync(filePath)).digest('hex');
        } catch (cause) {
            throw repairRequired('platform helper payload could not be verified', cause);
        }
        if (digest.toLowerCase() !== record.sha256.toLowerCase()) {
            throw repairRequired('platform helper payload verification failed');
        }
    }
    const helperRecord = files.find(function (record) {
        return record.path === manifest.entrypoints.helper;
    });
    return Object.freeze({
        path: path.join(helperRoot, ...manifest.entrypoints.helper.split('/')),
        sha256: helperRecord.sha256.toLowerCase(),
    });
}

function positiveDelay(value, fallback, name) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(name + ' must be a positive safe integer');
    }
    return value;
}

function validNativeTransport(value) {
    return value
        && typeof value.request === 'function'
        && typeof value.close === 'function';
}

function createPlatformHelperTransport(options) {
    const input = options || {};
    const runtime = input.runtime || { platform: process.platform, arch: process.arch };
    const platformId = platformIdFor(runtime);
    const addonPath = input.addonPath || defaultAddonPath(platformId);
    const loadAddon = input.loadAddon || function (filePath) { return require(filePath); };
    const connectTimeoutMs = positiveDelay(
        input.connectTimeoutMs,
        DEFAULT_CONNECT_TIMEOUT_MS,
        'connectTimeoutMs',
    );
    const connectRetryMs = positiveDelay(
        input.connectRetryMs,
        DEFAULT_CONNECT_RETRY_MS,
        'connectRetryMs',
    );
    const now = input.now || Date.now;
    const sleep = input.sleep || function (milliseconds) {
        return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
    };

    let helperIdentity = null;
    if (platformId === 'windows-x64') {
        const verifyPayload = input.verifyWindowsPayload || verifyWindowsPayload;
        helperIdentity = verifyPayload(addonPath, input);
        if (!helperIdentity
            || typeof helperIdentity.path !== 'string'
            || helperIdentity.path.length === 0
            || typeof helperIdentity.sha256 !== 'string'
            || !/^[0-9a-f]{64}$/i.test(helperIdentity.sha256)) {
            throw repairRequired('platform helper payload verifier returned an invalid entrypoint');
        }
    }

    let addon;
    try {
        addon = loadAddon(addonPath);
    } catch (cause) {
        throw repairRequired('failed to load the platform helper transport addon', cause);
    }
    if (!addon || typeof addon.createTransport !== 'function') {
        throw repairRequired('platform helper addon does not export createTransport');
    }

    let nativeTransport = null;
    let connectPromise = null;
    let closePromise = null;
    let closed = false;

    function openNativeTransport() {
        const opened = platformId === 'windows-x64'
            ? addon.createTransport({
                expectedServerPath: helperIdentity.path,
                expectedServerSha256: helperIdentity.sha256,
            })
            : addon.createTransport();
        if (!validNativeTransport(opened)) {
            try {
                if (opened && typeof opened.close === 'function') opened.close();
            } catch (_) {}
            throw repairRequired('platform helper addon returned an invalid transport');
        }
        return opened;
    }

    async function connectWindows() {
        try {
            return openNativeTransport();
        } catch (cause) {
            if (cause && cause.code === 'PLATFORM_HELPER_REPAIR_REQUIRED') throw cause;
        }

        const spawnHelper = input.spawnHelper || function (filePath) {
            return require('child_process').spawn(filePath, [], {
                windowsHide: true,
                // The authenticated AE owner monitor, not CEP teardown, controls lifetime.
                detached: true,
                shell: false,
                stdio: 'ignore',
            });
        };
        let child;
        let childError = null;
        let childExitCode = null;
        try {
            child = spawnHelper(helperIdentity.path);
            if (!child || typeof child !== 'object') {
                throw new TypeError('platform helper launcher returned an invalid child process');
            }
            if (typeof child.once === 'function') {
                child.once('error', function (cause) { childError = cause; });
                child.once('exit', function (code) { childExitCode = code; });
            }
            if (typeof child.unref === 'function') child.unref();
        } catch (cause) {
            throw startFailed('platform helper could not be started', cause);
        }

        const deadline = now() + connectTimeoutMs;
        while (!closed && now() < deadline) {
            await sleep(connectRetryMs);
            if (childError) throw startFailed('platform helper could not be started', childError);
            try {
                return openNativeTransport();
            } catch (cause) {
                if (cause && cause.code === 'PLATFORM_HELPER_REPAIR_REQUIRED') throw cause;
                if (childExitCode !== null && childExitCode !== 0) {
                    throw startFailed('platform helper exited before accepting a connection', cause);
                }
            }
        }
        if (closed) throw unavailable('platform helper transport is closed');
        throw startFailed('platform helper did not become ready before the startup deadline');
    }

    async function connect() {
        if (closed) throw unavailable('platform helper transport is closed');
        let opened;
        if (platformId === 'windows-x64') {
            opened = await connectWindows();
        } else {
            try {
                opened = openNativeTransport();
            } catch (cause) {
                if (cause && cause.code === 'PLATFORM_HELPER_REPAIR_REQUIRED') throw cause;
                throw unavailable('failed to open the authenticated platform helper transport', cause);
            }
        }
        if (closed) {
            try { await opened.close(); } catch (_) {}
            throw unavailable('platform helper transport is closed');
        }
        nativeTransport = opened;
        return opened;
    }

    function ensureTransport() {
        if (nativeTransport) return Promise.resolve(nativeTransport);
        if (!connectPromise) {
            const pending = Promise.resolve().then(connect).catch(function (error) {
                if (connectPromise === pending) connectPromise = null;
                throw error;
            });
            connectPromise = pending;
            pending.catch(function () {});
        }
        return connectPromise;
    }

    function beginStartup() {
        const pending = Promise.resolve().then(connect).catch(function (error) {
            if (connectPromise === pending) connectPromise = null;
            throw error;
        });
        connectPromise = pending;
        pending.catch(function () {});
    }

    beginStartup();

    return Object.freeze({
        request: function (jsonUtf8) {
            if (typeof jsonUtf8 !== 'string') {
                return Promise.reject(unavailable('platform helper request must be a UTF-8 string'));
            }
            return ensureTransport().then(function (transport) {
                return transport.request(jsonUtf8);
            }).catch(function (error) {
                if (nativeTransport) {
                    const failed = nativeTransport;
                    nativeTransport = null;
                    connectPromise = null;
                    try { Promise.resolve(failed.close()).catch(function () {}); } catch (_) {}
                }
                throw error;
            });
        },
        close: function () {
            if (!closePromise) {
                closed = true;
                closePromise = Promise.resolve(connectPromise).catch(function () { return null; })
                    .then(function (transport) {
                        const active = nativeTransport || transport;
                        nativeTransport = null;
                        connectPromise = null;
                        if (active && typeof active.close === 'function') return active.close();
                        return undefined;
                    });
            }
            return closePromise;
        },
    });
}

module.exports = { createPlatformHelperTransport };
