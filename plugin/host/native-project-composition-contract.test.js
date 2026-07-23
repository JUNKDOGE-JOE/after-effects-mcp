'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageContracts = require('./native-project-composition-contract');

test('getContract rejects unknown, non-string, and inherited property names', () => {
    for (const capabilityId of ['unknown', 'toString', 'constructor', '__proto__', null]) {
        assert.equal(packageContracts.getContract(capabilityId), null);
    }
});

const HOST = '22222222-2222-4222-8222-222222222222';
const SESSION = '11111111-1111-4111-8111-111111111111';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const SOURCE = '66666666-6666-4666-8666-666666666666';
const CREATED = '77777777-7777-4777-8777-777777777777';
const REFRESHED_PROJECT = '88888888-8888-4888-8888-888888888888';
const FRESH_SOURCE = '99999999-9999-4999-8999-999999999998';

function locator(kind, objectId, generation, projectId = PROJECT) {
    return {
        kind,
        hostInstanceId: HOST,
        sessionId: SESSION,
        projectId,
        generation,
        objectId,
    };
}

function time(value, scale) {
    let left = Math.abs(value);
    let right = scale;
    while (right !== 0) [left, right] = [right, left % right];
    const numerator = value / left;
    const denominator = scale / left;
    return {
        value,
        scale,
        secondsRational: denominator === 1
            ? String(numerator) : String(numerator) + '/' + String(denominator),
    };
}

function ratio(numerator, denominator) {
    return {
        numerator,
        denominator,
        rational: denominator === 1
            ? String(numerator) : String(numerator) + '/' + String(denominator),
    };
}

function settings(name) {
    return {
        name,
        width: 1920,
        height: 1080,
        duration: time(240, 24),
        frameDuration: time(1, 24),
        frameRate: ratio(24, 1),
        pixelAspectRatio: ratio(1, 1),
        workArea: { start: time(0, 24), duration: time(120, 24) },
        displayStartTime: time(0, 24),
        layerCount: 2,
    };
}

function cases() {
    const source = locator('composition', SOURCE, 8);
    const project = locator('project', PROJECT, 8);
    const summary = {
        locator: source,
        name: 'Fixture',
        type: 'composition',
        parentLocator: project,
    };
    const vectors = {
        'ae.project.context.read': {
            arguments: { selectionOffset: 0, selectionLimit: 50 },
            value: {
                projectLocator: project,
                generation: 8,
                activeItem: summary,
                mostRecentlyUsedComposition: summary,
                selection: {
                    total: 1,
                    offset: 0,
                    limit: 50,
                    returned: 1,
                    hasMore: false,
                    nextOffset: null,
                    items: [summary],
                },
            },
        },
        'ae.project.item.metadata.read': {
            arguments: { itemLocator: source },
            value: {
                itemLocator: source,
                name: 'Fixture',
                type: 'composition',
                parentLocator: project,
                comment: 'before',
                labelId: 3,
                width: 1920,
                height: 1080,
                duration: time(240, 24),
                pixelAspectRatio: ratio(1, 1),
                layerCount: 2,
            },
        },
        'ae.composition.settings.read': {
            arguments: { compositionLocator: source },
            value: { compositionLocator: source, ...settings('Fixture') },
        },
        'ae.composition.work-area.set': {
            arguments: {
                compositionLocator: source,
                start: { value: 24, scale: 24 },
                duration: { value: 48, scale: 24 },
                idempotencyKey: 'issue150-work-area-0001',
            },
            value: {
                changed: true,
                compositionLocator: source,
                beforeWorkArea: { start: time(0, 24), duration: time(120, 24) },
                afterWorkArea: { start: time(24, 24), duration: time(48, 24) },
            },
        },
        'ae.project.item.name.set': {
            arguments: {
                itemLocator: source,
                name: 'Renamed',
                idempotencyKey: 'issue150-name-set-0001',
            },
            value: {
                changed: true,
                itemLocator: source,
                beforeName: 'Fixture',
                afterName: 'Renamed',
            },
        },
        'ae.project.item.comment.set': {
            arguments: {
                itemLocator: source,
                comment: 'after',
                idempotencyKey: 'issue150-comment-set-0001',
            },
            value: {
                changed: true,
                itemLocator: source,
                beforeComment: 'before',
                afterComment: 'after',
            },
        },
        'ae.project.item.label.set': {
            arguments: {
                itemLocator: source,
                labelId: 6,
                idempotencyKey: 'issue150-label-set-0001',
            },
            value: {
                changed: true,
                itemLocator: source,
                beforeLabelId: 3,
                afterLabelId: 6,
            },
        },
        'ae.composition.duplicate': {
            arguments: {
                compositionLocator: source,
                newName: 'Fixture Copy',
                idempotencyKey: 'issue150-duplicate-0001',
            },
            value: {
                changed: true,
                sourceCompositionLocator: locator('composition', FRESH_SOURCE, 9, REFRESHED_PROJECT),
                newCompositionLocator: locator('composition', CREATED, 9, REFRESHED_PROJECT),
                projectItemCountBefore: 1,
                projectItemCountAfter: 2,
                sourceSettings: settings('Fixture'),
                newSettings: settings('Fixture Copy'),
            },
        },
    };
    for (const filename of [
        'invoke-layer-details-read.json',
        'invoke-layer-name-set.json',
        'invoke-layer-range-set.json',
        'invoke-layer-start-time-set.json',
        'invoke-layer-stretch-set.json',
        'invoke-layer-order-set.json',
        'invoke-layer-parent-set.json',
        'invoke-layer-duplicate.json',
    ]) {
        const vector = JSON.parse(fs.readFileSync(path.join(
            __dirname, '../../native/ae-plugin/protocol/fixtures', filename,
        ), 'utf8'));
        vectors[vector.request.params.capabilityId] = {
            arguments: vector.request.params.arguments,
            value: vector.response.result.value,
        };
    }
    const layer = locator('layer', SOURCE, 8);
    vectors['ae.layer.compositing.read'] = {
        arguments: { layerLocator: layer },
        value: {
            layerLocator: layer,
            visibilityEnabled: true,
            solo: false,
            locked: false,
            shy: false,
            motionBlur: false,
            threeD: false,
            adjustment: false,
            quality: 'best',
            blendingMode: 'normal',
            preserveAlpha: false,
            trackMatte: 'none',
        },
    };
    vectors['ae.layer.switch.set'] = {
        arguments: {
            layerLocator: layer,
            switch: 'solo',
            enabled: true,
            idempotencyKey: 'issue162-switch-0001',
        },
        value: {
            changed: true,
            layerLocator: layer,
            switch: 'solo',
            beforeEnabled: false,
            afterEnabled: true,
        },
    };
    vectors['ae.layer.quality.set'] = {
        arguments: {
            layerLocator: layer,
            quality: 'draft',
            idempotencyKey: 'issue162-quality-0001',
        },
        value: {
            changed: true,
            layerLocator: layer,
            beforeQuality: 'best',
            afterQuality: 'draft',
        },
    };
    vectors['ae.layer.blending-mode.set'] = {
        arguments: {
            layerLocator: layer,
            mode: 'multiply',
            idempotencyKey: 'issue162-blend-0001',
        },
        value: {
            changed: true,
            layerLocator: layer,
            beforeMode: 'normal',
            afterMode: 'multiply',
            preserveAlpha: false,
            trackMatte: 'none',
        },
    };
    return vectors;
}

