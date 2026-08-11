'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    prepareMacosHelperRegistration,
} = require('./platform-helper-registration');
const {
    createPlatformHelperStdioTransport,
} = require('./platform-helper-stdio-transport');

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

// Endpoint generation (#216): the pipe name is namespaced by the payload
// identity so an older installed Helper can never occupy or impersonate the
// current generation's endpoint. The helper computes the identical value from
// its own image (see native/platform-helper/windows/src/main.cpp); both sides
// agree without prior communication. Bump the scheme only together with the
// helper and the packaging identity policy.
const ENDPOINT_GENERATION_SCHEME = 'v1';
const WINDOWS_PIPE_NAME_PREFIX = '\\\\.\\pipe\\com.junkdoge.ae-mcp.platform-helper.';
const WINDOWS_LEGACY_PIPE_NAME = '\\\\.\\pipe\\com.junkdoge.ae-mcp.platform-helper';

function normalizedIdentityPath(filePath) {
    let value = String(filePath);
    if (value.startsWith('\\\\?\\')) value = value.slice(4);
    return value.replace(/\//g, '\\').toLowerCase();
}

function windowsEndpointGeneration(identity) {
    const material = normalizedIdentityPath(identity.path)
        + '\n' + identity.sha256.toLowerCase();
    const digest = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
    return ENDPOINT_GENERATION_SCHEME + '-' + digest.slice(0, 16);
}

function windowsPipeName(identity) {
    return WINDOWS_PIPE_NAME_PREFIX + windowsEndpointGeneration(identity);
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

function validMacosRegistration(value) {
    return value
        && typeof value.helperPath === 'string'
        && value.helperPath.length > 0
        && typeof value.ensureRegistered === 'function'
        && typeof value.repairRegistered === 'function';
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
    let macosRegistration = null;
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
    } else {
        const prepareRegistration = input.prepareMacosHelperRegistration
            || prepareMacosHelperRegistration;
        macosRegistration = prepareRegistration({
            addonPath,
            fsImpl: input.fsImpl,
            createHash: input.createHash,
            execFile: input.execFile,
            homedir: input.homedir,
            getuid: input.getuid,
            processId: input.processId,
        });
        if (!validMacosRegistration(macosRegistration)) {
            throw repairRequired('platform helper registrar returned an invalid registration');
        }
    }

    let addon = null;
    if (platformId === 'windows-x64') {
        try {
            addon = loadAddon(addonPath);
        } catch (cause) {
            throw repairRequired('failed to load the platform helper transport addon', cause);
        }
        if (!addon || typeof addon.createTransport !== 'function') {
            throw repairRequired('platform helper addon does not export createTransport');
        }
    }

    let nativeTransport = null;
    let connectPromise = null;
    let closePromise = null;
    let closed = false;

    function openNativeTransport() {
        const opened = addon.createTransport({
            expectedServerPath: helperIdentity.path,
            expectedServerSha256: helperIdentity.sha256,
            pipeName: windowsPipeName(helperIdentity),
        });
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
        // Name the generation and whether a legacy (pre-namespacing) helper
        // still owns the old fixed endpoint, so the failure is actionable
        // instead of an opaque timeout.
        let legacyOccupied = false;
        try {
            legacyOccupied = (input.fsImpl || require('fs')).existsSync(WINDOWS_LEGACY_PIPE_NAME);
        } catch (_) {}
        throw startFailed('platform helper did not become ready before the startup deadline'
            + ' (endpoint generation ' + windowsEndpointGeneration(helperIdentity)
            + (legacyOccupied
                ? '; a legacy pre-upgrade helper still owns the old endpoint and retires when its After Effects exits'
                : '')
            + ')');
    }

    async function connect() {
        if (closed) throw unavailable('platform helper transport is closed');
        let opened;
        if (platformId === 'windows-x64') {
            opened = await connectWindows();
        } else {
            try {
                if (input.repairRegistration === true) {
                    await macosRegistration.repairRegistered();
                } else {
                    await macosRegistration.ensureRegistered();
                }
                const createBrokerTransport = input.createMacosBrokerTransport
                    || createPlatformHelperStdioTransport;
                opened = createBrokerTransport({
                    helperPath: macosRegistration.helperPath,
                    spawnImpl: input.spawnMacosBroker,
                });
                if (!validNativeTransport(opened)) {
                    try {
                        if (opened && typeof opened.close === 'function') opened.close();
                    } catch (_) {}
                    throw repairRequired('platform helper broker returned an invalid transport');
                }
            } catch (cause) {
                if (cause
                    && (cause.code === 'PLATFORM_HELPER_REPAIR_REQUIRED'
                        || cause.code === 'HELPER_START_FAILED')) throw cause;
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

module.exports = {
    createPlatformHelperTransport,
    windowsEndpointGeneration,
    windowsPipeName,
};
