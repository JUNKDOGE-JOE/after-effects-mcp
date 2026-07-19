'use strict';

// Closed CEP-side verification for the #150, #155, and #157 capability packages.
// This is not a route resolver: it only validates the named native contracts.

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

function validSignedRatio(value) {
    if (!exactKeys(value, ['numerator', 'denominator', 'rational'])
        || !Number.isInteger(value.numerator) || value.numerator === 0
        || value.numerator < -2147483648 || value.numerator > 2147483647
        || !Number.isInteger(value.denominator) || value.denominator < 1
        || value.denominator > 2147483647) return false;
    return value.rational === reducedRational(value.numerator, value.denominator);
}

function ratiosEqual(left, right) {
    const leftNumerator = Object.hasOwn(left, 'numerator') ? left.numerator : left.num;
    const leftDenominator = Object.hasOwn(left, 'denominator') ? left.denominator : left.den;
    const rightNumerator = Object.hasOwn(right, 'numerator') ? right.numerator : right.num;
    const rightDenominator = Object.hasOwn(right, 'denominator') ? right.denominator : right.den;
    return BigInt(leftNumerator) * BigInt(rightDenominator)
        === BigInt(rightNumerator) * BigInt(leftDenominator);
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

function validLayerLocatorArguments(value) {
    return exactKeys(value, ['layerLocator'])
        && validLocator(value.layerLocator, ['layer']);
}

function validLayerDetails(value, hostInstanceId, sessionId) {
    if (!exactKeys(value, [
        'layerLocator', 'compositionLocator', 'stackIndex', 'name', 'type',
        'videoEnabled', 'isThreeD', 'locked', 'parentLocator', 'sourceItemLocator',
        'inPoint', 'duration', 'startTime', 'stretch',
    ]) || !validLocator(value.layerLocator, ['layer'])
        || !validLocator(value.compositionLocator, ['composition'])
        || !boundToSession(value.layerLocator, hostInstanceId, sessionId)
        || !sameContext(value.layerLocator, value.compositionLocator)
        || !Number.isSafeInteger(value.stackIndex) || value.stackIndex < 1
        || !validString(value.name, 0, 1024)
        || !['av', 'camera', 'light', 'text', 'shape', 'model3d', 'null', 'adjustment', 'unknown']
            .includes(value.type)
        || typeof value.videoEnabled !== 'boolean'
        || typeof value.isThreeD !== 'boolean'
        || typeof value.locked !== 'boolean'
        || !validTime(value.inPoint, true, -2147483648)
        || !validTime(value.duration, true, -2147483648)
        || value.duration.value <= 0
        || !validTime(value.startTime, true, -2147483648)
        || !validSignedRatio(value.stretch)) return false;
    if (value.parentLocator !== null
        && (!validLocator(value.parentLocator, ['layer'])
            || !sameContext(value.layerLocator, value.parentLocator)
            || value.parentLocator.objectId === value.layerLocator.objectId)) return false;
    return value.sourceItemLocator === null
        || (validLocator(value.sourceItemLocator, ['item', 'composition'])
            && sameContext(value.layerLocator, value.sourceItemLocator));
}

function validLayerDetailsValue(value, argumentsValue, hostInstanceId, sessionId) {
    return validLayerDetails(value, hostInstanceId, sessionId)
        && sameLocator(value.layerLocator, argumentsValue.layerLocator);
}

function validLayerWriteArguments(value, member, validator) {
    return exactKeys(value, ['layerLocator', member, 'idempotencyKey'])
        && validLocator(value.layerLocator, ['layer'])
        && validator(value[member])
        && validIdempotencyKey(value.idempotencyKey);
}

function validLayerWriteLocator(value, argumentsValue, hostInstanceId, sessionId) {
    return validLocator(value.layerLocator, ['layer'])
        && sameLocator(value.layerLocator, argumentsValue.layerLocator)
        && boundToSession(value.layerLocator, hostInstanceId, sessionId);
}

function validLayerNameValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, ['changed', 'layerLocator', 'beforeName', 'afterName'])
        && value.changed === true
        && validLayerWriteLocator(value, argumentsValue, hostInstanceId, sessionId)
        && validString(value.beforeName, 0, 1024)
        && validString(value.afterName, 1, 255)
        && value.beforeName !== value.afterName
        && value.afterName === argumentsValue.name;
}

function validLayerRangeValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, [
        'changed', 'layerLocator', 'beforeInPoint', 'beforeDuration',
        'afterInPoint', 'afterDuration',
    ]) && value.changed === true
        && validLayerWriteLocator(value, argumentsValue, hostInstanceId, sessionId)
        && validTime(value.beforeInPoint, true, -2147483648)
        && validTime(value.beforeDuration, true, -2147483648)
        && validTime(value.afterInPoint, true, -2147483648)
        && validTime(value.afterDuration, true, -2147483648)
        && (!timesEqual(value.beforeInPoint, value.afterInPoint)
            || !timesEqual(value.beforeDuration, value.afterDuration))
        && timesEqual(value.afterInPoint, argumentsValue.inPoint)
        && timesEqual(value.afterDuration, argumentsValue.duration);
}

function validLayerStartTimeValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, ['changed', 'layerLocator', 'beforeStartTime', 'afterStartTime'])
        && value.changed === true
        && validLayerWriteLocator(value, argumentsValue, hostInstanceId, sessionId)
        && validTime(value.beforeStartTime, true, -2147483648)
        && validTime(value.afterStartTime, true, -2147483648)
        && !timesEqual(value.beforeStartTime, value.afterStartTime)
        && timesEqual(value.afterStartTime, argumentsValue.startTime);
}

function validLayerStretchInput(value) {
    return exactKeys(value, ['num', 'den'])
        && Number.isInteger(value.num) && value.num !== 0
        && value.num >= -2147483648 && value.num <= 2147483647
        && Number.isInteger(value.den) && value.den >= 1 && value.den <= 2147483647;
}

function validLayerStretchValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, ['changed', 'layerLocator', 'beforeStretch', 'afterStretch'])
        && value.changed === true
        && validLayerWriteLocator(value, argumentsValue, hostInstanceId, sessionId)
        && validSignedRatio(value.beforeStretch) && validSignedRatio(value.afterStretch)
        && !ratiosEqual(value.beforeStretch, value.afterStretch)
        && ratiosEqual(value.afterStretch, argumentsValue.stretch);
}

function validLayerOrderValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, ['changed', 'layerLocator', 'beforeStackIndex', 'afterStackIndex'])
        && value.changed === true
        && validLayerWriteLocator(value, argumentsValue, hostInstanceId, sessionId)
        && Number.isSafeInteger(value.beforeStackIndex) && value.beforeStackIndex > 0
        && Number.isSafeInteger(value.afterStackIndex) && value.afterStackIndex > 0
        && value.beforeStackIndex !== value.afterStackIndex
        && value.afterStackIndex === argumentsValue.targetStackIndex;
}

function validNullableParent(locator, layerLocator) {
    return locator === null
        || (validLocator(locator, ['layer'])
            && sameContext(locator, layerLocator)
            && locator.objectId !== layerLocator.objectId);
}

function sameNullableLocator(left, right) {
    return left === null ? right === null : right !== null && sameLocator(left, right);
}

function validLayerParentArguments(value) {
    return exactKeys(value, ['layerLocator', 'parentLayerLocator', 'idempotencyKey'])
        && validLocator(value.layerLocator, ['layer'])
        && validNullableParent(value.parentLayerLocator, value.layerLocator)
        && validIdempotencyKey(value.idempotencyKey);
}

function validLayerParentValue(value, argumentsValue, hostInstanceId, sessionId) {
    return exactKeys(value, [
        'changed', 'layerLocator', 'beforeParentLocator', 'afterParentLocator',
    ]) && value.changed === true
        && validLayerWriteLocator(value, argumentsValue, hostInstanceId, sessionId)
        && validNullableParent(value.beforeParentLocator, value.layerLocator)
        && validNullableParent(value.afterParentLocator, value.layerLocator)
        && !sameNullableLocator(value.beforeParentLocator, value.afterParentLocator)
        && sameNullableLocator(value.afterParentLocator, argumentsValue.parentLayerLocator);
}