test('all twenty frozen #150/#155/#162 contracts accept their closed valid shapes', () => {
    const vectors = cases();
    assert.deepEqual(
        Object.keys(packageContracts.CONTRACTS).filter(function (capabilityId) {
            return !capabilityId.startsWith('ae.layer.property.keyframe.')
                && !capabilityId.startsWith('ae.native.media.');
        }).sort(),
        Object.keys(vectors).sort(),
    );
    for (const [capabilityId, vector] of Object.entries(vectors)) {
        const contract = packageContracts.getContract(capabilityId);
        assert.match(contract.digest, /^[0-9a-f]{64}$/);
        assert.equal(contract.validArguments(vector.arguments), true, capabilityId + ' arguments');
        assert.equal(
            contract.validValue(vector.value, vector.arguments, HOST, SESSION),
            true,
            capabilityId + ' value',
        );
        assert.equal(
            contract.validArguments({ ...vector.arguments, extra: true }),
            false,
            capabilityId + ' open arguments',
        );
        assert.equal(
            contract.validValue({ ...vector.value, extra: true }, vector.arguments, HOST, SESSION),
            false,
            capabilityId + ' open value',
        );
    }
});

test('#167 grouped media contracts admit closed read/write invokes and reject drift', () => {
    const item = locator('item', SOURCE, 8);
    const readArguments = {
        operation: 'effects-installed-list',
        offset: 0,
        limit: 50,
    };
    const readValue = {
        operation: 'effects-installed-list',
        effects: [],
        total: 0,
        offset: 0,
        limit: 50,
        returned: 0,
        hasMore: false,
        nextOffset: null,
    };
    const writeArguments = {
        operation: 'item-use-proxy',
        itemLocator: item,
        enabled: true,
        idempotencyKey: 'issue167-item-proxy-0001',
    };
    const writeValue = {
        operation: 'item-use-proxy',
        changed: true,
        itemLocator: item,
        afterEnabled: true,
    };
    const read = packageContracts.getContract('ae.native.media.read');
    const write = packageContracts.getContract('ae.native.media.write');

    assert.equal(read.digest, '4ec2dec1dbacec43fbd9dc3eeb1c69c6f8ade640be55a2568bc94ae839f7c282');
    assert.equal(write.digest, 'a19ceacd68d1dd4b0cce3066d9ed2792cfc665d9a1d299474708e7a876f73bb5');
    assert.equal(read.validArguments(readArguments), true);
    assert.equal(read.validValue(readValue, readArguments, HOST, SESSION), true);
    assert.equal(write.validArguments(writeArguments), true);
    assert.equal(write.validValue(writeValue, writeArguments, HOST, SESSION), true);
    assert.equal(read.validArguments({ ...readArguments, extra: true }), false);
    assert.equal(read.validValue({ ...readValue, extra: true }, readArguments, HOST, SESSION), false);
    assert.equal(write.validArguments({ ...writeArguments, enabled: 'true' }), false);
    assert.equal(write.validValue(
        { ...writeValue, changed: false }, writeArguments, HOST, SESSION,
    ), false);
});

