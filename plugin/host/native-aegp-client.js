'use strict';

// CEP 11 in AE 2024 embeds a Node runtime that predates the `node:` scheme.
// Bare builtin names also work on current Node, so keep this host bridge
// compatible with both runtimes.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const MAX_FRAME_BYTES = 524288;
const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES * 8;
const MAX_ENDPOINT_ENTRIES = 128;
const AUTH_CHALLENGE_BYTES = 57;
const AUTH_DECISION_BYTES = 49;
const ENDPOINT_DIRECTORY = 'aemcp-n1';
const ENDPOINT_PATTERN =
    /^d-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.endpoint$/;
const SOCKET_PATTERN = /^s-[0-9a-f]{12}\.sock$/;
const PIPE_PATTERN = /^\\\\\.\\pipe\\aemcp-n1-[0-9a-f]{12}$/;
const WINDOWS_RUNTIME_SUBDIRECTORY = 'AfterEffectsMCP';
const PLATFORM_IDS = Object.freeze({
    darwin: Object.freeze({ arch: 'arm64', platform: 'macos-arm64' }),
    win32: Object.freeze({ arch: 'x64', platform: 'windows-x64' }),
});
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// Operation ids are dot-separated and may contain camelCase segments
// (composition.selectedLayers.list, composition.frameRate.set, …).
const OP_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)+$/;
const REFERENCE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NATIVE_EXEC_CAPABILITY = 'ae.native.exec';
const CANCEL_STATES = new Set([
    'queued-cancelled',
    'running-cancel-requested',
    'running-not-cancellable',
    'already-terminal',
    'not-found',
]);
const NATIVE_WIRE_ERROR_CODES = new Set([
    'NATIVE_UNAVAILABLE',
    'NATIVE_UNSUPPORTED',
    'WIRE_VERSION_MISMATCH',
    'INVALID_REQUEST',
    'INVALID_ARGUMENT',
    'DUPLICATE_REQUEST',
    'TRACK_MATTE_COMPOSITION_MISMATCH',
    'LAYER_HAS_NO_AUDIO',
    'LAYER_HAS_NO_VIDEO',
    'PRECONDITION_FAILED',
    'STALE_LOCATOR',
    'DEADLINE_EXCEEDED',
    'CANCELLED',
    'QUEUE_FULL',
    'AE_SHUTTING_DOWN',
    'SESSION_STALE',
    'CAPABILITY_FAILED',
    'POSSIBLY_SIDE_EFFECTING_FAILURE',
]);

