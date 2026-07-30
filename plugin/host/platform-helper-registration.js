'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HELPER_ID = 'com.junkdoge.ae-mcp.platform-helper';
const HELPER_ENTRYPOINT = 'bin/ae-mcp-platform-helper';
const LAUNCHER_ENTRYPOINT = 'bin/ae-mcp';
const LAUNCHD_TEMPLATE = `launchd/${HELPER_ID}.plist`;
const LAUNCHD_TOKEN = '__AE_MCP_HELPER_EXECUTABLE__';
const MACOS_PAYLOAD = Object.freeze([
    Object.freeze({ path: HELPER_ENTRYPOINT, architecture: 'macho-arm64' }),
    Object.freeze({ path: LAUNCHER_ENTRYPOINT, architecture: 'script' }),
    Object.freeze({
        path: 'lib/ae-mcp-platform-helper-transport.node',
        architecture: 'macho-arm64',
    }),
    Object.freeze({
        path: `xpc/${HELPER_ID}.xpc/Contents/MacOS/ae-mcp-platform-helper`,
        architecture: 'macho-arm64',
    }),
    Object.freeze({
        path: `xpc/${HELPER_ID}.xpc/Contents/Info.plist`,
        architecture: 'data',
    }),
    Object.freeze({
        path: 'metadata/PlatformHelper.entitlements',
        architecture: 'data',
    }),
    Object.freeze({ path: LAUNCHD_TEMPLATE, architecture: 'data' }),
]);
const LAUNCHCTL = '/bin/launchctl';
const MAX_LAUNCHCTL_OUTPUT_BYTES = 65536;

function helperError(code, message, retryable, cause) {
    const error = new Error(message);
    error.code = code;
    error.retryable = Boolean(retryable);
    if (cause !== undefined) error.cause = cause;
    return error;
}

function repairRequired(message, cause) {
    return helperError('PLATFORM_HELPER_REPAIR_REQUIRED', message, false, cause);
}

function startFailed(message, cause) {
    return helperError('HELPER_START_FAILED', message, true, cause);
}

function regularFile(filePath, fsImpl) {
    let metadata;
    try {
        metadata = fsImpl.lstatSync(filePath);
    } catch (cause) {
        throw repairRequired('platform helper payload is incomplete', cause);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw repairRequired('platform helper payload contains an invalid file');
    }
}

function resolvePayloadFile(helperRoot, relative) {
    const absolute = path.resolve(helperRoot, ...relative.split('/'));
    if (!absolute.startsWith(helperRoot + path.sep)) {
        throw repairRequired('platform helper payload path is invalid');
    }
    return absolute;
}

function readManifest(helperRoot, fsImpl) {
    const manifestPath = path.join(helperRoot, 'helper-manifest.json');
    regularFile(manifestPath, fsImpl);
    try {
        return JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
    } catch (cause) {
        throw repairRequired('platform helper manifest is invalid', cause);
    }
}

