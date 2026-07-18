'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const projectCompositionContracts = require('./native-project-composition-contract');

const MAX_FRAME_BYTES = 131072;
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
const PROJECT_SUMMARY_CAPABILITY = 'ae.project.summary';
const PROJECT_BIT_DEPTH_READ_CAPABILITY = 'ae.project.bit-depth.read';
const PROJECT_BIT_DEPTH_SET_CAPABILITY = 'ae.project.bit-depth.set';
const PROJECT_ITEMS_LIST_CAPABILITY = 'ae.project.items.list';
const COMPOSITION_LAYERS_LIST_CAPABILITY = 'ae.composition.layers.list';
const COMPOSITION_SELECTED_LAYERS_LIST_CAPABILITY = 'ae.composition.selected-layers.list';
const COMPOSITION_TIME_READ_CAPABILITY = 'ae.composition.time.read';
const COMPOSITION_TIME_SET_CAPABILITY = 'ae.composition.time.set';
const COMPOSITION_CREATE_CAPABILITY = 'ae.composition.create';
const COMPOSITION_LAYER_CREATE_CAPABILITY = 'ae.composition.layer.create';
const LAYER_EFFECT_APPLY_CAPABILITY = 'ae.layer.effect.apply';
const LAYER_PROPERTIES_LIST_CAPABILITY = 'ae.layer.properties.list';
const LAYER_PROPERTY_KEYFRAMES_LIST_CAPABILITY = 'ae.layer.property.keyframes.list';
const LAYER_PROPERTY_SET_CAPABILITY = 'ae.layer.property.set';
const PROJECT_BIT_DEPTH_READ_CONTRACT_DIGEST = '936b86f89c99418bb570b9671569951ee10177efa70e8f4b72303a01dba0db6e';
const PROJECT_BIT_DEPTH_SET_CONTRACT_DIGEST = 'd5d11180b22293db667353e0861485e1633c2881ed96891744fd94d69910d80a';
const PROJECT_ITEMS_LIST_CONTRACT_DIGEST = '64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e';
const COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST = '3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75';
const COMPOSITION_SELECTED_LAYERS_LIST_CONTRACT_DIGEST = '3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75';
const COMPOSITION_TIME_READ_CONTRACT_DIGEST = 'fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd';
const COMPOSITION_TIME_SET_CONTRACT_DIGEST = '724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308';
const COMPOSITION_CREATE_CONTRACT_DIGEST = '0e65175a0d85640eda3eb58b08d4cabc0aa9f085068225e1b44f9cf01467310d';
const COMPOSITION_LAYER_CREATE_CONTRACT_DIGEST = 'd48b5c0fcf9871ee579bf518679bc36277e2fd5194e70d9cc6fa1b2c573edeee';
const LAYER_EFFECT_APPLY_CONTRACT_DIGEST = '5de12c7cd4ede09122a837c85ff2e589f695dd5377490b97b9de9d975ce00d77';
// Kept in lockstep with the full descriptor in capabilities.json. The native
// protocol build replaces this value only when the closed contract changes.
const LAYER_PROPERTIES_LIST_CONTRACT_DIGEST = 'a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba';
const LAYER_PROPERTY_KEYFRAMES_LIST_CONTRACT_DIGEST = 'f089d4cd1d35f492df660cbd83667968b2add70b5353172253691e33758e42bb';
const LAYER_PROPERTY_SET_CONTRACT_DIGEST = '5cb9b24ac33125823b08d1dcc43839bf1b568fd02da22b8fb3c30bb3c722689c';
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

function nativeMutationUncertain(message, capabilityId, cause) {
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
            details: { capabilityId },
        },
    );
}

function exactKeys(value, required, optional) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(required.concat(optional || []));
    return required.every(function (key) { return Object.hasOwn(value, key); })
        && Object.keys(value).every(function (key) { return allowed.has(key); });
}

function unicodeScalarLength(value) {
    if (typeof value !== 'string') return null;
    let length = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return null;
        }
        length += 1;
    }
    return length;
}

function validBoundedUnicodeString(value, maximum) {
    const length = unicodeScalarLength(value);
    return length !== null && length <= maximum;
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

function canonicalizeForDigest(value) {
    if (Array.isArray(value)) return value.map(canonicalizeForDigest);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce(function (result, key) {
            result[key] = canonicalizeForDigest(value[key]);
            return result;
        }, {});
    }
    return value;
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

function projectBitDepthReadPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: PROJECT_BIT_DEPTH_READ_CAPABILITY,
        capabilityVersion: 1,
        value: {
            bitsPerChannel: value.bitsPerChannel,
        },
    });
}

function projectBitDepthSetPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: PROJECT_BIT_DEPTH_SET_CAPABILITY,
        capabilityVersion: 1,
        value: {
            afterBitsPerChannel: value.afterBitsPerChannel,
            beforeBitsPerChannel: value.beforeBitsPerChannel,
            changed: value.changed,
        },
    });
}

function validProjectBitDepthSetArguments(value) {
    return exactKeys(value, ['targetDepth', 'idempotencyKey'])
        && [8, 16, 32].includes(value.targetDepth)
        && typeof value.idempotencyKey === 'string'
        && value.idempotencyKey.length >= 16 && TOKEN_PATTERN.test(value.idempotencyKey);
}

function validLocator(value, kinds) {
    return exactKeys(value, [
        'kind', 'hostInstanceId', 'sessionId', 'projectId', 'generation', 'objectId',
    ])
        && kinds.includes(value.kind)
        && UUID_PATTERN.test(value.hostInstanceId)
        && UUID_PATTERN.test(value.sessionId)
        && UUID_PATTERN.test(value.projectId)
        && Number.isSafeInteger(value.generation) && value.generation > 0
        && UUID_PATTERN.test(value.objectId);
}

function locatorContextMatches(left, right) {
    return left.hostInstanceId === right.hostInstanceId
        && left.sessionId === right.sessionId
        && left.projectId === right.projectId
        && left.generation === right.generation;
}

function locatorsEqual(left, right) {
    return locatorContextMatches(left, right)
        && left.kind === right.kind && left.objectId === right.objectId;
}

function canonicalLocator(value) {
    return {
        generation: value.generation,
        hostInstanceId: value.hostInstanceId,
        kind: value.kind,
        objectId: value.objectId,
        projectId: value.projectId,
        sessionId: value.sessionId,
    };
}

function validProjectItemsListArguments(value) {
    return exactKeys(value, ['offset', 'limit'], ['projectLocator'])
        && Number.isSafeInteger(value.offset) && value.offset >= 0
        && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 50
        && (value.projectLocator === undefined
            ? value.offset === 0 : validLocator(value.projectLocator, ['project']));
}

function validCompositionLayersListArguments(value) {
    return exactKeys(value, ['compositionLocator', 'offset', 'limit'])
        && validLocator(value.compositionLocator, ['composition'])
        && Number.isSafeInteger(value.offset) && value.offset >= 0
        && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 50;
}

function validCompositionSelectedLayersListArguments(value) {
    return exactKeys(value, ['compositionLocator', 'offset', 'limit'])
        && validLocator(value.compositionLocator, ['composition'])
        && Number.isSafeInteger(value.offset) && value.offset >= 0
        && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 50;
}

function validCompositionTimeReadArguments(value) {
    return exactKeys(value, ['compositionLocator'])
        && validLocator(value.compositionLocator, ['composition']);
}

function validCompositionTime(value, includeRational) {
    const required = includeRational
        ? ['value', 'scale', 'secondsRational'] : ['value', 'scale'];
    if (!exactKeys(value, required)
        || !Number.isInteger(value.value)
        || value.value < -2147483648 || value.value > 2147483647
        || !Number.isInteger(value.scale)
        || value.scale < 1 || value.scale > 4294967295) return false;
    if (!includeRational) return true;
    return typeof value.secondsRational === 'string'
        && value.secondsRational.length >= 1
        && value.secondsRational.length <= 28
        && /^(?:0|-?[1-9][0-9]*(?:\/[1-9][0-9]*)?)$/.test(value.secondsRational)
        && value.secondsRational === reducedRational(value.value, value.scale);
}

function compositionTimesEqual(left, right) {
    return BigInt(left.value) * BigInt(right.scale)
        === BigInt(right.value) * BigInt(left.scale);
}

function validCompositionTimeSetArguments(value) {
    return exactKeys(value, ['compositionLocator', 'targetTime', 'idempotencyKey'])
        && validLocator(value.compositionLocator, ['composition'])
        && validCompositionTime(value.targetTime, false)
        && typeof value.idempotencyKey === 'string'
        && value.idempotencyKey.length >= 16
        && TOKEN_PATTERN.test(value.idempotencyKey);
}

function validPositiveRatio(value, includeRational) {
    const required = includeRational
        ? ['numerator', 'denominator', 'rational']
        : ['numerator', 'denominator'];
    if (!exactKeys(value, required)
        || !Number.isInteger(value.numerator) || value.numerator < 1
        || value.numerator > 2147483647
        || !Number.isInteger(value.denominator) || value.denominator < 1
        || value.denominator > 2147483647) return false;
    if (!includeRational) return true;
    return typeof value.rational === 'string'
        && value.rational === reducedRational(value.numerator, value.denominator);
}

function positiveRatiosEqual(left, right) {
    return BigInt(left.numerator) * BigInt(right.denominator)
        === BigInt(right.numerator) * BigInt(left.denominator);
}

function validCompositionCreateArguments(value) {
    return exactKeys(value, [
        'name', 'width', 'height', 'duration', 'frameRate',
        'pixelAspectRatio', 'idempotencyKey',
    ])
        && unicodeScalarLength(value.name) !== null
        && unicodeScalarLength(value.name) >= 1
        && unicodeScalarLength(value.name) <= 255
        && !value.name.includes('\u0000')
        && Number.isInteger(value.width) && value.width >= 1 && value.width <= 30000
        && Number.isInteger(value.height) && value.height >= 1 && value.height <= 30000
        && validCompositionTime(value.duration, false) && value.duration.value > 0
        && validPositiveRatio(value.frameRate, false)
        && validPositiveRatio(value.pixelAspectRatio, false)
        && typeof value.idempotencyKey === 'string'
        && value.idempotencyKey.length >= 16
        && TOKEN_PATTERN.test(value.idempotencyKey);
}

function validCompositionLayerCreateColor(value) {
    return exactKeys(value, ['red', 'green', 'blue', 'alpha'])
        && ['red', 'green', 'blue', 'alpha'].every(function (channel) {
            return Number.isInteger(value[channel])
                && value[channel] >= 0 && value[channel] <= 255;
        });
}

function validCompositionLayerCreateArguments(value) {
    if (!exactKeys(value, [
        'compositionLocator', 'kind', 'name', 'idempotencyKey',
    ], ['color', 'width', 'height', 'duration'])
        || !validLocator(value.compositionLocator, ['composition'])
        || !['null', 'solid'].includes(value.kind)
        || unicodeScalarLength(value.name) === null
        || unicodeScalarLength(value.name) < 1
        || unicodeScalarLength(value.name) > 255
        || typeof value.idempotencyKey !== 'string'
        || value.idempotencyKey.length < 16
        || !TOKEN_PATTERN.test(value.idempotencyKey)) return false;
    const solidOnlyProvided = ['color', 'width', 'height', 'duration'].some(function (key) {
        return Object.hasOwn(value, key);
    });
    return !(value.kind === 'null' && solidOnlyProvided)
        && (value.color === undefined || validCompositionLayerCreateColor(value.color))
        && (value.width === undefined
            || (Number.isInteger(value.width) && value.width >= 1 && value.width <= 30000))
        && (value.height === undefined
            || (Number.isInteger(value.height) && value.height >= 1 && value.height <= 30000))
        && (value.duration === undefined || validCompositionTime(value.duration, false));
}