function validLayerDuplicateArguments(value) {
    return validLayerWriteArguments(value, 'newName', function (name) {
        return validString(name, 1, 255);
    });
}

function validLayerDuplicateValue(value, argumentsValue, hostInstanceId, sessionId) {
    if (!exactKeys(value, [
        'changed', 'sourceLayerLocator', 'newLayerLocator', 'compositionLocator',
        'layerCountBefore', 'layerCountAfter', 'newLayer',
    ]) || value.changed !== true
        || !validLocator(value.sourceLayerLocator, ['layer'])
        || !validLocator(value.newLayerLocator, ['layer'])
        || !validLocator(value.compositionLocator, ['composition'])
        || !boundToSession(value.sourceLayerLocator, hostInstanceId, sessionId)
        || !sameContext(value.sourceLayerLocator, value.newLayerLocator)
        || !sameContext(value.sourceLayerLocator, value.compositionLocator)
        || value.sourceLayerLocator.objectId !== argumentsValue.layerLocator.objectId
        || value.sourceLayerLocator.projectId === argumentsValue.layerLocator.projectId
        || value.sourceLayerLocator.generation <= argumentsValue.layerLocator.generation
        || value.newLayerLocator.objectId === value.sourceLayerLocator.objectId
        || !Number.isSafeInteger(value.layerCountBefore) || value.layerCountBefore < 0
        || value.layerCountAfter !== value.layerCountBefore + 1
        || !validLayerDetails(value.newLayer, hostInstanceId, sessionId)
        || !sameLocator(value.newLayer.layerLocator, value.newLayerLocator)
        || !sameLocator(value.newLayer.compositionLocator, value.compositionLocator)
        || value.newLayer.stackIndex > value.layerCountAfter
        || value.newLayer.name !== argumentsValue.newName) return false;
    return true;
}

const KEYFRAME_VALUE_TYPES = Object.freeze([
    'one-d', 'two-d', 'two-d-spatial', 'three-d', 'three-d-spatial', 'color',
]);
const KEYFRAME_INTERPOLATIONS = Object.freeze(['none', 'linear', 'bezier', 'hold']);
const KEYFRAME_SET_INTERPOLATIONS = Object.freeze(['linear', 'bezier', 'hold']);
const KEYFRAME_BEHAVIORS = Object.freeze([
    'temporal-continuous', 'temporal-auto-bezier', 'spatial-continuous',
    'spatial-auto-bezier', 'roving',
]);

function validDecimalString(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 32
        || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)) {
        return false;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (parsed === 0 && value[0] === '-')) return false;
    if (parsed !== 0) return true;
    return !/[1-9]/.test(value.split(/[eE]/, 1)[0]);
}

function validKeyframeSample(value, valueType) {
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
    return valueType === 'color'
        && exactKeys(value, ['kind', 'alpha', 'red', 'green', 'blue'])
        && value.kind === 'color'
        && ['alpha', 'red', 'green', 'blue'].every(function (key) {
            return validDecimalString(value[key]);
        });
}

function validAnyKeyframeSample(value) {
    return KEYFRAME_VALUE_TYPES.some(function (valueType) {
        return validKeyframeSample(value, valueType);
    });
}

function keyframeSamplesEqual(left, right) {
    if (!left || !right || left.kind !== right.kind) return false;
    const equalDecimal = function (a, b) { return Number(a) === Number(b); };
    if (left.kind === 'scalar') return equalDecimal(left.value, right.value);
    if (left.kind === 'vector') {
        return left.components.length === right.components.length
            && left.components.every(function (item, index) {
                return equalDecimal(item, right.components[index]);
            });
    }
    return ['alpha', 'red', 'green', 'blue'].every(function (key) {
        return equalDecimal(left[key], right[key]);
    });
}

function validKeyframeEase(value) {
    return exactKeys(value, ['speed', 'influence'])
        && validDecimalString(value.speed) && validDecimalString(value.influence)
        && Number(value.influence) >= 0 && Number(value.influence) <= 100;
}

