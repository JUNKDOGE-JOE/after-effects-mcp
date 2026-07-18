'use strict';

// Closed CEP-side verification for capability package #150. This is not a
// route resolver: it only validates the eight named native wire contracts.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;

function exactKeys(value, required) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === required.length
        && required.every(function (key) { return Object.hasOwn(value, key); });
}

function closedKeys(value, required, optional) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(required.concat(optional));
    const keys = Object.keys(value);
    return required.every(function (key) { return Object.hasOwn(value, key); })
        && keys.every(function (key) { return allowed.has(key); });
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

function validString(value, minimum, maximum) {
    const length = unicodeScalarLength(value);
    return length !== null && length >= minimum && length <= maximum
        && !value.includes('\u0000');
}

function gcd(left, right) {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b !== 0) [a, b] = [b, a % b];
    return a;
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

function sameContext(left, right) {
    return left.hostInstanceId === right.hostInstanceId
        && left.sessionId === right.sessionId
        && left.projectId === right.projectId
        && left.generation === right.generation;
}

function sameLocator(left, right) {
    return sameContext(left, right)
        && left.kind === right.kind && left.objectId === right.objectId;
}

function boundToSession(locator, hostInstanceId, sessionId) {
    return locator.hostInstanceId === hostInstanceId && locator.sessionId === sessionId;
}

function reducedRational(value, scale) {
    const divisor = gcd(value, scale);
    const numerator = value / divisor;
    const denominator = scale / divisor;
    return denominator === 1 ? String(numerator) : String(numerator) + '/' + String(denominator);
}

function validTime(value, exact, minimum) {
    const keys = exact ? ['value', 'scale', 'secondsRational'] : ['value', 'scale'];
    return exactKeys(value, keys)
        && Number.isInteger(value.value) && value.value >= minimum && value.value <= 2147483647
        && Number.isInteger(value.scale) && value.scale >= 1 && value.scale <= 4294967295
        && (!exact || (typeof value.secondsRational === 'string'
            && value.secondsRational === reducedRational(value.value, value.scale)));
}

function timesEqual(left, right) {
    return BigInt(left.value) * BigInt(right.scale)
        === BigInt(right.value) * BigInt(left.scale);
}

function validRatio(value) {
    if (!exactKeys(value, ['numerator', 'denominator', 'rational'])
        || !Number.isInteger(value.numerator) || value.numerator < 1
        || value.numerator > 2147483647
        || !Number.isInteger(value.denominator) || value.denominator < 1
        || value.denominator > 2147483647) return false;
    return value.rational === reducedRational(value.numerator, value.denominator);
}

function validWorkArea(value) {
    return exactKeys(value, ['start', 'duration'])
        && validTime(value.start, true, 0)
        && validTime(value.duration, true, 1);
}

function validIdempotencyKey(value) {
    return typeof value === 'string' && value.length >= 16 && value.length <= 64
        && TOKEN_PATTERN.test(value);
}

function validProjectItem(value, hostInstanceId, sessionId) {
    if (!exactKeys(value, ['locator', 'name', 'type', 'parentLocator'])
        || !validLocator(value.locator, ['item', 'composition'])
        || !validLocator(value.parentLocator, ['project', 'item'])
        || !boundToSession(value.locator, hostInstanceId, sessionId)
        || !sameContext(value.locator, value.parentLocator)
        || !validString(value.name, 0, 1024)
        || !['folder', 'composition', 'footage', 'unknown'].includes(value.type)) return false;
    return value.locator.kind === (value.type === 'composition' ? 'composition' : 'item');
}