function validLayerEffectApplyArguments(value) {
    const matchNameLength = unicodeScalarLength(value?.effectMatchName);
    return exactKeys(value, ['layerLocator', 'effectMatchName', 'idempotencyKey'])
        && validLocator(value.layerLocator, ['layer'])
        && matchNameLength !== null && matchNameLength >= 1 && matchNameLength <= 47
        && typeof value.idempotencyKey === 'string'
        && value.idempotencyKey.length >= 16
        && TOKEN_PATTERN.test(value.idempotencyKey);
}

function validLayerPropertiesListArguments(value) {
    return exactKeys(value, ['layerLocator', 'offset', 'limit'], ['parentPropertyLocator'])
        && validLocator(value.layerLocator, ['layer'])
        && Number.isSafeInteger(value.offset) && value.offset >= 0
        && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 25
        && (value.parentPropertyLocator === undefined
            || value.parentPropertyLocator === null
            || validLocator(value.parentPropertyLocator, ['stream']));
}

function validLayerPropertyKeyframesListArguments(value) {
    return exactKeys(value, ['propertyLocator', 'offset', 'limit'])
        && validLocator(value.propertyLocator, ['stream'])
        && Number.isSafeInteger(value.offset) && value.offset >= 0
        && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 25;
}

function validLayerPropertySetArguments(value) {
    return exactKeys(value, [
        'layerLocator', 'propertyLocator', 'value', 'idempotencyKey',
    ])
        && validLocator(value.layerLocator, ['layer'])
        && validLocator(value.propertyLocator, ['stream'])
        && locatorContextMatches(value.layerLocator, value.propertyLocator)
        && (validLayerPropertySample(value.value, 'one-d')
            || validLayerPropertySample(value.value, 'two-d')
            || validLayerPropertySample(value.value, 'three-d')
            || validLayerPropertySample(value.value, 'color'))
        && typeof value.idempotencyKey === 'string'
        && value.idempotencyKey.length >= 16
        && TOKEN_PATTERN.test(value.idempotencyKey);
}

function validPageMetadata(value, members, argumentsValue) {
    if (!Number.isSafeInteger(value.total) || value.total < 0
        || value.offset !== argumentsValue.offset || value.limit !== argumentsValue.limit
        || !Number.isSafeInteger(value.returned) || value.returned < 0
        || value.returned !== members.length || value.returned > value.limit
        || value.offset + value.returned > value.total
        || typeof value.hasMore !== 'boolean') return false;
    const consumed = value.offset + value.returned;
    const hasMore = consumed < value.total;
    return (!hasMore || value.returned > 0)
        && value.hasMore === hasMore
        && value.nextOffset === (hasMore ? consumed : null);
}

function validProjectItemsListValue(value, argumentsValue, hostInstanceId, sessionId) {
    if (!exactKeys(value, [
        'projectLocator', 'total', 'offset', 'limit', 'returned', 'hasMore',
        'nextOffset', 'items',
    ]) || !validLocator(value.projectLocator, ['project'])
        || value.projectLocator.hostInstanceId !== hostInstanceId
        || value.projectLocator.sessionId !== sessionId
        || (argumentsValue.projectLocator !== undefined
            && !locatorsEqual(value.projectLocator, argumentsValue.projectLocator))
        || !Array.isArray(value.items) || value.items.length > 50
        || !validPageMetadata(value, value.items, argumentsValue)) return false;
    const objectIds = new Set();
    return value.items.every(function (item) {
        if (!exactKeys(item, ['locator', 'name', 'type', 'parentLocator'])
            || !validBoundedUnicodeString(item.name, 1024)
            || !['folder', 'composition', 'footage', 'unknown'].includes(item.type)
            || !validLocator(item.locator, ['item', 'composition'])
            || !validLocator(item.parentLocator, ['project', 'item'])
            || !locatorContextMatches(item.locator, value.projectLocator)
            || !locatorContextMatches(item.parentLocator, value.projectLocator)
            || (item.type === 'composition') !== (item.locator.kind === 'composition')
            || (item.parentLocator.kind === 'project'
                && !locatorsEqual(item.parentLocator, value.projectLocator))
            || objectIds.has(item.locator.objectId)) return false;
        objectIds.add(item.locator.objectId);
        return true;
    });
}

function validCompositionLayersListValue(value, argumentsValue, hostInstanceId, sessionId) {
    if (!exactKeys(value, [
        'compositionLocator', 'compositionName', 'total', 'offset', 'limit',
        'returned', 'hasMore', 'nextOffset', 'layers',
    ]) || !validLocator(value.compositionLocator, ['composition'])
        || !locatorsEqual(value.compositionLocator, argumentsValue.compositionLocator)
        || value.compositionLocator.hostInstanceId !== hostInstanceId
        || value.compositionLocator.sessionId !== sessionId
        || !validBoundedUnicodeString(value.compositionName, 1024)
        || !Array.isArray(value.layers) || value.layers.length > 50
        || !validPageMetadata(value, value.layers, argumentsValue)) return false;
    const objectIds = new Set();
    return value.layers.every(function (layer, index) {
        return layer.stackIndex === value.offset + index + 1
            && validCompositionLayer(layer, value.compositionLocator, objectIds);
    });
}

function validCompositionSelectedLayersListValue(
    value, argumentsValue, hostInstanceId, sessionId,
) {
    if (!exactKeys(value, [
        'compositionLocator', 'compositionName', 'total', 'offset', 'limit',
        'returned', 'hasMore', 'nextOffset', 'layers',
    ]) || !validLocator(value.compositionLocator, ['composition'])
        || !locatorsEqual(value.compositionLocator, argumentsValue.compositionLocator)
        || value.compositionLocator.hostInstanceId !== hostInstanceId
        || value.compositionLocator.sessionId !== sessionId
        || !validBoundedUnicodeString(value.compositionName, 1024)
        || !Array.isArray(value.layers) || value.layers.length > 50
        || !validPageMetadata(value, value.layers, argumentsValue)) return false;
    const objectIds = new Set();
    let previousStackIndex = 0;
    return value.layers.every(function (layer) {
        if (!Number.isSafeInteger(layer?.stackIndex) || layer.stackIndex <= previousStackIndex
            || !validCompositionLayer(layer, value.compositionLocator, objectIds)) return false;
        previousStackIndex = layer.stackIndex;
        return true;
    });
}

function validCompositionLayer(layer, compositionLocator, objectIds) {
    if (!exactKeys(layer, [
        'locator', 'stackIndex', 'name', 'type', 'videoEnabled', 'isThreeD',
        'locked', 'parentLocator', 'sourceItemLocator',
    ]) || !validLocator(layer.locator, ['layer'])
        || !Number.isSafeInteger(layer.stackIndex) || layer.stackIndex < 1
        || !validBoundedUnicodeString(layer.name, 1024)
        || ![
            'av', 'camera', 'light', 'text', 'shape', 'model3d', 'null',
            'adjustment', 'unknown',
        ].includes(layer.type)
        || typeof layer.videoEnabled !== 'boolean'
        || typeof layer.isThreeD !== 'boolean' || typeof layer.locked !== 'boolean'
        || (layer.parentLocator !== null && !validLocator(layer.parentLocator, ['layer']))
        || (layer.sourceItemLocator !== null
            && !validLocator(layer.sourceItemLocator, ['item', 'composition']))
        || !locatorContextMatches(layer.locator, compositionLocator)
        || (layer.parentLocator !== null
            && !locatorContextMatches(layer.parentLocator, compositionLocator))
        || (layer.sourceItemLocator !== null
            && !locatorContextMatches(layer.sourceItemLocator, compositionLocator))
        || objectIds.has(layer.locator.objectId)) return false;
    objectIds.add(layer.locator.objectId);
    return true;
}

function reducedRational(value, scale) {
    let left = Math.abs(value);
    let right = scale;
    while (right !== 0) {
        const remainder = left % right;
        left = right;
        right = remainder;
    }
    const divisor = left;
    const numerator = value / divisor;
    const denominator = scale / divisor;
    return denominator === 1 ? String(numerator) : String(numerator) + '/' + String(denominator);
}

function validCompositionTimeReadValue(value, argumentsValue, hostInstanceId, sessionId) {
    if (!exactKeys(value, ['compositionLocator', 'currentTime'])
        || !validLocator(value.compositionLocator, ['composition'])
        || !locatorsEqual(value.compositionLocator, argumentsValue.compositionLocator)
        || value.compositionLocator.hostInstanceId !== hostInstanceId
        || value.compositionLocator.sessionId !== sessionId
        || !validCompositionTime(value.currentTime, true)) return false;
    return true;
}

function validCompositionTimeSetValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, ['changed', 'compositionLocator', 'beforeTime', 'afterTime'])
        && value.changed === true
        && validLocator(value.compositionLocator, ['composition'])
        && locatorsEqual(value.compositionLocator, argumentsValue.compositionLocator)
        && value.compositionLocator.hostInstanceId === hostInstanceId
        && value.compositionLocator.sessionId === sessionId
        && validCompositionTime(value.beforeTime, true)
        && validCompositionTime(value.afterTime, true)
        && !compositionTimesEqual(value.beforeTime, value.afterTime)
        && compositionTimesEqual(value.afterTime, argumentsValue.targetTime);
}

function validCompositionCreateValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, [
        'changed', 'name', 'compositionLocator', 'projectItemCountBefore',
        'projectItemCountAfter', 'layerCount', 'width', 'height', 'duration',
        'frameRate', 'pixelAspectRatio',
    ])
        && value.changed === true && value.name === argumentsValue.name
        && validLocator(value.compositionLocator, ['composition'])
        && value.compositionLocator.hostInstanceId === hostInstanceId
        && value.compositionLocator.sessionId === sessionId
        && Number.isSafeInteger(value.projectItemCountBefore)
        && value.projectItemCountBefore >= 0
        && value.projectItemCountAfter === value.projectItemCountBefore + 1
        && value.layerCount === 0
        && value.width === argumentsValue.width && value.height === argumentsValue.height
        && validCompositionTime(value.duration, true)
        && compositionTimesEqual(value.duration, argumentsValue.duration)
        && validPositiveRatio(value.frameRate, true)
        && validPositiveRatio(value.pixelAspectRatio, true)
        && positiveRatiosEqual(value.frameRate, argumentsValue.frameRate)
        && positiveRatiosEqual(value.pixelAspectRatio, argumentsValue.pixelAspectRatio);
}