test('#167 grouped media contracts bind every operation to one closed argument shape', () => {
    const layer = locator('layer', SOURCE, 8);
    const item = locator('item', CREATED, 8);
    const maskReference = { layerLocator: layer, maskIndex: 1, maskId: 7 };
    const effectReference = {
        layerLocator: layer, effectIndex: 1, installedEffectKey: 9,
    };
    const key = 'issue167-media-contract-0001';
    const vertex = {
        position: ['0', '0'], inTangent: ['0', '0'], outTangent: ['0', '0'],
    };
    const reads = [
        { operation: 'effects-installed-list', offset: 0, limit: 50 },
        { operation: 'effects-layer-list', layerLocator: layer, offset: 0, limit: 50 },
        { operation: 'effect-details', ...effectReference },
        { operation: 'masks-list', layerLocator: layer, offset: 0, limit: 50 },
        { operation: 'mask-details', ...maskReference },
        { operation: 'mask-path', ...maskReference },
        { operation: 'footage-details', itemLocator: item },
        { operation: 'footage-interpretation', itemLocator: item, proxy: false },
    ];
    const writes = [
        { operation: 'effect-enabled', ...effectReference, enabled: false, idempotencyKey: key },
        { operation: 'effect-reorder', ...effectReference, targetIndex: 2, idempotencyKey: key },
        { operation: 'effect-duplicate', ...effectReference, idempotencyKey: key },
        { operation: 'effect-delete', ...effectReference, idempotencyKey: key },
        { operation: 'mask-create', layerLocator: layer, idempotencyKey: key },
        {
            operation: 'mask-properties', ...maskReference,
            properties: { mode: 'add' }, idempotencyKey: key,
        },
        {
            operation: 'mask-path', ...maskReference, closed: false,
            vertices: [vertex, { ...vertex, position: ['10', '10'] }],
            idempotencyKey: key,
        },
        { operation: 'mask-duplicate', ...maskReference, targetIndex: 2, idempotencyKey: key },
        { operation: 'mask-delete', ...maskReference, idempotencyKey: key },
        { operation: 'footage-import', sourcePath: '/tmp/a.png', idempotencyKey: key },
        {
            operation: 'footage-replace', itemLocator: item,
            sourcePath: '/tmp/b.png', idempotencyKey: key,
        },
        {
            operation: 'footage-interpretation', itemLocator: item, proxy: false,
            interpretation: { loopCount: 2 }, idempotencyKey: key,
        },
        {
            operation: 'footage-proxy', itemLocator: item,
            sourcePath: '/tmp/proxy.png', idempotencyKey: key,
        },
        { operation: 'item-use-proxy', itemLocator: item, enabled: true, idempotencyKey: key },
    ];
    const read = packageContracts.getContract('ae.native.media.read');
    const write = packageContracts.getContract('ae.native.media.write');
    assert.equal(reads.every(function (value) { return read.validArguments(value); }), true);
    assert.equal(writes.every(function (value) { return write.validArguments(value); }), true);
    assert.equal(reads.every(function (value) {
        return !read.validArguments({ ...value, idempotencyKey: key });
    }), true);
    assert.equal(writes.every(function (value) {
        return !write.validArguments({ ...value, unexpected: true });
    }), true);
});

test('#162 compositing contracts reject generic, no-op, and unrelated readbacks', () => {
    const vectors = cases();
    const read = vectors['ae.layer.compositing.read'];
    const switched = vectors['ae.layer.switch.set'];
    const quality = vectors['ae.layer.quality.set'];
    const blend = vectors['ae.layer.blending-mode.set'];

    assert.equal(packageContracts.getContract('ae.layer.compositing.read').validValue(
        { ...read.value, layerLocator: { ...read.value.layerLocator, objectId: CREATED } },
        read.arguments, HOST, SESSION,
    ), false);
    assert.equal(packageContracts.getContract('ae.layer.switch.set').validArguments(
        { ...switched.arguments, switch: 'arbitrary-sdk-flag' },
    ), false);
    assert.equal(packageContracts.getContract('ae.layer.switch.set').validValue(
        { ...switched.value, beforeEnabled: true }, switched.arguments, HOST, SESSION,
    ), false);
    assert.equal(packageContracts.getContract('ae.layer.quality.set').validValue(
        { ...quality.value, afterQuality: 'wireframe' }, quality.arguments, HOST, SESSION,
    ), false);
    assert.equal(packageContracts.getContract('ae.layer.blending-mode.set').validValue(
        { ...blend.value, afterMode: 'screen' }, blend.arguments, HOST, SESSION,
    ), false);
});