function validSettingsSnapshot(value) {
    if (!exactKeys(value, [
        'name', 'width', 'height', 'duration', 'frameDuration', 'frameRate',
        'pixelAspectRatio', 'workArea', 'displayStartTime', 'layerCount',
    ])
        || !validString(value.name, 0, 1024)
        || !Number.isInteger(value.width) || value.width < 1 || value.width > 30000
        || !Number.isInteger(value.height) || value.height < 1 || value.height > 30000
        || !validTime(value.duration, true, 1)
        || !validTime(value.frameDuration, true, 1)
        || !validRatio(value.frameRate)
        || !validRatio(value.pixelAspectRatio)
        || !validWorkArea(value.workArea)
        || !validTime(value.displayStartTime, true, -2147483648)
        || !Number.isSafeInteger(value.layerCount) || value.layerCount < 0) return false;
    const reciprocalFrameRate = BigInt(value.frameDuration.value)
        * BigInt(value.frameRate.numerator)
        === BigInt(value.frameDuration.scale) * BigInt(value.frameRate.denominator);
    const workEndNumerator = BigInt(value.workArea.start.value)
        * BigInt(value.workArea.duration.scale)
        + BigInt(value.workArea.duration.value) * BigInt(value.workArea.start.scale);
    const workEndScale = BigInt(value.workArea.start.scale)
        * BigInt(value.workArea.duration.scale);
    const workAreaFits = workEndNumerator * BigInt(value.duration.scale)
        <= BigInt(value.duration.value) * workEndScale;
    return reciprocalFrameRate && workAreaFits;
}

function settingsFacts(value) {
    return {
        displayStartTime: value.displayStartTime,
        duration: value.duration,
        frameDuration: value.frameDuration,
        frameRate: value.frameRate,
        height: value.height,
        layerCount: value.layerCount,
        pixelAspectRatio: value.pixelAspectRatio,
        width: value.width,
        workArea: value.workArea,
    };
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
        return Object.keys(value).sort().reduce(function (result, key) {
            result[key] = canonicalize(value[key]);
            return result;
        }, {});
    }
    return value;
}

function validContextArguments(value) {
    return exactKeys(value, ['selectionOffset', 'selectionLimit'])
        && Number.isSafeInteger(value.selectionOffset) && value.selectionOffset >= 0
        && Number.isInteger(value.selectionLimit)
        && value.selectionLimit >= 1 && value.selectionLimit <= 50;
}

function validContextValue(value, argumentsValue, hostInstanceId, sessionId) {
    if (!exactKeys(value, [
        'projectLocator', 'generation', 'activeItem', 'mostRecentlyUsedComposition', 'selection',
    ]) || !validLocator(value.projectLocator, ['project'])
        || !boundToSession(value.projectLocator, hostInstanceId, sessionId)
        || value.generation !== value.projectLocator.generation
        || (value.activeItem !== null
            && !validProjectItem(value.activeItem, hostInstanceId, sessionId))
        || (value.mostRecentlyUsedComposition !== null
            && (!validProjectItem(value.mostRecentlyUsedComposition, hostInstanceId, sessionId)
                || value.mostRecentlyUsedComposition.type !== 'composition'))
        || !exactKeys(value.selection, [
            'total', 'offset', 'limit', 'returned', 'hasMore', 'nextOffset', 'items',
        ]) || !Array.isArray(value.selection.items)
        || value.selection.offset !== argumentsValue.selectionOffset
        || value.selection.limit !== argumentsValue.selectionLimit
        || !Number.isSafeInteger(value.selection.total) || value.selection.total < 0
        || !Number.isInteger(value.selection.returned)
        || value.selection.returned !== value.selection.items.length
        || value.selection.returned > value.selection.limit) return false;
    const related = [value.activeItem, value.mostRecentlyUsedComposition]
        .concat(value.selection.items).filter(Boolean);
    if (!related.every(function (item) {
        return validProjectItem(item, hostInstanceId, sessionId)
            && sameContext(item.locator, value.projectLocator);
    })) return false;
    const consumed = value.selection.offset + value.selection.returned;
    const hasMore = consumed < value.selection.total;
    return consumed <= value.selection.total
        && value.selection.hasMore === hasMore
        && value.selection.nextOffset === (hasMore ? consumed : null)
        && (!hasMore || value.selection.returned > 0)
        && new Set(value.selection.items.map(function (item) { return item.locator.objectId; })).size
            === value.selection.items.length;
}

function validItemLocatorArguments(value) {
    return exactKeys(value, ['itemLocator'])
        && validLocator(value.itemLocator, ['item', 'composition']);
}

