'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const MAX_FRAME_BYTES = 65536;
const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES * 8;
const MAX_ENDPOINT_ENTRIES = 128;
const AUTH_PENDING_BYTES = 57;
const AUTH_DECISION_BYTES = 49;
const ENDPOINT_DIRECTORY = 'aemcp-n1';
const ENDPOINT_PATTERN = /^d-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.endpoint$/;
const SOCKET_PATTERN = /^s-[0-9a-f]{12}\.sock$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NATIVE_WIRE_ERROR_CODES = new Set([
    'NATIVE_UNAVAILABLE', 'NATIVE_UNSUPPORTED', 'WIRE_VERSION_MISMATCH',
    'INVALID_REQUEST', 'INVALID_ARGUMENT', 'DUPLICATE_REQUEST',
    'PRECONDITION_FAILED', 'STALE_LOCATOR', 'DEADLINE_EXCEEDED', 'CANCELLED',
    'QUEUE_FULL', 'AE_SHUTTING_DOWN', 'SESSION_STALE', 'CAPABILITY_FAILED',
    'POSSIBLY_SIDE_EFFECTING_FAILURE',
]);

function nativeError(code, message, retryable, cause, structured) {
    const error = new Error(message);
    error.code = code;
    error.retryable = Boolean(retryable);
    if (cause !== undefined) error.cause = cause;
    if (structured && structured.sideEffect !== undefined) error.sideEffect = structured.sideEffect;
    if (structured && structured.recovery !== undefined) error.recovery = structured.recovery;
    if (structured && structured.details !== undefined) error.details = structured.details;
    return error;
}

function nativeContractMismatch(message, cause) {
    return nativeError(
        'NATIVE_CONTRACT_MISMATCH',
        message,
        false,
        cause,
        {
            sideEffect: 'not-started',
            recovery: {
                action: 'refresh-capabilities',
                hint: 'Refresh the authenticated native contract before retrying.',
            },
        },
    );
}

function exactKeys(value, required, optional) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(required.concat(optional || []));
    return required.every(function (key) { return Object.hasOwn(value, key); })
        && Object.keys(value).every(function (key) { return allowed.has(key); });
}