function validKeyframeEaseDimensions(value, expectedLength) {
    return Array.isArray(value) && value.length >= 1 && value.length <= 4
        && (expectedLength === undefined || value.length === expectedLength)
        && value.every(function (item, index) {
            return exactKeys(item, ['dimension', 'inEase', 'outEase'])
                && item.dimension === index
                && validKeyframeEase(item.inEase) && validKeyframeEase(item.outEase);
        });
}

function keyframeEaseDimensionsEqual(left, right) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
        && left.every(function (item, index) {
            const other = right[index];
            return item.dimension === other.dimension
                && Number(item.inEase.speed) === Number(other.inEase.speed)
                && Number(item.inEase.influence) === Number(other.inEase.influence)
                && Number(item.outEase.speed) === Number(other.outEase.speed)
                && Number(item.outEase.influence) === Number(other.outEase.influence);
        });
}

function validKeyframeBehaviors(value) {
    return exactKeys(value, [
        'temporalContinuous', 'temporalAutoBezier', 'spatialContinuous',
        'spatialAutoBezier', 'roving',
    ]) && Object.values(value).every(function (member) { return typeof member === 'boolean'; });
}

function validKeyframeDetails(value, propertyLocator, time, hostInstanceId, sessionId) {
    return exactKeys(value, [
        'propertyLocator', 'time', 'temporalDimensionality', 'valueType', 'value',
        'inInterpolation', 'outInterpolation', 'temporalEaseDimensions', 'behaviors',
    ])
        && validLocator(value.propertyLocator, ['stream'])
        && boundToSession(value.propertyLocator, hostInstanceId, sessionId)
        && sameLocator(value.propertyLocator, propertyLocator)
        && validTime(value.time, true, -2147483648) && timesEqual(value.time, time)
        && Number.isInteger(value.temporalDimensionality)
        && value.temporalDimensionality >= 1 && value.temporalDimensionality <= 4
        && KEYFRAME_VALUE_TYPES.includes(value.valueType)
        && validKeyframeSample(value.value, value.valueType)
        && KEYFRAME_INTERPOLATIONS.includes(value.inInterpolation)
        && KEYFRAME_INTERPOLATIONS.includes(value.outInterpolation)
        && validKeyframeEaseDimensions(
            value.temporalEaseDimensions, value.temporalDimensionality,
        )
        && validKeyframeBehaviors(value.behaviors);
}

function validKeyframeTargetArguments(value) {
    return exactKeys(value, ['propertyLocator', 'time'])
        && validLocator(value.propertyLocator, ['stream'])
        && validTime(value.time, false, -2147483648);
}

function validKeyframeWriteArguments(value, extraKeys, extraValidator) {
    return exactKeys(value, [
        'layerLocator', 'propertyLocator', 'time', 'idempotencyKey',
    ].concat(extraKeys))
        && validLocator(value.layerLocator, ['layer'])
        && validLocator(value.propertyLocator, ['stream'])
        && sameContext(value.layerLocator, value.propertyLocator)
        && validTime(value.time, false, -2147483648)
        && validIdempotencyKey(value.idempotencyKey)
        && extraValidator(value);
}

function validKeyframeMutation(value, argumentsValue, hostInstanceId, sessionId) {
    if (!exactKeys(value, [
        'changed', 'layerLocator', 'propertyLocator', 'time', 'keyframeCountBefore',
        'keyframeCountAfter', 'beforeKeyframe', 'afterKeyframe',
    ]) || value.changed !== true
        || !validLocator(value.layerLocator, ['layer'])
        || !validLocator(value.propertyLocator, ['stream'])
        || !boundToSession(value.layerLocator, hostInstanceId, sessionId)
        || !sameLocator(value.layerLocator, argumentsValue.layerLocator)
        || !sameLocator(value.propertyLocator, argumentsValue.propertyLocator)
        || !sameContext(value.layerLocator, value.propertyLocator)
        || !validTime(value.time, true, -2147483648)
        || !timesEqual(value.time, argumentsValue.time)
        || !Number.isSafeInteger(value.keyframeCountBefore) || value.keyframeCountBefore < 0
        || !Number.isSafeInteger(value.keyframeCountAfter) || value.keyframeCountAfter < 0) {
        return false;
    }
    for (const snapshot of [value.beforeKeyframe, value.afterKeyframe]) {
        if (snapshot !== null && !validKeyframeDetails(
            snapshot, value.propertyLocator, value.time, hostInstanceId, sessionId,
        )) return false;
    }
    return value.beforeKeyframe !== null || value.afterKeyframe !== null;
}