function validMetadataValue(value, argumentsValue, hostInstanceId, sessionId) {
    const required = ['itemLocator', 'name', 'type', 'parentLocator', 'comment', 'labelId'];
    const optional = ['width', 'height', 'duration', 'pixelAspectRatio', 'layerCount'];
    if (!closedKeys(value, required, optional)
        || !validLocator(value.itemLocator, ['item', 'composition'])
        || !sameLocator(value.itemLocator, argumentsValue.itemLocator)
        || !boundToSession(value.itemLocator, hostInstanceId, sessionId)
        || (value.parentLocator !== null
            && (!validLocator(value.parentLocator, ['project', 'item'])
                || !sameContext(value.itemLocator, value.parentLocator)))
        || !validString(value.name, 0, 1024)
        || !validString(value.comment, 0, 1024)
        || !['folder', 'composition', 'footage', 'unknown'].includes(value.type)
        || !Number.isInteger(value.labelId) || value.labelId < 0 || value.labelId > 16) return false;
    const composition = value.type === 'composition';
    if (value.itemLocator.kind !== (composition ? 'composition' : 'item')) return false;
    if (composition) {
        return optional.every(function (key) { return Object.hasOwn(value, key); })
            && Number.isInteger(value.width) && value.width >= 1 && value.width <= 30000
            && Number.isInteger(value.height) && value.height >= 1 && value.height <= 30000
            && validTime(value.duration, true, 1)
            && validRatio(value.pixelAspectRatio)
            && Number.isSafeInteger(value.layerCount) && value.layerCount >= 0;
    }
    return !Object.hasOwn(value, 'layerCount')
        && (!Object.hasOwn(value, 'width')
            || (Number.isInteger(value.width) && value.width >= 1 && value.width <= 30000))
        && (!Object.hasOwn(value, 'height')
            || (Number.isInteger(value.height) && value.height >= 1 && value.height <= 30000))
        && (!Object.hasOwn(value, 'duration')
            || validTime(value.duration, true, -2147483648))
        && (!Object.hasOwn(value, 'pixelAspectRatio') || validRatio(value.pixelAspectRatio));
}

function validCompositionLocatorArguments(value) {
    return exactKeys(value, ['compositionLocator'])
        && validLocator(value.compositionLocator, ['composition']);
}

function validSettingsValue(value, argumentsValue, hostInstanceId, sessionId) {
    if (!exactKeys(value, [
        'compositionLocator', 'name', 'width', 'height', 'duration', 'frameDuration',
        'frameRate', 'pixelAspectRatio', 'workArea', 'displayStartTime', 'layerCount',
    ]) || !validLocator(value.compositionLocator, ['composition'])
        || !sameLocator(value.compositionLocator, argumentsValue.compositionLocator)
        || !boundToSession(value.compositionLocator, hostInstanceId, sessionId)) return false;
    const snapshot = { ...value };
    delete snapshot.compositionLocator;
    return validSettingsSnapshot(snapshot);
}

function validWorkAreaArguments(value) {
    return exactKeys(value, ['compositionLocator', 'start', 'duration', 'idempotencyKey'])
        && validLocator(value.compositionLocator, ['composition'])
        && validTime(value.start, false, 0)
        && validTime(value.duration, false, 1)
        && validIdempotencyKey(value.idempotencyKey);
}

function validWorkAreaValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, ['changed', 'compositionLocator', 'beforeWorkArea', 'afterWorkArea'])
        && value.changed === true
        && validLocator(value.compositionLocator, ['composition'])
        && sameLocator(value.compositionLocator, argumentsValue.compositionLocator)
        && boundToSession(value.compositionLocator, hostInstanceId, sessionId)
        && validWorkArea(value.beforeWorkArea) && validWorkArea(value.afterWorkArea)
        && (!timesEqual(value.beforeWorkArea.start, value.afterWorkArea.start)
            || !timesEqual(value.beforeWorkArea.duration, value.afterWorkArea.duration))
        && timesEqual(value.afterWorkArea.start, argumentsValue.start)
        && timesEqual(value.afterWorkArea.duration, argumentsValue.duration);
}

function validItemWriteArguments(value, member, validator) {
    return exactKeys(value, ['itemLocator', member, 'idempotencyKey'])
        && validLocator(value.itemLocator, ['item', 'composition'])
        && validator(value[member]) && validIdempotencyKey(value.idempotencyKey);
}

