'use strict';

const assert = require('node:assert/strict');
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
    return {
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
}

test('all eight frozen package contracts accept their closed valid shapes', () => {
    const vectors = cases();
    assert.deepEqual(Object.keys(packageContracts.CONTRACTS), Object.keys(vectors));
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