function nativeError(code, message, retryable, cause, structured) {
    const error = new Error(message);
    error.code = code;
    error.retryable = Boolean(retryable);
    if (cause !== undefined) error.cause = cause;
    if (structured?.sideEffect !== undefined) {
        error.sideEffect = structured.sideEffect;
    }
    if (structured?.recovery !== undefined) error.recovery = structured.recovery;
    if (structured?.details !== undefined) error.details = structured.details;
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

function nativeMutationUncertain(message, cause, operationKey) {
    return nativeError(
        'POSSIBLY_SIDE_EFFECTING_FAILURE',
        message,
        false,
        cause,
        {
            sideEffect: 'may-have-occurred',
            recovery: {
                action: 'inspect-state',
                hint: 'Inspect After Effects state and the Undo stack before retrying.',
            },
            details: {
                capabilityId: NATIVE_EXEC_CAPABILITY,
                ...(operationKey === undefined ? {} : { operationKey }),
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

function validToken(value) {
    return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function validOperationKey(value) {
    return typeof value === 'string' && value.length >= 16
        && TOKEN_PATTERN.test(value);
}

function uuidV4(randomBytes) {
    const bytes = Buffer.from(randomBytes(16));
    if (bytes.length !== 16) {
        throw nativeError(
            'NATIVE_CLIENT_INVALID',
            'random source returned an invalid UUID',
            false,
        );
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
    ].join('-');
}

function endpointDescriptor(text, socketPattern = SOCKET_PATTERN) {
    const lines = String(text).split('\n');
    if (lines.length !== 9 || lines[8] !== ''
        || lines[0] !== 'AEMCP_NATIVE_ENDPOINT_V1') {
        return null;
    }
    const names = [
        'host',
        'pid',
        'startSeconds',
        'startMicros',
        'socket',
        'wire',
        'source',
    ];
    const values = {};
    for (let index = 0; index < names.length; index += 1) {
        const prefix = names[index] + '=';
        if (!lines[index + 1].startsWith(prefix)
            || lines[index + 1].length === prefix.length) {
            return null;
        }
        values[names[index]] = lines[index + 1].slice(prefix.length);
    }
    const pid = Number(values.pid);
    const startSeconds = Number(values.startSeconds);
    const startMicros = Number(values.startMicros);
    if (!UUID_PATTERN.test(values.host)
        || !Number.isSafeInteger(pid) || pid <= 1
        || !Number.isSafeInteger(startSeconds) || startSeconds <= 0
        || !Number.isSafeInteger(startMicros) || startMicros < 0
        || startMicros >= 1000000
        || !socketPattern.test(values.socket)
        || values.wire !== '1'
        || !/^[0-9a-f]{40}$/.test(values.source)) {
        return null;
    }
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
        throw nativeError(
            'NATIVE_UNAVAILABLE',
            'native endpoint discovery requires a local macOS user identity',
            true,
        );
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
        throw nativeError(
            'NATIVE_UNAVAILABLE',
            'native runtime root is unavailable',
            true,
            cause,
        );
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
        throw nativeError(
            'NATIVE_UNAVAILABLE',
            'native endpoint directory is unavailable',
            true,
            cause,
        );
    }
    if (!Array.isArray(names) || names.length > MAX_ENDPOINT_ENTRIES) {
        throw nativeError(
            'NATIVE_UNAVAILABLE',
            'native endpoint directory exceeds its discovery bound',
            true,
        );
    }
    const endpoints = [];
    for (const name of names.sort()) {
        const match = ENDPOINT_PATTERN.exec(name);
        if (!match) continue;
        const descriptorPath = pathImpl.join(directory, name);
        let descriptor;
        try {
            const descriptorStats = fsImpl.lstatSync(descriptorPath);
            if (!descriptorStats.isFile() || descriptorStats.isSymbolicLink()
                || descriptorStats.uid !== uid || descriptorStats.nlink !== 1
                || !privateMode(descriptorStats, 0o600)
                || descriptorStats.size <= 0 || descriptorStats.size > 1024) {
                continue;
            }
            descriptor = endpointDescriptor(
                fsImpl.readFileSync(descriptorPath, 'utf8'),
            );
        } catch (_) {
            continue;
        }
        if (!descriptor || descriptor.hostInstanceId !== match[1]) continue;
        const socketPath = pathImpl.join(directory, descriptor.socketName);
        try {
            const socketStats = fsImpl.lstatSync(socketPath);
            if (!socketStats.isSocket() || socketStats.isSymbolicLink()
                || socketStats.uid !== uid || socketStats.nlink !== 1
                || !privateMode(socketStats, 0o600)) {
                continue;
            }
        } catch (_) {
            continue;
        }
        endpoints.push(Object.freeze({
            ...descriptor,
            descriptorPath,
            socketPath,
        }));
    }
    return Object.freeze(endpoints);
}

// Windows endpoint discovery: descriptors live under
// %LOCALAPPDATA%\AfterEffectsMCP\aemcp-n1\d-<uuid>.endpoint with socket=
// carrying the full \\.\pipe\aemcp-n1-<nonce> pipe path. The per-user
// profile directory and same-user pipe ACL are implementation constraints;
// pipe liveness is proven by the connection attempt itself.
function discoverWindowsEndpoints(options) {
    const input = options || {};
    const fsImpl = input.fsImpl || fs;
    const pathImpl = input.pathImpl || path;
    const env = input.env || process.env;
    let runtimeRoot = input.runtimeRoot;
    if (!runtimeRoot) {
        const base = env.LOCALAPPDATA;
        if (typeof base !== 'string' || base.length === 0) {
            throw nativeError(
                'NATIVE_UNAVAILABLE',
                'native endpoint discovery requires %LOCALAPPDATA%',
                true,
            );
        }
        runtimeRoot = pathImpl.join(base, WINDOWS_RUNTIME_SUBDIRECTORY);
    }
    const directory = pathImpl.join(runtimeRoot, ENDPOINT_DIRECTORY);
    let names;
    try {
        if (!fsImpl.lstatSync(directory).isDirectory()) {
            throw new Error('unsafe endpoint directory');
        }
        names = fsImpl.readdirSync(directory);
    } catch (cause) {
        throw nativeError(
            'NATIVE_UNAVAILABLE',
            'native endpoint directory is unavailable',
            true,
            cause,
        );
    }
    if (!Array.isArray(names) || names.length > MAX_ENDPOINT_ENTRIES) {
        throw nativeError(
            'NATIVE_UNAVAILABLE',
            'native endpoint directory exceeds its discovery bound',
            true,
        );
    }
    const endpoints = [];
    for (const name of names.sort()) {
        const match = ENDPOINT_PATTERN.exec(name);
        if (!match) continue;
        const descriptorPath = pathImpl.join(directory, name);
        let descriptor;
        try {
            const descriptorStats = fsImpl.lstatSync(descriptorPath);
            if (!descriptorStats.isFile()
                || descriptorStats.size <= 0 || descriptorStats.size > 1024) {
                continue;
            }
            descriptor = endpointDescriptor(
                fsImpl.readFileSync(descriptorPath, 'utf8'),
                PIPE_PATTERN,
            );
        } catch (_) {
            continue;
        }
        if (!descriptor || descriptor.hostInstanceId !== match[1]) continue;
        endpoints.push(Object.freeze({
            ...descriptor,
            descriptorPath,
            socketPath: descriptor.socketName,
            pipePath: descriptor.socketName,
        }));
    }
    return Object.freeze(endpoints);
}

function parseAuthChallenge(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== AUTH_CHALLENGE_BYTES
        || !bytes.subarray(0, 8).equals(Buffer.from('AEMCP-P1', 'ascii'))) {
        return null;
    }
    const challengeId = bytes.toString('ascii', 8, 17);
    const expiresInMs = bytes.readUInt32BE(17);
    const hostInstanceId = bytes.toString('ascii', 21, 57);
    if (!/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(challengeId)
        || expiresInMs < 1000 || expiresInMs > 120000
        || !UUID_PATTERN.test(hostInstanceId)) {
        return null;
    }
    return Object.freeze({ challengeId, expiresInMs, hostInstanceId });
}

function parseAuthDecision(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== AUTH_DECISION_BYTES
        || !bytes.subarray(0, 8).equals(Buffer.from('AEMCP-D1', 'ascii'))) {
        return null;
    }
    const code = bytes[8];
    const sessionId = bytes.toString('ascii', 9, 45);
    const sessionGeneration = bytes.readUInt32BE(45);
    if (code === 1) {
        if (!UUID_PATTERN.test(sessionId) || sessionGeneration === 0) return null;
        return Object.freeze({
            code: 'authorized',
            sessionId,
            sessionGeneration,
        });
    }
    const names = ['rejected', 'expired', 'revoked', 'shutting-down'];
    if (code < 2 || code > 5
        || sessionId !== '00000000-0000-0000-0000-000000000000'
        || sessionGeneration !== 0) {
        return null;
    }
    return Object.freeze({
        code: names[code - 2],
        sessionId: null,
        sessionGeneration: 0,
    });
}

function encodeFrame(value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
        throw nativeError(
            'INVALID_ARGUMENT',
            'native request exceeds the frame limit',
            false,
        );
    }
    const result = Buffer.allocUnsafe(body.length + 4);
    result.writeUInt32BE(body.length, 0);
    body.copy(result, 4);
    return result;
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce(function (result, key) {
            result[key] = canonicalize(value[key]);
            return result;
        }, {});
    }
    return value;
}

function sha256Canonical(value) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(value)), 'utf8')
        .digest('hex');
}