function keyframeCases() {
    const layer = locator('layer', SOURCE, 8);
    const property = locator('stream', CREATED, 8);
    const targetTime = { value: 24, scale: 24 };
    const ease = function (speed, influence) {
        return [{
            dimension: 0,
            inEase: { speed, influence },
            outEase: { speed, influence },
        }];
    };
    const details = function (overrides) {
        return {
            propertyLocator: property,
            time: time(24, 24),
            temporalDimensionality: 1,
            valueType: 'one-d',
            value: { kind: 'scalar', value: '1' },
            inInterpolation: 'linear',
            outInterpolation: 'linear',
            temporalEaseDimensions: ease('0', '33'),
            behaviors: {
                temporalContinuous: false,
                temporalAutoBezier: false,
                spatialContinuous: false,
                spatialAutoBezier: false,
                roving: false,
            },
            ...overrides,
        };
    };
    const write = function (extra) {
        return {
            layerLocator: layer,
            propertyLocator: property,
            time: targetTime,
            idempotencyKey: 'issue157-host-contract-0001',
            ...extra,
        };
    };
    const mutation = function (beforeKeyframe, afterKeyframe, beforeCount, afterCount) {
        return {
            changed: true,
            layerLocator: layer,
            propertyLocator: property,
            time: time(24, 24),
            keyframeCountBefore: beforeCount,
            keyframeCountAfter: afterCount,
            beforeKeyframe,
            afterKeyframe,
        };
    };
    const before = details();
    const valueAfter = details({ value: { kind: 'scalar', value: '2' } });
    const interpolationAfter = details({ inInterpolation: 'bezier', outInterpolation: 'hold' });
    const easeAfter = details({
        inInterpolation: 'bezier',
        outInterpolation: 'bezier',
        temporalEaseDimensions: ease('5', '50'),
    });
    const behaviorAfter = details({
        behaviors: { ...before.behaviors, spatialContinuous: true },
    });
    return {
        'ae.layer.property.keyframe.details.read': {
            arguments: { propertyLocator: property, time: targetTime }, value: before,
        },
        'ae.layer.property.keyframe.add': {
            arguments: write({ value: { kind: 'scalar', value: '1' } }),
            value: mutation(null, before, 0, 1),
        },
        'ae.layer.property.keyframe.value.set': {
            arguments: write({ value: { kind: 'scalar', value: '2' } }),
            value: mutation(before, valueAfter, 1, 1),
        },
        'ae.layer.property.keyframe.interpolation.set': {
            arguments: write({ inInterpolation: 'bezier', outInterpolation: 'hold' }),
            value: mutation(before, interpolationAfter, 1, 1),
        },
        'ae.layer.property.keyframe.temporal-ease.set': {
            arguments: write({ dimensions: ease('5.0', '50.0') }),
            value: mutation(before, easeAfter, 1, 1),
        },
        'ae.layer.property.keyframe.behavior.set': {
            arguments: write({ behavior: 'spatial-continuous', enabled: true }),
            value: mutation(before, behaviorAfter, 1, 1),
        },
        'ae.layer.property.keyframe.delete': {
            arguments: write({}), value: mutation(before, null, 1, 0),
        },
    };
}

test('seven #157 contracts bind checked-in registry metadata and closed typed values', () => {
    const matrix = JSON.parse(fs.readFileSync(path.join(
        __dirname,
        '../../native/ae-plugin/protocol/fixtures/keyframe-authoring-matrix.json',
    ), 'utf8'));
    const capabilities = JSON.parse(fs.readFileSync(path.join(
        __dirname, '../../native/ae-plugin/protocol/fixtures/capabilities.json',
    ), 'utf8')).response.result.items;
    const vectors = keyframeCases();
    assert.deepEqual(Object.keys(vectors), matrix.cases.map(function (item) {
        return item.capabilityId;
    }));
    for (const entry of matrix.cases) {
        const contract = packageContracts.getContract(entry.capabilityId);
        const descriptor = capabilities.find(function (item) {
            return item.id === entry.capabilityId;
        });
        const vector = vectors[entry.capabilityId];
        assert.equal(contract.digest, entry.contractDigest, entry.capabilityId);
        assert.equal(contract.postconditionKind, entry.postconditionKind, entry.capabilityId);
        assert.equal(contract.mutating, entry.mutating, entry.capabilityId);
        assert.equal(descriptor.contractDigest, entry.contractDigest, entry.capabilityId);
        assert.equal(contract.validArguments(vector.arguments), true, entry.capabilityId);
        assert.equal(
            contract.validValue(vector.value, vector.arguments, HOST, SESSION),
            true,
            entry.capabilityId,
        );
        assert.equal(contract.validArguments({ ...vector.arguments, extra: true }), false);
        assert.equal(contract.validValue(
            { ...vector.value, extra: true }, vector.arguments, HOST, SESSION,
        ), false);
    }
});