function verifyMacosPayload(addonPath, input) {
    const fsImpl = input.fsImpl;
    const createHash = input.createHash;
    const helperRoot = path.resolve(path.dirname(addonPath), '..');
    const expectedAddonPath = resolvePayloadFile(
        helperRoot,
        'lib/ae-mcp-platform-helper-transport.node',
    );
    if (path.resolve(addonPath) !== expectedAddonPath) {
        throw repairRequired('platform helper addon path is invalid');
    }

    const manifest = readManifest(helperRoot, fsImpl);
    if (manifest === null
        || typeof manifest !== 'object'
        || Array.isArray(manifest)
        || manifest.schemaVersion !== 1
        || manifest.platform !== 'macos-arm64'
        || manifest.helperId !== HELPER_ID
        || manifest.entrypoints === null
        || typeof manifest.entrypoints !== 'object'
        || Array.isArray(manifest.entrypoints)
        || manifest.entrypoints.helper !== HELPER_ENTRYPOINT
        || manifest.entrypoints.launcher !== LAUNCHER_ENTRYPOINT
        || !Array.isArray(manifest.files)
        || manifest.files.length !== MACOS_PAYLOAD.length) {
        throw repairRequired('platform helper manifest identity is invalid');
    }

    for (let index = 0; index < MACOS_PAYLOAD.length; index += 1) {
        const expected = MACOS_PAYLOAD[index];
        const record = manifest.files[index];
        if (record === null
            || typeof record !== 'object'
            || Array.isArray(record)
            || record.path !== expected.path
            || record.architecture !== expected.architecture
            || typeof record.sha256 !== 'string'
            || !/^[0-9a-f]{64}$/i.test(record.sha256)) {
            throw repairRequired('platform helper manifest inventory is invalid');
        }
        const filePath = resolvePayloadFile(helperRoot, record.path);
        regularFile(filePath, fsImpl);
        let digest;
        try {
            digest = createHash('sha256')
                .update(fsImpl.readFileSync(filePath))
                .digest('hex');
        } catch (cause) {
            throw repairRequired('platform helper payload could not be verified', cause);
        }
        if (digest.toLowerCase() !== record.sha256.toLowerCase()) {
            throw repairRequired('platform helper payload verification failed');
        }
    }

    return Object.freeze({
        helperRoot,
        helperPath: resolvePayloadFile(helperRoot, HELPER_ENTRYPOINT),
        templatePath: resolvePayloadFile(helperRoot, LAUNCHD_TEMPLATE),
    });
}

function xmlEscape(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function privateStateRoot(input) {
    return path.join(
        input.homedir(),
        'Library',
        'Application Support',
        'AfterEffectsMCP',
        'platform-helper-v1',
    );
}

function ensurePrivateDirectory(stateRoot, fsImpl) {
    try {
        if (!fsImpl.existsSync(stateRoot)) {
            fsImpl.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
        }
        const metadata = fsImpl.lstatSync(stateRoot);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error('state root is not a private directory');
        }
        fsImpl.chmodSync(stateRoot, 0o700);
    } catch (cause) {
        if (cause && cause.code === 'PLATFORM_HELPER_REPAIR_REQUIRED') throw cause;
        throw repairRequired('platform helper registration state is invalid', cause);
    }
}