function capabilitiesQueryDigest(sessionId, ids, detail, limit) {
    return sha256Canonical({
        detail,
        ids: ids === undefined ? null : ids,
        limit,
        sessionId,
    });
}

function invokeRequestDigest(request) {
    return sha256Canonical(request);
}

function validNativeProgramArguments(value) {
    if (!exactKeys(value, ['operations'], ['operationKey', 'undoGroup'])
        || !Array.isArray(value.operations)
        || value.operations.length < 1 || value.operations.length > 64
        || (Object.hasOwn(value, 'operationKey')
            !== Object.hasOwn(value, 'undoGroup'))
        || (Object.hasOwn(value, 'operationKey')
            && (!validOperationKey(value.operationKey)
                || typeof value.undoGroup !== 'string'
                || value.undoGroup.length < 1 || value.undoGroup.length > 128))) {
        return false;
    }
    const names = new Set();
    return value.operations.every(function (operation) {
        if (!exactKeys(operation, ['op', 'args'], ['saveAs', 'returnAs'])
            || typeof operation.op !== 'string' || !OP_PATTERN.test(operation.op)
            || !operation.args || typeof operation.args !== 'object'
            || Array.isArray(operation.args)) {
            return false;
        }
        for (const key of ['saveAs', 'returnAs']) {
            if (!Object.hasOwn(operation, key)) continue;
            if (typeof operation[key] !== 'string'
                || !REFERENCE_PATTERN.test(operation[key])
                || names.has(operation[key])) {
                return false;
            }
            names.add(operation[key]);
        }
        return true;
    });
}

function validNativeInvokeRequest(value) {
    return exactKeys(value, [
        'requestId',
        'capabilityId',
        'capabilityVersion',
        'arguments',
        'deadlineUnixMs',
    ])
        && validToken(value.requestId)
        && value.capabilityId === NATIVE_EXEC_CAPABILITY
        && value.capabilityVersion === 1
        && validNativeProgramArguments(value.arguments)
        && Number.isSafeInteger(value.deadlineUnixMs)
        && value.deadlineUnixMs > 0;
}

function validNativeExecDescriptor(value, detail) {
    const baseKeys = [
        'cancellation',
        'compatibility',
        'detail',
        'id',
        'idempotency',
        'mutability',
        'preconditions',
        'primitiveCount',
        'requiredSkill',
        'requiredSuite',
        'risk',
        'schemaVersion',
        'sideEffectSummary',
        'summary',
        'undo',
        'valueKind',
        'version',
    ];
    const fullKeys = ['contractDigest', 'inputSchema', 'primitives', 'resultSchema'];
    if (!exactKeys(value, baseKeys, detail === 'full' ? fullKeys : [])
        || value.detail !== detail
        || value.id !== NATIVE_EXEC_CAPABILITY
        || value.version !== 1 || value.schemaVersion !== 1
        || value.risk !== 'write' || value.mutability !== 'mutating'
        || value.idempotency !== 'idempotency-key'
        || value.cancellation !== 'before-dispatch'
        || value.undo !== 'ae-undo-group'
        || value.requiredSuite !== 'generated-primitive-union'
        || value.valueKind !== 'Json'
        || value.requiredSkill !== 'builtin:skill:ae-execution-guide'
        || !Number.isSafeInteger(value.primitiveCount)
        || value.primitiveCount < 1 || value.primitiveCount > 64
        || !Array.isArray(value.preconditions)
        || value.preconditions.some(function (item) {
            return typeof item !== 'string' || item.length === 0;
        })
        || !exactKeys(value.compatibility, ['intendedPlatforms', 'status'])
        || !Array.isArray(value.compatibility.intendedPlatforms)
        || typeof value.compatibility.status !== 'string'
        || typeof value.summary !== 'string' || value.summary.length === 0
        || typeof value.sideEffectSummary !== 'string'
        || value.sideEffectSummary.length === 0) {
        return false;
    }
    if (detail === 'summary') return true;
    return SHA256_PATTERN.test(value.contractDigest)
        && value.inputSchema && typeof value.inputSchema === 'object'
        && !Array.isArray(value.inputSchema)
        && Array.isArray(value.primitives)
        && value.primitives.length === value.primitiveCount
        && value.primitives.every(function (primitive) {
            return primitive && typeof primitive === 'object'
                && !Array.isArray(primitive);
        })
        && value.resultSchema && typeof value.resultSchema === 'object'
        && !Array.isArray(value.resultSchema);
}

function validProgramOperationSummaries(operations, requested, status) {
    if (!Array.isArray(operations) || operations.length > 64) return false;
    let previous = -1;
    return operations.every(function (operation) {
        const valid = exactKeys(operation, ['index', 'op', 'status'])
            && Number.isSafeInteger(operation.index) && operation.index >= 0
            && operation.index > previous
            && operation.index < requested.length
            && operation.op === requested[operation.index].op
            && operation.status === status;
        previous = operation.index;
        return valid;
    });
}

function validProgramUndo(undo, expectedLabel) {
    if (!exactKeys(undo, ['available', 'verified'], ['groupLabel'])
        || typeof undo.available !== 'boolean' || undo.verified !== false) {
        return false;
    }
    return undo.available
        ? typeof undo.groupLabel === 'string'
            && undo.groupLabel.length >= 1 && undo.groupLabel.length <= 128
            && undo.groupLabel === expectedLabel
        : !Object.hasOwn(undo, 'groupLabel');
}