test('#157 read tampering is safe and write tampering remains side-effect-sensitive', () => {
    const vectors = keyframeCases();
    const read = vectors['ae.layer.property.keyframe.details.read'];
    const write = vectors['ae.layer.property.keyframe.add'];
    assert.equal(packageContracts.getContract(
        'ae.layer.property.keyframe.details.read',
    ).validValue(
        { ...read.value, temporalDimensionality: 2 }, read.arguments, HOST, SESSION,
    ), false);
    assert.equal(packageContracts.getContract('ae.layer.property.keyframe.add').validValue(
        { ...write.value, keyframeCountAfter: 2 }, write.arguments, HOST, SESSION,
    ), false);
});

test('#157 interpolation accepts only AE bezier in-ease influence normalization', () => {
    const vector = keyframeCases()['ae.layer.property.keyframe.interpolation.set'];
    const contract = packageContracts.getContract(
        'ae.layer.property.keyframe.interpolation.set',
    );
    const normalized = structuredClone(vector.value);
    normalized.beforeKeyframe.temporalEaseDimensions[0].inEase.influence =
        '16.666666666999998';
    normalized.beforeKeyframe.temporalEaseDimensions[0].outEase.influence =
        '16.666666666999998';
    normalized.afterKeyframe.temporalEaseDimensions[0].inEase.influence = '0';
    normalized.afterKeyframe.temporalEaseDimensions[0].outEase.influence =
        '16.666666666999998';

    assert.equal(
        contract.validValue(normalized, vector.arguments, HOST, SESSION),
        true,
    );

    const drifts = {
        value(value) { value.afterKeyframe.value = { kind: 'scalar', value: '2' }; },
        count(value) { value.keyframeCountAfter += 1; },
        inSpeed(value) { value.afterKeyframe.temporalEaseDimensions[0].inEase.speed = '1'; },
        outSpeed(value) { value.afterKeyframe.temporalEaseDimensions[0].outEase.speed = '1'; },
        outInfluence(value) {
            value.afterKeyframe.temporalEaseDimensions[0].outEase.influence = '1';
        },
        inInfluenceNonzero(value) {
            value.afterKeyframe.temporalEaseDimensions[0].inEase.influence = '1';
        },
        dimension(value) { value.afterKeyframe.temporalEaseDimensions[0].dimension = 1; },
    };
    for (const [name, mutate] of Object.entries(drifts)) {
        const drift = structuredClone(normalized);
        mutate(drift);
        assert.equal(
            contract.validValue(drift, vector.arguments, HOST, SESSION),
            false,
            name,
        );
    }

    const nonBezier = structuredClone(normalized);
    nonBezier.afterKeyframe.inInterpolation = 'linear';
    assert.equal(
        contract.validValue(
            nonBezier,
            { ...vector.arguments, inInterpolation: 'linear' },
            HOST,
            SESSION,
        ),
        false,
        'nonBezier',
    );
});