function validCompositionLayerCreateValue(value, argumentsValue, hostInstanceId, sessionId) {
    if (!exactKeys(value, [
        'changed', 'kind', 'name', 'stackIndex', 'compositionLocator',
        'layerLocator', 'sourceItemLocator', 'layerCountBefore', 'layerCountAfter',
        'projectItemCountBefore', 'projectItemCountAfter', 'solid',
    ])
        || value.changed !== true
        || value.kind !== argumentsValue.kind || value.name !== argumentsValue.name
        || !Number.isSafeInteger(value.stackIndex) || value.stackIndex < 1
        || !validLocator(value.compositionLocator, ['composition'])
        || !validLocator(value.layerLocator, ['layer'])
        || value.compositionLocator.hostInstanceId !== hostInstanceId
        || value.compositionLocator.sessionId !== sessionId
        || value.compositionLocator.generation <= argumentsValue.compositionLocator.generation
        || value.compositionLocator.projectId === argumentsValue.compositionLocator.projectId
        || !locatorContextMatches(value.compositionLocator, value.layerLocator)
        || (value.sourceItemLocator !== null
            && (!validLocator(value.sourceItemLocator, ['item', 'composition'])
                || !locatorContextMatches(value.compositionLocator, value.sourceItemLocator)))
        || !Number.isSafeInteger(value.layerCountBefore) || value.layerCountBefore < 0
        || value.layerCountAfter !== value.layerCountBefore + 1
        || value.stackIndex > value.layerCountAfter
        || !Number.isSafeInteger(value.projectItemCountBefore)
        || value.projectItemCountBefore < 0
        || !Number.isSafeInteger(value.projectItemCountAfter)
        || value.projectItemCountAfter < value.projectItemCountBefore) return false;
    if (value.kind === 'null') return value.solid === null;
    if (value.sourceItemLocator === null
        || value.projectItemCountAfter <= value.projectItemCountBefore
        || !exactKeys(value.solid, ['color', 'width', 'height', 'duration'])
        || !validCompositionLayerCreateColor(value.solid.color)
        || !Number.isInteger(value.solid.width)
        || value.solid.width < 1 || value.solid.width > 30000
        || !Number.isInteger(value.solid.height)
        || value.solid.height < 1 || value.solid.height > 30000
        || !validCompositionTime(value.solid.duration, true)) return false;
    return (argumentsValue.color === undefined
            || ['red', 'green', 'blue', 'alpha'].every(function (channel) {
                return value.solid.color[channel] === argumentsValue.color[channel];
            }))
        && (argumentsValue.width === undefined || value.solid.width === argumentsValue.width)
        && (argumentsValue.height === undefined || value.solid.height === argumentsValue.height)
        && (argumentsValue.duration === undefined
            || compositionTimesEqual(value.solid.duration, argumentsValue.duration));
}

function validLayerEffectApplyValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, [
        'changed', 'layerLocator', 'name', 'matchName', 'effectIndex',
        'effectCountBefore', 'effectCountAfter', 'matchingEffectCountBefore',
        'matchingEffectCountAfter',
    ])
        && value.changed === true
        && validLocator(value.layerLocator, ['layer'])
        && value.layerLocator.hostInstanceId === hostInstanceId
        && value.layerLocator.sessionId === sessionId
        && value.layerLocator.objectId === argumentsValue.layerLocator.objectId
        && value.layerLocator.generation > argumentsValue.layerLocator.generation
        && value.layerLocator.projectId !== argumentsValue.layerLocator.projectId
        && validBoundedUnicodeString(value.name, 47)
        && validBoundedUnicodeString(value.matchName, 47)
        && value.matchName === argumentsValue.effectMatchName
        && Number.isSafeInteger(value.effectIndex) && value.effectIndex >= 1
        && Number.isSafeInteger(value.effectCountBefore) && value.effectCountBefore >= 0
        && value.effectCountAfter === value.effectCountBefore + 1
        && value.effectIndex <= value.effectCountAfter
        && Number.isSafeInteger(value.matchingEffectCountBefore)
        && value.matchingEffectCountBefore >= 0
        && value.matchingEffectCountAfter === value.matchingEffectCountBefore + 1
        && value.matchingEffectCountAfter <= value.effectCountAfter;
}

const LAYER_PROPERTY_GROUPING_TYPES = new Set([
    'named-group', 'indexed-group', 'leaf',
]);
const LAYER_PROPERTY_VALUE_TYPES = new Set([
    'none', 'one-d', 'two-d', 'two-d-spatial', 'three-d', 'three-d-spatial',
    'color', 'arb', 'marker', 'layer-id', 'mask-id', 'mask', 'text-document',
    'unknown',
]);
const LAYER_PROPERTY_VALUE_STATUSES = new Set([
    'group', 'sampled', 'no-data', 'unsupported',
]);

function validDecimalString(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 32) return false;
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)) {
        return false;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return false;
    if (parsed === 0 && value[0] === '-') return false;
    if (parsed !== 0) return true;
    // A mathematically non-zero decimal that underflows to binary64 zero is
    // not a valid sampled value. Redundant but mathematically-zero spellings
    // remain schema-valid even though the native encoder emits just "0".
    const coefficient = value.split(/[eE]/, 1)[0];
    return !/[1-9]/.test(coefficient);
}

function validLayerPropertySample(value, valueType) {
    if (valueType === 'one-d') {
        return exactKeys(value, ['kind', 'value'])
            && value.kind === 'scalar' && validDecimalString(value.value);
    }
    if (['two-d', 'two-d-spatial', 'three-d', 'three-d-spatial'].includes(valueType)) {
        const expectedLength = valueType.startsWith('two-') ? 2 : 3;
        return exactKeys(value, ['kind', 'components'])
            && value.kind === 'vector' && Array.isArray(value.components)
            && value.components.length === expectedLength
            && value.components.every(validDecimalString);
    }
    if (valueType === 'color') {
        return exactKeys(value, ['kind', 'alpha', 'red', 'green', 'blue'])
            && value.kind === 'color'
            && validDecimalString(value.alpha)
            && validDecimalString(value.red)
            && validDecimalString(value.green)
            && validDecimalString(value.blue);
    }
    return false;
}

function validLayerPropertyEntry(property, value, argumentsValue, index, objectIds) {
    if (!exactKeys(property, [
        'propertyLocator', 'propertyIndex', 'name', 'matchName', 'groupingType',
        'childCount', 'hidden', 'disabled', 'modified', 'canVaryOverTime',
        'timeVarying', 'valueType', 'valueStatus', 'value',
    ]) || !validLocator(property.propertyLocator, ['stream'])
        || !locatorContextMatches(property.propertyLocator, value.layerLocator)
        || !Number.isSafeInteger(property.propertyIndex) || property.propertyIndex < 1
        || property.propertyIndex !== value.offset + index + 1
        || !validBoundedUnicodeString(property.name, 1024)
        || !validBoundedUnicodeString(property.matchName, 40)
        || !LAYER_PROPERTY_GROUPING_TYPES.has(property.groupingType)
        || !Number.isSafeInteger(property.childCount) || property.childCount < 0
        || typeof property.hidden !== 'boolean' || typeof property.disabled !== 'boolean'
        || typeof property.modified !== 'boolean'
        || (property.canVaryOverTime !== null
            && typeof property.canVaryOverTime !== 'boolean')
        || (property.timeVarying !== null && typeof property.timeVarying !== 'boolean')
        || !LAYER_PROPERTY_VALUE_TYPES.has(property.valueType)
        || !LAYER_PROPERTY_VALUE_STATUSES.has(property.valueStatus)
        || (value.parentPropertyLocator !== null
            && locatorsEqual(property.propertyLocator, value.parentPropertyLocator))
        || objectIds.has(property.propertyLocator.objectId)) return false;
    objectIds.add(property.propertyLocator.objectId);

    if (property.groupingType !== 'leaf') {
        return property.valueType === 'none' && property.valueStatus === 'group'
            && property.value === null && property.canVaryOverTime === null
            && property.timeVarying === null;
    }
    if (property.childCount !== 0) return false;
    if (property.valueStatus === 'sampled') {
        return validLayerPropertySample(property.value, property.valueType)
            && property.canVaryOverTime !== null && property.timeVarying !== null;
    }
    if (property.value !== null) return false;
    if (property.valueStatus === 'no-data') return property.valueType === 'none';
    if (property.valueStatus !== 'unsupported') return false;
    return [
        'arb', 'marker', 'layer-id', 'mask-id', 'mask', 'text-document', 'unknown',
    ].includes(property.valueType);
}

function validLayerPropertiesListValue(value, argumentsValue, hostInstanceId, sessionId) {
    const expectedParent = argumentsValue.parentPropertyLocator;
    if (!exactKeys(value, [
        'layerLocator', 'parentPropertyLocator', 'layerName', 'sampleTime',
        'total', 'offset', 'limit', 'returned', 'hasMore', 'nextOffset', 'properties',
    ]) || !validLocator(value.layerLocator, ['layer'])
        || !locatorsEqual(value.layerLocator, argumentsValue.layerLocator)
        || value.layerLocator.hostInstanceId !== hostInstanceId
        || value.layerLocator.sessionId !== sessionId
        || (expectedParent === undefined || expectedParent === null
            ? value.parentPropertyLocator !== null
            : !validLocator(value.parentPropertyLocator, ['stream'])
                || !locatorsEqual(value.parentPropertyLocator, expectedParent))
        || !validBoundedUnicodeString(value.layerName, 1024)
        || !exactKeys(value.sampleTime, ['value', 'scale', 'mode'])
        || !Number.isSafeInteger(value.sampleTime.value)
        || !Number.isSafeInteger(value.sampleTime.scale) || value.sampleTime.scale < 1
        || value.sampleTime.mode !== 'comp-time'
        || !Array.isArray(value.properties) || value.properties.length > 25
        || !validPageMetadata(value, value.properties, argumentsValue)) return false;
    if (value.parentPropertyLocator !== null
        && !locatorContextMatches(value.parentPropertyLocator, value.layerLocator)) return false;
    const objectIds = new Set();
    return value.properties.every(function (property, index) {
        return validLayerPropertyEntry(property, value, argumentsValue, index, objectIds);
    });
}

function validLayerPropertyKeyframesListValue(
    value, argumentsValue, hostInstanceId, sessionId,
) {
    if (!exactKeys(value, [
        'propertyLocator', 'valueType', 'total', 'offset', 'limit', 'returned',
        'hasMore', 'nextOffset', 'keyframes',
    ]) || !validLocator(value.propertyLocator, ['stream'])
        || !locatorsEqual(value.propertyLocator, argumentsValue.propertyLocator)
        || value.propertyLocator.hostInstanceId !== hostInstanceId
        || value.propertyLocator.sessionId !== sessionId
        || !['one-d', 'two-d', 'two-d-spatial', 'three-d', 'three-d-spatial', 'color']
            .includes(value.valueType)
        || !Array.isArray(value.keyframes) || value.keyframes.length > 25
        || !validPageMetadata(value, value.keyframes, argumentsValue)) return false;
    let previousTime = null;
    return value.keyframes.every(function (keyframe, index) {
        const valid = exactKeys(keyframe, [
            'keyframeIndex', 'time', 'value', 'inInterpolation', 'outInterpolation',
        ])
            && keyframe.keyframeIndex === value.offset + index + 1
            && exactKeys(keyframe.time, ['value', 'scale', 'mode'])
            && Number.isSafeInteger(keyframe.time.value)
            && Number.isSafeInteger(keyframe.time.scale) && keyframe.time.scale >= 1
            && keyframe.time.mode === 'comp-time'
            && validLayerPropertySample(keyframe.value, value.valueType)
            && ['none', 'linear', 'bezier', 'hold'].includes(keyframe.inInterpolation)
            && ['none', 'linear', 'bezier', 'hold'].includes(keyframe.outInterpolation)
            && (previousTime === null
                || BigInt(previousTime.value) * BigInt(keyframe.time.scale)
                    < BigInt(keyframe.time.value) * BigInt(previousTime.scale));
        previousTime = keyframe.time;
        return valid;
    });
}

function projectItemsListPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: PROJECT_ITEMS_LIST_CAPABILITY,
        capabilityVersion: 1,
        value: {
            hasMore: value.hasMore,
            items: value.items.map(function (item) {
                return {
                    locator: canonicalLocator(item.locator),
                    name: item.name,
                    parentLocator: canonicalLocator(item.parentLocator),
                    type: item.type,
                };
            }),
            limit: value.limit,
            nextOffset: value.nextOffset,
            offset: value.offset,
            projectLocator: canonicalLocator(value.projectLocator),
            returned: value.returned,
            total: value.total,
        },
    });
}

function compositionLayersListPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: COMPOSITION_LAYERS_LIST_CAPABILITY,
        capabilityVersion: 1,
        value: canonicalCompositionLayerPage(value),
    });
}

function compositionSelectedLayersListPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: COMPOSITION_SELECTED_LAYERS_LIST_CAPABILITY,
        capabilityVersion: 1,
        value: canonicalCompositionLayerPage(value),
    });
}