function validItemWriteValue(
    value,
    argumentsValue,
    hostInstanceId,
    sessionId,
    beforeMember,
    afterMember,
    argumentMember,
    validator,
) {
    return exactKeys(value, ['changed', 'itemLocator', beforeMember, afterMember])
        && value.changed === true
        && validLocator(value.itemLocator, ['item', 'composition'])
        && sameLocator(value.itemLocator, argumentsValue.itemLocator)
        && boundToSession(value.itemLocator, hostInstanceId, sessionId)
        && validator(value[beforeMember]) && validator(value[afterMember])
        && value[beforeMember] !== value[afterMember]
        && value[afterMember] === argumentsValue[argumentMember];
}

function validDuplicateArguments(value) {
    return exactKeys(value, ['compositionLocator', 'newName', 'idempotencyKey'])
        && validLocator(value.compositionLocator, ['composition'])
        && validString(value.newName, 1, 255)
        && validIdempotencyKey(value.idempotencyKey);
}

function validDuplicateValue(value, argumentsValue, hostInstanceId, sessionId) {
    if (!exactKeys(value, [
        'changed', 'sourceCompositionLocator', 'newCompositionLocator',
        'projectItemCountBefore', 'projectItemCountAfter', 'sourceSettings', 'newSettings',
    ]) || value.changed !== true
        || !validLocator(value.sourceCompositionLocator, ['composition'])
        || !validLocator(value.newCompositionLocator, ['composition'])
        || !boundToSession(value.sourceCompositionLocator, hostInstanceId, sessionId)
        || !boundToSession(value.newCompositionLocator, hostInstanceId, sessionId)
        || !sameContext(value.sourceCompositionLocator, value.newCompositionLocator)
        || value.sourceCompositionLocator.generation <= argumentsValue.compositionLocator.generation
        || value.newCompositionLocator.objectId === value.sourceCompositionLocator.objectId
        || !Number.isSafeInteger(value.projectItemCountBefore)
        || value.projectItemCountBefore < 0
        || value.projectItemCountAfter !== value.projectItemCountBefore + 1
        || !validSettingsSnapshot(value.sourceSettings)
        || !validSettingsSnapshot(value.newSettings)
        || value.newSettings.name !== argumentsValue.newName) return false;
    return JSON.stringify(canonicalize(settingsFacts(value.sourceSettings)))
        === JSON.stringify(canonicalize(settingsFacts(value.newSettings)));
}