test('#157 interpolation accepts only AE hold-side speed zeroing', () => {
    const contract = packageContracts.getContract(
        'ae.layer.property.keyframe.interpolation.set',
    );
    const vector = keyframeCases()['ae.layer.property.keyframe.interpolation.set'];
    // Probe shapes on the 3-key fixture (1s key between 0 at 0s and 80 at 2s,
    // linear ease speeds 40/40): switching one side to hold zeroes exactly
    // that side's speed while influence and everything else stay.
    const segmentEase = function (inSpeed, outSpeed) {
        return [{
            dimension: 0,
            inEase: { speed: inSpeed, influence: '16.666666666999998' },
            outEase: { speed: outSpeed, influence: '16.666666666999998' },
        }];
    };
    const bezierHold = structuredClone(vector.value);
    bezierHold.keyframeCountBefore = 3;
    bezierHold.keyframeCountAfter = 3;
    bezierHold.beforeKeyframe.temporalEaseDimensions = segmentEase('40', '40');
    bezierHold.afterKeyframe.inInterpolation = 'bezier';
    bezierHold.afterKeyframe.outInterpolation = 'hold';
    bezierHold.afterKeyframe.temporalEaseDimensions = segmentEase('40', '0');
    assert.equal(
        contract.validValue(bezierHold, vector.arguments, HOST, SESSION),
        true,
        'bezier/hold zeroes the out speed only',
    );

    const holdLinear = structuredClone(bezierHold);
    holdLinear.afterKeyframe.inInterpolation = 'hold';
    holdLinear.afterKeyframe.outInterpolation = 'linear';
    holdLinear.afterKeyframe.temporalEaseDimensions = segmentEase('0', '40');
    const holdLinearArguments = {
        ...vector.arguments,
        inInterpolation: 'hold',
        outInterpolation: 'linear',
    };
    assert.equal(
        contract.validValue(holdLinear, holdLinearArguments, HOST, SESSION),
        true,
        'hold/linear zeroes the in speed only',
    );

    const drifts = {
        holdSpeedNonzero(value) {
            value.afterKeyframe.temporalEaseDimensions[0].inEase.speed = '7';
        },
        holdInfluence(value) {
            value.afterKeyframe.temporalEaseDimensions[0].inEase.influence = '25';
        },
        linearSideSpeed(value) {
            // Only the hold side may zero: the still-linear side must keep 40.
            value.afterKeyframe.temporalEaseDimensions[0].outEase.speed = '0';
        },
        value(value) { value.afterKeyframe.value = { kind: 'scalar', value: '2' }; },
        behavior(value) { value.afterKeyframe.behaviors.roving = true; },
        dimension(value) { value.afterKeyframe.temporalEaseDimensions[0].dimension = 1; },
    };
    for (const [name, mutate] of Object.entries(drifts)) {
        const drift = structuredClone(holdLinear);
        mutate(drift);
        assert.equal(
            contract.validValue(drift, holdLinearArguments, HOST, SESSION),
            false,
            name,
        );
    }
});

test('#157 value set accepts only AE linear-key ease speed recomputation', () => {
    const vector = keyframeCases()['ae.layer.property.keyframe.value.set'];
    const contract = packageContracts.getContract(
        'ae.layer.property.keyframe.value.set',
    );
    assert.equal(
        contract.validValue(vector.value, vector.arguments, HOST, SESSION),
        true,
        'isolated key without drift',
    );

    // The exact T5 call-11 shape on candidate b7d852b: the 1s keyframe sits
    // between neighbours 0 at 0s and 80 at 2s, so changing the value 40 -> 65
    // makes After Effects recompute the linear ease speeds as the new slopes
    // (in 40 -> 65, out 40 -> 15) while influence, interpolation and
    // behaviors stay exactly equal.
    const recomputed = structuredClone(vector.value);
    recomputed.keyframeCountBefore = 3;
    recomputed.keyframeCountAfter = 3;
    recomputed.beforeKeyframe.value = { kind: 'scalar', value: '40' };
    recomputed.afterKeyframe.value = { kind: 'scalar', value: '65' };
    recomputed.beforeKeyframe.temporalEaseDimensions = [{
        dimension: 0,
        inEase: { speed: '40', influence: '16.666666666999998' },
        outEase: { speed: '40', influence: '16.666666666999998' },
    }];
    recomputed.afterKeyframe.temporalEaseDimensions = [{
        dimension: 0,
        inEase: { speed: '65', influence: '16.666666666999998' },
        outEase: { speed: '15', influence: '16.666666666999998' },
    }];
    const recomputedArguments = {
        ...vector.arguments,
        value: { kind: 'scalar', value: '65' },
    };
    assert.equal(
        contract.validValue(recomputed, recomputedArguments, HOST, SESSION),
        true,
        'AE slope recomputation',
    );

    const steady = structuredClone(recomputed);
    steady.afterKeyframe.temporalEaseDimensions =
        structuredClone(steady.beforeKeyframe.temporalEaseDimensions);
    assert.equal(
        contract.validValue(steady, recomputedArguments, HOST, SESSION),
        true,
        'steady speeds stay accepted',
    );

    const drifts = {
        inInfluence(value) {
            value.afterKeyframe.temporalEaseDimensions[0].inEase.influence = '25';
        },
        outInfluence(value) {
            value.afterKeyframe.temporalEaseDimensions[0].outEase.influence = '25';
        },
        interpolation(value) { value.afterKeyframe.inInterpolation = 'bezier'; },
        behavior(value) { value.afterKeyframe.behaviors.roving = true; },
        dimension(value) { value.afterKeyframe.temporalEaseDimensions[0].dimension = 1; },
        valueMismatch(value) {
            value.afterKeyframe.value = { kind: 'scalar', value: '66' };
        },
        count(value) { value.keyframeCountAfter = 4; },
        isolatedSpeed(value) {
            // An isolated keyframe has no segment whose slope After Effects
            // could recompute, so speed drift is not AE-attributable.
            value.keyframeCountBefore = 1;
            value.keyframeCountAfter = 1;
        },
        bezierSpeed(value) {
            // AE only recomputes ease speeds automatically for linear keys;
            // user-authored bezier ease must not drift on a value write.
            value.beforeKeyframe.inInterpolation = 'bezier';
            value.beforeKeyframe.outInterpolation = 'bezier';
            value.afterKeyframe.inInterpolation = 'bezier';
            value.afterKeyframe.outInterpolation = 'bezier';
        },
    };
    for (const [name, mutate] of Object.entries(drifts)) {
        const drift = structuredClone(recomputed);
        mutate(drift);
        assert.equal(
            contract.validValue(drift, recomputedArguments, HOST, SESSION),
            false,
            name,
        );
    }
});