function canonicalCompositionLayerPage(value) {
    return {
        compositionLocator: canonicalLocator(value.compositionLocator),
        compositionName: value.compositionName,
        hasMore: value.hasMore,
        layers: value.layers.map(function (layer) {
            return {
                isThreeD: layer.isThreeD,
                locator: canonicalLocator(layer.locator),
                locked: layer.locked,
                name: layer.name,
                parentLocator: layer.parentLocator === null
                    ? null : canonicalLocator(layer.parentLocator),
                sourceItemLocator: layer.sourceItemLocator === null
                    ? null : canonicalLocator(layer.sourceItemLocator),
                stackIndex: layer.stackIndex,
                type: layer.type,
                videoEnabled: layer.videoEnabled,
            };
        }),
        limit: value.limit,
        nextOffset: value.nextOffset,
        offset: value.offset,
        returned: value.returned,
        total: value.total,
    };
}

function compositionTimeReadPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: COMPOSITION_TIME_READ_CAPABILITY,
        capabilityVersion: 1,
        value: {
            compositionLocator: canonicalLocator(value.compositionLocator),
            currentTime: {
                scale: value.currentTime.scale,
                secondsRational: value.currentTime.secondsRational,
                value: value.currentTime.value,
            },
        },
    });
}

function compositionTimeSetPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: COMPOSITION_TIME_SET_CAPABILITY,
        capabilityVersion: 1,
        value: {
            afterTime: {
                scale: value.afterTime.scale,
                secondsRational: value.afterTime.secondsRational,
                value: value.afterTime.value,
            },
            beforeTime: {
                scale: value.beforeTime.scale,
                secondsRational: value.beforeTime.secondsRational,
                value: value.beforeTime.value,
            },
            changed: value.changed,
            compositionLocator: canonicalLocator(value.compositionLocator),
        },
    });
}

function compositionCreatePostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: COMPOSITION_CREATE_CAPABILITY,
        capabilityVersion: 1,
        value: {
            changed: value.changed,
            compositionLocator: canonicalLocator(value.compositionLocator),
            duration: {
                scale: value.duration.scale,
                secondsRational: value.duration.secondsRational,
                value: value.duration.value,
            },
            frameRate: {
                denominator: value.frameRate.denominator,
                numerator: value.frameRate.numerator,
                rational: value.frameRate.rational,
            },
            height: value.height,
            layerCount: value.layerCount,
            name: value.name,
            pixelAspectRatio: {
                denominator: value.pixelAspectRatio.denominator,
                numerator: value.pixelAspectRatio.numerator,
                rational: value.pixelAspectRatio.rational,
            },
            projectItemCountAfter: value.projectItemCountAfter,
            projectItemCountBefore: value.projectItemCountBefore,
            width: value.width,
        },
    });
}

function compositionLayerCreatePostconditionDigest(value) {
    const solid = value.solid === null ? null : {
        color: {
            alpha: value.solid.color.alpha,
            blue: value.solid.color.blue,
            green: value.solid.color.green,
            red: value.solid.color.red,
        },
        duration: {
            scale: value.solid.duration.scale,
            secondsRational: value.solid.duration.secondsRational,
            value: value.solid.duration.value,
        },
        height: value.solid.height,
        width: value.solid.width,
    };
    return sha256Canonical({
        capabilityId: COMPOSITION_LAYER_CREATE_CAPABILITY,
        capabilityVersion: 1,
        value: {
            changed: value.changed,
            compositionLocator: canonicalLocator(value.compositionLocator),
            kind: value.kind,
            layerCountAfter: value.layerCountAfter,
            layerCountBefore: value.layerCountBefore,
            layerLocator: canonicalLocator(value.layerLocator),
            name: value.name,
            projectItemCountAfter: value.projectItemCountAfter,
            projectItemCountBefore: value.projectItemCountBefore,
            solid,
            sourceItemLocator: value.sourceItemLocator === null
                ? null : canonicalLocator(value.sourceItemLocator),
            stackIndex: value.stackIndex,
        },
    });
}

function layerEffectApplyPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: LAYER_EFFECT_APPLY_CAPABILITY,
        capabilityVersion: 1,
        value: {
            changed: value.changed,
            effectCountAfter: value.effectCountAfter,
            effectCountBefore: value.effectCountBefore,
            effectIndex: value.effectIndex,
            layerLocator: canonicalLocator(value.layerLocator),
            matchName: value.matchName,
            matchingEffectCountAfter: value.matchingEffectCountAfter,
            matchingEffectCountBefore: value.matchingEffectCountBefore,
            name: value.name,
        },
    });
}

function canonicalLayerPropertyValue(value) {
    if (value === null) return null;
    if (value.kind === 'scalar') return { kind: value.kind, value: value.value };
    if (value.kind === 'vector') {
        return { components: value.components.slice(), kind: value.kind };
    }
    return {
        alpha: value.alpha,
        blue: value.blue,
        green: value.green,
        kind: value.kind,
        red: value.red,
    };
}

function layerPropertiesListPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: LAYER_PROPERTIES_LIST_CAPABILITY,
        capabilityVersion: 1,
        value: {
            hasMore: value.hasMore,
            layerLocator: canonicalLocator(value.layerLocator),
            layerName: value.layerName,
            limit: value.limit,
            nextOffset: value.nextOffset,
            offset: value.offset,
            parentPropertyLocator: value.parentPropertyLocator === null
                ? null : canonicalLocator(value.parentPropertyLocator),
            properties: value.properties.map(function (property) {
                return {
                    canVaryOverTime: property.canVaryOverTime,
                    childCount: property.childCount,
                    disabled: property.disabled,
                    groupingType: property.groupingType,
                    hidden: property.hidden,
                    matchName: property.matchName,
                    modified: property.modified,
                    name: property.name,
                    propertyIndex: property.propertyIndex,
                    propertyLocator: canonicalLocator(property.propertyLocator),
                    timeVarying: property.timeVarying,
                    value: canonicalLayerPropertyValue(property.value),
                    valueStatus: property.valueStatus,
                    valueType: property.valueType,
                };
            }),
            returned: value.returned,
            sampleTime: {
                mode: value.sampleTime.mode,
                scale: value.sampleTime.scale,
                value: value.sampleTime.value,
            },
            total: value.total,
        },
    });
}

function layerPropertySetPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: LAYER_PROPERTY_SET_CAPABILITY,
        capabilityVersion: 1,
        value: {
            afterValue: canonicalLayerPropertyValue(value.afterValue),
            beforeValue: canonicalLayerPropertyValue(value.beforeValue),
            changed: value.changed,
            layerLocator: canonicalLocator(value.layerLocator),
            propertyLocator: canonicalLocator(value.propertyLocator),
            valueType: value.valueType,
        },
    });
}

function layerPropertyKeyframesListPostconditionDigest(value) {
    return sha256Canonical({
        capabilityId: LAYER_PROPERTY_KEYFRAMES_LIST_CAPABILITY,
        capabilityVersion: 1,
        value: {
            hasMore: value.hasMore,
            keyframes: value.keyframes.map(function (keyframe) {
                return {
                    inInterpolation: keyframe.inInterpolation,
                    keyframeIndex: keyframe.keyframeIndex,
                    outInterpolation: keyframe.outInterpolation,
                    time: {
                        mode: keyframe.time.mode,
                        scale: keyframe.time.scale,
                        value: keyframe.time.value,
                    },
                    value: canonicalLayerPropertyValue(keyframe.value),
                };
            }),
            limit: value.limit,
            nextOffset: value.nextOffset,
            offset: value.offset,
            propertyLocator: canonicalLocator(value.propertyLocator),
            returned: value.returned,
            total: value.total,
            valueType: value.valueType,
        },
    });
}

function validLayerPropertySetValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, [
        'changed', 'layerLocator', 'propertyLocator', 'valueType',
        'beforeValue', 'afterValue',
    ])
        && value.changed === true
        && validLocator(value.layerLocator, ['layer'])
        && validLocator(value.propertyLocator, ['stream'])
        && locatorsEqual(value.layerLocator, argumentsValue.layerLocator)
        && locatorsEqual(value.propertyLocator, argumentsValue.propertyLocator)
        && value.layerLocator.hostInstanceId === hostInstanceId
        && value.layerLocator.sessionId === sessionId
        && locatorContextMatches(value.layerLocator, value.propertyLocator)
        && ['one-d', 'two-d', 'two-d-spatial', 'three-d', 'three-d-spatial', 'color']
            .includes(value.valueType)
        && validLayerPropertySample(value.beforeValue, value.valueType)
        && validLayerPropertySample(value.afterValue, value.valueType)
        && !layerPropertyValuesEqual(value.beforeValue, value.afterValue)
        && layerPropertyValuesEqual(value.afterValue, argumentsValue.value);
}

function layerPropertyValuesEqual(left, right) {
    if (!left || !right || left.kind !== right.kind) return false;
    const decimalsEqual = function (first, second) {
        const firstNumber = Number(first);
        const secondNumber = Number(second);
        return Number.isFinite(firstNumber) && Number.isFinite(secondNumber)
            && firstNumber === secondNumber;
    };
    if (left.kind === 'scalar') return decimalsEqual(left.value, right.value);
    if (left.kind === 'vector') {
        return left.components.length === right.components.length
            && left.components.every(function (component, index) {
                return decimalsEqual(component, right.components[index]);
            });
    }
    return ['alpha', 'red', 'green', 'blue'].every(function (component) {
        return decimalsEqual(left[component], right[component]);
    });
}