const CONTRACTS = Object.freeze({
    'ae.project.context.read': Object.freeze({
        digest: 'ee6df463fe36f13a02a09b833b0f13a01ba1c2a5dc335d689c04ea834ad10dca',
        mutating: false,
        postconditionKind: 'project-context-read',
        validArguments: validContextArguments,
        validValue: validContextValue,
        locatorFields: Object.freeze([]),
    }),
    'ae.project.item.metadata.read': Object.freeze({
        digest: 'b13139c0b2e8073f6606bfbead1e59eb7fea63ec10a164b500e19ff8babd0f69',
        mutating: false,
        postconditionKind: 'project-item-metadata-read',
        validArguments: validItemLocatorArguments,
        validValue: validMetadataValue,
        locatorFields: Object.freeze([['itemLocator', 'ae_getProjectContext']]),
    }),
    'ae.composition.settings.read': Object.freeze({
        digest: 'a7ae9383b4a627bf6f3f42cb929eafa724cf7bc30a172b67ddbcaf9e754f5e9b',
        mutating: false,
        postconditionKind: 'composition-settings-read',
        validArguments: validCompositionLocatorArguments,
        validValue: validSettingsValue,
        locatorFields: Object.freeze([['compositionLocator', 'ae_getProjectContext']]),
    }),
    'ae.composition.work-area.set': Object.freeze({
        digest: 'a4ffd90349164e1d7228e5d2374ef55c9f0dc1065db0dac9945a7f8eeb16b997',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'composition-work-area-set',
        validArguments: validWorkAreaArguments,
        validValue: validWorkAreaValue,
        locatorFields: Object.freeze([['compositionLocator', 'ae_getProjectContext']]),
    }),
    'ae.project.item.name.set': Object.freeze({
        digest: 'b26f017991e74f009b15cb24fcfd4bb7f154d4ac506f65f150b29efcccb9f538',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'project-item-name-set',
        validArguments: function (value) {
            return validItemWriteArguments(value, 'name', function (member) {
                return validString(member, 1, 255);
            });
        },
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validItemWriteValue(
                value, argumentsValue, hostInstanceId, sessionId,
                'beforeName', 'afterName', 'name', function (member) {
                    return validString(member, 0, 1024);
                },
            ) && validString(value.afterName, 1, 255);
        },
        locatorFields: Object.freeze([['itemLocator', 'ae_getProjectContext']]),
    }),
    'ae.project.item.comment.set': Object.freeze({
        digest: '957985628474caa9c9cef3de76a2839e59691232b062b776ff800a79dd3cc35c',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'project-item-comment-set',
        validArguments: function (value) {
            return validItemWriteArguments(value, 'comment', function (member) {
                return validString(member, 0, 1024);
            });
        },
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validItemWriteValue(
                value, argumentsValue, hostInstanceId, sessionId,
                'beforeComment', 'afterComment', 'comment', function (member) {
                    return validString(member, 0, 1024);
                },
            );
        },
        locatorFields: Object.freeze([['itemLocator', 'ae_getProjectContext']]),
    }),
    'ae.project.item.label.set': Object.freeze({
        digest: '4463637f6a5298b27afb39cea68c593a93383e4ccc7926bc228d00e0cc3ba94f',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'project-item-label-set',
        validArguments: function (value) {
            return validItemWriteArguments(value, 'labelId', function (member) {
                return Number.isInteger(member) && member >= 0 && member <= 16;
            });
        },
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validItemWriteValue(
                value, argumentsValue, hostInstanceId, sessionId,
                'beforeLabelId', 'afterLabelId', 'labelId', function (member) {
                    return Number.isInteger(member) && member >= 0 && member <= 16;
                },
            );
        },
        locatorFields: Object.freeze([['itemLocator', 'ae_getProjectContext']]),
    }),
    'ae.composition.duplicate': Object.freeze({
        digest: '96e7a14f7e2b983fac41a918657b101f54638d5ae6acee6003757bc6458b3be3',
        mutating: true,
        allowReplay: true,
        postconditionKind: 'composition-duplicate',
        validArguments: validDuplicateArguments,
        validValue: validDuplicateValue,
        locatorFields: Object.freeze([['compositionLocator', 'ae_getProjectContext']]),
    }),
});

function getContract(capabilityId) {
    if (typeof capabilityId !== 'string' || !Object.hasOwn(CONTRACTS, capabilityId)) {
        return null;
    }
    return CONTRACTS[capabilityId];
}

function validateCapabilityItems(items, requestedIds, detail) {
    if (!Array.isArray(items)) return null;
    const verified = new Map();
    for (const [capabilityId, contract] of Object.entries(CONTRACTS)) {
        const matches = items.filter(function (item) { return item?.id === capabilityId; });
        const required = requestedIds === undefined || requestedIds.includes(capabilityId);
        if ((required && matches.length !== 1) || (!required && matches.length > 1)) return null;
        if (matches.length === 0) continue;
        const item = matches[0];
        const expected = contract.mutating ? {
            risk: 'write', mutability: 'mutating', idempotency: 'idempotency-key',
            undo: 'ae-undo-group',
        } : {
            risk: 'read', mutability: 'read-only', idempotency: 'idempotent',
            undo: 'not-applicable',
        };
        if (item.version !== 1 || item.detail !== detail
            || (detail === 'full' && (item.contractDigest !== contract.digest
                || item.risk !== expected.risk
                || item.mutability !== expected.mutability
                || item.idempotency !== expected.idempotency
                || item.undo !== expected.undo))) return null;
        if (detail === 'full') verified.set(capabilityId, item.contractDigest);
    }
    return verified;
}

function locatorChecks(contract, argumentsValue) {
    return contract.locatorFields.map(function (entry) {
        return [argumentsValue[entry[0]], entry[0], entry[1]];
    });
}

module.exports = Object.freeze({
    CONTRACTS,
    getContract,
    locatorChecks,
    validateCapabilityItems,
});