function materializePrivatePlist(payload, input) {
    const fsImpl = input.fsImpl;
    const stateRoot = privateStateRoot(input);
    ensurePrivateDirectory(stateRoot, fsImpl);

    let template;
    try {
        template = fsImpl.readFileSync(payload.templatePath, 'utf8');
    } catch (cause) {
        throw repairRequired('platform helper launchd template is unavailable', cause);
    }
    const pieces = template.split(LAUNCHD_TOKEN);
    if (pieces.length !== 2) {
        throw repairRequired('platform helper launchd template is invalid');
    }
    const rendered = pieces[0] + xmlEscape(payload.helperPath) + pieces[1];
    const destination = path.join(stateRoot, `${HELPER_ID}.plist`);
    const nonce = crypto.randomBytes(8).toString('hex');
    const temporary = `${destination}.tmp.${input.processId}.${nonce}`;
    try {
        fsImpl.writeFileSync(temporary, rendered, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fsImpl.renameSync(temporary, destination);
        fsImpl.chmodSync(destination, 0o600);
    } catch (cause) {
        try {
            if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
        } catch (_) {}
        throw repairRequired('platform helper registration could not be written', cause);
    }
    return destination;
}

function launchctlServiceMissing(error) {
    return Boolean(error) && Number(error.code) === 113;
}

function launchctlRunner(input) {
    return function launchctl(args, options) {
        const allowMissing = Boolean(options && options.allowMissing);
        return new Promise(function (resolve, reject) {
            let settled = false;
            function finish(error, stdout) {
                if (settled) return;
                settled = true;
                if (error) {
                    if (allowMissing && launchctlServiceMissing(error)) {
                        resolve(Object.freeze({ found: false, stdout: '' }));
                        return;
                    }
                    reject(startFailed('platform helper registration command failed', error));
                    return;
                }
                resolve(Object.freeze({ found: true, stdout: String(stdout || '') }));
            }
            try {
                input.execFile(LAUNCHCTL, args, {
                    encoding: 'utf8',
                    timeout: 5000,
                    windowsHide: true,
                    maxBuffer: MAX_LAUNCHCTL_OUTPUT_BYTES,
                }, finish);
            } catch (cause) {
                finish(cause, '');
            }
        });
    };
}

function requireExactProgram(stdout, helperPath) {
    const exact = `program = ${helperPath}`;
    const lines = String(stdout).split(/\r?\n/).map(function (line) { return line.trim(); });
    if (!lines.includes(exact)) {
        throw repairRequired('registered platform helper identity is invalid');
    }
}

function prepareMacosHelperRegistration(options) {
    const input = options || {};
    if (typeof input.addonPath !== 'string' || !path.isAbsolute(input.addonPath)) {
        throw new TypeError('addonPath must be absolute');
    }
    const dependencies = {
        fsImpl: input.fsImpl || fs,
        createHash: input.createHash || crypto.createHash,
        execFile: input.execFile || require('child_process').execFile,
        homedir: input.homedir || os.homedir,
        getuid: input.getuid || process.getuid,
        processId: input.processId === undefined ? process.pid : input.processId,
    };
    if (typeof dependencies.execFile !== 'function'
        || typeof dependencies.homedir !== 'function'
        || typeof dependencies.getuid !== 'function'
        || !Number.isSafeInteger(dependencies.processId)
        || dependencies.processId <= 0) {
        throw new TypeError('macOS helper registration dependencies are invalid');
    }
    const userIdentifier = dependencies.getuid();
    if (!Number.isSafeInteger(userIdentifier) || userIdentifier < 0) {
        throw new TypeError('current user identifier is invalid');
    }
    const addonPath = path.resolve(input.addonPath);
    const payload = verifyMacosPayload(addonPath, dependencies);
    const launchctl = launchctlRunner(dependencies);
    const domain = `gui/${userIdentifier}`;
    const service = `${domain}/${HELPER_ID}`;
    let registrationPromise = null;

    async function register() {
        const current = await launchctl(['print', service], { allowMissing: true });
        if (current.found) {
            requireExactProgram(current.stdout, payload.helperPath);
            return;
        }
        const plistPath = materializePrivatePlist(payload, dependencies);
        await launchctl(['bootstrap', domain, plistPath]);
        const registered = await launchctl(['print', service]);
        requireExactProgram(registered.stdout, payload.helperPath);
    }

    function ensureRegistered() {
        if (!registrationPromise) {
            const pending = Promise.resolve().then(register).catch(function (error) {
                if (registrationPromise === pending) registrationPromise = null;
                throw error;
            });
            registrationPromise = pending;
            pending.catch(function () {});
        }
        return registrationPromise;
    }

    async function repairRegistered() {
        const currentPayload = verifyMacosPayload(addonPath, dependencies);
        const current = await launchctl(['print', service], { allowMissing: true });
        if (current.found) {
            try {
                requireExactProgram(current.stdout, currentPayload.helperPath);
                return Object.freeze({
                    action: 'already-current',
                    helperPath: currentPayload.helperPath,
                });
            } catch (error) {
                if (!error || error.code !== 'PLATFORM_HELPER_REPAIR_REQUIRED') {
                    throw error;
                }
            }
            await launchctl(['bootout', service], { allowMissing: true });
        }
        const plistPath = materializePrivatePlist(currentPayload, dependencies);
        await launchctl(['bootstrap', domain, plistPath]);
        const registered = await launchctl(['print', service]);
        requireExactProgram(registered.stdout, currentPayload.helperPath);
        return Object.freeze({
            action: 'repaired',
            helperPath: currentPayload.helperPath,
        });
    }

    return Object.freeze({
        helperPath: payload.helperPath,
        ensureRegistered,
        repairRegistered,
    });
}

module.exports = { prepareMacosHelperRegistration };