test('#157 temporal ease accepts only the AE bezier promotion coupling', () => {
    const vector = keyframeCases()['ae.layer.property.keyframe.temporal-ease.set'];
    const contract = packageContracts.getContract(
        'ae.layer.property.keyframe.temporal-ease.set',
    );
    assert.equal(
        contract.validValue(vector.value, vector.arguments, HOST, SESSION),
        true,
    );

    const drifts = {
        noPromotion(value) {
            value.afterKeyframe.inInterpolation = 'linear';
            value.afterKeyframe.outInterpolation = 'linear';
        },
        outNotBezier(value) { value.afterKeyframe.outInterpolation = 'hold'; },
        value(value) { value.afterKeyframe.value = { kind: 'scalar', value: '2' }; },
        count(value) { value.keyframeCountAfter += 1; },
        behavior(value) { value.afterKeyframe.behaviors.roving = true; },
        easeMismatch(value) {
            value.afterKeyframe.temporalEaseDimensions[0].inEase.influence = '51';
        },
        speedNormalized(value) {
            // After Effects drops temporal-ease speed to 0 when the keyframe
            // has no adjacent segment, while still applying the influence; the
            // contract must refuse that partial application.
            value.afterKeyframe.temporalEaseDimensions[0].inEase.speed = '0';
            value.afterKeyframe.temporalEaseDimensions[0].outEase.speed = '0';
        },
    };
    for (const [name, mutate] of Object.entries(drifts)) {
        const drift = structuredClone(vector.value);
        mutate(drift);
        assert.equal(
            contract.validValue(drift, vector.arguments, HOST, SESSION),
            false,
            name,
        );
    }
});

test('#155 layer contracts bind locators, readbacks, replay, and nullable parent refresh', () => {
    const vectors = cases();
    const writes = [
        'ae.layer.name.set',
        'ae.layer.range.set',
        'ae.layer.start-time.set',
        'ae.layer.stretch.set',
        'ae.layer.order.set',
        'ae.layer.parent.set',
        'ae.layer.duplicate',
    ];
    assert.equal(packageContracts.getContract('ae.layer.details.read').mutating, false);
    for (const capabilityId of writes) {
        const contract = packageContracts.getContract(capabilityId);
        assert.equal(contract.mutating, true, capabilityId);
        assert.equal(contract.allowReplay, capabilityId === 'ae.layer.duplicate', capabilityId);
    }

    const details = vectors['ae.layer.details.read'];
    assert.equal(packageContracts.getContract('ae.layer.details.read').validValue(
        { ...details.value, stackIndex: 2 }, details.arguments, HOST, SESSION,
    ), true);
    assert.equal(packageContracts.getContract('ae.layer.details.read').validValue(
        {
            ...details.value,
            layerLocator: { ...details.value.layerLocator, objectId: CREATED },
        },
        details.arguments,
        HOST,
        SESSION,
    ), false);

    const duplicate = vectors['ae.layer.duplicate'];
    assert.equal(packageContracts.getContract('ae.layer.duplicate').validValue(
        { ...duplicate.value, layerCountAfter: duplicate.value.layerCountBefore + 2 },
        duplicate.arguments,
        HOST,
        SESSION,
    ), false);
    assert.equal(packageContracts.getContract('ae.layer.duplicate').validValue(
        {
            ...duplicate.value,
            newLayer: {
                ...duplicate.value.newLayer,
                stackIndex: duplicate.value.layerCountAfter + 1,
            },
        },
        duplicate.arguments,
        HOST,
        SESSION,
    ), false);

    const parent = vectors['ae.layer.parent.set'];
    const clearParent = {
        ...parent.arguments,
        parentLayerLocator: null,
    };
    assert.deepEqual(
        packageContracts.locatorChecks(
            packageContracts.getContract('ae.layer.parent.set'), clearParent,
        ),
        [[clearParent.layerLocator, 'layerLocator', 'ae_listCompositionLayers']],
    );
});