function keyframeDetailsEqualExcept(left, right, excluded) {
    const leftValue = { ...left };
    const rightValue = { ...right };
    for (const key of excluded) {
        delete leftValue[key];
        delete rightValue[key];
    }
    return JSON.stringify(canonicalize(leftValue)) === JSON.stringify(canonicalize(rightValue));
}

function validKeyframeWriteValue(kind, value, argumentsValue, hostInstanceId, sessionId) {
    if (!validKeyframeMutation(value, argumentsValue, hostInstanceId, sessionId)) return false;
    const before = value.beforeKeyframe;
    const after = value.afterKeyframe;
    if (kind === 'add') {
        return before === null && after !== null
            && value.keyframeCountAfter === value.keyframeCountBefore + 1
            && keyframeSamplesEqual(after.value, argumentsValue.value);
    }
    if (kind === 'delete') {
        return before !== null && after === null
            && value.keyframeCountBefore === value.keyframeCountAfter + 1;
    }
    if (before === null || after === null
        || value.keyframeCountBefore !== value.keyframeCountAfter) return false;
    if (kind === 'value') {
        return !keyframeSamplesEqual(before.value, after.value)
            && keyframeSamplesEqual(after.value, argumentsValue.value)
            && keyframeDetailsEqualExcept(before, after, ['value']);
    }
    if (kind === 'interpolation') {
        return (before.inInterpolation !== after.inInterpolation
                || before.outInterpolation !== after.outInterpolation)
            && after.inInterpolation === argumentsValue.inInterpolation
            && after.outInterpolation === argumentsValue.outInterpolation
            && keyframeDetailsEqualExcept(
                before, after, ['inInterpolation', 'outInterpolation'],
            );
    }
    if (kind === 'ease') {
        return !keyframeEaseDimensionsEqual(
            before.temporalEaseDimensions, after.temporalEaseDimensions,
        )
            && keyframeEaseDimensionsEqual(
                after.temporalEaseDimensions, argumentsValue.dimensions,
            )
            && keyframeDetailsEqualExcept(before, after, ['temporalEaseDimensions']);
    }
    const member = {
        'temporal-continuous': 'temporalContinuous',
        'temporal-auto-bezier': 'temporalAutoBezier',
        'spatial-continuous': 'spatialContinuous',
        'spatial-auto-bezier': 'spatialAutoBezier',
        roving: 'roving',
    }[argumentsValue.behavior];
    return before.behaviors[member] !== after.behaviors[member]
        && after.behaviors[member] === argumentsValue.enabled
        && keyframeDetailsEqualExcept(before, after, ['behaviors']);
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
    'ae.layer.details.read': Object.freeze({
        digest: 'b1b7a5f313bbf72eb6b33ac4a0507f9f925ef6873d53fd07d93d861164ac15d9',
        mutating: false,
        postconditionKind: 'layer-details-read',
        validArguments: validLayerLocatorArguments,
        validValue: validLayerDetailsValue,
        locatorFields: Object.freeze([['layerLocator', 'ae_listCompositionLayers']]),
    }),
    'ae.layer.name.set': Object.freeze({
        digest: 'a68fb7f75f050faf4e77c81c3fa9f53ad501016af0eeb065493716ff94fd5929',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-name-set',
        validArguments: function (value) {
            return validLayerWriteArguments(value, 'name', function (name) {
                return validString(name, 1, 255);
            });
        },
        validValue: validLayerNameValue,
        locatorFields: Object.freeze([['layerLocator', 'ae_listCompositionLayers']]),
    }),
    'ae.layer.range.set': Object.freeze({
        digest: '0b90618916f0df612726017ef80795b72829f367cbf46cad23b33beb129230e2',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-range-set',
        validArguments: function (value) {
            return exactKeys(value, ['layerLocator', 'inPoint', 'duration', 'idempotencyKey'])
                && validLocator(value.layerLocator, ['layer'])
                && validTime(value.inPoint, false, -2147483648)
                && validTime(value.duration, false, 1)
                && validIdempotencyKey(value.idempotencyKey);
        },
        validValue: validLayerRangeValue,
        locatorFields: Object.freeze([['layerLocator', 'ae_listCompositionLayers']]),
    }),
    'ae.layer.start-time.set': Object.freeze({
        digest: 'c0c09292b98f5fecfb69a487f2014aed6ce2b67d47f07231beea36d916e07e27',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-start-time-set',
        validArguments: function (value) {
            return validLayerWriteArguments(value, 'startTime', function (time) {
                return validTime(time, false, -2147483648);
            });
        },
        validValue: validLayerStartTimeValue,
        locatorFields: Object.freeze([['layerLocator', 'ae_listCompositionLayers']]),
    }),
    'ae.layer.stretch.set': Object.freeze({
        digest: '0545a85e87d8907f94597ba36e3021fd3fa6dfe1262ff0e81eb30551f5e3bbb8',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-stretch-set',
        validArguments: function (value) {
            return validLayerWriteArguments(value, 'stretch', validLayerStretchInput);
        },
        validValue: validLayerStretchValue,
        locatorFields: Object.freeze([['layerLocator', 'ae_listCompositionLayers']]),
    }),
    'ae.layer.order.set': Object.freeze({
        digest: 'e977b89201314e2e4ee1b6e7a09efadd06f012b2b97e3087b0d9c4bd8102d162',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-order-set',
        validArguments: function (value) {
            return validLayerWriteArguments(value, 'targetStackIndex', function (index) {
                return Number.isSafeInteger(index) && index > 0;
            });
        },
        validValue: validLayerOrderValue,
        locatorFields: Object.freeze([['layerLocator', 'ae_listCompositionLayers']]),
    }),
    'ae.layer.parent.set': Object.freeze({
        digest: '36414bc469a83ddeadbf9f722e934266b38f26a70352c24f5e4a57800f2bb06c',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-parent-set',
        validArguments: validLayerParentArguments,
        validValue: validLayerParentValue,
        locatorFields: Object.freeze([
            ['layerLocator', 'ae_listCompositionLayers'],
            ['parentLayerLocator', 'ae_listCompositionLayers'],
        ]),
    }),
    'ae.layer.duplicate': Object.freeze({
        digest: '334a4371a4ac610f02d5dc1d525526ab54cfb1aea758a31434e1c0b196d76c75',
        mutating: true,
        allowReplay: true,
        postconditionKind: 'layer-duplicate',
        validArguments: validLayerDuplicateArguments,
        validValue: validLayerDuplicateValue,
        locatorFields: Object.freeze([['layerLocator', 'ae_listCompositionLayers']]),
    }),
    'ae.layer.property.keyframe.details.read': Object.freeze({
        digest: '254ec7933e9628b6c4fba4cc60e183331e4edc9f723c0ccb3f1e37619b7c5249',
        mutating: false,
        postconditionKind: 'layer-property-keyframe-details-read',
        validArguments: validKeyframeTargetArguments,
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validKeyframeDetails(
                value, argumentsValue.propertyLocator, argumentsValue.time,
                hostInstanceId, sessionId,
            );
        },
        locatorFields: Object.freeze([['propertyLocator', 'ae_listLayerProperties']]),
    }),
    'ae.layer.property.keyframe.add': Object.freeze({
        digest: '9eab679678002ba67260c70dcd46c3f93f0ed2dfbc8c272a17ec57c37451c68e',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-property-keyframe-add',
        validArguments: function (value) {
            return validKeyframeWriteArguments(value, ['value'], function (input) {
                return validAnyKeyframeSample(input.value);
            });
        },
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validKeyframeWriteValue(
                'add', value, argumentsValue, hostInstanceId, sessionId,
            );
        },
        locatorFields: Object.freeze([
            ['layerLocator', 'ae_listLayerProperties'],
            ['propertyLocator', 'ae_listLayerProperties'],
        ]),
    }),
    'ae.layer.property.keyframe.value.set': Object.freeze({
        digest: '9eab679678002ba67260c70dcd46c3f93f0ed2dfbc8c272a17ec57c37451c68e',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-property-keyframe-value-set',
        validArguments: function (value) {
            return validKeyframeWriteArguments(value, ['value'], function (input) {
                return validAnyKeyframeSample(input.value);
            });
        },
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validKeyframeWriteValue(
                'value', value, argumentsValue, hostInstanceId, sessionId,
            );
        },
        locatorFields: Object.freeze([
            ['layerLocator', 'ae_listLayerProperties'],
            ['propertyLocator', 'ae_listLayerProperties'],
        ]),
    }),
    'ae.layer.property.keyframe.interpolation.set': Object.freeze({
        digest: '42e8e12224bd1653fa8ca9f775c97553d61c0c2e60b3b2dcf76a8fc68deb2a20',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-property-keyframe-interpolation-set',
        validArguments: function (value) {
            return validKeyframeWriteArguments(
                value, ['inInterpolation', 'outInterpolation'], function (input) {
                    return KEYFRAME_SET_INTERPOLATIONS.includes(input.inInterpolation)
                        && KEYFRAME_SET_INTERPOLATIONS.includes(input.outInterpolation);
                },
            );
        },
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validKeyframeWriteValue(
                'interpolation', value, argumentsValue, hostInstanceId, sessionId,
            );
        },
        locatorFields: Object.freeze([
            ['layerLocator', 'ae_listLayerProperties'],
            ['propertyLocator', 'ae_listLayerProperties'],
        ]),
    }),
    'ae.layer.property.keyframe.temporal-ease.set': Object.freeze({
        digest: 'a73d70029c9a470b57d20fe54517cb36bb7fe249847c49da294f1db2d1c4bc8f',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-property-keyframe-temporal-ease-set',
        validArguments: function (value) {
            return validKeyframeWriteArguments(value, ['dimensions'], function (input) {
                return validKeyframeEaseDimensions(input.dimensions);
            });
        },
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validKeyframeWriteValue(
                'ease', value, argumentsValue, hostInstanceId, sessionId,
            );
        },
        locatorFields: Object.freeze([
            ['layerLocator', 'ae_listLayerProperties'],
            ['propertyLocator', 'ae_listLayerProperties'],
        ]),
    }),
    'ae.layer.property.keyframe.behavior.set': Object.freeze({
        digest: 'e2ff59d765613db12468d2140d8c937fd1ceb5def9f632877b18b664b6d6bf5c',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-property-keyframe-behavior-set',
        validArguments: function (value) {
            return validKeyframeWriteArguments(
                value, ['behavior', 'enabled'], function (input) {
                    return KEYFRAME_BEHAVIORS.includes(input.behavior)
                        && typeof input.enabled === 'boolean';
                },
            );
        },
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validKeyframeWriteValue(
                'behavior', value, argumentsValue, hostInstanceId, sessionId,
            );
        },
        locatorFields: Object.freeze([
            ['layerLocator', 'ae_listLayerProperties'],
            ['propertyLocator', 'ae_listLayerProperties'],
        ]),
    }),
    'ae.layer.property.keyframe.delete': Object.freeze({
        digest: 'a84e5b0971c54eb238ff96652340a7f1b34ebfea56e8238ac73edd11f551fdf9',
        mutating: true,
        allowReplay: false,
        postconditionKind: 'layer-property-keyframe-delete',
        validArguments: function (value) {
            return validKeyframeWriteArguments(value, [], function () { return true; });
        },
        validValue: function (value, argumentsValue, hostInstanceId, sessionId) {
            return validKeyframeWriteValue(
                'delete', value, argumentsValue, hostInstanceId, sessionId,
            );
        },
        locatorFields: Object.freeze([
            ['layerLocator', 'ae_listLayerProperties'],
            ['propertyLocator', 'ae_listLayerProperties'],
        ]),
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
    }).filter(function (entry) { return entry[0] !== null && entry[0] !== undefined; });
}

module.exports = Object.freeze({
    CONTRACTS,
    getContract,
    locatorChecks,
    validateCapabilityItems,
});