function uuidV4(randomBytes) {
    const bytes = Buffer.from(randomBytes(16));
    if (bytes.length !== 16) throw nativeError('NATIVE_CLIENT_INVALID', 'random source returned an invalid UUID', false);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function endpointDescriptor(text) {
    const lines = String(text).split('\n');
    if (lines.length !== 9 || lines[8] !== '' || lines[0] !== 'AEMCP_NATIVE_ENDPOINT_V1') return null;
    const names = ['host', 'pid', 'startSeconds', 'startMicros', 'socket', 'wire', 'source'];
    const values = {};
    for (let index = 0; index < names.length; index += 1) {
        const prefix = names[index] + '=';
        if (!lines[index + 1].startsWith(prefix) || lines[index + 1].length === prefix.length) return null;
        values[names[index]] = lines[index + 1].slice(prefix.length);
    }
    const pid = Number(values.pid);
    const startSeconds = Number(values.startSeconds);
    const startMicros = Number(values.startMicros);
    if (!UUID_PATTERN.test(values.host)
        || !Number.isSafeInteger(pid) || pid <= 1
        || !Number.isSafeInteger(startSeconds) || startSeconds <= 0
        || !Number.isSafeInteger(startMicros) || startMicros < 0 || startMicros >= 1000000
        || !SOCKET_PATTERN.test(values.socket)
        || values.wire !== '1'
        || !/^[0-9a-f]{40}$/.test(values.source)) return null;
    return Object.freeze({
        hostInstanceId: values.host,
        pid,
        startSeconds,
        startMicros,
        socketName: values.socket,
        wireVersion: 1,
        sourceCommit: values.source,
    });
}

function privateMode(stats, mode) {
    return (stats.mode & 0o777) === mode;
}

function discoverNativeEndpoints(options) {
    const input = options || {};
    const fsImpl = input.fsImpl || fs;
    const osImpl = input.osImpl || os;
    const pathImpl = input.pathImpl || path;
    const uid = input.uid === undefined
        ? (typeof process.getuid === 'function' ? process.getuid() : null)
        : input.uid;
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw nativeError('NATIVE_UNAVAILABLE', 'native endpoint discovery requires a local macOS user identity', true);
    }
    let runtimeRoot;
    try {
        runtimeRoot = fsImpl.realpathSync(input.runtimeRoot || osImpl.tmpdir());
        const runtimeStats = fsImpl.lstatSync(runtimeRoot);
        if (!runtimeStats.isDirectory() || runtimeStats.isSymbolicLink()
            || runtimeStats.uid !== uid || (runtimeStats.mode & 0o077) !== 0) {
            throw new Error('unsafe runtime root');
        }
    } catch (cause) {
        throw nativeError('NATIVE_UNAVAILABLE', 'native runtime root is unavailable', true, cause);
    }
    const directory = pathImpl.join(runtimeRoot, ENDPOINT_DIRECTORY);
    let names;
    try {
        const directoryStats = fsImpl.lstatSync(directory);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
            || directoryStats.uid !== uid || !privateMode(directoryStats, 0o700)) {
            throw new Error('unsafe endpoint directory');
        }
        names = fsImpl.readdirSync(directory);
    } catch (cause) {
        throw nativeError('NATIVE_UNAVAILABLE', 'native endpoint directory is unavailable', true, cause);
    }
    if (!Array.isArray(names) || names.length > MAX_ENDPOINT_ENTRIES) {
        throw nativeError('NATIVE_UNAVAILABLE', 'native endpoint directory exceeds its discovery bound', true);
    }
    const endpoints = [];
    for (const name of names.sort()) {
        const match = ENDPOINT_PATTERN.exec(name);
        if (!match) continue;
        const descriptorPath = pathImpl.join(directory, name);
        let descriptor;
        let descriptorStats;
        try {
            descriptorStats = fsImpl.lstatSync(descriptorPath);
            if (!descriptorStats.isFile() || descriptorStats.isSymbolicLink()
                || descriptorStats.uid !== uid || descriptorStats.nlink !== 1
                || !privateMode(descriptorStats, 0o600)
                || descriptorStats.size <= 0 || descriptorStats.size > 1024) continue;
            descriptor = endpointDescriptor(fsImpl.readFileSync(descriptorPath, 'utf8'));
        } catch (_) {
            continue;
        }
        if (!descriptor || descriptor.hostInstanceId !== match[1]) continue;
        const socketPath = pathImpl.join(directory, descriptor.socketName);
        try {
            const socketStats = fsImpl.lstatSync(socketPath);
            if (!socketStats.isSocket() || socketStats.isSymbolicLink()
                || socketStats.uid !== uid || socketStats.nlink !== 1
                || !privateMode(socketStats, 0o600)) continue;
        } catch (_) {
            continue;
        }
        endpoints.push(Object.freeze({ ...descriptor, descriptorPath, socketPath }));
    }
    return Object.freeze(endpoints);
}

function parseAuthPending(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== AUTH_PENDING_BYTES
        || !bytes.subarray(0, 8).equals(Buffer.from('AEMCP-P1', 'ascii'))) return null;
    const fingerprint = bytes.toString('ascii', 8, 17);
    const expiresInMs = bytes.readUInt32BE(17);
    const hostInstanceId = bytes.toString('ascii', 21, 57);
    if (!/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(fingerprint)
        || expiresInMs < 1000 || expiresInMs > 120000
        || !UUID_PATTERN.test(hostInstanceId)) return null;
    return Object.freeze({ fingerprint, expiresInMs, hostInstanceId });
}