// Construct the closed invoke request in canonical member order. Construct the
// RFC 8785 member order explicitly so the broker can bind native evidence to
// the exact request it sent instead of trusting a digest-shaped string.
function invokeRequestDigest(request) {
    let argumentsValue = {};
    if (projectCompositionContracts.getContract(request.params.capabilityId)) {
        // The package-specific validator has already proved a recursively
        // closed argument shape before send() can reach this digest boundary.
        // Sort every nested member here because the public request may arrive
        // in any insertion order while native evidence is RFC 8785 canonical.
        argumentsValue = canonicalizeForDigest(request.params.arguments);
    } else if (request.params.capabilityId === PROJECT_BIT_DEPTH_SET_CAPABILITY) {
        argumentsValue = {
            idempotencyKey: request.params.arguments.idempotencyKey,
            targetDepth: request.params.arguments.targetDepth,
        };
    } else if (request.params.capabilityId === PROJECT_ITEMS_LIST_CAPABILITY) {
        argumentsValue = {
            limit: request.params.arguments.limit,
            offset: request.params.arguments.offset,
        };
        if (request.params.arguments.projectLocator !== undefined) {
            argumentsValue.projectLocator = canonicalLocator(
                request.params.arguments.projectLocator,
            );
        }
    } else if (request.params.capabilityId === COMPOSITION_LAYERS_LIST_CAPABILITY
        || request.params.capabilityId === COMPOSITION_SELECTED_LAYERS_LIST_CAPABILITY) {
        argumentsValue = {
            compositionLocator: canonicalLocator(request.params.arguments.compositionLocator),
            limit: request.params.arguments.limit,
            offset: request.params.arguments.offset,
        };
    } else if (request.params.capabilityId === COMPOSITION_TIME_READ_CAPABILITY) {
        argumentsValue = {
            compositionLocator: canonicalLocator(request.params.arguments.compositionLocator),
        };
    } else if (request.params.capabilityId === COMPOSITION_TIME_SET_CAPABILITY) {
        argumentsValue = {
            compositionLocator: canonicalLocator(request.params.arguments.compositionLocator),
            idempotencyKey: request.params.arguments.idempotencyKey,
            targetTime: {
                scale: request.params.arguments.targetTime.scale,
                value: request.params.arguments.targetTime.value,
            },
        };
    } else if (request.params.capabilityId === COMPOSITION_CREATE_CAPABILITY) {
        argumentsValue = {
            duration: {
                scale: request.params.arguments.duration.scale,
                value: request.params.arguments.duration.value,
            },
            frameRate: {
                denominator: request.params.arguments.frameRate.denominator,
                numerator: request.params.arguments.frameRate.numerator,
            },
            height: request.params.arguments.height,
            idempotencyKey: request.params.arguments.idempotencyKey,
            name: request.params.arguments.name,
            pixelAspectRatio: {
                denominator: request.params.arguments.pixelAspectRatio.denominator,
                numerator: request.params.arguments.pixelAspectRatio.numerator,
            },
            width: request.params.arguments.width,
        };
    } else if (request.params.capabilityId === COMPOSITION_LAYER_CREATE_CAPABILITY) {
        argumentsValue = {};
        if (request.params.arguments.color !== undefined) {
            argumentsValue.color = {
                alpha: request.params.arguments.color.alpha,
                blue: request.params.arguments.color.blue,
                green: request.params.arguments.color.green,
                red: request.params.arguments.color.red,
            };
        }
        argumentsValue.compositionLocator = canonicalLocator(
            request.params.arguments.compositionLocator,
        );
        if (request.params.arguments.duration !== undefined) {
            argumentsValue.duration = {
                scale: request.params.arguments.duration.scale,
                value: request.params.arguments.duration.value,
            };
        }
        if (request.params.arguments.height !== undefined) {
            argumentsValue.height = request.params.arguments.height;
        }
        argumentsValue.idempotencyKey = request.params.arguments.idempotencyKey;
        argumentsValue.kind = request.params.arguments.kind;
        argumentsValue.name = request.params.arguments.name;
        if (request.params.arguments.width !== undefined) {
            argumentsValue.width = request.params.arguments.width;
        }
    } else if (request.params.capabilityId === LAYER_EFFECT_APPLY_CAPABILITY) {
        argumentsValue = {
            effectMatchName: request.params.arguments.effectMatchName,
            idempotencyKey: request.params.arguments.idempotencyKey,
            layerLocator: canonicalLocator(request.params.arguments.layerLocator),
        };
    } else if (request.params.capabilityId === LAYER_PROPERTIES_LIST_CAPABILITY) {
        argumentsValue = {
            layerLocator: canonicalLocator(request.params.arguments.layerLocator),
            limit: request.params.arguments.limit,
            offset: request.params.arguments.offset,
        };
        if (request.params.arguments.parentPropertyLocator !== undefined
            && request.params.arguments.parentPropertyLocator !== null) {
            argumentsValue.parentPropertyLocator = canonicalLocator(
                request.params.arguments.parentPropertyLocator,
            );
        }
    } else if (request.params.capabilityId
        === LAYER_PROPERTY_KEYFRAMES_LIST_CAPABILITY) {
        argumentsValue = {
            limit: request.params.arguments.limit,
            offset: request.params.arguments.offset,
            propertyLocator: canonicalLocator(request.params.arguments.propertyLocator),
        };
    } else if (request.params.capabilityId === LAYER_PROPERTY_SET_CAPABILITY) {
        argumentsValue = {
            idempotencyKey: request.params.arguments.idempotencyKey,
            layerLocator: canonicalLocator(request.params.arguments.layerLocator),
            propertyLocator: canonicalLocator(request.params.arguments.propertyLocator),
            value: canonicalLayerPropertyValue(request.params.arguments.value),
        };
    }
    return sha256Canonical({
        deadlineUnixMs: request.deadlineUnixMs,
        kind: request.kind,
        method: request.method,
        params: {
            arguments: argumentsValue,
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
    let projectBitDepthReadContractDigest = null;
    let projectBitDepthSetContractDigest = null;
    let projectItemsListContractDigest = null;
    let compositionLayersListContractDigest = null;
    let compositionSelectedLayersListContractDigest = null;
    let compositionTimeReadContractDigest = null;
    let compositionTimeSetContractDigest = null;
    let compositionCreateContractDigest = null;
    let compositionLayerCreateContractDigest = null;
    let layerEffectApplyContractDigest = null;
    let layerPropertiesListContractDigest = null;
    let layerPropertyKeyframesListContractDigest = null;
    let layerPropertySetContractDigest = null;
    const projectCompositionContractDigests = new Map();
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

    function pendingTransportFailure(pending, error, message) {
        return pending && pending.mutating
            ? nativeMutationUncertain(message, pending.capabilityId, error)
            : error;
    }

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
        projectSummaryContractDigest = null;
        projectBitDepthReadContractDigest = null;
        projectBitDepthSetContractDigest = null;
        projectItemsListContractDigest = null;
        compositionLayersListContractDigest = null;
        compositionSelectedLayersListContractDigest = null;
        compositionTimeReadContractDigest = null;
        compositionTimeSetContractDigest = null;
        compositionCreateContractDigest = null;
        compositionLayerCreateContractDigest = null;
        layerEffectApplyContractDigest = null;
        layerPropertiesListContractDigest = null;
        layerPropertyKeyframesListContractDigest = null;
        layerPropertySetContractDigest = null;
        projectCompositionContractDigests.clear();
        helloIdentity = null;
        if (socket) {
            const current = socket;
            socket = null;
            try { current.destroy(); } catch (_) {}
        }
    }

    function responseError(response, pending) {
        const error = response && response.error;
        if (!exactKeys(error, ['code', 'message', 'retryable', 'sideEffect', 'recovery'], ['details'])
            || typeof error.code !== 'string' || !NATIVE_WIRE_ERROR_CODES.has(error.code)
            || typeof error.message !== 'string' || error.message.length === 0
            || typeof error.retryable !== 'boolean'
            || !['not-started', 'may-have-occurred', 'completed'].includes(error.sideEffect)
            || !error.recovery || typeof error.recovery !== 'object' || Array.isArray(error.recovery)
            || typeof error.recovery.action !== 'string' || typeof error.recovery.hint !== 'string') {
            return pendingTransportFailure(
                pending,
                nativeContractMismatch('native AEGP returned a malformed error payload'),
                'Native AEGP returned an unverifiable mutation error after dispatch.',
            );
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
        const replayValid = pending?.method === 'invoke' && response.ok === true
            ? typeof response.replayed === 'boolean'
            : response.replayed === false;
        if (!pending || response.wireVersion !== 1 || response.kind !== 'response'
            || response.method !== pending.method
            || !replayValid
            || (pending.method !== 'hello' && response.sessionId !== sessionId)) {
            throw nativeContractMismatch('native AEGP response did not match an active request');
        }
        if (response.ok === true && pending.method === 'invoke') {
            const evidence = response.result?.evidence;
            if (evidence?.requestId !== response.requestId
                || evidence?.sessionId !== sessionId
                || evidence?.capabilityId !== pending.capabilityId
                || evidence?.capabilityVersion !== pending.capabilityVersion
                || evidence?.requestDigest !== pending.requestDigest) {
                throw nativeContractMismatch('native AEGP evidence did not match its response envelope');
            }
        }
        pendingRequests.delete(response.requestId);
        clearTimeout(pending.timer);
        if (response.ok === true) {
            pending.resolve(pending.method === 'invoke'
                ? { ...response.result, replayed: response.replayed }
                : response.result);
        }
        else pending.reject(responseError(response, pending));
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
        const requestDigest = method === 'invoke' ? invokeRequestDigest(request) : null;
        const mutating = method === 'invoke'
            && (params.capabilityId === PROJECT_BIT_DEPTH_SET_CAPABILITY
                || params.capabilityId === COMPOSITION_TIME_SET_CAPABILITY
                || params.capabilityId === COMPOSITION_CREATE_CAPABILITY
                || params.capabilityId === COMPOSITION_LAYER_CREATE_CAPABILITY
                || params.capabilityId === LAYER_EFFECT_APPLY_CAPABILITY
                || params.capabilityId === LAYER_PROPERTY_SET_CAPABILITY
                || projectCompositionContracts.getContract(params.capabilityId)?.mutating === true);
        return new Promise(function (resolve, reject) {
            const remainingMs = deadlineUnixMs === undefined
                ? requestTimeoutMs : Math.max(1, deadlineUnixMs - now());
            const timer = setTimeout(function () {
                pendingRequests.delete(requestId);
                reject(mutating
                    ? nativeMutationUncertain(
                        'Native mutation response timed out after dispatch.',
                        params.capabilityId,
                    )
                    : nativeError('DEADLINE_EXCEEDED', 'native AEGP request timed out', true));
            }, Math.min(requestTimeoutMs, remainingMs));
            pendingRequests.set(requestId, {
                method,
                requestDigest,
                capabilityId: method === 'invoke' ? params.capabilityId : null,
                capabilityVersion: method === 'invoke' ? params.capabilityVersion : null,
                mutating,
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
                        nativeError('NATIVE_UNAVAILABLE', 'native AEGP request write failed', true, error),
                        'Native mutation transport write failed after dispatch may have begun.',
                    ));
                });
            } catch (cause) {
                pendingRequests.delete(requestId);
                clearTimeout(timer);
                reject(mutating
                    ? nativeMutationUncertain(
                        'Native mutation transport write failed after dispatch may have begun.',
                        params.capabilityId,
                        cause,
                    )
                    : nativeError('NATIVE_UNAVAILABLE', 'native AEGP request write failed', true, cause));
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
        const summaryItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === PROJECT_SUMMARY_CAPABILITY; })
            : null;
        const bitDepthReadItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === PROJECT_BIT_DEPTH_READ_CAPABILITY; })
            : null;
        const bitDepthSetItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === PROJECT_BIT_DEPTH_SET_CAPABILITY; })
            : null;
        const projectItemsListItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === PROJECT_ITEMS_LIST_CAPABILITY; })
            : null;
        const compositionLayersListItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === COMPOSITION_LAYERS_LIST_CAPABILITY; })
            : null;
        const compositionSelectedLayersListItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) {
                return candidate?.id === COMPOSITION_SELECTED_LAYERS_LIST_CAPABILITY;
            })
            : null;
        const compositionTimeReadItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === COMPOSITION_TIME_READ_CAPABILITY; })
            : null;
        const compositionTimeSetItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === COMPOSITION_TIME_SET_CAPABILITY; })
            : null;
        const compositionCreateItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) {
                return candidate?.id === COMPOSITION_CREATE_CAPABILITY;
            })
            : null;
        const compositionLayerCreateItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) {
                return candidate?.id === COMPOSITION_LAYER_CREATE_CAPABILITY;
            })
            : null;
        const layerEffectApplyItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) {
                return candidate?.id === LAYER_EFFECT_APPLY_CAPABILITY;
            })
            : null;
        const layerPropertiesListItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === LAYER_PROPERTIES_LIST_CAPABILITY; })
            : null;
        const layerPropertyKeyframesListItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) {
                return candidate?.id === LAYER_PROPERTY_KEYFRAMES_LIST_CAPABILITY;
            })
            : null;
        const layerPropertySetItem = Array.isArray(result?.items)
            ? result.items.find(function (candidate) { return candidate?.id === LAYER_PROPERTY_SET_CAPABILITY; })
            : null;
        const packageContractDigests = projectCompositionContracts.validateCapabilityItems(
            result?.items,
            ids,
            requestedDetail,
        );
        const requiresSummary = ids === undefined || ids.includes(PROJECT_SUMMARY_CAPABILITY);
        const requiresBitDepthRead = ids === undefined || ids.includes(PROJECT_BIT_DEPTH_READ_CAPABILITY);
        const requiresBitDepthSet = ids === undefined || ids.includes(PROJECT_BIT_DEPTH_SET_CAPABILITY);
        const requiresProjectItemsList = ids === undefined || ids.includes(PROJECT_ITEMS_LIST_CAPABILITY);
        const requiresCompositionLayersList = ids === undefined
            || ids.includes(COMPOSITION_LAYERS_LIST_CAPABILITY);
        const requiresCompositionSelectedLayersList = ids === undefined
            || ids.includes(COMPOSITION_SELECTED_LAYERS_LIST_CAPABILITY);
        const requiresCompositionTimeRead = ids === undefined
            || ids.includes(COMPOSITION_TIME_READ_CAPABILITY);
        const requiresCompositionTimeSet = ids === undefined
            || ids.includes(COMPOSITION_TIME_SET_CAPABILITY);
        const requiresCompositionCreate = ids === undefined
            || ids.includes(COMPOSITION_CREATE_CAPABILITY);
        const requiresCompositionLayerCreate = ids === undefined
            || ids.includes(COMPOSITION_LAYER_CREATE_CAPABILITY);
        const requiresLayerEffectApply = ids === undefined
            || ids.includes(LAYER_EFFECT_APPLY_CAPABILITY);
        const requiresLayerPropertiesList = ids === undefined
            || ids.includes(LAYER_PROPERTIES_LIST_CAPABILITY);
        const requiresLayerPropertyKeyframesList = ids === undefined
            || ids.includes(LAYER_PROPERTY_KEYFRAMES_LIST_CAPABILITY);
        const requiresLayerPropertySet = ids === undefined
            || ids.includes(LAYER_PROPERTY_SET_CAPABILITY);
        if (!exactKeys(result, ['detail', 'items', 'nextCursor', 'queryDigest', 'capabilitiesDigest'])
            || result.detail !== requestedDetail || result.nextCursor !== null
            || result.queryDigest !== capabilitiesQueryDigest(sessionId, ids, requestedDetail, limit)
            || result.capabilitiesDigest !== capabilitiesDigest
            || (requiresSummary && !summaryItem)
            || (requiresBitDepthRead && !bitDepthReadItem)
            || (requiresBitDepthSet && !bitDepthSetItem)
            || (requiresProjectItemsList && !projectItemsListItem)
            || (requiresCompositionLayersList && !compositionLayersListItem)
            || (requiresCompositionSelectedLayersList && !compositionSelectedLayersListItem)
            || (requiresCompositionTimeRead && !compositionTimeReadItem)
            || (requiresCompositionTimeSet && !compositionTimeSetItem)
            || (requiresCompositionCreate && !compositionCreateItem)
            || (requiresCompositionLayerCreate && !compositionLayerCreateItem)
            || (requiresLayerEffectApply && !layerEffectApplyItem)
            || (requiresLayerPropertiesList && !layerPropertiesListItem)
            || (requiresLayerPropertyKeyframesList && !layerPropertyKeyframesListItem)
            || (requiresLayerPropertySet && !layerPropertySetItem)
            || packageContractDigests === null
            || (summaryItem && (summaryItem.version !== 1 || summaryItem.detail !== requestedDetail
                || (requestedDetail === 'full' && !SHA256_PATTERN.test(summaryItem.contractDigest))))
            || (bitDepthReadItem && (bitDepthReadItem.version !== 1
                || bitDepthReadItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && bitDepthReadItem.contractDigest !== PROJECT_BIT_DEPTH_READ_CONTRACT_DIGEST)))
            || (bitDepthSetItem && (bitDepthSetItem.version !== 1
                || bitDepthSetItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && bitDepthSetItem.contractDigest !== PROJECT_BIT_DEPTH_SET_CONTRACT_DIGEST)))
            || (projectItemsListItem && (projectItemsListItem.version !== 1
                || projectItemsListItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && projectItemsListItem.contractDigest !== PROJECT_ITEMS_LIST_CONTRACT_DIGEST)))
            || (compositionLayersListItem && (compositionLayersListItem.version !== 1
                || compositionLayersListItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && compositionLayersListItem.contractDigest
                        !== COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST)))
            || (compositionSelectedLayersListItem
                && (compositionSelectedLayersListItem.version !== 1
                    || compositionSelectedLayersListItem.detail !== requestedDetail
                    || (requestedDetail === 'full'
                        && compositionSelectedLayersListItem.contractDigest
                            !== COMPOSITION_SELECTED_LAYERS_LIST_CONTRACT_DIGEST)))
            || (compositionTimeReadItem && (compositionTimeReadItem.version !== 1
                || compositionTimeReadItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && compositionTimeReadItem.contractDigest
                        !== COMPOSITION_TIME_READ_CONTRACT_DIGEST)))
            || (compositionTimeSetItem && (compositionTimeSetItem.version !== 1
                || compositionTimeSetItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && compositionTimeSetItem.contractDigest
                        !== COMPOSITION_TIME_SET_CONTRACT_DIGEST)))
            || (compositionCreateItem && (compositionCreateItem.version !== 1
                || compositionCreateItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && compositionCreateItem.contractDigest
                        !== COMPOSITION_CREATE_CONTRACT_DIGEST)))
            || (compositionLayerCreateItem && (compositionLayerCreateItem.version !== 1
                || compositionLayerCreateItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && compositionLayerCreateItem.contractDigest
                        !== COMPOSITION_LAYER_CREATE_CONTRACT_DIGEST)))
            || (layerEffectApplyItem && (layerEffectApplyItem.version !== 1
                || layerEffectApplyItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && layerEffectApplyItem.contractDigest
                        !== LAYER_EFFECT_APPLY_CONTRACT_DIGEST)))
            || (layerPropertiesListItem && (layerPropertiesListItem.version !== 1
                || layerPropertiesListItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && layerPropertiesListItem.contractDigest
                        !== LAYER_PROPERTIES_LIST_CONTRACT_DIGEST)))
            || (layerPropertyKeyframesListItem
                && (layerPropertyKeyframesListItem.version !== 1
                    || layerPropertyKeyframesListItem.detail !== requestedDetail
                    || (requestedDetail === 'full'
                        && layerPropertyKeyframesListItem.contractDigest
                            !== LAYER_PROPERTY_KEYFRAMES_LIST_CONTRACT_DIGEST)))
            || (layerPropertySetItem && (layerPropertySetItem.version !== 1
                || layerPropertySetItem.detail !== requestedDetail
                || (requestedDetail === 'full'
                    && layerPropertySetItem.contractDigest
                        !== LAYER_PROPERTY_SET_CONTRACT_DIGEST)))) {
            throw nativeContractMismatch('native capabilities result was malformed');
        }
        if (requestedDetail === 'full' && summaryItem) {
            projectSummaryContractDigest = summaryItem.contractDigest;
        }
        if (requestedDetail === 'full' && bitDepthReadItem) {
            projectBitDepthReadContractDigest = bitDepthReadItem.contractDigest;
        }
        if (requestedDetail === 'full' && bitDepthSetItem) {
            projectBitDepthSetContractDigest = bitDepthSetItem.contractDigest;
        }
        if (requestedDetail === 'full' && projectItemsListItem) {
            projectItemsListContractDigest = projectItemsListItem.contractDigest;
        }
        if (requestedDetail === 'full' && compositionLayersListItem) {
            compositionLayersListContractDigest = compositionLayersListItem.contractDigest;
        }
        if (requestedDetail === 'full' && compositionSelectedLayersListItem) {
            compositionSelectedLayersListContractDigest =
                compositionSelectedLayersListItem.contractDigest;
        }
        if (requestedDetail === 'full' && compositionTimeReadItem) {
            compositionTimeReadContractDigest = compositionTimeReadItem.contractDigest;
        }
        if (requestedDetail === 'full' && compositionTimeSetItem) {
            compositionTimeSetContractDigest = compositionTimeSetItem.contractDigest;
        }
        if (requestedDetail === 'full' && compositionCreateItem) {
            compositionCreateContractDigest = compositionCreateItem.contractDigest;
        }
        if (requestedDetail === 'full' && compositionLayerCreateItem) {
            compositionLayerCreateContractDigest = compositionLayerCreateItem.contractDigest;
        }
        if (requestedDetail === 'full' && layerEffectApplyItem) {
            layerEffectApplyContractDigest = layerEffectApplyItem.contractDigest;
        }
        if (requestedDetail === 'full' && layerPropertiesListItem) {
            layerPropertiesListContractDigest = layerPropertiesListItem.contractDigest;
        }
        if (requestedDetail === 'full' && layerPropertyKeyframesListItem) {
            layerPropertyKeyframesListContractDigest =
                layerPropertyKeyframesListItem.contractDigest;
        }
        if (requestedDetail === 'full' && layerPropertySetItem) {
            layerPropertySetContractDigest = layerPropertySetItem.contractDigest;
        }
        if (requestedDetail === 'full') {
            for (const [capabilityId, digest] of packageContractDigests) {
                projectCompositionContractDigests.set(capabilityId, digest);
            }
        }
        return result;
    }

    async function invoke(options) {
        const call = options || {};
        const packageContract = projectCompositionContracts.getContract(call.capabilityId);
        const packageCall = packageContract !== null
            && call.capabilityVersion === 1
            && packageContract.validArguments(call.arguments);
        const summaryCall = call.capabilityId === PROJECT_SUMMARY_CAPABILITY
            && call.capabilityVersion === 1
            && call.arguments && typeof call.arguments === 'object'
            && !Array.isArray(call.arguments) && Object.keys(call.arguments).length === 0;
        const bitDepthReadCall = call.capabilityId === PROJECT_BIT_DEPTH_READ_CAPABILITY
            && call.capabilityVersion === 1
            && call.arguments && typeof call.arguments === 'object'
            && !Array.isArray(call.arguments) && Object.keys(call.arguments).length === 0;
        const bitDepthSetCall = call.capabilityId === PROJECT_BIT_DEPTH_SET_CAPABILITY
            && call.capabilityVersion === 1
            && validProjectBitDepthSetArguments(call.arguments);
        const projectItemsListCall = call.capabilityId === PROJECT_ITEMS_LIST_CAPABILITY
            && call.capabilityVersion === 1
            && validProjectItemsListArguments(call.arguments);
        const compositionLayersListCall = call.capabilityId === COMPOSITION_LAYERS_LIST_CAPABILITY
            && call.capabilityVersion === 1
            && validCompositionLayersListArguments(call.arguments);
        const compositionSelectedLayersListCall =
            call.capabilityId === COMPOSITION_SELECTED_LAYERS_LIST_CAPABILITY
            && call.capabilityVersion === 1
            && validCompositionSelectedLayersListArguments(call.arguments);
        const compositionTimeReadCall = call.capabilityId === COMPOSITION_TIME_READ_CAPABILITY
            && call.capabilityVersion === 1
            && validCompositionTimeReadArguments(call.arguments);
        const compositionTimeSetCall = call.capabilityId === COMPOSITION_TIME_SET_CAPABILITY
            && call.capabilityVersion === 1
            && validCompositionTimeSetArguments(call.arguments);
        const compositionCreateCall = call.capabilityId === COMPOSITION_CREATE_CAPABILITY
            && call.capabilityVersion === 1
            && validCompositionCreateArguments(call.arguments);
        const compositionLayerCreateCall =
            call.capabilityId === COMPOSITION_LAYER_CREATE_CAPABILITY
            && call.capabilityVersion === 1
            && validCompositionLayerCreateArguments(call.arguments);
        const layerEffectApplyCall = call.capabilityId === LAYER_EFFECT_APPLY_CAPABILITY
            && call.capabilityVersion === 1
            && validLayerEffectApplyArguments(call.arguments);
        const layerPropertiesListCall = call.capabilityId === LAYER_PROPERTIES_LIST_CAPABILITY
            && call.capabilityVersion === 1
            && validLayerPropertiesListArguments(call.arguments);
        const layerPropertyKeyframesListCall =
            call.capabilityId === LAYER_PROPERTY_KEYFRAMES_LIST_CAPABILITY
            && call.capabilityVersion === 1
            && validLayerPropertyKeyframesListArguments(call.arguments);
        const layerPropertySetCall = call.capabilityId === LAYER_PROPERTY_SET_CAPABILITY
            && call.capabilityVersion === 1
            && validLayerPropertySetArguments(call.arguments);
        if (!exactKeys(call, [
            'requestId', 'capabilityId', 'capabilityVersion', 'arguments', 'deadlineUnixMs',
        ]) || !TOKEN_PATTERN.test(call.requestId || '')
            || (!summaryCall && !bitDepthReadCall && !bitDepthSetCall
                && !projectItemsListCall && !compositionLayersListCall
                && !compositionSelectedLayersListCall
                && !compositionTimeReadCall
                && !compositionTimeSetCall
                && !compositionCreateCall
                && !compositionLayerCreateCall
                && !layerEffectApplyCall
                && !layerPropertiesListCall && !layerPropertyKeyframesListCall
                && !layerPropertySetCall && !packageCall)
            || !Number.isSafeInteger(call.deadlineUnixMs) || call.deadlineUnixMs <= 0) {
            throw nativeError('INVALID_ARGUMENT', 'native invoke request is invalid', false);
        }
        if (state !== 'connected') await waitUntilConnected(call.deadlineUnixMs);
        if (packageCall
            && projectCompositionContractDigests.get(call.capabilityId)
                !== packageContract.digest) {
            throw nativeContractMismatch(
                'native project/composition capability was not verified before dispatch',
            );
        }
        if (bitDepthReadCall
            && projectBitDepthReadContractDigest !== PROJECT_BIT_DEPTH_READ_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native project-bit-depth read capability was not verified before dispatch',
            );
        }
        if (bitDepthSetCall
            && projectBitDepthSetContractDigest !== PROJECT_BIT_DEPTH_SET_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native project-bit-depth set capability was not verified before dispatch',
            );
        }
        if (projectItemsListCall
            && projectItemsListContractDigest !== PROJECT_ITEMS_LIST_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native project-items list capability was not verified before dispatch',
            );
        }
        if (compositionLayersListCall
            && compositionLayersListContractDigest !== COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native composition-layers list capability was not verified before dispatch',
            );
        }
        if (compositionSelectedLayersListCall
            && compositionSelectedLayersListContractDigest
                !== COMPOSITION_SELECTED_LAYERS_LIST_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native selected-composition-layers list capability was not verified before dispatch',
            );
        }
        if (compositionTimeReadCall
            && compositionTimeReadContractDigest !== COMPOSITION_TIME_READ_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native composition-time read capability was not verified before dispatch',
            );
        }
        if (compositionTimeSetCall
            && compositionTimeSetContractDigest !== COMPOSITION_TIME_SET_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native composition-time set capability was not verified before dispatch',
            );
        }
        if (compositionCreateCall
            && compositionCreateContractDigest !== COMPOSITION_CREATE_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native composition create capability was not verified before dispatch',
            );
        }
        if (compositionLayerCreateCall
            && compositionLayerCreateContractDigest
                !== COMPOSITION_LAYER_CREATE_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native composition-layer create capability was not verified before dispatch',
            );
        }
        if (layerEffectApplyCall
            && layerEffectApplyContractDigest !== LAYER_EFFECT_APPLY_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native layer-effect apply capability was not verified before dispatch',
            );
        }
        if (layerPropertiesListCall
            && layerPropertiesListContractDigest !== LAYER_PROPERTIES_LIST_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native layer-properties list capability was not verified before dispatch',
            );
        }
        if (layerPropertyKeyframesListCall
            && layerPropertyKeyframesListContractDigest
                !== LAYER_PROPERTY_KEYFRAMES_LIST_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native layer-property keyframe list capability was not verified before dispatch',
            );
        }
        if (layerPropertySetCall
            && layerPropertySetContractDigest !== LAYER_PROPERTY_SET_CONTRACT_DIGEST) {
            throw nativeContractMismatch(
                'native layer-property set capability was not verified before dispatch',
            );
        }
        let locatorChecks = [];
        if (packageCall) {
            locatorChecks = projectCompositionContracts.locatorChecks(
                packageContract,
                call.arguments,
            );
        } else if (projectItemsListCall && call.arguments.projectLocator !== undefined) {
            locatorChecks = [[call.arguments.projectLocator, 'projectLocator', 'ae_listProjectItems']];
        } else if (compositionLayersListCall || compositionSelectedLayersListCall
            || compositionTimeReadCall || compositionTimeSetCall
            || compositionLayerCreateCall) {
            locatorChecks = [[
                call.arguments.compositionLocator,
                'compositionLocator',
                'ae_listProjectItems',
            ]];
        } else if (layerPropertiesListCall) {
            locatorChecks = [[
                call.arguments.layerLocator,
                'layerLocator',
                'ae_listCompositionLayers',
            ]];
            if (call.arguments.parentPropertyLocator !== undefined
                && call.arguments.parentPropertyLocator !== null) {
                locatorChecks.push([
                    call.arguments.parentPropertyLocator,
                    'parentPropertyLocator',
                    'ae_listLayerProperties',
                ]);
            }
        } else if (layerEffectApplyCall) {
            locatorChecks = [[
                call.arguments.layerLocator,
                'layerLocator',
                'ae_listCompositionLayers',
            ]];
        } else if (layerPropertyKeyframesListCall) {
            locatorChecks = [[
                call.arguments.propertyLocator,
                'propertyLocator',
                'ae_listLayerProperties',
            ]];
        } else if (layerPropertySetCall) {
            locatorChecks = [
                [call.arguments.layerLocator, 'layerLocator', 'ae_listLayerProperties'],
                [call.arguments.propertyLocator, 'propertyLocator', 'ae_listLayerProperties'],
            ];
        }
        const staleLocator = locatorChecks.find(function (entry) {
            return entry[0].hostInstanceId !== endpoint.hostInstanceId
                || entry[0].sessionId !== sessionId;
        });
        if (staleLocator) {
            throw nativeError(
                'STALE_LOCATOR',
                'native locator does not belong to the connected host session',
                true,
                undefined,
                {
                    sideEffect: 'not-started',
                    recovery: {
                        action: 'refresh-locator',
                        hint: 'Discard the stale locator and call '
                            + staleLocator[2] + ' again.',
                    },
                    details: {
                        field: 'params.arguments.' + staleLocator[1],
                        capabilityId: call.capabilityId,
                    },
                },
            );
        }
        if (layerPropertiesListCall
            && call.arguments.parentPropertyLocator !== undefined
            && call.arguments.parentPropertyLocator !== null
            && !locatorContextMatches(
                call.arguments.parentPropertyLocator, call.arguments.layerLocator,
            )) {
            throw nativeError(
                'STALE_LOCATOR',
                'parent property locator does not belong to the requested layer context',
                true,
                undefined,
                {
                    sideEffect: 'not-started',
                    recovery: {
                        action: 'refresh-locator',
                        hint: 'Discard the stale parent and call ae_listLayerProperties again.',
                    },
                    details: {
                        field: 'params.arguments.parentPropertyLocator',
                        capabilityId: call.capabilityId,
                    },
                },
            );
        }
        if (layerPropertySetCall
            && !locatorContextMatches(
                call.arguments.propertyLocator, call.arguments.layerLocator,
            )) {
            throw nativeError(
                'STALE_LOCATOR',
                'property locator does not belong to the requested layer context',
                true,
                undefined,
                {
                    sideEffect: 'not-started',
                    recovery: {
                        action: 'refresh-locator',
                        hint: 'Discard both locators and call ae_listLayerProperties again.',
                    },
                    details: {
                        field: 'params.arguments.propertyLocator',
                        capabilityId: call.capabilityId,
                    },
                },
            );
        }
        const normalizedArguments = layerPropertiesListCall
            && call.arguments.parentPropertyLocator === null
            ? {
                layerLocator: call.arguments.layerLocator,
                offset: call.arguments.offset,
                limit: call.arguments.limit,
            }
            : call.arguments;
        const result = await send('invoke', {
            capabilityId: call.capabilityId,
            capabilityVersion: call.capabilityVersion,
            arguments: normalizedArguments,
        }, { requestId: call.requestId, deadlineUnixMs: call.deadlineUnixMs });
        const value = result?.value;
        const evidence = result?.evidence;
        const commonValid = result?.capabilityId === call.capabilityId
            && result?.capabilityVersion === call.capabilityVersion
            && result?.engine === 'native-aegp' && result?.outcome === 'succeeded'
            && evidence?.engine === 'native-aegp'
            && evidence?.hostInstanceId === endpoint.hostInstanceId;
        const evidenceValid = evidence?.sessionId === sessionId
            && evidence?.requestId === call.requestId
            && evidence?.capabilityId === call.capabilityId
            && evidence?.capabilityVersion === call.capabilityVersion
            && SHA256_PATTERN.test(evidence?.requestDigest || '')
            && Number.isSafeInteger(evidence?.startedAtUnixMs) && evidence.startedAtUnixMs > 0
            && Number.isSafeInteger(evidence?.completedAtUnixMs)
            && evidence.completedAtUnixMs >= evidence.startedAtUnixMs
            && evidence?.postcondition?.verified === true
            && evidence.postcondition.algorithm === 'sha256-rfc8785-jcs-v1'
            && SHA256_PATTERN.test(evidence.postcondition.digest || '');
        if (!commonValid || !evidenceValid) {
            if ((packageCall && packageContract.mutating)
                || bitDepthSetCall || compositionTimeSetCall || compositionCreateCall
                || compositionLayerCreateCall
                || layerEffectApplyCall
                || layerPropertySetCall) {
                throw nativeMutationUncertain(
                    'Native mutation result lacked verified AEGP evidence.',
                    call.capabilityId,
                );
            }
            if ((packageCall && !packageContract.mutating)
                || bitDepthReadCall || projectItemsListCall || compositionLayersListCall
                || compositionSelectedLayersListCall
                || compositionTimeReadCall
                || layerPropertiesListCall || layerPropertyKeyframesListCall) {
                throw nativeContractMismatch(
                    'native read result lacked verified AEGP evidence',
                );
            }
            throw nativeContractMismatch('native project summary result lacked verified AEGP evidence');
        }
        if (packageCall) {
            const resultShapeValid = exactKeys(result, [
                'capabilityId', 'capabilityVersion', 'engine', 'outcome',
                'evidence', 'value', 'replayed',
            ]);
            const expectedEvidenceKeys = [
                'engine', 'hostInstanceId', 'sessionId', 'requestId', 'capabilityId',
                'capabilityVersion', 'startedAtUnixMs', 'completedAtUnixMs', 'effect',
                'requestDigest', 'postcondition',
            ].concat(packageContract.mutating ? ['undo'] : []);
            const replayValid = packageContract.mutating
                ? (packageContract.allowReplay
                    ? typeof result.replayed === 'boolean'
                    : result.replayed === false)
                : result.replayed === false;
            const shapeValid = exactKeys(evidence, expectedEvidenceKeys)
                && exactKeys(evidence.postcondition, [
                    'verified', 'kind', 'algorithm', 'digest',
                ])
                && (packageContract.mutating
                    ? (evidence.effect === 'committed'
                        && exactKeys(evidence.undo, ['available', 'verified'])
                        && evidence.undo.available === true
                        && evidence.undo.verified === false)
                    : (evidence.effect === 'none' && evidence.undo === undefined));
            const valueValid = packageContract.validValue(
                value,
                call.arguments,
                endpoint.hostInstanceId,
                sessionId,
            );
            const expectedPostconditionDigest = valueValid
                ? sha256Canonical({
                    capabilityId: call.capabilityId,
                    capabilityVersion: 1,
                    value: canonicalizeForDigest(value),
                })
                : null;
            const verified = resultShapeValid && replayValid && shapeValid && valueValid
                && projectCompositionContractDigests.get(call.capabilityId)
                    === packageContract.digest
                && evidence.completedAtUnixMs <= call.deadlineUnixMs
                && evidence.postcondition.kind === packageContract.postconditionKind
                && evidence.postcondition.digest === expectedPostconditionDigest;
            if (!verified) {
                if (packageContract.mutating) {
                    throw nativeMutationUncertain(
                        'Native project/composition mutation failed post-dispatch verification.',
                        call.capabilityId,
                    );
                }
                throw nativeContractMismatch(
                    'native project/composition read failed verification',
                );
            }
        }
        if (summaryCall && (evidence.effect !== 'none'
            || evidence.undo !== undefined
            || evidence.postcondition.kind !== 'project-summary'
            || typeof value?.projectOpen !== 'boolean'
            || !validBoundedUnicodeString(value?.projectName, 1024)
            || !Number.isSafeInteger(value?.itemCount) || value.itemCount < 0
            || !SHA256_PATTERN.test(projectSummaryContractDigest || '')
            || evidence.postcondition.digest !== projectSummaryPostconditionDigest(value))) {
            throw nativeContractMismatch('native project summary result lacked verified AEGP evidence');
        }
        if (bitDepthReadCall && (evidence.effect !== 'none'
            || evidence.undo !== undefined
            || evidence.postcondition.kind !== 'project-bit-depth-read'
            || !exactKeys(value, ['bitsPerChannel'])
            || ![8, 16, 32].includes(value.bitsPerChannel)
            || projectBitDepthReadContractDigest !== PROJECT_BIT_DEPTH_READ_CONTRACT_DIGEST
            || evidence.postcondition.digest !== projectBitDepthReadPostconditionDigest(value))) {
            throw nativeContractMismatch(
                'native project-bit-depth read result failed verification',
            );
        }
        if (bitDepthSetCall && (result.replayed !== false
            || evidence.effect !== 'committed'
            || evidence.postcondition.kind !== 'project-bit-depth-set'
            || !exactKeys(evidence.undo, ['available', 'verified'])
            || evidence.undo.available !== true || evidence.undo.verified !== false
            || !exactKeys(value, ['changed', 'beforeBitsPerChannel', 'afterBitsPerChannel'])
            || value.changed !== true
            || ![8, 16, 32].includes(value.beforeBitsPerChannel)
            || ![8, 16, 32].includes(value.afterBitsPerChannel)
            || value.beforeBitsPerChannel === value.afterBitsPerChannel
            || value.afterBitsPerChannel !== call.arguments.targetDepth
            || projectBitDepthSetContractDigest !== PROJECT_BIT_DEPTH_SET_CONTRACT_DIGEST
            || evidence.postcondition.digest !== projectBitDepthSetPostconditionDigest(value))) {
            throw nativeMutationUncertain(
                'Native project-bit-depth set result failed post-dispatch verification.',
                PROJECT_BIT_DEPTH_SET_CAPABILITY,
            );
        }
        if (compositionTimeSetCall && (result.replayed !== false
            || evidence.effect !== 'committed'
            || evidence.postcondition.kind !== 'composition-time-set'
            || !exactKeys(evidence.undo, ['available', 'verified'])
            || evidence.undo.available !== true || evidence.undo.verified !== false
            || compositionTimeSetContractDigest !== COMPOSITION_TIME_SET_CONTRACT_DIGEST
            || !validCompositionTimeSetValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest !== compositionTimeSetPostconditionDigest(value))) {
            throw nativeMutationUncertain(
                'Native composition-time set result failed post-dispatch verification.',
                COMPOSITION_TIME_SET_CAPABILITY,
            );
        }
        if (compositionCreateCall && (typeof result.replayed !== 'boolean'
            || evidence.effect !== 'committed'
            || evidence.postcondition.kind !== 'composition-create'
            || !exactKeys(evidence.undo, ['available', 'verified'])
            || evidence.undo.available !== true || evidence.undo.verified !== false
            || compositionCreateContractDigest !== COMPOSITION_CREATE_CONTRACT_DIGEST
            || !validCompositionCreateValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest !== compositionCreatePostconditionDigest(value))) {
            throw nativeMutationUncertain(
                'Native composition create result failed post-dispatch verification.',
                COMPOSITION_CREATE_CAPABILITY,
            );
        }
        if (compositionLayerCreateCall && (typeof result.replayed !== 'boolean'
            || evidence.effect !== 'committed'
            || evidence.postcondition.kind !== 'composition-layer-create'
            || !exactKeys(evidence.undo, ['available', 'verified'])
            || evidence.undo.available !== true || evidence.undo.verified !== false
            || compositionLayerCreateContractDigest
                !== COMPOSITION_LAYER_CREATE_CONTRACT_DIGEST
            || !validCompositionLayerCreateValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest
                !== compositionLayerCreatePostconditionDigest(value))) {
            throw nativeMutationUncertain(
                'Native composition-layer create result failed post-dispatch verification.',
                COMPOSITION_LAYER_CREATE_CAPABILITY,
            );
        }
        if (layerEffectApplyCall && (typeof result.replayed !== 'boolean'
            || evidence.effect !== 'committed'
            || evidence.postcondition.kind !== 'layer-effect-apply'
            || !exactKeys(evidence.undo, ['available', 'verified'])
            || evidence.undo.available !== true || evidence.undo.verified !== false
            || layerEffectApplyContractDigest !== LAYER_EFFECT_APPLY_CONTRACT_DIGEST
            || !validLayerEffectApplyValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest !== layerEffectApplyPostconditionDigest(value))) {
            throw nativeMutationUncertain(
                'Native layer-effect apply result failed post-dispatch verification.',
                LAYER_EFFECT_APPLY_CAPABILITY,
            );
        }
        if (layerPropertySetCall && (result.replayed !== false
            || evidence.effect !== 'committed'
            || evidence.postcondition.kind !== 'layer-property-set'
            || !exactKeys(evidence.undo, ['available', 'verified'])
            || evidence.undo.available !== true || evidence.undo.verified !== false
            || layerPropertySetContractDigest !== LAYER_PROPERTY_SET_CONTRACT_DIGEST
            || !validLayerPropertySetValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest !== layerPropertySetPostconditionDigest(value))) {
            throw nativeMutationUncertain(
                'Native layer-property set result failed post-dispatch verification.',
                LAYER_PROPERTY_SET_CAPABILITY,
            );
        }
        const navigationEvidenceValid = (projectItemsListCall || compositionLayersListCall
            || compositionSelectedLayersListCall
            || compositionTimeReadCall || layerPropertiesListCall
            || layerPropertyKeyframesListCall)
            && exactKeys(evidence, [
                'engine', 'hostInstanceId', 'sessionId', 'requestId', 'capabilityId',
                'capabilityVersion', 'startedAtUnixMs', 'completedAtUnixMs', 'effect',
                'requestDigest', 'postcondition',
            ])
            && exactKeys(evidence.postcondition, [
                'verified', 'kind', 'algorithm', 'digest',
            ]);
        if (projectItemsListCall && (!navigationEvidenceValid
            || result.replayed !== false || evidence.effect !== 'none'
            || evidence.postcondition.kind !== 'project-items-list'
            || projectItemsListContractDigest !== PROJECT_ITEMS_LIST_CONTRACT_DIGEST
            || !validProjectItemsListValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest !== projectItemsListPostconditionDigest(value))) {
            throw nativeContractMismatch('native project-items page failed verification');
        }
        if (compositionLayersListCall && (!navigationEvidenceValid
            || result.replayed !== false || evidence.effect !== 'none'
            || evidence.postcondition.kind !== 'composition-layers-list'
            || compositionLayersListContractDigest
                !== COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST
            || !validCompositionLayersListValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest
                !== compositionLayersListPostconditionDigest(value))) {
            throw nativeContractMismatch('native composition-layers page failed verification');
        }
        if (compositionSelectedLayersListCall && (!navigationEvidenceValid
            || result.replayed !== false || evidence.effect !== 'none'
            || evidence.postcondition.kind !== 'composition-selected-layers-list'
            || compositionSelectedLayersListContractDigest
                !== COMPOSITION_SELECTED_LAYERS_LIST_CONTRACT_DIGEST
            || !validCompositionSelectedLayersListValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest
                !== compositionSelectedLayersListPostconditionDigest(value))) {
            throw nativeContractMismatch(
                'native selected-composition-layers page failed verification',
            );
        }
        if (compositionTimeReadCall && (!navigationEvidenceValid
            || result.replayed !== false || evidence.effect !== 'none'
            || evidence.postcondition.kind !== 'composition-time-read'
            || compositionTimeReadContractDigest
                !== COMPOSITION_TIME_READ_CONTRACT_DIGEST
            || !validCompositionTimeReadValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest
                !== compositionTimeReadPostconditionDigest(value))) {
            throw nativeContractMismatch('native composition-time read failed verification');
        }
        if (layerPropertiesListCall && (!navigationEvidenceValid
            || result.replayed !== false || evidence.effect !== 'none'
            || evidence.postcondition.kind !== 'layer-properties-list'
            || layerPropertiesListContractDigest
                !== LAYER_PROPERTIES_LIST_CONTRACT_DIGEST
            || !validLayerPropertiesListValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest
                !== layerPropertiesListPostconditionDigest(value))) {
            throw nativeContractMismatch('native layer-properties page failed verification');
        }
        if (layerPropertyKeyframesListCall && (!navigationEvidenceValid
            || result.replayed !== false || evidence.effect !== 'none'
            || evidence.postcondition.kind !== 'layer-property-keyframes-list'
            || layerPropertyKeyframesListContractDigest
                !== LAYER_PROPERTY_KEYFRAMES_LIST_CONTRACT_DIGEST
            || !validLayerPropertyKeyframesListValue(
                value, call.arguments, endpoint.hostInstanceId, sessionId,
            )
            || evidence.postcondition.digest
                !== layerPropertyKeyframesListPostconditionDigest(value))) {
            throw nativeContractMismatch(
                'native layer-property keyframe page failed verification',
            );
        }
        return result;
    }

    async function invalidateProjectGraph(options) {
        const call = options || {};
        if (!exactKeys(call, ['deadlineUnixMs'])
            || !Number.isSafeInteger(call.deadlineUnixMs) || call.deadlineUnixMs <= 0) {
            throw nativeError(
                'INVALID_ARGUMENT',
                'native project graph invalidation request is invalid',
                false,
            );
        }
        if (state !== 'connected') await waitUntilConnected(call.deadlineUnixMs);
        const result = await send(
            'invalidateGraph',
            { reason: 'cep-jsx' },
            { deadlineUnixMs: call.deadlineUnixMs },
        );
        if (!exactKeys(result, ['generation', 'invalidated'])
            || !Number.isSafeInteger(result.generation) || result.generation < 0
            || typeof result.invalidated !== 'boolean'
            || (result.invalidated ? result.generation < 1 : result.generation !== 0)) {
            throw nativeContractMismatch(
                'native project graph invalidation result was malformed',
            );
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
        invalidateProjectGraph,
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
                projectBitDepthReadContractDigest,
                projectBitDepthSetContractDigest,
                projectItemsListContractDigest,
                compositionLayersListContractDigest,
                compositionSelectedLayersListContractDigest,
                compositionTimeReadContractDigest,
                compositionTimeSetContractDigest,
                compositionCreateContractDigest,
                compositionLayerCreateContractDigest,
                layerEffectApplyContractDigest,
                layerPropertiesListContractDigest,
                layerPropertyKeyframesListContractDigest,
                layerPropertySetContractDigest,
                projectCompositionContractDigests: Object.fromEntries(
                    projectCompositionContractDigests,
                ),
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
