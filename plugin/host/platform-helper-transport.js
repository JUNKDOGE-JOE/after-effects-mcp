'use strict';

const path = require('path');

function unavailable(message, cause) {
    const error = new Error(message);
    error.code = 'HELPER_UNAVAILABLE';
    error.retryable = true;
    if (cause !== undefined) error.cause = cause;
    return error;
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

function createPlatformHelperTransport(options) {
    const input = options || {};
    const runtime = input.runtime || { platform: process.platform, arch: process.arch };
    const platformId = platformIdFor(runtime);
    const addonPath = input.addonPath || defaultAddonPath(platformId);
    const loadAddon = input.loadAddon || function (filePath) { return require(filePath); };

    let addon;
    try {
        addon = loadAddon(addonPath);
    } catch (cause) {
        throw unavailable('failed to load the platform helper transport addon', cause);
    }
    if (!addon || typeof addon.createTransport !== 'function') {
        throw unavailable('platform helper addon does not export createTransport');
    }

    let nativeTransport;
    try {
        nativeTransport = addon.createTransport();
    } catch (cause) {
        throw unavailable('failed to open the authenticated platform helper transport', cause);
    }
    if (!nativeTransport
        || typeof nativeTransport.request !== 'function'
        || typeof nativeTransport.close !== 'function') {
        throw unavailable('platform helper addon returned an invalid transport');
    }

    let closePromise = null;
    return Object.freeze({
        request: function (jsonUtf8) {
            if (typeof jsonUtf8 !== 'string') {
                return Promise.reject(unavailable('platform helper request must be a UTF-8 string'));
            }
            return Promise.resolve().then(function () {
                return nativeTransport.request(jsonUtf8);
            });
        },
        close: function () {
            if (!closePromise) {
                closePromise = Promise.resolve().then(function () {
                    return nativeTransport.close();
                });
            }
            return closePromise;
        },
    });
}

module.exports = { createPlatformHelperTransport };