function parseAuthDecision(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== AUTH_DECISION_BYTES
        || !bytes.subarray(0, 8).equals(Buffer.from('AEMCP-D1', 'ascii'))) return null;
    const code = bytes[8];
    const sessionId = bytes.toString('ascii', 9, 45);
    const sessionGeneration = bytes.readUInt32BE(45);
    if (code === 1) {
        if (!UUID_PATTERN.test(sessionId) || sessionGeneration === 0) return null;
        return Object.freeze({ code: 'authorized', sessionId, sessionGeneration });
    }
    const names = ['rejected', 'expired', 'revoked', 'shutting-down'];
    if (code < 2 || code > 5
        || sessionId !== '00000000-0000-0000-0000-000000000000'
        || sessionGeneration !== 0) return null;
    return Object.freeze({ code: names[code - 2], sessionId: null, sessionGeneration: 0 });
}

function encodeFrame(value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
        throw nativeError('INVALID_ARGUMENT', 'native request exceeds the frame limit', false);
    }
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return frame;
}

function sha256Canonical(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function capabilitiesQueryDigest(sessionId, ids, detail, limit) {
    return sha256Canonical({
        detail,
        ids: ids === undefined ? null : ids,
        limit,
        sessionId,
    });
}

function projectSummaryPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: 'ae.project.summary',
        capabilityVersion: 1,
        value: {
            itemCount: value.itemCount,
            projectName: value.projectName,
            projectOpen: value.projectOpen,
        },
    });
}

// This client currently exposes one closed invoke contract. Construct the
// RFC 8785 member order explicitly so the broker can bind native evidence to
// the exact request it sent instead of trusting a digest-shaped string.
function projectSummaryRequestDigest(request) {
    return sha256Canonical({
        deadlineUnixMs: request.deadlineUnixMs,
        kind: request.kind,
        method: request.method,
        params: {
            arguments: request.params.arguments,
            capabilityId: request.params.capabilityId,
            capabilityVersion: request.params.capabilityVersion,
        },
        requestId: request.requestId,
        sessionId: request.sessionId,
        wireVersion: request.wireVersion,
    });
}