function validProgramEvidence(
    evidence,
    pending,
    requestId,
    sessionId,
    hostInstanceId,
    effect,
    verified,
) {
    return exactKeys(evidence, [
        'engine',
        'hostInstanceId',
        'sessionId',
        'requestId',
        'capabilityId',
        'capabilityVersion',
        'startedAtUnixMs',
        'completedAtUnixMs',
        'effect',
        'postcondition',
        'requestDigest',
    ])
        && evidence.engine === 'native-aegp'
        && evidence.hostInstanceId === hostInstanceId
        && evidence.sessionId === sessionId
        && evidence.requestId === requestId
        && evidence.capabilityId === NATIVE_EXEC_CAPABILITY
        && evidence.capabilityVersion === 1
        && Number.isSafeInteger(evidence.startedAtUnixMs)
        && evidence.startedAtUnixMs > 0
        && Number.isSafeInteger(evidence.completedAtUnixMs)
        && evidence.completedAtUnixMs >= evidence.startedAtUnixMs
        && evidence.effect === effect
        && evidence.requestDigest === pending.requestDigest
        && exactKeys(
            evidence.postcondition,
            ['verified', 'kind', 'algorithm', 'digest'],
        )
        && evidence.postcondition.verified === verified
        && evidence.postcondition.kind === 'native-program'
        && evidence.postcondition.algorithm === 'sha256-rfc8785-jcs-v1'
        && SHA256_PATTERN.test(evidence.postcondition.digest);
}

function programPostconditionDigest(outputs, operations) {
    return sha256Canonical({ operations, outputs });
}