test('capability descriptors bind every package contract digest', () => {
    const items = Object.entries(packageContracts.CONTRACTS).map(function (entry) {
        return {
            id: entry[0], version: 1, detail: 'full', contractDigest: entry[1].digest,
            risk: entry[1].mutating ? 'write' : 'read',
            mutability: entry[1].mutating ? 'mutating' : 'read-only',
            idempotency: entry[1].mutating ? 'idempotency-key' : 'idempotent',
            undo: entry[1].mutating ? 'ae-undo-group' : 'not-applicable',
        };
    });
    const verified = packageContracts.validateCapabilityItems(items, undefined, 'full');
    assert.deepEqual(Object.fromEntries(verified), Object.fromEntries(
        Object.entries(packageContracts.CONTRACTS).map(function (entry) {
            return [entry[0], entry[1].digest];
        }),
    ));

    items[0] = { ...items[0], contractDigest: '0'.repeat(64) };
    assert.equal(packageContracts.validateCapabilityItems(items, undefined, 'full'), null);
    items[0] = {
        id: Object.keys(packageContracts.CONTRACTS)[0],
        version: 1,
        detail: 'full',
        contractDigest: Object.values(packageContracts.CONTRACTS)[0].digest,
        risk: 'write',
        mutability: 'read-only',
        idempotency: 'idempotent',
        undo: 'not-applicable',
    };
    assert.equal(packageContracts.validateCapabilityItems(items, undefined, 'full'), null);
});

test('metadata permits a root item with omitted unsupported type-specific facts', () => {
    const item = locator('item', SOURCE, 8);
    const contract = packageContracts.getContract('ae.project.item.metadata.read');
    const argumentsValue = { itemLocator: item };
    const value = {
        itemLocator: item,
        name: 'Root folder',
        type: 'folder',
        parentLocator: null,
        comment: '',
        labelId: 0,
    };
    assert.equal(contract.validValue(value, argumentsValue, HOST, SESSION), true);
    assert.equal(contract.validValue({ ...value, layerCount: 0 }, argumentsValue, HOST, SESSION), false);
    assert.equal(contract.validValue({ ...value, width: null }, argumentsValue, HOST, SESSION), false);

    const settingsVector = cases()['ae.composition.settings.read'];
    assert.equal(
        packageContracts.getContract('ae.composition.settings.read').validValue(
            { ...settingsVector.value, name: '' },
            settingsVector.arguments,
            HOST,
            SESSION,
        ),
        true,
    );
});

test('mutation readback tampering is rejected by package-specific validators', () => {
    const vectors = cases();
    const workArea = vectors['ae.composition.work-area.set'];
    const duplicate = vectors['ae.composition.duplicate'];
    const label = vectors['ae.project.item.label.set'];
    assert.equal(
        packageContracts.getContract('ae.composition.work-area.set').validValue(
            { ...workArea.value, afterWorkArea: workArea.value.beforeWorkArea },
            workArea.arguments,
            HOST,
            SESSION,
        ),
        false,
    );
    assert.equal(
        packageContracts.getContract('ae.composition.duplicate').validValue(
            { ...duplicate.value, projectItemCountAfter: 3 },
            duplicate.arguments,
            HOST,
            SESSION,
        ),
        false,
    );
    assert.equal(
        packageContracts.getContract('ae.composition.duplicate').validValue(
            {
                ...duplicate.value,
                newCompositionLocator: {
                    ...duplicate.value.newCompositionLocator,
                    projectId: PROJECT,
                },
            },
            duplicate.arguments,
            HOST,
            SESSION,
        ),
        false,
    );
    assert.equal(
        packageContracts.getContract('ae.composition.duplicate').validValue(
            {
                ...duplicate.value,
                sourceCompositionLocator: {
                    ...duplicate.value.sourceCompositionLocator,
                    generation: duplicate.arguments.compositionLocator.generation,
                },
                newCompositionLocator: {
                    ...duplicate.value.newCompositionLocator,
                    generation: duplicate.arguments.compositionLocator.generation,
                },
            },
            duplicate.arguments,
            HOST,
            SESSION,
        ),
        false,
    );
    assert.equal(
        packageContracts.getContract('ae.composition.duplicate').validValue(
            {
                ...duplicate.value,
                sourceSettings: {
                    ...duplicate.value.sourceSettings,
                    frameRate: ratio(25, 1),
                },
            },
            duplicate.arguments,
            HOST,
            SESSION,
        ),
        false,
    );
    assert.equal(
        packageContracts.getContract('ae.composition.duplicate').validValue(
            {
                ...duplicate.value,
                newSettings: {
                    ...duplicate.value.newSettings,
                    workArea: { start: time(239, 24), duration: time(2, 24) },
                },
            },
            duplicate.arguments,
            HOST,
            SESSION,
        ),
        false,
    );
    assert.equal(
        packageContracts.getContract('ae.project.item.label.set').validValue(
            { ...label.value, afterLabelId: 7 },
            label.arguments,
            HOST,
            SESSION,
        ),
        false,
    );
});