function createNativeAegpClient(options) {
    const input = options || {};
    const runtime = input.runtime;
    if (!runtime || runtime.platform !== 'darwin' || runtime.arch !== 'arm64') {
        throw nativeError('NATIVE_UNAVAILABLE', 'native AEGP transport currently supports macOS arm64 only', true);
    }
    const netImpl = input.netImpl || net;
    const discoverEndpoints = input.discoverEndpoints || discoverNativeEndpoints;
    const randomBytes = input.randomBytes || crypto.randomBytes;
    const now = input.now || Date.now;
    const requestTimeoutMs = input.requestTimeoutMs === undefined ? 7000 : input.requestTimeoutMs;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30000) {
        throw new TypeError('requestTimeoutMs must be an integer between 100 and 30000');
    }
    const clientInstanceId = input.clientInstanceId || uuidV4(randomBytes);
    if (!UUID_PATTERN.test(clientInstanceId)) throw new TypeError('clientInstanceId must be a UUID');

    let state = 'disconnected';
    let endpoint = null;
    let socket = null;
    let sessionId = null;
    let sessionGeneration = 0;
    let capabilitiesDigest = null;
    let projectSummaryContractDigest = null;
    let helloIdentity = null;
    let nextRequest = 1;
    let inputBuffer = Buffer.alloc(0);
    let pairingResolve;
    let pairingReject;
    let connectedResolve;
    let connectedReject;
    let pairingPromise = null;
    let connectedPromise = null;
    const pendingRequests = new Map();

    function fail(error) {
        const protocolCodes = new Set([
            ...NATIVE_WIRE_ERROR_CODES, 'AUTH_REQUIRED', 'NATIVE_CONTRACT_MISMATCH',
        ]);
        const failure = error && protocolCodes.has(error.code)
            ? error : nativeError('NATIVE_UNAVAILABLE', 'native AEGP connection failed', true, error);
        if (pairingReject) pairingReject(failure);
        if (connectedReject) connectedReject(failure);
        pairingResolve = null;
        pairingReject = null;
        connectedResolve = null;
        connectedReject = null;
        for (const pending of pendingRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(failure);
        }
        pendingRequests.clear();
        if (state !== 'closed') state = 'disconnected';
        sessionId = null;
        sessionGeneration = 0;
        capabilitiesDigest = null;
        projectSummaryContractDigest = null;
        helloIdentity = null;
        if (socket) {
            const current = socket;
            socket = null;
            try { current.destroy(); } catch (_) {}
        }
    }

    function responseError(response) {
        const error = response && response.error;
        if (!exactKeys(error, ['code', 'message', 'retryable', 'sideEffect', 'recovery'], ['details'])
            || typeof error.code !== 'string' || !NATIVE_WIRE_ERROR_CODES.has(error.code)
            || typeof error.message !== 'string' || error.message.length === 0
            || typeof error.retryable !== 'boolean'
            || !['not-started', 'may-have-occurred', 'completed'].includes(error.sideEffect)
            || !error.recovery || typeof error.recovery !== 'object' || Array.isArray(error.recovery)
            || typeof error.recovery.action !== 'string' || typeof error.recovery.hint !== 'string') {
            return nativeContractMismatch('native AEGP returned a malformed error payload');
        }
        return nativeError(error.code, error.message, error.retryable, undefined, error);
    }

    function handleFrame(frame) {
        let response;
        try { response = JSON.parse(frame.toString('utf8')); } catch (cause) {
            throw nativeContractMismatch('native AEGP returned malformed JSON', cause);
        }
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
            throw nativeContractMismatch('native AEGP returned an invalid envelope');
        }
        if (response.kind === 'event') return;
        const pending = pendingRequests.get(response.requestId);
        if (!pending || response.wireVersion !== 1 || response.kind !== 'response'
            || response.method !== pending.method
            || (pending.method !== 'hello' && response.sessionId !== sessionId)) {
            throw nativeContractMismatch('native AEGP response did not match an active request');
        }
        if (response.ok === true && pending.method === 'invoke') {
            const evidence = response.result?.evidence;
            if (evidence?.requestId !== response.requestId
                || evidence?.sessionId !== sessionId
                || evidence?.capabilityId !== 'ae.project.summary'
                || evidence?.capabilityVersion !== 1
                || evidence?.requestDigest !== pending.requestDigest) {
                throw nativeContractMismatch('native AEGP evidence did not match its response envelope');
            }
        }
        pendingRequests.delete(response.requestId);
        clearTimeout(pending.timer);
        if (response.ok === true) pending.resolve(response.result);
        else pending.reject(responseError(response));
    }

    function consumeFrames() {
        while (inputBuffer.length >= 4) {
            const length = inputBuffer.readUInt32BE(0);
            if (length === 0 || length > MAX_FRAME_BYTES) {
                throw nativeContractMismatch('native AEGP returned an invalid frame size');
            }
            if (inputBuffer.length < length + 4) return;
            const frame = inputBuffer.subarray(4, length + 4);
            inputBuffer = inputBuffer.subarray(length + 4);
            handleFrame(frame);
        }
    }

    function send(method, params, options) {
        if (!socket || (method !== 'hello' && state !== 'connected')) {
            return Promise.reject(nativeError('NATIVE_UNAVAILABLE', 'native AEGP session is not connected', true));
        }
        const call = options || {};
        const deadlineUnixMs = call.deadlineUnixMs;
        if (deadlineUnixMs !== undefined
            && (!Number.isSafeInteger(deadlineUnixMs) || deadlineUnixMs <= now())) {
            return Promise.reject(nativeError('DEADLINE_EXCEEDED', 'native AEGP request deadline elapsed before dispatch', true));
        }
        const requestId = call.requestId
            || method + '-' + String(nextRequest++) + '-' + randomBytes(4).toString('hex');
        if (!TOKEN_PATTERN.test(requestId)) {
            return Promise.reject(nativeError('INVALID_ARGUMENT', 'native AEGP request ID is invalid', false));
        }
        if (pendingRequests.has(requestId)) {
            return Promise.reject(nativeError('DUPLICATE_REQUEST', 'native AEGP request ID is already in flight', false));
        }
        const request = { wireVersion: 1, kind: 'request', requestId, method, params };
        if (method !== 'hello') request.sessionId = sessionId;
        if (deadlineUnixMs !== undefined) request.deadlineUnixMs = deadlineUnixMs;
        const requestDigest = method === 'invoke' ? projectSummaryRequestDigest(request) : null;
        return new Promise(function (resolve, reject) {
            const remainingMs = deadlineUnixMs === undefined
                ? requestTimeoutMs : Math.max(1, deadlineUnixMs - now());
            const timer = setTimeout(function () {
                pendingRequests.delete(requestId);
                reject(nativeError('DEADLINE_EXCEEDED', 'native AEGP request timed out', true));
            }, Math.min(requestTimeoutMs, remainingMs));
            pendingRequests.set(requestId, { method, requestDigest, resolve, reject, timer });
            try {
                socket.write(encodeFrame(request), function (error) {
                    if (!error) return;
                    const pending = pendingRequests.get(requestId);
                    if (!pending) return;
                    pendingRequests.delete(requestId);
                    clearTimeout(pending.timer);
                    pending.reject(nativeError('NATIVE_UNAVAILABLE', 'native AEGP request write failed', true, error));
                });
            } catch (cause) {
                pendingRequests.delete(requestId);
                clearTimeout(timer);
                reject(nativeError('NATIVE_UNAVAILABLE', 'native AEGP request write failed', true, cause));
            }
        });
    }

    async function hello(deadlineUnixMs) {
        const nonce = randomBytes(24).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        const result = await send('hello', {
            supportedWireVersions: { minimum: 1, maximum: 1 },
            client: { component: input.component || 'core-broker', version: input.version || '0.9.2', instanceId: clientInstanceId },
            nonce,
        }, { deadlineUnixMs });
        if (!exactKeys(result, [
            'selectedWireVersion', 'pluginVersion', 'compiledSdk', 'host', 'sessionId',
            'sessionGeneration', 'limits', 'capabilitiesDigest', 'clientNonce',
        ]) || result.selectedWireVersion !== 1 || result.sessionId !== sessionId
            || result.sessionGeneration !== sessionGeneration || result.clientNonce !== nonce
            || !SHA256_PATTERN.test(result.capabilitiesDigest)
            || result.host?.instanceId !== endpoint.hostInstanceId
            || result.host?.application !== 'after-effects'
            || result.host?.platform !== 'macos-arm64'
            || result.compiledSdk?.architecture !== 'arm64') {
            throw nativeContractMismatch('native AEGP hello identity did not match discovery');
        }
        capabilitiesDigest = result.capabilitiesDigest;
        helloIdentity = Object.freeze({ ...result, sourceCommit: endpoint.sourceCommit });
        return result;
    }

    function onData(chunk) {
        try {
            if (!chunk || inputBuffer.length + chunk.length > MAX_BUFFERED_BYTES) {
                throw nativeContractMismatch('native AEGP buffered input exceeded its bound');
            }
            inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
            if (state === 'pairing-pending') {
                if (inputBuffer.length < AUTH_PENDING_BYTES) return;
                const pending = parseAuthPending(inputBuffer.subarray(0, AUTH_PENDING_BYTES));
                inputBuffer = inputBuffer.subarray(AUTH_PENDING_BYTES);
                if (!pending || pending.hostInstanceId !== endpoint.hostInstanceId) {
                    throw nativeContractMismatch('native pairing challenge did not match discovery');
                }
                state = 'pairing-decision';
                const resolve = pairingResolve;
                pairingResolve = null;
                pairingReject = null;
                resolve(Object.freeze({ ...pending, sourceCommit: endpoint.sourceCommit }));
            }
            if (state === 'pairing-decision') {
                if (inputBuffer.length < AUTH_DECISION_BYTES) return;
                const decision = parseAuthDecision(inputBuffer.subarray(0, AUTH_DECISION_BYTES));
                inputBuffer = inputBuffer.subarray(AUTH_DECISION_BYTES);
                if (!decision) throw nativeContractMismatch('native pairing decision was malformed');
                if (decision.code !== 'authorized') {
                    throw nativeError('AUTH_REQUIRED', 'native pairing was ' + decision.code, decision.code === 'expired');
                }
                sessionId = decision.sessionId;
                sessionGeneration = decision.sessionGeneration;
                state = 'authenticating';
                hello().then(function (identity) {
                    state = 'connected';
                    const resolve = connectedResolve;
                    connectedResolve = null;
                    connectedReject = null;
                    resolve(identity);
                    if (inputBuffer.length) consumeFrames();
                }).catch(fail);
                return;
            }
            if (state === 'authenticating' || state === 'connected') consumeFrames();
        } catch (error) {
            fail(error);
        }
    }

    function open(candidate) {
        endpoint = candidate;
        inputBuffer = Buffer.alloc(0);
        state = 'pairing-pending';
        const current = netImpl.createConnection({ path: candidate.socketPath });
        socket = current;
        current.on('data', function (chunk) {
            if (socket === current) onData(chunk);
        });
        current.on('error', function (error) {
            if (socket === current) fail(error);
        });
        current.on('close', function () {
            if (socket !== current) return;
            if (state !== 'closed' && state !== 'disconnected') {
                fail(nativeError('NATIVE_UNAVAILABLE', 'native AEGP connection closed', true));
            }
        });
        current.once('connect', function () {
            if (socket !== current) return;
            const preface = Buffer.concat([Buffer.from('AEMCP-A1', 'ascii'), randomBytes(16)]);
            current.write(preface, function (error) {
                if (error && socket === current) {
                    fail(nativeError('NATIVE_UNAVAILABLE', 'native pairing preface failed', true, error));
                }
            });
        });
    }

    function boundByDeadline(promise, deadlineUnixMs, message) {
        if (deadlineUnixMs === undefined) return promise;
        if (!Number.isSafeInteger(deadlineUnixMs) || deadlineUnixMs <= now()) {
            return Promise.reject(nativeError('DEADLINE_EXCEEDED', message, true));
        }
        return new Promise(function (resolve, reject) {
            const timer = setTimeout(function () {
                reject(nativeError('DEADLINE_EXCEEDED', message, true));
            }, Math.min(requestTimeoutMs, Math.max(1, deadlineUnixMs - now())));
            promise.then(function (value) {
                clearTimeout(timer);
                resolve(value);
            }, function (error) {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    function beginPairing(deadlineUnixMs) {
        if (state === 'closed') return Promise.reject(nativeError('NATIVE_UNAVAILABLE', 'native AEGP client is closed', false));
        if (pairingPromise && state.startsWith('pairing')) {
            return boundByDeadline(pairingPromise, deadlineUnixMs, 'native pairing deadline elapsed');
        }
        if (state === 'connected' || state === 'authenticating') {
            return Promise.reject(nativeError('DUPLICATE_REQUEST', 'native AEGP client is already connected', false));
        }
        let endpoints;
        try { endpoints = discoverEndpoints(input); } catch (error) { return Promise.reject(error); }
        if (endpoints.length !== 1) {
            return Promise.reject(nativeError(
                'NATIVE_UNAVAILABLE',
                endpoints.length === 0 ? 'no native AEGP endpoint is available' : 'multiple native AEGP endpoints require host selection',
                true,
            ));
        }
        pairingPromise = new Promise(function (resolve, reject) {
            pairingResolve = resolve;
            pairingReject = reject;
        });
        connectedPromise = new Promise(function (resolve, reject) {
            connectedResolve = resolve;
            connectedReject = reject;
        });
        // The connection may outlive the HTTP request that surfaced the pairing
        // fingerprint. Mark this promise handled without changing what a later
        // waitUntilConnected() caller observes.
        connectedPromise.catch(function () {});
        try {
            open(endpoints[0]);
        } catch (cause) {
            fail(nativeError('NATIVE_UNAVAILABLE', 'native AEGP connection could not be opened', true, cause));
        }
        return boundByDeadline(pairingPromise, deadlineUnixMs, 'native pairing deadline elapsed');
    }

    function waitUntilConnected(deadlineUnixMs) {
        if (state === 'connected') {
            return boundByDeadline(
                Promise.resolve(helloIdentity), deadlineUnixMs, 'native connection deadline elapsed',
            );
        }
        if (!connectedPromise) return Promise.reject(nativeError('AUTH_REQUIRED', 'begin native pairing first', false));
        return boundByDeadline(connectedPromise, deadlineUnixMs, 'native connection deadline elapsed');
    }

    async function negotiate(options) {
        const call = options || {};
        if (call.deadlineUnixMs !== undefined
            && (!Number.isSafeInteger(call.deadlineUnixMs) || call.deadlineUnixMs <= now())) {
            throw nativeError('DEADLINE_EXCEEDED', 'native negotiation deadline elapsed', true);
        }
        if (state !== 'connected') await waitUntilConnected(call.deadlineUnixMs);
        if (call.deadlineUnixMs !== undefined && call.deadlineUnixMs <= now()) {
            throw nativeError('DEADLINE_EXCEEDED', 'native negotiation deadline elapsed', true);
        }
        if (!helloIdentity) {
            throw nativeContractMismatch('native hello identity is unavailable');
        }
        return helloIdentity;
    }

    async function capabilities(options) {
        const call = typeof options === 'string' ? { detail: options } : (options || {});
        const requestedDetail = call.detail || 'full';
        const limit = call.limit === undefined ? 100 : call.limit;
        const ids = call.ids === null || call.ids === undefined ? undefined : call.ids;
        if (!['summary', 'full'].includes(requestedDetail)
            || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
            || (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > 32
                || ids.some(function (id) { return typeof id !== 'string' || !TOKEN_PATTERN.test(id); })
                || new Set(ids).size !== ids.length))) {
            throw nativeError('INVALID_ARGUMENT', 'native capabilities query is invalid', false);
        }
        if (state !== 'connected') await waitUntilConnected(call.deadlineUnixMs);
        const params = { detail: requestedDetail, limit };
        // Omission is protocol-significant: no filter is represented on the
        // wire by an absent member, while its canonical query digest uses
        // ids:null. Never serialize a JavaScript null for this field.
        if (ids !== undefined) params.ids = ids;
        const result = await send('capabilities', params, {
            deadlineUnixMs: call.deadlineUnixMs,
        });
        const item = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === 'ae.project.summary'; })
            : null;
        if (!exactKeys(result, ['detail', 'items', 'nextCursor', 'queryDigest', 'capabilitiesDigest'])
            || result.detail !== requestedDetail || result.nextCursor !== null
            || result.queryDigest !== capabilitiesQueryDigest(sessionId, ids, requestedDetail, limit)
            || result.capabilitiesDigest !== capabilitiesDigest
            || (ids === undefined && !item)
            || (item && (item.version !== 1 || item.detail !== requestedDetail
                || (requestedDetail === 'full' && !SHA256_PATTERN.test(item.contractDigest))))) {
            throw nativeContractMismatch('native capabilities result was malformed');
        }
        if (requestedDetail === 'full' && item) projectSummaryContractDigest = item.contractDigest;
        return result;
    }

    async function invoke(options) {
        const call = options || {};
        if (!exactKeys(call, [
            'requestId', 'capabilityId', 'capabilityVersion', 'arguments', 'deadlineUnixMs',
        ]) || !TOKEN_PATTERN.test(call.requestId || '')
            || call.capabilityId !== 'ae.project.summary' || call.capabilityVersion !== 1
            || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)
            || Object.keys(call.arguments).length !== 0
            || !Number.isSafeInteger(call.deadlineUnixMs) || call.deadlineUnixMs <= 0) {
            throw nativeError('INVALID_ARGUMENT', 'native invoke request is invalid', false);
        }
        if (state !== 'connected') await waitUntilConnected(call.deadlineUnixMs);
        const result = await send('invoke', {
            capabilityId: call.capabilityId,
            capabilityVersion: call.capabilityVersion,
            arguments: call.arguments,
        }, { requestId: call.requestId, deadlineUnixMs: call.deadlineUnixMs });
        const value = result?.value;
        const evidence = result?.evidence;
        if (result?.capabilityId !== 'ae.project.summary' || result?.capabilityVersion !== 1
            || result?.engine !== 'native-aegp' || result?.outcome !== 'succeeded'
            || evidence?.engine !== 'native-aegp' || evidence?.hostInstanceId !== endpoint.hostInstanceId
            || evidence?.sessionId !== sessionId || evidence?.effect !== 'none'
            || !TOKEN_PATTERN.test(evidence?.requestId || '')
            || !SHA256_PATTERN.test(evidence?.requestDigest || '')
            || !Number.isSafeInteger(evidence?.startedAtUnixMs) || evidence.startedAtUnixMs <= 0
            || !Number.isSafeInteger(evidence?.completedAtUnixMs)
            || evidence.completedAtUnixMs < evidence.startedAtUnixMs
            || evidence?.postcondition?.verified !== true
            || evidence.postcondition.kind !== 'project-summary'
            || evidence.postcondition.algorithm !== 'sha256-rfc8785-jcs-v1'
            || !SHA256_PATTERN.test(evidence.postcondition.digest || '')
            || typeof value?.projectOpen !== 'boolean' || typeof value?.projectName !== 'string'
            || value.projectName.length > 1024
            || !Number.isSafeInteger(value?.itemCount) || value.itemCount < 0
            || !SHA256_PATTERN.test(projectSummaryContractDigest || '')
            || evidence.postcondition.digest !== projectSummaryPostconditionDigest(value)) {
            throw nativeContractMismatch('native project summary result lacked verified AEGP evidence');
        }
        return result;
    }

    async function projectSummary() {
        return invoke({
            requestId: 'invoke-' + String(nextRequest++) + '-' + randomBytes(4).toString('hex'),
            capabilityId: 'ae.project.summary',
            capabilityVersion: 1,
            arguments: {},
            deadlineUnixMs: now() + Math.min(requestTimeoutMs, 5000),
        });
    }

    async function close() {
        if (state === 'closed') return;
        state = 'closed';
        fail(nativeError('NATIVE_UNAVAILABLE', 'native AEGP client was closed', false));
        state = 'closed';
    }

    return Object.freeze({
        beginPairing,
        waitUntilConnected,
        negotiate,
        capabilities,
        invoke,
        projectSummary,
        close,
        status: function () {
            return Object.freeze({
                state,
                hostInstanceId: endpoint?.hostInstanceId || null,
                sourceCommit: endpoint?.sourceCommit || null,
                sessionId,
                sessionGeneration: sessionGeneration || null,
                capabilitiesDigest,
                projectSummaryContractDigest,
            });
        },
    });
}

module.exports = {
    createNativeAegpClient,
    discoverNativeEndpoints,
    endpointDescriptor,
    parseAuthPending,
    parseAuthDecision,
    encodeFrame,
};