function createNativeAegpClient(options) {
    const input = options || {};
    const runtime = input.runtime;
    const platformIds = runtime && PLATFORM_IDS[runtime.platform];
    if (!platformIds || runtime.arch !== platformIds.arch) {
        throw nativeError(
            'NATIVE_UNAVAILABLE',
            'native AEGP transport supports macOS arm64 and Windows x64 only',
            true,
        );
    }
    const netImpl = input.netImpl || net;
    const discoverEndpoints = input.discoverEndpoints
        || (runtime.platform === 'win32'
            ? discoverWindowsEndpoints
            : discoverNativeEndpoints);
    const randomBytes = input.randomBytes || crypto.randomBytes;
    const now = input.now || Date.now;
    const requestTimeoutMs = input.requestTimeoutMs === undefined
        ? 7000 : input.requestTimeoutMs;
    if (!Number.isSafeInteger(requestTimeoutMs)
        || requestTimeoutMs < 100 || requestTimeoutMs > 30000) {
        throw new TypeError(
            'requestTimeoutMs must be an integer between 100 and 30000',
        );
    }
    const clientInstanceId = input.clientInstanceId || uuidV4(randomBytes);
    if (!UUID_PATTERN.test(clientInstanceId)) {
        throw new TypeError('clientInstanceId must be a UUID');
    }

    let state = 'disconnected';
    let endpoint = null;
    let socket = null;
    let sessionId = null;
    let sessionGeneration = 0;
    let capabilitiesDigest = null;
    let nativeExecContractDigest = null;
    let helloIdentity = null;
    let nextRequest = 1;
    let inputBuffer = Buffer.alloc(0);
    let connectedResolve;
    let connectedReject;
    let connectedPromise = null;
    const pendingRequests = new Map();

    function pendingTransportFailure(pending, error, message) {
        return pending?.mutating
            ? nativeMutationUncertain(message, error, pending.operationKey)
            : error;
    }

    function fail(error) {
        const protocolCodes = new Set([
            ...NATIVE_WIRE_ERROR_CODES,
            'NATIVE_CONTRACT_MISMATCH',
        ]);
        const failure = error && protocolCodes.has(error.code)
            ? error
            : nativeError(
                'NATIVE_UNAVAILABLE',
                'native AEGP connection failed',
                true,
                error,
            );
        if (connectedReject) connectedReject(failure);
        connectedResolve = null;
        connectedReject = null;
        for (const pending of pendingRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(pendingTransportFailure(
                pending,
                failure,
                'Native AEGP connection failed after mutation dispatch.',
            ));
        }
        pendingRequests.clear();
        if (state !== 'closed') state = 'disconnected';
        sessionId = null;
        sessionGeneration = 0;
        capabilitiesDigest = null;
        nativeExecContractDigest = null;
        helloIdentity = null;
        if (socket) {
            const current = socket;
            socket = null;
            try { current.destroy(); } catch (_) {}
        }
    }

    function responseError(response, pending) {
        const error = response?.error;
        if (!exactKeys(
            error,
            ['code', 'message', 'retryable', 'sideEffect', 'recovery'],
            ['details'],
        )
            || typeof error.code !== 'string'
            || !NATIVE_WIRE_ERROR_CODES.has(error.code)
            || typeof error.message !== 'string' || error.message.length === 0
            || typeof error.retryable !== 'boolean'
            || !['not-started', 'may-have-occurred', 'completed']
                .includes(error.sideEffect)
            || !error.recovery || typeof error.recovery !== 'object'
            || Array.isArray(error.recovery)
            || typeof error.recovery.action !== 'string'
            || typeof error.recovery.hint !== 'string') {
            return pendingTransportFailure(
                pending,
                nativeContractMismatch(
                    'native AEGP returned a malformed error payload',
                ),
                'Native AEGP returned an unverifiable mutation error after dispatch.',
            );
        }
        if (pending?.capabilityId === NATIVE_EXEC_CAPABILITY
            && error.details !== undefined) {
            const details = error.details;
            const disposition = details?.disposition;
            const sideEffect = disposition === 'possibly-side-effecting'
                ? 'may-have-occurred'
                : disposition === 'completed' ? 'completed' : 'not-started';
            const effect = disposition === 'possibly-side-effecting'
                ? 'may-have-occurred' : 'none';
            const completed = details?.completedOperations;
            const valid = exactKeys(details, [
                'capabilityId',
                'disposition',
                'completedOperations',
                'outputs',
                'evidence',
                'undo',
            ], ['operationKey', 'failedOperation'])
                && details.capabilityId === NATIVE_EXEC_CAPABILITY
                && ['not-started', 'completed', 'possibly-side-effecting']
                    .includes(disposition)
                && error.sideEffect === sideEffect
                && validProgramOperationSummaries(
                    completed,
                    pending.operations,
                    'completed',
                )
                && details.outputs && typeof details.outputs === 'object'
                && !Array.isArray(details.outputs)
                && Object.keys(details.outputs).length <= 64
                && (details.failedOperation === undefined
                    || validProgramOperationSummaries(
                        [details.failedOperation],
                        pending.operations,
                        'failed',
                    ))
                && (pending.operationKey === undefined
                    ? details.operationKey === undefined
                    : details.operationKey === pending.operationKey)
                && validProgramEvidence(
                    details.evidence,
                    pending,
                    response.requestId,
                    sessionId,
                    endpoint.hostInstanceId,
                    effect,
                    false,
                )
                && details.evidence.postcondition.digest
                    === programPostconditionDigest(details.outputs, completed)
                && validProgramUndo(details.undo, pending.undoGroup)
                && (disposition !== 'not-started'
                    || (completed.length === 0
                        && Object.keys(details.outputs).length === 0
                        && details.failedOperation === undefined
                        && details.undo.available === false))
                && (disposition !== 'possibly-side-effecting'
                    || (error.code === 'POSSIBLY_SIDE_EFFECTING_FAILURE'
                        && details.operationKey === pending.operationKey));
            if (!valid) {
                return pendingTransportFailure(
                    pending,
                    nativeContractMismatch(
                        'native AEGP returned a malformed native program failure',
                    ),
                    'Native AEGP returned an unverifiable program failure after dispatch.',
                );
            }
        }
        // Program-terminal failures must carry their details envelope;
        // session/transport-level typed errors (DUPLICATE_REQUEST,
        // SESSION_STALE, …) have none and pass through as typed errors.
        if (pending?.capabilityId === NATIVE_EXEC_CAPABILITY
            && error.details === undefined
            && ['POSSIBLY_SIDE_EFFECTING_FAILURE', 'PRECONDITION_FAILED',
                'STALE_LOCATOR', 'CAPABILITY_FAILED', 'NATIVE_UNSUPPORTED',
                'INVALID_ARGUMENT'].includes(error.code)) {
            return pendingTransportFailure(
                pending,
                nativeContractMismatch(
                    'native AEGP omitted the native program failure details',
                ),
                'Native AEGP returned an unverifiable program failure after dispatch.',
            );
        }
        return nativeError(
            error.code,
            error.message,
            error.retryable,
            undefined,
            error,
        );
    }

    function handleFrame(body) {
        let response;
        try {
            response = JSON.parse(body.toString('utf8'));
        } catch (cause) {
            throw nativeContractMismatch(
                'native AEGP returned malformed JSON',
                cause,
            );
        }
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
            throw nativeContractMismatch(
                'native AEGP returned an invalid envelope',
            );
        }
        if (response.kind === 'event') return;
        const pending = pendingRequests.get(response.requestId);
        const replayValid = pending?.method === 'invoke'
            ? typeof response.replayed === 'boolean'
            : response.replayed === false;
        if (!pending || response.wireVersion !== 1
            || response.kind !== 'response'
            || response.method !== pending.method
            || !replayValid
            || (pending.method !== 'hello' && response.sessionId !== sessionId)) {
            throw nativeContractMismatch(
                'native AEGP response did not match an active request',
            );
        }
        if (response.ok === true && pending.method === 'invoke') {
            const evidence = response.result?.evidence;
            if (evidence?.requestId !== response.requestId
                || evidence?.sessionId !== sessionId
                || evidence?.capabilityId !== NATIVE_EXEC_CAPABILITY
                || evidence?.capabilityVersion !== 1
                || evidence?.requestDigest !== pending.requestDigest) {
                throw nativeContractMismatch(
                    'native AEGP evidence did not match its response envelope',
                );
            }
        }
        pendingRequests.delete(response.requestId);
        clearTimeout(pending.timer);
        if (response.ok === true) {
            pending.resolve(pending.method === 'invoke'
                ? { ...response.result, replayed: response.replayed }
                : response.result);
        } else {
            pending.reject(responseError(response, pending));
        }
    }

    function consumeFrames() {
        while (inputBuffer.length >= 4) {
            const length = inputBuffer.readUInt32BE(0);
            if (length === 0 || length > MAX_FRAME_BYTES) {
                throw nativeContractMismatch(
                    'native AEGP returned an invalid frame size',
                );
            }
            if (inputBuffer.length < length + 4) return;
            const body = inputBuffer.subarray(4, length + 4);
            inputBuffer = inputBuffer.subarray(length + 4);
            handleFrame(body);
        }
    }

    function send(method, params, options) {
        if (!socket || (method !== 'hello' && state !== 'connected')) {
            return Promise.reject(nativeError(
                'NATIVE_UNAVAILABLE',
                'native AEGP session is not connected',
                true,
            ));
        }
        const call = options || {};
        const deadlineUnixMs = call.deadlineUnixMs;
        if (deadlineUnixMs !== undefined
            && (!Number.isSafeInteger(deadlineUnixMs)
                || deadlineUnixMs <= now())) {
            return Promise.reject(nativeError(
                'DEADLINE_EXCEEDED',
                'native AEGP request deadline elapsed before dispatch',
                true,
            ));
        }
        const requestId = call.requestId
            || method + '-' + String(nextRequest++)
                + '-' + randomBytes(4).toString('hex');
        if (!validToken(requestId)) {
            return Promise.reject(nativeError(
                'INVALID_ARGUMENT',
                'native AEGP request ID is invalid',
                false,
            ));
        }
        if (pendingRequests.has(requestId)) {
            return Promise.reject(nativeError(
                'DUPLICATE_REQUEST',
                'native AEGP request ID is already in flight',
                false,
            ));
        }
        const request = {
            wireVersion: 1,
            kind: 'request',
            requestId,
            method,
            params,
        };
        if (method !== 'hello') request.sessionId = sessionId;
        if (deadlineUnixMs !== undefined) request.deadlineUnixMs = deadlineUnixMs;
        const requestDigest = method === 'invoke'
            ? invokeRequestDigest(request) : null;
        const mutating = method === 'invoke'
            && params.capabilityId === NATIVE_EXEC_CAPABILITY
            && typeof params.arguments?.operationKey === 'string';
        return new Promise(function (resolve, reject) {
            const remainingMs = deadlineUnixMs === undefined
                ? requestTimeoutMs : Math.max(1, deadlineUnixMs - now());
            const timer = setTimeout(function () {
                pendingRequests.delete(requestId);
                reject(mutating
                    ? nativeMutationUncertain(
                        'Native mutation response timed out after dispatch.',
                        undefined,
                        params.arguments.operationKey,
                    )
                    : nativeError(
                        'DEADLINE_EXCEEDED',
                        'native AEGP request timed out',
                        true,
                    ));
            }, Math.min(requestTimeoutMs, remainingMs));
            pendingRequests.set(requestId, {
                method,
                requestDigest,
                capabilityId: method === 'invoke'
                    ? NATIVE_EXEC_CAPABILITY : null,
                mutating,
                operationKey: method === 'invoke'
                    ? params.arguments.operationKey : undefined,
                undoGroup: method === 'invoke'
                    ? params.arguments.undoGroup : undefined,
                operations: method === 'invoke'
                    ? params.arguments.operations : undefined,
                resolve,
                reject,
                timer,
            });
            try {
                socket.write(encodeFrame(request), function (error) {
                    if (!error) return;
                    const pending = pendingRequests.get(requestId);
                    if (!pending) return;
                    pendingRequests.delete(requestId);
                    clearTimeout(pending.timer);
                    pending.reject(pendingTransportFailure(
                        pending,
                        nativeError(
                            'NATIVE_UNAVAILABLE',
                            'native AEGP request write failed',
                            true,
                            error,
                        ),
                        'Native mutation transport write failed after dispatch may have begun.',
                    ));
                });
            } catch (cause) {
                pendingRequests.delete(requestId);
                clearTimeout(timer);
                reject(mutating
                    ? nativeMutationUncertain(
                        'Native mutation transport write failed after dispatch may have begun.',
                        cause,
                        params.arguments.operationKey,
                    )
                    : nativeError(
                        'NATIVE_UNAVAILABLE',
                        'native AEGP request write failed',
                        true,
                        cause,
                    ));
            }
        });
    }

    async function hello(deadlineUnixMs) {
        const nonce = randomBytes(24).toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
        const result = await send('hello', {
            supportedWireVersions: { minimum: 1, maximum: 1 },
            client: {
                component: input.component || 'core-broker',
        version: input.version || '0.9.6',
                instanceId: clientInstanceId,
            },
            nonce,
        }, { deadlineUnixMs });
        if (!exactKeys(result, [
            'selectedWireVersion',
            'pluginVersion',
            'compiledSdk',
            'host',
            'sessionId',
            'sessionGeneration',
            'limits',
            'capabilitiesDigest',
            'clientNonce',
        ])
            || result.selectedWireVersion !== 1
            || result.sessionId !== sessionId
            || result.sessionGeneration !== sessionGeneration
            || result.clientNonce !== nonce
            || !SHA256_PATTERN.test(result.capabilitiesDigest)
            || result.host?.instanceId !== endpoint.hostInstanceId
            || result.host?.application !== 'after-effects'
            || result.host?.platform !== platformIds.platform
            || result.compiledSdk?.architecture !== platformIds.arch) {
            throw nativeContractMismatch(
                'native AEGP hello identity did not match discovery',
            );
        }
        capabilitiesDigest = result.capabilitiesDigest;
        helloIdentity = Object.freeze({
            ...result,
            sourceCommit: endpoint.sourceCommit,
        });
        return result;
    }

    function onData(chunk) {
        try {
            if (!chunk || inputBuffer.length + chunk.length > MAX_BUFFERED_BYTES) {
                throw nativeContractMismatch(
                    'native AEGP buffered input exceeded its bound',
                );
            }
            inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
            if (state === 'challenge-pending') {
                if (inputBuffer.length < AUTH_CHALLENGE_BYTES) return;
                const challenge = parseAuthChallenge(
                    inputBuffer.subarray(0, AUTH_CHALLENGE_BYTES),
                );
                inputBuffer = inputBuffer.subarray(AUTH_CHALLENGE_BYTES);
                if (!challenge
                    || challenge.hostInstanceId !== endpoint.hostInstanceId) {
                    throw nativeContractMismatch(
                        'native compatibility challenge did not match discovery',
                    );
                }
                state = 'decision-pending';
            }
            if (state === 'decision-pending') {
                if (inputBuffer.length < AUTH_DECISION_BYTES) return;
                const decision = parseAuthDecision(
                    inputBuffer.subarray(0, AUTH_DECISION_BYTES),
                );
                inputBuffer = inputBuffer.subarray(AUTH_DECISION_BYTES);
                if (!decision) {
                    throw nativeContractMismatch(
                        'native authorization decision was malformed',
                    );
                }
                if (decision.code !== 'authorized') {
                    throw nativeError(
                        'NATIVE_UNAVAILABLE',
                        'native authorization was ' + decision.code,
                        decision.code === 'expired',
                    );
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
            if (state === 'authenticating' || state === 'connected') {
                consumeFrames();
            }
        } catch (error) {
            fail(error);
        }
    }

    function open(candidate) {
        endpoint = candidate;
        inputBuffer = Buffer.alloc(0);
        state = 'challenge-pending';
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
                fail(nativeError(
                    'NATIVE_UNAVAILABLE',
                    'native AEGP connection closed',
                    true,
                ));
            }
        });
        current.once('connect', function () {
            if (socket !== current) return;
            const preface = Buffer.concat([
                Buffer.from('AEMCP-A1', 'ascii'),
                randomBytes(16),
            ]);
            current.write(preface, function (error) {
                if (error && socket === current) {
                    fail(nativeError(
                        'NATIVE_UNAVAILABLE',
                        'native authorization preface failed',
                        true,
                        error,
                    ));
                }
            });
        });
    }

    function boundByDeadline(promise, deadlineUnixMs, message) {
        if (deadlineUnixMs === undefined) return promise;
        if (!Number.isSafeInteger(deadlineUnixMs) || deadlineUnixMs <= now()) {
            return Promise.reject(nativeError(
                'DEADLINE_EXCEEDED',
                message,
                true,
            ));
        }
        return new Promise(function (resolve, reject) {
            const timer = setTimeout(function () {
                reject(nativeError('DEADLINE_EXCEEDED', message, true));
            }, Math.min(
                requestTimeoutMs,
                Math.max(1, deadlineUnixMs - now()),
            ));
            promise.then(function (value) {
                clearTimeout(timer);
                resolve(value);
            }, function (error) {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    function connect(deadlineUnixMs) {
        if (state === 'closed') {
            return Promise.reject(nativeError(
                'NATIVE_UNAVAILABLE',
                'native AEGP client is closed',
                false,
            ));
        }
        if (state === 'connected') {
            return boundByDeadline(
                Promise.resolve(helloIdentity),
                deadlineUnixMs,
                'native connection deadline elapsed',
            );
        }
        if (connectedPromise && state !== 'disconnected') {
            return boundByDeadline(
                connectedPromise,
                deadlineUnixMs,
                'native connection deadline elapsed',
            );
        }
        let endpoints;
        try {
            endpoints = discoverEndpoints(input);
        } catch (error) {
            return Promise.reject(error);
        }
        if (endpoints.length !== 1) {
            return Promise.reject(nativeError(
                'NATIVE_UNAVAILABLE',
                endpoints.length === 0
                    ? 'no native AEGP endpoint is available'
                    : 'multiple native AEGP endpoints require host selection',
                true,
            ));
        }
        connectedPromise = new Promise(function (resolve, reject) {
            connectedResolve = resolve;
            connectedReject = reject;
        });
        connectedPromise.catch(function () {});
        try {
            open(endpoints[0]);
        } catch (cause) {
            fail(nativeError(
                'NATIVE_UNAVAILABLE',
                'native AEGP connection could not be opened',
                true,
                cause,
            ));
        }
        return boundByDeadline(
            connectedPromise,
            deadlineUnixMs,
            'native connection deadline elapsed',
        );
    }

    function waitUntilConnected(deadlineUnixMs) {
        if (state === 'connected') {
            return boundByDeadline(
                Promise.resolve(helloIdentity),
                deadlineUnixMs,
                'native connection deadline elapsed',
            );
        }
        return connect(deadlineUnixMs);
    }

    async function negotiate(options) {
        const call = options || {};
        if (call.deadlineUnixMs !== undefined
            && (!Number.isSafeInteger(call.deadlineUnixMs)
                || call.deadlineUnixMs <= now())) {
            throw nativeError(
                'DEADLINE_EXCEEDED',
                'native negotiation deadline elapsed',
                true,
            );
        }
        if (state !== 'connected') {
            await waitUntilConnected(call.deadlineUnixMs);
        }
        if (call.deadlineUnixMs !== undefined
            && call.deadlineUnixMs <= now()) {
            throw nativeError(
                'DEADLINE_EXCEEDED',
                'native negotiation deadline elapsed',
                true,
            );
        }
        if (!helloIdentity) {
            throw nativeContractMismatch(
                'native hello identity is unavailable',
            );
        }
        return helloIdentity;
    }

    async function capabilities(options) {
        const call = typeof options === 'string'
            ? { detail: options } : (options || {});
        const requestedDetail = call.detail || 'full';
        const limit = call.limit === undefined ? 100 : call.limit;
        const ids = call.ids === null || call.ids === undefined
            ? undefined : call.ids;
        if (!['summary', 'full'].includes(requestedDetail)
            || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
            || (ids !== undefined
                && (!Array.isArray(ids) || ids.length === 0 || ids.length > 32
                    || ids.some(function (id) { return !validToken(id); })
                    || new Set(ids).size !== ids.length))) {
            throw nativeError(
                'INVALID_ARGUMENT',
                'native capabilities query is invalid',
                false,
            );
        }
        if (state !== 'connected') {
            await waitUntilConnected(call.deadlineUnixMs);
        }
        const params = { detail: requestedDetail, limit };
        if (ids !== undefined) params.ids = ids;
        const result = await send('capabilities', params, {
            deadlineUnixMs: call.deadlineUnixMs,
        });
        const expectedCount = ids === undefined
            || ids.includes(NATIVE_EXEC_CAPABILITY) ? 1 : 0;
        if (!exactKeys(result, [
            'detail',
            'items',
            'nextCursor',
            'queryDigest',
            'capabilitiesDigest',
        ])
            || result.detail !== requestedDetail
            || !Array.isArray(result.items)
            || result.items.length !== expectedCount
            || result.items.some(function (item) {
                return !validNativeExecDescriptor(item, requestedDetail);
            })
            || result.nextCursor !== null
            || result.queryDigest !== capabilitiesQueryDigest(
                sessionId,
                ids,
                requestedDetail,
                limit,
            )
            || result.capabilitiesDigest !== capabilitiesDigest) {
            throw nativeContractMismatch(
                'native capabilities result was malformed',
            );
        }
        if (requestedDetail === 'full' && result.items.length === 1) {
            nativeExecContractDigest = result.items[0].contractDigest;
        }
        return result;
    }

    async function invoke(options) {
        const call = options || {};
        if (!validNativeInvokeRequest(call)) {
            throw nativeError(
                'INVALID_ARGUMENT',
                'native invoke request must be one closed ae.native.exec program',
                false,
            );
        }
        if (state !== 'connected') {
            await waitUntilConnected(call.deadlineUnixMs);
        }
        const result = await send('invoke', {
            capabilityId: NATIVE_EXEC_CAPABILITY,
            capabilityVersion: 1,
            arguments: call.arguments,
        }, {
            requestId: call.requestId,
            deadlineUnixMs: call.deadlineUnixMs,
        });
        const mutating = Object.hasOwn(call.arguments, 'operationKey');
        const operationsValid = validProgramOperationSummaries(
            result?.operations,
            call.arguments.operations,
            'completed',
        ) && result.operations.length === call.arguments.operations.length;
        const outputsValid = result?.outputs
            && typeof result.outputs === 'object'
            && !Array.isArray(result.outputs)
            && Object.keys(result.outputs).length <= 64;
        const undoValid = validProgramUndo(
            result?.undo,
            call.arguments.undoGroup,
        ) && result.undo.available === mutating;
        const evidenceValid = validProgramEvidence(
            result?.evidence,
            {
                requestDigest: invokeRequestDigest({
                    wireVersion: 1,
                    kind: 'request',
                    sessionId,
                    requestId: call.requestId,
                    method: 'invoke',
                    params: {
                        capabilityId: NATIVE_EXEC_CAPABILITY,
                        capabilityVersion: 1,
                        arguments: call.arguments,
                    },
                    deadlineUnixMs: call.deadlineUnixMs,
                }),
            },
            call.requestId,
            sessionId,
            endpoint.hostInstanceId,
            mutating ? 'committed' : 'none',
            true,
        );
        const valid = exactKeys(result, [
            'capabilityId',
            'outputs',
            'operations',
            'evidence',
            'undo',
            'replayed',
        ], ['operationKey'])
            && result.capabilityId === NATIVE_EXEC_CAPABILITY
            && (mutating
                ? result.operationKey === call.arguments.operationKey
                : result.operationKey === undefined)
            && typeof result.replayed === 'boolean'
            && operationsValid && outputsValid && undoValid && evidenceValid
            && result.evidence.postcondition.digest
                === programPostconditionDigest(
                    result.outputs,
                    result.operations,
                );
        if (!valid) {
            if (mutating) {
                throw nativeMutationUncertain(
                    'Native program result lacked a closed verified terminal.',
                    undefined,
                    call.arguments.operationKey,
                );
            }
            throw nativeContractMismatch(
                'native program result lacked a closed verified terminal',
            );
        }
        return result;
    }

    async function cancel(options) {
        const call = options || {};
        if (!exactKeys(call, [
            'requestId',
            'targetRequestId',
            'deadlineUnixMs',
        ])
            || !validToken(call.requestId)
            || !validToken(call.targetRequestId)
            || !Number.isSafeInteger(call.deadlineUnixMs)
            || call.deadlineUnixMs <= 0
            || call.requestId === call.targetRequestId) {
            throw nativeError(
                'INVALID_ARGUMENT',
                'native cancellation request is invalid',
                false,
            );
        }
        if (state !== 'connected') {
            await waitUntilConnected(call.deadlineUnixMs);
        }
        const result = await send('cancel', {
            targetRequestId: call.targetRequestId,
        }, {
            requestId: call.requestId,
            deadlineUnixMs: call.deadlineUnixMs,
        });
        if (!exactKeys(result, [
            'targetRequestId',
            'state',
            'terminalResponseExpected',
        ])
            || result.targetRequestId !== call.targetRequestId
            || !CANCEL_STATES.has(result.state)
            || typeof result.terminalResponseExpected !== 'boolean') {
            throw nativeContractMismatch(
                'native cancellation result was malformed',
            );
        }
        return result;
    }

    async function invalidateProjectGraph(options) {
        const call = options || {};
        if (!exactKeys(call, ['deadlineUnixMs'])
            || !Number.isSafeInteger(call.deadlineUnixMs)
            || call.deadlineUnixMs <= 0) {
            throw nativeError(
                'INVALID_ARGUMENT',
                'native project graph invalidation request is invalid',
                false,
            );
        }
        if (state !== 'connected') {
            await waitUntilConnected(call.deadlineUnixMs);
        }
        const result = await send(
            'invalidateGraph',
            { reason: 'cep-jsx' },
            { deadlineUnixMs: call.deadlineUnixMs },
        );
        if (!exactKeys(result, ['generation', 'invalidated'])
            || !Number.isSafeInteger(result.generation)
            || result.generation < 0
            || typeof result.invalidated !== 'boolean'
            || (result.invalidated
                ? result.generation < 1 : result.generation !== 0)) {
            throw nativeContractMismatch(
                'native project graph invalidation result was malformed',
            );
        }
        return result;
    }

    async function close() {
        if (state === 'closed') return;
        state = 'closed';
        fail(nativeError(
            'NATIVE_UNAVAILABLE',
            'native AEGP client was closed',
            false,
        ));
        state = 'closed';
    }

    return Object.freeze({
        connect,
        waitUntilConnected,
        negotiate,
        capabilities,
        invoke,
        cancel,
        invalidateProjectGraph,
        close,
        status: function () {
            return Object.freeze({
                state,
                hostInstanceId: endpoint?.hostInstanceId || null,
                sourceCommit: endpoint?.sourceCommit || null,
                sessionId,
                sessionGeneration: sessionGeneration || null,
                capabilitiesDigest,
                nativeExecContractDigest,
            });
        },
    });
}

module.exports = {
    createNativeAegpClient,
    discoverNativeEndpoints,
    discoverWindowsEndpoints,
    endpointDescriptor,
    parseAuthChallenge,
    parseAuthDecision,
    encodeFrame,
    validNativeProgramArguments,
    validNativeInvokeRequest,
};
